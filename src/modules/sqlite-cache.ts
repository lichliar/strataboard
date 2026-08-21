import { Notice, type Vault } from "obsidian";
import initSqlJs, { type Database } from "sql.js";
import type { AssetType, Freq, MarketData, OhlcvRow, ParsedCardSpec, SeriesPoint, SymbolItem } from "../types";
import { CacheStore } from "./cache-store";

export interface SqliteCacheOptions {
  vault: Vault;
  pluginDir: string;
}

export interface SqliteCachePaths {
  ohlcvDbPath: string;
  marketDbPath: string;
  symbolsDbPath: string;
}

export class SqliteCache {
  private vault: Vault;
  private pluginDir: string;
  private SQL?: initSqlJs.SqlJsStatic;
  private ohlcvDb?: Database;
  private marketDb?: Database;
  private symbolsDb?: Database;
  private paths?: SqliteCachePaths;
  // sql.js keeps the whole DB in memory; exporting it to disk on every write
  // is O(DB size) per call and made batch operations (migration, refresh-all)
  // quadratic. Writes now only mark the DB dirty and a debounced flush
  // persists it; save() on unload flushes everything.
  private dirtyDbs = new Set<"ohlcv" | "market" | "symbols">();
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
    await this.ensureDir(paths.marketDbPath);
    await this.ensureDir(paths.symbolsDbPath);

    const wasmPath = `${this.pluginDir}/sql-wasm.wasm`;
    const wasmBinary = await this.readWasmBinary(wasmPath);
    this.SQL = await initSqlJs({ wasmBinary });

    this.ohlcvDb = await this.openOrCreate(paths.ohlcvDbPath);
    this.marketDb = await this.openOrCreate(paths.marketDbPath);
    this.symbolsDb = await this.openOrCreate(paths.symbolsDbPath);

    this.ensureSchemas();

    // Older builds cached fund W/M rows that were resampled at fetch time;
    // incremental refresh could then overwrite a complete week/month with a
    // partial one. Funds are now cached daily-only and resampled at read
    // time, so drop the legacy rows (they are re-fetched on next load).
    this.ohlcvDb.run(`DELETE FROM ohlcv WHERE asset_type = 'fund' AND freq <> 'D'`);
    this.markDirty("ohlcv");
  }

  private async readWasmBinary(path: string): Promise<ArrayBuffer> {
    try {
      return await this.vault.adapter.readBinary(path);
    } catch {
      throw new Error(`无法读取 sql-wasm.wasm。请确认插件目录中存在该文件：${path}`);
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

    this.marketDb!.run(`
      CREATE TABLE IF NOT EXISTS market_data (
        symbol TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        total_mv REAL,
        circ_mv REAL,
        pe REAL,
        pe_ttm REAL,
        volume_ratio REAL,
        turnover_rate REAL,
        turnover_rate_f REAL,
        amount REAL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (symbol, asset_type, trade_date)
      )
    `);

    this.marketDb!.run(`
      CREATE TABLE IF NOT EXISTS macro_series (
        source TEXT NOT NULL,
        series_id TEXT NOT NULL,
        obs_date TEXT NOT NULL,
        value REAL,
        PRIMARY KEY (source, series_id, obs_date)
      )
    `);

    this.symbolsDb!.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
        refreshed_at TEXT NOT NULL,
        PRIMARY KEY (asset_type, ts_code)
      )
    `);
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
    if (this.marketDb) await this.saveDb(this.marketDb, paths.marketDbPath);
    if (this.symbolsDb) await this.saveDb(this.symbolsDb, paths.symbolsDbPath);
    this.dirtyDbs.clear();
  }

  private markDirty(kind: "ohlcv" | "market" | "symbols"): void {
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
      const db = kind === "ohlcv" ? this.ohlcvDb : kind === "market" ? this.marketDb : this.symbolsDb;
      const path = kind === "ohlcv" ? paths.ohlcvDbPath : kind === "market" ? paths.marketDbPath : paths.symbolsDbPath;
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
    this.marketDb?.close();
    this.symbolsDb?.close();
    this.ohlcvDb = undefined;
    this.marketDb = undefined;
    this.symbolsDb = undefined;
  }

  // ==================== OHLCV ====================

  async loadOhlcvRange(
    key: { symbol: string; assetType: AssetType; freq: Freq },
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
    key: { symbol: string; assetType: AssetType; freq: Freq }
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
    key: { symbol: string; assetType: AssetType; freq: Freq },
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

  async loadSymbols(assetType: AssetType): Promise<SymbolItem[]> {
    const stmt = this.symbolsDb!.prepare(`
      SELECT ts_code, symbol, name, enname, exchange, list_date, asset_type, refreshed_at
      FROM symbols
      WHERE asset_type = ?
    `);
    stmt.bind([assetType]);
    const items: SymbolItem[] = [];
    while (stmt.step()) {
      items.push(this.rowToSymbol(stmt.getAsObject()));
    }
    stmt.free();
    return items;
  }

  async saveSymbols(assetType: AssetType, items: SymbolItem[]): Promise<void> {
    const db = this.symbolsDb!;
    const refreshedAt = new Date().toISOString();
    db.run("BEGIN TRANSACTION");
    // Clear existing entries for this asset type to remove stale symbols.
    const deleteStmt = db.prepare("DELETE FROM symbols WHERE asset_type = ?");
    deleteStmt.run([assetType]);
    deleteStmt.free();

    const insertStmt = db.prepare(`
      INSERT INTO symbols
      (ts_code, symbol, name, enname, exchange, list_date, asset_type, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insertStmt.run([
        item.tsCode,
        item.symbol,
        item.name,
        item.enname ?? null,
        item.exchange,
        item.listDate ?? null,
        item.assetType,
        refreshedAt,
      ]);
    }
    insertStmt.free();
    db.run("COMMIT");
    this.markDirty("symbols");
  }

  async isSymbolCacheStale(assetType: AssetType, maxAgeDays: number): Promise<boolean> {
    const stmt = this.symbolsDb!.prepare(`
      SELECT MIN(refreshed_at) as refreshed_at
      FROM symbols
      WHERE asset_type = ?
    `);
    stmt.bind([assetType]);
    if (!stmt.step()) {
      stmt.free();
      return true;
    }
    const r = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    const refreshedAt = r.refreshed_at as string | undefined;
    if (!refreshedAt) return true;
    const refreshed = new Date(refreshedAt).getTime();
    return Date.now() - refreshed > maxAgeDays * 24 * 60 * 60 * 1000;
  }

  async searchSymbols(assetType: AssetType, query: string): Promise<SymbolItem[]> {
    const lower = `%${query.toLowerCase()}%`;
    const stmt = this.symbolsDb!.prepare(`
      SELECT ts_code, symbol, name, enname, exchange, list_date, asset_type, refreshed_at
      FROM symbols
      WHERE asset_type = ? AND (LOWER(ts_code) LIKE ? OR LOWER(symbol) LIKE ? OR LOWER(name) LIKE ?)
    `);
    stmt.bind([assetType, lower, lower, lower]);
    const items: SymbolItem[] = [];
    while (stmt.step()) {
      items.push(this.rowToSymbol(stmt.getAsObject()));
    }
    stmt.free();
    return items;
  }

  async lookupSymbol(tsCode: string, assetType: AssetType): Promise<SymbolItem | undefined> {
    const stmt = this.symbolsDb!.prepare(`
      SELECT ts_code, symbol, name, enname, exchange, list_date, asset_type, refreshed_at
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
    };
  }

  // Merges individual symbols without clearing the asset type's list — used
  // for the token-free tx/em sources, whose "symbol list" is just the items
  // the user has picked from remote search (so the chart header can resolve
  // their names later via lookupSymbol).
  async upsertSymbols(items: SymbolItem[]): Promise<void> {
    const db = this.symbolsDb!;
    const refreshedAt = new Date().toISOString();
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO symbols
      (ts_code, symbol, name, enname, exchange, list_date, asset_type, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insertStmt.run([
        item.tsCode,
        item.symbol,
        item.name,
        item.enname ?? null,
        item.exchange,
        item.listDate ?? null,
        item.assetType,
        refreshedAt,
      ]);
    }
    insertStmt.free();
    this.markDirty("symbols");
  }

  // ==================== Market Data ====================

  async loadMarketData(spec: ParsedCardSpec, tradeDate: string): Promise<MarketData | null> {
    const stmt = this.marketDb!.prepare(`
      SELECT symbol, asset_type, trade_date, total_mv, circ_mv, pe, pe_ttm,
             volume_ratio, turnover_rate, turnover_rate_f, amount
      FROM market_data
      WHERE symbol = ? AND asset_type = ? AND trade_date = ?
    `);
    stmt.bind([spec.symbol, spec.assetType, tradeDate]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const r = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return this.rowToMarketData(r);
  }

  async saveMarketData(spec: ParsedCardSpec, data: MarketData): Promise<void> {
    const db = this.marketDb!;
    const updatedAt = new Date().toISOString().slice(0, 10);
    db.run("BEGIN TRANSACTION");
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO market_data
      (symbol, asset_type, trade_date, total_mv, circ_mv, pe, pe_ttm,
       volume_ratio, turnover_rate, turnover_rate_f, amount, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run([
      spec.symbol,
      spec.assetType,
      data.tradeDate,
      data.totalMv ?? null,
      data.circMv ?? null,
      data.pe ?? null,
      data.peTtm ?? null,
      data.volumeRatio ?? null,
      data.turnoverRate ?? null,
      data.turnoverRateF ?? null,
      data.amount ?? null,
      updatedAt,
    ]);
    stmt.free();
    db.run("COMMIT");
    this.markDirty("market");
  }

  private rowToMarketData(r: Record<string, unknown>): MarketData {
    return {
      tradeDate: r.trade_date as string,
      totalMv: (r.total_mv as number | undefined | null) ?? undefined,
      circMv: (r.circ_mv as number | undefined | null) ?? undefined,
      pe: (r.pe as number | undefined | null) ?? undefined,
      peTtm: (r.pe_ttm as number | undefined | null) ?? undefined,
      volumeRatio: (r.volume_ratio as number | undefined | null) ?? undefined,
      turnoverRate: (r.turnover_rate as number | undefined | null) ?? undefined,
      turnoverRateF: (r.turnover_rate_f as number | undefined | null) ?? undefined,
      amount: (r.amount as number | undefined | null) ?? undefined,
    };
  }

  // ==================== Macro Series ====================

  // Generic point-in-time series cache (cn_m money supply, FRED, ...),
  // keyed by (source, series_id). obs_date is YYYY-MM-DD.
  async loadMacroSeries(source: string, seriesId: string, startDate: string, endDate: string): Promise<SeriesPoint[]> {
    const stmt = this.marketDb!.prepare(`
      SELECT obs_date, value
      FROM macro_series
      WHERE source = ? AND series_id = ? AND obs_date >= ? AND obs_date <= ?
      ORDER BY obs_date ASC
    `);
    stmt.bind([source, seriesId, startDate, endDate]);
    const rows: SeriesPoint[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, unknown>;
      const value = Number(r.value);
      if (!Number.isFinite(value)) continue;
      rows.push({ date: r.obs_date as string, value });
    }
    stmt.free();
    return rows;
  }

  async mergeMacroSeriesRows(source: string, seriesId: string, rows: SeriesPoint[]): Promise<void> {
    if (rows.length === 0) return;
    const db = this.marketDb!;
    db.run("BEGIN TRANSACTION");
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO macro_series
      (source, series_id, obs_date, value)
      VALUES (?, ?, ?, ?)
    `);
    for (const row of rows) {
      // Skip rows with null/NaN values on ingest.
      if (!Number.isFinite(row.value)) continue;
      stmt.run([source, seriesId, row.date, row.value]);
    }
    stmt.free();
    db.run("COMMIT");
    this.markDirty("market");
  }

  async getMacroSeriesMaxDate(source: string, seriesId: string): Promise<string | null> {
    const stmt = this.marketDb!.prepare(`
      SELECT MAX(obs_date) as max_date
      FROM macro_series
      WHERE source = ? AND series_id = ?
    `);
    stmt.bind([source, seriesId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const r = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return (r.max_date as string | undefined | null) ?? null;
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

  async listMarketDataKeys(): Promise<{ symbol: string; assetType: AssetType; rows: number }[]> {
    const stmt = this.marketDb!.prepare(`
      SELECT symbol, asset_type, COUNT(*) as rows
      FROM market_data
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

  async deleteMarketData(symbol: string, assetType: AssetType): Promise<void> {
    const stmt = this.marketDb!.prepare("DELETE FROM market_data WHERE symbol = ? AND asset_type = ?");
    stmt.run([symbol, assetType]);
    stmt.free();
    this.markDirty("market");
  }

  async listMacroSeriesKeys(): Promise<{ source: string; seriesId: string; rows: number }[]> {
    const stmt = this.marketDb!.prepare(`
      SELECT source, series_id, COUNT(*) as rows
      FROM macro_series
      GROUP BY source, series_id
      ORDER BY source, series_id
    `);
    const keys: { source: string; seriesId: string; rows: number }[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, unknown>;
      keys.push({ source: r.source as string, seriesId: r.series_id as string, rows: Number(r.rows) });
    }
    stmt.free();
    return keys;
  }

  async deleteMacroSeries(source: string, seriesId: string): Promise<void> {
    const stmt = this.marketDb!.prepare("DELETE FROM macro_series WHERE source = ? AND series_id = ?");
    stmt.run([source, seriesId]);
    stmt.free();
    this.markDirty("market");
  }

  // ==================== Migration ====================

  async migrateFromLegacy(legacyDataPath: string, legacySymbolPath: string): Promise<void> {
    if (await this.isMigrationDone()) return;

    const cacheStore = new CacheStore(this.vault);

    try {
      await this.migrateSymbols(cacheStore, legacySymbolPath);
      await this.migrateOhlcv(cacheStore, legacyDataPath);
      await this.migrateMarketData(cacheStore, legacyDataPath);
      // Flush migrated data before recording the flag, so a crash can't
      // leave the flag set while the data never reached disk.
      await this.flushDirty();
      await this.setMigrationDone();
    } catch (e) {
      console.error("StrataBoard: SQLite migration failed", e);
      new Notice(`金融卡片：JSON 缓存迁移到 SQLite 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async isMigrationDone(): Promise<boolean> {
    const stmt = this.symbolsDb!.prepare("SELECT value FROM meta WHERE key = ?");
    stmt.bind(["migration_v1_json_done"]);
    const done = stmt.step();
    stmt.free();
    return done;
  }

  private async setMigrationDone(): Promise<void> {
    const stmt = this.symbolsDb!.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    stmt.run(["migration_v1_json_done", new Date().toISOString()]);
    stmt.free();
    // meta lives in symbols.db; persist immediately.
    await this.saveDb(this.symbolsDb!, this.paths!.symbolsDbPath);
  }

  private async migrateSymbols(cacheStore: CacheStore, legacySymbolPath: string): Promise<void> {
    const assetTypes: AssetType[] = ["stock", "fund", "index"];
    for (const assetType of assetTypes) {
      const path = `${legacySymbolPath}/${assetType}s.json`;
      const cached = await cacheStore.readSymbolCache(path);
      if (cached && cached.items.length > 0) {
        await this.saveSymbols(assetType, cached.items);
      }
    }
  }

  private async migrateOhlcv(cacheStore: CacheStore, legacyDataPath: string): Promise<void> {
    const assetTypes: AssetType[] = ["stock", "fund", "index"];
    for (const assetType of assetTypes) {
      const dir = `${legacyDataPath}/${assetType}`;
      if (!(await this.vault.adapter.exists(dir))) continue;

      const list = await this.listDirectory(dir);
      for (const file of list.files) {
        if (!file.endsWith(".json")) continue;
        const cached = await cacheStore.readDataCache(file);
        if (!cached || cached.rows.length === 0) continue;
        await this.mergeOhlcvRows(
          { symbol: cached.symbol, assetType: cached.assetType, freq: cached.freq },
          cached.rows
        );
      }
    }
  }

  private async migrateMarketData(cacheStore: CacheStore, legacyDataPath: string): Promise<void> {
    const marketDir = `${legacyDataPath}/market`;
    if (!(await this.vault.adapter.exists(marketDir))) return;

    const assetTypes: AssetType[] = ["stock", "fund", "index"];
    for (const assetType of assetTypes) {
      const dir = `${marketDir}/${assetType}`;
      if (!(await this.vault.adapter.exists(dir))) continue;

      const list = await this.listDirectory(dir);
      for (const file of list.files) {
        if (!file.endsWith(".json")) continue;
        const cached = await cacheStore.readJson<MarketData>(file);
        if (!cached) continue;

        // Parse symbol and tradeDate from filename: "{symbol}-{tradeDate}.json"
        const basename = file.split("/").pop()!.replace(".json", "");
        const lastDash = basename.lastIndexOf("-");
        if (lastDash < 0) continue;
        const symbol = basename.slice(0, lastDash).replace(/-/g, ".");
        const tradeDate = basename.slice(lastDash + 1);

        await this.saveMarketData(
          { symbol, assetType, freq: "D", range: "", version: 1 },
          { ...cached, tradeDate }
        );
      }
    }
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

  private async listDirectory(dir: string): Promise<{ files: string[]; folders: string[] }> {
    try {
      return await (this.vault.adapter as any).list(dir);
    } catch {
      return { files: [], folders: [] };
    }
  }
}
