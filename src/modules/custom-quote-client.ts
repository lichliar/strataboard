import { httpRequest } from "./http";
import type { CustomSourceDef, JsonSourceMap, OhlcvRow, SearchEndpoint, SymbolItem } from "../types";
import { searchProbeQuery } from "../types";
import { compileDeadCodes, resolveSymbolParams } from "../utils/symbol-list";
import {
  digPathValue,
  extractApiError,
  parseEastmoneyKline,
  parseEastmoneySearch,
  parseMappedKline,
  parseMappedSearch,
  parseTencentKline,
  parseTencentSearch,
  resolveMapCode,
  splitCompositeCode,
  type KlineParseStats,
} from "./quote-format-parsers";
import { formatDate } from "../utils/date";
import { t } from "../i18n";

// HTTP client for one user-configured custom data source (设置页 → 自定义数据
// 源). The plugin ships no endpoint URLs; both URLs come from the user's
// templates with {query} / {code} / {start} / {end} (YYYYMMDD) / {startIso} /
// {endIso} (YYYY-MM-DD) / {startTs} / {endTs} (epoch seconds) / {apiKey} /
// {p.<name>} (per-symbol params from the matching symbols-table entry)
// placeholders filled per request; apiKeyHeader adds an auth header on top,
// and def.headers lays static headers underneath it. Search is GET
// (searchUrl) or POST (searchBodyTemplate, URL falls back to klineUrl).
// `def.format` picks the response parser preset; "json" maps arbitrary
// payloads via def.jsonMap.

// Tencent-format kline pages top out at ~640 bars; paging goes back at most
// MAX_PAGES pages (~20 years of trading days).
const PAGE_SIZE = 640;
const MAX_PAGES = 8;

// Fetch caveats a search round-trip surfaces to the caller: rows dropped for
// a missing code/name, and a paginated fetch stopped short of the declared
// total / page cap (silent truncation). `allowed` marks an endpoint whose
// paginate config opted out (`allowTruncated: true`) — the validator then
// keeps it a warning instead of failing the search.
export interface SearchFetchStats {
  skipped?: number;
  truncated?: { fetched: number; total?: number; allowed?: boolean };
}

export class CustomQuoteClient {
  constructor(private def: CustomSourceDef) {}

  // Server-side symbol search. A source configures a primary GET searchUrl
  // ({query} placeholder) / POST searchBodyTemplate (same placeholders as
  // bodyTemplate plus {query}) pair, plus optional extra `searches`
  // endpoints for merged sources spanning several search interfaces — all
  // endpoints are queried and their results merge deduped by code (a
  // partially failing fan-out still returns the endpoints that worked).
  // With only a body template the URL falls back to klineUrl. Templates
  // WITHOUT {query} fetch the whole symbol list; the caller filters locally
  // (DataAdapter.searchRemoteQuotes).
  async searchQuotes(query: string, statsOut?: SearchFetchStats): Promise<SymbolItem[]> {
    const endpoints = this.searchEndpoints();
    if (endpoints.length === 0) return [];
    const merged = new Map<string, SymbolItem>();
    let firstError: unknown;
    let skipped = 0;
    for (const endpoint of endpoints) {
      try {
        const stats: SearchFetchStats = {};
        for (const item of await this.searchOne(endpoint, query, stats)) {
          // First endpoint wins by default — but a DECLARED classification
          // (endpoint.profile) outranks an undeclared earlier hit, so the
          // merge result never depends on array order when it matters.
          const existing = merged.get(item.tsCode);
          if (!existing || (!existing.profile && item.profile)) merged.set(item.tsCode, item);
        }
        skipped += stats.skipped ?? 0;
        if (stats.truncated) {
          console.warn(`[StrataBoard] source "${this.def.name}": search looks truncated (${stats.truncated.fetched}${stats.truncated.total ? ` / ${stats.truncated.total}` : ""} rows) — check paginate.pageSize or raise maxPages`);
          // An un-opted-out truncation is the one the validator must see.
          if (statsOut && (!statsOut.truncated || (statsOut.truncated.allowed && !stats.truncated.allowed))) {
            statsOut.truncated = stats.truncated;
          }
        }
      } catch (e) {
        firstError ??= e;
      }
    }
    if (skipped > 0) {
      console.warn(`[StrataBoard] source "${this.def.name}": ${skipped} search row(s) dropped for a missing code or name`);
      if (statsOut) statsOut.skipped = (statsOut.skipped ?? 0) + skipped;
    }
    if (merged.size === 0 && firstError) throw firstError;
    const dead = compileDeadCodes(this.def);
    return [...merged.values()].map((item) => ({
      ...item,
      sourceId: this.def.id,
      // Mark — never remove — codes the source declares known-unplottable.
      ...(dead?.test(splitCompositeCode(item.tsCode).urlCode) ? { dead: true } : {}),
    }));
  }

  // The search endpoints of this source: the primary searchUrl /
  // searchBodyTemplate pair first, then every enabled extra `searches` entry.
  private searchEndpoints(): SearchEndpoint[] {
    const def = this.def;
    const endpoints: SearchEndpoint[] = [];
    const primaryUrl = def.searchUrl ?? (def.searchBodyTemplate ? def.klineUrl : undefined);
    if (primaryUrl) {
      endpoints.push({
        url: primaryUrl,
        bodyTemplate: def.searchBodyTemplate,
        // Source-level searchPaginate/searchProfile apply to the primary
        // pair (extra `searches` entries carry their own).
        ...(def.searchPaginate ? { paginate: def.searchPaginate } : {}),
        ...(def.searchProfile ? { profile: def.searchProfile } : {}),
      });
    }
    for (const s of def.searches ?? []) {
      if (s.enabled === false) continue;
      const url = s.url ?? (s.bodyTemplate ? def.klineUrl : undefined);
      if (url) endpoints.push({ ...s, url });
    }
    return endpoints;
  }

  // One search endpoint round-trip: template fill, request, parse. With
  // `paginate` set (and an {offset} placeholder present) the request loops —
  // offset 0, pageSize, 2*pageSize, … — until a page comes back short or
  // maxPages (default 20) is hit; pages merge deduped by code. stats.skipped
  // accumulates rows dropped for a missing code/name across all pages;
  // stats.truncated reports a fetch stopped short of the declared total
  // (totalPath) or at the page cap.
  private async searchOne(endpoint: SearchEndpoint, query: string, stats?: SearchFetchStats): Promise<SymbolItem[]> {
    const def = this.def;
    const paginate = endpoint.paginate;
    const canPaginate = !!paginate && paginate.pageSize > 0
      && (!!endpoint.url?.includes("{offset}") || !!endpoint.bodyTemplate?.includes("{offset}"));
    const maxPages = paginate?.maxPages ?? 20;
    const map = this.endpointMap(endpoint);
    const items: SymbolItem[] = [];
    const seen = new Set<string>();
    let lastJson: any;
    let hitPageCap = false;
    for (let page = 0; ; page++) {
      const offset = canPaginate ? String(page * paginate!.pageSize) : "";
      const url = fillTemplate(endpoint.url!, templateValues(def, { query: encodeURIComponent(query), offset }));
      const headers = buildRequestHeaders(def);
      // {query} goes into the body raw (URL-encoding would break non-ASCII
      // keywords); {apiKey} stays raw in bodies per the bodyTemplate contract.
      const body = endpoint.bodyTemplate
        ? fillTemplate(endpoint.bodyTemplate, { apiKey: def.apiKey ?? "", query, offset })
        : undefined;
      const response = await httpRequest({
        url,
        method: body !== undefined ? "POST" : "GET",
        ...(headers ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(def.transport ? { transport: def.transport } : {}),
      });
      lastJson = response.json;
      if (def.format === "json" && map) {
        const apiError = extractApiError(response.json, map);
        if (apiError) throw new Error(apiError);
      }
      const pageItems = def.format === "tencent"
        ? parseTencentSearch(response.text)
        : def.format === "eastmoney"
          ? parseEastmoneySearch(response.json)
          : parseMappedSearch(response.json, map, stats);
      for (const item of pageItems) {
        if (!seen.has(item.tsCode)) {
          seen.add(item.tsCode);
          // The endpoint's declared classification rides the item into the
          // merge and (on pick) the symbol cache — the fetch path then uses
          // the declaration instead of re-deriving the shape via codeRules.
          items.push(endpoint.profile ? { ...item, profile: endpoint.profile } : item);
        }
      }
      if (!canPaginate) break;
      // Termination counts RAW rows, not parsed items — skipped rows (missing
      // code/name) must not look like a short final page.
      const rawRows = map?.searchRowsPath ? digPathValue(response.json, map.searchRowsPath) : undefined;
      const pageRows = Array.isArray(rawRows) ? rawRows.length : pageItems.length;
      if (pageRows < paginate!.pageSize) break;
      if (page + 1 >= maxPages) {
        hitPageCap = true; // stopped at the page cap, not a short page
        break;
      }
    }
    // Truncation detection, same contract as the kline path: hitting maxPages
    // or a declared total (totalPath) exceeding what came back is reported
    // instead of passing silently.
    if (canPaginate && stats) {
      const total = paginate!.totalPath ? Number(digPathValue(lastJson, paginate!.totalPath)) : NaN;
      const allowed = paginate!.allowTruncated === true || undefined;
      if (Number.isFinite(total) && total > items.length) {
        stats.truncated = { fetched: items.length, total, ...(allowed ? { allowed } : {}) };
      } else if (hitPageCap) {
        stats.truncated = { fetched: items.length, ...(allowed ? { allowed } : {}) };
      }
    }
    return items;
  }

  // The jsonMap a search endpoint parses with: the source-level map, with
  // searchRowsPath/searchCols overridden when the endpoint carries its own
  // (merged sources spanning interfaces whose list responses differ in
  // shape, e.g. a bond table with bond_short_name instead of name).
  private endpointMap(endpoint: SearchEndpoint): JsonSourceMap | undefined {
    const base = this.def.jsonMap;
    if (!base) return undefined;
    if (!endpoint.searchRowsPath && !endpoint.searchCols) return base;
    return {
      ...base,
      searchRowsPath: endpoint.searchRowsPath ?? base.searchRowsPath,
      searchCols: endpoint.searchCols ?? base.searchCols,
    };
  }

  // Daily bars for [start, end] (YYYYMMDD), oldest first. Pass a stats
  // object to count rows dropped on unparseable dates (json format only).
  // declaredProfile is the classification the search endpoint declared for
  // this code (persisted in the symbol cache on pick) — it outranks
  // codeRules when resolving {p.*} params.
  async fetchKline(code: string, start: string, end: string, stats?: KlineParseStats, declaredProfile?: string): Promise<OhlcvRow[]> {
    if (!this.def.klineUrl) {
      throw new Error(t("自定义数据源「{name}」缺少 K线 URL 配置。", { name: this.def.name }));
    }
    if (this.def.format === "tencent") return this.fetchTencentKline(code, start, end);
    if (this.def.format === "eastmoney") return this.fetchEastmoneyKline(code, start, end);
    return this.fetchJsonKline(code, start, end, stats, declaredProfile);
  }

  // Tencent format: one call returns at most PAGE_SIZE bars, so page
  // backwards from `end` until the window is covered.
  private async fetchTencentKline(code: string, start: string, end: string): Promise<OhlcvRow[]> {
    const all = new Map<string, OhlcvRow>();
    let pageEnd = end;
    for (let page = 0; page < MAX_PAGES; page++) {
      const values = rangeValues(code, start, pageEnd);
      const url = fillTemplate(this.def.klineUrl!, templateValues(this.def, values));
      const response = await authedRequest(this.def, url, values);
      this.throwOnApiError(response.json);
      const rows = parseTencentKline(response.json, code);
      if (rows.length === 0) break;
      for (const row of rows) {
        all.set(row.tradeDate, row);
      }
      const earliest = rows[0].tradeDate;
      if (rows.length < PAGE_SIZE || earliest <= start) break;
      pageEnd = prevDay(earliest);
    }
    return [...all.values()]
      .filter((row) => row.tradeDate >= start && row.tradeDate <= end)
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  }

  // Eastmoney format: a ranged query returns the whole window in one call
  // (transient failures are retried by the http layer).
  private async fetchEastmoneyKline(code: string, start: string, end: string): Promise<OhlcvRow[]> {
    const values = rangeValues(code, start, end);
    const url = fillTemplate(this.def.klineUrl!, templateValues(this.def, values));
    const response = await authedRequest(this.def, url, values);
    this.throwOnApiError(response.json);
    return parseEastmoneyKline(response.json);
  }

  // Generic JSON format: rows dug out at jsonMap.rowsPath and mapped by
  // column index (rowKind "array"), field name ("object", dotted paths
  // allowed), column name ("fields"), a date-keyed object ("map") or
  // parallel column arrays ("columns"); {code} and {p.*} placeholders in the
  // mapping resolve against the requested code and its symbol params. The
  // request honors def.method/bodyTemplate/transport, so POST sources (e.g.
  // Tushare) work through the same path. With def.paginate set (and an
  // {offset} placeholder present), the request loops offset-paged until a
  // short page or maxPages.
  private async fetchJsonKline(code: string, start: string, end: string, stats?: KlineParseStats, declaredProfile?: string): Promise<OhlcvRow[]> {
    const { urlCode, mapCode } = splitCompositeCode(code);
    const params = resolveSymbolParams(this.def, code, declaredProfile);
    const map = this.def.jsonMap ? resolveMapCode(this.def.jsonMap, mapCode, params) : undefined;
    if (!map) {
      throw new Error(t("自定义数据源「{name}」缺少 JSON 字段映射配置。", { name: this.def.name }));
    }
    // A {p.*} left unfilled would go out literally and fail at the server
    // with an opaque error — fail locally and readably instead.
    const missing = missingSymbolParams(this.def, params);
    if (missing.length > 0) {
      throw new Error(
        t("数据源「{name}」的模板需要符号级参数 {names}，但代码 {code} 不在代码表中且没有源级默认 params——请配置源级 params 或把该代码加入代码表。", {
          name: this.def.name,
          names: missing.map((n) => `p.${n}`).join(", "),
          code,
        })
      );
    }
    const paginate = this.def.paginate;
    const canPaginate = !!paginate && paginate.pageSize > 0
      && (!!this.def.klineUrl?.includes("{offset}") || !!this.def.bodyTemplate?.includes("{offset}"));
    const maxPages = paginate?.maxPages ?? 20;
    const merged = new Map<string, OhlcvRow>();
    let lastJson: any;
    let hitPageCap = false;
    for (let page = 0; ; page++) {
      const offset = canPaginate ? String(page * paginate!.pageSize) : "";
      const values = { ...rangeValues(urlCode, start, end), ...paramValues(params, true), offset };
      const url = fillTemplate(this.def.klineUrl!, templateValues(this.def, values));
      // Body placeholders go in raw (like {apiKey}) — percent-encoding is a
      // URL concern; an encoded value would corrupt a JSON body.
      const rawValues = { code: urlCode, ...paramValues(params, false), offset };
      const response = await authedRequest(this.def, url, values, rawValues);
      // Business errors ride a 200 response on some APIs (e.g. Tushare
      // {code, msg}) — surface them instead of silently parsing empty data.
      const apiError = extractApiError(response.json, map);
      if (apiError) throw new Error(apiError);
      lastJson = response.json;
      // Parse with a page-local stats object and accumulate: parseMappedKline
      // assigns (not adds) `total`, so a paginated fetch must merge per page.
      const pageStats: KlineParseStats | undefined = stats ? { dropped: 0 } : undefined;
      const pageRows = parseMappedKline(response.json, map, pageStats);
      if (stats && pageStats) {
        stats.dropped += pageStats.dropped;
        stats.total = (stats.total ?? 0) + (pageStats.total ?? 0);
        stats.emptyDate = (stats.emptyDate ?? 0) + (pageStats.emptyDate ?? 0);
        stats.badClose = (stats.badClose ?? 0) + (pageStats.badClose ?? 0);
        stats.missingClose = (stats.missingClose ?? 0) + (pageStats.missingClose ?? 0);
        stats.firstBadDate ??= pageStats.firstBadDate;
        stats.unmappedCols ??= pageStats.unmappedCols;
        stats.availableFields ??= pageStats.availableFields;
      }
      for (const row of pageRows) merged.set(row.tradeDate, row);
      if (!canPaginate) break;
      // A full page means there may be more; a short page ends the loop.
      // rawCount (not parsed count) decides — rows dropped on missing
      // values must not look like a short final page.
      const rawNode: unknown = map.rowsPath ? digPathValue(response.json, map.rowsPath) : response.json;
      const rawCount = Array.isArray(rawNode)
        ? rawNode.length
        : rawNode !== null && typeof rawNode === "object"
          ? Object.keys(rawNode).length // "map"/"columns" containers
          : pageRows.length;
      if (rawCount < paginate!.pageSize) break;
      if (page + 1 >= maxPages) {
        hitPageCap = true; // stopped at the page cap, not a short page
        break;
      }
    }
    // Truncation detection: hitting maxPages, or a declared total
    // (totalPath) exceeding what came back — the window is likely
    // incomplete, and the caller (validate-config / console) must hear
    // about it instead of seeing a green probe.
    if (canPaginate && stats) {
      const total = paginate!.totalPath ? Number(digPathValue(lastJson, paginate!.totalPath)) : NaN;
      if (Number.isFinite(total) && total > merged.size) {
        stats.truncated = { fetched: merged.size, total };
      } else if (hitPageCap) {
        stats.truncated = { fetched: merged.size };
      }
      if (stats.truncated) {
        console.warn(`[StrataBoard] source "${this.def.name}": kline fetch of ${code} looks truncated (${stats.truncated.fetched}${stats.truncated.total ? ` / ${stats.truncated.total}` : ""} rows)`);
      }
    }
    const rows = [...merged.values()]
      // The endpoint may ignore the range params; enforce the window locally.
      .filter((row) => row.tradeDate >= start && row.tradeDate <= end)
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    return rows;
  }

  // Throws when the response carries a business-level error and the source
  // has jsonMap.errorPath configured; a no-op otherwise.
  private throwOnApiError(json: any): void {
    const map = this.def.jsonMap;
    if (!map) return;
    const message = extractApiError(json, map);
    if (message) throw new Error(message);
  }
}

// Raw kline probe for the setup wizard: fetches the URL with the sample code
// and a recent range, returning the payload for format detection / preview.
// The ~400-day window also covers low-frequency series (quarterly/annual
// readings), so verification doesn't false-fail on an empty recent window.
// Goes through authedRequest, so POST sources can be probed too.
// Throws the request error on failure.
export async function fetchKlineSample(def: CustomSourceDef, code: string): Promise<{ json: any; text: string }> {
  const end = formatDate(new Date());
  const start = formatDate(new Date(Date.now() - 400 * 86400000));
  const params = resolveSymbolParams(def, code);
  const missing = missingSymbolParams(def, params);
  if (missing.length > 0) {
    throw new Error(
      t("数据源「{name}」的模板需要符号级参数 {names}，但代码 {code} 不在代码表中且没有源级默认 params——请配置源级 params 或把该代码加入代码表。", {
        name: def.name,
        names: missing.map((n) => `p.${n}`).join(", "),
        code,
      })
    );
  }
  const values = { ...rangeValues(splitCompositeCode(code).urlCode, start, end), ...paramValues(params, true) };
  const url = fillTemplate(def.klineUrl ?? "", templateValues(def, values));
  const response = await authedRequest(def, url, values, { code: splitCompositeCode(code).urlCode, ...paramValues(params, false) });
  return { json: response.json, text: response.text };
}

// Raw text fetch for remote delimited-text sources (format "csv" with a
// klineUrl instead of a vault filePath): the same template fill, symbol
// params, missing-param guard and auth as fetchJsonKline, but the response
// body comes back unparsed for the CSV parser.
export async function fetchSourceText(def: CustomSourceDef, code: string, start: string, end: string): Promise<string> {
  const urlCode = splitCompositeCode(code).urlCode;
  const params = resolveSymbolParams(def, code);
  const missing = missingSymbolParams(def, params);
  if (missing.length > 0) {
    throw new Error(
      t("数据源「{name}」的模板需要符号级参数 {names}，但代码 {code} 不在代码表中且没有源级默认 params——请配置源级 params 或把该代码加入代码表。", {
        name: def.name,
        names: missing.map((n) => `p.${n}`).join(", "),
        code,
      })
    );
  }
  const values = { ...rangeValues(urlCode, start, end), ...paramValues(params, true), offset: "" };
  const url = fillTemplate(def.klineUrl ?? "", templateValues(def, values));
  const response = await authedRequest(def, url, values, { code: urlCode, ...paramValues(params, false), offset: "" });
  return response.text;
}

// Guesses the search parser for a source: builtin presets by probing the
// search URL; "json" sources keep their manual mapping. The probe query
// derives from the source's own testCode/symbols (a hardcoded A-share code
// would false-fail English/global sources).
export async function autoDetectSearchFormat(def: CustomSourceDef): Promise<CustomSourceDef["format"]> {
  if (!def.searchUrl) return def.format;
  const values = { query: encodeURIComponent(searchProbeQuery(def).query) };
  const url = fillTemplate(def.searchUrl, templateValues(def, values));
  const response = await authedRequest(def, url, values);
  if (parseTencentSearch(response.text).length > 0) return "tencent";
  if (parseEastmoneySearch(response.json).length > 0) return "eastmoney";
  return "json";
}

// Placeholder values for one ranged request: the code plus the range in
// every spelling a template may want — YYYYMMDD ({start}/{end}), ISO
// ({startIso}/{endIso}) and epoch seconds ({startTs}/{endTs}, start-of-day
// UTC). The code is already URL-encoded here, matching the previous
// call-site behavior.
function rangeValues(code: string, start: string, end: string): Record<string, string> {
  return {
    code: encodeURIComponent(code),
    start,
    end,
    startIso: isoDate(start),
    endIso: isoDate(end),
    startTs: epochSeconds(start),
    endTs: epochSeconds(end),
  };
}

// YYYYMMDD → epoch seconds at 00:00 UTC of that day.
function epochSeconds(ymd: string): string {
  const ms = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  return String(Math.floor(ms / 1000));
}

// Fills {placeholder} tokens; unknown placeholders are left as-is so a URL
// the user didn't mean to template stays intact. Keys may contain a dot —
// {p.<name>} is a per-symbol param slot.
function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([\w.]+)\}/g, (match, key: string) => values[key] ?? match);
}

// Flattens symbol params into template values ("p.api_name" → value).
// URL values are percent-encoded like {code}; body values go raw.
function paramValues(params: Record<string, string> | undefined, encode: boolean): Record<string, string> {
  if (!params) return {};
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [`p.${k}`, encode ? encodeURIComponent(v) : v]),
  );
}

// {p.<name>} placeholders used by the kline templates but not provided by
// the resolved params — sending them literally would make the request fail
// at the server with an opaque error, so the caller fails locally instead.
function missingSymbolParams(def: CustomSourceDef, params: Record<string, string> | undefined): string[] {
  const missing = new Set<string>();
  for (const template of [def.klineUrl, def.bodyTemplate]) {
    for (const m of template?.matchAll(/\{p\.([\w.]+)\}/g) ?? []) {
      if (!params || params[m[1]] === undefined) missing.add(m[1]);
    }
  }
  return [...missing];
}

// Template values shared by every request of a source: the {apiKey}
// placeholder (query-param auth) is filled URL-encoded; header-mode auth
// never goes into the URL.
function templateValues(def: CustomSourceDef, extra: Record<string, string>): Record<string, string> {
  return { apiKey: encodeURIComponent(def.apiKey ?? ""), ...extra };
}

// Builds the auth header set for a source, or undefined when no key/header
// is configured. apiKeyHeader syntax: "Name" (header value = the raw key) or
// "Name: value-template" (split on the first colon; the template may contain
// {apiKey}, e.g. "Authorization: Bearer {apiKey}"). Header values are not
// URL-encoded.
export function buildAuthHeaders(def: Pick<CustomSourceDef, "apiKey" | "apiKeyHeader">): Record<string, string> | undefined {
  const key = def.apiKey?.trim();
  const spec = def.apiKeyHeader?.trim();
  if (!key || !spec) return undefined;
  const colon = spec.indexOf(":");
  if (colon < 0) return { [spec]: key };
  const name = spec.slice(0, colon).trim();
  if (!name) return undefined;
  return { [name]: fillTemplate(spec.slice(colon + 1).trim(), { apiKey: key }) };
}

// Header set for one source request: def.headers lays static headers first
// (values may contain {apiKey}, filled raw like every header value), then
// the auth header from buildAuthHeaders overrides on a name conflict.
// Undefined when neither is configured.
function buildRequestHeaders(def: CustomSourceDef): Record<string, string> | undefined {
  const statics = Object.fromEntries(
    Object.entries(def.headers ?? {}).map(([name, value]) => [name, fillTemplate(value, { apiKey: def.apiKey ?? "" })]),
  );
  const merged = { ...statics, ...buildAuthHeaders(def) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// Sends a source request through the global throttle with the source's auth
// headers attached. Honors def.method (default GET), def.transport and — for
// POST — def.bodyTemplate with def.bodyEncoding: "json" (default) fills
// placeholders RAW ({apiKey} has always been raw in bodies; {code}/{p.*}
// follow via rawValues — percent-encoding is a URL concern and would corrupt
// a JSON body); "form" percent-encodes every value and sends
// Content-Type: application/x-www-form-urlencoded (legacy form-only APIs).
function authedRequest(
  def: CustomSourceDef,
  url: string,
  extraValues?: Record<string, string>,
  rawValues?: Record<string, string>
) {
  const form = def.bodyEncoding === "form";
  const headers = {
    ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    ...buildRequestHeaders(def),
  };
  const method = def.method ?? "GET";
  let body: string | undefined;
  if (method === "POST" && def.bodyTemplate) {
    body = form
      ? fillTemplate(def.bodyTemplate, { apiKey: encodeURIComponent(def.apiKey ?? ""), ...extraValues })
      : fillBodyTemplate(def.bodyTemplate, { apiKey: def.apiKey ?? "", ...extraValues, ...rawValues });
  }
  return httpRequest({
    url,
    method,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(def.transport ? { transport: def.transport } : {}),
  });
}

// Marker for an empty {p.<name>} value in a JSON body — see fillBodyTemplate.
// Must be JSON-string-safe (no control chars) so the filled body still parses.
const EMPTY_PARAM_SENTINEL = "__fc_empty_param__";

// Fills a POST body template. A {p.<name>} placeholder resolving to the empty
// string first fills a sentinel; when the filled body parses as JSON, keys
// holding exactly the sentinel are dropped and the body re-serializes — this
// is how one symbol in a merged source opts out of a range/extra param the
// shared body template carries (e.g. an interface that filters hard on
// start/end and must be queried without them). Non-JSON bodies get the
// sentinel replaced back with an empty string, i.e. the old behavior. Only
// p.* values take part; every other placeholder keeps its old empty-fill.
function fillBodyTemplate(template: string, values: Record<string, string>): string {
  const sentinelValues = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, k.startsWith("p.") && v === "" ? EMPTY_PARAM_SENTINEL : v]),
  );
  const filled = fillTemplate(template, sentinelValues);
  if (!filled.includes(EMPTY_PARAM_SENTINEL)) return filled;
  try {
    const parsed: unknown = JSON.parse(filled);
    dropEmptyParams(parsed);
    return JSON.stringify(parsed);
  } catch {
    return filled.split(EMPTY_PARAM_SENTINEL).join("");
  }
}

// Recursively deletes object keys whose value is exactly EMPTY_PARAM_SENTINEL.
function dropEmptyParams(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) dropEmptyParams(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (value === EMPTY_PARAM_SENTINEL) delete (node as Record<string, unknown>)[key];
    else dropEmptyParams(value);
  }
}

function isoDate(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function prevDay(ymd: string): string {
  const d = new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
