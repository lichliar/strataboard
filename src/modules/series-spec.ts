import { parse, stringify } from "yaml";
import {
  ASSET_TYPES,
  type AssetType,
  type ChartTheme,
  type DisplayOverrides,
  type OverlayCompareMode,
  type OverlaySpec,
  type SeriesPeriod,
  type SeriesLineType,
  type SeriesRef,
  type SeriesSource,
  type SignalRef,
  type SpreadSpec,
} from "../types";
import { MAX_CARD_BLEED } from "./card-spec";
import { parseExpression } from "./expression";
import { t } from "../i18n";

// Parse/serialize for the overlay (资产叠加) and spread (差值计算) card
// specs. These live outside ParsedCardSpec and are parsed with the `yaml`
// package directly, using English keys.

export interface SeriesSpecParseResult<T> {
  spec?: T;
  error?: string;
}

const VALID_SOURCES: SeriesSource[] = ["quote", "card"];
const VALID_ASSET_TYPES: AssetType[] = ASSET_TYPES;
const VALID_PERIODS: SeriesPeriod[] = ["D", "M", "Q", "Y"];

export const DEFAULT_OVERLAY_SPEC: OverlaySpec = {
  series: [],
  range: "10y",
};

export const DEFAULT_SPREAD_SPEC: SpreadSpec = {
  series: [],
  expression: "",
  range: "10y",
};

// Overlay cards overlay up to this many series on one chart; the line
// palette (SERIES_LINE_COLORS) must stay at least this long so every series
// gets a distinct color.
export const MAX_OVERLAY_SERIES = 10;

export function parseOverlaySpec(source: string): SeriesSpecParseResult<OverlaySpec> {
  const map = parseYamlMap(source);
  if (typeof map === "string") return { error: map };

  if (!Array.isArray(map.series) || map.series.length === 0) {
    return { error: t("缺少必填字段 series（至少需要一个数据系列）。") };
  }
  if (map.series.length > MAX_OVERLAY_SERIES) {
    return { error: t("叠加卡最多支持 {max} 个数据系列。", { max: MAX_OVERLAY_SERIES }) };
  }
  const series: SeriesRef[] = [];
  for (let i = 0; i < map.series.length; i++) {
    const ref = parseSeriesRef(map.series[i], `series[${i}]`, true);
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
  if (typeof normalize !== "string") return normalize;
  const lineType = parseLineType(map.lineType);
  if (typeof lineType === "object") return lineType;
  const theme = parseTheme(map.theme);
  if (typeof theme === "object") return theme;
  const widthAuto = parseAutoFlag(map.widthAuto, "widthAuto");
  if (typeof widthAuto !== "boolean" && widthAuto !== undefined) return widthAuto;
  const heightAuto = parseAutoFlag(map.heightAuto, "heightAuto");
  if (typeof heightAuto !== "boolean" && heightAuto !== undefined) return heightAuto;
  const bleed = parseBleed(map.bleed);
  if (typeof bleed !== "number" && bleed !== undefined) return bleed;
  const display = parseDisplayOverrides(map);
  if ("error" in display) return display;

  return {
    spec: {
      series,
      range,
      period,
      normalize,
      ...(lineType ? { lineType } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(theme ? { theme } : {}),
      ...(widthAuto !== undefined ? { widthAuto } : {}),
      ...(heightAuto !== undefined ? { heightAuto } : {}),
      ...(bleed !== undefined ? { bleed } : {}),
      ...display,
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
  const style = map.style === undefined || map.style === null ? undefined : String(map.style);
  if (style !== undefined && style !== "line" && style !== "baseline" && style !== "area") {
    return { error: t("style 仅支持 line、baseline 或 area。") };
  }
  const lineType = parseLineType(map.lineType);
  if (typeof lineType === "object") return lineType;
  const widthAuto = parseAutoFlag(map.widthAuto, "widthAuto");
  if (typeof widthAuto !== "boolean" && widthAuto !== undefined) return widthAuto;
  const heightAuto = parseAutoFlag(map.heightAuto, "heightAuto");
  if (typeof heightAuto !== "boolean" && heightAuto !== undefined) return heightAuto;
  const bleed = parseBleed(map.bleed);
  if (typeof bleed !== "number" && bleed !== undefined) return bleed;
  const display = parseDisplayOverrides(map);
  if ("error" in display) return display;

  // Missing/invalid ids are NOT card errors: the renderer (and the card
  // listing) write a fresh id back on first sight. Only non-empty strings
  // are carried through.
  const id = String(map.id ?? "").trim();
  const signals = parseSignals(map.signals);
  if (signals && !Array.isArray(signals)) return signals;

  return {
    spec: {
      ...(id ? { id } : {}),
      series,
      expression,
      range,
      ...(signals ? { signals } : {}),
      period,
      ...(height !== undefined ? { height } : {}),
      ...(theme ? { theme } : {}),
      ...(lineWidth !== undefined ? { lineWidth } : {}),
      ...(lineColor ? { lineColor } : {}),
      ...(lineType ? { lineType } : {}),
      ...(style === "baseline" || style === "area" ? { style } : {}),
      ...(widthAuto !== undefined ? { widthAuto } : {}),
      ...(heightAuto !== undefined ? { heightAuto } : {}),
      ...(bleed !== undefined ? { bleed } : {}),
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
    ...(spec.period && spec.period !== "D" ? { period: spec.period } : {}),
    ...(spec.normalize && spec.normalize !== "percent" ? { normalize: spec.normalize } : {}),
    ...(spec.lineType ? { lineType: spec.lineType } : {}),
    ...(spec.height ? { height: spec.height } : {}),
    ...(spec.theme && spec.theme !== "auto" ? { theme: spec.theme } : {}),
    ...(spec.widthAuto === false ? { widthAuto: false } : {}),
    ...(spec.heightAuto === false ? { heightAuto: false } : {}),
    ...(spec.bleed != null && spec.bleed !== 8 ? { bleed: spec.bleed } : {}),
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
    ...(spec.period && spec.period !== "D" ? { period: spec.period } : {}),
    ...(spec.height ? { height: spec.height } : {}),
    ...(spec.theme && spec.theme !== "auto" ? { theme: spec.theme } : {}),
    ...(spec.lineWidth != null && spec.lineWidth !== 2 ? { lineWidth: spec.lineWidth } : {}),
    ...(spec.lineColor ? { lineColor: spec.lineColor } : {}),
    ...(spec.lineType ? { lineType: spec.lineType } : {}),
    ...(spec.style ? { style: spec.style } : {}),
    ...(spec.signals && spec.signals.length > 0 ? { signals: signalsYaml(spec.signals) } : {}),
    ...(spec.widthAuto === false ? { widthAuto: false } : {}),
    ...(spec.heightAuto === false ? { heightAuto: false } : {}),
    ...(spec.bleed != null && spec.bleed !== 8 ? { bleed: spec.bleed } : {}),
    ...displayOverridesYaml(spec),
    ...(spec.viewStart ? { viewStart: spec.viewStart } : {}),
    ...(spec.viewEnd ? { viewEnd: spec.viewEnd } : {}),
  }, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();
}

// signals: a single {source, code} map or a list of them (spread cards only —
// overlay cards dropped 信号标注). code is REQUIRED — spread cards filter
// events by it before merging them onto the single line.
function parseSignals(raw: unknown): SignalRef[] | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const signals: SignalRef[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: t("signals[{i}] 必须是一个 YAML 对象。", { i }) };
    }
    const m = entry as Record<string, unknown>;
    const sourceId = String(m.source ?? "").trim();
    const code = String(m.code ?? "").trim();
    if (!sourceId) {
      return { error: t("signals[{i}] 缺少有效的 source（信号源 id）。", { i }) };
    }
    if (!code) {
      return { error: t("signals[{i}] 缺少有效的 code（信号标注的标的代码）。", { i }) };
    }
    signals.push({ sourceId, code });
  }
  return signals.length > 0 ? signals : undefined;
}

// YAML form uses {source, code} keys (English-key convention of series
// specs), not the internal SignalRef field names.
function signalsYaml(signals: SignalRef[]): { source: string; code?: string }[] {
  return signals.map((s) => ({ source: s.sourceId, ...(s.code ? { code: s.code } : {}) }));
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

  let scaleValue: number | undefined;
  if (map.scale !== undefined && map.scale !== null) {
    if (!allowScale) {
      return t("{path} 不支持 scale 字段（缩放系数仅资产叠加卡可用）。", { path });
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
    // Legacy cardPath refs are recognized only to give a targeted error —
    // they are never resolved. The one-click upgrade (设置 → 路径设置 →
    // 清理维护) rewrites them; the file path stays in the YAML as a clue.
    if (map.cardPath !== undefined && map.cardPath !== null && String(map.cardPath).trim()) {
      return t("{path} 是旧格式引用（cardPath），已无法解析。请到 设置 → 路径设置 → 清理维护 运行「升级卡片引用」，或编辑卡片重新选择系列。", { path });
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
  }

  const label = String(map.label ?? "").trim();
  if (label) {
    ref.label = label;
  }
  if (scaleValue !== undefined) {
    ref.scale = scaleValue;
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
    return { error: t("无效的 period：{value}（应为 D | M | Q | Y）。", { value: String(raw) }) };
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

function parseHeight(raw: unknown): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const height = Number(raw);
  if (!Number.isFinite(height) || height <= 0) {
    return { error: t("无效的 height：{value}（应为正数，单位 px）。", { value: String(raw) }) };
  }
  return height;
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

function parseBleed(raw: unknown): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const bleed = Number(raw);
  if (!Number.isFinite(bleed) || bleed < 0 || bleed > MAX_CARD_BLEED) {
    return { error: t("无效的 bleed：{value}（应为 0–{max}，单位 px）。", { value: String(raw), max: MAX_CARD_BLEED }) };
  }
  return Math.round(bleed);
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
