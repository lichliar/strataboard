import * as yaml from "js-yaml";
import type { AssetType, Freq, ParsedCardSpec, RangePreset, VisibleRangePreset, WidgetType } from "../types";
import { isDateRangeString } from "../utils/date";

const VALID_ASSET_TYPES: AssetType[] = ["stock", "fund", "index"];
const VALID_FREQS: Freq[] = ["D", "W", "M"];
const VALID_RANGES: RangePreset[] = ["1y", "3y", "5y", "ytd", "max"];
const VALID_VISIBLE_RANGES: VisibleRangePreset[] = ["1m", "3m", "6m", "1y", "ytd", "max"];
const VALID_WIDGET_TYPES: WidgetType[] = ["iframe", "html"];

export const DEFAULT_CARD_HEIGHT = 400;
export const MIN_CARD_HEIGHT = 200;
export const MAX_CARD_HEIGHT = 1600;

export interface ParseError {
  message: string;
}

export type ParseResult = { ok: true; spec: ParsedCardSpec } | { ok: false; error: ParseError };

function normalizeYamlSource(source: string): string {
  return source
    .replace(/^﻿/, "") // Strip UTF-8 BOM
    .replace(/\r\n/g, "\n") // Windows CRLF
    .replace(/\r/g, "\n"); // Old Mac CR
}

export function parseCardSpec(source: string, defaults?: Partial<ParsedCardSpec>): ParseResult {
  const normalizedSource = normalizeYamlSource(source);
  let parsed: unknown;
  try {
    parsed = yaml.load(normalizedSource);
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
    return parseWidgetCardSpec(map, defaults, widgetType ?? "iframe");
  }

  const symbol = extractString(map, "代码");
  if (!symbol) {
    const keys = Object.keys(map).join(", ");
    return { ok: false, error: { message: `Missing required field: 代码. Parsed keys: [${keys}]` } };
  }

  const rawType = extractString(map, "类型") ?? defaults?.assetType ?? "stock";
  if (!isAssetType(rawType)) {
    return { ok: false, error: { message: `Invalid 类型: ${rawType}. Must be one of ${VALID_ASSET_TYPES.join(", ")}.` } };
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
  const height = extractHeight(map, defaults?.height);

  const paneRatios = extractPositiveNumberArray(map, "面板比例");
  const chartType = extractLiteral(map, "图表类型", ["candlestick", "line"]);
  const theme = extractLiteral(map, "主题", ["auto", "dark", "light"]);
  const riseColor = extractString(map, "涨色");
  const fallColor = extractString(map, "跌色");
  const showHeader = extractBoolean(map, "显示标题");
  const showMarketData = extractBoolean(map, "显示市场数据");
  const visibleRange = extractLiteral(map, "可见范围", VALID_VISIBLE_RANGES);
  const logScale = extractBoolean(map, "对数坐标");
  const headerCollapsed = extractBoolean(map, "标题折叠");

  return {
    ok: true,
    spec: {
      symbol,
      assetType: rawType,
      freq: rawFreq,
      range: rawRange,
      version,
      height,
      paneRatios,
      chartType,
      theme,
      riseColor,
      fallColor,
      showHeader,
      showMarketData,
      visibleRange,
      logScale,
      headerCollapsed,
    },
  };
}

function parseWidgetCardSpec(
  map: Record<string, unknown>,
  defaults?: Partial<ParsedCardSpec>,
  inferredWidgetType?: WidgetType
): ParseResult {
  const iframeUrl = extractString(map, "iframe地址");
  const widgetHtml = extractString(map, "小组件HTML");

  if (!iframeUrl && !widgetHtml) {
    return { ok: false, error: { message: "Widget card requires iframe地址 or 小组件HTML." } };
  }

  const widgetType = inferredWidgetType ?? extractLiteral(map, "小组件类型", VALID_WIDGET_TYPES) ?? "iframe";
  const widgetTitle = extractString(map, "小组件标题");
  const symbol = extractString(map, "代码") ?? widgetTitle ?? "widget";
  const rawType = extractString(map, "类型") ?? defaults?.assetType ?? "stock";
  const rawFreq = extractString(map, "周期") ?? defaults?.freq ?? "D";
  const rawRange = extractString(map, "范围") ?? defaults?.range ?? "1y";
  const version = extractNumber(map, "版本") ?? defaults?.version ?? 1;
  const height = extractHeight(map, defaults?.height);

  return {
    ok: true,
    spec: {
      contentType: "widget",
      symbol,
      assetType: isAssetType(rawType) ? rawType : "stock",
      freq: isFreq(rawFreq) ? rawFreq : "D",
      range: rawRange,
      version,
      height,
      widgetType,
      iframeUrl,
      widgetHtml,
      widgetTitle,
    },
  };
}

const CALENDAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseCalendarCardSpec(
  map: Record<string, unknown>,
  defaults?: Partial<ParsedCardSpec>
): ParseResult {
  const month = extractString(map, "月份");
  if (month && !CALENDAR_MONTH_RE.test(month)) {
    return { ok: false, error: { message: `Invalid 月份: ${month}. Use YYYY-MM.` } };
  }

  return {
    ok: true,
    spec: {
      contentType: "calendar",
      symbol: "calendar",
      assetType: "stock",
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
  return [spec.assetType, spec.symbol, spec.freq].join("|");
}

export function stringifyCardSpec(spec: ParsedCardSpec): string {
  if (spec.contentType === "calendar") {
    const obj: Record<string, unknown> = { 日历: true };
    if (spec.calendarMonth) obj.月份 = spec.calendarMonth;
    if (spec.height != null && spec.height !== DEFAULT_CARD_HEIGHT) {
      obj.高度 = spec.height;
    }
    return yaml.dump(obj, { lineWidth: -1, noRefs: true }).trim();
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
    return yaml.dump(obj, { lineWidth: -1, noRefs: true }).trim();
  }

  const obj: Record<string, unknown> = {
    代码: spec.symbol,
    类型: spec.assetType,
    周期: spec.freq,
    范围: spec.range,
    版本: spec.version,
  };
  if (spec.height != null && spec.height !== DEFAULT_CARD_HEIGHT) {
    obj.高度 = spec.height;
  }
  if (spec.paneRatios != null && spec.paneRatios.length > 0) {
    obj.面板比例 = spec.paneRatios;
  }
  if (spec.chartType != null) {
    obj.图表类型 = spec.chartType;
  }
  if (spec.theme != null) {
    obj.主题 = spec.theme;
  }
  if (spec.riseColor != null) {
    obj.涨色 = spec.riseColor;
  }
  if (spec.fallColor != null) {
    obj.跌色 = spec.fallColor;
  }
  if (spec.showHeader === false) {
    obj.显示标题 = false;
  }
  if (spec.showMarketData === false) {
    obj.显示市场数据 = false;
  }
  if (spec.visibleRange != null) {
    obj.可见范围 = spec.visibleRange;
  }
  if (spec.logScale === true) {
    obj.对数坐标 = true;
  }
  if (spec.headerCollapsed === true) {
    obj.标题折叠 = true;
  }
  return yaml.dump(obj, { lineWidth: -1, noRefs: true }).trim();
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
    `fc-类型: ${spec.assetType}`,
    `fc-周期: ${spec.freq}`,
    `fc-范围: ${spec.range}`,
    `fc-高度: ${spec.height ?? DEFAULT_CARD_HEIGHT}`,
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

function extractLiteral<T extends string>(
  map: Record<string, unknown>,
  key: string,
  valid: readonly T[]
): T | undefined {
  const raw = extractString(map, key);
  if (!raw) return undefined;
  return valid.includes(raw as T) ? (raw as T) : undefined;
}

function extractPositiveNumberArray(
  map: Record<string, unknown>,
  key: string
): number[] | undefined {
  const raw = map[key];
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map((item) => (typeof item === "number" && Number.isFinite(item) && item > 0 ? item : null))
    .filter((item): item is number => item !== null);
  return values.length > 0 ? values : undefined;
}

function extractHeight(map: Record<string, unknown>, defaultValue?: number): number {
  const raw = extractNumber(map, "高度");
  const value = raw ?? defaultValue ?? DEFAULT_CARD_HEIGHT;
  if (!Number.isFinite(value)) return DEFAULT_CARD_HEIGHT;
  return Math.max(MIN_CARD_HEIGHT, Math.min(MAX_CARD_HEIGHT, value));
}

function isAssetType(value: string): value is AssetType {
  return VALID_ASSET_TYPES.includes(value as AssetType);
}

function isFreq(value: string): value is Freq {
  return VALID_FREQS.includes(value as Freq);
}

function isRangePreset(value: string): value is RangePreset {
  return VALID_RANGES.includes(value as RangePreset);
}
