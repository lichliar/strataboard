// Execution-boundary behavior checks for W02 (no test framework, per project
// rules): esbuild-bundles the pure modules (script-runner / widget-parser /
// indicator loader+compute) and runs table-driven + real-process assertions.
// Run: node scripts/check-execution.mjs
import esbuild from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const entry = `
export { runScript, buildScriptEnv, isPathInside, MAX_OUTPUT_CHARS } from "./src/modules/script-runner";
export { isTradingViewUrl, parseWidgetCode, parseWidgetInput, buildTradingViewWidgetHtml } from "./src/modules/widget-parser";
export { syncIndicatorFiles, getIndicatorLoadErrors, getUnapprovedIndicators } from "./src/modules/indicators/loader";
export { indicatorRegistry } from "./src/modules/indicators/registry";
export { computeIndicatorForInstance, getIndicatorRuntimeError, getIndicatorRuntimeErrors } from "./src/modules/indicators/compute";
`;

const result = await esbuild.build({
  stdin: { contents: entry, loader: "ts", resolveDir: repoRoot },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["obsidian"],
  logLevel: "silent",
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-exec-"));
const tmp = path.join(tmpDir, "check.cjs");
fs.writeFileSync(tmp, result.outputFiles[0].text);
const m = await import(pathToFileURL(tmp).href);

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

const {
  runScript, buildScriptEnv, isPathInside, MAX_OUTPUT_CHARS,
  isTradingViewUrl, parseWidgetCode, parseWidgetInput, buildTradingViewWidgetHtml,
  syncIndicatorFiles, getIndicatorLoadErrors, getUnapprovedIndicators,
  indicatorRegistry,
  computeIndicatorForInstance, getIndicatorRuntimeError,
} = m;

// ==================== TradingView allowlist (W02-C) ====================

const goodUrls = [
  "https://www.tradingview.com/chart/",
  "https://tradingview.com",
  "https://s3.tradingview.com/tv.js",
  "https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js",
  "https://www.tradingview.com:443/widgetembed/?symbol=AAPL",
];
for (const url of goodUrls) check(`allowlist accepts ${url}`, isTradingViewUrl(url), true);

const badUrls = [
  "http://www.tradingview.com/x",                       // not https
  "https://tradingview.com.evil.com/",                  // suffix look-alike
  "https://evil-tradingview.com/",                      // prefix look-alike
  "https://tradingview.com@evil.com/",                  // userinfo deception
  "https://user:pass@www.tradingview.com/x",            // credentials in URL
  "https://www.tradingview.com:8080/x",                 // non-default port
  "ftp://www.tradingview.com/x",                        // other protocol
  "not a url",
  "",
];
for (const url of badUrls) check(`allowlist rejects ${JSON.stringify(url)}`, isTradingViewUrl(url), false);

const OFFICIAL_EMBED = `<!-- TradingView Widget BEGIN -->
<div class="tradingview-widget-container">
  <div class="tradingview-widget-container__widget"></div>
  <script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js" async>
  { "symbol": "NASDAQ:AAPL", "width": "100%", "height": "100%" }
  </script>
</div>
<!-- TradingView Widget END -->`;

check("official embed snippet accepted", parseWidgetCode(OFFICIAL_EMBED)?.kind, "embed");
check(
  "embed snippet rebuilt with attribution",
  parseWidgetCode(OFFICIAL_EMBED)?.withConfig({ symbol: "X" }).includes("tradingview-widget-copyright"),
  true
);
check(
  "embed snippet rebuild keeps official script only",
  (() => {
    const html = parseWidgetCode(OFFICIAL_EMBED)?.withConfig({ symbol: "X" }) ?? "";
    return html.includes("https://s3.tradingview.com/external-embedding/") && !html.includes("<!-- TradingView");
  })(),
  true
);

const MALICIOUS_EMBED = OFFICIAL_EMBED + `<script src="https://evil.com/steal.js"></script><img src="https://evil.com/x">`;
check(
  "foreign tags/scripts stripped on rebuild",
  (() => {
    const html = parseWidgetCode(MALICIOUS_EMBED)?.withConfig({ symbol: "X" }) ?? "";
    return !html.includes("evil.com");
  })(),
  true
);

const EMBED_LOOKALIKE = OFFICIAL_EMBED.replace("s3.tradingview.com", "s3.tradingview.com.evil.com");
check("embed snippet with look-alike host rejected", parseWidgetCode(EMBED_LOOKALIKE)?.kind, "invalid");

const TVJS_SNIPPET = `<script src="https://s3.tradingview.com/tv.js"></script>
<script>new TradingView.widget({ "symbol": "AAPL", "container_id": "tv" });</script>`;
check("legacy tv.js snippet accepted", parseWidgetCode(TVJS_SNIPPET)?.kind, "tvjs");
check(
  "tvjs rebuild keeps official script + attribution",
  (() => {
    const html = parseWidgetCode(TVJS_SNIPPET)?.withConfig({ symbol: "X" }) ?? "";
    return html.includes("https://s3.tradingview.com/tv.js") && html.includes("tradingview-widget-copyright");
  })(),
  true
);

check("bare official URL accepted", parseWidgetCode("https://www.tradingview.com/widgetembed/?symbol=AAPL")?.kind, "iframe-url");
check("bare look-alike URL rejected", parseWidgetCode("https://tradingview.evil.com/widgetembed/")?.kind, "invalid");
check("arbitrary html rejected", parseWidgetCode(`<iframe src="https://evil.com"></iframe>`)?.kind, "invalid");
check("parseWidgetInput rejects non-official", parseWidgetInput(`<script src="https://evil.com/x.js"></script>`), null);

check(
  "built widget html always carries attribution",
  buildTradingViewWidgetHtml("https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js", {}).includes(
    'href="https://www.tradingview.com/"'
  ),
  true
);

// ==================== Python script runner (W02-A) ====================

process.env.STRATABOARD_API_KEY_TESTSRC = "super-secret-value";
const env = buildScriptEnv();
check("minimal env has PATH", typeof env.PATH === "string" && env.PATH.length > 0, true);
check(
  "minimal env leaks no secrets",
  Object.keys(env).some((k) => /STRATABOARD|KEY|TOKEN|SECRET/i.test(k)),
  false
);
check(
  "minimal env is small",
  Object.keys(env).length <= 8,
  true
);

// Script-containment predicate (symlink-escape guard, W02-A).
check("script inside folder accepted", isPathInside("/v/scripts", "/v/scripts/macro/cpi.py"), true);
check("script equal to folder root rejected", isPathInside("/v/scripts", "/v/scripts"), false);
check("parent traversal rejected", isPathInside("/v/scripts", "/v/scripts/../data.json"), false);
check("sibling prefix not inside", isPathInside("/v/scripts", "/v/scripts-evil/x.py"), false);

const python = (() => {
  for (const p of ["/usr/bin/python3", "/opt/homebrew/bin/python3"]) {
    if (fs.existsSync(p)) return p;
  }
  try {
    return execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

if (!python) {
  console.log("skip python process tests (no python3 found)");
} else {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-script-"));

  // Success + no-shell proof: a filename with a space and $HOME would break
  // under any shell interpolation; direct spawn runs it as a single argv.
  const weirdName = "has space $HOME.py";
  const weirdPath = path.join(scriptDir, weirdName);
  fs.writeFileSync(weirdPath, "print('hello-strata')");
  const ok = await runScript({ interpreter: python, scriptPath: weirdPath, cwd: scriptDir });
  check("script runs and returns exit 0", ok.code, 0);
  check("stdout captured", ok.stdout.includes("hello-strata"), true);
  check("no shell interpolation of $HOME in filename", ok.code === 0 && !ok.stderr.includes("$HOME"), true);

  // Minimal env end-to-end: the child reports its own environment.
  const envPath = path.join(scriptDir, "env.py");
  fs.writeFileSync(envPath, "import os, json; print(json.dumps(sorted(os.environ.keys())))");
  const envRun = await runScript({ interpreter: python, scriptPath: envPath, cwd: scriptDir });
  const childKeys = JSON.parse(envRun.stdout.trim() || "[]");
  check("child env has no STRATABOARD secret", childKeys.some((k) => k.includes("STRATABOARD")), false);
  // Beyond our allowlist: LC_CTYPE comes from Python's locale coercion
  // (PEP 538/540); SDKROOT/CPATH/LIBRARY_PATH/MANPATH from macOS's xcode CLT
  // python3 shim; __CF_USER_TEXT_ENCODING is injected by the macOS loader.
  // None are inherited from the plugin process.
  const allowed = [
    "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "SystemRoot", "USERPROFILE", "TEMP", "TMP",
    "SDKROOT", "CPATH", "LIBRARY_PATH", "MANPATH", "__CF_USER_TEXT_ENCODING",
  ];
  check("child env keys allowlisted", childKeys.every((k) => allowed.includes(k)), true);

  // Non-zero exit code propagates.
  const failPath = path.join(scriptDir, "fail.py");
  fs.writeFileSync(failPath, "import sys; sys.exit(3)");
  check("non-zero exit code propagates", (await runScript({ interpreter: python, scriptPath: failPath, cwd: scriptDir })).code, 3);

  // Timeout kills the actual Python process (no lingering child).
  const pidFile = path.join(scriptDir, "pid.txt");
  const slowPath = path.join(scriptDir, "slow.py");
  fs.writeFileSync(slowPath, `import os, time\nopen(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))\ntime.sleep(60)`);
  const slow = await runScript({ interpreter: python, scriptPath: slowPath, cwd: scriptDir, timeoutMs: 500 });
  check("timeout reported", slow.timedOut, true);
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  let alive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    alive = false;
  }
  check("timed-out python process is gone", alive, false);

  // Output is capped and flagged.
  const loudPath = path.join(scriptDir, "loud.py");
  fs.writeFileSync(loudPath, `print("x" * ${MAX_OUTPUT_CHARS * 3})`);
  const loud = await runScript({ interpreter: python, scriptPath: loudPath, cwd: scriptDir });
  check("huge output flagged truncated", loud.truncated, true);
  check("huge output retained tail is capped", loud.stdout.length <= MAX_OUTPUT_CHARS, true);

  // Missing interpreter: never rejects, error text in stderr.
  const noInterp = await runScript({ interpreter: path.join(scriptDir, "no-such-python"), scriptPath: weirdPath, cwd: scriptDir });
  check("missing interpreter → code 127", noInterp.code, 127);
  check("missing interpreter → stderr message", noInterp.stderr.length > 0, true);

  fs.rmSync(scriptDir, { recursive: true, force: true });
}

// ==================== Custom indicator approval + isolation (W02-B) ====================

// Minimal vault mock: files live in a plain map; getFiles returns TFile-shaped
// objects (only the fields the loader reads).
function makeHost(bodies, { approved = {}, confirm } = {}) {
  const calls = [];
  const host = {
    app: {
      vault: {
        getFiles: () =>
          Object.keys(bodies).map((p) => ({
            path: p,
            extension: p.split(".").pop(),
            basename: p.split("/").pop().replace(/\.js$/, ""),
          })),
        cachedRead: async (f) => bodies[f.path],
      },
    },
    pluginSettings: {
      indicatorFolderPath: "指标",
      disabledIndicators: [],
      approvedIndicatorHashes: approved,
    },
    confirmIndicatorApprovals: confirm
      ? async (pending) => {
          calls.push(pending.map((p) => p.path));
          return confirm(pending);
        }
      : undefined,
    _confirmCalls: calls,
  };
  return host;
}

const GOOD = `module.exports = {
  name: "好指标",
  metadata: { title: "Good", shortTitle: "G", overlay: true },
  inputConfig: [], defaultInputs: {},
  calculate: (bars) => ({ plots: { p: bars.map((b) => ({ time: b.time, value: b.close })) } }),
};`;

// 1. Without a confirm hook nothing unapproved ever executes.
{
  const host = makeHost({ "指标/good.js": GOOD });
  await syncIndicatorFiles(host);
  check("no confirm hook → not loaded", indicatorRegistry.resolve("good"), undefined);
  check("no confirm hook → listed as unapproved", getUnapprovedIndicators().map((u) => u.path), ["指标/good.js"]);
}

// 2. Approval via the confirm hook loads the indicator.
{
  const approved = {};
  const host = makeHost(
    { "指标/ok1.js": GOOD },
    {
      approved,
      confirm: (pending) => {
        for (const p of pending) approved[p.path] = p.hash;
        return { approved: pending, rejected: [] };
      },
    }
  );
  await syncIndicatorFiles(host);
  const def = indicatorRegistry.resolve("ok1");
  check("approved indicator loads", typeof def?.calculate, "function");
  check("confirm hook called once with the pending file", host._confirmCalls, [["指标/ok1.js"]]);

  // 3. Second sync with stored approval: no modal, still loaded.
  await syncIndicatorFiles(host);
  check("stored approval → no re-confirm", host._confirmCalls.length, 1);
  check("stored approval → still loaded", typeof indicatorRegistry.resolve("ok1")?.calculate, "function");
}

// 4. Rejection: not loaded, and NOT re-asked on the next sync (session memory).
{
  const host = makeHost(
    { "指标/no1.js": GOOD },
    { confirm: (pending) => ({ approved: [], rejected: pending }) }
  );
  await syncIndicatorFiles(host);
  await syncIndicatorFiles(host);
  check("rejected indicator not loaded", indicatorRegistry.resolve("no1"), undefined);
  check("rejected indicator not re-asked in session", host._confirmCalls.length, 1);
  check("rejected indicator listed as unapproved", getUnapprovedIndicators().map((u) => u.path), ["指标/no1.js"]);
}

// 5. Content change on an approved file requires re-confirmation (changed flag).
{
  const crypto = await import("node:crypto");
  const oldHash = crypto.createHash("sha256").update(GOOD).digest("hex");
  const CHANGED = GOOD.replace("好指标", "好指标v2");
  const approved = { "指标/ch.js": oldHash };
  const seen = [];
  const host = makeHost(
    { "指标/ch.js": CHANGED },
    {
      approved,
      confirm: (pending) => {
        seen.push(...pending.map((p) => p.changed));
        for (const p of pending) approved[p.path] = p.hash;
        return { approved: pending, rejected: [] };
      },
    }
  );
  await syncIndicatorFiles(host);
  check("changed content flagged for re-confirm", seen, [true]);
  check("re-approved changed indicator loads", typeof indicatorRegistry.resolve("ch")?.calculate, "function");
}

// 6. Forbidden capability token rejected; the good file still loads.
{
  const approved = {};
  const approveAll = (pending) => {
    for (const p of pending) approved[p.path] = p.hash;
    return { approved: pending, rejected: [] };
  };
  const host = makeHost(
    { "指标/evil.js": GOOD.replace("calculate:", "const x = require('fs');\n  calculate:"), "指标/good2.js": GOOD },
    { approved, confirm: approveAll }
  );
  await syncIndicatorFiles(host);
  check("forbidden-token indicator rejected", indicatorRegistry.resolve("evil"), undefined);
  check("forbidden-token error collected", getIndicatorLoadErrors().errors.some((e) => e.path === "指标/evil.js" && e.error.includes("受限标识符")), true);
  check("sibling indicator still loads", typeof indicatorRegistry.resolve("good2")?.calculate, "function");
}

// 7. Infinite loop at module load: timed out, collected, does not block others.
{
  const approved = {};
  const approveAll = (pending) => {
    for (const p of pending) approved[p.path] = p.hash;
    return { approved: pending, rejected: [] };
  };
  const host = makeHost(
    { "指标/loop.js": "while (true) {}\n" + GOOD, "指标/good3.js": GOOD },
    { approved, confirm: approveAll }
  );
  const t0 = Date.now();
  await syncIndicatorFiles(host);
  check("load-time infinite loop contained", getIndicatorLoadErrors().errors.some((e) => e.path === "指标/loop.js"), true);
  check("load-time loop finished near the 1s limit", Date.now() - t0 < 5000, true);
  check("sibling still loads after loop failure", typeof indicatorRegistry.resolve("good3")?.calculate, "function");
}

// 8-11. Compute-time isolation. All files approved up front via the hook.
{
  const barsData = [0, 1, 2].map((i) => ({
    tradeDate: `2026010${i + 1}`,
    open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, vol: 1000 + i,
  }));
  const bars = barsData.map((row) => ({
    time: Date.UTC(2026, 0, Number(row.tradeDate.slice(6)) ) / 1000,
    open: row.open, high: row.high, low: row.low, close: row.close, volume: row.vol,
  }));

  const THROWER = GOOD.replace("name: \"好指标\"", "name: \"坏指标\"").replace(
    "calculate: (bars) =>",
    "calculate: (bars) => { throw new Error('boom'); } //"
  );
  const MUTATOR = `module.exports = {
  name: "改输入指标",
  metadata: { title: "Mutator", shortTitle: "M", overlay: true },
  inputConfig: [], defaultInputs: {},
  calculate: (bars, inputs) => {
    bars[0].close = -999;
    inputs.x = 1;
    return { plots: { p: bars.map((b) => ({ time: b.time, value: b.close })) } };
  },
};`;
  const HOG = GOOD.replace(
    "calculate: (bars) =>",
    "calculate: (bars) => { const p = {}; for (let i = 0; i < 70; i++) p['s' + i] = []; return { plots: p }; } //"
  );

  const approved = {};
  const approveAll = (pending) => {
    for (const p of pending) approved[p.path] = p.hash;
    return { approved: pending, rejected: [] };
  };
  const host = makeHost(
    { "指标/thrower.js": THROWER, "指标/mutator.js": MUTATOR, "指标/hog.js": HOG, "指标/good4.js": GOOD },
    { approved, confirm: approveAll }
  );
  await syncIndicatorFiles(host);

  // 8. Throwing calculate: null result, recorded, others unaffected.
  const bad = computeIndicatorForInstance({ id: "thrower" }, bars, barsData);
  check("throwing indicator → null (isolated)", bad, null);
  check("throwing indicator → runtime error recorded", getIndicatorRuntimeError("thrower")?.includes("boom"), true);
  const good = computeIndicatorForInstance({ id: "good4" }, bars, barsData);
  check("other indicator still computes", good?.adapted?.plots?.p?.length, 3);

  // 9. Oversized output rejected at the boundary.
  const hog = computeIndicatorForInstance({ id: "hog" }, bars, barsData);
  check("oversized output → null (isolated)", hog, null);
  check("oversized output → error mentions the limit", getIndicatorRuntimeError("hog")?.includes("超过 64 条序列"), true);

  // 10. Inputs/bars mutation cannot leak back (calculate receives copies).
  const before = bars[0].close;
  const mutated = computeIndicatorForInstance({ id: "mutator" }, bars, barsData);
  check("mutating indicator still returns its result", mutated?.adapted?.plots?.p?.length, 3);
  check("bars untouched by indicator mutation", bars[0].close, before);

  // 11. Unknown id: null, no runtime error recorded.
  check("unknown id → null without runtime error", getIndicatorRuntimeError("nope"), undefined);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll execution-boundary checks passed.");
fs.rmSync(tmpDir, { recursive: true, force: true });
