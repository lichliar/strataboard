#!/usr/bin/env node
/**
 * Manual CI-style check for the indicator builtins (the repo has no test
 * framework). Bundles src/modules/indicators/{builtins,bars}.ts with the
 * repo's own esbuild into a temp CJS file, runs every builtin on a
 * deterministic synthetic fixture, and either writes or compares snapshots.
 *
 *   node scripts/check-indicators.mjs --write   # regenerate snapshots
 *   node scripts/check-indicators.mjs           # compare (exit 1 on failure)
 *
 * No network. Cleanup of temp files is guaranteed via finally.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = path.join(repoRoot, "scripts", "indicator-snapshots.json");
const writeMode = process.argv.includes("--write");

// ---------- deterministic fixture ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86400;
const T0 = Date.UTC(2024, 0, 1) / 1000;

function buildDailyBars() {
  const rand = mulberry32(42);
  const bars = [];
  let close = 100;
  for (let i = 0; i < 260; i++) {
    const drift = (rand() - 0.48) * 2.4; // slight upward bias
    const open = close;
    close = Math.max(1, close + drift * (close / 100));
    const high = Math.max(open, close) + rand() * (close / 100);
    const low = Math.min(open, close) - rand() * (close / 100);
    const volume = Math.floor(1_000_000 * (0.5 + rand()));
    bars.push({ time: T0 + i * DAY, open, high, low, close, volume });
  }
  return bars;
}

// Weekly aggregate in chunks of 5 trading days; bar time = last day of the
// chunk (same convention as data-adapter's period-end tradeDate).
function resampleWeekly(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i += 5) {
    const chunk = bars.slice(i, i + 5);
    out.push({
      time: chunk[chunk.length - 1].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, b) => sum + b.volume, 0),
    });
  }
  return out;
}

function unixToTradeDate(time) {
  return new Date(time * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

function barsToRows(bars) {
  return bars.map((b) => ({
    tradeDate: unixToTradeDate(b.time),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    vol: b.volume,
    amount: 0,
  }));
}

// ---------- snapshot helpers ----------

const round6 = (v) => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r; // normalize -0
};

function summarizePlots(plots) {
  const summary = {};
  for (const [plotId, points] of Object.entries(plots)) {
    const values = points.map((p) => p.value);
    const nonNaN = values.filter((v) => !Number.isNaN(v));
    summary[plotId] = {
      nan: values.length - nonNaN.length,
      head: nonNaN.slice(0, 3).map(round6),
      tail: nonNaN.slice(-3).map(round6),
    };
  }
  return summary;
}

function closeEnough(a, b) {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
}

function compareRun(id, runName, actual, expected, failures) {
  for (const [plotId, exp] of Object.entries(expected.plots)) {
    const act = actual.plots[plotId];
    const label = `${id}${runName ? `@${runName}` : ""}.${plotId}`;
    if (!act) {
      failures.push(`${label}: plot missing in actual output`);
      continue;
    }
    if (act.nan !== exp.nan) {
      failures.push(`${label}: NaN count ${act.nan} != expected ${exp.nan}`);
    }
    for (const key of ["head", "tail"]) {
      const av = act[key];
      const ev = exp[key];
      if (av.length !== ev.length || !av.every((v, i) => closeEnough(v, ev[i]))) {
        failures.push(`${label}: ${key} mismatch: got [${av}] expected [${ev}]`);
      }
    }
  }
  for (const plotId of Object.keys(actual.plots)) {
    if (!expected.plots[plotId]) failures.push(`${id}: unexpected extra plot ${plotId}`);
  }
}

// ---------- bundle the TS sources with the repo's esbuild ----------

const tmp = mkdtempSync(path.join(tmpdir(), "check-indicators-"));
try {
  const entryPath = path.join(tmp, "entry.ts");
  const bundlePath = path.join(tmp, "bundle.cjs");
  writeFileSync(
    entryPath,
    [
      `export { BUILTIN_INDICATORS } from ${JSON.stringify(path.join(repoRoot, "src/modules/indicators/builtins.ts"))};`,
      `export { adaptResultTimes } from ${JSON.stringify(path.join(repoRoot, "src/modules/indicators/bars.ts"))};`,
    ].join("\n")
  );
  execFileSync(
    path.join(repoRoot, "node_modules", ".bin", "esbuild"),
    [entryPath, "--bundle", "--platform=node", "--format=cjs", "--charset=utf8", `--outfile=${bundlePath}`, "--log-level=warning"],
    { cwd: repoRoot, stdio: "inherit" }
  );
  const { BUILTIN_INDICATORS, adaptResultTimes } = createRequire(import.meta.url)(bundlePath);

  // ---------- run ----------

  const dailyBars = buildDailyBars();
  const weeklyBars = resampleWeekly(dailyBars);
  const dailyTimes = new Set(dailyBars.map((b) => unixToTradeDate(b.time).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")));
  const weeklyTimes = new Set(weeklyBars.map((b) => unixToTradeDate(b.time).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")));

  const failures = [];
  const runs = {};

  for (const def of BUILTIN_INDICATORS) {
    const cases = [{ name: "", bars: dailyBars, ctx: undefined, times: dailyTimes, rows: barsToRows(dailyBars) }];
    if (def.id === "ma") {
      // Exercise the trading-day snap path: MA computed on daily native bars,
      // values fitted onto weekly displayed bars.
      cases.push({ name: "weekly", bars: weeklyBars, ctx: { nativeBars: dailyBars }, times: weeklyTimes, rows: barsToRows(weeklyBars) });
    }
    for (const c of cases) {
      const key = c.name ? `${def.id}@${c.name}` : def.id;
      let result;
      try {
        result = def.calculate(c.bars, def.defaultInputs, c.ctx);
      } catch (e) {
        failures.push(`${key}: calculate threw: ${e.message}`);
        continue;
      }
      runs[key] = { plots: summarizePlots(result.plots) };

      // Time-adaptation red line: after adaptation every output point time
      // must be a real bar of the chart (future-bar points are dropped).
      const adapted = adaptResultTimes(result, c.rows);
      for (const [plotId, points] of Object.entries(adapted.plots)) {
        for (const point of points) {
          if (!c.times.has(point.time)) {
            failures.push(`${key}.${plotId}: adapted time ${point.time} is not a bar time`);
            break;
          }
        }
      }
    }
  }

  // Reference check: RSI(14) on a strictly increasing series is 100 (all gains).
  {
    const rsi = BUILTIN_INDICATORS.find((d) => d.id === "rsi");
    const upBars = Array.from({ length: 20 }, (_, i) => ({
      time: T0 + i * DAY,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 1000,
    }));
    const result = rsi.calculate(upBars, rsi.defaultInputs);
    const last = result.plots.plot0[result.plots.plot0.length - 1].value;
    if (!closeEnough(last, 100)) {
      failures.push(`rsi reference check: last RSI(14) on monotonic uptrend = ${last}, expected 100`);
    }
  }

  // Prove the MA snap path ran: with ctx.nativeBars, MA(20) at the last
  // weekly bar equals the SMA of the last 20 DAILY closes (the fixture's
  // last weekly chunk ends on the last daily bar).
  {
    const weeklyRun = runs["ma@weekly"];
    const expected = dailyBars.slice(-20).reduce((sum, b) => sum + b.close, 0) / 20;
    const actual = weeklyRun?.plots.plot0.tail.at(-1);
    if (actual === undefined || !closeEnough(actual, round6(expected))) {
      failures.push(`ma snap-path check: last weekly MA(20) = ${actual}, expected daily-close SMA ${round6(expected)}`);
    }
  }

  // ---------- write or compare ----------

  if (writeMode) {
    const snapshot = {
      version: 1,
      fixture: "mulberry32(seed=42) random walk, 260 consecutive daily bars from 2024-01-01 UTC, start close 100; ma@weekly = 5-day chunks, ctx.nativeBars = daily",
      runs,
    };
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");
    console.log(`Wrote ${snapshotPath} (${Object.keys(runs).length} runs)`);
  } else {
    if (!existsSync(snapshotPath)) {
      console.error(`Snapshot file missing: ${snapshotPath} — run with --write first`);
      process.exit(1);
    }
    const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
    for (const [key, exp] of Object.entries(expected.runs)) {
      const [id, runName] = key.split("@");
      const act = runs[key];
      if (!act) {
        failures.push(`${key}: run missing in actual output`);
        continue;
      }
      compareRun(id, runName ?? "", act, exp, failures);
    }
    for (const key of Object.keys(runs)) {
      if (!expected.runs[key]) failures.push(`${key}: unexpected extra run`);
    }
  }

  for (const key of Object.keys(runs)) {
    const failed = failures.some((f) => f.startsWith(`${key}:`) || f.startsWith(`${key}.`));
    if (!writeMode) console.log(`${failed ? "FAIL" : "PASS"}  ${key}`);
  }
  const rsiFailed = failures.some((f) => f.startsWith("rsi reference"));
  console.log(`${rsiFailed ? "FAIL" : "PASS"}  rsi reference (monotonic uptrend => 100)`);
  const maSnapFailed = failures.some((f) => f.startsWith("ma snap-path"));
  console.log(`${maSnapFailed ? "FAIL" : "PASS"}  ma snap-path (weekly MA == daily-close SMA)`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nAll indicator checks passed (${Object.keys(runs).length} runs).`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
