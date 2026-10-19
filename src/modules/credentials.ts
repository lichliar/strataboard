import type { App } from "obsidian";
import { sourceNeedsApiKey, type CustomSourceDef } from "../types";

// Central credential seam: every runtime secret goes through this module.
// The plugin persists only a `credentialId` reference in data.json; the real
// secret lives in Obsidian's SecretStorage (plugin side) or in a per-source
// environment variable (CLI/MCP side). Secrets must never be serialized,
// logged, or sent to AI context.

// SecretStorage ids are lowercase-alphanumeric-plus-dashes; the prefix keeps
// our entries apart from other plugins sharing the vault-wide store.
const CREDENTIAL_PREFIX = "strataboard-cred-";

export function newCredentialId(): string {
  return `${CREDENTIAL_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function isCredentialId(id: string): boolean {
  return id.startsWith(CREDENTIAL_PREFIX);
}

export interface CredentialStore {
  // null = absent or deleted. SecretStorage has no delete API, so removal
  // writes "" and every read treats "" as absent.
  get(id: string): string | null;
  set(id: string, secret: string): void;
  remove(id: string): void;
  // Only this plugin's ids holding a non-empty secret.
  list(): string[];
}

export function createPluginCredentialStore(app: App): CredentialStore {
  const storage = app.secretStorage;
  return {
    get(id) {
      if (!isCredentialId(id)) return null;
      const value = storage.getSecret(id);
      return value ? value : null;
    },
    set(id, secret) {
      if (!isCredentialId(id)) throw new Error(`Invalid credential id: ${id}`);
      if (!secret) throw new Error("Refusing to store an empty secret.");
      storage.setSecret(id, secret);
    },
    remove(id) {
      if (isCredentialId(id) && storage.listSecrets().includes(id)) storage.setSecret(id, "");
    },
    list() {
      return storage.listSecrets().filter((id) => isCredentialId(id) && !!storage.getSecret(id));
    },
  };
}

// Runtime resolution result: `missing` means the source references a
// credential (or needs one) that could not be resolved — callers must fail
// with a clear "re-select the credential" / "missing runtime credential"
// error instead of silently sending an empty key.
export interface ApiKeyResolution {
  key?: string;
  missing: boolean;
}

export type ApiKeyResolver = (def: CustomSourceDef) => ApiKeyResolution;

export function createPluginApiKeyResolver(store: CredentialStore): ApiKeyResolver {
  return (def) => {
    if (!def.credentialId) return { missing: false };
    const key = store.get(def.credentialId);
    return key ? { key, missing: false } : { missing: true };
  };
}

// CLI/MCP: no SecretStorage in a headless process, so secrets come from a
// per-source environment variable the user exports when starting the
// process. Never accept keys via CLI arguments (shell history / ps).
export function envVarNameForSource(sourceId: string): string {
  return `STRATABOARD_API_KEY_${sourceId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function createEnvApiKeyResolver(
  env: Record<string, string | undefined> = process.env,
  onSecretUsed?: (secret: string) => void,
): ApiKeyResolver {
  return (def) => {
    const value = env[envVarNameForSource(def.id)];
    if (!value) return { missing: sourceNeedsApiKey(def) };
    onSecretUsed?.(value);
    return { key: value, missing: false };
  };
}

// --- Redaction secret registry ---
// redact.ts asks this provider for the values it must mask. The plugin
// registers "all stored credentials"; the CLI registers each env secret at
// the moment it is used (enumeration would pull unrelated process env into
// the mask set).

let redactionSecretProvider: () => string[] = () => [];

export function setRedactionSecretProvider(provider: () => string[]): void {
  redactionSecretProvider = provider;
}

export function redactionSecrets(): string[] {
  return redactionSecretProvider();
}

// Plugin-side registration: mask every stored credential.
export function registerStoreForRedaction(store: CredentialStore): void {
  setRedactionSecretProvider(() => store.list().map((id) => store.get(id)).filter((v): v is string => !!v));
}
