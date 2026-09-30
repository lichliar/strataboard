import { type Vault } from "obsidian";
import initSqlJs, { type Database } from "sql.js";
import type { AssetType, Freq, OhlcvRow, SymbolItem } from "../types";
import { cacheAssetKey } from "../types";
import { t } from "../i18n";

// The asset_type column is a plain cache-key string: user custom sources
// carry `custom:<sourceId>` (see cacheAssetKey) so two sources sharing a
// symbol code never collide.

export interface SqliteCacheOptions {
  vault: Vault;
  pluginDir: string;
}

export interface SqliteCachePaths {
  ohlcvDbPath: string;
  symbolsDbPath: string;
}

export class SqliteCache {
  private vault: Vault;
  private pluginDir: string;
  private SQL?: initSqlJs.SqlJsStatic;
  private ohlcvDb?: Database;
  private symbolsDb?: Database;
  private paths?: SqliteCachePaths;
  // sql.js keeps the whole DB in memory; exporting it to disk on every write
  // is O(DB size) per call and made batch operations quadratic. Writes now
  // only mark the DB dirty and a debounced flush persists it; save() on
  // unload flushes everything.
  private dirtyDbs = new Set<"ohlcv" | "symbols">();
  private saveTimer: number | null = null;
  private flushPromise: Promise<void> | null = null;
  private static readonly SAVE_DEBOUNCE_MS = 1500;

  constructor(options: SqliteCacheOptions) {
    this.vault = options.vault;
    this.pluginDir = options.pluginDir;
  }

  async init(paths: SqliteCachePaths): Promise<void> {
    this.paths = paths;
    await this.ensureDir(paths.ohlcvDbPath);
    await this.ensureDir(paths.symbolsDbPath);

    const wasmPath = `${this.pluginDir}/sql-wasm.wasm`;
    const wasmBinary = await this.readWasmBinary(wasmPath);
    this.SQL = await initSqlJs({ wasmBinary });

    this.ohlcvDb = await this.openOrCreate(paths.ohlcvDbPath);
    this.symbolsDb = await this.openOrCreate(paths.symbolsDbPath);

    this.ensureSchemas();
  }

  private async readWasmBinary(path: string): Promise<ArrayBuffer> {
    try {
      return await this.vault.adapter.readBinary(path);
    } catch {
      throw new Error(t("无法读取 sql-wasm.wasm。请确认插件目录中存在该文件：{path}", { path }));
    }
  }

  private async openOrCreate(path: string): Promise<Database> {
    if (!(await this.vault.adapter.exists(path))) {
      return new this.SQL!.Database();
    }
    const buffer = await this.vault.adapter.readBinary(path);
    return new this.SQL!.Database(new Uint8Array(buffer));
  }

  private ensureSchemas(): void {
    this.ohlcvDb!.run(`
      CREATE TABLE IF NOT EXISTS ohlcv (
        symbol TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        freq TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        vol REAL NOT NULL,
        amount REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (symbol, asset_type, freq, trade_date)
      )
    `);

    this.symbolsDb!.run(`
      CREATE TABLE IF NOT EXISTS symbols (
        ts_code TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        enname TEXT,
        exchange TEXT,
        list_date TEXT,
        asset_type TEXT NOT NULL,
        profile TEXT,
        refreshed_at TEXT NOT NULL,
        PRIMARY KEY (asset_type, ts_code)
      )
    `);
    // Existing databases predate the profile column (the search endpoint's
    // declared classification, persisted on pick).
    try {
      this.symbolsDb!.run("ALTER TABLE symbols ADD COLUMN profile TEXT");
    } catch { /* column already present */ }
    this.symbolsDb!.run(`
      CREATE INDEX IF NOT EXISTS idx_symbols_search
      ON symbols(asset_type, symbol, name)
    `);
  }

  async save(): Promise<void> {
    const paths = this.paths;
    if (!paths) return;
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Wait for any in-flight debounced flush so we don't write concurrently.
    await this.flushPromise;
    if (this.ohlcvDb) await this.saveDb(this.ohlcvDb, paths.ohlcvDbPath);
    if (this.symbolsDb) await this.saveDb(this.symbolsDb, paths.symbolsDbPath);
    this.dirtyDbs.clear();
  }

  private markDirty(kind: "ohlcv" | "symbols"): void {
    this.dirtyDbs.add(kind);
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.flushPromise = this.flushDirty().catch((e) => {
        console.error("StrataBoard: failed to persist SQLite cache", e);
      });
      void this.flushPromise.finally(() => {
        this.flushPromise = null;
      });
    }, SqliteCache.SAVE_DEBOUNCE_MS);
  }

  private async flushDirty(): Promise<void> {
    const paths = this.paths;
    if (!paths) {
      this.dirtyDbs.clear();
      return;
    }
    const kinds = Array.from(this.dirtyDbs);
    this.dirtyDbs.clear();
    for (const kind of kinds) {
      const db = kind === "ohlcv" ? this.ohlcvDb : this.symbolsDb;
      const path = kind === "ohlcv" ? paths.ohlcvDbPath : paths.symbolsDbPath;
      if (db) await this.saveDb(db, path);
    }
  }

  private async saveDb(db: Database, path: string): Promise<void> {
    const data = db.export();
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    await this.ensureDir(path);
    await this.vault.adapter.writeBinary(path, buffer as ArrayBuffer);
  }

  close(): void {
    this.ohlcvDb?.close();
    this.symbolsDb?.close();
    this.ohlcvDb = undefined;
    this.symbolsDb = undefined;
  }

  // ==================== OHLCV ====================

  async loadOhlcvRange(
    key: { symbol: string; assetType: string; freq: Freq },
    start: string,
    end: string
  ): Promise<OhlcvRow[]> {
    const stmt = this.ohlcvDb!.prepare(`
      SELECT trade_date, open, high, low, close, vol, amount
      FROM ohlcv
      WHERE symbol = ? AND asset_type = ? AND freq = ? AND trade_date >= ? AND trade_date <= ?
      ORDER BY trade_date ASC
    `);
    stmt.bind([key.symbol, key.assetType, key.freq, start, end]);
    const rows: OhlcvRow[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, unknown>;
      rows.push(this.rowToOhlcv(r));
    }
    stmt.free();
    return rows;
  }

  async getOhlcvExtent(
    key: { symbol: string; assetType: string; freq: Freq }
  ): Promise<{ minDate: string; maxDate: string } | null> {
    const stmt = this.ohlcvDb!.prepare(`
      SELECT MIN(trade_date) as min_date, MAX(trade_date) as max_date
      FROM ohlcv
      WHERE symbol = ? AND asset_type = ? AND freq = ?
    `);
    stmt.bind([key.symbol, key.assetType, key.freq]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const r = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    const minDate = r.min_date as string | undefined;
    const maxDate = r.max_date as string | undefined;
    if (!minDate || !maxDate) return null;
    return { minDate, maxDate };
  }

  async mergeOhlcvRows(
    key: { symbol: string; assetType: string; freq: Freq },
    rows: OhlcvRow[]
  ): Promise<void> {
    if (rows.length === 0) return;
    const db = this.ohlcvDb!;
    const updatedAt = new Date().toISOString().slice(0, 10);
    db.run("BEGIN TRANSACTION");
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO ohlcv
      (symbol, asset_type, freq, trade_date, open, high, low, close, vol, amount, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      stmt.run([
        key.symbol,
        key.assetType,
        key.freq,
        row.tradeDate,
        row.open,
        row.high,
        row.low,
        row.close,
        row.vol,
        row.amount,
        updatedAt,
      ]);
    }
    stmt.free();
    db.run("COMMIT");
    this.markDirty("ohlcv");
  }

  private rowToOhlcv(r: Record<string, unknown>): OhlcvRow {
    return {
      tradeDate: r.trade_date as string,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      vol: Number(r.vol),
      amount: Number(r.amount),
    };
  }

  // ==================== Symbols ====================

  // The "symbol list" of a custom source is just the items the user has
  // picked from remote search or manual entry, so the chart header can
  // resolve their names later via lookupSymbol.
  async lookupSymbol(tsCode: string, assetType: string): Promise<SymbolItem | undefined> {
    const stmt = this.symbolsDb!.prepare(`
      SELECT ts_code, symbol, name, enname, exchange, list_date, asset_type, profile, refreshed_at
      FROM symbols
      WHERE asset_type = ? AND ts_code = ?
    `);
    stmt.bind([assetType, tsCode]);
    if (!stmt.step()) {
      stmt.free();
      return undefined;
    }
    const item = this.rowToSymbol(stmt.getAsObject());
    stmt.free();
    return item;
  }

  private rowToSymbol(r: Record<string, unknown>): SymbolItem {
    return {
      tsCode: r.ts_code as string,
      symbol: r.symbol as string,
      name: r.name as string,
      enname: (r.enname as string | undefined | null) ?? undefined,
      exchange: (r.exchange as string | undefined | null) ?? "",
      listDate: (r.list_date as string | undefined | null) ?? undefined,
      assetType: r.asset_type as AssetType,
      profile: (r.profile as string | undefined | null) ?? undefined,
    };
  }

  // Merges individual symbols without clearing the asset type's list — used
  // for custom sources (see lookupSymbol). Items key on `custom:<sourceId>`
  // via cacheAssetKey.
  async upsertSymbols(items: SymbolItem[]): Promise<void> {
    const db = this.symbolsDb!;
    const refreshedAt = new Date().toISOString();
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO symbols
      (ts_code, symbol, name, enname, exchange, list_date, asset_type, profile, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insertStmt.run([
        item.tsCode,
        item.symbol,
        item.name,
        item.enname ?? null,
        item.exchange,
        item.listDate ?? null,
        cacheAssetKey(item.assetType, item.sourceId),
        item.profile ?? null,
        refreshedAt,
      ]);
    }
    insertStmt.free();
    this.markDirty("symbols");
  }

  // ==================== Maintenance ====================

  // Key enumeration + targeted deletes for the settings-tab cache cleanup
  // (maintenance.ts decides which keys are no longer referenced by any card).
  async listOhlcvKeys(): Promise<{ symbol: string; assetType: AssetType; rows: number }[]> {
    const stmt = this.ohlcvDb!.prepare(`
      SELECT symbol, asset_type, COUNT(*) as rows
      FROM ohlcv
      GROUP BY symbol, asset_type
      ORDER BY symbol
    `);
    const keys: { symbol: string; assetType: AssetType; rows: number }[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, unknown>;
      keys.push({ symbol: r.symbol as string, assetType: r.asset_type as AssetType, rows: Number(r.rows) });
    }
    stmt.free();
    return keys;
  }

  async deleteOhlcv(symbol: string, assetType: AssetType): Promise<void> {
    const stmt = this.ohlcvDb!.prepare("DELETE FROM ohlcv WHERE symbol = ? AND asset_type = ?");
    stmt.run([symbol, assetType]);
    stmt.free();
    this.markDirty("ohlcv");
  }

  // ==================== Helpers ====================

  private async ensureDir(filePath: string): Promise<void> {
    const parts = filePath.split("/");
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
