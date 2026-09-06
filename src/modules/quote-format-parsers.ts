import type { JsonSourceMap, OhlcvRow, SymbolItem } from "../types";
import { formatDate } from "../utils/date";

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

// Normalizes a date cell to YYYYMMDD: strips non-digits; 8 digits pass
// through, 10/13 digits are epoch seconds/milliseconds. Shared by the custom
// quote client and the format heuristics below.
export function normalizeJsonDate(raw: unknown): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 8) return digits;
  if (digits.length === 10) return formatDate(new Date(Number(digits) * 1000));
  if (digits.length === 13) return formatDate(new Date(Number(digits)));
  return "";
}

// ===== Auto-detection (custom-source setup wizard) =====
// The wizard pastes a working URL and probes it; these pure functions
// recognize the payload shape so the user never has to name a parser.

// Tries the built-in kline parser presets against a fetched payload; returns
// the matching format when one yields rows, else null (caller falls back to
// detectJsonMapping / manual mapping).
export function detectBuiltinKlineFormat(json: any, code: string): "tencent" | "eastmoney" | null {
  if (parseTencentKline(json, code).length > 0) return "tencent";
  if (parseEastmoneyKline(json).length > 0) return "eastmoney";
  return null;
}

export interface JsonRowCandidate {
  rowsPath: string;
  rowKind: "array" | "object";
  row: any; // first row, used to preview column values in the wizard
}

// Field-name dictionaries for guessing OHLCV columns of object rows
// (case-insensitive exact match). Position-based fallbacks live in
// guessArrayCols.
const NAME_KEYS: Record<keyof Omit<JsonSourceMap["cols"], "amount">, string[]> = {
  date: ["date", "time", "datetime", "day", "trade_date", "tradedate", "d", "t"],
  open: ["open", "openprice", "o"],
  close: ["close", "closeprice", "price", "last", "c"],
  high: ["high", "highprice", "h"],
  low: ["low", "lowprice", "l"],
  vol: ["vol", "volume", "v"],
};
const AMOUNT_KEYS = ["amount", "turnover", "amt", "money"];

// Lowercase keys keep CJK field names out of the dictionaries — "日期" would
// lowercase to itself and never match an English payload anyway.
function matchName(field: string, candidates: string[]): boolean {
  const lower = field.toLowerCase();
  return candidates.includes(lower) || candidates.includes(lower.replace(/[_\s]/g, ""));
}

// Finds arrays in the payload that look like kline row lists: ≥2 rows whose
// values include a date-like cell. Breadth-first, so shallow wrappers come
// before nested lookalikes.
export function findRowCandidates(json: any): JsonRowCandidate[] {
  const found: JsonRowCandidate[] = [];
  const queue: { node: any; path: string }[] = [{ node: json, path: "" }];
  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      if (node.length >= 2 && node.every((r) => Array.isArray(r) || (r !== null && typeof r === "object"))) {
        const candidate: JsonRowCandidate = {
          rowsPath: path,
          rowKind: Array.isArray(node[0]) ? "array" : "object",
          row: node[0],
        };
        if (guessCols(candidate) !== null) found.push(candidate);
      }
      continue; // don't descend into row lists
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child !== null && typeof child === "object") {
        queue.push({ node: child, path: path ? `${path}.${key}` : key });
      }
    }
  }
  return found;
}

// Guesses a full column mapping for one candidate; null when no date column
// is identifiable (the list probably isn't kline data).
export function guessCols(candidate: JsonRowCandidate): JsonSourceMap["cols"] | null {
  return candidate.rowKind === "array" ? guessArrayCols(candidate.row) : guessObjectCols(candidate.row);
}

function guessArrayCols(row: any): JsonSourceMap["cols"] | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const dateIndex = row.findIndex((v) => normalizeJsonDate(v) !== "");
  if (dateIndex < 0) return null;
  // Tencent/Eastmoney order (open, close, high, low) is the most common
  // layout of quote arrays; the user corrects wrong guesses via the
  // value-preview dropdowns in the wizard.
  const cols: JsonSourceMap["cols"] = { date: String(dateIndex), open: "", close: "", high: "", low: "", vol: "" };
  const numericAfter: number[] = [];
  for (let i = dateIndex + 1; i < row.length; i++) {
    if (Number.isFinite(Number(row[i])) && String(row[i]).trim() !== "") numericAfter.push(i);
  }
  const [o, c, h, l, v, a] = numericAfter;
  if (o === undefined || c === undefined || h === undefined || l === undefined) return null;
  cols.open = String(o);
  cols.close = String(c);
  cols.high = String(h);
  cols.low = String(l);
  if (v !== undefined) cols.vol = String(v);
  if (a !== undefined) cols.amount = String(a);
  return cols;
}

function guessObjectCols(row: any): JsonSourceMap["cols"] | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const fields = Object.keys(row);
  const pickBy = (candidates: string[]): string | undefined => fields.find((f) => matchName(f, candidates));
  const date = pickBy(NAME_KEYS.date) ?? fields.find((f) => normalizeJsonDate(row[f]) !== "");
  if (!date) return null;
  const open = pickBy(NAME_KEYS.open);
  const close = pickBy(NAME_KEYS.close);
  const high = pickBy(NAME_KEYS.high);
  const low = pickBy(NAME_KEYS.low);
  const vol = pickBy(NAME_KEYS.vol);
  if (!open || !close || !high || !low || !vol) return null;
  const cols: JsonSourceMap["cols"] = { date, open, close, high, low, vol };
  const amount = pickBy(AMOUNT_KEYS);
  if (amount) cols.amount = amount;
  return cols;
}

// Best-effort generic JSON mapping: first candidate that guesses cleanly.
// The wizard previews the parsed rows so a wrong guess is caught by the user.
export function detectJsonMapping(json: any): JsonSourceMap | null {
  for (const candidate of findRowCandidates(json)) {
    const cols = guessCols(candidate);
    if (cols) return { rowsPath: candidate.rowsPath, rowKind: candidate.rowKind, cols };
  }
  return null;
}

// Parses rows with a guessed/explicit mapping — used by the wizard preview.
export function parseMappedKline(json: any, map: JsonSourceMap): OhlcvRow[] {
  const raw: unknown = digPathValue(json, map.rowsPath);
  if (!Array.isArray(raw)) return [];
  const rows: OhlcvRow[] = [];
  for (const r of raw) {
    const pick = (col: string | undefined) => pickRowColumn(r, map.rowKind, col);
    const tradeDate = normalizeJsonDate(pick(map.cols.date));
    const open = Number(pick(map.cols.open));
    const close = Number(pick(map.cols.close));
    const high = Number(pick(map.cols.high));
    const low = Number(pick(map.cols.low));
    const vol = Number(pick(map.cols.vol));
    const amount = map.cols.amount ? Number(pick(map.cols.amount)) : 0;
    if (!tradeDate || !Number.isFinite(close)) continue;
    rows.push({
      tradeDate,
      open,
      high,
      low,
      close,
      vol: Number.isFinite(vol) ? vol : 0,
      amount: Number.isFinite(amount) ? amount : 0,
    });
  }
  return rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

// Walks a dotted path ("data.klines") into a parsed JSON payload. Exported
// for the wizard's manual "pick this array" interaction.
export function digPathValue(json: any, path: string): unknown {
  let node: any = json;
  if (!path) return node;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

// Reads one column off a row: numeric index for array rows, field name for
// object rows.
export function pickRowColumn(row: any, rowKind: "array" | "object", col: string | undefined): unknown {
  if (col === undefined || col === "") return undefined;
  if (rowKind === "array") {
    if (!Array.isArray(row)) return undefined;
    const index = Number(col);
    return Number.isInteger(index) ? row[index] : undefined;
  }
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  return row[col];
}

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
