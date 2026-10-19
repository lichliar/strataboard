// Security-module behavior checks (no test framework, per project rules):
// esbuild-bundles the pure modules (url-policy / redact / credentials) and
// runs table-driven assertions. Run: node scripts/check-security.mjs
import esbuild from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const entry = `
export { evaluateUrl } from "./src/utils/url-policy";
export { redactSecrets, redactSecretsWith } from "./src/modules/redact";
export { envVarNameForSource, createEnvApiKeyResolver, newCredentialId, isCredentialId, setRedactionSecretProvider } from "./src/modules/credentials";
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

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sb-sec-")), "check.cjs");
fs.writeFileSync(tmp, result.outputFiles[0].text);
const m = await import(pathToFileURL(tmp).href);
fs.rmSync(path.dirname(tmp), { recursive: true, force: true });

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

const { evaluateUrl, redactSecrets, envVarNameForSource, createEnvApiKeyResolver, newCredentialId, isCredentialId, setRedactionSecretProvider } = m;

// --- URL policy ---
check("https public ok", evaluateUrl("https://api.example.com/data?code=x", []).kind, "ok");
check("https template ok", evaluateUrl("https://x.com/k?code={code}&token={apiKey}", []).kind, "ok");
check("public http rejected", evaluateUrl("http://api.example.com/x", []).kind, "reject");
check("private http rejected", evaluateUrl("http://192.168.1.10/x", []).kind, "reject");
check("loopback http needs confirm", evaluateUrl("http://localhost:8080/api", []), { kind: "loopback-http", origin: "http://localhost:8080" });
check("loopback http confirmed ok", evaluateUrl("http://localhost:8080/api", ["http://localhost:8080"]).kind, "ok");
check("127.x loopback needs confirm", evaluateUrl("http://127.0.0.1:9/x", []).kind, "loopback-http");
check("ipv6 loopback needs confirm", evaluateUrl("http://[::1]:8080/x", []).kind, "loopback-http");
check("userinfo rejected", evaluateUrl("https://user:pass@example.com/x", []).kind, "reject");
check("metadata https rejected", evaluateUrl("https://169.254.169.254/latest/meta-data", []).kind, "reject");
check("metadata http rejected", evaluateUrl("http://169.254.169.254/", []).kind, "reject");
check("gcp metadata rejected", evaluateUrl("http://metadata.google.internal/", []).kind, "reject");
check("non-http scheme rejected", evaluateUrl("ftp://example.com/x", []).kind, "reject");
check("unparseable rejected", evaluateUrl("not a url", []).kind, "reject");
check("private https warns", evaluateUrl("https://192.168.1.10/api", []).kind, "warn-private");
check("10/8 warns", evaluateUrl("https://10.0.0.5/x", []).kind, "warn-private");
check("172.16 warns", evaluateUrl("https://172.16.0.1/x", []).kind, "warn-private");
check("172.32 is public", evaluateUrl("https://172.32.0.1/x", []).kind, "ok");
check("loopback https ok", evaluateUrl("https://localhost:8443/x", []).kind, "ok");

// --- redaction ---
const SECRET = "sk-live-ab cd+ef/gh12345";
setRedactionSecretProvider(() => [SECRET]);
const enc = encodeURIComponent(SECRET);
check("raw secret masked", redactSecrets(`error: token ${SECRET} rejected`), "error: token *** rejected");
check("url-encoded secret masked", redactSecrets(`GET https://x.com/?k=${enc}`).includes(enc), false);
check("query param masked", redactSecrets("call https://x.com/?code=sh600519&token=whatever123 end"), "call https://x.com/?code=sh600519&token=*** end");
check("authorization header masked", redactSecrets("headers:\nAuthorization: Bearer abcdef123456\nrest"), "headers:\nAuthorization: ***\nrest");
check("cookie header masked", redactSecrets('payload {"Cookie": "session=abcdef123"}'), 'payload {"Cookie": "***"}');
check("response echo masked", redactSecrets(`{"error":"bad key ${SECRET}"}`), '{"error":"bad key ***"}');
check("short secrets not over-masked", redactSecrets("the key is a key"), "the key is a key");

// --- env credentials ---
check("env var name legalized", envVarNameForSource("src-ab.cd ef"), "STRATABOARD_API_KEY_SRC_AB_CD_EF");
const used = [];
const resolver = createEnvApiKeyResolver({ STRATABOARD_API_KEY_SRC_1: "env-secret-1" }, (s) => used.push(s));
const needsKey = { id: "src-1", name: "n", enabled: true, format: "json", klineUrl: "https://x.com/?token={apiKey}" };
const noKey = { id: "src-2", name: "n", enabled: true, format: "json", klineUrl: "https://x.com/" };
check("env secret resolves", resolver(needsKey), { key: "env-secret-1", missing: false });
check("used secret tracked for redaction", used, ["env-secret-1"]);
check("missing env for keyless source is fine", resolver(noKey), { missing: false });
check("missing env for keyed source fails", resolver({ ...needsKey, id: "src-9" }), { missing: true });

// --- credential ids ---
const id = newCredentialId();
check("credential id format", isCredentialId(id) && /^strataboard-cred-[a-z0-9-]+$/.test(id), true);
check("foreign id rejected", isCredentialId("other-plugin-thing"), false);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll security checks passed.");
