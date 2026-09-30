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

// One extra search endpoint of a custom source, beyond the primary
// searchUrl/searchBodyTemplate pair. A merged source covering several
// interfaces (e.g. one Tushare source spanning stock_basic/index_basic/…)
// hangs one endpoint per search interface; results merge deduped by code.
// url absent = klineUrl; bodyTemplate present = POST, otherwise GET with
// {query} in the URL. A template without {query} means "fetch the whole
// list, filter locally". searchRowsPath/searchCols override the source's
// jsonMap for interfaces whose response shape differs. paginate turns on
// offset pagination for whole-list endpoints that cap rows server-side.
export interface SearchEndpoint {
  url?: string;
  bodyTemplate?: string;
  searchRowsPath?: string;
  searchCols?: JsonSourceMap["searchCols"];
  // Offset pagination: the template must contain an {offset} placeholder;
  // the client loops requests with offset 0, pageSize, 2*pageSize, … until a
  // page returns fewer rows than pageSize or maxPages (default 20) is hit.
  // totalPath (dotted path to a total-count field in the response) enables
  // truncation detection: stopping short of the declared total is reported
  // instead of passing silently.
  paginate?: { pageSize: number; maxPages?: number; totalPath?: string; allowTruncated?: boolean };
  //   ^ allowTruncated: opt out of the validator treating a truncated fetch
  //   (maxPages hit / declared total not reached) as a failure — it stays a
  //   warning. Default: truncation fails validation (data is incomplete).
  // Declared classification: every code this endpoint returns belongs to this
  // profiles tier. Declared beats guessed: it outranks codeRules regex hits in
  // resolveSymbolParams, and persists into the symbol cache on pick so the
  // fetch path uses it without re-deriving the shape.
  profile?: string;
  enabled?: boolean; // absent = true; false skips this endpoint (e.g. an interface you don't need)
}

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
  searches?: SearchEndpoint[];      // additional search endpoints (merged source covering several search interfaces); results merge deduped by code
  klineUrl?: string;                // HTTP formats only: template, {code} {start} {end} (YYYYMMDD) / {endIso} (YYYY-MM-DD) placeholders
  filePath?: string;                // format "csv" only: vault-relative path of the CSV file
  testCode?: string;                // symbol code used by the 检测 connectivity test (kline probe)
  jsonMap?: JsonSourceMap;          // formats "json"/"csv": column mapping (csv rows are objects keyed by header)
  symbols?: SymbolListEntry[];      // static code table: named picks at card time without remote search
  params?: Record<string, string>;  // source-level default template variables for {p.<name>} placeholders; a symbols entry's own params override these per key — this is what keeps searched codes (never in the static table) fetchable when templates use {p.*}
  profiles?: Record<string, Record<string, string>>; // named param sets ("tiers") shared by several symbols: a symbols entry with `profile: "<name>"` merges this set between source-level params and its own params (source-level ← profile ← per-symbol)
  codeRules?: { match: string; profile: string }[]; // code-shape rules for codes NOT in the static symbols table (e.g. picked from remote search): the first rule whose `match` regex hits the code contributes the named profile, merged over source-level params. This is the FALLBACK for codes with no declared classification — a search endpoint's `profile` declaration (persisted into the symbol cache on pick) outranks it.
  searchPaginate?: SearchEndpoint["paginate"]; // pagination for the PRIMARY searchUrl/searchBodyTemplate pair (extra `searches` entries carry their own paginate); same contract as SearchEndpoint.paginate, template needs {offset}
  searchProfile?: string;          // declared profiles tier for codes returned by the PRIMARY search pair (like SearchEndpoint.profile)
  deadCodes?: string[];            // regexes for codes known to be unplottable (the interface serves the class but not these codes, e.g. a delisted family): validate-config skips probing them with a warning instead of failing, and search results mark (not remove) them
  apiKey?: string;                  // secret, stored plaintext in data.json; never sent to AI context; stripped on export. Empty falls back to the first non-empty key in the same group (resolveGroupApiKey)
  apiKeyHeader?: string;            // optional auth header spec: "Name" or "Name: value-template" where the template may contain {apiKey} (e.g. "Authorization: Bearer {apiKey}")
  headers?: Record<string, string>; // static extra headers (values may contain {apiKey}); applied first, apiKeyHeader wins on a name conflict
  method?: "GET" | "POST";          // default GET; POST sends bodyTemplate as the request body
  bodyTemplate?: string;            // POST body; same placeholders as the URL ({code} {start} {end} {startIso} {endIso} {startTs} {endTs} {apiKey} {p.*}); placeholders are NOT URL-encoded in the body (except in "form" encoding)
  bodyEncoding?: "json" | "form";   // POST body encoding, default "json": "form" URL-encodes every placeholder value and sends Content-Type: application/x-www-form-urlencoded (for legacy form-only APIs)
  paginate?: { pageSize: number; maxPages?: number; totalPath?: string; allowTruncated?: boolean };
  //   ^ kline pagination for endpoints that cap one response (e.g. "latest N
  //   bars only"): the kline template must contain an {offset} placeholder;
  //   the client loops offset 0, pageSize, 2*pageSize, … until a page comes
  //   back short or maxPages (default 20) is hit. totalPath (dotted path to a
  //   total-count field in the response) enables truncation detection: when
  //   paging ends short of the declared total, the gap is reported instead of
  //   passing silently — and validate-config fails the probe unless
  //   allowTruncated opts out.
  transport?: "node";               // absent = Obsidian requestUrl; "node" = Node https (HTTP/1.1), for hosts that fail under Electron's HTTP/2 stack (e.g. api.stlouisfed.org)
}

// Whether a source has any server-side search configured (GET searchUrl,
// POST searchBodyTemplate, or extra searches endpoints); sources without one
// fall back to manual code entry backed by the static symbols table.
export function sourceSupportsRemoteSearch(def: CustomSourceDef): boolean {
  return Boolean(def.searchUrl || def.searchBodyTemplate || (def.searches && def.searches.length > 0));
}

// Whole-table search: no search template (primary or extra) carries {query},
// so every endpoint returns its full symbol list and the caller filters
// locally (DataAdapter caches the merged list instead of refetching per
// keystroke).
export function isWholeTableSearchSource(def: CustomSourceDef): boolean {
  if (!sourceSupportsRemoteSearch(def)) return false;
  const templates = [
    def.searchUrl,
    def.searchBodyTemplate,
    ...(def.searches ?? []).flatMap((s) => [s.url, s.bodyTemplate]),
  ];
  return templates.every((t) => !(t ?? "").includes("{query}"));
}

// Query for a search probe/self-check, derived from the source's OWN
// declared symbols instead of a hardcoded A-share code — an English/global
// source (FRED, US stocks, crypto) returns 0 hits for "000001" no matter how
// correct its search mapping is. Composite/market suffixes strip off
// (600519.SH → 600519, LPR_1Y@1y → LPR_1Y); falls back to the first
// symbol's name, then "000001" flagged as defaulted.
export function searchProbeQuery(def: CustomSourceDef): { query: string; defaulted: boolean } {
  const strip = (code: string): string => code.split("@")[0].split(".")[0].trim();
  const candidates: string[] = [];
  if (def.testCode?.trim()) candidates.push(strip(def.testCode));
  for (const s of def.symbols ?? []) {
    if (s.code.trim()) candidates.push(strip(s.code));
  }
  const named = def.symbols?.find((s) => s.name.trim());
  if (named) candidates.push(named.name.trim());
  const query = candidates.find((c) => c.length > 0);
  return query ? { query, defaulted: false } : { query: "000001", defaulted: true };
}

// Runtime credential fallback: a source with an empty apiKey borrows the
// first non-empty apiKey among enabled sources in the same group (one key
// covers a whole platform split into per-endpoint sources). Resolution
// happens at request time only — the borrowed key is never persisted or
// exported. Group names compare trimmed (a stray trailing space in one
// entry must not silently cut it off from the group's key).
export interface ApiKeyResolution {
  key?: string;
  // self = own entry; group = borrowed from a group member; vault/injected
  // = validate-config only (borrowed from a same-name/same-group vault
  // source / passed via --api-key or STRATABOARD_API_KEY); none = missing.
  source: "self" | "group" | "vault" | "injected" | "none";
  donorName?: string; // source === "group"/"vault": name of the entry the key was borrowed from
}

export function resolveApiKeySource(def: CustomSourceDef, all: CustomSourceDef[]): ApiKeyResolution {
  const own = def.apiKey?.trim();
  if (own) return { key: def.apiKey, source: "self" };
  const group = def.group?.trim();
  if (!group) return { source: "none" };
  const donor = all.find((s) => s.id !== def.id && s.enabled && s.group?.trim() === group && s.apiKey?.trim());
  return donor ? { key: donor.apiKey, source: "group", donorName: donor.name } : { source: "none" };
}

export function resolveGroupApiKey(def: CustomSourceDef, all: CustomSourceDef[]): string | undefined {
  return resolveApiKeySource(def, all).key;
}

// Whether any template/header of the source carries an {apiKey} placeholder
// — i.e. the endpoint expects a credential and an empty resolution means a
// likely 401 rather than a keyless API.
export function sourceNeedsApiKey(def: CustomSourceDef): boolean {
  if (def.apiKeyHeader?.includes("{apiKey}")) return true;
  if (def.apiKeyHeader?.trim() && !def.apiKeyHeader.includes(":")) return true; // bare header name = raw key as value
  for (const template of [def.klineUrl, def.bodyTemplate, def.searchUrl, def.searchBodyTemplate]) {
    if (template?.includes("{apiKey}")) return true;
  }
  return Object.values(def.headers ?? {}).some((v) => v.includes("{apiKey}"));
}

// Whitelists for config validation/import: anything outside these in an
// imported entry is almost certainly a misplaced field (the classic mistake:
// searchBodyTemplate nested inside jsonMap). Shared by the CLI validator and
// the settings import path so the two never drift.
export const KNOWN_SOURCE_DEF_KEYS: ReadonlySet<string> = new Set([
  "id", "name", "enabled", "group", "icon", "format", "searchUrl", "searchBodyTemplate",
  "searches", "klineUrl", "filePath", "testCode", "jsonMap", "symbols", "params",
  "profiles", "codeRules", "searchPaginate", "searchProfile", "deadCodes", "apiKey", "apiKeyHeader", "headers", "method", "bodyTemplate",
  "bodyEncoding", "paginate", "transport",
]);
export const KNOWN_JSON_MAP_KEYS: ReadonlySet<string> = new Set([
  "rowsPath", "rowKind", "fieldsPath", "cols", "errorPath", "errorMessagePath",
  "okValues", "percentScale", "searchRowsPath", "searchCols",
]);

// One row of a custom source's static code table (code + display name).
// `params` carries per-symbol template variables: a {p.<name>} placeholder
// in klineUrl/bodyTemplate is filled from this entry's params when that
// symbol is fetched (e.g. Tushare's api_name differs per interface, so one
// source with per-symbol params covers many interfaces instead of one
// source per api_name). `profile` names a param set from the source's
// `profiles` map, applied between source-level params and this entry's own.
export interface SymbolListEntry {
  code: string;
  name: string;
  profile?: string;
  params?: Record<string, string>;
}

// Field mapping for format "json": where the row list lives and how each
// OHLCV column is addressed (array index, object field name, or column name
// resolved against a name list, per rowKind).
export interface JsonSourceMap {
  rowsPath: string;                 // dotted path to the kline rows, e.g. "data.klines"
  rowKind: "array" | "object" | "fields" | "map" | "columns";
  //   array   — rows are arrays, cols are column indexes
  //   object  — rows are objects, cols are field names (dotted paths allowed
  //             for nested fields, e.g. "quote.close")
  //   fields  — rows are arrays, cols are column NAMES resolved against the
  //             name list at fieldsPath (Tushare's data.fields + data.items)
  //   map     — rowsPath points to an OBJECT keyed by date: each entry is one
  //             row, the key fills the "$key" sentinel (write cols.date as
  //             "$key"); scalar values land in "$value"
  //   columns — rowsPath points to an object of PARALLEL arrays: each cols
  //             value is the path of that column's array (relative to
  //             rowsPath), row i = the i-th element of every column; a scalar
  //             instead of an array means a single-row series (snapshot /
  //             single-point endpoints)
  fieldsPath?: string;              // required for rowKind "fields": dotted path to the column-name array, e.g. "data.fields"
  // Column mapping per rowKind. A col value may itself contain {code} —
  // then the mapping half of a composite code "urlCode@mapCode" fills it
  // (the part before "@" fills {code} in URL/body templates, the part after
  // fills {code} here — wide tables like LPR_1Y@1y pick one column as the
  // series). Plain codes without "@" fill both.
  cols: { date: string; open: string; close: string; high: string; low: string; vol: string; amount?: string };
  errorPath?: string;               // business-error indicator path (e.g. "code"); a value other than 0/""/null/undefined means the response is an error
  errorMessagePath?: string;        // error message path (e.g. "msg"), thrown as the error text
  okValues?: (string | number)[];   // optional success whitelist for errorPath (e.g. [200] for APIs where code 200 means success); absent = the falsy rule above
  percentScale?: number;            // divisor for cells with a trailing % (default 1 = keep the printed number; 100 turns "1.5%" into 0.015)
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
  profile?: string;  // classification declared by the search endpoint that returned this code (SearchEndpoint.profile / CustomSourceDef.searchProfile); persisted in the symbol cache on pick, consulted by resolveSymbolParams ahead of codeRules
  dead?: boolean;    // matched the source's deadCodes — known unplottable; marked, never silently removed from results
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
