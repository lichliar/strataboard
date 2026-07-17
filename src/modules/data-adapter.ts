import { Notice } from "obsidian";
import type { AssetType, Freq, MarketData, OhlcvRow, ParsedCardSpec } from "../types";
import { resolveDateRange, formatDate, parseDateYmd, nextTradingDate, prevTradingDate } from "../utils/date";
import { SqliteCache } from "./sqlite-cache";
import { TushareApiClient, TushareApiError } from "./tushare-api-client";

interface DataAdapterOptions {
  cache: SqliteCache;
  token: string;
}

export class DataAdapter {
  private client: TushareApiClient;
  private cache: SqliteCache;

  constructor(options: DataAdapterOptions) {
    this.client = new TushareApiClient(options.token);
    this.cache = options.cache;
  }

  setToken(token: string) {
    this.client.setToken(token);
  }

  private toKey(spec: ParsedCardSpec) {
    return {
      symbol: spec.symbol,
      assetType: spec.assetType,
      // Funds are always cached as daily rows and resampled to W/M at read
      // time. Caching resampled rows broke incremental refresh: the trailing
      // partial week/month re-fetched from "last cached date + 1" would
      // overwrite the complete period row with an incomplete one.
      freq: spec.assetType === "fund" ? ("D" as Freq) : spec.freq,
    };
  }

  private maybeResample(spec: ParsedCardSpec, rows: OhlcvRow[]): OhlcvRow[] {
    if (spec.assetType === "fund" && spec.freq !== "D") {
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
        new Notice(`Financial Canvas: failed to refresh data, showing cached data. ${e instanceof Error ? e.message : ""}`);
        return this.maybeResample(spec, cachedRows);
      }
      throw e;
    }
  }

  private async fetchOhlcv(spec: ParsedCardSpec, start: string, end: string): Promise<OhlcvRow[]> {
    const { apiName, params } = this.buildTushareRequest(spec, start, end);
    const response = await this.client.query(apiName, params);

    if (!response.data || !response.data.items || response.data.items.length === 0) {
      return [];
    }

    const fields = response.data.fields;
    const items = response.data.items as unknown[];

    const getIndex = (name: string) => fields.findIndex((f) => f.toLowerCase() === name.toLowerCase());
    const tradeDateIdx = getIndex("trade_date");
    const openIdx = getIndex("open");
    const highIdx = getIndex("high");
    const lowIdx = getIndex("low");
    const closeIdx = getIndex("close");
    const volIdx = getIndex("vol");
    const amountIdx = getIndex("amount");

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
}
