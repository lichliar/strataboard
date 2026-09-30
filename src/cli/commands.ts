// Command implementations shared by the standalone CLI (src/cli/main.ts) and
// the MCP stdio server (src/mcp/server.ts). Each function takes structured
// input plus a VaultContext and returns the full result object (the same
// shape the CLI prints as JSON); user-facing failures throw CliError.

import * as fs from "fs";
import * as path from "path";
import initSqlJs from "sql.js";
import { parseCardSpec } from "../modules/card-spec";
import {
  parseOverlaySpec,
  parseSpreadSpec,
} from "../modules/series-spec";
import { setRequestInterval } from "../modules/http";
import { CustomQuoteClient, fetchKlineSample, type SearchFetchStats } from "../modules/custom-quote-client";
import { CsvQuoteClient } from "../modules/csv-quote-client";
import type { KlineParseStats } from "../modules/quote-format-parsers";
import { hasCodeSpecificParams, auditSearchCoverage, compileDeadCodes, type SearchCoverageAudit } from "../utils/symbol-list";
import { formatDate } from "../utils/date";
import {
  ASSET_TYPES,
  KNOWN_JSON_MAP_KEYS,
  KNOWN_SOURCE_DEF_KEYS,
  resolveApiKeySource,
  resolveGroupApiKey,
  searchProbeQuery,
  sourceNeedsApiKey,
  sourceSupportsRemoteSearch,
  type AssetType,
  type CustomSourceDef,
} from "../types";

const PLUGIN_ID = "strataboard";

// Subset of StrataBoardSettings the CLI/MCP read; defaults mirror settings.ts.
export interface CliSettings {
  customSources?: CustomSourceDef[];
  symbolCachePath?: string;
  requestIntervalMs?: number;
}

export interface VaultContext {
  vault: string;
  settings: CliSettings;
}

export class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

// Vault resolution: explicit path (--vault / STRATABOARD_VAULT) wins;
// otherwise walk up from cwd looking for a .obsidian folder.
export function resolveVaultDir(explicit?: string): string {
  if (explicit) {
    const dir = path.resolve(explicit);
    if (!fs.existsSync(path.join(dir, ".obsidian"))) {
      fail(`指定的目录不是 Obsidian vault（缺少 .obsidian）: ${dir}`);
    }
    return dir;
  }
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, ".obsidian"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      fail("未找到 vault：请用 --vault 参数或 STRATABOARD_VAULT 环境变量指定 vault 根目录，或在 vault 内的目录下运行。");
    }
    dir = parent;
  }
}

function loadSettings(vault: string): CliSettings {
  const file = path.join(vault, ".obsidian", "plugins", PLUGIN_ID, "data.json");
  if (!fs.existsSync(file)) {
    fail(`找不到插件设置文件: ${file}（请确认该 vault 已安装并启用过 StrataBoard 插件）。`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CliSettings;
  } catch (e) {
    fail(`插件设置文件解析失败: ${file} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Resolves the vault, loads plugin settings, applies the HTTP throttle.
export function createVaultContext(vaultOverride?: string): VaultContext {
  const vault = resolveVaultDir(vaultOverride);
  const settings = loadSettings(vault);
  setRequestInterval(settings.requestIntervalMs ?? 500);
  return { vault, settings };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export interface SearchResultItem {
  tsCode: string;
  symbol: string;
  name: string;
  exchange: string;
  assetType: string;
  sourceId?: string;
  sourceName?: string;
}

export async function searchSymbols(
  ctx: VaultContext,
  opts: { query: string; assetType?: string; limit?: number }
): Promise<{ ok: true; query: string; results: SearchResultItem[] }> {
  const query = opts.query?.trim();
  if (!query) fail("search 需要一个关键词参数，如: search 茅台");
  const type = opts.assetType;
  if (type !== undefined && !ASSET_TYPES.includes(type as AssetType)) {
    fail(`无效的资产类型: ${type}（应为 ${ASSET_TYPES.join(" | ")}）。`);
  }
  const limit = opts.limit ?? 20;

  const results: SearchResultItem[] = [];
  const lower = query.toLowerCase();

  // Static code tables of custom sources (not necessarily in symbols.db).
  for (const def of ctx.settings.customSources ?? []) {
    for (const s of def.symbols ?? []) {
      if (type !== undefined && type !== "custom") continue;
      if (!s.code.toLowerCase().includes(lower) && !s.name.toLowerCase().includes(lower)) continue;
      results.push({
        tsCode: s.code,
        symbol: s.code,
        name: s.name,
        exchange: "",
        assetType: "custom",
        sourceId: def.id,
        sourceName: def.name,
      });
    }
  }

  // Local symbol cache (same LOWER LIKE match as SqliteCache.searchSymbols,
  // plus relevance ordering: exact code hit first, then prefix, then the rest).
  const dbPath = path.join(ctx.vault, ctx.settings.symbolCachePath ?? "金融卡片/股票代码缓存", "symbols.db");
  if (fs.existsSync(dbPath)) {
    const SQL = await initSqlJs({ locateFile: (f) => path.join(__dirname, f) });
    const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
    try {
      const like = `%${lower}%`;
      const prefix = `${lower}%`;
      const typeFilter =
        type === undefined
          ? ""
          : type === "custom"
            ? "AND (asset_type = 'custom' OR asset_type LIKE 'custom:%')"
            : "AND asset_type = :type";
      const stmt = db.prepare(`
        SELECT ts_code, symbol, name, exchange, asset_type FROM symbols
        WHERE (LOWER(ts_code) LIKE :like OR LOWER(symbol) LIKE :like OR LOWER(name) LIKE :like)
        ${typeFilter}
        ORDER BY CASE
          WHEN LOWER(ts_code) = :exact OR LOWER(symbol) = :exact THEN 0
          WHEN LOWER(ts_code) LIKE :prefix OR LOWER(symbol) LIKE :prefix OR LOWER(name) LIKE :prefix THEN 1
          ELSE 2
        END, ts_code
        LIMIT :limit
      `);
      stmt.bind({
        ":like": like,
        ":exact": lower,
        ":prefix": prefix,
        ":type": type ?? "",
        ":limit": limit,
      });
      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>;
        const assetType = String(row.asset_type ?? "");
        // Custom-source cache rows are keyed custom:<sourceId>; report the
        // base type plus the sourceId, like SymbolItem does.
        const custom = assetType.startsWith("custom:");
        results.push({
          tsCode: String(row.ts_code ?? ""),
          symbol: String(row.symbol ?? ""),
          name: String(row.name ?? ""),
          exchange: String(row.exchange ?? ""),
          assetType: custom ? "custom" : assetType,
          ...(custom ? { sourceId: assetType.slice("custom:".length) } : {}),
        });
      }
      stmt.free();
    } finally {
      db.close();
    }
  } else if (results.length === 0) {
    fail(`找不到符号库: ${dbPath}（请先在 Obsidian 里运行一次 StrataBoard 以建立代码缓存）。`);
  }

  return { ok: true, query, results: results.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

export function listSources(ctx: VaultContext): {
  ok: true;
  sources: { id: string; name: string; format: string; enabled: boolean; group?: string; symbolCount: number; isScriptOutput: boolean }[];
} {
  const sources = (ctx.settings.customSources ?? []).map((def) => ({
    id: def.id,
    name: def.name,
    format: def.format,
    enabled: def.enabled,
    group: def.group,
    symbolCount: def.symbols?.length ?? 0,
    // 脚本处理产物自动注册的源，id 形如 script:<文件名>。
    isScriptOutput: def.id.startsWith("script:"),
  }));
  return { ok: true, sources };
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

const KNOWN_BLOCK_TYPES = new Set([
  "quote",
  "overlay",
  "spread",
  "financial-widget",
  "calendar",
]);

export interface BlockCheck {
  lang: string;
  line: number;
  ok: boolean;
  error?: string;
}

// Validates one fenced block body with the same parser the plugin's renderer
// uses for that language. quote/financial-widget/calendar all go through
// parseCardSpec — the renderers distinguish them by the parsed contentType.
function validateBlock(lang: string, body: string): string | undefined {
  switch (lang) {
    case "quote": {
      const r = parseCardSpec(body);
      if (!r.ok) return r.error.message;
      if (r.spec.contentType) return "quote 块不应包含日历/小组件字段。";
      return undefined;
    }
    case "financial-widget": {
      const r = parseCardSpec(body);
      if (!r.ok) return r.error.message;
      if (r.spec.contentType !== "widget" && !r.spec.widgetType) {
        return "financial-widget 块需要 小组件类型 + iframe地址/小组件HTML。";
      }
      return undefined;
    }
    case "calendar": {
      const r = parseCardSpec(body);
      if (!r.ok) return r.error.message;
      if (r.spec.contentType !== "calendar") return "calendar 块需要 日历: true（可选 月份: YYYY-MM）。";
      return undefined;
    }
    case "overlay":
      return parseOverlaySpec(body).error;
    case "spread":
      return parseSpreadSpec(body).error;
    default:
      return undefined;
  }
}

// Validates every StrataBoard fenced block in a markdown document. `label`
// only echoes back into the result so callers can tell inputs apart.
export function validateCards(opts: { markdown: string; label?: string }): {
  ok: boolean;
  label?: string;
  blocks: BlockCheck[];
} {
  const lines = opts.markdown.split(/\r?\n/);
  const blocks: BlockCheck[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^```(\w+)\s*$/);
    if (m && KNOWN_BLOCK_TYPES.has(m[1])) {
      const lang = m[1];
      const startLine = i + 1; // 1-based, points at the opening fence
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i >= lines.length) {
        blocks.push({ lang, line: startLine, ok: false, error: "围栏代码块未闭合。" });
      } else {
        const error = validateBlock(lang, body.join("\n"));
        blocks.push(error ? { lang, line: startLine, ok: false, error } : { lang, line: startLine, ok: true });
      }
    }
    i++;
  }

  const ok = blocks.every((b) => b.ok);
  return { ok, ...(opts.label ? { label: opts.label } : {}), blocks };
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

function recentWindow(days: number): { start: string; end: string } {
  const now = Date.now();
  return {
    start: formatDate(new Date(now - days * 86400000)),
    end: formatDate(new Date(now)),
  };
}

export interface ProbeOutput {
  ok: boolean;
  type: string;
  code: string;
  apiName?: string;
  sourceId?: string;
  rows: number;
  dropped?: number;
  fields?: string[];
  firstDate?: string;
  lastDate?: string;
  lastClose?: number;
  // Where the runtime apiKey comes from (only when the source's templates
  // carry an {apiKey} placeholder): own entry / group member / missing.
  apiKeySource?: "self" | "group" | "none";
  apiKeyDonor?: string;
  // Set when the call succeeded but returned no data — likely reasons
  // (permissions/points, wrong code, too-narrow window, misspelled column).
  hint?: string;
  // Set when a paginated fetch stopped short of the declared total / page
  // cap — the window is likely incomplete.
  truncated?: { fetched: number; total?: number };
}

// Lazily-opened reader for the symbol cache's declared-profile column
// (symbols.db `profile`, written when a search result is picked in the app).
// CLI probes use it so a picked code fetches with the same declared
// classification the runtime card would use. Tolerates databases that
// predate the profile column.
function createDeclaredProfileLookup(ctx: VaultContext): {
  get(sourceId: string, code: string): Promise<string | undefined>;
  close(): Promise<void>;
} {
  const dbPath = path.join(ctx.vault, ctx.settings.symbolCachePath ?? "金融卡片/股票代码缓存", "symbols.db");
  let dbPromise: Promise<import("sql.js").Database | null> | undefined;
  const open = () =>
    (dbPromise ??= (async () => {
      if (!fs.existsSync(dbPath)) return null;
      const SQL = await initSqlJs({ locateFile: (f) => path.join(__dirname, f) });
      return new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
    })());
  return {
    async get(sourceId, code) {
      const db = await open();
      if (!db) return undefined;
      try {
        const stmt = db.prepare("SELECT profile FROM symbols WHERE asset_type = ? AND ts_code = ?");
        stmt.bind([`custom:${sourceId}`, code]);
        const value = stmt.step() ? stmt.getAsObject().profile : null;
        stmt.free();
        return typeof value === "string" && value ? value : undefined;
      } catch {
        return undefined; // profile column missing (db predates the migration)
      }
    },
    async close() {
      if (dbPromise) (await dbPromise)?.close();
    },
  };
}

// Fetches one window of kline rows for a source def, collecting parse-drop
// stats (json format). Shared by probeData and validateConfig.
// declaredProfile: the classification declared for this code at search time
// (outranks codeRules — see resolveSymbolParams).
async function fetchWithStats(
  ctx: VaultContext,
  def: CustomSourceDef,
  code: string,
  start: string,
  end: string,
  declaredProfile?: string
): Promise<{ rows: Awaited<ReturnType<CustomQuoteClient["fetchKline"]>>; stats: KlineParseStats }> {
  const stats: KlineParseStats = { dropped: 0 };
  const rows =
    def.format === "csv"
      ? await new CsvQuoteClient(def, async (p) => fs.promises.readFile(path.join(ctx.vault, p), "utf8")).fetchKline(code, start, end)
      : await new CustomQuoteClient(def).fetchKline(code, start, end, stats, declaredProfile);
  return { rows, stats };
}

export async function probeData(
  ctx: VaultContext,
  opts: { code: string; assetType?: string; sourceId?: string; days?: number }
): Promise<ProbeOutput> {
  const code = opts.code?.trim();
  if (!code) fail("probe 需要一个代码参数，如: probe 600519.SH --source <数据源id>");
  const days = opts.days ?? 14;
  const { start, end } = recentWindow(days);
  const type = (opts.assetType ?? "custom") as AssetType;
  if (!ASSET_TYPES.includes(type)) {
    fail(`无效的资产类型: ${type}（应为 ${ASSET_TYPES.join(" | ")}）。`);
  }

  const sourceId = opts.sourceId;
  if (!sourceId) fail("必须提供 sourceId（用 list_sources / sources 命令查看可用 id）。");
  const profileLookup = createDeclaredProfileLookup(ctx);
  const all = ctx.settings.customSources ?? [];
  const found = all.find((s) => s.id === sourceId);
  if (!found) fail(`自定义数据源不存在: ${sourceId}（用 list_sources / sources 命令查看可用 id）。`);
  const def: CustomSourceDef = { ...found, apiKey: resolveGroupApiKey(found, all) };
  const keyInfo = sourceNeedsApiKey(found) ? resolveApiKeySource(found, all) : undefined;
  const keyFields = keyInfo
    ? { apiKeySource: keyInfo.source, ...(keyInfo.donorName ? { apiKeyDonor: keyInfo.donorName } : {}) }
    : {};
  const { rows, stats } = await fetchWithStats(ctx, def, code, start, end, await profileLookup.get(sourceId, code));
  await profileLookup.close();
  if (rows.length === 0) {
    return {
      ok: true,
      type,
      sourceId,
      code,
      rows: 0,
      ...(stats.dropped > 0 ? { dropped: stats.dropped } : {}),
      ...keyFields,
      hint: `数据源「${def.name}」在该区间没有返回 ${code} 的数据。诊断：${emptyProbeReason(def, stats, code)}`,
    };
  }
  return {
    ok: true,
    type,
    sourceId,
    code,
    rows: rows.length,
    ...(stats.dropped > 0 ? { dropped: stats.dropped } : {}),
    ...(stats.truncated ? { truncated: stats.truncated } : {}),
    ...keyFields,
    firstDate: rows[0].tradeDate,
    lastDate: rows[rows.length - 1].tradeDate,
    lastClose: rows[rows.length - 1].close,
  };
}

// ---------------------------------------------------------------------------
// validate-config
// ---------------------------------------------------------------------------

// Known CustomSourceDef / JsonSourceMap keys live in types.ts
// (KNOWN_SOURCE_DEF_KEYS / KNOWN_JSON_MAP_KEYS), shared with the settings
// import path so the two never drift — anything else in an imported entry is
// almost certainly a misplaced field (the classic mistake: searchBodyTemplate
// nested inside jsonMap, where it is silently ignored).
const KNOWN_FORMATS = new Set(["tencent", "eastmoney", "json", "csv"]);

// Why a probe parsed 0 rows. Names the exact column when the mapping is
// provably wrong — a fields set-diff hit, or every row's date/close cell
// empty (a misspelled column yields undefined for every row, while sparse
// data only blanks SOME rows) — before falling back to the generic hint.
// When the template uses {p.*} and the probed code has no code-specific
// params (not in the symbols table, no codeRules hit), the generic hint
// also names the likelier cause: the code was fetched with the source-level
// default params, i.e. possibly against an interface that doesn't serve
// its asset class.
function emptyProbeReason(def: CustomSourceDef, stats: KlineParseStats, code?: string, declaredProfile?: string): string {
  const fieldsHint =
    stats.availableFields && stats.availableFields.length > 0
      ? `（响应实际字段: ${stats.availableFields.slice(0, 20).join(", ")}）`
      : "";
  if (stats.unmappedCols && stats.unmappedCols.length > 0) {
    return `cols 映射的列名 ${stats.unmappedCols.join("、")} 在响应的 fields 列表中不存在——检查列名拼写${fieldsHint}`;
  }
  if (stats.total && stats.emptyDate === stats.total) {
    return `cols.date="${def.jsonMap?.cols.date ?? ""}" 在 ${stats.total} 行里一次都没取到值——检查日期列名拼写${fieldsHint}`;
  }
  if (stats.total && stats.badClose === stats.total) {
    return `cols.close="${def.jsonMap?.cols.close ?? ""}" 在 ${stats.total} 行里一次都没取到数值——检查列名拼写${fieldsHint}`;
  }
  if (stats.total && (stats.missingClose ?? 0) === stats.total) {
    return `cols.close="${def.jsonMap?.cols.close ?? ""}" 在 ${stats.total} 行里全部为空（null/空串）——列名可能对但数据缺失，或列名拼错${fieldsHint}`;
  }
  if ((stats.missingClose ?? 0) > 0 || (stats.badClose ?? 0) > 0) {
    const parts: string[] = [];
    if (stats.missingClose) parts.push(`${stats.missingClose} 行 close 为空`);
    if (stats.badClose) parts.push(`${stats.badClose} 行 close 不是数值`);
    return `接口返回成功但区间内 0 行（${parts.join("，")}，均已跳过——缺失值不再当作 0）——检查代码、区间或 cols 映射${fieldsHint}`;
  }
  if (stats.dropped > 0) {
    return `解析出 0 行，${stats.dropped} 行因日期无法解析被丢弃（首个异常值: ${JSON.stringify(stats.firstBadDate ?? "")}）——检查日期列格式或字段映射`;
  }
  const generic = "接口返回成功但区间内 0 行——检查代码、区间或 rowsPath 映射（也可能是 cols 列名与实际字段不符）";
  if (code && templateUsesSymbolParams(def) && !hasCodeSpecificParams(def, code, declaredProfile)) {
    return `${generic}；另外，代码 ${code} 不在代码表中、未命中 codeRules、也没有端点声明的 profile，本次取数用的是源级默认 params——它可能不在该默认接口的覆盖范围内；若它属于其它资产类别，请按代码形态配置 codeRules（或在 symbols 里逐条配 params/profile、给搜索端点声明 profile）`;
  }
  return generic;
}

// Whether fetching this source fills any {p.<name>} placeholder — from the
// URL/body templates or the column mapping values.
function templateUsesSymbolParams(def: CustomSourceDef): boolean {
  const templates: unknown[] = [def.klineUrl, def.bodyTemplate, ...Object.values(def.jsonMap?.cols ?? {})];
  return templates.some((tpl) => typeof tpl === "string" && tpl.includes("{p."));
}

// Whether a wider probe window could change the outcome: no when the
// mapping is provably broken (a typo heals in no window), yes otherwise
// (a delisted/suspended symbol simply has no recent bars).
function mappingProvablyBroken(stats: KlineParseStats): boolean {
  if ((stats.unmappedCols?.length ?? 0) > 0) return true;
  if (stats.dropped > 0) return true;
  if (stats.total !== undefined && stats.total > 0 && (stats.emptyDate === stats.total || stats.badClose === stats.total || stats.missingClose === stats.total)) {
    return true;
  }
  return false;
}

// Probe caveats that must surface even on a GREEN probe: rows skipped for an
// empty close (a missing value is not a 0), and a paginated fetch that
// stopped short of the declared total / page cap (silent truncation).
function pushProbeStatWarnings(result: ValidateConfigSourceResult, code: string, stats: KlineParseStats): void {
  if ((stats.missingClose ?? 0) > 0) {
    result.warnings.push(`代码 ${code}：${stats.missingClose} 行 close 为空（null/空串）被跳过——缺失值不会当作 0；若不该缺失，检查 close 列映射或接口数据`);
  }
  if (stats.truncated) {
    const total = stats.truncated.total;
    result.warnings.push(`代码 ${code}：取数疑似被截断，只取回 ${stats.truncated.fetched}${total ? ` / ${total}` : ""} 行——检查 paginate.pageSize 是否与服务端单页上限一致，或调大 maxPages`);
  }
}

export interface ValidateConfigProbe {
  code: string;
  ok: boolean;
  rows: number;
  dropped?: number;
  reason?: string;  sample?: string; // first 300 chars of the raw response, on failure only
  note?: string;   // ok with a caveat (e.g. no recent bars, but older data exists — likely delisted)
  via?: "search";  // this code came from the search probe (not the declared symbols) — exercises the {p.*}-vs-search path
  profile?: string; // wiring-audit sampling: the effective profile this code was classified into
}

export interface ValidateConfigSourceResult {
  source: string;
  structuralErrors: string[];
  warnings: string[];
  // Where the runtime apiKey comes from when the source's templates carry an
  // {apiKey} placeholder: own entry / group member / vault source with the
  // same name or group / injected via --api-key / missing.
  apiKeySource?: "self" | "group" | "vault" | "injected" | "none";
  apiKeyDonor?: string;
  search?: { ok: boolean; results?: number; reason?: string; query?: string; defaulted?: boolean; skippedRows?: number; truncated?: { fetched: number; total?: number; allowed?: boolean }; audit?: SearchCoverageAudit };
  probes: ValidateConfigProbe[];
}

// Structural sanity checks for one imported entry; errors block probing,
// warnings do not. Returns the entry normalized to a CustomSourceDef when
// it is sound enough to probe.
function checkConfigEntry(entry: any, index: number): { def?: CustomSourceDef; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const label = entry?.name ? `「${entry.name}」` : `#${index + 1}`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { errors: [`${label}: 条目不是对象`] , warnings };
  }
  for (const key of Object.keys(entry)) {
    if (!KNOWN_SOURCE_DEF_KEYS.has(key)) warnings.push(`${label}: 未知字段 "${key}"（会被忽略，检查是否放错了层级）`);
  }
  if (typeof entry.name !== "string" || !entry.name.trim()) errors.push(`${label}: 缺少 name`);
  if (!KNOWN_FORMATS.has(entry.format)) errors.push(`${label}: format 必须是 tencent/eastmoney/json/csv 之一`);
  if (entry.format === "csv") {
    const hasFile = typeof entry.filePath === "string" && !!entry.filePath;
    const hasUrl = typeof entry.klineUrl === "string" && !!entry.klineUrl;
    if (!hasFile && !hasUrl) errors.push(`${label}: csv 格式需要 filePath（vault 内文件）或 klineUrl（远程 CSV）之一`);
  } else if (typeof entry.klineUrl !== "string" || !entry.klineUrl) {
    errors.push(`${label}: 缺少 klineUrl`);
  }
  if (entry.transport !== undefined && entry.transport !== "node") errors.push(`${label}: transport 只支持 "node"`);
  if (entry.method !== undefined && entry.method !== "GET" && entry.method !== "POST") errors.push(`${label}: method 只支持 GET/POST`);
  if (entry.bodyEncoding !== undefined && entry.bodyEncoding !== "json" && entry.bodyEncoding !== "form") {
    errors.push(`${label}: bodyEncoding 只支持 "json"/"form"`);
  }
  if (entry.bodyEncoding === "form" && entry.method !== "POST") {
    warnings.push(`${label}: bodyEncoding 为 form 但 method 不是 POST——不会生效`);
  }
  if (entry.paginate !== undefined) {
    if (entry.paginate === null || typeof entry.paginate !== "object" || Array.isArray(entry.paginate)
      || !Number.isInteger(Number(entry.paginate.pageSize)) || Number(entry.paginate.pageSize) <= 0) {
      errors.push(`${label}: paginate 必须是 {"pageSize": 正整数, "maxPages"?, "totalPath"?} 对象`);
    } else if (!String(entry.klineUrl ?? "").includes("{offset}") && !String(entry.bodyTemplate ?? "").includes("{offset}")) {
      warnings.push(`${label}: 配了 paginate 但 klineUrl/bodyTemplate 里没有 {offset} 占位符——不会翻页`);
    }
  }
  if (entry.method === "POST" && typeof entry.bodyTemplate !== "string") {
    warnings.push(`${label}: method 为 POST 但没有 bodyTemplate`);
  }
  if (entry.headers !== undefined && (entry.headers === null || typeof entry.headers !== "object" || Array.isArray(entry.headers))) {
    errors.push(`${label}: headers 必须是 {"头名": "值"} 对象`);
  }
  const map = entry.jsonMap;
  if ((entry.format === "json" || entry.format === "csv") && !map) {
    errors.push(`${label}: ${entry.format} 格式需要 jsonMap 字段映射`);
  }
  if (map !== undefined) {
    if (map === null || typeof map !== "object" || Array.isArray(map)) {
      errors.push(`${label}: jsonMap 必须是对象`);
    } else {
      for (const key of Object.keys(map)) {
        if (!KNOWN_JSON_MAP_KEYS.has(key)) warnings.push(`${label}: jsonMap 里的未知字段 "${key}"（searchUrl/searchBodyTemplate 等是源级字段，不属于 jsonMap）`);
      }
      const cols = map.cols;
      if (!cols || typeof cols.date !== "string" || !cols.date || typeof cols.close !== "string" || !cols.close) {
        errors.push(`${label}: jsonMap.cols 至少需要非空的 date 与 close`);
      }
      const KNOWN_ROW_KINDS = new Set(["array", "object", "fields", "map", "columns"]);
      if (map.rowKind !== undefined && !KNOWN_ROW_KINDS.has(map.rowKind)) {
        errors.push(`${label}: rowKind 只支持 array/object/fields/map/columns`);
      }
      if (map.rowKind === "fields" && typeof map.fieldsPath !== "string") {
        errors.push(`${label}: rowKind 为 fields 时需要 fieldsPath`);
      }
      if (map.percentScale !== undefined && (typeof map.percentScale !== "number" || !(map.percentScale > 0))) {
        errors.push(`${label}: percentScale 必须是正数（如 100 表示 "1.5%" 读作 0.015）`);
      }
    }
  }
  if (entry.symbols !== undefined) {
    if (!Array.isArray(entry.symbols)) {
      errors.push(`${label}: symbols 必须是数组`);
    } else {
      for (const s of entry.symbols) {
        if (!s || typeof s !== "object" || typeof s.code !== "string" || !s.code.trim()) {
          errors.push(`${label}: symbols 里的每条必须是 {"code","name"} 对象且 code 非空`);
          break;
        }
        if (s.params !== undefined && (s.params === null || typeof s.params !== "object" || Array.isArray(s.params)
          || Object.values(s.params).some((v: unknown) => typeof v !== "string"))) {
          errors.push(`${label}: symbols[].params 必须是 {"变量名": "字符串值"} 对象`);
          break;
        }
        if (s.profile !== undefined && typeof s.profile !== "string") {
          errors.push(`${label}: symbols[].profile 必须是字符串（profiles 里的档位名）`);
          break;
        }
      }
    }
  }
  if (entry.params !== undefined && (entry.params === null || typeof entry.params !== "object" || Array.isArray(entry.params)
    || Object.values(entry.params).some((v: unknown) => typeof v !== "string"))) {
    errors.push(`${label}: params 必须是 {"变量名": "字符串值"} 对象（{p.*} 占位符的源级默认值）`);
  }
  if (entry.profiles !== undefined) {
    if (entry.profiles === null || typeof entry.profiles !== "object" || Array.isArray(entry.profiles)
      || Object.values(entry.profiles).some((p: unknown) => p === null || typeof p !== "object" || Array.isArray(p)
        || Object.values(p as object).some((v: unknown) => typeof v !== "string"))) {
      errors.push(`${label}: profiles 必须是 {"档位名": {"变量名": "字符串值"}} 对象`);
    }
  }
  if (entry.codeRules !== undefined) {
    if (!Array.isArray(entry.codeRules)) {
      errors.push(`${label}: codeRules 必须是 [{"match": "正则", "profile": "档位名"}] 数组`);
    } else {
      for (const r of entry.codeRules) {
        if (!r || typeof r !== "object" || Array.isArray(r)
          || typeof r.match !== "string" || !r.match.trim() || typeof r.profile !== "string" || !r.profile.trim()) {
          errors.push(`${label}: codeRules 里的每条必须是 {"match": "正则", "profile": "档位名"} 对象`);
          break;
        }
        try {
          new RegExp(r.match);
        } catch {
          errors.push(`${label}: codeRules 的 match "${r.match}" 不是合法正则`);
          break;
        }
        if (entry.profiles && typeof entry.profiles === "object" && !Array.isArray(entry.profiles)
          && !(r.profile in entry.profiles)) {
          warnings.push(`${label}: codeRules 的 profile "${r.profile}" 在 profiles 里没有对应档位——不会生效`);
        }
      }
    }
  }
  if (entry.searchPaginate !== undefined) {
    if (entry.searchPaginate === null || typeof entry.searchPaginate !== "object" || Array.isArray(entry.searchPaginate)
      || !Number.isInteger(Number(entry.searchPaginate.pageSize)) || Number(entry.searchPaginate.pageSize) <= 0) {
      errors.push(`${label}: searchPaginate 必须是 {"pageSize": 正整数, "maxPages"?, "totalPath"?, "allowTruncated"?} 对象`);
    } else if (![entry.searchUrl, entry.searchBodyTemplate, entry.klineUrl].some((tpl) => String(tpl ?? "").includes("{offset}"))) {
      warnings.push(`${label}: 配了 searchPaginate 但 searchUrl/searchBodyTemplate/klineUrl 里没有 {offset} 占位符——不会翻页`);
    }
  }
  if (entry.searchProfile !== undefined) {
    if (typeof entry.searchProfile !== "string" || !entry.searchProfile.trim()) {
      errors.push(`${label}: searchProfile 必须是字符串（profiles 里的档位名，声明主搜索端点返回代码的资产类别）`);
    } else if (entry.profiles && typeof entry.profiles === "object" && !Array.isArray(entry.profiles)
      && !(entry.searchProfile in entry.profiles)) {
      warnings.push(`${label}: searchProfile "${entry.searchProfile}" 在 profiles 里没有对应档位——不会生效`);
    }
  }
  if (entry.deadCodes !== undefined) {
    if (!Array.isArray(entry.deadCodes) || entry.deadCodes.some((d: unknown) => typeof d !== "string" || !d.trim())) {
      errors.push(`${label}: deadCodes 必须是正则字符串数组（已知不可画代码的标记——跳过探测并在搜索结果里标注，不是剔除）`);
    } else {
      for (const d of entry.deadCodes) {
        try {
          new RegExp(d);
        } catch {
          errors.push(`${label}: deadCodes 的 "${d}" 不是合法正则`);
          break;
        }
      }
    }
  }
  for (const p of [entry.paginate, entry.searchPaginate]) {
    if (p && typeof p === "object" && !Array.isArray(p) && p.allowTruncated !== undefined && typeof p.allowTruncated !== "boolean") {
      errors.push(`${label}: paginate.allowTruncated 必须是布尔值（true = 截断只告警不判红）`);
      break;
    }
  }
  if (entry.searches !== undefined) {
    if (!Array.isArray(entry.searches)) {
      errors.push(`${label}: searches 必须是数组`);
    } else {
      for (const s of entry.searches) {
        if (!s || typeof s !== "object" || Array.isArray(s)
          || (typeof s.url !== "string" || !s.url.trim()) && (typeof s.bodyTemplate !== "string" || !s.bodyTemplate.trim())) {
          errors.push(`${label}: searches 里的每条必须是 {"url"?,"bodyTemplate"?} 对象，且至少有一个非空`);
          break;
        }
        if (s.searchCols !== undefined && (s.searchCols === null || typeof s.searchCols !== "object" || Array.isArray(s.searchCols)
          || typeof s.searchCols.code !== "string" || typeof s.searchCols.name !== "string")) {
          errors.push(`${label}: searches[].searchCols 必须是 {"code","name","market"?} 对象`);
          break;
        }
        if (s.searchRowsPath !== undefined && typeof s.searchRowsPath !== "string") {
          errors.push(`${label}: searches[].searchRowsPath 必须是字符串`);
          break;
        }
        if (s.paginate !== undefined && (s.paginate === null || typeof s.paginate !== "object" || Array.isArray(s.paginate)
          || !Number.isInteger(Number(s.paginate.pageSize)) || Number(s.paginate.pageSize) <= 0)) {
          errors.push(`${label}: searches[].paginate 必须是 {"pageSize": 正整数, "maxPages"?, "totalPath"?, "allowTruncated"?} 对象，且模板需含 {offset} 占位符`);
          break;
        }
        if (s.paginate?.allowTruncated !== undefined && typeof s.paginate.allowTruncated !== "boolean") {
          errors.push(`${label}: searches[].paginate.allowTruncated 必须是布尔值`);
          break;
        }
        if (s.profile !== undefined) {
          if (typeof s.profile !== "string" || !s.profile.trim()) {
            errors.push(`${label}: searches[].profile 必须是字符串（profiles 里的档位名，声明该端点返回代码的资产类别）`);
            break;
          }
          if (entry.profiles && typeof entry.profiles === "object" && !Array.isArray(entry.profiles)
            && !(s.profile in entry.profiles)) {
            warnings.push(`${label}: searches[].profile "${s.profile}" 在 profiles 里没有对应档位——不会生效`);
          }
        }
        if (s.paginate && !(String(s.url ?? "").includes("{offset}") || String(s.bodyTemplate ?? "").includes("{offset}"))) {
          warnings.push(`${label}: searches[] 配了 paginate 但模板里没有 {offset} 占位符——不会翻页`);
        }
      }
    }
  }
  if (errors.length > 0) return { errors, warnings };
  const def: CustomSourceDef = {
    id: typeof entry.id === "string" && entry.id ? entry.id : `validate-${index}`,
    name: entry.name,
    enabled: entry.enabled !== false,
    format: entry.format,
    ...entry,
  };
  return { def, errors, warnings };
}

// Dry-run a not-yet-imported source config file (the JSON array the AI 辅助
// flow writes into the vault): structural checks per entry, then a live
// probe of testCode + every symbols row (default 400-day window so monthly
// and quarterly series also prove out; --days overrides), plus one search
// request per source that configures one. A clean 0-row probe retries once
// with a ~10-year window to tell "delisted/suspended" apart from "wrong
// code". Keys never live in the delivered file, so keyed sources resolve
// one via opts.apiKeys (a map of 组名/源名 → key, "" = global fallback) /
// STRATABOARD_API_KEY / a same-name-or-group vault source;
// --structural-only skips all network probes. Nothing is written to
// settings.
export async function validateConfig(
  ctx: VaultContext,
  opts: { file: string; days?: number; apiKey?: string; apiKeys?: Record<string, string>; structuralOnly?: boolean }
): Promise<{ ok: boolean; file: string; sources: ValidateConfigSourceResult[] }> {
  const file = path.isAbsolute(opts.file) ? opts.file : path.join(ctx.vault, opts.file);
  if (!fs.existsSync(file)) fail(`配置文件不存在: ${file}`);
  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`配置文件不是合法 JSON: ${file} — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(entries)) fail(`配置文件必须是数据源数组（[ {...}, {...} ]）: ${file}`);

  const days = opts.days ?? 400;
  // Injected keys: named entries target one group or source by name; the ""
  // entry is the global fallback, ahead of the env var. A legacy single
  // opts.apiKey becomes the "" entry.
  const injectedKeys: Record<string, string> = {
    ...(opts.apiKey?.trim() ? { "": opts.apiKey.trim() } : {}),
    ...opts.apiKeys,
  };
  const envKey = process.env.STRATABOARD_API_KEY?.trim() || undefined;
  const injectedKeyFor = (def: CustomSourceDef): string | undefined => {
    const group = def.group?.trim();
    if (group && injectedKeys[group]) return injectedKeys[group];
    const name = def.name.trim();
    if (injectedKeys[name]) return injectedKeys[name];
    return injectedKeys[""] || envKey;
  };
  const vaultSources = ctx.settings.customSources ?? [];
  const defs = entries
    .map((entry: any) => checkConfigEntry(entry, 0).def)
    .filter((d): d is CustomSourceDef => Boolean(d));
  const { start, end } = recentWindow(days);
  const sources: ValidateConfigSourceResult[] = [];

  for (let i = 0; i < entries.length; i++) {
    const { def, errors, warnings } = checkConfigEntry(entries[i], i);
    const result: ValidateConfigSourceResult = {
      source: typeof entries[i]?.name === "string" ? entries[i].name : `#${i + 1}`,
      structuralErrors: errors,
      warnings,
      probes: [],
    };
    sources.push(result);
    if (!def) continue;

    // Key resolution chain: the file's own entry/group first, then an
    // injected key (named apiKeys entry matching the group, then the name,
    // then the global fallback / STRATABOARD_API_KEY), then a vault source
    // with the same name or group (which is what the import will resolve
    // to). Only consulted when the templates actually carry {apiKey}.
    let resolved: CustomSourceDef = { ...def, apiKey: resolveGroupApiKey(def, defs) };
    if (sourceNeedsApiKey(def)) {
      let keyInfo = resolveApiKeySource(def, defs);
      const injectedKey = keyInfo.source === "none" ? injectedKeyFor(def) : undefined;
      if (keyInfo.source === "none" && injectedKey) {
        resolved = { ...resolved, apiKey: injectedKey };
        keyInfo = { key: injectedKey, source: "injected" };
      }
      if (keyInfo.source === "none") {
        const candidate =
          vaultSources.find((s) => s.name.trim() === def.name.trim()) ??
          (def.group?.trim() ? vaultSources.find((s) => s.group?.trim() === def.group!.trim()) : undefined);
        const vaultKey = candidate ? resolveApiKeySource(candidate, vaultSources) : undefined;
        if (candidate && vaultKey?.key) {
          resolved = { ...resolved, apiKey: vaultKey.key };
          keyInfo = { key: vaultKey.key, source: "vault", donorName: candidate.name };
        }
      }
      result.apiKeySource = keyInfo.source;
      if (keyInfo.donorName) result.apiKeyDonor = keyInfo.donorName;
      if (keyInfo.source === "none") {
        result.warnings.push("模板含 {apiKey} 但未找到密钥（文件内、vault 同名/同组源、--api-key 注入都没有）——请求很可能被鉴权拒绝");
      }
    }

    if (opts.structuralOnly) continue;

    let searchOnlyCode: string | undefined;
    let auditSamples: SearchCoverageAudit["sampleCodes"] = [];
    if (sourceSupportsRemoteSearch(resolved)) {
      const probe = searchProbeQuery(resolved);
      try {
        const searchStats: SearchFetchStats = {};
        const items = await new CustomQuoteClient(resolved).searchQuotes(probe.query, searchStats);
        const skippedRows = searchStats.skipped ?? 0;
        result.search = {
          ok: true,
          results: items.length,
          query: probe.query,
          ...(probe.defaulted ? { defaulted: true } : {}),
          ...(skippedRows > 0 ? { skippedRows } : {}),
          ...(searchStats.truncated ? { truncated: searchStats.truncated } : {}),
        };
        if (skippedRows > 0) {
          result.warnings.push(`搜索响应有 ${skippedRows} 行因缺 code 或 name 被丢弃——若是整表接口，检查该端点的 searchCols 列名是否与实际字段一致（可用 searches[].searchCols 单独覆盖）`);
        }
        if (searchStats.truncated) {
          const tr = searchStats.truncated;
          result.warnings.push(`搜索结果被截断，只取回 ${tr.fetched}${tr.total ? ` / ${tr.total}` : ""} 行——检查该端点 paginate.pageSize 是否与服务端单页上限一致，或调大 maxPages`);
          // Truncation means incomplete data — fail the search unless the
          // endpoint's paginate config explicitly opted out.
          if (!tr.allowed) {
            result.search.ok = false;
            result.search.reason = `搜索结果被截断（只取回 ${tr.fetched}${tr.total ? ` / ${tr.total}` : ""} 行）——调大 maxPages / 校正 pageSize，或确认无误后给该端点 paginate 加 "allowTruncated": true`;
          }
        }
        // Offline wiring audit: classify every searchable code by endpoint
        // declaration / codeRules and report what would fetch with the wrong
        // (source-default) interface — zero extra requests, the items are
        // already in hand.
        const hasWiring = (resolved.codeRules?.length ?? 0) > 0
          || !!resolved.searchProfile
          || (resolved.searches ?? []).some((s) => s.profile);
        if (hasWiring && items.length > 0) {
          const audit = auditSearchCoverage(resolved, items);
          result.search.audit = audit;
          auditSamples = audit.sampleCodes;
          if (audit.unmatched > 0) {
            const top = audit.unmatchedTop
              .slice(0, 3)
              .map((s) => `${s.shape} ×${s.count}（如 ${s.samples.join("、")}）`)
              .join("；");
            result.warnings.push(`搜索审计：${audit.unmatched}/${audit.total} 条可搜索代码未命中任何 codeRules 或端点声明，将用源级默认参数取数（top 形态：${top}）——确认它们属于默认接口，或补 codeRules`);
          }
          if (audit.overlapCount > 0) {
            const ex = audit.overlaps.map((o) => `${o.code} 命中 [${o.profiles.join(", ")}]`).join("；");
            result.warnings.push(`搜索审计：${audit.overlapCount} 条代码同时命中多条 codeRules（首条生效，顺序敏感）：${ex}——调整规则顺序或收窄正则`);
          }
          if (audit.conflictCount > 0) {
            const ex = audit.conflicts.map((c) => `${c.code} 端点声明=${c.declared} 规则命中=${c.rule}`).join("；");
            result.warnings.push(`搜索审计：${audit.conflictCount} 条代码的端点声明与 codeRules 命中不一致（以端点声明为准）：${ex}——修正规则或端点声明`);
          }
        }
        if (items.length === 0) {
          result.search = {
            ok: false,
            results: 0,
            query: probe.query,
            ...(probe.defaulted ? { defaulted: true } : {}),
            reason: `搜索 "${probe.query}" 返回 0 条——检查搜索模板与 searchRowsPath/searchCols 映射`,
          };
        }
        // Templates using {p.*} + remote search: searched codes are never in
        // the static symbols table, so probe one of them too — otherwise the
        // declared-symbol probes (all carrying params) give false confidence.
        const usesSymbolParams = templateUsesSymbolParams(resolved);
        if (usesSymbolParams && items.length > 0) {
          const known = new Set((resolved.symbols ?? []).flatMap((s) => [s.code, s.code.split("@")[0]]));
          searchOnlyCode = items.find((it) => !known.has(it.tsCode))?.tsCode;
        }
      } catch (e) {
        result.search = { ok: false, query: probe.query, ...(probe.defaulted ? { defaulted: true } : {}), reason: e instanceof Error ? e.message : String(e) };
      }
      if (probe.defaulted) {
        result.warnings.push("没有 testCode 或 symbols 可取查询词，搜索探针使用了默认查询词 000001（英文/全球源可能误判）");
      }
    }

    const codes: string[] = [];
    if (resolved.testCode?.trim()) codes.push(resolved.testCode.trim());
    for (const s of resolved.symbols ?? []) {
      if (typeof s?.code === "string" && s.code.trim() && !codes.includes(s.code.trim())) codes.push(s.code.trim());
    }
    if (codes.length === 0) {
      result.warnings.push("没有 testCode 或 symbols，无法实际探测——建议至少配一个 testCode");
    }
    const dead = compileDeadCodes(resolved);
    for (const code of codes) {
      // Declared known-unplottable: skip the request, leave a trail (probe
      // note + warning) instead of a red failure.
      if (dead?.test(code.split("@")[0])) {
        result.probes.push({ code, ok: true, rows: 0, note: "deadCodes 命中（已知不可画），跳过探测" });
        result.warnings.push(`代码 ${code} 被 deadCodes 标记为已知不可画，已跳过探测——若上游恢复供数请移除该标记`);
        continue;
      }
      try {
        const { rows, stats } = await fetchWithStats(ctx, resolved, code, start, end);
        if (rows.length > 0) {
          // A truncated paginated fetch means the window is incomplete —
          // fail the probe unless paginate.allowTruncated opted out.
          if (stats.truncated && resolved.paginate?.allowTruncated !== true) {
            const tr = stats.truncated;
            result.probes.push({
              code,
              ok: false,
              rows: rows.length,
              reason: `取数被截断，只取回 ${tr.fetched}${tr.total ? ` / ${tr.total}` : ""} 行——检查 paginate.pageSize 是否与服务端单页上限一致、调大 maxPages，或确认无误后给 paginate 加 "allowTruncated": true`,
            });
            continue;
          }
          result.probes.push({ code, ok: true, rows: rows.length, ...(stats.dropped > 0 ? { dropped: stats.dropped } : {}) });
          pushProbeStatWarnings(result, code, stats);
          continue;
        }
        // Clean 0 rows: retry once with a ~10-year window. A delisted or
        // suspended symbol has no recent bars but older ones, which is a
        // fact about the symbol, not a config error.
        if (!mappingProvablyBroken(stats) && days < WIDEN_PROBE_DAYS) {
          const wide = recentWindow(WIDEN_PROBE_DAYS);
          try {
            const widened = await fetchWithStats(ctx, resolved, code, wide.start, wide.end);
            if (widened.rows.length > 0) {
              if (widened.stats.truncated && resolved.paginate?.allowTruncated !== true) {
                const tr = widened.stats.truncated;
                result.probes.push({
                  code,
                  ok: false,
                  rows: widened.rows.length,
                  reason: `取数被截断，只取回 ${tr.fetched}${tr.total ? ` / ${tr.total}` : ""} 行——检查 paginate.pageSize 是否与服务端单页上限一致、调大 maxPages，或确认无误后给 paginate 加 "allowTruncated": true`,
                });
                continue;
              }
              result.probes.push({
                code,
                ok: true,
                rows: widened.rows.length,
                note: `近 ${days} 天无数据，但近 ${Math.round(WIDEN_PROBE_DAYS / 365)} 年有 ${widened.rows.length} 行——疑似已退市/停更，代码与映射正常`,
              });
              pushProbeStatWarnings(result, code, widened.stats);
              continue;
            }
          } catch {
            // Widening is best-effort; fall through to the original failure.
          }
        }
        result.probes.push({
          code,
          ok: false,
          rows: 0,
          ...(stats.dropped > 0 ? { dropped: stats.dropped } : {}),
          reason: emptyProbeReason(resolved, stats, code),
          sample: await rawSample(resolved, code),
        });
      } catch (e) {
        result.probes.push({ code, ok: false, rows: 0, reason: e instanceof Error ? e.message : String(e), sample: await rawSample(resolved, code) });
      }
    }

    // The search-only code probe ({p.*} templates + remote search): a code
    // the static table doesn't know exercises the source-level default
    // params path. Failure here means searched symbols can't be fetched.
    if (searchOnlyCode) {
      const code = searchOnlyCode;
      const prefix = "搜索结果的代码（不在代码表中）：";
      try {
        const { rows, stats } = await fetchWithStats(ctx, resolved, code, start, end);
        if (rows.length > 0) {
          result.probes.push({ code, ok: true, rows: rows.length, via: "search" });
          pushProbeStatWarnings(result, code, stats);
        } else {
          result.probes.push({
            code,
            ok: false,
            rows: 0,
            via: "search",
            reason: prefix + emptyProbeReason(resolved, stats, code),
            sample: await rawSample(resolved, code),
          });
        }
      } catch (e) {
        result.probes.push({
          code,
          ok: false,
          rows: 0,
          via: "search",
          reason: prefix + (e instanceof Error ? e.message : String(e)),
          sample: await rawSample(resolved, code),
        });
      }
    }

    // Wiring-audit sampling: probe ONE searched code per effective profile
    // (endpoint-declared or codeRules-hit), closing the
    // "rule → interface → rows" loop the offline audit can't. This is the
    // built-in version of a per-family manual regression.
    for (const sample of auditSamples) {
      if (sample.code === searchOnlyCode) continue; // already probed above
      const prefix = `接线审计抽样（profile=${sample.profile}，${sample.declared ? "端点声明" : "codeRules 命中"}）：`;
      const code = sample.code;
      try {
        const { rows, stats } = await fetchWithStats(
          ctx, resolved, code, start, end,
          sample.declared ? sample.profile : undefined
        );
        if (rows.length > 0) {
          result.probes.push({ code, ok: true, rows: rows.length, via: "search", profile: sample.profile });
          pushProbeStatWarnings(result, code, stats);
        } else {
          result.probes.push({
            code,
            ok: false,
            rows: 0,
            via: "search",
            profile: sample.profile,
            reason: prefix + emptyProbeReason(resolved, stats, code, sample.declared ? sample.profile : undefined),
            sample: await rawSample(resolved, code),
          });
        }
      } catch (e) {
        result.probes.push({
          code,
          ok: false,
          rows: 0,
          via: "search",
          profile: sample.profile,
          reason: prefix + (e instanceof Error ? e.message : String(e)),
          sample: await rawSample(resolved, code),
        });
      }
    }
  }

  const ok = sources.every(
    (s) => s.structuralErrors.length === 0 && (s.search?.ok ?? true) && s.probes.every((p) => p.ok)
  );
  return { ok, file, sources };
}

// Second-chance window for probes that come back cleanly empty (see
// validateConfig): roughly ten years of history.
const WIDEN_PROBE_DAYS = 3650;

// Raw response excerpt for a failed probe — the "view raw response" escape
// hatch, one extra request per failure.
async function rawSample(def: CustomSourceDef, code: string): Promise<string | undefined> {
  if (def.format === "csv") return undefined;
  try {
    const sample = await fetchKlineSample(def, code);
    return sample.text.slice(0, 300);
  } catch {
    return undefined;
  }
}
