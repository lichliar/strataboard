import { httpRequest } from "./http";
import type { CustomSourceDef, JsonSourceMap, OhlcvRow, SymbolItem } from "../types";
import {
  digPathValue,
  parseEastmoneyKline,
  parseEastmoneySearch,
  parseMappedKline,
  parseTencentKline,
  parseTencentSearch,
  pickRowColumn,
} from "./quote-format-parsers";
import { formatDate } from "../utils/date";
import { t } from "../i18n";

// HTTP client for one user-configured custom data source (设置页 → 自定义数据
// 源). The plugin ships no endpoint URLs; both URLs come from the user's
// templates with {query} / {code} / {start} / {end} (YYYYMMDD) / {startIso} /
// {endIso} (YYYY-MM-DD) placeholders filled per request. `def.format` picks
// the response parser preset; "json" maps arbitrary payloads via def.jsonMap.

// Tencent-format kline pages top out at ~640 bars; paging goes back at most
// MAX_PAGES pages (~20 years of trading days).
const PAGE_SIZE = 640;
const MAX_PAGES = 8;

export class CustomQuoteClient {
  constructor(private def: CustomSourceDef) {}

  // Server-side symbol search. Sources without a searchUrl have no remote
  // search — the UI opens the manual-entry modal instead of calling this.
  async searchQuotes(query: string): Promise<SymbolItem[]> {
    if (!this.def.searchUrl) return [];
    const url = fillTemplate(this.def.searchUrl, { query: encodeURIComponent(query) });
    const response = await httpRequest({ url, method: "GET" });
    const items =
      this.def.format === "tencent"
        ? parseTencentSearch(response.text)
        : this.def.format === "eastmoney"
          ? parseEastmoneySearch(response.json)
          : this.parseJsonSearch(response.json);
    return items.map((item) => ({ ...item, sourceId: this.def.id }));
  }

  // Daily bars for [start, end] (YYYYMMDD), oldest first.
  async fetchKline(code: string, start: string, end: string): Promise<OhlcvRow[]> {
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
      const url = fillTemplate(this.def.klineUrl, {
        code: encodeURIComponent(code),
        start,
        end: pageEnd,
        startIso: isoDate(start),
        endIso: isoDate(pageEnd),
      });
      const response = await httpRequest({ url, method: "GET" });
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
    const url = fillTemplate(this.def.klineUrl, {
      code: encodeURIComponent(code),
      start,
      end,
      startIso: isoDate(start),
      endIso: isoDate(end),
    });
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await httpRequest({ url, method: "GET" });
        return parseEastmoneyKline(response.json);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError ?? new Error(t("自定义数据源「{name}」行情接口请求失败。", { name: this.def.name }));
  }

  // Generic JSON format: single GET, rows dug out at jsonMap.rowsPath and
  // mapped by column index (rowKind "array") or field name ("object").
  private async fetchJsonKline(code: string, start: string, end: string): Promise<OhlcvRow[]> {
    const map = this.def.jsonMap;
    if (!map) {
      throw new Error(t("自定义数据源「{name}」缺少 JSON 字段映射配置。", { name: this.def.name }));
    }
    const url = fillTemplate(this.def.klineUrl, {
      code: encodeURIComponent(code),
      start,
      end,
      startIso: isoDate(start),
      endIso: isoDate(end),
    });
    const response = await httpRequest({ url, method: "GET" });
    // The endpoint may ignore the range params; enforce the window locally.
    return parseMappedKline(response.json, map)
      .filter((row) => row.tradeDate >= start && row.tradeDate <= end);
  }

  private parseJsonSearch(json: any): SymbolItem[] {
    const map = this.def.jsonMap;
    if (!map?.searchRowsPath || !map.searchCols) return [];
    const raw: unknown = digPathValue(json, map.searchRowsPath);
    if (!Array.isArray(raw)) return [];
    const items: SymbolItem[] = [];
    for (const r of raw) {
      const code = String(pickRowColumn(r, map.rowKind, map.searchCols.code) ?? "").trim();
      const name = String(pickRowColumn(r, map.rowKind, map.searchCols.name) ?? "").trim();
      if (!code || !name) continue;
      items.push({
        tsCode: code,
        symbol: code,
        name,
        exchange: map.searchCols.market ? String(pickRowColumn(r, map.rowKind, map.searchCols.market) ?? "") : "",
        assetType: "custom",
      });
    }
    return items;
  }
}

// Raw kline probe for the setup wizard: fetches the URL with the sample code
// and a recent range, returning the payload for format detection / preview.
// Throws the request error on failure.
export async function fetchKlineSample(def: CustomSourceDef, code: string): Promise<{ json: any; text: string }> {
  const end = formatDate(new Date());
  const start = formatDate(new Date(Date.now() - 120 * 86400000));
  const url = fillTemplate(def.klineUrl, {
    code: encodeURIComponent(code),
    start,
    end,
    startIso: isoDate(start),
    endIso: isoDate(end),
  });
  const response = await httpRequest({ url, method: "GET" });
  return { json: response.json, text: response.text };
}

// Guesses the search parser for a source: builtin presets by probing the
// search URL; "json" sources keep their manual mapping.
export async function autoDetectSearchFormat(def: CustomSourceDef): Promise<CustomSourceDef["format"]> {
  if (!def.searchUrl) return def.format;
  const url = fillTemplate(def.searchUrl, { query: encodeURIComponent("000001") });
  const response = await httpRequest({ url, method: "GET" });
  if (parseTencentSearch(response.text).length > 0) return "tencent";
  if (parseEastmoneySearch(response.json).length > 0) return "eastmoney";
  return "json";
}

// Fills {placeholder} tokens; unknown placeholders are left as-is so a URL
// the user didn't mean to template stays intact.
function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
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
