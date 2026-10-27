import type { Vault } from "obsidian";

const VERSION = 1;
const DATA_KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const PBKDF2_ITERATIONS = 600000;
const MANIFEST_FILE = "manifest.json";
const CREDENTIAL_ID_PATTERN = /^strataboard-cred-[a-z0-9-]+$/;

interface Manifest {
  version: 1;
  kdf: "PBKDF2";
  hash: "SHA-256";
  iterations: 600000;
  salt: string;
  iv: string;
  ciphertext: string;
}

interface CredentialEntry {
  version: 1;
  id: string;
  iv: string;
  ciphertext: string;
}

const ERROR_MESSAGES = {
  "not-found": "Credential sync manifest not found.",
  "already-exists": "Credential sync manifest already exists.",
  "unlock-failed": "Credential sync unlock failed.",
  corrupt: "Credential sync data is corrupt.",
} as const;

export class CredentialSyncError extends Error {
  readonly code: keyof typeof ERROR_MESSAGES;

  constructor(code: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[code]);
    this.name = "CredentialSyncError";
    this.code = code;
  }
}

export function encodeSyncKey(key: Uint8Array): string {
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeSyncKey(encoded: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("Invalid base64 data.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (encodeSyncKey(bytes) !== encoded) throw new Error("Invalid base64 data.");
  return bytes;
}

function corrupt(): CredentialSyncError {
  return new CredentialSyncError("corrupt");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isBase64WithLength(value: unknown, minimum: number, maximum = minimum): value is string {
  if (typeof value !== "string") return false;
  try {
    const length = decodeSyncKey(value).length;
    return length >= minimum && length <= maximum;
  } catch {
    return false;
  }
}

function isManifest(value: unknown): value is Manifest {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "kdf", "hash", "iterations", "salt", "iv", "ciphertext"])) {
    return false;
  }
  return value.version === VERSION
    && value.kdf === "PBKDF2"
    && value.hash === "SHA-256"
    && value.iterations === PBKDF2_ITERATIONS
    && isBase64WithLength(value.salt, SALT_BYTES)
    && isBase64WithLength(value.iv, IV_BYTES)
    && isBase64WithLength(value.ciphertext, DATA_KEY_BYTES + GCM_TAG_BYTES);
}

function isCredentialEntry(value: unknown): value is CredentialEntry {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "id", "iv", "ciphertext"])) return false;
  return value.version === VERSION
    && typeof value.id === "string"
    && CREDENTIAL_ID_PATTERN.test(value.id)
    && isBase64WithLength(value.iv, IV_BYTES)
    && isBase64WithLength(value.ciphertext, GCM_TAG_BYTES + 1, Number.MAX_SAFE_INTEGER);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw corrupt();
  }
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveWrapKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const passwordKey = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: arrayBuffer(salt), iterations: PBKDF2_ITERATIONS },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

async function importDataKey(dataKey: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    arrayBuffer(dataKey),
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function additionalData(id: string): Uint8Array {
  return new TextEncoder().encode(`strataboard-credential-v1:${id}`);
}

export class CredentialSyncFiles {
  private readonly folder: string;
  private readonly manifestPath: string;

  constructor(private readonly vault: Vault, folder: string) {
    this.folder = folder.replace(/\/+$/, "");
    this.manifestPath = `${this.folder}/${MANIFEST_FILE}`;
  }

  containsPath(path: string): boolean {
    if (path === this.manifestPath) return true;
    if (!path.startsWith(`${this.folder}/`)) return false;
    const name = path.slice(this.folder.length + 1);
    return name.endsWith(".json") && CREDENTIAL_ID_PATTERN.test(name.slice(0, -".json".length));
  }

  async hasManifest(): Promise<boolean> {
    return this.vault.adapter.exists(this.manifestPath);
  }

  async create(password: string): Promise<Uint8Array> {
    if (await this.hasManifest()) throw new CredentialSyncError("already-exists");
    if (!password) throw new Error("Password must not be empty.");

    const dataKey = randomBytes(DATA_KEY_BYTES);
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const wrapKey = await deriveWrapKey(password, salt);
    const extractableDataKey = await globalThis.crypto.subtle.importKey(
      "raw",
      arrayBuffer(dataKey),
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const wrapped = await globalThis.crypto.subtle.wrapKey(
      "raw",
      extractableDataKey,
      wrapKey,
      { name: "AES-GCM", iv: arrayBuffer(iv) },
    );
    const manifest: Manifest = {
      version: VERSION,
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: encodeSyncKey(salt),
      iv: encodeSyncKey(iv),
      ciphertext: encodeSyncKey(new Uint8Array(wrapped)),
    };
    await this.ensureFolder();
    await this.vault.adapter.write(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return dataKey;
  }

  async unlock(password: string): Promise<Uint8Array> {
    if (!await this.hasManifest()) throw new CredentialSyncError("not-found");
    const parsed = parseJson(await this.vault.adapter.read(this.manifestPath));
    if (!isManifest(parsed)) throw corrupt();
    if (!password) throw new CredentialSyncError("unlock-failed");

    try {
      const wrapKey = await deriveWrapKey(password, decodeSyncKey(parsed.salt));
      const unwrapped = await globalThis.crypto.subtle.unwrapKey(
        "raw",
        arrayBuffer(decodeSyncKey(parsed.ciphertext)),
        wrapKey,
        { name: "AES-GCM", iv: arrayBuffer(decodeSyncKey(parsed.iv)) },
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const dataKey = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", unwrapped));
      if (dataKey.length !== DATA_KEY_BYTES) throw new Error("Invalid unwrapped key length.");
      return dataKey;
    } catch {
      throw new CredentialSyncError("unlock-failed");
    }
  }

  async readAll(dataKey: Uint8Array): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!await this.hasManifest()) throw new CredentialSyncError("not-found");
    const listed = await this.vault.adapter.list(this.folder);
    const cryptoKey = await importDataKey(dataKey, ["decrypt"]);

    for (const path of listed.files) {
      if (path === this.manifestPath) continue;
      const name = path.slice(this.folder.length + 1);
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      // Sync tools may leave conflict copies or OS metadata beside our files.
      if (!CREDENTIAL_ID_PATTERN.test(id)) continue;
      if (!this.containsPath(path)) throw corrupt();
      const parsed = parseJson(await this.vault.adapter.read(path));
      if (!isCredentialEntry(parsed) || parsed.id !== id) throw corrupt();
      try {
        const plaintext = await globalThis.crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: arrayBuffer(decodeSyncKey(parsed.iv)),
            additionalData: arrayBuffer(additionalData(id)),
          },
          cryptoKey,
          arrayBuffer(decodeSyncKey(parsed.ciphertext)),
        );
        result.set(id, new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      } catch {
        throw corrupt();
      }
    }
    return result;
  }

  async write(id: string, secret: string, dataKey: Uint8Array): Promise<void> {
    if (!CREDENTIAL_ID_PATTERN.test(id)) throw new Error("Invalid credential id.");
    if (!secret) throw new Error("Secret must not be empty.");
    const cryptoKey = await importDataKey(dataKey, ["encrypt"]);
    const iv = randomBytes(IV_BYTES);
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: arrayBuffer(iv), additionalData: arrayBuffer(additionalData(id)) },
      cryptoKey,
      new TextEncoder().encode(secret),
    );
    const entry: CredentialEntry = {
      version: VERSION,
      id,
      iv: encodeSyncKey(iv),
      ciphertext: encodeSyncKey(new Uint8Array(ciphertext)),
    };
    await this.ensureFolder();
    await this.vault.adapter.write(this.entryPath(id), `${JSON.stringify(entry, null, 2)}\n`);
  }

  async remove(id: string): Promise<void> {
    if (!CREDENTIAL_ID_PATTERN.test(id)) throw new Error("Invalid credential id.");
    const path = this.entryPath(id);
    if (await this.vault.adapter.exists(path)) await this.vault.adapter.remove(path);
  }

  async removeAll(): Promise<void> {
    if (await this.vault.adapter.exists(this.folder)) await this.vault.adapter.rmdir(this.folder, true);
  }

  private entryPath(id: string): string {
    return `${this.folder}/${id}.json`;
  }

  private async ensureFolder(): Promise<void> {
    if (!await this.vault.adapter.exists(this.folder)) await this.vault.adapter.mkdir(this.folder);
  }
}
