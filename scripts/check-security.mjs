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
export { CredentialSyncFiles } from "./src/modules/credential-sync";
export { envVarNameForSource, createEnvApiKeyResolver, createPluginApiKeyResolver, createPluginCredentialStore, newCredentialId, isCredentialId, setRedactionSecretProvider } from "./src/modules/credentials";
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

const {
  evaluateUrl,
  redactSecrets,
  envVarNameForSource,
  createEnvApiKeyResolver,
  createPluginApiKeyResolver,
  createPluginCredentialStore,
  CredentialSyncFiles,
  newCredentialId,
  isCredentialId,
  setRedactionSecretProvider,
} = m;

async function checkAsync(name, operation) {
  try {
    await operation();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function expectCredentialError(operation, code) {
  try {
    await operation;
  } catch (error) {
    if (error?.code === code) return;
    throw new Error(`Expected credential error ${code}.`);
  }
  throw new Error(`Expected credential error ${code}.`);
}

function normalizeVaultPath(value) {
  const normalized = path.posix.normalize(value).replace(/^\/+/, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Invalid vault path.");
  }
  return normalized;
}

function createMemoryVault(files) {
  const adapter = {
    async exists(value) {
      const target = normalizeVaultPath(value);
      return files.has(target) || [...files.keys()].some((file) => file.startsWith(`${target}/`));
    },
    async read(value) {
      const target = normalizeVaultPath(value);
      if (!files.has(target)) throw new Error("Vault file not found.");
      return files.get(target);
    },
    async write(value, data) {
      files.set(normalizeVaultPath(value), data);
    },
    async list(value) {
      const target = normalizeVaultPath(value);
      const prefix = `${target}/`;
      const listedFiles = new Set();
      const folders = new Set();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const remainder = file.slice(prefix.length);
        const separator = remainder.indexOf("/");
        if (separator === -1) listedFiles.add(file);
        else folders.add(`${prefix}${remainder.slice(0, separator)}`);
      }
      return { files: [...listedFiles].sort(), folders: [...folders].sort() };
    },
    async mkdir(value) {
      normalizeVaultPath(value);
    },
    async remove(value) {
      files.delete(normalizeVaultPath(value));
    },
    async rmdir(value, recursive) {
      const target = normalizeVaultPath(value);
      const contained = [...files.keys()].filter((file) => file.startsWith(`${target}/`));
      if (!recursive && contained.length > 0) throw new Error("Vault folder is not empty.");
      for (const file of contained) files.delete(file);
    },
  };
  return { configDir: "test-config", adapter };
}

function createMemorySecretStorage() {
  const secrets = new Map();
  return {
    getSecret(id) {
      return secrets.get(id) ?? null;
    },
    setSecret(id, value) {
      if (value === "") secrets.delete(id);
      else secrets.set(id, value);
    },
    listSecrets() {
      return [...secrets.keys()];
    },
  };
}

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

// --- encrypted credential sync files ---
const SYNC_PASSWORD = "test-password-correct-123";
const WRONG_PASSWORD = "test-password-wrong-123";
const syncFolder = "test-config/plugins/strataboard/credentials";
const syncFileMap = new Map();
const syncVault = createMemoryVault(syncFileMap);
const syncFiles = new CredentialSyncFiles(syncVault, syncFolder);
const fileCredentialId = "strataboard-cred-file-roundtrip";
const unicodeSecret = "test-secret-密码-🔐";
const dataKey = await syncFiles.create(SYNC_PASSWORD);
await syncFiles.write(fileCredentialId, unicodeSecret, dataKey);
const unlockedKey = await syncFiles.unlock(SYNC_PASSWORD);
const roundTrip = await syncFiles.readAll(unlockedKey);
check("sync create/unlock/readAll round-trip with Unicode", roundTrip.size === 1 && roundTrip.get(fileCredentialId) === unicodeSecret, true);
check("sync unlocked key matches created key", dataKey.length === unlockedKey.length && dataKey.every((byte, index) => byte === unlockedKey[index]), true);
check("sync manifest and entries contain no plaintext or password", [...syncFileMap.values()].every((contents) => !contents.includes(unicodeSecret) && !contents.includes(SYNC_PASSWORD)), true);
await checkAsync("sync wrong password rejected", () => expectCredentialError(syncFiles.unlock(WRONG_PASSWORD), "unlock-failed"));

const fileEntryPath = `${syncFolder}/${fileCredentialId}.json`;
const originalEntry = syncFileMap.get(fileEntryPath);
const tamperedEntry = JSON.parse(originalEntry);
const tamperedCiphertext = Buffer.from(tamperedEntry.ciphertext, "base64");
tamperedCiphertext[0] ^= 1;
tamperedEntry.ciphertext = tamperedCiphertext.toString("base64");
await syncVault.adapter.write(fileEntryPath, JSON.stringify(tamperedEntry));
await checkAsync("sync ciphertext tampering rejected", () => expectCredentialError(syncFiles.readAll(dataKey), "corrupt"));
await syncVault.adapter.write(fileEntryPath, originalEntry);

const otherFileCredentialId = "strataboard-cred-file-other";
const otherFileSecret = "test-secret-other-file";
await syncFiles.write(otherFileCredentialId, otherFileSecret, dataKey);
const otherEntryPath = `${syncFolder}/${otherFileCredentialId}.json`;
const originalOtherEntry = syncFileMap.get(otherEntryPath);
const movedEntry = JSON.parse(originalEntry);
movedEntry.id = otherFileCredentialId;
await syncVault.adapter.write(otherEntryPath, JSON.stringify(movedEntry));
await checkAsync("sync entry moved to another credential id rejected by AAD", () => expectCredentialError(syncFiles.readAll(dataKey), "corrupt"));
await syncVault.adapter.write(otherEntryPath, originalOtherEntry);

// --- two-device plugin credential sync ---
const sharedFiles = new Map();
const secretStorageA = createMemorySecretStorage();
const secretStorageB = createMemorySecretStorage();
const appA = { vault: createMemoryVault(sharedFiles), secretStorage: secretStorageA };
const appB = { vault: createMemoryVault(sharedFiles), secretStorage: secretStorageB };
const storeA = createPluginCredentialStore(appA);
const storeB = createPluginCredentialStore(appB);
const credentialA = "strataboard-cred-device-a";
const credentialB = "strataboard-cred-device-b";
const secretA = "test-secret-device-a";
const rotatedSecretA = "test-secret-device-a-rotated";
const secretB = "test-secret-device-b";
await storeA.set(credentialA, secretA);
await storeB.set(credentialB, secretB);
await storeA.enableSync(SYNC_PASSWORD, false);
await storeB.configureSync(true);
await storeB.unlockSync(SYNC_PASSWORD, false);
await storeA.reloadSync();
check("first sync unlock merges independent local credentials", storeA.get(credentialA) === secretA && storeA.get(credentialB) === secretB && storeB.get(credentialA) === secretA && storeB.get(credentialB) === secretB, true);

await storeA.set(credentialA, rotatedSecretA);
await storeB.reloadSync();
check("credential rotation reaches reload and local secret storage", storeB.get(credentialA) === rotatedSecretA && secretStorageB.getSecret(credentialA) === rotatedSecretA, true);

await storeA.remove(credentialA);
await storeB.reloadSync();
check("credential deletion reaches reload and removes local cache", storeB.get(credentialA) === null && secretStorageB.getSecret(credentialA) === null, true);

await storeB.lockSync();
const lockedResolver = createPluginApiKeyResolver(storeB);
check("lockSync retains readable local credential cache", storeB.get(credentialB) === secretB, true);
check("uncached credential resolver reports locked sync", lockedResolver({ credentialId: "strataboard-cred-not-cached" }), { missing: true, locked: true });

await storeB.unlockSync(SYNC_PASSWORD, true);
const rememberedStoreB = createPluginCredentialStore(appB);
await rememberedStoreB.configureSync(true);
check("remembered sync key automatically unlocks a new store", rememberedStoreB.getSyncState(), { enabled: true, status: "unlocked" });
check("automatically unlocked store reads synced credential", rememberedStoreB.get(credentialB) === secretB, true);
const storeC = createPluginCredentialStore({ vault: appA.vault, secretStorage: createMemorySecretStorage() });
await storeC.unlockSync(SYNC_PASSWORD, false);
check("unlocking an existing store also enables sync immediately", storeC.getSyncState(), { enabled: true, status: "unlocked" });

await appA.vault.adapter.write(`${syncFolder}/.DS_Store`, "not a credential");
await storeA.reloadSync();
check("unrelated sync-tool and OS files do not block reload", storeA.get(credentialB) === secretB, true);
await rememberedStoreB.disableSync();
check("disabling sync retains this device's local cache", rememberedStoreB.get(credentialB) === secretB, true);
await checkAsync("missing remote manifest preserves another device's local cache", async () => {
  try {
    await storeA.reloadSync();
  } catch {
    if (storeA.get(credentialB) === secretB) return;
    throw new Error("Local cache was not preserved.");
  }
  throw new Error("Missing manifest was treated as an empty remote store.");
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll security checks passed.");
