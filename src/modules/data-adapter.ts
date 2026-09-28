import { Notice } from "obsidian";
import type { AssetType, CustomSourceDef, Freq, MacroSeriesDef, MarketData, OhlcvRow, ParsedCardSpec, SeriesPoint } from "../types";
import { MACRO_SERIES_OPTIONS, cacheAssetKey, findMacroSeriesDef } from "../types";
import { resolveDateRange, formatDate, parseDateYmd, nextTradingDate, prevTradingDate } from "../utils/date";
import { SqliteCache } from "./sqlite-cache";
import { TushareApiClient, TushareApiError } from "./tushare-api-client";
import { tushareQuoteApiName } from "./tushare-quote-api";
import { CustomQuoteClient } from "./custom-quote-client";
import { CsvQuoteClient } from "./csv-quote-client";
import { t } from "../i18n";

interface DataAdapterOptions {
  cache: SqliteCache;
  token: string;
  customSources: CustomSourceDef[];
  // Vault file reader for format "csv" custom sources (main.ts wires
  // app.vault.cachedRead with a TFile check).
  readVaultFile: (path: string) => Promise<string>;
}

export class DataAdapter {
  private client: TushareApiClient;
  private customSources: CustomSourceDef[];
  private cache: SqliteCache;
  private readVaultFile: (path: string) => Promise<string>;

  constructor(options: DataAdapterOptions) {
    this.client = new TushareApiClient(options.token);
    this.customSources = options.customSources;
    this.cache = options.cache;
    this.readVaultFile = options.readVaultFile;
  }

  setToken(token: string) {
    this.client.setToken(token);
  }

  setCustomSources(sources: CustomSourceDef[]) {
    this.customSources = sources;
  }

  // Resolves the enabled CustomSourceDef behind a sourceId, or throws the
  // guidance every custom-source path shares.
  private resolveCustomSource(sourceId: string | undefined): CustomSourceDef {
    const def = this.customSources.find((s) => s.id === sourceId && s.enabled);
    if (!def) {
      throw new Error(t("自定义数据源「{id}」不存在或已停用，请在设置页检查。", { id: sourceId ?? "" }));
    }
    return def;
  }

  // Server-side quote search for a custom source, used by
  // RemoteQuoteSearchModal. Local-index types never reach this.
  async searchRemoteQuotes(sourceId: string, text: string) {
    return new CustomQuoteClient(this.resolveCustomSource(sourceId)).searchQuotes(text);
  }

  // Asset types whose quote API only has daily bars (fund_daily, fund_nav,
  // fut_index_daily, hk_daily, index_global, cb_daily, fut_daily, fx_daily,
  // sw_daily — and user custom sources, which this plugin pulls daily-only):
  // always cached as daily rows and resampled to W/M at read time. Caching
  // resampled rows broke incremental refresh: the trailing partial week/month
  // re-fetched from "last cached date + 1" would overwrite the complete
  // period row with an incomplete one.
  private static isDailyOnly(assetType: AssetType): boolean {
    return (
      assetType === "fund" ||
      assetType === "ofund" ||
      assetType === "nhindex" ||
      assetType === "hk" ||
      assetType === "gbindex" ||
      assetType === "cb" ||
      assetType === "fut" ||
      assetType === "fx" ||
      assetType === "sw" ||
      assetType === "custom"
    );
  }

  private toKey(spec: ParsedCardSpec) {
    return {
      symbol: spec.symbol,
      assetType: cacheAssetKey(spec.assetType, spec.sourceId),
      freq: DataAdapter.isDailyOnly(spec.assetType) ? ("D" as Freq) : spec.freq,
    };
  }

  private maybeResample(spec: ParsedCardSpec, rows: OhlcvRow[]): OhlcvRow[] {
    if (DataAdapter.isDailyOnly(spec.assetType) && spec.freq !== "D") {
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
    // Custom sources return ready-mapped rows and bypass Tushare entirely;
    // format "csv" reads a vault-local file instead of an HTTP endpoint.
    if (spec.assetType === "custom") {
      const def = this.resolveCustomSource(spec.sourceId);
      if (def.format === "csv") {
        return new CsvQuoteClient(def, this.readVaultFile).fetchKline(spec.symbol, start, end);
      }
      return new CustomQuoteClient(def).fetchKline(spec.symbol, start, end);
    }

    const { apiName, params } = this.buildTushareRequest(spec, start, end);
    const response = await this.client.query(apiName, params);

    if (!response.data || !response.data.items || response.data.items.length === 0) {
      return [];
    }

    const fields = response.data.fields;
    const items = response.data.items;

    const getIndex = (name: string) => fields.findIndex((f) => f.toLowerCase() === name.toLowerCase());

    // fund_nav (场外基金净值) has no OHLCV: the adjusted nav (adj_nav,
    // falling back to unit_nav) becomes a synthetic o=h=l=c bar keyed by
    // nav_date, with zero vol/amount.
    if (spec.assetType === "ofund") {
      const navDateIdx = getIndex("nav_date");
      const adjNavIdx = getIndex("adj_nav");
      const unitNavIdx = getIndex("unit_nav");
      if (navDateIdx < 0 || (adjNavIdx < 0 && unitNavIdx < 0)) {
        throw new TushareApiError("Unexpected Tushare response format: missing nav_date/adj_nav/unit_nav fields.");
      }
      const rows: OhlcvRow[] = [];
      for (const item of items as any[]) {
        const nav = adjNavIdx >= 0 && item[adjNavIdx] != null ? Number(item[adjNavIdx]) : Number(item[unitNavIdx]);
        if (!Number.isFinite(nav)) continue;
        rows.push({
          tradeDate: String(item[navDateIdx]),
          open: nav,
          high: nav,
          low: nav,
          close: nav,
          vol: 0,
          amount: 0,
        });
      }
      return rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    }

    // fx_daily has no plain OHLC columns — only bid/ask OHLC; the bid side is
    // the quote convention for FX charts. tick_qty (tick count) stands in for
    // volume; there is no turnover amount.
    const names =
      spec.assetType === "fx"
        ? { open: "bid_open", high: "bid_high", low: "bid_low", close: "bid_close", vol: "tick_qty", amount: "" }
        : { open: "open", high: "high", low: "low", close: "close", vol: "vol", amount: "amount" };

    const tradeDateIdx = getIndex("trade_date");
    const openIdx = getIndex(names.open);
    const highIdx = getIndex(names.high);
    const lowIdx = getIndex(names.low);
    const closeIdx = getIndex(names.close);
    const volIdx = names.vol ? getIndex(names.vol) : -1;
    const amountIdx = names.amount ? getIndex(names.amount) : -1;

    if (tradeDateIdx < 0 || openIdx < 0 || highIdx < 0 || lowIdx < 0 || closeIdx < 0) {
      throw new TushareApiError("Unexpected Tushare response format: missing required fields.");
    }

    const rows: OhlcvRow[] = items.map((item: any) => ({
      tradeDate: String(item[tradeDateIdx]),
      open: Number(item[openIdx]),
      high: Number(item[highIdx]),
      low: Number(item[lowIdx]),
      close: Number(item[closeIdx]),
      vol: volIdx >= 0 ? Number(item[volIdx]) : 0,
      amount: amountIdx >= 0 ? Number(item[amountIdx]) : 0,
    }));

    // No resampling here: funds are cached as daily rows; W/M resampling
    // happens at read time (see maybeResample).
    return rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  }

  private buildTushareRequest(spec: ParsedCardSpec, start: string, end: string): { apiName: string; params: Record<string, unknown> } {
    return {
      // api_name mapping lives in tushare-quote-api.ts (shared with the CLI).
      apiName: tushareQuoteApiName(spec.assetType, spec.freq),
      params: {
        ts_code: spec.symbol,
        start_date: start,
        end_date: end,
      },
    };
  }

  private resample(rows: OhlcvRow[], freq: Freq): OhlcvRow[] {
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
        // Period-end trading date (matches the Tushare weekly/monthly
        // trade_date convention), so W/M bars from both sources share the
        // same date semantics and daily-based MAs can be fitted onto them.
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

  private getPeriodKey(ymd: string, freq: Freq): string {
    const date = parseDateYmd(ymd);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");

    if (freq === "M") {
      return `${y}${m}01`;
    }

    if (freq === "W") {
      const day = date.getDay();
      const diff = date.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(date.setDate(diff));
      return formatDate(monday);
    }

    return ymd;
  }

  async loadMarketData(spec: ParsedCardSpec, tradeDate: string): Promise<MarketData | null> {
    const cached = await this.cache.loadMarketData(spec, tradeDate);
    if (cached) {
      return cached;
    }

    try {
      const data = await this.fetchMarketData(spec, tradeDate);
      if (data) {
        await this.cache.saveMarketData(spec, data);
      }
      return data;
    } catch (e) {
      console.warn("Failed to load market data:", e);
      return null;
    }
  }

  private async fetchMarketData(spec: ParsedCardSpec, tradeDate: string): Promise<MarketData | null> {
    const response = await this.client.query("daily_basic", {
      ts_code: spec.symbol,
      trade_date: tradeDate,
    });

    if (!response.data || !response.data.items || response.data.items.length === 0) {
      return null;
    }

    const fields = response.data.fields;
    const item = response.data.items[0] as unknown[];
    const get = (name: string) => {
      const idx = fields.findIndex((f) => f.toLowerCase() === name.toLowerCase());
      return idx >= 0 ? Number(item[idx]) : undefined;
    };

    return {
      tradeDate,
      totalMv: get("total_mv"),
      circMv: get("circ_mv"),
      pe: get("pe"),
      peTtm: get("pe_ttm"),
      volumeRatio: get("volume_ratio"),
      turnoverRate: get("turnover_rate"),
      turnoverRateF: get("turnover_rate_f"),
    };
  }

  // ==================== Macro (Tushare 国内宏观) ====================

  // Ensures the series' API table is fresh in the cache, then reads the
  // series back out. Whole-table APIs are fetched in one call covering every
  // cataloged field, so first use of one series warms the whole group;
  // windowed APIs (yc_cb/shibor/moneyflow_hsgt/index_dailybasic) fill their
  // groups incrementally (see fetchMacroWindowed).
  async loadMacroSeries(seriesId: string, startDate: string, endDate: string): Promise<SeriesPoint[]> {
    const def = findMacroSeriesDef(seriesId);
    if (!def) {
      throw new TushareApiError(t("未知的宏观序列：{id}", { id: seriesId }));
    }
    const maxDate = await this.cache.getMacroSeriesMaxDate(def.api, seriesId);
    if (!maxDate || maxDate < DataAdapter.expectedLatestDate(def.freq)) {
      try {
        await this.fetchMacroApi(def.api);
      } catch (e) {
        console.error(`Failed to refresh macro data (${def.api}):`, e);
        new Notice(t("StrataBoard: 宏观数据刷新失败，显示缓存数据。"));
      }
    }
    return this.cache.loadMacroSeries(def.api, seriesId, startDate, endDate);
  }

  // The latest observation date a fresh cache should hold, as YYYY-MM-DD:
  // daily series (yc_cb yields) publish every trading day, monthly series
  // publish the previous calendar month with a lag, quarterly series (GDP)
  // the previous quarter; the latter two are stored at period start.
  private static expectedLatestDate(freq: "D" | "M" | "Q"): string {
    const today = new Date();
    if (freq === "D") {
      return formatDate(today);
    }
    const y = today.getFullYear();
    const m = today.getMonth(); // 0-based
    if (freq === "Q") {
      const curQuarterStart = Math.floor(m / 3) * 3; // 0-based month of this quarter's start
      const prev = new Date(y, curQuarterStart - 3, 1);
      return formatDate(prev);
    }
    return formatDate(new Date(y, m - 1, 1));
  }

  // Fetches one API's data and merges it into the series cache (keyed by
  // api + series id). Most APIs are pulled as one full table covering every
  // cataloged field; APIs whose rows are keyed by date × params (yc_cb,
  // index_dailybasic) or exceed the per-call row cap over their full history
  // (shibor, moneyflow_hsgt) are fetched in windows instead (see
  // fetchMacroWindowed).
  private async fetchMacroApi(api: string): Promise<void> {
    const defs = MACRO_SERIES_OPTIONS.filter((o) => o.api === api);
    if (defs.length === 0) {
      throw new TushareApiError(t("未知的宏观接口：{api}", { api }));
    }
    // dateField: the response column holding the observation date;
    // historyStart: the API's earliest data (YYYYMMDD); windowYears keeps one
    // call under the API's per-call row cap (moneyflow_hsgt: 300 rows,
    // index_dailybasic: 3000, yc_cb: 2000).
    const windowed: Record<string, { dateField: string; historyStart: string; windowYears: number }> = {
      yc_cb: { dateField: "trade_date", historyStart: "20020101", windowYears: 5 },
      shibor: { dateField: "date", historyStart: "20061008", windowYears: 5 },
      moneyflow_hsgt: { dateField: "trade_date", historyStart: "20141117", windowYears: 1 },
      index_dailybasic: { dateField: "trade_date", historyStart: "20040101", windowYears: 5 },
    };
    if (windowed[api]) {
      await this.fetchMacroWindowed(api, defs, windowed[api]);
      return;
    }
    const params: Record<string, unknown> = {};
    if (api === "cn_gdp") {
      params.start_q = "1992Q1";
    } else if (api === "shibor_lpr") {
      params.start_date = "20100101";
    } else if (api === "cn_m" || api === "sf_month") {
      params.start_month = "199001";
    } else {
      params.start_m = "199001";
    }

    const response = await this.client.query(api, params);
    if (!response.data || !response.data.items || response.data.items.length === 0) {
      return;
    }

    const fields = response.data.fields;
    const items = response.data.items;
    const getIndex = (name: string) => fields.findIndex((f) => f.toLowerCase() === name.toLowerCase());
    const dateIdx = getIndex(api === "cn_gdp" ? "quarter" : api === "shibor_lpr" ? "date" : "month");
    if (dateIdx < 0) {
      throw new TushareApiError("Unexpected Tushare response format: missing date field.");
    }

    for (const def of defs) {
      const valueIdx = getIndex(def.field);
      if (valueIdx < 0) continue;

      const points: SeriesPoint[] = [];
      for (const item of items as any[]) {
        const date = normalizeMacroDate(String(item[dateIdx]));
        if (!date) continue;
        const value = Number(item[valueIdx]);
        if (!Number.isFinite(value)) continue;
        points.push({ date, value });
      }
      await this.cache.mergeMacroSeriesRows(api, def.id, points);
    }
  }

  // Windowed incremental fetch for daily macro APIs. Defs are grouped by
  // def.params (defs sharing the same params share one request — their fields
  // are columns of the same response; defs without params form a single
  // whole-table group). Each group is pulled from the cached max date of its
  // least-cached series (or the API's history start) up to today in
  // windowYears-sized windows, and every response is split per def field into
  // each series' cache. yc_cb uses this per curve tenor, index_dailybasic per
  // ts_code; one row per trading day keeps every window under the per-call
  // row cap.
  private async fetchMacroWindowed(
    api: string,
    defs: MacroSeriesDef[],
    opts: { dateField: string; historyStart: string; windowYears: number }
  ): Promise<void> {
    const today = new Date();
    const end = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

    const groups = new Map<string, MacroSeriesDef[]>();
    for (const def of defs) {
      const key = JSON.stringify(def.params ?? {});
      const group = groups.get(key) ?? [];
      group.push(def);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      // Refetch from the least-cached series of the group so a series that
      // has never been fetched still pulls full history.
      let cursor: string | null = null;
      for (const def of group) {
        const cachedMax = await this.cache.getMacroSeriesMaxDate(api, def.id);
        const start = cachedMax ? cachedMax.replace(/-/g, "") : opts.historyStart;
        if (cursor === null || start < cursor) cursor = start;
      }

      const pointsByDef = new Map<string, SeriesPoint[]>();
      while (cursor! <= end) {
        const cursorDate = parseDateYmd(cursor!);
        const windowEnd = new Date(cursorDate.getFullYear() + opts.windowYears, cursorDate.getMonth(), cursorDate.getDate());
        const windowEndYmd = formatDate(windowEnd).replace(/-/g, "");
        const chunkEnd = windowEndYmd > end ? end : windowEndYmd;
        const response = await this.client.query(api, {
          ...(group[0].params ?? {}),
          start_date: cursor,
          end_date: chunkEnd,
        });
        if (response.data && response.data.items && response.data.items.length > 0) {
          const fields = response.data.fields;
          const dateIdx = fields.findIndex((f) => f.toLowerCase() === opts.dateField.toLowerCase());
          if (dateIdx < 0) {
            throw new TushareApiError(`Unexpected Tushare response format: missing ${opts.dateField} field.`);
          }
          for (const def of group) {
            const valueIdx = fields.findIndex((f) => f.toLowerCase() === def.field.toLowerCase());
            if (valueIdx < 0) continue;
            const points = pointsByDef.get(def.id) ?? [];
            for (const item of response.data.items as any[]) {
              const date = normalizeMacroDate(String(item[dateIdx]));
              if (!date) continue;
              const value = Number(item[valueIdx]);
              if (!Number.isFinite(value)) continue;
              points.push({ date, value });
            }
            pointsByDef.set(def.id, points);
          }
        }
        // Next window starts the day after this chunk's end.
        const next = parseDateYmd(chunkEnd);
        next.setDate(next.getDate() + 1);
        cursor = formatDate(next).replace(/-/g, "");
      }
      for (const def of group) {
        await this.cache.mergeMacroSeriesRows(api, def.id, pointsByDef.get(def.id) ?? []);
      }
    }
  }
}

// Normalizes a Tushare period key to YYYY-MM-DD: YYYY-MM-DD passes through
// (shibor's date column is ISO), YYYYMM and YYYYMMDD pass through (monthly
// data at month start), quarters ("2023Q4") map to the quarter's first
// month. Returns "" for unrecognized shapes.
function normalizeMacroDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  const quarter = raw.match(/^(\d{4})Q([1-4])$/);
  if (quarter) {
    const month = String((Number(quarter[2]) - 1) * 3 + 1).padStart(2, "0");
    return `${quarter[1]}-${month}-01`;
  }
  if (/^\d{6}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-01`;
  }
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return "";
}
