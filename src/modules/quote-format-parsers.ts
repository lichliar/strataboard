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

// Normalizes a date cell to YYYYMMDD. ISO-ish "YYYY-MM-DD" (optionally
// followed by a time part) keeps its leading date; otherwise strips
// non-digits — 8 digits pass through, 10/13 digits are epoch
// seconds/milliseconds. Shared by the custom quote client and the format
// heuristics below.
export function normalizeJsonDate(raw: unknown): string {
  const text = String(raw ?? "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + iso[2] + iso[3];
  const digits = text.replace(/\D/g, "");
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
  if (!Array.isArray(row) || row.length < 2) return null;
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
  if (o === undefined) return null;
  if (c === undefined || h === undefined || l === undefined) {
    // Not a kline layout — treat it as a single-value series (yields,
    // indices) and map only the close column.
    cols.close = String(o);
    return cols;
  }
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
  const high = pickBy(NAME_KEYS.high);
  const low = pickBy(NAME_KEYS.low);
  const vol = pickBy(NAME_KEYS.vol);
  // Close falls back to the first unmatched numeric field so single-value
  // series (yields, macro readings) with opaque field names still guess.
  const taken = new Set([date, open, high, low, vol].filter((f): f is string => Boolean(f)));
  const close =
    pickBy(NAME_KEYS.close) ??
    fields.find((f) => !taken.has(f) && String(row[f] ?? "").trim() !== "" && Number.isFinite(Number(row[f])));
  if (!close) return null;
  const cols: JsonSourceMap["cols"] = { date, open: open ?? "", close, high: high ?? "", low: low ?? "", vol: vol ?? "" };
  const amount = pickBy(AMOUNT_KEYS);
  if (amount) cols.amount = amount;
  return cols;
}

// Best-effort generic JSON mapping: the Tushare-style fields+items shape is
// recognized first, then the first row-list candidate that guesses cleanly.
// The wizard previews the parsed rows so a wrong guess is caught by the user.
export function detectJsonMapping(json: any): JsonSourceMap | null {
  const fieldsMap = detectFieldsMapping(json);
  if (fieldsMap) return fieldsMap;
  for (const candidate of findRowCandidates(json)) {
    const cols = guessCols(candidate);
    if (cols) return { rowsPath: candidate.rowsPath, rowKind: candidate.rowKind, cols };
  }
  return null;
}

// Recognizes the Tushare response shape {data:{fields: string[], items:
// any[][]}} (a column-name list next to an array-of-arrays row list, at any
// depth) and emits a rowKind "fields" mapping. Column names are matched
// against the same dictionaries as object rows (trade_date/date → date,
// open/high/low/close/vol, amount); date + close alone count as a success.
function detectFieldsMapping(json: any): JsonSourceMap | null {
  return findFieldsMappings(json)[0] ?? null;
}

// Finds every fields+items node in the payload and emits a rowKind "fields"
// mapping for each one that guesses cleanly. Exported for the setup wizard's
// 数据列表 dropdown, which offers these alongside the plain row lists.
export function findFieldsMappings(json: any): JsonSourceMap[] {
  const found: JsonSourceMap[] = [];
  const queue: { node: any; path: string }[] = [{ node: json, path: "" }];
  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
    const fields: unknown = node.fields;
    const items: unknown = node.items;
    if (
      Array.isArray(fields) && fields.length > 0 && fields.every((f) => typeof f === "string") &&
      Array.isArray(items) && items.length > 0 && items.every((r) => Array.isArray(r))
    ) {
      const cols = guessFieldsCols(fields, items[0]);
      if (cols) {
        const prefix = path ? `${path}.` : "";
        found.push({ rowsPath: `${prefix}items`, rowKind: "fields", fieldsPath: `${prefix}fields`, cols });
      }
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      // Row lists are leaf data; never descend into arrays.
      if (child !== null && typeof child === "object" && !Array.isArray(child)) {
        queue.push({ node: child, path: path ? `${path}.${key}` : key });
      }
    }
  }
  return found;
}

// Column-name guess for a fields+items payload: each field matched by name
// dictionary, with a value-based fallback for the date and close columns.
function guessFieldsCols(fields: string[], firstRow: any[]): JsonSourceMap["cols"] | null {
  const pickBy = (candidates: string[]): string | undefined => fields.find((f) => matchName(f, candidates));
  const date = pickBy(NAME_KEYS.date) ?? fields.find((_, i) => normalizeJsonDate(firstRow?.[i]) !== "");
  if (!date) return null;
  const open = pickBy(NAME_KEYS.open);
  const high = pickBy(NAME_KEYS.high);
  const low = pickBy(NAME_KEYS.low);
  const vol = pickBy(NAME_KEYS.vol);
  // Close falls back to the first unmatched numeric field, so single-value
  // series (yields, macro readings) with opaque field names still guess.
  const taken = new Set([date, open, high, low, vol].filter((f): f is string => Boolean(f)));
  const close =
    pickBy(NAME_KEYS.close) ??
    fields.find((f, i) => !taken.has(f) && Number.isFinite(Number(firstRow?.[i])));
  if (!close) return null;
  const cols: JsonSourceMap["cols"] = { date, open: open ?? "", close, high: high ?? "", low: low ?? "", vol: vol ?? "" };
  const amount = pickBy(AMOUNT_KEYS);
  if (amount) cols.amount = amount;
  return cols;
}

// Business-level error check for APIs that report failures inside a 200
// response (e.g. Tushare's {code, msg}: code 0 means success). Returns the
// message at errorMessagePath, or a generic text when the response carries
// none; null when no errorPath is configured or the indicator says success.
export function extractApiError(json: any, map: JsonSourceMap): string | null {
  if (!map.errorPath) return null;
  const value: unknown = digPathValue(json, map.errorPath);
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") return null;
  const message = map.errorMessagePath ? String(digPathValue(json, map.errorMessagePath) ?? "").trim() : "";
  return message || `API error (code: ${String(value)})`;
}

// Parses rows with a guessed/explicit mapping — used by the wizard preview.
export function parseMappedKline(json: any, map: JsonSourceMap): OhlcvRow[] {
  // rowKind "fields": resolve the column NAMES against the name list at
  // fieldsPath once per response, then parse as array rows. A name missing
  // from the list becomes unmapped (OHLC falls back to close below).
  if (map.rowKind === "fields") map = resolveFieldsMap(json, map);
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
    // Unmapped/non-finite OHLC fall back to close, so close-only mappings
    // (single-value series like yields) still form valid candles.
    const o = Number.isFinite(open) ? open : close;
    const h = Number.isFinite(high) ? high : Math.max(o, close);
    const l = Number.isFinite(low) ? low : Math.min(o, close);
    rows.push({
      tradeDate,
      open: o,
      high: h,
      low: l,
      close,
      vol: Number.isFinite(vol) ? vol : 0,
      amount: Number.isFinite(amount) ? amount : 0,
    });
  }
  return rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

// Resolves a rowKind "fields" mapping into an equivalent "array" mapping:
// each col's column name is looked up in the name list at fieldsPath, and a
// name not present becomes "" (unmapped). Resolved once per response, not
// per row.
function resolveFieldsMap(json: any, map: JsonSourceMap): JsonSourceMap {
  const raw: unknown = digPathValue(json, map.fieldsPath ?? "");
  const fields = Array.isArray(raw) ? raw.map((f) => String(f)) : [];
  const indexOf = (name: string | undefined): string => {
    if (!name) return "";
    const index = fields.indexOf(name);
    return index >= 0 ? String(index) : "";
  };
  return {
    ...map,
    rowKind: "array",
    cols: {
      date: indexOf(map.cols.date),
      open: indexOf(map.cols.open),
      close: indexOf(map.cols.close),
      high: indexOf(map.cols.high),
      low: indexOf(map.cols.low),
      vol: indexOf(map.cols.vol),
      amount: map.cols.amount ? indexOf(map.cols.amount) : undefined,
    },
  };
}

// Splits a composite code "URL部分@映射部分" (e.g. "REPORTNAME@COLUMN" for
// wide-table report sources): the part before "@" fills {code} in URL
// templates, the part after fills {code} in column mappings. Plain codes
// (no "@") fill both — single-dimension sources are unaffected.
export function splitCompositeCode(code: string): { urlCode: string; mapCode: string } {
  const at = code.indexOf("@");
  if (at < 0) return { urlCode: code, mapCode: code };
  return { urlCode: code.slice(0, at), mapCode: code.slice(at + 1) };
}

// Substitutes the {code} placeholder in column mappings. Fixed-report
// sources (one URL, many series as columns — e.g. a yield curve with one
// tenor per column) map close to "{code}" so the requested code picks the
// column, the same way it would pick a URL slot for kline sources.
export function resolveMapCode(map: JsonSourceMap, code: string): JsonSourceMap {  const sub = (value: string): string => (value.includes("{code}") ? value.replaceAll("{code}", code) : value);
  const cols = map.cols;
  return {
    ...map,
    cols: {
      date: sub(cols.date),
      open: sub(cols.open),
      close: sub(cols.close),
      high: sub(cols.high),
      low: sub(cols.low),
      vol: sub(cols.vol),
      amount: cols.amount ? sub(cols.amount) : undefined,
    },
  };
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
// object rows. rowKind "fields" never reaches here — parseMappedKline
// resolves it to "array" first; the union is accepted so callers holding a
// JsonSourceMap can pass map.rowKind without narrowing.
export function pickRowColumn(row: any, rowKind: JsonSourceMap["rowKind"], col: string | undefined): unknown {
  if (col === undefined || col === "") return undefined;
  if (rowKind === "array" || rowKind === "fields") {
    if (!Array.isArray(row)) return undefined;
    const index = Number(col);
    return Number.isInteger(index) ? row[index] : undefined;
  }
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  return row[col];
}

// Parses a generic-JSON search / symbol-list response: rows dug out at
// searchRowsPath, columns picked per searchCols. rowKind "fields" resolves
// searchCols the same way parseMappedKline resolves cols — a column NAME is
// looked up in the fieldsPath list, while an integer string passes through
// as a column index (so both spellings work in searchCols).
export function parseMappedSearch(json: any, map: JsonSourceMap | undefined): SymbolItem[] {
  if (!map?.searchRowsPath || !map.searchCols) return [];
  let rowKind = map.rowKind;
  let cols = map.searchCols;
  if (rowKind === "fields") {
    const rawFields: unknown = digPathValue(json, map.fieldsPath ?? "");
    const fields = Array.isArray(rawFields) ? rawFields.map((f) => String(f)) : [];
    const indexOf = (col: string | undefined): string | undefined => {
      if (!col) return undefined;
      if (Number.isInteger(Number(col))) return col;
      const index = fields.indexOf(col);
      return index >= 0 ? String(index) : undefined;
    };
    rowKind = "array";
    cols = {
      code: indexOf(cols.code) ?? "",
      name: indexOf(cols.name) ?? "",
      ...(cols.market ? { market: indexOf(cols.market) } : {}),
    };
  }
  const raw: unknown = digPathValue(json, map.searchRowsPath);
  if (!Array.isArray(raw)) return [];
  const items: SymbolItem[] = [];
  for (const r of raw) {
    const code = String(pickRowColumn(r, rowKind, cols.code) ?? "").trim();
    const name = String(pickRowColumn(r, rowKind, cols.name) ?? "").trim();
    if (!code || !name) continue;
    items.push({
      tsCode: code,
      symbol: code,
      name,
      exchange: cols.market ? String(pickRowColumn(r, rowKind, cols.market) ?? "") : "",
      assetType: "custom",
    });
  }
  return items;
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
