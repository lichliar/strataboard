import { httpRequest } from "./http";
import type { CustomSourceDef, OhlcvRow, SymbolItem } from "../types";
import {
  extractApiError,
  parseEastmoneyKline,
  parseEastmoneySearch,
  parseMappedKline,
  parseMappedSearch,
  parseTencentKline,
  parseTencentSearch,
  resolveMapCode,
  splitCompositeCode,
} from "./quote-format-parsers";
import { formatDate } from "../utils/date";
import { t } from "../i18n";

// HTTP client for one user-configured custom data source (设置页 → 自定义数据
// 源). The plugin ships no endpoint URLs; both URLs come from the user's
// templates with {query} / {code} / {start} / {end} (YYYYMMDD) / {startIso} /
// {endIso} (YYYY-MM-DD) / {apiKey} placeholders filled per request;
// apiKeyHeader adds an auth header on top. Search is GET (searchUrl) or POST
// (searchBodyTemplate, URL falls back to klineUrl). `def.format` picks
// the response parser preset; "json" maps arbitrary payloads via def.jsonMap.

// Tencent-format kline pages top out at ~640 bars; paging goes back at most
// MAX_PAGES pages (~20 years of trading days).
const PAGE_SIZE = 640;
const MAX_PAGES = 8;

export class CustomQuoteClient {
  constructor(private def: CustomSourceDef) {}

  // Server-side symbol search. A source configures a GET searchUrl ({query}
  // placeholder), a POST searchBodyTemplate (same placeholders as
  // bodyTemplate plus {query}), or neither (no remote search — the UI offers
  // manual entry instead). With only the body template the URL falls back to
  // klineUrl. Templates WITHOUT {query} fetch the whole symbol list; the
  // caller filters locally (DataAdapter.searchRemoteQuotes).
  async searchQuotes(query: string): Promise<SymbolItem[]> {
    const def = this.def;
    const urlTemplate = def.searchUrl ?? (def.searchBodyTemplate ? def.klineUrl : undefined);
    if (!urlTemplate) return [];
    const url = fillTemplate(urlTemplate, templateValues(def, { query: encodeURIComponent(query) }));
    const headers = buildAuthHeaders(def);
    // {query} goes into the body raw (URL-encoding would break non-ASCII
    // keywords); {apiKey} stays raw in bodies per the bodyTemplate contract.
    const body = def.searchBodyTemplate
      ? fillTemplate(def.searchBodyTemplate, { apiKey: def.apiKey ?? "", query })
      : undefined;
    const response = await httpRequest({
      url,
      method: body !== undefined ? "POST" : "GET",
      ...(headers ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(def.transport ? { transport: def.transport } : {}),
    });
    if (def.format === "json" && def.jsonMap) {
      const apiError = extractApiError(response.json, def.jsonMap);
      if (apiError) throw new Error(apiError);
    }
    const items =
      def.format === "tencent"
        ? parseTencentSearch(response.text)
        : def.format === "eastmoney"
          ? parseEastmoneySearch(response.json)
          : parseMappedSearch(response.json, def.jsonMap);
    return items.map((item) => ({ ...item, sourceId: def.id }));
  }

  // Daily bars for [start, end] (YYYYMMDD), oldest first.
  async fetchKline(code: string, start: string, end: string): Promise<OhlcvRow[]> {
    if (!this.def.klineUrl) {
      throw new Error(t("自定义数据源「{name}」缺少 K线 URL 配置。", { name: this.def.name }));
    }
    if (this.def.format === "tencent") return this.fetchTencentKline(code, start, end);
    if (this.def.format === "eastmoney") return this.fetchEastmoneyKline(code, start, end);
    return this.fetchJsonKline(code, start, end);
  }

  // Tencent format: one call returns at most PAGE_SIZE bars, so page
  // backwards from `end` until the window is covered.
  private async fetchTencentKline(code: string, start: string, end: string): Promise<OhlcvRow[]> {
    const all = new Map<string, OhlcvRow>();
    let pageEnd = end;
    for (let page = 0; page < MAX_PAGES; page++) {
      const values = {
        code: encodeURIComponent(code),
        start,
        end: pageEnd,
        startIso: isoDate(start),
        endIso: isoDate(pageEnd),
      };
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

  // Eastmoney format: a ranged query returns the whole window in one call;
  // retry the same URL once for the occasional dropped connection.
  private async fetchEastmoneyKline(code: string, start: string, end: string): Promise<OhlcvRow[]> {
    const values = {
      code: encodeURIComponent(code),
      start,
      end,
      startIso: isoDate(start),
      endIso: isoDate(end),
    };
    const url = fillTemplate(this.def.klineUrl!, templateValues(this.def, values));
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await authedRequest(this.def, url, values);
        this.throwOnApiError(response.json);
        return parseEastmoneyKline(response.json);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError ?? new Error(t("自定义数据源「{name}」行情接口请求失败。", { name: this.def.name }));
  }

  // Generic JSON format: rows dug out at jsonMap.rowsPath and mapped by
  // column index (rowKind "array"), field name ("object") or column name
  // ("fields"); a {code} placeholder in the mapping resolves to the
  // requested code first. The request honors def.method/bodyTemplate/
  // transport, so POST sources (e.g. Tushare) work through the same path.
  private async fetchJsonKline(code: string, start: string, end: string): Promise<OhlcvRow[]> {
    const { urlCode, mapCode } = splitCompositeCode(code);
    const map = this.def.jsonMap ? resolveMapCode(this.def.jsonMap, mapCode) : undefined;
    if (!map) {
      throw new Error(t("自定义数据源「{name}」缺少 JSON 字段映射配置。", { name: this.def.name }));
    }
    const values = {
      code: encodeURIComponent(urlCode),
      start,
      end,
      startIso: isoDate(start),
      endIso: isoDate(end),
    };
    const url = fillTemplate(this.def.klineUrl!, templateValues(this.def, values));
    const response = await authedRequest(this.def, url, values);
    // Business errors ride a 200 response on some APIs (e.g. Tushare
    // {code, msg}) — surface them instead of silently parsing empty data.
    const apiError = extractApiError(response.json, map);
    if (apiError) throw new Error(apiError);
    // The endpoint may ignore the range params; enforce the window locally.
    return parseMappedKline(response.json, map)
      .filter((row) => row.tradeDate >= start && row.tradeDate <= end);
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
  const values = {
    code: encodeURIComponent(splitCompositeCode(code).urlCode),
    start,
    end,
    startIso: isoDate(start),
    endIso: isoDate(end),
  };
  const url = fillTemplate(def.klineUrl ?? "", templateValues(def, values));
  const response = await authedRequest(def, url, values);
  return { json: response.json, text: response.text };
}

// Guesses the search parser for a source: builtin presets by probing the
// search URL; "json" sources keep their manual mapping.
export async function autoDetectSearchFormat(def: CustomSourceDef): Promise<CustomSourceDef["format"]> {
  if (!def.searchUrl) return def.format;
  const values = { query: encodeURIComponent("000001") };
  const url = fillTemplate(def.searchUrl, templateValues(def, values));
  const response = await authedRequest(def, url, values);
  if (parseTencentSearch(response.text).length > 0) return "tencent";
  if (parseEastmoneySearch(response.json).length > 0) return "eastmoney";
  return "json";
}

// Fills {placeholder} tokens; unknown placeholders are left as-is so a URL
// the user didn't mean to template stays intact.
function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
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

// Sends a source request through the global throttle with the source's auth
// headers attached. Honors def.method (default GET), def.transport and — for
// POST — def.bodyTemplate, filled with the same placeholder values as the
// URL (extraValues) except {apiKey}, which is NOT URL-encoded in the body
// (the URL copy stays encoded, see templateValues).
function authedRequest(def: CustomSourceDef, url: string, extraValues?: Record<string, string>) {
  const headers = buildAuthHeaders(def);
  const method = def.method ?? "GET";
  const body =
    method === "POST" && def.bodyTemplate
      ? fillTemplate(def.bodyTemplate, { apiKey: def.apiKey ?? "", ...extraValues })
      : undefined;
  return httpRequest({
    url,
    method,
    ...(headers ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(def.transport ? { transport: def.transport } : {}),
  });
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
