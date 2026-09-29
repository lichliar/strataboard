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
import { CustomQuoteClient } from "../modules/custom-quote-client";
import { CsvQuoteClient } from "../modules/csv-quote-client";
import { formatDate } from "../utils/date";
import {
  ASSET_TYPES,
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
  fields?: string[];
  firstDate?: string;
  lastDate?: string;
  lastClose?: number;
  // Set when the call succeeded but returned no data — likely reasons
  // (permissions/points, wrong code, too-narrow window).
  hint?: string;
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
  const def = (ctx.settings.customSources ?? []).find((s) => s.id === sourceId);
  if (!def) fail(`自定义数据源不存在: ${sourceId}（用 list_sources / sources 命令查看可用 id）。`);
  const rows =
    def.format === "csv"
      ? await new CsvQuoteClient(def, async (p) => fs.promises.readFile(path.join(ctx.vault, p), "utf8")).fetchKline(code, start, end)
      : await new CustomQuoteClient(def).fetchKline(code, start, end);
  if (rows.length === 0) {
    return {
      ok: true,
      type,
      sourceId,
      code,
      rows: 0,
      hint: `数据源「${def.name}」在该区间没有返回 ${code} 的数据——可能代码不存在、代码格式不符，或区间太短。`,
    };
  }
  return {
    ok: true,
    type,
    sourceId,
    code,
    rows: rows.length,
    firstDate: rows[0].tradeDate,
    lastDate: rows[rows.length - 1].tradeDate,
    lastClose: rows[rows.length - 1].close,
  };
}
