import * as yaml from "js-yaml";
import {
  ASSET_TYPES,
  FRED_TRANSFORM_OPTIONS,
  MACRO_SERIES_OPTIONS,
  type AssetType,
  type ChartTheme,
  type FredCardSpec,
  type FredTransform,
  type MacroCardSpec,
  type OverlaySpec,
  type SeriesPeriod,
  type SeriesRef,
  type SeriesSource,
  type SpreadSpec,
} from "../types";
import { MAX_CARD_BLEED } from "./card-spec";
import { parseExpression } from "./expression";

// Parse/serialize for the overlay (资产叠加) and spread (差值计算) card
// specs. Like the timeline card, these live outside ParsedCardSpec and are
// parsed with js-yaml directly, using English keys.

export interface SeriesSpecParseResult<T> {
  spec?: T;
  error?: string;
}

const VALID_SOURCES: SeriesSource[] = ["quote", "macro", "fred", "card"];
const VALID_ASSET_TYPES: AssetType[] = ASSET_TYPES;
const VALID_PERIODS: SeriesPeriod[] = ["D", "M", "Q", "Y"];
const VALID_FRED_TRANSFORMS: FredTransform[] = FRED_TRANSFORM_OPTIONS.map((o) => o.value);
const MACRO_IDS = new Set(MACRO_SERIES_OPTIONS.map((o) => o.id));

// Optional FRED transform field; absent/"lin" both mean raw levels (never
// stored). Returns the transform, undefined, or an error message.
function parseFredTransform(raw: unknown, key = "transform"): FredTransform | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const rawValue = String(raw).trim();
  if (rawValue === "" || rawValue === "lin") return undefined;
  const value = rawValue as FredTransform;
  if (!VALID_FRED_TRANSFORMS.includes(value)) {
    return { error: `无效的 ${key}：${rawValue}（应为 ${VALID_FRED_TRANSFORMS.join(" | ")}）。` };
  }
  return value;
}

export const DEFAULT_OVERLAY_SPEC: OverlaySpec = {
  series: [
    { source: "macro", seriesId: "m1_yoy" },
    { source: "macro", seriesId: "m2_yoy" },
  ],
  range: "10y",
};

export const DEFAULT_SPREAD_SPEC: SpreadSpec = {
  series: [
    { source: "macro", seriesId: "m1_yoy" },
    { source: "macro", seriesId: "m2_yoy" },
  ],
  expression: "A-B",
  range: "10y",
};

export function parseOverlaySpec(source: string): SeriesSpecParseResult<OverlaySpec> {
  const map = parseYamlMap(source);
  if (typeof map === "string") return { error: map };

  if (!Array.isArray(map.series) || map.series.length === 0) {
    return { error: "缺少必填字段 series（至少需要一个数据系列）。" };
  }
  const series: SeriesRef[] = [];
  for (let i = 0; i < map.series.length; i++) {
    const ref = parseSeriesRef(map.series[i], `series[${i}]`);
    if (typeof ref === "string") return { error: ref };
    series.push(ref);
  }

  const range = parseRange(map.range);
  const height = parseHeight(map.height);
  if (typeof height !== "number" && height !== undefined) return height;
  const period = parsePeriod(map.period);
  if (typeof period !== "string") return period;
  const viewStart = parseViewDate(map.viewStart, "viewStart");
  if (viewStart !== undefined && typeof viewStart !== "string") return viewStart;
  const viewEnd = parseViewDate(map.viewEnd, "viewEnd");
  if (viewEnd !== undefined && typeof viewEnd !== "string") return viewEnd;
  const normalize = parseNormalize(map.normalize);
  if (typeof normalize !== "boolean") return normalize;
  const theme = parseTheme(map.theme);
  if (typeof theme === "object") return theme;
  const widthAuto = parseAutoFlag(map.widthAuto, "widthAuto");
  if (typeof widthAuto !== "boolean" && widthAuto !== undefined) return widthAuto;
  const heightAuto = parseAutoFlag(map.heightAuto, "heightAuto");
  if (typeof heightAuto !== "boolean" && heightAuto !== undefined) return heightAuto;
  const bleed = parseBleed(map.bleed);
  if (typeof bleed !== "number" && bleed !== undefined) return bleed;

  return {
    spec: {
      series,
      range,
      period,
      normalize,
      ...(height !== undefined ? { height } : {}),
      ...(theme ? { theme } : {}),
      ...(widthAuto !== undefined ? { widthAuto } : {}),
      ...(heightAuto !== undefined ? { heightAuto } : {}),
      ...(bleed !== undefined ? { bleed } : {}),
      ...(viewStart ? { viewStart } : {}),
      ...(viewEnd ? { viewEnd } : {}),
    },
  };
}

export function parseSpreadSpec(source: string): SeriesSpecParseResult<SpreadSpec> {
  const map = parseYamlMap(source);
  if (typeof map === "string") return { error: map };

  // Current shape: series[] + expression. Legacy 差值计算 cards carry two
  // legs (a/b) and migrate to the equivalent "A-B" expression.
  let series: SeriesRef[];
  let expression: string;
  if (Array.isArray(map.series) && map.series.length > 0) {
    series = [];
    for (let i = 0; i < map.series.length; i++) {
      const ref = parseSeriesRef(map.series[i], `series[${i}]`);
      if (typeof ref === "string") return { error: ref };
      series.push(ref);
    }
    expression = String(map.expression ?? "").trim();
    if (!expression) {
      return { error: "缺少必填字段 expression（如 A-B、(A+B)/2）。" };
    }
  } else if (map.a !== undefined && map.a !== null && map.b !== undefined && map.b !== null) {
    const a = parseSeriesRef(map.a, "a");
    if (typeof a === "string") return { error: a };
    const b = parseSeriesRef(map.b, "b");
    if (typeof b === "string") return { error: b };
    series = [a, b];
    expression = "A-B";
  } else {
    return { error: "缺少必填字段 series（至少需要一个数据系列）。" };
  }

  // Hand-written YAML may reference undefined letters or have broken syntax;
  // surface the parser's Chinese reason as the card-level error.
  const parsedExpr = parseExpression(expression, series.length);
  if (!parsedExpr.ok) {
    return { error: `公式错误：${parsedExpr.error}` };
  }

  const range = parseRange(map.range);
  const height = parseHeight(map.height);
  if (typeof height !== "number" && height !== undefined) return height;
  const period = parsePeriod(map.period);
  if (typeof period !== "string") return period;
  const viewStart = parseViewDate(map.viewStart, "viewStart");
  if (viewStart !== undefined && typeof viewStart !== "string") return viewStart;
  const viewEnd = parseViewDate(map.viewEnd, "viewEnd");
  if (viewEnd !== undefined && typeof viewEnd !== "string") return viewEnd;
  const theme = parseTheme(map.theme);
  if (typeof theme === "object") return theme;
  const lineWidth = parseLineWidth(map.lineWidth);
  if (typeof lineWidth !== "number" && lineWidth !== undefined) return lineWidth;
  const lineColor = parseLineColor(map.lineColor);
  if (typeof lineColor !== "string" && lineColor !== undefined) return lineColor;
  const widthAuto = parseAutoFlag(map.widthAuto, "widthAuto");
  if (typeof widthAuto !== "boolean" && widthAuto !== undefined) return widthAuto;
  const heightAuto = parseAutoFlag(map.heightAuto, "heightAuto");
  if (typeof heightAuto !== "boolean" && heightAuto !== undefined) return heightAuto;
  const bleed = parseBleed(map.bleed);
  if (typeof bleed !== "number" && bleed !== undefined) return bleed;

  return {
    spec: {
      series,
      expression,
      range,
      period,
      ...(height !== undefined ? { height } : {}),
      ...(theme ? { theme } : {}),
      ...(lineWidth !== undefined ? { lineWidth } : {}),
      ...(lineColor ? { lineColor } : {}),
      ...(widthAuto !== undefined ? { widthAuto } : {}),
      ...(heightAuto !== undefined ? { heightAuto } : {}),
      ...(bleed !== undefined ? { bleed } : {}),
      ...(viewStart ? { viewStart } : {}),
      ...(viewEnd ? { viewEnd } : {}),
    },
  };
}

export function stringifyOverlaySpec(spec: OverlaySpec): string {
  return yaml.dump({
    series: spec.series,
    range: spec.range,
    ...(spec.period && spec.period !== "D" ? { period: spec.period } : {}),
    ...(spec.normalize === false ? { normalize: false } : {}),
    ...(spec.height ? { height: spec.height } : {}),
    ...(spec.theme && spec.theme !== "auto" ? { theme: spec.theme } : {}),
    ...(spec.widthAuto === false ? { widthAuto: false } : {}),
    ...(spec.heightAuto === false ? { heightAuto: false } : {}),
    ...(spec.bleed != null && spec.bleed !== 8 ? { bleed: spec.bleed } : {}),
    ...(spec.viewStart ? { viewStart: spec.viewStart } : {}),
    ...(spec.viewEnd ? { viewEnd: spec.viewEnd } : {}),
  }).trimEnd();
}

export function stringifySpreadSpec(spec: SpreadSpec): string {
  return yaml.dump({
    expression: spec.expression,
    series: spec.series,
    range: spec.range,
    ...(spec.period && spec.period !== "D" ? { period: spec.period } : {}),
    ...(spec.height ? { height: spec.height } : {}),
    ...(spec.theme && spec.theme !== "auto" ? { theme: spec.theme } : {}),
    ...(spec.lineWidth != null && spec.lineWidth !== 2 ? { lineWidth: spec.lineWidth } : {}),
    ...(spec.lineColor ? { lineColor: spec.lineColor } : {}),
    ...(spec.widthAuto === false ? { widthAuto: false } : {}),
    ...(spec.heightAuto === false ? { heightAuto: false } : {}),
    ...(spec.bleed != null && spec.bleed !== 8 ? { bleed: spec.bleed } : {}),
    ...(spec.viewStart ? { viewStart: spec.viewStart } : {}),
    ...(spec.viewEnd ? { viewEnd: spec.viewEnd } : {}),
  }).trimEnd();
}

export function parseFredCardSpec(source: string): SeriesSpecParseResult<FredCardSpec> {
  const map = parseYamlMap(source);
  if (typeof map === "string") return { error: map };

  const seriesId = String(map.seriesId ?? "").trim();
  if (!seriesId) {
    return { error: "缺少必填字段 seriesId（FRED 系列代码，如 DGS10）。" };
  }
  const label = String(map.label ?? "").trim();
  const units = String(map.units ?? "").trim();
  const frequency = String(map.frequency ?? "").trim();
  const transform = parseFredTransform(map.transform);
  if (typeof transform === "object") return transform;

  const range = parseRange(map.range);
  const height = parseHeight(map.height);
  if (typeof height !== "number" && height !== undefined) return height;
  const period = parsePeriod(map.period);
  if (typeof period !== "string") return period;
  const viewStart = parseViewDate(map.viewStart, "viewStart");
  if (viewStart !== undefined && typeof viewStart !== "string") return viewStart;
  const viewEnd = parseViewDate(map.viewEnd, "viewEnd");
  if (viewEnd !== undefined && typeof viewEnd !== "string") return viewEnd;

  return {
    spec: {
      seriesId,
      ...(label ? { label } : {}),
      ...(units ? { units } : {}),
      ...(frequency ? { frequency } : {}),
      ...(transform ? { transform } : {}),
      range,
      period,
      ...(height !== undefined ? { height } : {}),
      ...(viewStart ? { viewStart } : {}),
      ...(viewEnd ? { viewEnd } : {}),
    },
  };
}

export function stringifyFredCardSpec(spec: FredCardSpec): string {
  return yaml.dump({
    seriesId: spec.seriesId,
    ...(spec.label ? { label: spec.label } : {}),
    ...(spec.units ? { units: spec.units } : {}),
    ...(spec.frequency ? { frequency: spec.frequency } : {}),
    ...(spec.transform ? { transform: spec.transform } : {}),
    range: spec.range,
    ...(spec.period && spec.period !== "D" ? { period: spec.period } : {}),
    ...(spec.height ? { height: spec.height } : {}),
    ...(spec.viewStart ? { viewStart: spec.viewStart } : {}),
    ...(spec.viewEnd ? { viewEnd: spec.viewEnd } : {}),
  }).trimEnd();
}

export function parseMacroCardSpec(source: string): SeriesSpecParseResult<MacroCardSpec> {
  const map = parseYamlMap(source);
  if (typeof map === "string") return { error: map };

  const seriesId = String(map.seriesId ?? "").trim();
  if (!MACRO_IDS.has(seriesId)) {
    return { error: `seriesId 无效：${seriesId}（不是已知的宏观序列）。` };
  }

  const range = parseRange(map.range);
  const height = parseHeight(map.height);
  if (typeof height !== "number" && height !== undefined) return height;
  const period = parsePeriod(map.period);
  if (typeof period !== "string") return period;
  const viewStart = parseViewDate(map.viewStart, "viewStart");
  if (viewStart !== undefined && typeof viewStart !== "string") return viewStart;
  const viewEnd = parseViewDate(map.viewEnd, "viewEnd");
  if (viewEnd !== undefined && typeof viewEnd !== "string") return viewEnd;

  return {
    spec: {
      seriesId,
      range,
      period,
      ...(height !== undefined ? { height } : {}),
      ...(viewStart ? { viewStart } : {}),
      ...(viewEnd ? { viewEnd } : {}),
    },
  };
}

export function stringifyMacroCardSpec(spec: MacroCardSpec): string {
  return yaml.dump({
    seriesId: spec.seriesId,
    range: spec.range,
    ...(spec.period && spec.period !== "D" ? { period: spec.period } : {}),
    ...(spec.height ? { height: spec.height } : {}),
    ...(spec.viewStart ? { viewStart: spec.viewStart } : {}),
    ...(spec.viewEnd ? { viewEnd: spec.viewEnd } : {}),
  }).trimEnd();
}

// Returns the parsed YAML object, or an error message string.
function parseYamlMap(source: string): Record<string, unknown> | string {
  let parsed: unknown;
  try {
    parsed = yaml.load(source.replace(/\r\n?/g, "\n"));
  } catch (e) {
    return `YAML 解析失败：${e instanceof Error ? e.message : String(e)}`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "代码块必须是一个 YAML 对象。";
  }
  return parsed as Record<string, unknown>;
}

// Validates one series entry; returns the SeriesRef or an error message.
function parseSeriesRef(raw: unknown, path: string): SeriesRef | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return `${path} 必须是一个 YAML 对象。`;
  }
  const map = raw as Record<string, unknown>;

  const source = String(map.source ?? "").trim() as SeriesSource;
  if (!VALID_SOURCES.includes(source)) {
    return `${path} 的 source 无效：${String(map.source)}（应为 quote | macro | fred | card）。`;
  }

  const ref: SeriesRef = { source };

  if (source === "card") {
    const cardPath = String(map.cardPath ?? "").trim();
    if (!cardPath) {
      return `${path} 缺少有效的 cardPath（引用的数据计算卡片文件路径）。`;
    }
    ref.cardPath = cardPath;
  } else if (source === "quote") {
    const tsCode = String(map.tsCode ?? "").trim();
    // Global-index ts_codes are bare (HSI, XIN9) — the ".XX" suffix is not
    // required.
    if (!/^\w+(\.\w+)?$/.test(tsCode)) {
      return `${path} 缺少有效的 tsCode（如 600519.SH、HSI）。`;
    }
    const assetType = String(map.assetType ?? "").trim() as AssetType;
    if (!VALID_ASSET_TYPES.includes(assetType)) {
      return `${path} 的 assetType 无效：${String(map.assetType)}（应为 ${VALID_ASSET_TYPES.join(" | ")}）。`;
    }
    ref.tsCode = tsCode;
    ref.assetType = assetType;
  } else if (source === "macro") {
    const seriesId = String(map.seriesId ?? "").trim();
    if (!MACRO_IDS.has(seriesId)) {
      return `${path} 的 seriesId 无效：${seriesId}（不是已知的宏观序列）。`;
    }
    ref.seriesId = seriesId;
  } else {
    const seriesId = String(map.seriesId ?? "").trim();
    if (!seriesId) {
      return `${path} 缺少有效的 seriesId（FRED 系列代码，如 DGS10）。`;
    }
    ref.seriesId = seriesId;
    // Optional FRED "units" metadata (e.g. "Percent"), written by the search
    // flow; used at render time to tell percent series apart.
    const units = String(map.units ?? "").trim();
    if (units) {
      ref.units = units;
    }
    const transform = parseFredTransform(map.transform, `${path} 的 transform`);
    if (typeof transform === "object") {
      return transform.error;
    }
    if (transform) {
      ref.transform = transform;
    }
  }

  const label = String(map.label ?? "").trim();
  if (label) {
    ref.label = label;
  }

  return ref;
}

function parseRange(raw: unknown): string {
  if (raw === undefined || raw === null) return "10y";
  const range = String(raw).trim();
  return range || "10y";
}

function parsePeriod(raw: unknown): SeriesPeriod | { error: string } {
  if (raw === undefined || raw === null) return "D";
  const value = String(raw).trim().toUpperCase() as SeriesPeriod;
  if (!VALID_PERIODS.includes(value)) {
    return { error: `无效的 period：${String(raw)}（应为 D | M | Q | Y）。` };
  }
  return value;
}

// Loose YYYY-MM-DD check for the persisted wheel-zoom visible range.
function parseViewDate(raw: unknown, key: string): string | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: `无效的 ${key}：${value}（应为 YYYY-MM-DD）。` };
  }
  return value;
}

// Overlay-only: quote lines normalize to % change by default (true).
function parseNormalize(raw: unknown): boolean | { error: string } {
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== "boolean") {
    return { error: `无效的 normalize：${String(raw)}（应为 true 或 false）。` };
  }
  return raw;
}

function parseHeight(raw: unknown): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const height = Number(raw);
  if (!Number.isFinite(height) || height <= 0) {
    return { error: `无效的 height：${String(raw)}（应为正数，单位 px）。` };
  }
  return height;
}

const VALID_THEMES: ChartTheme[] = ["auto", "dark", "light"];

function parseTheme(raw: unknown): ChartTheme | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim() as ChartTheme;
  if (!VALID_THEMES.includes(value)) {
    return { error: `无效的 theme：${String(raw)}（应为 auto | dark | light）。` };
  }
  return value;
}

function parseLineWidth(raw: unknown): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const width = Number(raw);
  // lightweight-charts only accepts 1|2|3|4 (LineWidth).
  if (!Number.isInteger(width) || width < 1 || width > 4) {
    return { error: `无效的 lineWidth：${String(raw)}（应为 1–4 的整数，单位 px）。` };
  }
  return width;
}

function parseLineColor(raw: unknown): string | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    return { error: `无效的 lineColor：${String(raw)}（应为 #rrggbb）。` };
  }
  return value;
}

function parseAutoFlag(raw: unknown, key: string): boolean | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    return { error: `无效的 ${key}：${String(raw)}（应为 true 或 false）。` };
  }
  return raw;
}

function parseBleed(raw: unknown): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const bleed = Number(raw);
  if (!Number.isFinite(bleed) || bleed < 0 || bleed > MAX_CARD_BLEED) {
    return { error: `无效的 bleed：${String(raw)}（应为 0–${MAX_CARD_BLEED}，单位 px）。` };
  }
  return Math.round(bleed);
}
