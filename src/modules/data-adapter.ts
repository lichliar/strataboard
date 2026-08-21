import { Notice } from "obsidian";
import type { AssetType, Freq, MacroSeriesDef, MarketData, OhlcvRow, ParsedCardSpec, SeriesPoint } from "../types";
import { MACRO_SERIES_OPTIONS, findMacroSeriesDef } from "../types";
import { resolveDateRange, formatDate, parseDateYmd, nextTradingDate, prevTradingDate } from "../utils/date";
import { SqliteCache } from "./sqlite-cache";
import { TushareApiClient, TushareApiError } from "./tushare-api-client";
import { TencentApiClient } from "./tencent-api-client";
import { EastmoneyApiClient } from "./eastmoney-api-client";

interface DataAdapterOptions {
  cache: SqliteCache;
  token: string;
}

export class DataAdapter {
  private client: TushareApiClient;
  private txClient = new TencentApiClient();
  private emClient = new EastmoneyApiClient();
  private cache: SqliteCache;

  constructor(options: DataAdapterOptions) {
    this.client = new TushareApiClient(options.token);
    this.cache = options.cache;
  }

  setToken(token: string) {
    this.client.setToken(token);
  }

  // Server-side quote search for the token-free sources (tx/em), used by
  // RemoteQuoteSearchModal. Local-index types never reach this.
  async searchRemoteQuotes(assetType: "tx" | "em", text: string) {
    return assetType === "tx" ? this.txClient.searchQuotes(text) : this.emClient.searchQuotes(text);
  }

  // Asset types whose quote API only has daily bars (fund_daily,
  // fut_index_daily, hk_daily, index_global, cb_daily, fut_daily, fx_daily,
  // sw_daily — and the token-free tx/em endpoints, which this plugin pulls
  // daily-only): always cached as daily rows and resampled to W/M at read
  // time. Caching resampled rows broke incremental refresh: the trailing
  // partial week/month re-fetched from "last cached date + 1" would overwrite
  // the complete period row with an incomplete one.
  private static isDailyOnly(assetType: AssetType): boolean {
    return (
      assetType === "fund" ||
      assetType === "nhindex" ||
      assetType === "hk" ||
      assetType === "gbindex" ||
      assetType === "cb" ||
      assetType === "fut" ||
      assetType === "fx" ||
      assetType === "sw" ||
      assetType === "tx" ||
      assetType === "em"
    );
  }

  private toKey(spec: ParsedCardSpec) {
    return {
      symbol: spec.symbol,
      assetType: spec.assetType,
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
    // Token-free sources return ready-mapped rows and bypass Tushare entirely.
    if (spec.assetType === "tx") {
      return this.txClient.fetchKline(spec.symbol, start, end);
    }
    if (spec.assetType === "em") {
      return this.emClient.fetchKline(spec.symbol, start, end);
    }

    const { apiName, params } = this.buildTushareRequest(spec, start, end);
    const response = await this.client.query(apiName, params);

    if (!response.data || !response.data.items || response.data.items.length === 0) {
      return [];
    }

    const fields = response.data.fields;
    const items = response.data.items;

    // fx_daily has no plain OHLC columns — only bid/ask OHLC; the bid side is
    // the quote convention for FX charts. tick_qty (tick count) stands in for
    // volume; there is no turnover amount.
    const names =
      spec.assetType === "fx"
        ? { open: "bid_open", high: "bid_high", low: "bid_low", close: "bid_close", vol: "tick_qty", amount: "" }
        : { open: "open", high: "high", low: "low", close: "close", vol: "vol", amount: "amount" };

    const getIndex = (name: string) => fields.findIndex((f) => f.toLowerCase() === name.toLowerCase());
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
    const params: Record<string, unknown> = {
      ts_code: spec.symbol,
      start_date: start,
      end_date: end,
    };

    let apiName = "";

    switch (spec.assetType) {
      case "stock":
        apiName = spec.freq === "W" ? "weekly" : spec.freq === "M" ? "monthly" : "daily";
        break;
      case "fund":
        apiName = "fund_daily";
        break;
      case "index":
        apiName = spec.freq === "W" ? "index_weekly" : spec.freq === "M" ? "index_monthly" : "index_daily";
        break;
      case "nhindex":
        // 南华期货指数只有日线；W/M 由读取端重采样。
        apiName = "fut_index_daily";
        break;
      case "hk":
        // 港股只有日线（hk_daily）；W/M 由读取端重采样。
        apiName = "hk_daily";
        break;
      case "gbindex":
        // 国际指数只有日线（index_global）；W/M 由读取端重采样。
        apiName = "index_global";
        break;
      case "cb":
        // 可转债只有日线（cb_daily）；W/M 由读取端重采样。
        apiName = "cb_daily";
        break;
      case "fut":
        // 期货合约只有日线（fut_daily）；W/M 由读取端重采样。
        apiName = "fut_daily";
        break;
      case "fx":
        // 外汇只有日线（fx_daily，bid 侧 OHLC）；W/M 由读取端重采样。
        apiName = "fx_daily";
        break;
      case "sw":
        // 申万行业指数只有日线（sw_daily）；W/M 由读取端重采样。
        apiName = "sw_daily";
        break;
    }

    return { apiName, params };
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
    for (const [period, group] of groups) {
      result.push({
        tradeDate: period,
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
  // series back out. Each API's full table is fetched in one call and every
  // cataloged field of it is cached, so first use of one series warms the
  // whole group.
  async loadMacroSeries(seriesId: string, startDate: string, endDate: string): Promise<SeriesPoint[]> {
    const def = findMacroSeriesDef(seriesId);
    if (!def) {
      throw new TushareApiError(`未知的宏观序列：${seriesId}`);
    }
    const maxDate = await this.cache.getMacroSeriesMaxDate(def.api, seriesId);
    if (!maxDate || maxDate < DataAdapter.expectedLatestDate(def.freq)) {
      try {
        await this.fetchMacroApi(def.api);
      } catch (e) {
        console.error(`Failed to refresh macro data (${def.api}):`, e);
        new Notice("StrataBoard: 宏观数据刷新失败，显示缓存数据。");
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
  // cataloged field; yc_cb rows are keyed by date × curve tenor, so it is
  // fetched per cataloged tenor instead (see fetchYcCbSeries).
  private async fetchMacroApi(api: string): Promise<void> {
    const defs = MACRO_SERIES_OPTIONS.filter((o) => o.api === api);
    if (defs.length === 0) {
      throw new TushareApiError(`未知的宏观接口：${api}`);
    }
    if (api === "yc_cb") {
      await this.fetchYcCbSeries(defs);
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

  // yc_cb (中债收益率曲线) is fetched per cataloged tenor, incrementally:
  // from the cached max date (or 20020101, the curve's history start) up to
  // today, in 5-year windows — one row per trading day per tenor keeps every
  // window far below the 2000-row per-call cap. def.params carries
  // ts_code / curve_type / curve_term.
  private async fetchYcCbSeries(defs: MacroSeriesDef[]): Promise<void> {
    const today = new Date();
    const end = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    for (const def of defs) {
      const cachedMax = await this.cache.getMacroSeriesMaxDate(def.api, def.id);
      let cursor = cachedMax ? cachedMax.replace(/-/g, "") : "20020101";
      const points: SeriesPoint[] = [];
      while (cursor <= end) {
        const cursorDate = parseDateYmd(cursor);
        const windowEnd = new Date(cursorDate.getFullYear() + 5, cursorDate.getMonth(), cursorDate.getDate());
        const windowEndYmd = formatDate(windowEnd).replace(/-/g, "");
        const chunkEnd = windowEndYmd > end ? end : windowEndYmd;
        const response = await this.client.query("yc_cb", {
          ...def.params,
          start_date: cursor,
          end_date: chunkEnd,
        });
        if (response.data && response.data.items && response.data.items.length > 0) {
          const fields = response.data.fields;
          const dateIdx = fields.findIndex((f) => f.toLowerCase() === "trade_date");
          const valueIdx = fields.findIndex((f) => f.toLowerCase() === def.field.toLowerCase());
          if (dateIdx < 0 || valueIdx < 0) {
            throw new TushareApiError("Unexpected Tushare response format: missing trade_date/yield field.");
          }
          for (const item of response.data.items as any[]) {
            const date = normalizeMacroDate(String(item[dateIdx]));
            if (!date) continue;
            const value = Number(item[valueIdx]);
            if (!Number.isFinite(value)) continue;
            points.push({ date, value });
          }
        }
        // Next window starts the day after this chunk's end.
        const next = parseDateYmd(chunkEnd);
        next.setDate(next.getDate() + 1);
        cursor = formatDate(next).replace(/-/g, "");
      }
      await this.cache.mergeMacroSeriesRows(def.api, def.id, points);
    }
  }
}

// Normalizes a Tushare period key to YYYY-MM-DD: YYYYMM and YYYYMMDD pass
// through (monthly data at month start), quarters ("2023Q4") map to the
// quarter's first month. Returns "" for unrecognized shapes.
function normalizeMacroDate(raw: string): string {
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
