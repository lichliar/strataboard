import { Notice } from "obsidian";
import type { CustomSourceDef, OhlcvRow, ParsedCardSpec, ResolvedCustomSourceDef, SymbolItem } from "../types";
import { cacheAssetKey, isWholeTableSearchSource } from "../types";
import type { ApiKeyResolver } from "./credentials";
import { resolveDateRange, formatDate, parseDateYmd, nextTradingDate, prevTradingDate } from "../utils/date";
import { matchSymbolEntry } from "../utils/symbol-list";
import { SqliteCache } from "./sqlite-cache";
import { CustomQuoteClient } from "./custom-quote-client";
import { CsvQuoteClient } from "./csv-quote-client";
import { canAttempt, isRateLimitError, recordFailure, recordSuccess, sleep, TRIP_COOLDOWN_MS } from "./fetch-guard";
import { redactError } from "./redact";
import { reportSourceHealth } from "./source-health";
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
  // Credential seam (modules/credentials.ts): resolves the runtime secret
  // for a source — SecretStorage in the plugin, env vars in CLI/MCP.
  resolveApiKey: ApiKeyResolver;
}

// Result of a loadOhlcv call: the rows plus where they came from.
// fromCache=true means the source was NOT successfully queried this time
// (circuit-breaker pause or a failed fetch falling back to cache) and the
// card should show the shared cache badge; lastDataAt is the latest cached
// bar date (YYYY-MM-DD) for that badge. A deliberate cache read with
// auto-refresh off (loadCachedOhlcv) is NOT a fallback and stays false.
export interface OhlcvLoadResult {
  rows: OhlcvRow[];
  fromCache: boolean;
  lastDataAt?: string;
}

export class DataAdapter {
  private customSources: CustomSourceDef[];
  private cache: SqliteCache;
  private readVaultFile: (path: string) => Promise<string>;
  private resolveApiKey: ApiKeyResolver;
  private wholeTableSearchCache = new Map<string, { at: number; items: SymbolItem[] }>();

  constructor(options: DataAdapterOptions) {
    this.customSources = options.customSources;
    this.cache = options.cache;
    this.readVaultFile = options.readVaultFile;
    this.resolveApiKey = options.resolveApiKey;
  }

  setCustomSources(sources: CustomSourceDef[]) {
    this.customSources = sources;
    this.wholeTableSearchCache.clear();
  }

  // Resolves the enabled CustomSourceDef behind a sourceId, or throws the
  // guidance every custom-source path shares. The returned def carries the
  // resolved runtime secret (never persisted, never logged).
  private resolveCustomSource(sourceId: string | undefined): ResolvedCustomSourceDef {
    const def = this.customSources.find((s) => s.id === sourceId && s.enabled);
    if (!def) {
      throw new Error(t("自定义数据源「{id}」不存在或已停用，请在设置页检查。", { id: sourceId ?? "" }));
    }
    const { key, missing } = this.resolveApiKey(def);
    if (missing) {
      throw new Error(t("数据源「{name}」尚未配置凭据，请在设置页重新选择或创建凭据。", { name: def.name }));
    }
    return { ...def, apiKey: key };
  }

  // Server-side quote search for a custom source, used by the unified search
  // modal. Whole-table sources (no {query} in the search template) are served
  // from the cache above and filtered locally with the same matcher as static
  // code tables; query-template sources hit the endpoint directly.
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

  // Every source is cached as its raw (usually daily) rows and resampled to
  // W/M/Q/Y at read time. Caching resampled rows broke incremental refresh: the trailing partial
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

  // Whether the cache holds ANY rows for this card's key — drives the
  // source-empty vs range-empty distinction of the shared empty state (cache
  // non-empty but nothing in range → the range is the problem, not the source).
  async hasCachedData(spec: ParsedCardSpec): Promise<boolean> {
    return (await this.cache.getOhlcvExtent(this.toKey(spec))) != null;
  }

  async loadOhlcv(spec: ParsedCardSpec): Promise<OhlcvLoadResult> {
    const { start, end } = resolveDateRange(spec.range);
    const key = this.toKey(spec);

    // Per-source circuit breaker (fetch-guard): a source that keeps failing
    // (rate-limited, down, bad key) is paused after a few consecutive
    // failures, and every card on it silently serves cache instead of each
    // firing its own request and Notice. format "csv" reads a vault-local
    // file — no rate limiting exists there, so it bypasses the guard.
    const breakerKey = this.guardKey(spec);
    if (breakerKey && !canAttempt(breakerKey)) {
      const cachedRows = await this.cache.loadOhlcvRange(key, start, end);
      if (cachedRows.length > 0) {
        return {
          rows: this.maybeResample(spec, cachedRows),
          fromCache: true,
          lastDataAt: (await this.cache.getLastDataDate(key)) ?? undefined,
        };
      }
      throw new Error(t("数据源请求连续失败，已暂停自动重试，请稍后再试。"));
    }

    const extent = await this.cache.getOhlcvExtent(key);

    try {
      const fetchedRows = breakerKey
        ? await this.fetchGuarding(spec, start, end, extent, breakerKey)
        : await this.fetchMissingRanges(spec, start, end, extent);

      if (fetchedRows.length > 0) {
        await this.cache.mergeOhlcvRows(key, fetchedRows);
      }

      return {
        rows: this.maybeResample(spec, await this.cache.loadOhlcvRange(key, start, end)),
        fromCache: false,
      };
    } catch (e) {
      const cachedRows = await this.cache.loadOhlcvRange(key, start, end);
      if (cachedRows.length > 0) {
        // Silent on purpose: the single trip Notice from fetchGuarding is the
        // only user-facing signal — per-card Notices here flooded the UI
        // whenever a source got rate-limited. The card shows the cache badge
        // instead (fromCache).
        return {
          rows: this.maybeResample(spec, cachedRows),
          fromCache: true,
          lastDataAt: (await this.cache.getLastDataDate(key)) ?? undefined,
        };
      }
      throw e;
    }
  }

  // Circuit key for remote custom sources; null for csv (local file) sources.
  private guardKey(spec: ParsedCardSpec): string | null {
    const def = this.customSources.find((s) => s.id === spec.sourceId && s.enabled);
    return def && def.format !== "csv" ? def.id : null;
  }

  // Incremental fetch wrapped in the rate-limit guard: rate-limit-style
  // failures retry up to 3 attempts with backoff (2s, 5s), and every failure
  // feeds the source's circuit breaker — the Notice fires only on the trip
  // transition, so a struggling source produces one toast, not one per card.
  private async fetchGuarding(
    spec: ParsedCardSpec,
    start: string,
    end: string,
    extent: { minDate: string; maxDate: string } | null,
    breakerKey: string,
  ): Promise<OhlcvRow[]> {
    const backoffs = [2000, 5000];
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = await this.fetchMissingRanges(spec, start, end, extent);
        recordSuccess(breakerKey);
        return rows;
      } catch (e) {
        if (recordFailure(breakerKey)) {
          // The breaker trips on ANY repeated failure (rate limit, WAF block,
          // dead domain alike) — name no cause here, carry the real one.
          new Notice(t("数据源「{name}」请求连续失败，已暂停 {min} 分钟，期间展示缓存数据。最近错误：{msg}", {
            name: this.sourceName(spec.sourceId),
            min: String(Math.round(TRIP_COOLDOWN_MS / 60000)),
            msg: redactError(e),
          }));
        }
        if (!isRateLimitError(e) || attempt >= backoffs.length || !canAttempt(breakerKey)) throw e;
        await sleep(backoffs[attempt]);
      }
    }
  }

  private sourceName(sourceId: string | undefined): string {
    return this.customSources.find((s) => s.id === sourceId)?.name ?? sourceId ?? "";
  }

  // Fetches only the ranges the cache does not cover yet (the whole window on
  // a cold cache, otherwise the missing head/tail around the cached extent).
  private async fetchMissingRanges(
    spec: ParsedCardSpec,
    start: string,
    end: string,
    extent: { minDate: string; maxDate: string } | null,
  ): Promise<OhlcvRow[]> {
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

    return fetchedRows;
  }

  private async fetchOhlcv(spec: ParsedCardSpec, start: string, end: string): Promise<OhlcvRow[]> {
    // Custom sources return ready-mapped rows; format "csv" reads a
    // vault-local file instead of an HTTP endpoint.
    const def = this.resolveCustomSource(spec.sourceId);
    if (def.format === "csv") {
      if (!def.filePath) {
        // Remote CSV/TSV: fetched over HTTP, health already recorded by
        // sendSourceRequest.
        return new CsvQuoteClient(def, this.readVaultFile).fetchKline(spec.symbol, start, end);
      }
      // Vault-local CSV: record the read/parse outcome for the settings-page
      // connection badge (no HTTP seam to catch it otherwise).
      try {
        const rows = await new CsvQuoteClient(def, this.readVaultFile).fetchKline(spec.symbol, start, end);
        reportSourceHealth(def.id, true);
        return rows;
      } catch (e) {
        reportSourceHealth(def.id, false, redactError(e));
        throw e;
      }
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

  private resample(rows: OhlcvRow[], freq: "W" | "M" | "Q" | "Y"): OhlcvRow[] {
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
        // so daily-based MAs can be fitted onto resampled W/M/Q/Y bars.
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

  private getPeriodKey(ymd: string, freq: "W" | "M" | "Q" | "Y"): string {
    const date = parseDateYmd(ymd);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");

    if (freq === "Y") {
      return `${y}0101`;
    }
    if (freq === "Q") {
      const q = Math.floor(date.getMonth() / 3) + 1;
      return `${y}Q${q}`;
    }
    if (freq === "M") {
      return `${y}${m}01`;
    }

    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(date.setDate(diff));
    return formatDate(monday);
  }
}
