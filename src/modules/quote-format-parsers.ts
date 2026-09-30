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
// followed by a time part) keeps its leading date; "YYYYQn" snaps to the
// quarter's last day; otherwise strips non-digits — 8 digits pass through,
// 6 digits (19/20xx + valid month) snap to the month's last day, 10/13
// digits are epoch seconds/milliseconds. Low-frequency series (monthly CPI,
// quarterly GDP) snap to the PERIOD END, matching the data-adapter
// convention that a resampled bar carries the period's last trade date.
// Shared by the custom quote client and the format heuristics below.
export function normalizeJsonDate(raw: unknown): string {
  const text = String(raw ?? "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + iso[2] + iso[3];
  const quarter = text.match(/^(\d{4})[Qq]([1-4])$/);
  if (quarter) return monthEnd(quarter[1], String(Number(quarter[2]) * 3));
  const digits = text.replace(/\D/g, "");
  if (digits.length === 8) return digits;
  if (digits.length === 6 && /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])$/.test(digits)) {
    return monthEnd(digits.slice(0, 4), digits.slice(4, 6));
  }
  if (digits.length === 10) return formatDate(new Date(Number(digits) * 1000));
  if (digits.length === 13) return formatDate(new Date(Number(digits)));
  return "";
}

// Last calendar day of the given year/month ("2024", "12" → "20241231").
// Day 0 of the next month is the last day of this one.
function monthEnd(year: string, month: string): string {
  const d = new Date(Number(year), Number(month), 0);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
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
// Success is judged by map.okValues when configured (string-compared, so
// 200 and "200" both match), otherwise by the falsy rule (0/""/null = ok).
export function extractApiError(json: any, map: JsonSourceMap): string | null {
  if (!map.errorPath) return null;
  const value: unknown = digPathValue(json, map.errorPath);
  if (map.okValues && map.okValues.length > 0) {
    if (value === null || value === undefined) return null;
    if (map.okValues.some((ok) => String(ok) === String(value))) return null;
  } else {
    if (value === null || value === undefined || value === "" || value === 0 || value === "0") return null;
  }
  const message = map.errorMessagePath ? String(digPathValue(json, map.errorMessagePath) ?? "").trim() : "";
  return message || `API error (code: ${String(value)})`;
}

// Drop diagnostics for parseMappedKline: rows skipped because their date
// cell could not be normalized (e.g. an unsupported period format) are
// counted, and the first offending raw value is kept for error messages.
// Rows dropped for a non-finite close are NOT counted in `dropped` — a
// missing value is a normal sparse-data case, while an unparseable date
// means a mapping or format mistake the user should hear about.
// The remaining fields distinguish "sparse data" from "misspelled column
// name": when EVERY row comes back with an empty date or close cell, the
// mapped column almost certainly doesn't exist in the response.
// `missingClose` (empty cell: null/undefined/"") is counted separately from
// `badClose` (a non-empty but non-numeric value like "N/A"): the former is
// sparse data, the latter hints at a format mismatch. Both row kinds are
// dropped — a missing close is never silently turned into a 0.
export interface KlineParseStats {
  dropped: number;
  firstBadDate?: string;
  total?: number;          // raw rows seen (before any dropping)
  emptyDate?: number;      // rows whose date cell held no value at all (vs dropped = non-empty but unparseable)
  badClose?: number;       // rows with a valid date but a non-numeric close value ("N/A", "–")
  missingClose?: number;   // rows with a valid date but an EMPTY close cell (null/""/absent) — sparse data
  unmappedCols?: string[]; // rowKind "fields": cols entries ("date=\"trade_dtae\"") absent from the response's fields list
  availableFields?: string[]; // response field names (rowKind "fields" list / first object row's keys), for diagnostics
  truncated?: { fetched: number; total?: number }; // paginated fetch stopped short: paging hit maxPages, or the declared total (totalPath) exceeds what was fetched — the window is likely incomplete
}

// Parses rows with a guessed/explicit mapping — used by the wizard preview.
// Pass a stats object to count rows dropped on unparseable dates and to
// collect column-mapping diagnostics (see KlineParseStats).
export function parseMappedKline(json: any, map: JsonSourceMap, stats?: KlineParseStats): OhlcvRow[] {
  // rowKind "fields": resolve the column NAMES against the name list at
  // fieldsPath once per response, then parse as array rows. A name missing
  // from the list becomes unmapped (OHLC falls back to close below).
  if (map.rowKind === "fields") {
    if (stats) {
      // Set-diff the requested column names against the response's own
      // fields list: a misspelled name shows up here verbatim, before a
      // single row is parsed.
      const rawFields: unknown = digPathValue(json, map.fieldsPath ?? "");
      const fields = Array.isArray(rawFields) ? rawFields.map((f) => String(f)) : [];
      stats.availableFields = fields;
      const missing: string[] = [];
      for (const [label, col] of Object.entries(map.cols)) {
        if (col && !col.includes("{code}") && !fields.includes(col)) missing.push(`${label}="${col}"`);
      }
      if (missing.length > 0) stats.unmappedCols = missing;
    }
    map = resolveFieldsMap(json, map);
  }
  // rowKind "map"/"columns": materialize an object-row array first (the map
  // key lands in "$key", parallel arrays are zipped into synthetic "$date"
  // /"$open"/… fields), then parse as object rows.
  let raw: unknown;
  if (map.rowKind === "map" || map.rowKind === "columns") {
    const node: unknown = digPathValue(json, map.rowsPath);
    const materialized = materializeRows(node, map, stats);
    raw = materialized.rows;
    map = materialized.map;
  } else {
    raw = digPathValue(json, map.rowsPath);
  }
  if (!Array.isArray(raw)) return [];
  if (stats) {
    stats.total = raw.length;
    if (!stats.availableFields && map.rowKind === "object") {
      const first = raw.find((r) => r !== null && typeof r === "object" && !Array.isArray(r));
      if (first) stats.availableFields = Object.keys(first);
    }
  }
  const percentScale = map.percentScale && map.percentScale > 0 ? map.percentScale : 1;
  const rows: OhlcvRow[] = [];
  for (const r of raw) {
    const pick = (col: string | undefined) => pickRowColumn(r, map.rowKind, col);
    const dateCell = pick(map.cols.date);
    const tradeDate = normalizeJsonDate(dateCell);
    const closeCell = pick(map.cols.close);
    const open = parseNumericCell(pick(map.cols.open), percentScale);
    const close = parseNumericCell(closeCell, percentScale);
    const high = parseNumericCell(pick(map.cols.high), percentScale);
    const low = parseNumericCell(pick(map.cols.low), percentScale);
    const vol = parseNumericCell(pick(map.cols.vol), percentScale);
    const amount = map.cols.amount ? parseNumericCell(pick(map.cols.amount), percentScale) : 0;
    if (!tradeDate) {
      // Only non-empty cells count as dropped: an empty date is sparse data
      // (counted separately), a non-empty unparseable one is a
      // format/mapping mistake.
      if (stats) {
        if (dateCell === undefined || dateCell === null || String(dateCell).trim() === "") {
          stats.emptyDate = (stats.emptyDate ?? 0) + 1;
        } else {
          stats.dropped++;
          if (stats.firstBadDate === undefined) {
            stats.firstBadDate = String(dateCell);
          }
        }
      }
      continue;
    }
    if (!Number.isFinite(close)) {
      // Missing (null/undefined/"") and unparseable ("N/A") are counted
      // apart; both skip the row — Number(null) === 0 must never turn a
      // missing close into a zero-price bar.
      if (stats) {
        if (closeCell === undefined || closeCell === null || String(closeCell).trim() === "") {
          stats.missingClose = (stats.missingClose ?? 0) + 1;
        } else {
          stats.badClose = (stats.badClose ?? 0) + 1;
        }
      }
      continue;
    }
    // Unmapped/missing OHLC fall back to close, so close-only mappings
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
      // A missing vol/amount cell is not a data error — "no turnover
      // reported" reads as 0 by design (unlike close, which skips the row).
      vol: Number.isFinite(vol) ? vol : 0,
      amount: Number.isFinite(amount) ? amount : 0,
    });
  }
  return rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

// Parses one numeric cell. null/undefined/empty-string are MISSING (NaN),
// never 0 — Number(null) === 0 would silently turn a missing close into a
// zero-price bar. Thousands separators, currency symbols and surrounding
// whitespace are stripped ("$1,234.50" → 1234.5); a trailing % divides by
// percentScale (1 keeps the printed number, 100 turns "1.5%" into 0.015).
// Anything still unparseable is NaN.
export function parseNumericCell(raw: unknown, percentScale: number = 1): number {
  if (raw === null || raw === undefined) return NaN;
  if (typeof raw === "number") return raw;
  let s = String(raw).trim();
  if (s === "") return NaN;
  let percent = false;
  if (s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(/[$€£¥,\s]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return percent ? n / percentScale : n;
}

// Materializes rowKind "map" / "columns" payloads into an object-row array
// plus an equivalent "object" mapping.
//   map     — rowsPath points to a date-keyed object: each entry is one row;
//             the key lands in the "$key" field (cols.date: "$key"), a scalar
//             value in "$value".
//   columns — each cols value is the path of a parallel array relative to
//             the rowsPath node; row i = every column's i-th element. A
//             scalar instead of an array is a single-row series (snapshot
//             endpoints). Row length follows the date column.
function materializeRows(node: unknown, map: JsonSourceMap, stats?: KlineParseStats): { rows: unknown[]; map: JsonSourceMap } {
  if (map.rowKind === "map") {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return { rows: [], map };
    const rows = Object.entries(node).map(([key, value]) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? { ...value, $key: key }
        : { $key: key, $value: value },
    );
    return { rows, map: { ...map, rowKind: "object" } };
  }
  // columns
  if (node === null || typeof node !== "object" || Array.isArray(node)) return { rows: [], map };
  const keys = ["date", "open", "close", "high", "low", "vol", "amount"] as const;
  const colArrays = keys.map((k) => {
    const path = map.cols[k];
    if (!path) return undefined;
    const v: unknown = digPathValue(node, path);
    if (Array.isArray(v)) return v;
    if (v === undefined || v === null) return undefined;
    return [v];
  });
  const length = colArrays[0]?.length ?? 0;
  const rows: unknown[] = [];
  for (let i = 0; i < length; i++) {
    rows.push(Object.fromEntries(keys.map((k, c) => [`$${k}`, colArrays[c]?.[i]])));
  }
  if (stats) stats.availableFields = Object.keys(node);
  return {
    rows,
    map: {
      ...map,
      rowKind: "object",
      cols: {
        date: "$date",
        open: colArrays[1] ? "$open" : "",
        close: colArrays[2] ? "$close" : "",
        high: colArrays[3] ? "$high" : "",
        low: colArrays[4] ? "$low" : "",
        vol: colArrays[5] ? "$vol" : "",
        ...(map.cols.amount ? { amount: colArrays[6] ? "$amount" : "" } : {}),
      },
    },
  };
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

// Substitutes placeholders in column mappings: {code} resolves to the
// requested (map-half) code — fixed-report sources (one URL, many series as
// columns — e.g. a yield curve with one tenor per column) map close to
// "{code}" so the requested code picks the column, the same way it would
// pick a URL slot for kline sources — and {p.<name>} resolves to the
// symbol's params (raw, never URL-encoded: these are field names), so
// symbols whose columns differ (stock OHLC vs fx bid_close, month vs
// quarter date columns) can share one source.
// Note on "@": a composite "code@variant" only reaches here when cols
// contains a {code} placeholder — with plain column names the map-half is
// ignored, so same-code variants ("DGS10@lin") must be expressed as
// symbol-level params ({p.*}) instead of @ suffixes.
export function resolveMapCode(map: JsonSourceMap, code: string, params?: Record<string, string>): JsonSourceMap {
  const sub = (value: string): string => {
    let out = value;
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (out.includes(`{p.${key}}`)) out = out.replaceAll(`{p.${key}}`, val);
      }
    }
    return out.includes("{code}") ? out.replaceAll("{code}", code) : out;
  };
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
// object rows — a DOTTED name ("quote.close") walks nested objects via
// digPathValue. rowKind "fields" never reaches here — parseMappedKline
// resolves it to "array" first; the union is accepted so callers holding a
// JsonSourceMap can pass map.rowKind without narrowing. ("map"/"columns"
// are likewise materialized to "object" rows before the row loop.)
export function pickRowColumn(row: any, rowKind: JsonSourceMap["rowKind"], col: string | undefined): unknown {
  if (col === undefined || col === "") return undefined;
  if (rowKind === "array" || rowKind === "fields") {
    if (!Array.isArray(row)) return undefined;
    const index = Number(col);
    return Number.isInteger(index) ? row[index] : undefined;
  }
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  return col.includes(".") ? digPathValue(row, col) : row[col];
}

// Parses a generic-JSON search / symbol-list response: rows dug out at
// searchRowsPath, columns picked per searchCols. rowKind "fields" resolves
// searchCols the same way parseMappedKline resolves cols — a column NAME is
// looked up in the fieldsPath list, while an integer string passes through
// as a column index (so both spellings work in searchCols).
// stats.skipped (when a stats object is passed) counts rows dropped for a
// missing code or name — e.g. delisted rows whose name column comes back
// null; whole interfaces would otherwise vanish silently.
export function parseMappedSearch(json: any, map: JsonSourceMap | undefined, stats?: { skipped?: number }): SymbolItem[] {
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
    if (!code || !name) {
      if (stats) stats.skipped = (stats.skipped ?? 0) + 1;
      continue;
    }
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
