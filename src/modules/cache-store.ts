import { type Vault } from "obsidian";
import type { CacheEntry, SymbolCacheEntry } from "../types";

const CACHE_SCHEMA_VERSION = 1;

/**
 * Generic JSON file read/write helper.
 *
 * Previously the primary cache backend; now kept mainly for one-time migration
 * of legacy JSON caches into SQLite.
 */
export class CacheStore {
  constructor(private vault: Vault) {}

  async readDataCache(path: string): Promise<CacheEntry | null> {
    return this.readJson<CacheEntry>(path);
  }

  async writeDataCache(path: string, entry: CacheEntry): Promise<void> {
    await this.writeJson(path, entry);
  }

  async mergeDataCache(path: string, newRows: CacheEntry["rows"], symbol: string, assetType: string, freq: string): Promise<CacheEntry> {
    const existing = await this.readDataCache(path);
    const rowsByDate = new Map<string, CacheEntry["rows"][number]>();

    if (existing) {
      for (const row of existing.rows) {
        rowsByDate.set(row.tradeDate, row);
      }
    }

    for (const row of newRows) {
      rowsByDate.set(row.tradeDate, row);
    }

    const mergedRows = Array.from(rowsByDate.values()).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));

    const entry: CacheEntry = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      symbol,
      assetType: assetType as any,
      freq: freq as any,
      updatedAt: new Date().toISOString().slice(0, 10),
      rows: mergedRows,
    };

    await this.writeDataCache(path, entry);
    return entry;
  }

  async readSymbolCache(path: string): Promise<SymbolCacheEntry | null> {
    return this.readJson<SymbolCacheEntry>(path);
  }

  async writeSymbolCache(path: string, entry: SymbolCacheEntry): Promise<void> {
    await this.writeJson(path, entry);
  }

  async readJson<T>(path: string): Promise<T | null> {
    try {
      const content = await this.vault.adapter.read(path);
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  async writeJson<T>(path: string, data: T): Promise<void> {
    await this.ensureDir(path);
    await this.vault.adapter.write(path, JSON.stringify(data, null, 2));
  }

  async ensureDir(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.vault.adapter.exists(current))) {
        await this.vault.adapter.mkdir(current);
      }
    }
  }
}
