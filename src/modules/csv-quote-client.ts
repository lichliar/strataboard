import * as Papa from "papaparse";
import type { CustomSourceDef, JsonSourceMap, OhlcvRow, SignalEvent, SymbolListEntry } from "../types";
import { normalizeJsonDate, parseMappedKline, resolveMapCode, splitCompositeCode } from "./quote-format-parsers";
import { fetchSourceText } from "./custom-quote-client";
import { resolveSymbolParams } from "../utils/symbol-list";
import { t } from "../i18n";

// Quote client for format "csv" custom sources: a vault-local CSV file
// (filePath, via the injected readFile — main.ts wires app.vault.cachedRead)
// or a remote CSV/TSV endpoint (klineUrl, fetched like any HTTP source).
// The whole payload is re-read on every fetch — reads are cheap and the
// cache merge is idempotent, so there is no mtime logic.
//
// The header line keys every row as an object, so the shared jsonMap
// machinery applies unchanged: def.jsonMap is { rowsPath: "", rowKind:
// "object", cols }, and cols.close "{code}" gives the wide-table mode (each
// numeric column one series, the requested code picking the column).
export class CsvQuoteClient {
  constructor(private def: CustomSourceDef, private readFile: (path: string) => Promise<string>) {}

  async fetchKline(code: string, start: string, end: string): Promise<OhlcvRow[]> {
    if (!this.def.filePath && !this.def.klineUrl) {
      throw new Error(t("CSV 数据源「{name}」缺少文件路径或 URL 配置。", { name: this.def.name }));
    }
    if (!this.def.jsonMap) {
      throw new Error(t("CSV 数据源「{name}」缺少列映射配置。", { name: this.def.name }));
    }
    const text = this.def.filePath
      ? await this.readFile(this.def.filePath)
      : await fetchSourceText(this.def, code, start, end);
    return parseCsvKline(text, this.def.jsonMap, splitCompositeCode(code).mapCode, resolveSymbolParams(this.def, code))
      .filter((row) => row.tradeDate >= start && row.tradeDate <= end);
  }
}

export interface CsvTable {
  fields: string[];                      // header columns, in file order
  rows: Record<string, unknown>[];       // data rows keyed by header
}

// Parses raw CSV text into a header-keyed table. Exported for the setup
// wizard's column preview. A leading BOM is stripped (Excel exports).
export function parseCsvTable(text: string): CsvTable {
  // Strip a leading BOM (Excel exports) before parsing.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result = Papa.parse<Record<string, unknown>>(body, {
    header: true,
    skipEmptyLines: true,
  });
  return { fields: result.meta.fields ?? [], rows: result.data };
}

// Pure CSV → OhlcvRow parse shared by the client, the setup wizard's 保存前
// 测试解析, and node smoke tests. `code` resolves {code} placeholders in the
// mapping (wide-table column pick); pass "" for fixed (OHLCV) mappings.
// `params` resolves {p.<name>} placeholders the same way (symbol-level
// column names). A blank close cell means "no data that day" (脚本产物契约) —
// the row is dropped up front so Number("") can't parse it as a zero close.
export function parseCsvKline(text: string, map: JsonSourceMap, code: string, params?: Record<string, string>): OhlcvRow[] {
  const resolved = resolveMapCode(map, code, params);
  const closeCol = resolved.cols.close;
  const rows = parseCsvTable(text).rows.filter((r) => String(r[closeCol] ?? "").trim() !== "");
  return parseMappedKline(rows, { ...resolved, rowsPath: "", rowKind: "object" });
}

const OHLCV_KEYS = ["open", "high", "low", "close"] as const;

// Derives the jsonMap column mapping + symbol table from a parsed CSV table:
// OHLCV mode when open/high/low/close columns all exist (one series per
// file), wide-table mode otherwise (cols.close "{code}", one series per
// numeric column). `prev` carries earlier choices so a re-derivation keeps a
// still-valid date column and user-renamed symbols; `fallbackCode` names the
// OHLCV mode's single series when there is no previous symbol. cols.date may
// come back "" when no column looks like a date — callers validate before
// saving/registering. Shared by the CSV setup wizard and the script-output
// auto-registration (script-sources.ts); pure, so node-exercisable.
export function deriveCsvMapping(
  table: CsvTable,
  prev?: { dateCol?: string; symbols?: SymbolListEntry[]; fallbackCode?: string }
): { jsonMap: JsonSourceMap; symbols: SymbolListEntry[]; mode: "ohlcv" | "wide" } {
  const first = table.rows[0] ?? {};
  const findCol = (names: readonly string[]) =>
    table.fields.find((f) => names.includes(f.toLowerCase().replace(/[_\s]/g, "")));
  const ohlcv = OHLCV_KEYS.every((key) => findCol([key])) ? OHLCV_KEYS.map((key) => findCol([key])!) : null;

  const cols: JsonSourceMap["cols"] = { date: "", open: "", close: "", high: "", low: "", vol: "" };
  const prevDate = prev?.dateCol;
  cols.date =
    prevDate && table.fields.includes(prevDate)
      ? prevDate
      : findCol(["date", "time", "datetime", "日期"]) ??
        table.fields.find((f) => normalizeJsonDate(first[f]) !== "") ??
        "";

  let symbols: SymbolListEntry[];
  let mode: "ohlcv" | "wide";
  if (ohlcv) {
    // OHLCV mode: one series per file; the requested code is irrelevant to
    // the mapping (no {code}), symbols carries a single entry.
    [cols.open, cols.high, cols.low, cols.close] = ohlcv;
    cols.vol = findCol(["vol", "volume"]) ?? "";
    cols.amount = findCol(["amount", "turnover"]) || undefined;
    const code = prev?.symbols?.[0]?.code ?? prev?.fallbackCode ?? "csv";
    symbols = [{ code, name: prev?.symbols?.[0]?.name ?? code }];
    mode = "ohlcv";
  } else {
    // Wide-table mode: close is the {code} placeholder; every numeric column
    // except the date column is one series.
    cols.close = "{code}";
    const existing = prev?.symbols ?? [];
    symbols = table.fields
      .filter((f) => f !== cols.date && String(first[f] ?? "").trim() !== "" && Number.isFinite(Number(first[f])))
      .map((f) => existing.find((s) => s.code === f) ?? { code: f, name: f });
    mode = "wide";
  }
  return { jsonMap: { rowsPath: "", rowKind: "object", cols }, symbols, mode };
}

// ==================== Signal event tables (信号表) ====================

// Column aliases for the script-contract signal table (date,code,side,text).
const SIGNAL_DATE_COLS = ["date", "time", "datetime", "日期"] as const;
const SIGNAL_CODE_COLS = ["code", "symbol", "代码"] as const;
const SIGNAL_SIDE_COLS = ["side", "direction", "方向"] as const;

function findField(fields: string[], names: readonly string[]): string | undefined {
  return fields.find((f) => names.includes(f.toLowerCase().replace(/[_\s]/g, "") as never));
}

// A CSV is a signal event table when it carries a date, a code and a side
// column. Checked BEFORE the quote-shape derivation (script-sources.ts), so
// event tables never get misclassified as wide tables.
export function isSignalTable(fields: string[]): boolean {
  return Boolean(
    findField(fields, SIGNAL_DATE_COLS) &&
    findField(fields, SIGNAL_CODE_COLS) &&
    findField(fields, SIGNAL_SIDE_COLS)
  );
}

const SIDE_MAP: Record<string, SignalEvent["side"]> = {
  buy: "buy",
  sell: "sell",
  "买": "buy",
  "卖": "sell",
};

// Parses a signal event table into normalized events. Rows with an
// unparseable date, empty code or unrecognized side are dropped and counted
// (sparse annotations are fine; silently halving them is not). Event dates
// normalize to YYYYMMDD via the shared normalizeJsonDate.
export function parseSignalTable(text: string): { events: SignalEvent[]; dropped: number; total: number } {
  const table = parseCsvTable(text);
  const dateCol = findField(table.fields, SIGNAL_DATE_COLS);
  const codeCol = findField(table.fields, SIGNAL_CODE_COLS);
  const sideCol = findField(table.fields, SIGNAL_SIDE_COLS);
  const textCol = findField(table.fields, ["text", "note", "备注"]);
  const events: SignalEvent[] = [];
  let dropped = 0;
  if (!dateCol || !codeCol || !sideCol) {
    return { events, dropped: table.rows.length, total: table.rows.length };
  }
  for (const row of table.rows) {
    const date = normalizeJsonDate(row[dateCol]);
    const code = String(row[codeCol] ?? "").trim();
    const side = SIDE_MAP[String(row[sideCol] ?? "").trim().toLowerCase()];
    if (!date || !code || !side) {
      dropped++;
      continue;
    }
    const text = String(row[textCol ?? ""] ?? "").trim();
    events.push({ date, code, side, ...(text ? { text } : {}) });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  return { events, dropped, total: table.rows.length };
}
