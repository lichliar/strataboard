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
import { setRequestInterval, setAllowedLoopbackHttpOrigins } from "../modules/http";
import { CustomQuoteClient, type SearchFetchStats } from "../modules/custom-quote-client";
import { CsvQuoteClient } from "../modules/csv-quote-client";
import type { KlineParseStats } from "../modules/quote-format-parsers";
import { hasCodeSpecificParams, compileDeadCodes } from "../utils/symbol-list";
import { formatDate } from "../utils/date";
import { renderCardBlockPng } from "../modules/render-headless";
import { createRenderRuntime } from "./fs-host";
import {
  ASSET_TYPES,
  sourceNeedsApiKey,
  type AssetType,
  type CustomSourceDef,
  type IndicatorGroup,
  type IndicatorInstance,
  type ResolvedCustomSourceDef,
} from "../types";
import { envVarNameForSource } from "../modules/credentials";
import { cliApiKeyResolver } from "./runtime-credentials";

const PLUGIN_ID = "strataboard";

// Subset of StrataBoardSettings the CLI/MCP read; defaults mirror settings.ts.
export interface CliSettings {
  customSources?: CustomSourceDef[];
  symbolCachePath?: string;
  requestIntervalMs?: number;
  // Loopback http origins confirmed in the plugin settings (url-policy.ts).
  allowedLoopbackHttpOrigins?: string[];
  // 本地脚本 folder (vault-relative); output/*.csv auto-registers as sources.
  scriptFolderPath?: string;
  // 指标 folder (vault-relative); *.js files load as custom indicators.
  indicatorFolderPath?: string;
  // 卡片库 folder (vault-relative): spread-card references (source: card)
  // resolve against an index of this folder. Never hardcoded — the value is
  // whatever the user configured in the plugin settings.
  cardLibraryPath?: string;
  dataCachePath?: string;
  // 指标组 (设置 → 指标 → 指标组): named indicator bundles, listed
  // read-only via CLI `groups` / MCP `list_indicator_groups`.
  indicatorGroups?: IndicatorGroup[];
  showSeriesLatestValue?: boolean;
  showSeriesPointMarkers?: boolean;
  showChartGrid?: boolean;
  gridOpacity?: number;
  // 指标 tab global switch for the overlay correlation badge; absent = on.
  showOverlayCorrelation?: boolean;
  // Global rise/fall colors (通用 tab); read by the headless renderers.
  riseColor?: string;
  fallColor?: string;
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
  setRequestInterval(settings.requestIntervalMs ?? 1000);
  setAllowedLoopbackHttpOrigins(settings.allowedLoopbackHttpOrigins ?? []);
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
    // 本地脚本产物自动注册的源，id 形如 script:<文件名>。
    isScriptOutput: def.id.startsWith("script:"),
  }));
  return { ok: true, sources };
}

// ---------------------------------------------------------------------------
// groups (指标组)
// ---------------------------------------------------------------------------

export function listIndicatorGroups(ctx: VaultContext): {
  ok: true;
  groups: IndicatorGroup[];
} {
  return { ok: true, groups: ctx.settings.indicatorGroups ?? [] };
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

export interface CardBlock {
  lang: string;
  line: number;      // 1-based line number of the opening fence
  startLine: number; // 0-based line index of the opening fence
  endLine: number;   // 0-based line index of the closing fence (-1: unclosed)
  body: string;
}

// Extracts every StrataBoard fenced block from a markdown document. Shared by
// validateCards (checks) and the render commands (rendering + block
// replacement).
export function findCardBlocks(markdown: string): { lines: string[]; blocks: CardBlock[] } {
  const lines = markdown.split(/\r?\n/);
  const blocks: CardBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^```([\w-]+)\s*$/);
    if (m && KNOWN_BLOCK_TYPES.has(m[1])) {
      const lang = m[1];
      const startLine = i;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      blocks.push({
        lang,
        line: startLine + 1,
        startLine,
        endLine: i < lines.length ? i : -1,
        body: body.join("\n"),
      });
    }
    i++;
  }
  return { lines, blocks };
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
  const { blocks } = findCardBlocks(opts.markdown);
  const checks: BlockCheck[] = blocks.map((block) => {
    if (block.endLine < 0) {
      return { lang: block.lang, line: block.line, ok: false, error: "围栏代码块未闭合。" };
    }
    const error = validateBlock(block.lang, block.body);
    return error
      ? { lang: block.lang, line: block.line, ok: false, error }
      : { lang: block.lang, line: block.line, ok: true };
  });

  const ok = checks.every((b) => b.ok);
  return { ok, ...(opts.label ? { label: opts.label } : {}), blocks: checks };
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
  // Runtime credential provenance (only when the source's templates carry an
  // {apiKey} placeholder): CLI/MCP resolve secrets from per-source env vars.
  credential?: { source: "env"; envVar: string };
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
// stats (json format) used by probeData.
// declaredProfile: the classification declared for this code at search time
// (outranks codeRules — see resolveSymbolParams).
async function fetchWithStats(
  ctx: VaultContext,
  def: ResolvedCustomSourceDef,
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
  // Runtime credential: env var only, never data.json. A missing one is a
  // structured failure naming the exact variable to export.
  const envVar = envVarNameForSource(found.id);
  const { key, missing } = cliApiKeyResolver()(found);
  if (missing) {
    fail(`缺少运行时凭据：数据源「${found.name}」需要 API Key。请为进程设置环境变量 ${envVar} 后重试（不要把密钥写进命令行参数）。`);
  }
  const def: ResolvedCustomSourceDef = { ...found, apiKey: key };
  const keyFields = sourceNeedsApiKey(found) ? { credential: { source: "env" as const, envVar } } : {};
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

// ---------------------------------------------------------------------------
// render-card / render-doc (headless PNG rendering)
// ---------------------------------------------------------------------------

// Only chart cards render to a static image; financial-widget embeds
// third-party HTML and calendar is a DOM UI — both stay as-is in the output.
const RENDERABLE_BLOCK_TYPES = new Set(["quote", "overlay", "spread"]);

const UNSUPPORTED_RENDER_MESSAGE = (lang: string) =>
  `「${lang}」类型的卡片不支持渲染为图片（仅支持 quote/overlay/spread）。`;

export interface RenderCardPngResult {
  ok: true;
  title: string;
  width: number;
  height: number;
  pngBase64: string;
}

// Renders the FIRST card block in the given markdown text to a PNG (in
// memory). Shared by the CLI's render-card (writes a file) and the MCP
// render_card_png tool (returns image content).
export async function renderCardPngBase64(
  ctx: VaultContext,
  opts: { markdown: string; width?: number; height?: number }
): Promise<RenderCardPngResult> {
  const { blocks } = findCardBlocks(opts.markdown);
  const block = blocks[0];
  if (!block) fail("没有找到 StrataBoard 卡片块（```quote/overlay/spread 围栏块）。");
  if (block.endLine < 0) fail(`第 ${block.line} 行的卡片块未闭合。`);
  if (!RENDERABLE_BLOCK_TYPES.has(block.lang)) fail(UNSUPPORTED_RENDER_MESSAGE(block.lang));
  const runtime = await createRenderRuntime(ctx.vault, ctx.settings);
  try {
    const rendered = await renderCardBlockPng(block.lang, block.body, runtime.deps, {
      width: opts.width,
      height: opts.height,
    });
    return {
      ok: true,
      title: rendered.title,
      width: rendered.width,
      height: rendered.height,
      pngBase64: rendered.png.toString("base64"),
    };
  } finally {
    await runtime.save();
  }
}

// File name safe on every platform (titles may contain / : etc.).
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|[\]]/g, "_").trim() || "card";
}

// CLI render-card: renders the first card block of the input text and writes
// the PNG to --out (default ./<标题>-<日期>.png).
export async function renderCardToFile(
  ctx: VaultContext,
  opts: { markdown: string; out?: string; width?: number; height?: number }
): Promise<{ ok: true; file: string; title: string; width: number; height: number }> {
  const rendered = await renderCardPngBase64(ctx, opts);
  const target = path.resolve(opts.out ?? `./${sanitizeFileName(rendered.title)}-${formatDate(new Date())}.png`);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, Buffer.from(rendered.pngBase64, "base64"));
  return { ok: true, file: target, title: rendered.title, width: rendered.width, height: rendered.height };
}

export interface RenderDocBlockResult {
  lang: string;
  line: number;
  ok: boolean;
  image?: string;
  error?: string;
}

export interface RenderDocResult {
  ok: boolean;
  file: string;
  outputMarkdown: string;
  images: string[];
  blocks: RenderDocBlockResult[];
}

// CLI render-doc / MCP render_doc_images: renders every card block in a
// markdown file to a PNG under the assets dir, then writes a copy of the
// document with each successfully rendered block replaced by an image link
// (relative to the output markdown). Failed/unsupported blocks keep their
// original text. ok = every renderable block rendered.
export async function renderDoc(
  ctx: VaultContext,
  opts: { file: string; outDir?: string; outMd?: string; width?: number; height?: number }
): Promise<RenderDocResult> {
  const absFile = path.isAbsolute(opts.file) ? opts.file : path.join(ctx.vault, opts.file);
  if (!fs.existsSync(absFile)) fail(`文件不存在: ${absFile}`);
  const markdown = await fs.promises.readFile(absFile, "utf8");
  const { lines, blocks } = findCardBlocks(markdown);
  if (blocks.length === 0) fail(`没有找到 StrataBoard 卡片块: ${absFile}`);

  const dir = path.dirname(absFile);
  const base = path.basename(absFile).replace(/\.md$/i, "");
  const outDir = opts.outDir ? path.resolve(opts.outDir) : path.join(dir, `${base}.assets`);
  const outMd = opts.outMd ? path.resolve(opts.outMd) : path.join(dir, `${base}.images.md`);
  await fs.promises.mkdir(outDir, { recursive: true });

  const runtime = await createRenderRuntime(ctx.vault, ctx.settings);
  const results: RenderDocBlockResult[] = [];
  // 0-based line index → replacement lines ([] deletes the line).
  const replacements = new Map<number, string[]>();
  try {
    for (const block of blocks) {
      if (!RENDERABLE_BLOCK_TYPES.has(block.lang)) {
        results.push({ lang: block.lang, line: block.line, ok: false, error: `${UNSUPPORTED_RENDER_MESSAGE(block.lang)}已保留原文。` });
        continue;
      }
      if (block.endLine < 0) {
        results.push({ lang: block.lang, line: block.line, ok: false, error: "围栏代码块未闭合。" });
        continue;
      }
      try {
        const rendered = await renderCardBlockPng(block.lang, block.body, runtime.deps, {
          width: opts.width,
          height: opts.height,
        });
        const pngPath = path.join(outDir, `${base}-card-${block.line}.png`);
        await fs.promises.writeFile(pngPath, rendered.png);
        const rel = path.relative(path.dirname(outMd), pngPath).split(path.sep).join("/");
        replacements.set(block.startLine, [`![${sanitizeFileName(rendered.title)}](${rel})`]);
        for (let i = block.startLine + 1; i <= block.endLine; i++) replacements.set(i, []);
        results.push({ lang: block.lang, line: block.line, ok: true, image: pngPath });
      } catch (e) {
        results.push({ lang: block.lang, line: block.line, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    await runtime.save();
  }

  const outLines: string[] = [];
  lines.forEach((line, i) => {
    const replacement = replacements.get(i);
    if (replacement) outLines.push(...replacement);
    else outLines.push(line);
  });
  await fs.promises.writeFile(outMd, outLines.join("\n") + "\n");

  const renderable = results.filter((r) => RENDERABLE_BLOCK_TYPES.has(r.lang));
  return {
    ok: renderable.every((r) => r.ok),
    file: absFile,
    outputMarkdown: outMd,
    images: results.flatMap((r) => (r.image ? [r.image] : [])),
    blocks: results,
  };
}
