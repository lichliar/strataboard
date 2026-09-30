import { Notice } from "obsidian";
import type { CustomSourceDef, OhlcvRow, ParsedCardSpec, SymbolItem } from "../types";
import { cacheAssetKey, isWholeTableSearchSource, resolveGroupApiKey } from "../types";
import { resolveDateRange, formatDate, parseDateYmd, nextTradingDate, prevTradingDate } from "../utils/date";
import { matchSymbolEntry } from "../utils/symbol-list";
import { SqliteCache } from "./sqlite-cache";
import { CustomQuoteClient } from "./custom-quote-client";
import { CsvQuoteClient } from "./csv-quote-client";
import { t } from "../i18n";

// Whole-table remote search (search template without {query}): the endpoint
// returns its full symbol list and we filter locally. The list is cached per
// source — a group-scoped search fans out to every member, and refetching a
// multi-thousand-row table per source per keystroke would take seconds under
// the global serial throttle. Symbol tables change slowly, so the TTL is a
// day; settings saves still clear the cache (setCustomSources), so
// edited/re-imported sources refetch immediately, and the import path warms
// the cache right after importing.
const WHOLE_TABLE_SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
// Cap on locally filtered remote results pushed into the suggest modal.
const REMOTE_SEARCH_LIMIT = 200;

interface DataAdapterOptions {
  cache: SqliteCache;
  customSources: CustomSourceDef[];
  // Vault file reader for format "csv" custom sources (main.ts wires
  // app.vault.cachedRead with a TFile check).
  readVaultFile: (path: string) => Promise<string>;
}

export class DataAdapter {
  private customSources: CustomSourceDef[];
  private cache: SqliteCache;
  private readVaultFile: (path: string) => Promise<string>;
  private wholeTableSearchCache = new Map<string, { at: number; items: SymbolItem[] }>();

  constructor(options: DataAdapterOptions) {
    this.customSources = options.customSources;
    this.cache = options.cache;
    this.readVaultFile = options.readVaultFile;
  }

  setCustomSources(sources: CustomSourceDef[]) {
    this.customSources = sources;
    this.wholeTableSearchCache.clear();
  }

  // Resolves the enabled CustomSourceDef behind a sourceId, or throws the
  // guidance every custom-source path shares. The returned def carries the
  // group-fallback apiKey (runtime-only, never persisted).
  private resolveCustomSource(sourceId: string | undefined): CustomSourceDef {
    const def = this.customSources.find((s) => s.id === sourceId && s.enabled);
    if (!def) {
      throw new Error(t("自定义数据源「{id}」不存在或已停用，请在设置页检查。", { id: sourceId ?? "" }));
    }
    return { ...def, apiKey: resolveGroupApiKey(def, this.customSources) };
  }

  // Server-side quote search for a custom source, used by the unified search
  // modal and RemoteQuoteSearchModal. Whole-table sources (no {query} in the
  // search template) are served from the cache above and filtered locally
  // with the same matcher as static code tables; query-template sources hit
  // the endpoint directly.
  async searchRemoteQuotes(sourceId: string, text: string): Promise<SymbolItem[]> {
    const def = this.resolveCustomSource(sourceId);
    const client = new CustomQuoteClient(def);
    if (!isWholeTableSearchSource(def)) return client.searchQuotes(text);
    const cached = this.wholeTableSearchCache.get(sourceId);
    const items =
      cached && Date.now() - cached.at < WHOLE_TABLE_SEARCH_TTL_MS
        ? cached.items
        : await client.searchQuotes(text).then((fresh) => {
            this.wholeTableSearchCache.set(sourceId, { at: Date.now(), items: fresh });
            return fresh;
          });
    const q = text.trim();
    return (q ? items.filter((item) => matchSymbolEntry({ code: item.tsCode, name: item.name }, q)) : items)
      .slice(0, REMOTE_SEARCH_LIMIT);
  }

  // Every source is cached as daily rows and resampled to W/M at read time.
  // Caching resampled rows broke incremental refresh: the trailing partial
  // week/month re-fetched from "last cached date + 1" would overwrite the
  // complete period row with an incomplete one.
  private toKey(spec: ParsedCardSpec) {
    return {
      symbol: spec.symbol,
      assetType: cacheAssetKey(spec.assetType, spec.sourceId),
      freq: "D" as const,
    };
  }

  private maybeResample(spec: ParsedCardSpec, rows: OhlcvRow[]): OhlcvRow[] {
    if (spec.freq !== "D") {
      return this.resample(rows, spec.freq);
    }
    return rows;
  }

  async loadCachedOhlcv(spec: ParsedCardSpec): Promise<OhlcvRow[]> {
    const { start, end } = resolveDateRange(spec.range);
    const rows = await this.cache.loadOhlcvRange(this.toKey(spec), start, end);
    return this.maybeResample(spec, rows);
  }

  async loadOhlcv(spec: ParsedCardSpec): Promise<OhlcvRow[]> {
    const { start, end } = resolveDateRange(spec.range);
    const key = this.toKey(spec);

    const extent = await this.cache.getOhlcvExtent(key);

    try {
      const fetchedRows: OhlcvRow[] = [];

      if (!extent) {
        fetchedRows.push(...(await this.fetchOhlcv(spec, start, end)));
      } else {
        // Fetch earlier missing data
        if (start < extent.minDate) {
          const earlierEnd = prevTradingDate(extent.minDate);
          if (earlierEnd >= start) {
            fetchedRows.push(...(await this.fetchOhlcv(spec, start, earlierEnd)));
          }
        }

        // Fetch later missing data
        if (end > extent.maxDate) {
          const laterStart = nextTradingDate(extent.maxDate);
          if (laterStart <= end) {
            fetchedRows.push(...(await this.fetchOhlcv(spec, laterStart, end)));
          }
        }
      }

      if (fetchedRows.length > 0) {
        await this.cache.mergeOhlcvRows(key, fetchedRows);
      }

      return this.maybeResample(spec, await this.cache.loadOhlcvRange(key, start, end));
    } catch (e) {
      const cachedRows = await this.cache.loadOhlcvRange(key, start, end);
      if (cachedRows.length > 0) {
        new Notice(`StrataBoard: failed to refresh data, showing cached data. ${e instanceof Error ? e.message : ""}`);
        return this.maybeResample(spec, cachedRows);
      }
      throw e;
    }
  }

  private async fetchOhlcv(spec: ParsedCardSpec, start: string, end: string): Promise<OhlcvRow[]> {
    // Custom sources return ready-mapped rows; format "csv" reads a
    // vault-local file instead of an HTTP endpoint.
    const def = this.resolveCustomSource(spec.sourceId);
    if (def.format === "csv") {
      return new CsvQuoteClient(def, this.readVaultFile).fetchKline(spec.symbol, start, end);
    }
    // The classification the search endpoint declared for this code,
    // persisted in the symbol cache when the user picked it — it outranks
    // codeRules when resolving {p.*} params. Absent for hand-entered codes,
    // which fall back to codeRules / source defaults.
    const declaredProfile = await this.cache
      .lookupSymbol(spec.symbol, cacheAssetKey("custom", def.id))
      .then((item) => item?.profile)
      .catch(() => undefined);
    return new CustomQuoteClient(def).fetchKline(spec.symbol, start, end, undefined, declaredProfile);
  }

  private resample(rows: OhlcvRow[], freq: "W" | "M"): OhlcvRow[] {
    if (rows.length === 0) return [];

    const sorted = [...rows].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    const groups = new Map<string, OhlcvRow[]>();

    for (const row of sorted) {
      const key = this.getPeriodKey(row.tradeDate, freq);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    const result: OhlcvRow[] = [];
    for (const group of groups.values()) {
      result.push({
        // Period-end trading date (the weekly/monthly trade_date convention),
        // so daily-based MAs can be fitted onto resampled W/M bars.
        tradeDate: group[group.length - 1].tradeDate,
        open: group[0].open,
        high: Math.max(...group.map((r) => r.high)),
        low: Math.min(...group.map((r) => r.low)),
        close: group[group.length - 1].close,
        vol: group.reduce((sum, r) => sum + r.vol, 0),
        amount: group.reduce((sum, r) => sum + r.amount, 0),
      });
    }

    return result.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  }

  private getPeriodKey(ymd: string, freq: "W" | "M"): string {
    const date = parseDateYmd(ymd);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");

    if (freq === "M") {
      return `${y}${m}01`;
    }

    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(date.setDate(diff));
    return formatDate(monday);
  }
}
