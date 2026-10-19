import { parse, stringify } from "yaml";
import { cacheAssetKey, type AssetType, type Freq, type IndicatorInstance, type ParsedCardSpec, type PriceLineSpec, type RangePreset, type WidgetType } from "../types";
import { isDateRangeString } from "../utils/date";
import { parseWidgetInput } from "./widget-parser";
import { t } from "../i18n";

const VALID_FREQS: Freq[] = ["D", "W", "M", "Q", "Y"];const VALID_RANGES: RangePreset[] = ["1y", "3y", "5y", "ytd", "max"];
const VALID_WIDGET_TYPES: WidgetType[] = ["iframe", "html"];

export const DEFAULT_CARD_HEIGHT = 400;
export const MIN_CARD_HEIGHT = 200;
export const MAX_CARD_HEIGHT = 1600;

// Strict known-key whitelists: any other YAML key (unknown or removed in a
// past version) is a parse error, so stale/typo'd fields surface instead of
// being silently ignored.
export const QUOTE_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "代码", "数据源", "周期", "范围", "版本", "title",
  "图表类型", "主题", "显示标题", "显示成交量", "对数坐标",
  "可见起点", "可见终点", "indicators", "价位线",
  "高度",
  "显示图例", "图例半透明", "图例透明度", "显示网格", "网格透明度",
]);
export const WIDGET_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "小组件类型", "iframe地址", "小组件HTML", "小组件标题", "代码", "周期", "范围", "版本", "高度",
]);
export const CALENDAR_KNOWN_KEYS: ReadonlySet<string> = new Set(["日历", "月份", "高度"]);

export type CardBlockKind = "quote" | "widget" | "calendar";

export function findUnknownCardKeys(source: string): { kind: CardBlockKind; keys: string[] } | null {
  let parsed: unknown;
  try {
    parsed = parse(normalizeYamlSource(source));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const map = parsed as Record<string, unknown>;
  const isCalendar = extractBoolean(map, "日历") === true || map["月份"] !== undefined;
  const widgetType = extractLiteral(map, "小组件类型", VALID_WIDGET_TYPES);
  const isWidget = Boolean(widgetType || extractString(map, "iframe地址") || extractString(map, "小组件HTML"));
  const kind: CardBlockKind = isCalendar ? "calendar" : isWidget ? "widget" : "quote";
  const known = kind === "calendar" ? CALENDAR_KNOWN_KEYS : kind === "widget" ? WIDGET_KNOWN_KEYS : QUOTE_KNOWN_KEYS;
  const keys = Object.keys(map).filter((key) => !known.has(key));
  return keys.length > 0 ? { kind, keys } : null;
}

function unknownKeysError(map: Record<string, unknown>, known: ReadonlySet<string>): ParseError | null {
  const unknown = Object.keys(map).filter((key) => !known.has(key));
  if (unknown.length === 0) return null;
  return { message: t("卡片配置包含未知或已删除的字段：{keys}", { keys: unknown.join(", ") }) };
}

export interface ParseError {
  message: string;
}

export type ParseResult = { ok: true; spec: ParsedCardSpec } | { ok: false; error: ParseError };

function normalizeYamlSource(source: string): string {
  return source
    .replace(/^\uFEFF/, "") // Strip UTF-8 BOM
    .replace(/\r\n/g, "\n") // Windows CRLF
    .replace(/\r/g, "\n"); // Old Mac CR
}

export function parseCardSpec(source: string, defaults?: Partial<ParsedCardSpec>): ParseResult {
  const normalizedSource = normalizeYamlSource(source);
  let parsed: unknown;
  try {
    parsed = parse(normalizedSource);
  } catch (e) {
    return { ok: false, error: { message: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}` } };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: { message: "Code block must be a YAML mapping." } };
  }

  const map = parsed as Record<string, unknown>;

  const isCalendar = extractBoolean(map, "日历") === true || map["月份"] !== undefined;
  if (isCalendar) {
    return parseCalendarCardSpec(map, defaults);
  }

  const widgetType = extractLiteral(map, "小组件类型", VALID_WIDGET_TYPES);
  const iframeUrl = extractString(map, "iframe地址");
  const widgetHtml = extractString(map, "小组件HTML");
  if (widgetType || iframeUrl || widgetHtml) {
    return parseWidgetCardSpec(map, defaults, widgetType);
  }

  const symbol = extractString(map, "代码");
  if (!symbol) {
    const keys = Object.keys(map).join(", ");
    return { ok: false, error: { message: `Missing required field: 代码. Parsed keys: [${keys}]` } };
  }
  const unknownKeys = unknownKeysError(map, QUOTE_KNOWN_KEYS);
  if (unknownKeys) return { ok: false, error: unknownKeys };
  const title = extractString(map, "title");

  const assetType: AssetType = "custom";
  const sourceId = extractString(map, "数据源") ?? defaults?.sourceId;
  if (!sourceId) {
    return { ok: false, error: { message: "Missing required field: 数据源（自定义数据源 id）。" } };
  }

  const rawFreq = extractString(map, "周期") ?? defaults?.freq ?? "D";
  if (!isFreq(rawFreq)) {
    return { ok: false, error: { message: `Invalid 周期: ${rawFreq}. Must be one of ${VALID_FREQS.join(", ")}.` } };
  }

  const rawRange = extractString(map, "范围") ?? defaults?.range ?? "1y";
  if (!isRangePreset(rawRange) && !isDateRangeString(rawRange)) {
    return { ok: false, error: { message: `Invalid 范围: ${rawRange}. Use yyyy-mm-dd~yyyy-mm-dd or one of ${VALID_RANGES.join(", ")}.` } };
  }

  const version = extractNumber(map, "版本") ?? defaults?.version ?? 1;

  const chartType = extractLiteral(map, "图表类型", ["candlestick", "line"]);
  const theme = extractLiteral(map, "主题", ["auto", "dark", "light"]);
  const showHeader = extractBoolean(map, "显示标题");
  const showVolume = extractBoolean(map, "显示成交量");
  const visibleStart = extractIsoDate(map, "可见起点");
  if (visibleStart instanceof Error) {
    return { ok: false, error: { message: visibleStart.message } };
  }
  const visibleEnd = extractIsoDate(map, "可见终点");
  if (visibleEnd instanceof Error) {
    return { ok: false, error: { message: visibleEnd.message } };
  }
  const logScale = extractBoolean(map, "对数坐标");
  const indicators = extractIndicators(map);
  if (indicators instanceof Error) {
    return { ok: false, error: { message: indicators.message } };
  }
  const priceLines = extractPriceLines(map);
  if (priceLines instanceof Error) {
    return { ok: false, error: { message: priceLines.message } };
  }
  const showLegend = extractBoolean(map, "显示图例");
  const legendFrosted = extractBoolean(map, "图例半透明");
  const legendOpacity = extractOpacity(map, "图例透明度");
  const showGrid = extractBoolean(map, "显示网格");
  const gridOpacity = extractOpacity(map, "网格透明度");
  const height = extractOptionalHeight(map);

  return {
    ok: true,
    spec: {
      symbol,
      title,
      assetType,
      sourceId,
      freq: rawFreq,
      range: rawRange,
      version,
      chartType,
      theme,
      showHeader,
      showVolume,
      visibleStart,
      visibleEnd,
      logScale,
      indicators,
      priceLines,
      showLegend,
      legendFrosted,
      legendOpacity,
      showGrid,
      gridOpacity,
      height,
    },
  };
}

function parseWidgetCardSpec(
  map: Record<string, unknown>,
  defaults?: Partial<ParsedCardSpec>,
  inferredWidgetType?: WidgetType
): ParseResult {
  const unknownKeys = unknownKeysError(map, WIDGET_KNOWN_KEYS);
  if (unknownKeys) return { ok: false, error: unknownKeys };
  if (map["小组件类型"] !== undefined && !inferredWidgetType) {
    return { ok: false, error: { message: "小组件类型 must be iframe or html." } };
  }
  const iframeUrl = extractString(map, "iframe地址");
  const widgetHtml = extractString(map, "小组件HTML");

  if (!iframeUrl && !widgetHtml) {
    return { ok: false, error: { message: "TradingView widget card requires iframe地址 or 小组件HTML." } };
  }
  if (iframeUrl && widgetHtml) {
    return { ok: false, error: { message: "TradingView widget card must contain only one of iframe地址 or 小组件HTML." } };
  }

  const parsedWidget = parseWidgetInput(iframeUrl ?? widgetHtml ?? "");
  if (!parsedWidget) {
    return { ok: false, error: { message: "Only official TradingView HTTPS URLs and widget code are allowed." } };
  }
  const widgetType = inferredWidgetType ?? extractLiteral(map, "小组件类型", VALID_WIDGET_TYPES) ?? parsedWidget.widgetType;
  if (widgetType !== parsedWidget.widgetType) {
    return {
      ok: false,
      error: { message: `小组件类型 must be ${parsedWidget.widgetType} for the supplied TradingView content.` },
    };
  }
  const widgetTitle = extractString(map, "小组件标题");
  const symbol = extractString(map, "代码") ?? widgetTitle ?? "widget";
  const rawFreq = extractString(map, "周期") ?? defaults?.freq ?? "D";
  const rawRange = extractString(map, "范围") ?? defaults?.range ?? "1y";
  const version = extractNumber(map, "版本") ?? defaults?.version ?? 1;
  const height = extractHeight(map, defaults?.height);

  return {
    ok: true,
    spec: {
      contentType: "widget",
      symbol,
      assetType: "custom",
      freq: isFreq(rawFreq) ? rawFreq : "D",
      range: rawRange,
      version,
      height,
      widgetType,
      iframeUrl: parsedWidget.iframeUrl,
      widgetHtml: parsedWidget.widgetHtml,
      widgetTitle,
    },
  };
}

const CALENDAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseCalendarCardSpec(
  map: Record<string, unknown>,
  defaults?: Partial<ParsedCardSpec>
): ParseResult {
  const unknownKeys = unknownKeysError(map, CALENDAR_KNOWN_KEYS);
  if (unknownKeys) return { ok: false, error: unknownKeys };
  const month = extractString(map, "月份");
  if (month && !CALENDAR_MONTH_RE.test(month)) {
    return { ok: false, error: { message: `Invalid 月份: ${month}. Use YYYY-MM.` } };
  }

  return {
    ok: true,
    spec: {
      contentType: "calendar",
      symbol: "calendar",
      assetType: "custom",
      freq: "D",
      range: "1y",
      version: 1,
      height: extractHeight(map, defaults?.height),
      calendarMonth: month,
    },
  };
}

export function canonicalKey(spec: ParsedCardSpec): string {
  if (spec.contentType === "calendar") {
    // A single calendar card is reused globally: it only reflects the
    // daily-notes folder, so duplicates would render the same thing.
    return "calendar";
  }
  if (spec.contentType === "widget" || spec.widgetType) {
    return ["widget", spec.widgetType ?? "iframe", spec.symbol].join("|");
  }
  // range is intentionally NOT part of the key: it resolves to absolute dates
  // (e.g. 2025-07-17~2026-07-17) that shift every day, so each day's insert
  // produced a different key, defeated card reuse and piled up duplicates.
  // cacheAssetKey keeps custom sources from colliding on a shared symbol code.
  return [cacheAssetKey(spec.assetType, spec.sourceId), spec.symbol, spec.freq].join("|");
}

export function stringifyCardSpec(spec: ParsedCardSpec): string {
  if (spec.contentType === "calendar") {
    const obj: Record<string, unknown> = { 日历: true };
    if (spec.calendarMonth) obj.月份 = spec.calendarMonth;
    if (spec.height != null && spec.height !== DEFAULT_CARD_HEIGHT) {
      obj.高度 = spec.height;
    }
    return stringify(obj, { lineWidth: 0, aliasDuplicateObjects: false }).trim();
  }

  if (spec.contentType === "widget" || spec.widgetType) {
    const obj: Record<string, unknown> = {
      小组件类型: spec.widgetType ?? "iframe",
      代码: spec.symbol,
    };
    if (spec.iframeUrl) obj.iframe地址 = spec.iframeUrl;
    if (spec.widgetHtml) obj.小组件HTML = spec.widgetHtml;
    if (spec.widgetTitle) obj.小组件标题 = spec.widgetTitle;
    if (spec.height != null && spec.height !== DEFAULT_CARD_HEIGHT) {
      obj.高度 = spec.height;
    }
    return stringify(obj, { lineWidth: 0, aliasDuplicateObjects: false }).trim();
  }

  const obj: Record<string, unknown> = {
    代码: spec.symbol,
    数据源: spec.sourceId,
    周期: spec.freq,
    范围: spec.range,
    版本: spec.version,
  };
  if (spec.title != null) {
    obj.title = spec.title;
  }
  if (spec.chartType != null) {
    obj.图表类型 = spec.chartType;
  }
  if (spec.theme != null) {
    obj.主题 = spec.theme;
  }
  if (spec.showHeader === false) {
    obj.显示标题 = false;
  }
  if (spec.showVolume === false) {
    obj.显示成交量 = false;
  }
  if (spec.visibleStart != null) {
    obj.可见起点 = spec.visibleStart;
  }
  if (spec.visibleEnd != null) {
    obj.可见终点 = spec.visibleEnd;
  }
  if (spec.logScale === true) {
    obj.对数坐标 = true;
  }
  if (spec.indicators !== undefined) {
    obj.indicators = spec.indicators;
  }
  if (spec.priceLines != null && spec.priceLines.length > 0) {
    obj.价位线 = spec.priceLines.map((line) =>
      line.title == null && line.color == null
        ? line.price
        : {
            价格: line.price,
            ...(line.title ? { 名称: line.title } : {}),
            ...(line.color ? { 颜色: line.color } : {}),
          }
    );
  }
  // Quote cards omit 高度 to follow the containing Canvas node. A value
  // switches the card to a fixed manual chart height.
  if (spec.height != null) {
    obj.高度 = spec.height;
  }
  // Per-card display overrides are written only when set; absent = the card
  // follows the plugin-wide 显示设置.
  if (spec.showLegend != null) {
    obj.显示图例 = spec.showLegend;
  }
  if (spec.legendFrosted != null) {
    obj.图例半透明 = spec.legendFrosted;
  }
  if (spec.legendOpacity != null) {
    obj.图例透明度 = spec.legendOpacity;
  }
  if (spec.showGrid != null) {
    obj.显示网格 = spec.showGrid;
  }
  if (spec.gridOpacity != null) {
    obj.网格透明度 = spec.gridOpacity;
  }
  return stringify(obj, { lineWidth: 0, aliasDuplicateObjects: false }).trim();
}

export function buildCardFrontmatter(spec: ParsedCardSpec): string {
  if (spec.contentType === "calendar") {
    return [
      "---",
      `fc-content-type: calendar`,
      `fc-高度: ${spec.height ?? DEFAULT_CARD_HEIGHT}`,
      `fc-key: ${canonicalKey(spec)}`,
      "---",
    ].join("\n");
  }

  if (spec.contentType === "widget" || spec.widgetType) {
    return [
      "---",
      `fc-代码: ${spec.symbol}`,
      `fc-content-type: widget`,
      `fc-小组件类型: ${spec.widgetType ?? "iframe"}`,
      `fc-高度: ${spec.height ?? DEFAULT_CARD_HEIGHT}`,
      `fc-key: ${canonicalKey(spec)}`,
      "---",
    ].join("\n");
  }

  return [
    "---",
    `fc-代码: ${spec.symbol}`,
    `fc-数据源: ${spec.sourceId}`,
    `fc-周期: ${spec.freq}`,
    `fc-范围: ${spec.range}`,
    `fc-key: ${canonicalKey(spec)}`,
    "---",
  ].join("\n");
}

function extractString(map: Record<string, unknown>, key: string): string | undefined {
  const value = map[key];
  if (typeof value === "string") return value.trim();
  return undefined;
}

function extractNumber(map: Record<string, unknown>, key: string): number | undefined {
  const value = map[key];
  if (typeof value === "number") return value;
  return undefined;
}

function extractBoolean(map: Record<string, unknown>, key: string): boolean | undefined {
  const value = map[key];
  if (typeof value === "boolean") return value;
  return undefined;
}

// indicators: a list of indicator instances, each a {id, inputs?, hidden?, group?}
// map. id is the indicator registry id; inputs are parameter overrides
// (values pass through unvalidated); hidden: true keeps the instance but
// skips drawing it. An empty list is meaningful — explicitly no indicators,
// overriding the global default.
function extractIndicators(map: Record<string, unknown>): IndicatorInstance[] | Error | undefined {
  const raw = map["indicators"];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    return new Error("Invalid indicators: 应为指标实例列表（每项为 {id, inputs?} 对象）。");
  }
  const indicators: IndicatorInstance[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return new Error(`indicators[${i}] 必须是一个 YAML 对象。`);
    }
    const m = entry as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id.trim() : "";
    if (!id) {
      return new Error(`indicators[${i}] 缺少有效的 id。`);
    }
    const inputs = m.inputs;
    if (inputs !== undefined && (inputs === null || typeof inputs !== "object" || Array.isArray(inputs))) {
      return new Error(`indicators[${i}] 的 inputs 必须是对象。`);
    }
    if (m.hidden !== undefined && typeof m.hidden !== "boolean") {
      return new Error(`indicators[${i}] 的 hidden 必须是布尔值。`);
    }
    if (m.group !== undefined && (typeof m.group !== "string" || !m.group.trim())) {
      return new Error(`indicators[${i}] 的 group 必须是非空字符串。`);
    }
    indicators.push({
      id,
      ...(inputs !== undefined ? { inputs: inputs as Record<string, unknown> } : {}),
      ...(m.hidden === true ? { hidden: true } : {}),
      ...(typeof m.group === "string" && m.group.trim() ? { group: m.group.trim() } : {}),
    });
  }
  return indicators;
}

// 价位线: a list of entries, each either a bare price number or a
// {价格, 名称?, 颜色?} map (成本线/关注价位 horizontal reference lines).
function extractPriceLines(map: Record<string, unknown>): PriceLineSpec[] | Error | undefined {
  const raw = map["价位线"];
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (!Array.isArray(raw)) {
    return new Error("Invalid 价位线: 应为价格数字或 {价格, 名称, 颜色} 映射的列表。");
  }
  const lines: PriceLineSpec[] = [];
  for (const item of raw) {
    if (typeof item === "number" && Number.isFinite(item)) {
      lines.push({ price: item });
      continue;
    }
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const m = item as Record<string, unknown>;
      const price = Number(m["价格"]);
      if (!Number.isFinite(price)) {
        return new Error("Invalid 价位线: 缺少有效的 价格 数值。");
      }
      const title = String(m["名称"] ?? "").trim();
      const color = String(m["颜色"] ?? "").trim();
      lines.push({ price, ...(title ? { title } : {}), ...(color ? { color } : {}) });
      continue;
    }
    return new Error("Invalid 价位线: 条目应为价格数字或 {价格, 名称, 颜色} 映射。");
  }
  return lines.length > 0 ? lines : undefined;
}

function extractLiteral<T extends string>(
  map: Record<string, unknown>,
  key: string,
  valid: readonly T[]
): T | undefined {
  const raw = extractString(map, key);
  if (!raw) return undefined;
  return valid.includes(raw as T) ? (raw as T) : undefined;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Loose YYYY-MM-DD extraction: absent → undefined, malformed → Error.
function extractIsoDate(map: Record<string, unknown>, key: string): string | undefined | Error {
  const raw = extractString(map, key);
  if (!raw) return undefined;
  if (!ISO_DATE_RE.test(raw)) {
    return new Error(`Invalid ${key}: ${raw}. Use YYYY-MM-DD.`);
  }
  return raw;
}

function extractHeight(map: Record<string, unknown>, defaultValue?: number): number {
  const raw = extractNumber(map, "高度");
  const value = raw ?? defaultValue ?? DEFAULT_CARD_HEIGHT;
  if (!Number.isFinite(value)) return DEFAULT_CARD_HEIGHT;
  return Math.max(MIN_CARD_HEIGHT, Math.min(MAX_CARD_HEIGHT, value));
}

function extractOptionalHeight(map: Record<string, unknown>): number | undefined {
  const raw = extractNumber(map, "高度");
  if (raw == null || !Number.isFinite(raw)) return undefined;
  return Math.max(MIN_CARD_HEIGHT, Math.min(MAX_CARD_HEIGHT, Math.round(raw)));
}

// Display-override opacities are percents, clamped to 0–100.
function extractOpacity(map: Record<string, unknown>, key: string): number | undefined {
  const raw = extractNumber(map, key);
  if (raw == null || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function isFreq(value: string): value is Freq {
  return VALID_FREQS.includes(value as Freq);
}

function isRangePreset(value: string): value is RangePreset {
  return VALID_RANGES.includes(value as RangePreset);
}
