export type AssetType =
  | "stock"
  | "fund"
  | "index"
  | "nhindex"
  | "hk"
  | "gbindex"
  | "cb"
  | "fut"
  | "fx"
  | "sw"
  | "tx"
  | "em";

// Chinese display labels for asset types, used in UI (search results, Notices).
// tx/em are the token-free sources (腾讯自选股 / 东方财富 public endpoints);
// their tsCode is the source's native quote code (sh600519 / 1.600519 …).
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  stock: "股票",
  fund: "基金",
  index: "指数",
  nhindex: "南华指数",
  hk: "港股",
  gbindex: "全球指数",
  cb: "可转债",
  fut: "期货",
  fx: "外汇",
  sw: "申万行业",
  tx: "腾讯行情",
  em: "东方财富",
};

// Minimum Tushare points required to pull each asset type's quotes (per
// tushare.pro 关于权限 doc; "起" = higher tiers add rate limits only).
// stock daily is 120 but weekly/monthly are 2000, hence "120起".
// hk: hk_basic needs 2000; hk_daily is a separately granted permission
// (like yc_cb), not a points tier — noted in the settings tab.
// tx/em are token-free public endpoints — no points involved.
export const ASSET_TYPE_MIN_POINTS: Record<AssetType, string> = {
  stock: "120起",
  fund: "2000",
  index: "2000起",
  nhindex: "2000",
  hk: "2000",
  gbindex: "6000",
  cb: "2000",
  fut: "2000",
  fx: "2000",
  sw: "2000",
  tx: "免费",
  em: "免费",
};
// All valid asset types, in UI display order; the single source of truth for
// spec validators (card-spec.ts, series-spec.ts) and picker dropdowns.
export const ASSET_TYPES: AssetType[] = [
  "stock",
  "fund",
  "index",
  "nhindex",
  "hk",
  "gbindex",
  "cb",
  "fut",
  "fx",
  "sw",
  "tx",
  "em",
];

export type Freq = "D" | "W" | "M";
export type RangePreset = "1y" | "3y" | "5y" | "10y" | "20y" | "ytd" | "max";
export type ChartTheme = "auto" | "dark" | "light";
export type ChartType = "candlestick" | "line";
// The toolbar is a full-height vertical bar, so position only picks the side.
export type ToolbarPosition = "left" | "right";
// Toolbar buttons show an icon (with tooltip) or a plain text label.
export type ToolbarStyle = "icon" | "text";
// Sources with a top-level toolbar button/menu, each toggleable in settings.
export type ToolbarSourceId = "tushare" | "tencent" | "eastmoney" | "fred" | "tradingview";
// Reorderable top-level toolbar entries: the five sources plus the three
// cross-source tools. 全部刷新/设置 are pinned to the bottom, not reorderable.
export type ToolbarEntryId = ToolbarSourceId | "overlay" | "spread" | "components";
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
  showVolume?: boolean; // default true: 成交量副图 pane（卡片级可关）
  visibleRange?: VisibleRangePreset;
  visibleStart?: string;  // YYYY-MM-DD, persisted chart-mode zoom/pan range
  visibleEnd?: string;    // YYYY-MM-DD (takes precedence over visibleRange)
  logScale?: boolean;
  maPeriods?: number[]; // moving-average periods, e.g. [5, 10, 20, 60]
  widthAuto?: boolean;  // canvas only: card width follows the node (default true; false freezes the first-layout width)
  heightAuto?: boolean; // canvas only: card height follows the node (default true; false = fixed 高度)
  bleed?: number;       // canvas only: px gap between card content and node edge (default DEFAULT_CARD_BLEED)
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

// ==================== Series (overlay / spread cards) ====================

export type SeriesSource = "quote" | "macro" | "fred" | "card";

// Resampling period for series cards: daily / monthly / quarterly / yearly.
export type SeriesPeriod = "D" | "M" | "Q" | "Y";

export interface SeriesRef {
  source: SeriesSource;
  tsCode?: string;        // quote only, e.g. "600519.SH"
  assetType?: AssetType;  // quote only
  seriesId?: string;      // macro: a MACRO_SERIES_OPTIONS id like "m1_yoy" / "cpi_yoy"; fred: e.g. "DGS10"
  cardPath?: string;      // card only: vault-relative path of the referenced spread card .md
  label?: string;         // optional display name override
  units?: string;         // fred only: FRED "units" metadata (e.g. "Percent"), used to tell percent series apart
  transform?: FredTransform; // fred only: server-side units transformation; absent = 原始值 (lin)
}

// FRED server-side units transformations (the `units` param of
// /fred/series/observations). "lin" (levels) is the API default and is
// represented by an absent transform, never stored in a spec.
export type FredTransform = "chg" | "ch1" | "pch" | "pc1" | "pca" | "cch" | "cca" | "log";

export const FRED_TRANSFORM_OPTIONS: { value: FredTransform; label: string }[] = [
  { value: "chg", label: "变动量（Change）" },
  { value: "ch1", label: "同比变动量（Change from Year Ago）" },
  { value: "pch", label: "环比增速 %（Percent Change）" },
  { value: "pc1", label: "同比增速 %（Percent Change from Year Ago）" },
  { value: "pca", label: "年化增速 %（Compounded Annual Rate）" },
  { value: "cch", label: "对数变动率（Continuously Compounded Rate）" },
  { value: "cca", label: "对数年化增速（Continuously Compounded Annual Rate）" },
  { value: "log", label: "自然对数（Natural Log）" },
];

// Short Chinese label for card chrome (the full option labels carry an
// English explanation in parentheses, too long for a header line).
export function fredTransformLabel(transform: FredTransform): string {
  const label = FRED_TRANSFORM_OPTIONS.find((o) => o.value === transform)?.label;
  return label ? label.split("（")[0].trim() : transform;
}

// Percent transforms output percentage values regardless of the series' raw
// units. Returns undefined when no transform is set, so callers can fall
// back to the units-metadata heuristic.
export function fredTransformIsPercent(transform?: FredTransform): boolean | undefined {
  if (!transform) return undefined;
  return transform === "pch" || transform === "pc1" || transform === "pca" || transform === "cch" || transform === "cca";
}

// One FRED series search result (subset of /fred/series/search fields), used
// by the FRED search modal and carried into card specs.
export interface FredSeriesInfo {
  id: string;
  title: string;
  frequency: string;
  units: string;
  popularity: number;
  seasonalAdjustment?: string;
}

export interface SeriesPoint {
  date: string;  // YYYY-MM-DD
  value: number;
}

export interface OverlaySpec {
  series: SeriesRef[];
  range: string;   // RangePreset
  period?: SeriesPeriod;  // default "D"
  normalize?: boolean;    // default true: quote lines plotted as % change from the first point
  height?: number;
  theme?: ChartTheme;     // default "auto" (follow Obsidian)
  widthAuto?: boolean;    // canvas only, default true
  heightAuto?: boolean;   // canvas only, default true
  bleed?: number;         // canvas only, default DEFAULT_CARD_BLEED
  viewStart?: string;  // YYYY-MM-DD, persisted wheel-zoom visible range
  viewEnd?: string;    // YYYY-MM-DD
}

// 数据计算卡 (formerly 差值计算卡): an arithmetic expression over lettered
// series — series[0] is A, series[1] is B, … (e.g. "A-B", "(A+B)/2").
// Legacy two-leg cards (`a:`/`b:` in YAML) migrate to series + "A-B" at
// parse time (see series-spec.ts).
export interface SpreadSpec {
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

// Standalone FRED card (```fred block): a single FRED series with a
// tushare-asset-card-like presentation. label/units/frequency come from the
// search result; viewStart/viewEnd are the persisted wheel-zoom range.
export interface FredCardSpec {
  seriesId: string;      // e.g. "DGS10"
  label?: string;        // display name (English FRED title)
  units?: string;        // FRED units metadata, e.g. "Percent"
  frequency?: string;    // FRED frequency metadata, e.g. "Daily"
  transform?: FredTransform; // server-side units transformation; absent = 原始值 (lin)
  range: string;         // RangePreset or YYYY-MM-DD~YYYY-MM-DD
  period?: SeriesPeriod; // default "D"
  height?: number;
  viewStart?: string;    // YYYY-MM-DD
  viewEnd?: string;      // YYYY-MM-DD
}

// Standalone macro card (```macro block): a single Tushare China-macro
// series (one MACRO_SERIES_OPTIONS entry) with the same standalone-card
// presentation as the FRED card. Display name/unit come from the catalog,
// so the spec only carries the id; viewStart/viewEnd are the persisted
// wheel-zoom range.
export interface MacroCardSpec {
  seriesId: string;      // a MACRO_SERIES_OPTIONS id, e.g. "cpi_yoy"
  range: string;         // RangePreset or YYYY-MM-DD~YYYY-MM-DD
  period?: SeriesPeriod; // default "D"
  height?: number;
  viewStart?: string;    // YYYY-MM-DD
  viewEnd?: string;      // YYYY-MM-DD
}

// One selectable Tushare macro series. `id` is the seriesId stored in card
// YAML (cn_m entries keep their raw field names — existing cards reference
// them); `api`/`field` say which Tushare endpoint and column feed it.
export interface MacroSeriesDef {
  id: string;
  label: string;      // Chinese label for the UI dropdown and chart legend
  api: string;        // Tushare api_name, e.g. "cn_m"
  field: string;      // column in the API response (matched case-insensitively)
  freq: "D" | "M" | "Q"; // publication frequency (staleness check + date bucketing)
  group: string;      // UI optgroup label
  kind: "money" | "percent" | "index";
  // Minimum Tushare points needed to call the API; "special" = a separately
  // granted permission (yc_cb, contact Tushare admins), not a points tier.
  points: number | "special";
  // money only: raw-value → 万亿元 divisor (10000 for 亿元-denominated
  // fields; 1 for sf_month's already-万亿元 stk_endval).
  divisor?: number;
  // Extra request params for APIs whose rows are keyed by more than a date
  // (yc_cb: ts_code/curve_type/curve_term select one curve tenor).
  params?: Record<string, string>;
}

// The macro series offered in the UI. Fetching one series of an API pulls the
// API's full table once and caches every cataloged field of it (yc_cb
// excepted: it is fetched per tenor, see data-adapter). `points` follows the
// official 关于权限 table (https://tushare.pro/document/1?doc_id=108).
export const MACRO_SERIES_OPTIONS: MacroSeriesDef[] = [
  // 货币供应 (cn_m, 月度, 600积分)
  { id: "m0_yoy", label: "M0 同比", api: "cn_m", field: "m0_yoy", freq: "M", group: "货币供应", kind: "percent", points: 600 },
  { id: "m0_mom", label: "M0 环比", api: "cn_m", field: "m0_mom", freq: "M", group: "货币供应", kind: "percent", points: 600 },
  { id: "m0", label: "M0 余额", api: "cn_m", field: "m0", freq: "M", group: "货币供应", kind: "money", points: 600, divisor: 10000 },
  { id: "m1_yoy", label: "M1 同比", api: "cn_m", field: "m1_yoy", freq: "M", group: "货币供应", kind: "percent", points: 600 },
  { id: "m1_mom", label: "M1 环比", api: "cn_m", field: "m1_mom", freq: "M", group: "货币供应", kind: "percent", points: 600 },
  { id: "m1", label: "M1 余额", api: "cn_m", field: "m1", freq: "M", group: "货币供应", kind: "money", points: 600, divisor: 10000 },
  { id: "m2_yoy", label: "M2 同比", api: "cn_m", field: "m2_yoy", freq: "M", group: "货币供应", kind: "percent", points: 600 },
  { id: "m2_mom", label: "M2 环比", api: "cn_m", field: "m2_mom", freq: "M", group: "货币供应", kind: "percent", points: 600 },
  { id: "m2", label: "M2 余额", api: "cn_m", field: "m2", freq: "M", group: "货币供应", kind: "money", points: 600, divisor: 10000 },
  // 物价 (cn_cpi / cn_ppi, 月度, 600积分; nt_* = 全国口径; Tushare 无核心CPI)
  { id: "cpi_yoy", label: "CPI 同比", api: "cn_cpi", field: "nt_yoy", freq: "M", group: "物价", kind: "percent", points: 600 },
  { id: "cpi_mom", label: "CPI 环比", api: "cn_cpi", field: "nt_mom", freq: "M", group: "物价", kind: "percent", points: 600 },
  { id: "ppi_yoy", label: "PPI 同比", api: "cn_ppi", field: "ppi_yoy", freq: "M", group: "物价", kind: "percent", points: 600 },
  { id: "ppi_mom", label: "PPI 环比", api: "cn_ppi", field: "ppi_mom", freq: "M", group: "物价", kind: "percent", points: 600 },
  // 景气 (cn_pmi, 月度, 5000积分)
  { id: "pmi", label: "制造业 PMI", api: "cn_pmi", field: "PMI010000", freq: "M", group: "景气", kind: "index", points: 5000 },
  { id: "pmi_prod", label: "制造业PMI: 生产", api: "cn_pmi", field: "pmi010400", freq: "M", group: "景气", kind: "index", points: 5000 },
  { id: "pmi_order", label: "制造业PMI: 新订单", api: "cn_pmi", field: "pmi010500", freq: "M", group: "景气", kind: "index", points: 5000 },
  { id: "pmi_emp", label: "制造业PMI: 从业人员", api: "cn_pmi", field: "pmi010800", freq: "M", group: "景气", kind: "index", points: 5000 },
  { id: "pmi_export", label: "制造业PMI: 新出口订单", api: "cn_pmi", field: "pmi010900", freq: "M", group: "景气", kind: "index", points: 5000 },
  { id: "pmi_price_in", label: "制造业PMI: 主要原材料购进价格", api: "cn_pmi", field: "pmi011200", freq: "M", group: "景气", kind: "index", points: 5000 },
  { id: "pmi_price_out", label: "制造业PMI: 出厂价格", api: "cn_pmi", field: "pmi011300", freq: "M", group: "景气", kind: "index", points: 5000 },
  { id: "pmi_nm", label: "非制造业商务活动指数", api: "cn_pmi", field: "PMI020100", freq: "M", group: "景气", kind: "index", points: 5000 },
  { id: "pmi_nm_order", label: "非制造业PMI: 新订单", api: "cn_pmi", field: "pmi020200", freq: "M", group: "景气", kind: "index", points: 5000 },
  { id: "pmi_comp", label: "综合 PMI 产出指数", api: "cn_pmi", field: "PMI030000", freq: "M", group: "景气", kind: "index", points: 5000 },
  // GDP (cn_gdp, 季度, 600积分)
  { id: "gdp_yoy", label: "GDP 当季同比", api: "cn_gdp", field: "gdp_yoy", freq: "Q", group: "GDP", kind: "percent", points: 600 },
  { id: "gdp", label: "GDP 当季值", api: "cn_gdp", field: "gdp", freq: "Q", group: "GDP", kind: "money", points: 600, divisor: 10000 },
  { id: "gdp_pi_yoy", label: "第一产业增加值同比", api: "cn_gdp", field: "pi_yoy", freq: "Q", group: "GDP", kind: "percent", points: 600 },
  { id: "gdp_si_yoy", label: "第二产业增加值同比", api: "cn_gdp", field: "si_yoy", freq: "Q", group: "GDP", kind: "percent", points: 600 },
  { id: "gdp_ti_yoy", label: "第三产业增加值同比", api: "cn_gdp", field: "ti_yoy", freq: "Q", group: "GDP", kind: "percent", points: 600 },
  // 社融 (sf_month, 月度, 2000积分; 增量为亿元, 存量已为万亿元)
  { id: "sf_inc", label: "社融 当月新增", api: "sf_month", field: "inc_month", freq: "M", group: "社融", kind: "money", points: 2000, divisor: 10000 },
  { id: "sf_inc_cum", label: "社融 累计新增", api: "sf_month", field: "inc_cumval", freq: "M", group: "社融", kind: "money", points: 2000, divisor: 10000 },
  { id: "sf_stk", label: "社融 存量", api: "sf_month", field: "stk_endval", freq: "M", group: "社融", kind: "money", points: 2000, divisor: 1 },
  // 利率 (shibor_lpr, 月度, 120积分)
  { id: "lpr_1y", label: "LPR 1年期", api: "shibor_lpr", field: "1y", freq: "M", group: "利率", kind: "percent", points: 120 },
  { id: "lpr_5y", label: "LPR 5年期以上", api: "shibor_lpr", field: "5y", freq: "M", group: "利率", kind: "percent", points: 120 },
  // 国债收益率 (yc_cb, 日频, 单独权限 — 需联系 Tushare 管理员开通;
  // 中债国债到期收益率曲线, curve_term 单位: 年)
  { id: "cgb_1y", label: "中债国债到期收益率 1年", api: "yc_cb", field: "yield", freq: "D", group: "国债收益率", kind: "percent", points: "special", params: { ts_code: "1001.CB", curve_type: "0", curve_term: "1" } },
  { id: "cgb_2y", label: "中债国债到期收益率 2年", api: "yc_cb", field: "yield", freq: "D", group: "国债收益率", kind: "percent", points: "special", params: { ts_code: "1001.CB", curve_type: "0", curve_term: "2" } },
  { id: "cgb_10y", label: "中债国债到期收益率 10年", api: "yc_cb", field: "yield", freq: "D", group: "国债收益率", kind: "percent", points: "special", params: { ts_code: "1001.CB", curve_type: "0", curve_term: "10" } },
  { id: "cgb_30y", label: "中债国债到期收益率 30年", api: "yc_cb", field: "yield", freq: "D", group: "国债收益率", kind: "percent", points: "special", params: { ts_code: "1001.CB", curve_type: "0", curve_term: "30" } },
];

export function findMacroSeriesDef(id: string): MacroSeriesDef | undefined {
  return MACRO_SERIES_OPTIONS.find((o) => o.id === id);
}
