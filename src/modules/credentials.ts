import type { App } from "obsidian";
import { sourceNeedsApiKey, type CustomSourceDef } from "../types";
import { t } from "../i18n";
import {
  CredentialSyncError,
  CredentialSyncFiles,
  decodeSyncKey,
  encodeSyncKey,
} from "./credential-sync";

// Central credential seam: plaintext runtime secrets live only in memory,
// SecretStorage, or CLI/MCP environment variables. Optional vault sync stores
// authenticated ciphertext; data.json carries only references and its switch.
const CREDENTIAL_PREFIX = "strataboard-cred-";
const SYNC_DATA_KEY_ID = "strataboard-sync-data-key";
const SYNC_INITIALIZED_ID = "strataboard-sync-initialized";

export function newCredentialId(): string {
  return `${CREDENTIAL_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function isCredentialId(id: string): boolean {
  return id.startsWith(CREDENTIAL_PREFIX);
}

export type CredentialSyncStatus = "disabled" | "locked" | "unlocked" | "error";

export interface CredentialSyncState {
  enabled: boolean;
  status: CredentialSyncStatus;
  detail?: string;
}

export interface CredentialStore {
  get(id: string): string | null;
  set(id: string, secret: string): Promise<void>;
  remove(id: string): Promise<void>;
  list(): string[];
  isSyncLocked(): boolean;
}

export interface PluginCredentialStore extends CredentialStore {
  getSyncState(): CredentialSyncState;
  configureSync(enabled: boolean): Promise<void>;
  hasSyncManifest(): Promise<boolean>;
  enableSync(password: string, remember: boolean): Promise<void>;
  unlockSync(password: string, remember: boolean): Promise<void>;
  lockSync(): Promise<void>;
  disableSync(): Promise<void>;
  reloadSync(): Promise<void>;
  handleSyncPath(path: string): boolean;
  closeSync(): void;
}

class LocalCredentialStore implements PluginCredentialStore {
  private readonly storage: App["secretStorage"];
  private readonly values = new Map<string, string>();
  private readonly files: CredentialSyncFiles;
  private syncEnabled = false;
  private status: CredentialSyncStatus = "disabled";
  private detail: string | undefined;
  private dataKey: Uint8Array | undefined;
  private syncInitialized: boolean;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(app: App) {
    this.storage = app.secretStorage;
    for (const id of this.storage.listSecrets()) {
      if (!isCredentialId(id)) continue;
      const value = this.storage.getSecret(id);
      if (value) this.values.set(id, value);
    }
    this.syncInitialized = this.storage.getSecret(SYNC_INITIALIZED_ID) === "1";
    this.files = new CredentialSyncFiles(app.vault, `${app.vault.configDir}/plugins/strataboard/credentials`);
  }

  get(id: string): string | null {
    return isCredentialId(id) ? this.values.get(id) ?? null : null;
  }

  list(): string[] {
    return [...this.values.keys()];
  }

  isSyncLocked(): boolean {
    return this.syncEnabled && this.status !== "unlocked";
  }

  getSyncState(): CredentialSyncState {
    return { enabled: this.syncEnabled, status: this.status, ...(this.detail ? { detail: this.detail } : {}) };
  }

  hasSyncManifest(): Promise<boolean> {
    return this.files.hasManifest();
  }

  handleSyncPath(path: string): boolean {
    return this.syncEnabled && !!this.dataKey && this.files.containsPath(path);
  }

  closeSync(): void {
    this.closed = true;
  }

  configureSync(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (!enabled) {
        this.syncEnabled = false;
        this.status = "disabled";
        this.detail = undefined;
        this.dataKey = undefined;
        this.syncInitialized = false;
        this.storage.setSecret(SYNC_DATA_KEY_ID, "");
        this.storage.setSecret(SYNC_INITIALIZED_ID, "");
        return;
      }
      if (this.syncEnabled && this.status === "unlocked") return;
      this.syncEnabled = true;
      const encoded = this.storage.getSecret(SYNC_DATA_KEY_ID);
      if (!encoded) {
        this.status = "locked";
        this.detail = undefined;
        return;
      }
      try {
        this.dataKey = decodeSyncKey(encoded);
        await this.applyRemote(this.dataKey, false);
      } catch (error) {
        const translated = this.translateSyncError(error);
        this.status = "error";
        this.detail = translated.message;
      }
    });
  }

  enableSync(password: string, remember: boolean): Promise<void> {
    return this.enqueue(async () => {
      try {
        const key = await this.files.hasManifest()
          ? await this.files.unlock(password)
          : await this.files.create(password);
        this.dataKey = key;
        await this.applyRemote(key, !this.syncInitialized);
        this.rememberKey(key, remember);
        this.syncEnabled = true;
      } catch (error) {
        this.dataKey = undefined;
        this.failSync(error);
      }
    });
  }

  unlockSync(password: string, remember: boolean): Promise<void> {
    return this.enqueue(async () => {
      try {
        const key = await this.files.unlock(password);
        this.dataKey = key;
        await this.applyRemote(key, !this.syncInitialized);
        this.rememberKey(key, remember);
        this.syncEnabled = true;
      } catch (error) {
        this.dataKey = undefined;
        this.failSync(error);
      }
    });
  }

  lockSync(): Promise<void> {
    return this.enqueue(async () => {
      this.dataKey = undefined;
      this.storage.setSecret(SYNC_DATA_KEY_ID, "");
      if (this.syncEnabled) this.status = "locked";
      this.detail = undefined;
    });
  }

  disableSync(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.files.removeAll();
        this.dataKey = undefined;
        this.syncEnabled = false;
        this.syncInitialized = false;
        this.status = "disabled";
        this.detail = undefined;
        this.storage.setSecret(SYNC_DATA_KEY_ID, "");
        this.storage.setSecret(SYNC_INITIALIZED_ID, "");
      } catch (error) {
        this.failSync(error);
      }
    });
  }

  reloadSync(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.syncEnabled || this.closed) return;
      if (!this.dataKey) {
        this.status = "locked";
        throw new Error(t("请先解锁凭证同步。"));
      }
      try {
        await this.applyRemote(this.dataKey, false);
      } catch (error) {
        this.failSync(error);
      }
    });
  }

  set(id: string, secret: string): Promise<void> {
    return this.enqueue(async () => {
      this.validate(id, secret);
      if (this.syncEnabled && !this.dataKey) {
        this.status = "locked";
        throw new Error(t("请先解锁凭证同步，再保存或更新凭据。"));
      }
      try {
        if (this.syncEnabled && this.dataKey) await this.files.write(id, secret, this.dataKey);
        this.setLocal(id, secret);
        if (this.syncEnabled) {
          this.status = "unlocked";
          this.detail = undefined;
        }
      } catch (error) {
        if (this.syncEnabled) this.failSync(error);
        throw error;
      }
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isCredentialId(id)) return;
      if (this.syncEnabled && !this.dataKey) {
        this.status = "locked";
        throw new Error(t("请先解锁凭证同步，再删除凭据。"));
      }
      try {
        if (this.syncEnabled && this.dataKey) await this.files.remove(id);
        this.removeLocal(id);
      } catch (error) {
        if (this.syncEnabled) this.failSync(error);
        throw error;
      }
    });
  }

  private async applyRemote(key: Uint8Array, mergeLocal: boolean): Promise<void> {
    const remote = await this.files.readAll(key);
    if (mergeLocal) {
      for (const [id, secret] of this.values) {
        if (remote.has(id)) continue;
        await this.files.write(id, secret, key);
        remote.set(id, secret);
      }
    }
    for (const id of this.values.keys()) {
      if (!remote.has(id)) this.removeLocal(id);
    }
    for (const [id, secret] of remote) {
      if (this.values.get(id) !== secret) this.setLocal(id, secret);
    }
    this.syncInitialized = true;
    this.storage.setSecret(SYNC_INITIALIZED_ID, "1");
    this.status = "unlocked";
    this.detail = undefined;
  }

  private rememberKey(key: Uint8Array, remember: boolean): void {
    this.storage.setSecret(SYNC_DATA_KEY_ID, remember ? encodeSyncKey(key) : "");
  }

  private setLocal(id: string, secret: string): void {
    this.validate(id, secret);
    this.values.set(id, secret);
    this.storage.setSecret(id, secret);
  }

  private removeLocal(id: string): void {
    this.values.delete(id);
    if (this.storage.listSecrets().includes(id)) this.storage.setSecret(id, "");
  }

  private validate(id: string, secret: string): void {
    if (!isCredentialId(id)) throw new Error(`Invalid credential id: ${id}`);
    if (!secret) throw new Error("Refusing to store an empty secret.");
  }

  private failSync(error: unknown): never {
    const translated = this.translateSyncError(error);
    this.status = !this.dataKey || (error instanceof CredentialSyncError && error.code === "unlock-failed")
      ? "locked"
      : "error";
    this.detail = translated.message;
    throw translated;
  }

  private translateSyncError(error: unknown): Error {
    if (error instanceof CredentialSyncError) {
      if (error.code === "unlock-failed") return new Error(t("解锁密码不正确，或同步数据已损坏。"));
      if (error.code === "not-found") return new Error(t("未找到同步凭证文件，请确认同步软件已包含插件配置目录。"));
      if (error.code === "already-exists") return new Error(t("检测到已有同步凭证，请输入原解锁密码。"));
      return new Error(t("同步凭证数据已损坏，无法读取。"));
    }
    return new Error(t("凭证同步失败，请检查同步文件后重试。"));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

export function createPluginCredentialStore(app: App): PluginCredentialStore {
  return new LocalCredentialStore(app);
}

// Runtime resolution distinguishes a genuinely missing secret from a synced
// credential whose ciphertext has not been unlocked on this device.
export interface ApiKeyResolution {
  key?: string;
  missing: boolean;
  locked?: boolean;
}

export type ApiKeyResolver = (def: CustomSourceDef) => ApiKeyResolution;

export function createPluginApiKeyResolver(store: CredentialStore): ApiKeyResolver {
  return (def) => {
    if (!def.credentialId) return { missing: sourceNeedsApiKey(def) };
    const key = store.get(def.credentialId);
    return key
      ? { key, missing: false }
      : { missing: true, locked: store.isSyncLocked() };
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
