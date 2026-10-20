import type { ParsedCardSpec, SeriesPeriod, SeriesPoint, SeriesRef, SpreadSpec } from "../types";
import { DataAdapter, type OhlcvLoadResult } from "./data-adapter";
import { parseSpreadSpec } from "./series-spec";
import { evalExpression, parseExpression, type ExprNode } from "./expression";
import { t } from "../i18n";

// Host capabilities the adapter needs from the embedding app (card-id → path
// resolution + vault file reads). Obsidian-free so the CLI can back these
// with plain fs reads.
export interface SeriesCardHost {
  // cardId → vault-relative path; null when the id doesn't resolve.
  resolveCardId(cardId: string): Promise<string | null>;
  // In-memory snapshot of resolveCardId for contexts that cannot await (edit
  // modals); may return null on a cold cache.
  resolveCardIdSync?(cardId: string): string | null;
  // Reads the md file at a vault-relative path; null when missing/not a file.
  readCardFile(path: string): Promise<string | null>;
}

// Cache-serve signals collected across the quote legs of one load, so the
// card can show the shared cache badge when ANY leg fell back to cached data.
// lastDataAt keeps the OLDEST leg date (the most conservative freshness).
export interface SeriesLoadMeta {
  fromCache: boolean;
  lastDataAt?: string;
}

interface SeriesAdapterOptions {
  dataAdapter: DataAdapter;
  host: SeriesCardHost;
  // 打开自动刷新 setting (plugin only): when OFF, quote legs read the cache
  // first and fetch only on a cold cache — same semantics as the quote card.
  // Defaults to always-fetch (CLI/headless behavior).
  autoRefreshOnOpen?: () => boolean;
}

// Unified loader for the generic "series" used by overlay and spread cards.
// Dispatches across quote (custom-source OHLCV) and card (an existing spread
// card, referenced by its stable SpreadSpec.id) sources, all yielding
// YYYY-MM-DD SeriesPoints. `visited` threads the card-reference chain so
// hand-written YAML cycles (A refs B refs A) fail fast instead of recursing
// forever.
export class SeriesAdapter {
  private dataAdapter: DataAdapter;
  private host: SeriesCardHost;
  private autoRefreshOnOpen: () => boolean;

  constructor(options: SeriesAdapterOptions) {
    this.dataAdapter = options.dataAdapter;
    this.host = options.host;
    this.autoRefreshOnOpen = options.autoRefreshOnOpen ?? (() => true);
  }

  async loadSeries(
    ref: SeriesRef,
    range: string,
    period: SeriesPeriod = "D",
    force = false,
    visited: Set<string> = new Set(),
    meta?: SeriesLoadMeta
  ): Promise<SeriesPoint[]> {
    switch (ref.source) {
      case "quote":
        return resamplePoints(await this.loadQuoteSeries(ref, range, meta), period);
      case "card":
        return this.loadCardSeries(ref, range, period, visited, meta);
    }
  }

  // Resolves a card ref (SeriesRef.cardId) to the referenced spread card's
  // evaluated point series. The OVERLAY's own range/period govern; the
  // referenced card's range, period and view settings are ignored. Quote
  // cards are never referenced — pickers emit plain quote refs instead.
  private async loadCardSeries(
    ref: SeriesRef,
    range: string,
    period: SeriesPeriod,
    visited: Set<string>,
    meta?: SeriesLoadMeta
  ): Promise<SeriesPoint[]> {
    const cardId = ref.cardId!;
    if (visited.has(cardId)) {
      throw new Error(t("检测到循环引用：{path}。", { path: cardId }));
    }
    visited.add(cardId);
    const cardPath = await this.host.resolveCardId(cardId);
    if (!cardPath) {
      throw new Error(t("无法读取卡片：引用的计算卡不存在（id: {id}）。", { id: cardId }));
    }
    const content = await this.host.readCardFile(cardPath);
    if (content == null) {
      throw new Error(t("无法读取卡片：{path}（文件不存在）。", { path: cardPath }));
    }
    const match = content.match(/```spread\n([\s\S]*?)\n```/);
    if (!match) {
      throw new Error(t("无法读取卡片：{path}（引用的卡片不是计算卡）。", { path: cardPath }));
    }
    const invalid = (reason: string) =>
      new Error(t("无法读取卡片：{path}（{reason}）。", { path: cardPath, reason }));

    const result = parseSpreadSpec(match[1]);
    if (!result.spec) {
      throw invalid(result.error ?? t("配置无效"));
    }
    return this.loadSpread(result.spec, range, period, visited, meta);
  }

  private async loadQuoteSeries(ref: SeriesRef, range: string, meta?: SeriesLoadMeta): Promise<SeriesPoint[]> {
    const spec: ParsedCardSpec = {
      symbol: ref.tsCode!,
      assetType: ref.assetType!,
      sourceId: ref.sourceId,
      profile: ref.profile,
      freq: "D",
      range,
      version: 1,
    };
    let result: OhlcvLoadResult;
    if (!this.autoRefreshOnOpen()) {
      const cached = await this.dataAdapter.loadCachedOhlcv(spec);
      if (cached.length > 0) {
        // A deliberate cache read (auto-refresh off) is not a fallback.
        result = { rows: cached, fromCache: false };
      } else {
        // First use (or cache miss): fetch once even when auto-refresh is
        // off, otherwise a series with an empty cache stays empty forever.
        result = await this.dataAdapter.loadOhlcv(spec);
      }
    } else {
      result = await this.dataAdapter.loadOhlcv(spec);
    }
    if (meta && result.fromCache) {
      meta.fromCache = true;
      if (result.lastDataAt && (!meta.lastDataAt || result.lastDataAt < meta.lastDataAt)) {
        meta.lastDataAt = result.lastDataAt;
      }
    }
    return result.rows.map((row) => ({ date: ymdToIso(row.tradeDate), value: row.close }));
  }

  // Loads every series (each resampled to the requested period FIRST), then
  // aligns them and evaluates the card's expression pointwise. With two
  // series and the migrated "A-B" expression this reproduces the legacy
  // two-leg spread exactly. Invalid expressions throw a Chinese error for the
  // card-level error+retry UI (same discipline as loadCardSeries).
  async loadSpread(spec: SpreadSpec, range: string, period: SeriesPeriod = "D", visited: Set<string> = new Set(), meta?: SeriesLoadMeta): Promise<SeriesPoint[]> {
    const parsed = parseExpression(spec.expression, spec.series.length);
    if (!parsed.ok) {
      throw new Error(t("公式错误：{msg}", { msg: parsed.error }));
    }
    const ast = parsed.ast;

    const allPoints = await Promise.all(spec.series.map((ref) => this.loadSeries(ref, range, period, false, visited, meta)));

    if (allPoints.some(isMonthlyish)) {
      return evalMonthly(allPoints, ast);
    }
    return evalDaily(allPoints, ast);
  }

  static defaultLabel(ref: SeriesRef): string {
    return ref.tsCode ? (ref.profile ? `${ref.tsCode} · ${ref.profile}` : ref.tsCode) : "";
  }

  // Display name for a series ref: explicit label first, then the referenced
  // spread card's file basename (async: the card index may need a rebuild),
  // finally the raw quote code. Card refs fall back to a generic 计算卡 when
  // the id no longer resolves.
  async resolveLabel(ref: SeriesRef): Promise<string> {
    if (ref.label) return ref.label;
    if (ref.source === "card") {
      const path = ref.cardId ? await this.host.resolveCardId(ref.cardId) : null;
      return basename(path) ?? t("计算卡");
    }
    return ref.tsCode ? (ref.profile ? `${ref.tsCode} · ${ref.profile}` : ref.tsCode) : "";
  }

  // Sync variant for contexts that cannot await (edit modals): uses only the
  // host's warm in-memory map, same 计算卡 fallback.
  resolveLabelSync(ref: SeriesRef): string {
    if (ref.label) return ref.label;
    if (ref.source === "card") {
      const path = ref.cardId ? this.host.resolveCardIdSync?.(ref.cardId) ?? null : null;
      return basename(path) ?? t("计算卡");
    }
    return ref.tsCode ? (ref.profile ? `${ref.tsCode} · ${ref.profile}` : ref.tsCode) : "";
  }
}

// File basename without the .md extension, e.g. "差值计算-1".
function basename(path: string | null): string | null {
  return path?.split("/").pop()?.replace(/\.md$/, "") ?? null;
}

function ymdToIso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// Resamples ascending points to the requested period by taking the LAST
// observation per bucket (ISO week / calendar month / quarter / year),
// keeping that observation's actual date. "D" is the identity. Monthly data
// passing through "M" is therefore unchanged; through "Q"/"Y" it keeps the
// last month of each quarter/year, which is the desired semantics. The weekly
// bucket key is the week's Monday, same convention as data-adapter's W
// resampling.
function resamplePoints(points: SeriesPoint[], period: SeriesPeriod): SeriesPoint[] {
  if (period === "D" || points.length === 0) return points;
  const bucketOf = (date: string): string => {
    if (period === "Y") return date.slice(0, 4);
    if (period === "Q") {
      const quarter = Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
      return `${date.slice(0, 4)}-Q${quarter}`;
    }
    if (period === "W") {
      const d = new Date(`${date}T00:00:00`);
      const day = d.getDay();
      d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
