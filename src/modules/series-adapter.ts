import { App, TFile } from "obsidian";
import type { ParsedCardSpec, SeriesPeriod, SeriesPoint, SeriesRef, SpreadSpec } from "../types";
import { SqliteCache } from "./sqlite-cache";
import { DataAdapter } from "./data-adapter";
import { parseCardSpec } from "./card-spec";
import { parseSpreadSpec } from "./series-spec";
import { evalExpression, parseExpression, type ExprNode } from "./expression";
import { t } from "../i18n";

interface SeriesAdapterOptions {
  app: App;
  cache: SqliteCache;
  dataAdapter: DataAdapter;
}

// Unified loader for the generic "series" used by overlay and spread cards.
// Dispatches across quote (custom-source OHLCV) and card (an existing
// quote/spread card file) sources, all yielding YYYY-MM-DD SeriesPoints.
// `visited` threads the card-reference chain so hand-written YAML cycles
// (A refs B refs A) fail fast instead of recursing forever.
export class SeriesAdapter {
  private app: App;
  private dataAdapter: DataAdapter;

  constructor(options: SeriesAdapterOptions) {
    this.app = options.app;
    this.dataAdapter = options.dataAdapter;
  }

  async loadSeries(
    ref: SeriesRef,
    range: string,
    period: SeriesPeriod = "D",
    force = false,
    visited: Set<string> = new Set()
  ): Promise<SeriesPoint[]> {
    switch (ref.source) {
      case "quote":
        return resamplePoints(await this.loadQuoteSeries(ref, range), period);
      case "card":
        return this.loadCardSeries(ref, range, period, visited);
    }
  }

  // Loads an existing card file and resolves it to a point series by block
  // type: spread cards evaluate their expression (recursively), quote cards
  // yield their close prices. The OVERLAY's own range/period govern; the
  // referenced card's range, period and view settings are ignored.
  private async loadCardSeries(
    ref: SeriesRef,
    range: string,
    period: SeriesPeriod,
    visited: Set<string>
  ): Promise<SeriesPoint[]> {
    const cardPath = ref.cardPath!;
    if (visited.has(cardPath)) {
      throw new Error(t("检测到循环引用：{path}。", { path: cardPath }));
    }
    visited.add(cardPath);
    const file = this.app.vault.getAbstractFileByPath(cardPath);
    if (!(file instanceof TFile)) {
      throw new Error(t("无法读取卡片：{path}（文件不存在）。", { path: cardPath }));
    }
    const content = await this.app.vault.cachedRead(file);
    const match = content.match(/```(quote|spread)\n([\s\S]*?)\n```/);
    if (!match) {
      throw new Error(t("无法读取卡片：{path}（未找到可引用的数据代码块）。", { path: cardPath }));
    }
    const kind = match[1];
    const body = match[2];
    const invalid = (reason: string) =>
      new Error(t("无法读取卡片：{path}（{reason}）。", { path: cardPath, reason }));

    if (kind === "spread") {
      const result = parseSpreadSpec(body);
      if (!result.spec) {
        throw invalid(result.error ?? t("配置无效"));
      }
      return this.loadSpread(result.spec, range, period, visited);
    }
    const result = parseCardSpec(body);
    if (!result.ok) {
      throw invalid(result.error.message);
    }
    const spec = result.spec;
    const points = await this.loadQuoteSeries(
      { source: "quote", tsCode: spec.symbol, assetType: spec.assetType, sourceId: spec.sourceId },
      range
    );
    return resamplePoints(points, period);
  }

  private async loadQuoteSeries(ref: SeriesRef, range: string): Promise<SeriesPoint[]> {
    const spec: ParsedCardSpec = {
      symbol: ref.tsCode!,
      assetType: ref.assetType!,
      sourceId: ref.sourceId,
      freq: "D",
      range,
      version: 1,
    };
    const rows = await this.dataAdapter.loadOhlcv(spec);
    return rows.map((row) => ({ date: ymdToIso(row.tradeDate), value: row.close }));
  }

  // Loads every series (each resampled to the requested period FIRST), then
  // aligns them and evaluates the card's expression pointwise. With two
  // series and the migrated "A-B" expression this reproduces the legacy
  // two-leg spread exactly. Invalid expressions throw a Chinese error for the
  // card-level error+retry UI (same discipline as loadCardSeries).
  async loadSpread(spec: SpreadSpec, range: string, period: SeriesPeriod = "D", visited: Set<string> = new Set()): Promise<SeriesPoint[]> {
    const parsed = parseExpression(spec.expression, spec.series.length);
    if (!parsed.ok) {
      throw new Error(t("公式错误：{msg}", { msg: parsed.error }));
    }
    const ast = parsed.ast;

    const allPoints = await Promise.all(spec.series.map((ref) => this.loadSeries(ref, range, period, false, visited)));

    if (allPoints.some(isMonthlyish)) {
      return evalMonthly(allPoints, ast);
    }
    return evalDaily(allPoints, ast);
  }

  static defaultLabel(ref: SeriesRef): string {
    switch (ref.source) {
      case "quote":
        return ref.tsCode ?? "";
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
// observation's actual date. "D" is the identity. Monthly data passing
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
