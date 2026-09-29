export type AssetType = "custom";

// Chinese display labels for asset types, used in UI (search results, Notices).
// "custom" is a user-configured REST source (see CustomSourceDef); its tsCode
// is the source's native quote code and spec.sourceId picks the source.
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  custom: "自定义",
};

// All valid asset types, in UI display order; the single source of truth for
// spec validators (card-spec.ts, series-spec.ts) and picker dropdowns.
export const ASSET_TYPES: AssetType[] = ["custom"];

// ==================== Custom data sources (user-configured REST) ====================

// A user-defined quote source (设置页 → 自定义数据源). The plugin ships no
// URLs — users paste their own endpoint templates, or point format "csv" at a
// vault-local CSV file. `format` selects the parser preset
// (quote-format-parsers.ts for the HTTP formats, csv-quote-client.ts for
// "csv"); "json"/"csv" map columns via jsonMap (cols.close "{code}" = wide
// table, the code picks the column).
export interface CustomSourceDef {
  id: string;                       // stable slug, never changes once created
  name: string;                     // user label: pickers / toolbar / card file names
  enabled: boolean;
  group?: string;                   // source-group label: sources sharing a name collapse into one grouped entry (unified search fans out across members); absent = ungrouped
  icon?: string;                    // optional custom SVG markup shown in the 插入图表 submenu; absent = colored dot from the series palette
  format: "tencent" | "eastmoney" | "json" | "csv";
  searchUrl?: string;               // GET search template, {query} placeholder; empty = no GET search
  searchBodyTemplate?: string;      // POST search body; same placeholders as bodyTemplate plus {query} (raw, not URL-encoded). When set, search goes POST to searchUrl, falling back to klineUrl. A search template WITHOUT {query} means "fetch the whole list, filter locally" (cached in data-adapter).
  klineUrl?: string;                // HTTP formats only: template, {code} {start} {end} (YYYYMMDD) / {endIso} (YYYY-MM-DD) placeholders
  filePath?: string;                // format "csv" only: vault-relative path of the CSV file
  testCode?: string;                // symbol code used by the 检测 connectivity test (kline probe)
  jsonMap?: JsonSourceMap;          // formats "json"/"csv": column mapping (csv rows are objects keyed by header)
  symbols?: SymbolListEntry[];      // static code table: named picks at card time without remote search
  apiKey?: string;                  // secret, stored plaintext in data.json; never sent to AI context; stripped on export
  apiKeyHeader?: string;            // optional auth header spec: "Name" or "Name: value-template" where the template may contain {apiKey} (e.g. "Authorization: Bearer {apiKey}")
  method?: "GET" | "POST";          // default GET; POST sends bodyTemplate as the request body
  bodyTemplate?: string;            // POST body; same {code} {start} {end} {startIso} {endIso} {apiKey} placeholders as the URL, except {apiKey} is NOT URL-encoded in the body
  transport?: "node";               // absent = Obsidian requestUrl; "node" = Node https (HTTP/1.1), for hosts that fail under Electron's HTTP/2 stack (e.g. api.stlouisfed.org)
}

// Whether a source has any server-side search configured (GET searchUrl or
// POST searchBodyTemplate); sources without one fall back to manual code
// entry backed by the static symbols table.
export function sourceSupportsRemoteSearch(def: CustomSourceDef): boolean {
  return Boolean(def.searchUrl || def.searchBodyTemplate);
}

// Whole-table search: neither search template carries {query}, so the
// endpoint returns its full symbol list and the caller filters locally
// (DataAdapter caches the list briefly instead of refetching per keystroke).
export function isWholeTableSearchSource(def: CustomSourceDef): boolean {
  return (
    sourceSupportsRemoteSearch(def) &&
    !(def.searchUrl ?? "").includes("{query}") &&
    !(def.searchBodyTemplate ?? "").includes("{query}")
  );
}

// One row of a custom source's static code table (code + display name).
export interface SymbolListEntry {
  code: string;
  name: string;
}

// Field mapping for format "json": where the row list lives and how each
// OHLCV column is addressed (array index, object field name, or column name
// resolved against a name list, per rowKind).
export interface JsonSourceMap {
  rowsPath: string;                 // dotted path to the kline rows, e.g. "data.klines"
  rowKind: "array" | "object" | "fields";
  //   array  — rows are arrays, cols are column indexes
  //   object — rows are objects, cols are field names
  //   fields — rows are arrays, cols are column NAMES resolved against the
  //            name list at fieldsPath (Tushare's data.fields + data.items)
  fieldsPath?: string;              // required for rowKind "fields": dotted path to the column-name array, e.g. "data.fields"
  cols: { date: string; open: string; close: string; high: string; low: string; vol: string; amount?: string };
  errorPath?: string;               // business-error indicator path (e.g. "code"); a value other than 0/""/null/undefined means the response is an error
  errorMessagePath?: string;        // error message path (e.g. "msg"), thrown as the error text
  searchRowsPath?: string;          // dotted path to the search result list
  searchCols?: { code: string; name: string; market?: string };
}

// Cache key for an asset type: different custom sources may share symbol
// codes (two sources can both have sh600519), so custom data is cached under
// `custom:<sourceId>` instead of the bare "custom".
export function cacheAssetKey(assetType: string, sourceId?: string): string {
  return assetType === "custom" && sourceId ? `custom:${sourceId}` : assetType;
}

export type Freq = "D" | "W" | "M";
export type RangePreset = "1y" | "3y" | "5y" | "10y" | "20y" | "ytd" | "max";
export type ChartTheme = "auto" | "dark" | "light";
export type ChartType = "candlestick" | "line";
// The toolbar is a compact vertical bar anchored to a canvas corner
// (default bottom-left, so it never covers the canvas back button).
export type ToolbarPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
// Toolbar buttons show an icon (with tooltip) or a plain text label.
export type ToolbarStyle = "icon" | "text";
// Sources with a top-level toolbar button, each toggleable in settings.
// Data insert flows all live behind the single 「插入图表」 entry, so only
// TradingView remains a per-source toggle.
export type ToolbarSourceId = "tradingview";
// Reorderable top-level toolbar entries: 「插入图表」, 「数据处理」(overlay +
// spread menu), TradingView, 「组件」. 全部刷新/设置 follow the list, not
// reorderable.
export type ToolbarEntryId = "insert-data" | "data-tools" | "tradingview" | "components";
export type VisibleRangePreset = "1m" | "3m" | "6m" | "1y" | "ytd" | "max";
export type WidgetType = "iframe" | "html";
export type CardContentType = "quote" | "widget" | "calendar";

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
  sourceId?: string; // which CustomSourceDef this symbol came from
}

// Per-card display overrides; undefined = follow the plugin-wide 显示设置.
export interface DisplayOverrides {
  showLegend?: boolean;
  legendFrosted?: boolean;
  legendOpacity?: number;
  showLatestValue?: boolean;
  showPointMarkers?: boolean;
  // K-line cards only: moving-average lines (系列图 cards have no MA).
  showMA?: boolean;
  showGrid?: boolean;
  gridOpacity?: number;
}

export interface ParsedCardSpec {
  contentType?: CardContentType;
  symbol: string;
  assetType: AssetType;
  sourceId?: string; // which CustomSourceDef feeds this card
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
  showVolume?: boolean; // default true: 成交量副图 pane（卡片级可关）
  visibleRange?: VisibleRangePreset;
  visibleStart?: string;  // YYYY-MM-DD, persisted chart-mode zoom/pan range
  visibleEnd?: string;    // YYYY-MM-DD (takes precedence over visibleRange)
  logScale?: boolean;
  maPeriods?: number[]; // moving-average periods, e.g. [5, 10, 20, 60]
  widthAuto?: boolean;  // canvas only: card width follows the node (default true; false freezes the first-layout width)
  heightAuto?: boolean; // canvas only: card height follows the node (default true; false = fixed 高度)
  bleed?: number;       // canvas only: px gap between card content and node edge (default DEFAULT_CARD_BLEED)
  // Per-card display overrides (undefined = follow the plugin-wide 显示设置).
  // The K-line renderer has no latest-value/point-marker options.
  showLegend?: boolean;
  legendFrosted?: boolean;
  legendOpacity?: number; // percent 0-100
  showMA?: boolean;       // 显示均线 override (undefined = follow 全局 showChartMA)
  showGrid?: boolean;
  gridOpacity?: number;   // percent 0-100
  widgetType?: WidgetType;
  iframeUrl?: string;
  widgetHtml?: string;
  widgetTitle?: string;
  calendarMonth?: string; // YYYY-MM, initial month shown by a calendar card
}

// ==================== Series (overlay / spread cards) ====================

export type SeriesSource = "quote" | "card";

// Resampling period for series cards: daily / monthly / quarterly / yearly.
export type SeriesPeriod = "D" | "M" | "Q" | "Y";

export interface SeriesRef {
  source: SeriesSource;
  tsCode?: string;        // quote only, e.g. "600519.SH"
  assetType?: AssetType;  // quote only
  sourceId?: string;      // quote only: which CustomSourceDef feeds it
  cardPath?: string;      // card only: vault-relative path of the referenced card .md (quote/spread block)
  label?: string;         // optional display name override
  scale?: number;         // overlay cards only: visual multiplier applied to the plotted values (default 1)
}

export interface SeriesPoint {
  date: string;  // YYYY-MM-DD
  value: number;
}

// A card file an overlay series can reference (source: "card"), identified by
// its fenced block type. Overlay cards are deliberately not referenceable
// (which of the normalized lines would it resolve to?).
export type ReferenceableCardKind = "quote" | "spread";

export interface ReferenceableCard {
  path: string;  // vault-relative .md path
  name: string;  // file basename (display name)
  kind: ReferenceableCardKind;
}

// How the overlay card puts its series on a comparable footing:
//   percent — quote lines plotted as % change from the first point (default)
//   zscore  — every line standardized to (x − mean) / std over the range
//   axis    — raw values, each line on its own (hidden) price scale
//   none    — raw values on one shared axis
export type OverlayCompareMode = "percent" | "zscore" | "axis" | "none";

export interface OverlaySpec extends DisplayOverrides {
  series: SeriesRef[];
  range: string;   // RangePreset
  period?: SeriesPeriod;  // default "D"
  normalize?: OverlayCompareMode;  // default "percent"
  height?: number;
  theme?: ChartTheme;     // default "auto" (follow Obsidian)
  widthAuto?: boolean;    // canvas only, default true
  heightAuto?: boolean;   // canvas only, default true
  bleed?: number;         // canvas only, default DEFAULT_CARD_BLEED
  viewStart?: string;  // YYYY-MM-DD, persisted wheel-zoom visible range
  viewEnd?: string;    // YYYY-MM-DD
}

// 数据计算卡: an arithmetic expression over lettered series — series[0] is
// A, series[1] is B, … (e.g. "A-B", "(A+B)/2"). Legacy two-leg cards
// (`a:`/`b:` in YAML) migrate to series + "A-B" at parse time (see
// series-spec.ts).
export interface SpreadSpec extends DisplayOverrides {
  series: SeriesRef[];
  expression: string;
  range: string;
  period?: SeriesPeriod;  // default "D"
  height?: number;
  theme?: ChartTheme;     // default "auto" (follow Obsidian)
  lineWidth?: number;     // px, default 2
  lineColor?: string;     // default: first palette color
  widthAuto?: boolean;    // canvas only, default true
  heightAuto?: boolean;   // canvas only, default true
  bleed?: number;         // canvas only, default DEFAULT_CARD_BLEED
  viewStart?: string;  // YYYY-MM-DD, persisted wheel-zoom visible range
  viewEnd?: string;    // YYYY-MM-DD
}
