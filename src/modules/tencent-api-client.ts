import { requestUrl } from "obsidian";
import type { OhlcvRow, SymbolItem } from "../types";

// Thin client for Tencent's token-free quote endpoints (the same public HTTP
// APIs behind 腾讯自选股; see the westock-data reference the user pointed at).
// Two endpoints:
//   search — smartbox.gtimg.cn/s3 (code/name fuzzy search, JS-with-escapes)
//   kline  — web.ifzq.gtimg.cn/appstock/app/fqkline/get (day bars, ≤640/call)
// tsCode convention: the native Tencent code (sh600519 / hk00700 / usAAPL.OQ).

const SEARCH_URL = "https://smartbox.gtimg.cn/s3/";
const KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
// One page of the fqkline API tops out at ~640 bars; paging goes back at most
// ~20 years of trading days.
const PAGE_SIZE = 640;
const MAX_PAGES = 8;

export class TencentApiClient {
  async searchQuotes(query: string): Promise<SymbolItem[]> {
    const response = await requestUrl({
      url: `${SEARCH_URL}?v=2&q=${encodeURIComponent(query)}&t=all`,
      method: "GET",
    });
    return parseTencentSearch(response.text);
  }

  // Daily bars for [start, end] (YYYYMMDD), oldest first. Pages backwards
  // from `end` because one call returns at most PAGE_SIZE bars.
  async fetchKline(code: string, start: string, end: string): Promise<OhlcvRow[]> {
    const all = new Map<string, OhlcvRow>();
    let pageEnd = end;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${KLINE_URL}?param=${code},day,,${isoDate(pageEnd)},${PAGE_SIZE},qfq`;
      const response = await requestUrl({ url, method: "GET" });
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
}

// Parses the smartbox response (`v_hint="sh~600519~贵州茅台~gzmt~GP-A^…"`).
// The payload is ASCII with JSON-style \uXXXX escapes, so the quoted body is
// decoded via JSON.parse. Kept pure for node-side testing.
export function parseTencentSearch(text: string): SymbolItem[] {
  const match = text.match(/v_hint="((?:[^"\\]|\\.)*)"/);
  if (!match) return [];
  let decoded: string;
  try {
    decoded = JSON.parse(`"${match[1]}"`);
  } catch {
    return [];
  }
  const items: SymbolItem[] = [];
  for (const entry of decoded.split("^")) {
    const [market, code, name] = entry.split("~");
    if (!market || !code || !name) continue;
    if (market !== "sh" && market !== "sz" && market !== "hk" && market !== "us") continue;
    // Tencent's kline API wants the US ticker uppercased (usAAPL.OQ); the
    // search response lowercases it (us~aapl.oq).
    const tsCode = market === "us" ? `us${code.toUpperCase()}` : `${market}${code}`;
    items.push({
      tsCode,
      symbol: code.toUpperCase(),
      name,
      exchange: { sh: "沪", sz: "深", hk: "港股", us: "美股" }[market],
      assetType: "tx",
    });
  }
  return items;
}

// Parses one fqkline response. Rows are [date, open, close, high, low, vol, …]
// (note close BEFORE high/low — Tencent's order, not OHLC). A-share stocks
// and ETFs come back under "qfqday" (前复权), indices/HK/US under "day".
export function parseTencentKline(json: any, code: string): OhlcvRow[] {
  const bucket = json?.data?.[code];
  const raw: unknown[] = bucket?.qfqday ?? bucket?.day ?? [];
  const rows: OhlcvRow[] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const tradeDate = String(r[0]).replace(/-/g, "");
    const open = Number(r[1]);
    const close = Number(r[2]);
    const high = Number(r[3]);
    const low = Number(r[4]);
    const vol = Number(r[5]);
    if (!tradeDate || !Number.isFinite(close)) continue;
    rows.push({ tradeDate, open, high, low, close, vol, amount: 0 });
  }
  return rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
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
