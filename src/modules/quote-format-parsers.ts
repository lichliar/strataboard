import type { OhlcvRow, SymbolItem } from "../types";

// Response parser presets for user-configured custom data sources
// (CustomSourceDef.format). The plugin ships no endpoint URLs — users paste
// their own templates in settings; these functions only decode the two known
// payload shapes. All functions are pure (no requestUrl), so they can be
// exercised from node.

// Parses the Tencent smartbox search response
// (`v_hint="sh~600519~贵州茅台~gzmt~GP-A^…"`). The payload is ASCII with
// JSON-style \uXXXX escapes, so the quoted body is decoded via JSON.parse.
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
      assetType: "custom",
    });
  }
  return items;
}

// Parses one Tencent fqkline response. Rows are [date, open, close, high,
// low, vol, …] (note close BEFORE high/low — Tencent's order, not OHLC).
// A-share stocks and ETFs come back under "qfqday" (前复权), indices/HK/US
// under "day".
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

// Quoteable classes only — bonds, warrants and the like are filtered out.
const KEEP_CLASSIFY = new Set(["AStock", "UsStock", "HKStock", "Fund", "Index"]);

// Parses the Eastmoney suggest response; QuoteID (e.g. "1.600519") doubles as
// the kline secid ("<market>.<code>"; 1=沪 0=深 116=港 105=美).
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
      assetType: "custom",
    });
  }
  return items;
}

// Eastmoney kline rows are CSV strings: date,open,close,high,low,vol,amount
// (,amplitude) — again close BEFORE high/low. amount is in 元.
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
