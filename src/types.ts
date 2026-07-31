export type AssetType = "stock" | "fund" | "index";

// Chinese display labels for asset types, used in UI (search results, Notices).
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  stock: "股票",
  fund: "基金",
  index: "指数",
};
export type Freq = "D" | "W" | "M";
export type RangePreset = "1y" | "3y" | "5y" | "ytd" | "max";
export type ChartTheme = "auto" | "dark" | "light";
export type ChartType = "candlestick" | "line";
export type ToolbarPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type VisibleRangePreset = "1m" | "3m" | "6m" | "1y" | "ytd" | "max";
export type WidgetType = "iframe" | "html";
export type CardContentType = "tushare" | "widget" | "calendar";

export interface OhlcvRow {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  amount: number;
}

export interface SymbolItem {
  tsCode: string;
  symbol: string;
  name: string;
  enname?: string;
  exchange: string;
  listDate?: string;
  assetType: AssetType;
}

export interface MarketData {
  tradeDate: string;
  totalMv?: number; // 总市值（万元）
  circMv?: number; // 流通市值（万元）
  pe?: number; // 市盈率
  peTtm?: number; // 市盈率 TTM
  volumeRatio?: number; // 量比
  turnoverRate?: number; // 换手率（%）
  turnoverRateF?: number; // 换手率（自由流通，%）
  amount?: number; // 成交额（千元）
}

export interface ParsedCardSpec {
  contentType?: CardContentType;
  symbol: string;
  assetType: AssetType;
  freq: Freq;
  range: string;
  version: number;
  height?: number;
  paneRatios?: number[];
  chartType?: ChartType;
  theme?: ChartTheme;
  riseColor?: string;
  fallColor?: string;
  showHeader?: boolean;
  showMarketData?: boolean;
  visibleRange?: VisibleRangePreset;
  logScale?: boolean;
  widgetType?: WidgetType;
  iframeUrl?: string;
  widgetHtml?: string;
  widgetTitle?: string;
  calendarMonth?: string; // YYYY-MM, initial month shown by a calendar card
}

export interface CacheEntry {
  schemaVersion: number;
  symbol: string;
  assetType: AssetType;
  freq: Freq;
  updatedAt: string;
  rows: OhlcvRow[];
}

export interface SymbolCacheEntry {
  schemaVersion: number;
  assetType: AssetType;
  refreshedAt: string;
  items: SymbolItem[];
}

export interface TushareResponse<T = unknown> {
  code: number;
  msg: string;
  data: {
    fields: string[];
    items: T[];
  } | null;
}
