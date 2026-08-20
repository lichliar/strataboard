import { requestUrl } from "obsidian";
import type { OhlcvRow, SymbolItem } from "../types";

// Thin client for Eastmoney's token-free quote endpoints:
//   search — searchapi.eastmoney.com/api/suggest/get (returns a ready-to-use
//            QuoteID, e.g. "1.600519", which doubles as the kline secid)
//   kline  — push2his.eastmoney.com/api/qt/stock/kline/get (day bars, CSV)
// tsCode convention: the secid ("<market>.<code>"; 1=沪 0=深 116=港 105=美).
// The suggest token below is Eastmoney's public web token, shipped in their
// own frontend — not a user credential.

const SEARCH_URL = "https://searchapi.eastmoney.com/api/suggest/get";
const SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
const KLINE_HOSTS = ["push2his.eastmoney.com", "92.push2his.eastmoney.com"];

// Quoteable classes only — bonds, warrants and the like are filtered out.
const KEEP_CLASSIFY = new Set(["AStock", "UsStock", "HKStock", "Fund", "Index"]);

export class EastmoneyApiClient {
  async searchQuotes(query: string): Promise<SymbolItem[]> {
    const url = `${SEARCH_URL}?input=${encodeURIComponent(query)}&type=14&token=${SEARCH_TOKEN}&count=20`;
    const response = await requestUrl({ url, method: "GET" });
    return parseEastmoneySearch(response.json);
  }

  // Daily bars for [start, end] (YYYYMMDD), oldest first. A ranged query
  // returns the whole window in one call; the second host is a fallback for
  // the occasional dropped connection from the CDN edge.
  async fetchKline(secid: string, start: string, end: string): Promise<OhlcvRow[]> {
    let lastError: Error | undefined;
    for (const host of KLINE_HOSTS) {
      try {
        const url =
          `https://${host}/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}` +
          `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&beg=${start}&end=${end}`;
        const response = await requestUrl({ url, method: "GET" });
        return parseEastmoneyKline(response.json);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError ?? new Error("东方财富行情接口请求失败。");
  }
}

// Kept pure for node-side testing.
export function parseEastmoneySearch(json: any): SymbolItem[] {
  const data = json?.QuotationCodeTable?.Data;
  if (!Array.isArray(data)) return [];
  const items: SymbolItem[] = [];
  for (const entry of data) {
    if (!KEEP_CLASSIFY.has(entry?.Classify)) continue;
    const tsCode = String(entry.QuoteID ?? "");
    if (!tsCode) continue;
    items.push({
      tsCode,
      symbol: String(entry.Code ?? ""),
      name: String(entry.Name ?? ""),
      exchange: String(entry.SecurityTypeName ?? ""),
      assetType: "em",
    });
  }
  return items;
}

// Kline rows are CSV strings: date,open,close,high,low,vol,amount(,amplitude)
// — again close BEFORE high/low. amount is in 元.
export function parseEastmoneyKline(json: any): OhlcvRow[] {
  const klines: unknown = json?.data?.klines;
  if (!Array.isArray(klines)) return [];
  const rows: OhlcvRow[] = [];
  for (const line of klines) {
    const parts = String(line).split(",");
    if (parts.length < 7) continue;
    const tradeDate = parts[0].replace(/-/g, "");
    const open = Number(parts[1]);
    const close = Number(parts[2]);
    const high = Number(parts[3]);
    const low = Number(parts[4]);
    const vol = Number(parts[5]);
    const amount = Number(parts[6]);
    if (!tradeDate || !Number.isFinite(close)) continue;
    rows.push({ tradeDate, open, high, low, close, vol, amount });
  }
  return rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}
