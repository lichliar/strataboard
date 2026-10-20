import { parse, stringify } from "yaml";
import {
  ASSET_TYPES,
  CORR_TRANSFORMS,
  SERIES_VALUE_KINDS,
  type AssetType,
  type ChartTheme,
  type CorrTransform,
  type DisplayOverrides,
  type OverlayCompareMode,
  type OverlaySpec,
  type SeriesPeriod,
  type SeriesLineType,
  type SeriesRef,
  type SeriesSource,
  type SeriesValueKind,
  type SpreadSpec,
} from "../types";
import { parseExpression } from "./expression";
import { t } from "../i18n";

// Parse/serialize for the overlay (compare) and spread (calc) card
// specs. These live outside ParsedCardSpec and are parsed with the `yaml`
// package directly, using English keys.

export interface SeriesSpecParseResult<T> {
  spec?: T;
  error?: string;
}

const VALID_SOURCES: SeriesSource[] = ["quote", "card"];
const VALID_ASSET_TYPES: AssetType[] = ASSET_TYPES;
const VALID_PERIODS: SeriesPeriod[] = ["D", "W", "M", "Q", "Y"];

export const DEFAULT_OVERLAY_SPEC: OverlaySpec = {
  series: [],
  range: "10y",
};

export const DEFAULT_SPREAD_SPEC: SpreadSpec = {
  series: [],
  expression: "A-B",
  range: "10y",
};

// Overlay cards overlay up to this many series on one chart; the line
// palette (SERIES_LINE_COLORS) must stay at least this long so every series
// gets a distinct color.
export const MAX_OVERLAY_SERIES = 10;

// Strict known-key whitelists: any other YAML key (unknown or removed in a
// past version) is a parse error, so stale/typo'd fields surface instead of
// being silently ignored. Display-override keys (DisplayOverrides) are shared.
const DISPLAY_OVERRIDE_KEYS = [
  "showLegend", "legendFrosted", "legendOpacity", "showLatestValue", "showPointMarkers", "showGrid", "gridOpacity",
];
export const OVERLAY_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "series", "range", "period", "normalize", "lineType", "theme", "title", "correlation", "viewStart", "viewEnd",
  ...DISPLAY_OVERRIDE_KEYS,
]);
export const SPREAD_KNOWN_KEYS: ReadonlySet<string> = new Set([
  // a/b are the legacy two-leg shape, recognized for the migration error path.
  "id", "series", "expression", "a", "b", "range", "period", "theme", "lineWidth", "lineColor", "lineType", "style",
  "title", "viewStart", "viewEnd",
  ...DISPLAY_OVERRIDE_KEYS,
]);

function unknownKeysError(map: Record<string, unknown>, known: ReadonlySet<string>): string | null {
  const unknown = Object.keys(map).filter((key) => !known.has(key));
  if (unknown.length === 0) return null;
  return t("卡片配置包含未知或已删除的字段：{keys}", { keys: unknown.join(", ") });
}

// Strict known-key whitelist for one series entry, same discipline as the
// card-level whitelists: a typo'd or not-yet-implemented field (e.g. `kin`)
// must surface as a parse error instead of being silently ignored. cardPath
// is listed so it reaches the targeted legacy-error branch in parseSeriesRef
// instead of the generic unknown-key error.
const SERIES_REF_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "source", "tsCode", "assetType", "sourceId", "profile", "cardId", "cardPath", "label", "scale", "kind", "corr",
]);

export function parseOverlaySpec(source: string): SeriesSpecParseResult<OverlaySpec> {
  const map = parseYamlMap(source);
  if (typeof map === "string") return { error: map };
  const unknownKeys = unknownKeysError(map, OVERLAY_KNOWN_KEYS);
  if (unknownKeys) return { error: unknownKeys };

  if (!Array.isArray(map.series) || map.series.length === 0) {
    return { error: t("缺少必填字段 series（至少需要一个数据系列）。") };
  }
  if (map.series.length > MAX_OVERLAY_SERIES) {
    return { error: t("对比卡最多支持 {max} 个数据系列。", { max: MAX_OVERLAY_SERIES }) };
  }
  const series: SeriesRef[] = [];
  for (let i = 0; i < map.series.length; i++) {
    const ref = parseSeriesRef(map.series[i], `series[${i}]`, true);
    if (typeof ref === "string") return { error: ref };
    series.push(ref);
  }

  const range = parseRange(map.range);
  const period = parsePeriod(map.period);
  if (typeof period !== "string") return period;
  const viewStart = parseViewDate(map.viewStart, "viewStart");
  if (viewStart !== undefined && typeof viewStart !== "string") return viewStart;
  const viewEnd = parseViewDate(map.viewEnd, "viewEnd");
  if (viewEnd !== undefined && typeof viewEnd !== "string") return viewEnd;
  const normalize = parseNormalize(map.normalize);
  if (typeof normalize !== "string") return normalize;
  const correlation = parseAutoFlag(map.correlation, "correlation");
  if (typeof correlation !== "boolean" && correlation !== undefined) return correlation;
  const lineType = parseLineType(map.lineType);
  if (typeof lineType === "object") return lineType;
  const theme = parseTheme(map.theme);
  if (typeof theme === "object") return theme;
  const display = parseDisplayOverrides(map);
  if ("error" in display) return display;

  return {
    spec: {
      series,
      range,
      period,
      normalize,
      ...seriesTitle(map),
      ...(correlation === false ? { correlation: false } : {}),
      ...(lineType ? { lineType } : {}),
      ...(theme ? { theme } : {}),
      ...display,
      ...(viewStart ? { viewStart } : {}),
      ...(viewEnd ? { viewEnd } : {}),
    },
  };
}

export function parseSpreadSpec(source: string): SeriesSpecParseResult<SpreadSpec> {
  const map = parseYamlMap(source);
  if (typeof map === "string") return { error: map };
  const unknownKeys = unknownKeysError(map, SPREAD_KNOWN_KEYS);
  if (unknownKeys) return { error: unknownKeys };

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
      return { error: t("缺少必填字段 expression（如 A-B、(A+B)/2）。") };
    }
  } else if (map.a !== undefined && map.a !== null && map.b !== undefined && map.b !== null) {
    const a = parseSeriesRef(map.a, "a");
    if (typeof a === "string") return { error: a };
    const b = parseSeriesRef(map.b, "b");
    if (typeof b === "string") return { error: b };
    series = [a, b];
    expression = "A-B";
  } else {
    return { error: t("缺少必填字段 series（至少需要一个数据系列）。") };
  }

  // Hand-written YAML may reference undefined letters or have broken syntax;
  // surface the parser's Chinese reason as the card-level error.
  const parsedExpr = parseExpression(expression, series.length);
  if (!parsedExpr.ok) {
    return { error: t("公式错误：{msg}", { msg: parsedExpr.error }) };
  }

  const range = parseRange(map.range);
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
  const style = map.style === undefined || map.style === null ? undefined : String(map.style);
  if (style !== undefined && style !== "line" && style !== "baseline" && style !== "area") {
    return { error: t("style 仅支持 line、baseline 或 area。") };
  }
  const lineType = parseLineType(map.lineType);
  if (typeof lineType === "object") return lineType;
  const display = parseDisplayOverrides(map);
  if ("error" in display) return display;

  // Missing/invalid ids are NOT card errors: the renderer (and the card
  // listing) write a fresh id back on first sight. Only non-empty strings
  // are carried through.
  const id = String(map.id ?? "").trim();
  return {
    spec: {
      ...(id ? { id } : {}),
      series,
      expression,
      range,
      ...seriesTitle(map),
      period,
      ...(theme ? { theme } : {}),
      ...(lineWidth !== undefined ? { lineWidth } : {}),
      ...(lineColor ? { lineColor } : {}),
      ...(lineType ? { lineType } : {}),
      ...(style === "baseline" || style === "area" ? { style } : {}),
      ...display,
      ...(viewStart ? { viewStart } : {}),
      ...(viewEnd ? { viewEnd } : {}),
    },
  };
}

export function stringifyOverlaySpec(spec: OverlaySpec): string {
  return stringify({
    series: spec.series,
    range: spec.range,
    ...(spec.title ? { title: spec.title } : {}),
    ...(spec.period && spec.period !== "D" ? { period: spec.period } : {}),
    ...(spec.normalize && spec.normalize !== "percent" ? { normalize: spec.normalize } : {}),
    ...(spec.correlation === false ? { correlation: false } : {}),
    ...(spec.lineType ? { lineType: spec.lineType } : {}),
    ...(spec.theme && spec.theme !== "auto" ? { theme: spec.theme } : {}),
    ...displayOverridesYaml(spec),
    ...(spec.viewStart ? { viewStart: spec.viewStart } : {}),
    ...(spec.viewEnd ? { viewEnd: spec.viewEnd } : {}),
  }, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();
}

export function stringifySpreadSpec(spec: SpreadSpec): string {
  return stringify({
    ...(spec.id ? { id: spec.id } : {}),
    expression: spec.expression,
    series: spec.series,
    range: spec.range,
    ...(spec.title ? { title: spec.title } : {}),
    ...(spec.period && spec.period !== "D" ? { period: spec.period } : {}),
    ...(spec.theme && spec.theme !== "auto" ? { theme: spec.theme } : {}),
    ...(spec.lineWidth != null && spec.lineWidth !== 2 ? { lineWidth: spec.lineWidth } : {}),
    ...(spec.lineColor ? { lineColor: spec.lineColor } : {}),
    ...(spec.lineType ? { lineType: spec.lineType } : {}),
    ...(spec.style ? { style: spec.style } : {}),
    ...displayOverridesYaml(spec),
    ...(spec.viewStart ? { viewStart: spec.viewStart } : {}),
    ...(spec.viewEnd ? { viewEnd: spec.viewEnd } : {}),
  }, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();
}

// title: optional title override for the whole card (chart header,
// watermark, export PNG title/file name).
function seriesTitle(map: Record<string, unknown>): { title?: string } {
  const raw = map["title"];
  if (typeof raw !== "string") return {};
  const title = raw.trim();
  return title ? { title } : {};
}

// Returns the parsed YAML object, or an error message string.
function parseYamlMap(source: string): Record<string, unknown> | string {
  let parsed: unknown;
  try {
    parsed = parse(source.replace(/\r\n?/g, "\n"));
  } catch (e) {
    return t("YAML 解析失败：{msg}", { msg: e instanceof Error ? e.message : String(e) });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return t("代码块必须是一个 YAML 对象。");
  }
  return parsed as Record<string, unknown>;
}

// Validates one series entry; returns the SeriesRef or an error message.
// `scale` is an overlay-only field — spread cards reject it.
function parseSeriesRef(raw: unknown, path: string, allowScale = false): SeriesRef | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return t("{path} 必须是一个 YAML 对象。", { path });
  }
  const map = raw as Record<string, unknown>;
  const unknown = Object.keys(map).filter((key) => !SERIES_REF_KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    return t("{path} 包含未知字段：{keys}", { path, keys: unknown.join(", ") });
  }

  let scaleValue: number | undefined;
  if (map.scale !== undefined && map.scale !== null) {
    if (!allowScale) {
      return t("{path} 不支持 scale 字段（缩放系数仅对比卡可用）。", { path });
    }
    const scale = Number(map.scale);
    if (!Number.isFinite(scale) || scale === 0) {
      return t("{path} 的 scale 无效：{value}（应为非零数字）。", { path, value: String(map.scale) });
    }
    if (scale !== 1) {
      scaleValue = scale;
    }
  }

  const source = String(map.source ?? "").trim() as SeriesSource;
  if (!VALID_SOURCES.includes(source)) {
    return t("{path} 的 source 无效：{value}（应为 quote | card）。", { path, value: String(map.source) });
  }

  const ref: SeriesRef = { source };

  if (source === "card") {
    if (map.profile !== undefined && map.profile !== null && String(map.profile).trim()) {
      return t("{path} 不支持 profile 字段（口径仅对行情系列可用）。", { path });
    }
    // Legacy cardPath refs are recognized only to give a targeted error —
    // they are never resolved. The one-click upgrade (设置 → 高级 →
    // 清理维护) rewrites them; the file path stays in the YAML as a clue.
    if (map.cardPath !== undefined && map.cardPath !== null && String(map.cardPath).trim()) {
      return t("{path} 是旧格式引用（cardPath），已无法解析。请到 设置 → 高级 → 清理维护 运行「扫描并升级卡片引用」，或编辑卡片重新选择系列。", { path });
    }
    const cardId = String(map.cardId ?? "").trim();
    if (!cardId) {
      return t("{path} 缺少有效的 cardId（引用的计算卡 id）。", { path });
    }
    ref.cardId = cardId;
  } else {
    const tsCode = String(map.tsCode ?? "").trim();
    // assetType is always "custom" now; keep reading the field only to reject
    // stale values in hand-written YAML.
    const assetType = String(map.assetType ?? "").trim() as AssetType;
    if (!VALID_ASSET_TYPES.includes(assetType)) {
      return t("{path} 的 assetType 无效：{value}（应为 {valid}）。", { path, value: String(map.assetType), valid: VALID_ASSET_TYPES.join(" | ") });
    }
    // Custom-source codes are free-form: composite "URL部分@映射部分" report
    // codes, endpoint-specific ids — non-empty is the only requirement.
    if (!tsCode) {
      return t("{path} 缺少有效的 tsCode。", { path });
    }
    ref.tsCode = tsCode;
    ref.assetType = assetType;
    const sourceId = String(map.sourceId ?? "").trim();
    if (!sourceId) {
      return t("{path} 缺少有效的 sourceId（自定义数据源 id）。", { path });
    }
    ref.sourceId = sourceId;
    if (map.profile !== undefined && map.profile !== null) {
      const profile = String(map.profile).trim();
      if (!profile) return t("{path} 的 profile 不能为空。", { path });
      ref.profile = profile;
    }
  }

  const label = String(map.label ?? "").trim();
  if (label) {
    ref.label = label;
  }
  if (scaleValue !== undefined) {
    ref.scale = scaleValue;
  }

  // Value semantics / correlation transform (see SeriesRef): accepted on both
  // quote and card legs — a referenced spread card's output can itself be a
  // yield spread. Only the overlay correlation badge consumes them.
  if (map.kind !== undefined && map.kind !== null) {
    const kind = String(map.kind).trim() as SeriesValueKind;
    if (!SERIES_VALUE_KINDS.includes(kind)) {
      return t("{path} 的 kind 无效：{value}（应为 {valid}）。", { path, value: String(map.kind), valid: SERIES_VALUE_KINDS.join(" | ") });
    }
    ref.kind = kind;
  }
  if (map.corr !== undefined && map.corr !== null) {
    const corr = String(map.corr).trim() as CorrTransform;
    if (!CORR_TRANSFORMS.includes(corr)) {
      return t("{path} 的 corr 无效：{value}（应为 {valid}）。", { path, value: String(map.corr), valid: CORR_TRANSFORMS.join(" | ") });
    }
    ref.corr = corr;
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
    return { error: t("无效的 period：{value}（应为 D | W | M | Q | Y）。", { value: String(raw) }) };
  }
  return value;
}

// Loose YYYY-MM-DD check for the persisted wheel-zoom visible range.
function parseViewDate(raw: unknown, key: string): string | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: t("无效的 {key}：{value}（应为 YYYY-MM-DD）。", { key, value }) };
  }
  return value;
}

// Overlay-only: how the card puts its series on a comparable footing
// (default "percent" — quote lines as % change from the first point).
const VALID_COMPARE_MODES: OverlayCompareMode[] = ["percent", "zscore", "axis", "none"];

function parseNormalize(raw: unknown): OverlayCompareMode | { error: string } {
  if (raw === undefined || raw === null) return "percent";
  const value = String(raw).trim() as OverlayCompareMode;
  if (!VALID_COMPARE_MODES.includes(value)) {
    return { error: t("无效的 normalize：{value}（应为 {valid}）。", { value: String(raw), valid: VALID_COMPARE_MODES.join(" | ") }) };
  }
  return value;
}

const VALID_THEMES: ChartTheme[] = ["auto", "dark", "light"];

function parseTheme(raw: unknown): ChartTheme | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim() as ChartTheme;
  if (!VALID_THEMES.includes(value)) {
    return { error: t("无效的 theme：{value}（应为 auto | dark | light）。", { value: String(raw) }) };
  }
  return value;
}

function parseLineWidth(raw: unknown): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const width = Number(raw);
  // lightweight-charts only accepts 1|2|3|4 (LineWidth).
  if (!Number.isInteger(width) || width < 1 || width > 4) {
    return { error: t("无效的 lineWidth：{value}（应为 1–4 的整数，单位 px）。", { value: String(raw) }) };
  }
  return width;
}

function parseLineColor(raw: unknown): string | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    return { error: t("无效的 lineColor：{value}（应为 #rrggbb）。", { value: String(raw) }) };
  }
  return value;
}

const VALID_LINE_TYPES: SeriesLineType[] = ["simple", "curved", "steps"];

function parseLineType(raw: unknown): SeriesLineType | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim() as SeriesLineType;
  if (!VALID_LINE_TYPES.includes(value)) {
    return { error: t("无效的 lineType：{value}（应为 {valid}）。", { value: String(raw), valid: VALID_LINE_TYPES.join(" | ") }) };
  }
  return value === "simple" ? undefined : value;
}

function parseAutoFlag(raw: unknown, key: string): boolean | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    return { error: t("无效的 {key}：{value}（应为 true 或 false）。", { key, value: String(raw) }) };
  }
  return raw;
}

// Opacity overrides are percents, clamped to 0–100.
function parseOpacity(raw: unknown, key: string): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { error: t("无效的 {key}：{value}（应为 0–100 的数字）。", { key, value: String(raw) }) };
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Per-card display overrides (see DisplayOverrides in types.ts). Every field
// is optional — absent means the card follows the plugin-wide 显示设置.
function parseDisplayOverrides(map: Record<string, unknown>): DisplayOverrides | { error: string } {
  const showLegend = parseAutoFlag(map.showLegend, "showLegend");
  if (typeof showLegend !== "boolean" && showLegend !== undefined) return showLegend;
  const legendFrosted = parseAutoFlag(map.legendFrosted, "legendFrosted");
  if (typeof legendFrosted !== "boolean" && legendFrosted !== undefined) return legendFrosted;
  const legendOpacity = parseOpacity(map.legendOpacity, "legendOpacity");
  if (typeof legendOpacity !== "number" && legendOpacity !== undefined) return legendOpacity;
  const showLatestValue = parseAutoFlag(map.showLatestValue, "showLatestValue");
  if (typeof showLatestValue !== "boolean" && showLatestValue !== undefined) return showLatestValue;
  const showPointMarkers = parseAutoFlag(map.showPointMarkers, "showPointMarkers");
  if (typeof showPointMarkers !== "boolean" && showPointMarkers !== undefined) return showPointMarkers;
  const showGrid = parseAutoFlag(map.showGrid, "showGrid");
  if (typeof showGrid !== "boolean" && showGrid !== undefined) return showGrid;
  const gridOpacity = parseOpacity(map.gridOpacity, "gridOpacity");
  if (typeof gridOpacity !== "number" && gridOpacity !== undefined) return gridOpacity;

  return {
    ...(showLegend !== undefined ? { showLegend } : {}),
    ...(legendFrosted !== undefined ? { legendFrosted } : {}),
    ...(legendOpacity !== undefined ? { legendOpacity } : {}),
    ...(showLatestValue !== undefined ? { showLatestValue } : {}),
    ...(showPointMarkers !== undefined ? { showPointMarkers } : {}),
    ...(showGrid !== undefined ? { showGrid } : {}),
    ...(gridOpacity !== undefined ? { gridOpacity } : {}),
  };
}

// YAML fragment for the overrides that are set (undefined = follow 全局).
function displayOverridesYaml(spec: DisplayOverrides): DisplayOverrides {
  return {
    ...(spec.showLegend !== undefined ? { showLegend: spec.showLegend } : {}),
    ...(spec.legendFrosted !== undefined ? { legendFrosted: spec.legendFrosted } : {}),
    ...(spec.legendOpacity !== undefined ? { legendOpacity: spec.legendOpacity } : {}),
    ...(spec.showLatestValue !== undefined ? { showLatestValue: spec.showLatestValue } : {}),
    ...(spec.showPointMarkers !== undefined ? { showPointMarkers: spec.showPointMarkers } : {}),
    ...(spec.showGrid !== undefined ? { showGrid: spec.showGrid } : {}),
    ...(spec.gridOpacity !== undefined ? { gridOpacity: spec.gridOpacity } : {}),
  };
}
