import { App, Notice, TFile } from "obsidian";
import type { FredSeriesInfo, ParsedCardSpec, SeriesPeriod, SeriesPoint, SeriesRef, SpreadSpec } from "../types";
import { MACRO_SERIES_OPTIONS } from "../types";
import { resolveDateRange } from "../utils/date";
import { SqliteCache } from "./sqlite-cache";
import { DataAdapter } from "./data-adapter";
import { FredApiClient } from "./fred-api-client";
import { parseSpreadSpec } from "./series-spec";
import { evalExpression, parseExpression, type ExprNode } from "./expression";

interface SeriesAdapterOptions {
  app: App;
  cache: SqliteCache;
  dataAdapter: DataAdapter;
  getFredApiKey: () => string;
}

// Unified loader for the generic "series" used by overlay and spread cards.
// Dispatches across quote (Tushare OHLCV), macro (Tushare 国内宏观: 货币供应 /
// CPI / PPI / PMI / GDP / 社融 / LPR), fred (FRED API) and card (an existing
// 差值计算卡 file) sources, all yielding YYYY-MM-DD SeriesPoints.
export class SeriesAdapter {
  private app: App;
  private cache: SqliteCache;
  private dataAdapter: DataAdapter;
  private getFredApiKey: () => string;
  private fredClient?: FredApiClient;

  constructor(options: SeriesAdapterOptions) {
    this.app = options.app;
    this.cache = options.cache;
    this.dataAdapter = options.dataAdapter;
    this.getFredApiKey = options.getFredApiKey;
  }

  async loadSeries(ref: SeriesRef, range: string, period: SeriesPeriod = "D", force = false): Promise<SeriesPoint[]> {
    switch (ref.source) {
      case "quote":
        return resamplePoints(await this.loadQuoteSeries(ref, range), period);
      case "macro":
        return resamplePoints(await this.loadMacroSeries(ref, range), period);
      case "fred":
        return resamplePoints(await this.loadFredSeries(ref, range, force), period);
      case "card":
        return this.loadCardSeries(ref, range, period);
    }
  }

  // Loads an existing spread card file and evaluates its expression series.
  // The OVERLAY's own range/period govern; the referenced card's range, period
  // and view settings are ignored.
  private async loadCardSeries(ref: SeriesRef, range: string, period: SeriesPeriod): Promise<SeriesPoint[]> {
    const cardPath = ref.cardPath!;
    const file = this.app.vault.getAbstractFileByPath(cardPath);
    if (!(file instanceof TFile)) {
      throw new Error(`无法读取卡片：${cardPath}（文件不存在）。`);
    }
    const content = await this.app.vault.cachedRead(file);
    const match = content.match(/```spread\n([\s\S]*?)\n```/);
    if (!match) {
      throw new Error(`无法读取卡片：${cardPath}（未找到 spread 代码块）。`);
    }
    const result = parseSpreadSpec(match[1]);
    if (!result.spec) {
      throw new Error(`无法读取卡片：${cardPath}（${result.error ?? "配置无效"}）。`);
    }
    return this.loadSpread(result.spec, range, period);
  }

  private async loadQuoteSeries(ref: SeriesRef, range: string): Promise<SeriesPoint[]> {
    const spec: ParsedCardSpec = {
      symbol: ref.tsCode!,
      assetType: ref.assetType!,
      freq: "D",
      range,
      version: 1,
    };
    const rows = await this.dataAdapter.loadOhlcv(spec);
    return rows.map((row) => ({ date: ymdToIso(row.tradeDate), value: row.close }));
  }

  private async loadMacroSeries(ref: SeriesRef, range: string): Promise<SeriesPoint[]> {
    const { start, end } = resolveDateRange(range);
    return this.dataAdapter.loadMacroSeries(ref.seriesId!, ymdToIso(start), ymdToIso(end));
  }

  private async loadFredSeries(ref: SeriesRef, range: string, force = false): Promise<SeriesPoint[]> {
    const seriesId = ref.seriesId!;
    // Transformed data differs from raw levels, so the transformation is part
    // of the cache key ("DGS10@pch"); raw series keep the bare id.
    const cacheId = ref.transform ? `${seriesId}@${ref.transform}` : seriesId;
    const { start, end } = resolveDateRange(range);
    const startIso = ymdToIso(start);
    const endIso = ymdToIso(end);

    const cachedMax = await this.cache.getMacroSeriesMaxDate("fred", cacheId);
    // FRED series update with a lag; consider the cache stale when its latest
    // observation is older than today - 3 days. force (the card's refresh
    // button) skips the staleness check and always refetches.
    const staleThreshold = isoDaysAgo(3);
    if (force || !cachedMax || cachedMax < staleThreshold) {
      try {
        const client = this.getFredClient();
        const points = await client.fetchSeries(seriesId, cachedMax ?? startIso, ref.transform);
        await this.cache.mergeMacroSeriesRows("fred", cacheId, points);
      } catch (e) {
        console.error("Failed to refresh FRED series:", e);
        const reason = e instanceof Error ? e.message : String(e);
        new Notice(`StrataBoard: FRED 数据刷新失败（${reason}），显示缓存数据。`);
      }
    }
    return this.cache.loadMacroSeries("fred", cacheId, startIso, endIso);
  }

  // Interactive FRED series search for the search modal; delegates to the
  // shared client so key injection/refresh stays in one place.
  async searchFredSeries(text: string): Promise<FredSeriesInfo[]> {
    return this.getFredClient().searchSeries(text);
  }

  private getFredClient(): FredApiClient {
    if (!this.fredClient) {
      this.fredClient = new FredApiClient(this.getFredApiKey());
    } else {
      // The key may have changed in settings since the client was created.
      this.fredClient.setApiKey(this.getFredApiKey());
    }
    return this.fredClient;
  }

  // Loads every series (each resampled to the requested period FIRST), then
  // aligns them and evaluates the card's expression pointwise. With two
  // series and the migrated "A-B" expression this reproduces the legacy
  // two-leg spread exactly. Invalid expressions throw a Chinese error for the
  // card-level error+retry UI (same discipline as loadCardSeries).
  async loadSpread(spec: SpreadSpec, range: string, period: SeriesPeriod = "D"): Promise<SeriesPoint[]> {
    const parsed = parseExpression(spec.expression, spec.series.length);
    if (!parsed.ok) {
      throw new Error(`公式错误：${parsed.error}`);
    }
    const ast = parsed.ast;

    const allPoints = await Promise.all(spec.series.map((ref) => this.loadSeries(ref, range, period)));

    if (allPoints.some(isMonthlyish)) {
      return evalMonthly(allPoints, ast);
    }
    return evalDaily(allPoints, ast);
  }

  static defaultLabel(ref: SeriesRef): string {
    switch (ref.source) {
      case "quote":
        return ref.tsCode ?? "";
      case "macro":
        return MACRO_SERIES_OPTIONS.find((o) => o.id === ref.seriesId)?.label ?? ref.seriesId ?? "";
      case "fred":
        return ref.seriesId ?? "";
      case "card":
        // File basename without the .md extension, e.g. "差值计算-1".
        return ref.cardPath?.split("/").pop()?.replace(/\.md$/, "") ?? "";
    }
  }
}

function ymdToIso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// Resamples ascending points to the requested period by taking the LAST
// observation per bucket (calendar month / quarter / year), keeping that
// observation's actual date. "D" is the identity. Monthly macro data passing
// through "M" is therefore unchanged; through "Q"/"Y" it keeps the last
// month of each quarter/year, which is the desired semantics.
function resamplePoints(points: SeriesPoint[], period: SeriesPeriod): SeriesPoint[] {
  if (period === "D" || points.length === 0) return points;
  const bucketOf = (date: string): string => {
    if (period === "Y") return date.slice(0, 4);
    if (period === "Q") {
      const quarter = Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
      return `${date.slice(0, 4)}-Q${quarter}`;
    }
    return date.slice(0, 7);
  };
  const lastByBucket = new Map<string, SeriesPoint>();
  for (const p of points) {
    lastByBucket.set(bucketOf(p.date), p);
  }
  // Points are ascending, so buckets were inserted in ascending order.
  return [...lastByBucket.values()];
}

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// A series is "monthly-ish" when the median gap between consecutive
// observations is more than 20 days.
function isMonthlyish(points: SeriesPoint[]): boolean {
  if (points.length < 3) return false;
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    gaps.push((Date.parse(points[i].date) - Date.parse(points[i - 1].date)) / 86400000);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return median > 20;
}

// Downsamples every series to month buckets (last observation per YYYY-MM),
// inner-joins the months across ALL series, and evaluates the expression per
// month, emitting at YYYY-MM-01.
function evalMonthly(allPoints: SeriesPoint[][], ast: ExprNode): SeriesPoint[] {
  const monthMaps = allPoints.map((points) => {
    const map = new Map<string, number>();
    for (const p of points) {
      map.set(p.date.slice(0, 7), p.value);
    }
    return map;
  });
  if (monthMaps.length === 0) return [];

  const result: SeriesPoint[] = [];
  for (const month of monthMaps[0].keys()) {
    const values: number[] = [];
    for (const map of monthMaps) {
      const value = map.get(month);
      if (value === undefined) {
        values.length = 0;
        break;
      }
      values.push(value);
    }
    if (values.length === 0) continue;
    const value = evalExpression(ast, (letter) => values[letter.charCodeAt(0) - 65]);
    if (!Number.isFinite(value)) continue;
    result.push({ date: `${month}-01`, value });
  }
  return result.sort((x, y) => x.date.localeCompare(y.date));
}

// Emits points on the FIRST series' dates; for dates missing in another
// series uses that series' latest value <= date (asof/backfill). Dates before
// any series' first observation are skipped (that series has no value yet).
function evalDaily(allPoints: SeriesPoint[][], ast: ExprNode): SeriesPoint[] {
  if (allPoints.length === 0) return [];
  const sorted = allPoints.map((points) => [...points].sort((x, y) => x.date.localeCompare(y.date)));
  const cursors = sorted.map(() => 0);
  const result: SeriesPoint[] = [];
  for (const p of sorted[0]) {
    const values: number[] = [];
    for (let s = 0; s < sorted.length; s++) {
      while (cursors[s] < sorted[s].length && sorted[s][cursors[s]].date <= p.date) {
        cursors[s]++;
      }
      if (cursors[s] === 0) {
        values.length = 0;
        break;
      }
      values.push(sorted[s][cursors[s] - 1].value);
    }
    if (values.length === 0) continue;
    const value = evalExpression(ast, (letter) => values[letter.charCodeAt(0) - 65]);
    if (!Number.isFinite(value)) continue;
    result.push({ date: p.date, value });
  }
  return result;
}
