import type { App } from "obsidian";
import type { AssetType, CustomSourceDef, OhlcvRow, ParsedCardSpec, SeriesRef } from "../types";
import { ASSET_TYPES, MACRO_SERIES_OPTIONS } from "../types";
import { resolveDateRange } from "../utils/date";
import { parseCardSpec } from "./card-spec";
import {
  parseFredCardSpec,
  parseMacroCardSpec,
  parseOverlaySpec,
  parseSpreadSpec,
} from "./series-spec";
import type { DataAdapter } from "./data-adapter";
import type { SeriesAdapter } from "./series-adapter";
import type { SymbolIndex } from "./symbol-index";
import type { CardService } from "./card-service";
import type { CanvasToolbar } from "./toolbar";

// Registry of plugin capabilities exposed to the local AI (see ai-agent.ts).
// Tool results are plain text for the model; long payloads are truncated so a
// single CLI invocation stays well under the argv limit. API tokens never
// leave the tool implementations — the model only sees assetType/tsCode args.

export interface AiToolContext {
  app: App;
  dataAdapter: DataAdapter;
  seriesAdapter: SeriesAdapter;
  symbolIndex: SymbolIndex;
  cardService: CardService;
  toolbar: CanvasToolbar;
  getCustomSources: () => CustomSourceDef[];
  // Upserts a CustomSourceDef into settings and persists (never edits
  // data.json directly — a settings save would clobber external edits).
  saveCustomSource: (def: CustomSourceDef) => Promise<void>;
}

export interface AiTool<TCtx = AiToolContext> {
  name: string;
  description: string;
  // LLM-readable parameter documentation, inlined into the system prompt.
  paramsDoc: string;
  // true = the chat UI asks the user before running (create card, save source, ...).
  confirm: boolean;
  run: (args: Record<string, unknown>, ctx: TCtx) => Promise<string>;
}

const RESULT_CHAR_LIMIT = 4000;

function truncate(text: string): string {
  if (text.length <= RESULT_CHAR_LIMIT) return text;
  return `${text.slice(0, RESULT_CHAR_LIMIT)}\n…（结果过长已截断，共 ${text.length} 字符）`;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    if (required) throw new Error(`缺少参数 ${key}`);
    return "";
  }
  return String(value).trim();
}

function summarizeOhlcv(rows: OhlcvRow[], tail = 30): string {
  if (rows.length === 0) return "区间内没有数据。";
  const first = rows[0];
  const last = rows[rows.length - 1];
  const header = [
    `共 ${rows.length} 行，区间 ${first.tradeDate} ~ ${last.tradeDate}`,
    `最新收盘 ${last.close}，区间最高 ${Math.max(...rows.map((r) => r.high))}，区间最低 ${Math.min(...rows.map((r) => r.low))}`,
    `最近 ${Math.min(tail, rows.length)} 行（日期,开,高,低,收,量）：`,
  ];
  const body = rows
    .slice(-tail)
    .map((r) => `${r.tradeDate},${r.open},${r.high},${r.low},${r.close},${r.vol}`)
    .join("\n");
  return header.join("\n") + "\n" + body;
}

// Validators per card block type so create_card can hand the model a
// concrete error to fix instead of producing a broken card file.
function validateCardBody(blockType: string, body: string): string | null {
  switch (blockType) {
    case "tushare": {
      const result = parseCardSpec(body);
      return result.ok ? null : (result.error.message ?? "配置无效");
    }
    case "overlay":
      return parseOverlaySpec(body).error ?? null;
    case "spread":
      return parseSpreadSpec(body).error ?? null;
    case "fred":
      return parseFredCardSpec(body).error ?? null;
    case "macro":
      return parseMacroCardSpec(body).error ?? null;
    default:
      return `未知的卡片类型：${blockType}（可选 tushare / overlay / spread / fred / macro）`;
  }
}

export function buildAiTools(): AiTool[] {
  return [
    {
      name: "search_symbols",
      description: "搜索证券代码（A股股票/基金/指数/港股/可转债/期货/外汇/申万行业等）。",
      paramsDoc:
        'query: 搜索词（名称或代码，必填）；assetType: stock|fund|index|nhindex|hk|gbindex|cb|fut|fx|sw（可选，默认同时搜 stock/fund/index）；sourceId: 自定义数据源 id（可选，填了则在该自定义源内远程搜索）',
      confirm: false,
      run: async (args, ctx) => {
        const query = str(args, "query");
        const sourceId = str(args, "sourceId", false);
        if (sourceId) {
          const items = await ctx.dataAdapter.searchRemoteQuotes(sourceId, query);
          return truncate(items.map((i) => `${i.tsCode} ${i.name}`).join("\n") || "没有匹配结果。");
        }
        const assetTypeArg = str(args, "assetType", false);
        const types: AssetType[] = assetTypeArg
          ? [assetTypeArg as AssetType]
          : ["stock", "fund", "index"];
        for (const type of types) {
          if (!ASSET_TYPES.includes(type) || type === "custom") {
            throw new Error(`无效的 assetType：${type}`);
          }
        }
        const groups = await Promise.all(types.map((type) => ctx.symbolIndex.search(query, type)));
        const lines = groups.flat().slice(0, 30).map((i) => `${i.tsCode} ${i.name}（${i.assetType}）`);
        return truncate(lines.join("\n") || "没有匹配结果。");
      },
    },
    {
      name: "get_ohlcv",
      description: "获取某资产的 K 线行情数据（返回区间统计与最近若干行）。",
      paramsDoc:
        "assetType: 同上（必填）；tsCode: 代码，如 600519.SH（必填）；range: 1y|3y|5y|10y|20y|ytd|max 或 YYYY-MM-DD~YYYY-MM-DD（可选，默认 1y）；freq: D|W|M（可选，默认 D）；sourceId: 自定义数据源 id（assetType=custom 时必填）",
      confirm: false,
      run: async (args, ctx) => {
        const assetType = str(args, "assetType") as AssetType;
        if (!ASSET_TYPES.includes(assetType)) throw new Error(`无效的 assetType：${assetType}`);
        const freq = (str(args, "freq", false) || "D") as ParsedCardSpec["freq"];
        if (!["D", "W", "M"].includes(freq)) throw new Error(`无效的 freq：${freq}`);
        const spec: ParsedCardSpec = {
          symbol: str(args, "tsCode"),
          assetType,
          sourceId: str(args, "sourceId", false) || undefined,
          freq,
          range: str(args, "range", false) || "1y",
          version: 1,
        };
        const rows = await ctx.dataAdapter.loadOhlcv(spec);
        return truncate(summarizeOhlcv(rows));
      },
    },
    {
      name: "list_macro_series",
      description: "列出可用的中国宏观数据序列（货币供应/CPI/PPI/PMI/GDP/社融/LPR/国债收益率）的 seriesId。",
      paramsDoc: "无参数",
      confirm: false,
      run: async () => {
        const lines = MACRO_SERIES_OPTIONS.map((o) => `${o.id} — ${o.group} / ${o.label}`);
        return truncate(lines.join("\n"));
      },
    },
    {
      name: "get_macro_series",
      description: "获取中国宏观数据序列的值（先用 list_macro_series 查 seriesId）。",
      paramsDoc: "seriesId: 宏观序列 id（必填）；range: 同 get_ohlcv（可选，默认 5y）",
      confirm: false,
      run: async (args, ctx) => {
        const seriesId = str(args, "seriesId");
        const { start, end } = resolveDateRange(str(args, "range", false) || "5y");
        const points = await ctx.dataAdapter.loadMacroSeries(seriesId, iso(start), iso(end));
        if (points.length === 0) return "区间内没有数据。";
        const tail = points.slice(-24).map((p) => `${p.date}: ${p.value}`).join("\n");
        return truncate(`共 ${points.length} 个点，最近 ${Math.min(24, points.length)} 个：\n${tail}`);
      },
    },
    {
      name: "search_fred",
      description: "搜索 FRED（美联储经济数据库）序列。",
      paramsDoc: "query: 英文搜索词（必填），如 10-Year Treasury、CPI、unemployment rate",
      confirm: false,
      run: async (args, ctx) => {
        const results = await ctx.seriesAdapter.searchFredSeries(str(args, "query"));
        const lines = results
          .slice(0, 20)
          .map((r) => `${r.id} — ${r.title}（${r.frequency}）`);
        return truncate(lines.join("\n") || "没有匹配结果。");
      },
    },
    {
      name: "get_fred_series",
      description: "获取 FRED 序列的值。",
      paramsDoc:
        "seriesId: FRED 序列 id，如 DGS10（必填）；range: 同 get_ohlcv（可选，默认 5y）；transform: chg|ch1|pch|pc1|pca|cch|cca|log（可选，服务端变换，缺省为原始值）",
      confirm: false,
      run: async (args, ctx) => {
        const ref: SeriesRef = {
          source: "fred",
          seriesId: str(args, "seriesId"),
          transform: (str(args, "transform", false) || undefined) as SeriesRef["transform"],
        };
        const points = await ctx.seriesAdapter.loadSeries(ref, str(args, "range", false) || "5y");
        if (points.length === 0) return "区间内没有数据。";
        const tail = points.slice(-24).map((p) => `${p.date}: ${p.value}`).join("\n");
        return truncate(`共 ${points.length} 个点，最近 ${Math.min(24, points.length)} 个：\n${tail}`);
      },
    },
    {
      name: "list_custom_sources",
      description: "列出用户已配置的自定义数据源（名称/id/格式/启用状态）。",
      paramsDoc: "无参数",
      confirm: false,
      run: async (_args, ctx) => {
        const sources = ctx.getCustomSources();
        if (sources.length === 0) return "尚未配置任何自定义数据源。";
        return truncate(
          sources
            .map((s) => `${s.id} — ${s.name}（${s.format}，${s.enabled ? "启用" : "停用"}）${s.klineUrl}`)
            .join("\n")
        );
      },
    },
    {
      name: "create_card",
      description:
        "创建一张数据卡片文件（tushare K线卡 / overlay 叠加卡 / spread 计算卡 / fred 卡 / macro 宏观卡）。卡片出现在卡片库文件夹中。",
      paramsDoc:
        'blockType: tushare|overlay|spread|fred|macro（必填）；body: 卡片代码块的 YAML 正文（必填，格式与各卡片编辑弹窗一致，tushare 卡至少含 代码/资产类型/周期/时间范围 等中文字段）；baseName: 文件名，如 贵州茅台-600519.SH-Tushare.md（必填）',
      confirm: true,
      run: async (args, ctx) => {
        const blockType = str(args, "blockType");
        const body = str(args, "body");
        const baseName = str(args, "baseName");
        const error = validateCardBody(blockType, body);
        if (error) throw new Error(`卡片配置校验失败：${error}`);
        const file = await ctx.cardService.createRawCard(baseName, blockType, body);
        return `已创建卡片文件：${file.path}。可用 place_card_on_canvas 把它放到当前画布。`;
      },
    },
    {
      name: "place_card_on_canvas",
      description: "把一张已存在的卡片文件放到当前激活的画布上。",
      paramsDoc: "filePath: 卡片文件路径（必填，通常是 create_card 的返回路径）",
      confirm: true,
      run: async (args, ctx) => {
        const filePath = str(args, "filePath");
        const file = ctx.app.vault.getAbstractFileByPath(filePath);
        if (!file) throw new Error(`找不到文件：${filePath}`);
        ctx.toolbar.placeFileNode(filePath);
        return `已把 ${filePath} 放到当前画布。`;
      },
    },
    {
      name: "upsert_custom_source",
      description: "新增或更新一个自定义数据源配置（按 id 匹配更新）。",
      paramsDoc:
        'def: 完整的数据源定义 JSON（必填）：{ id, name, enabled, format: "tencent"|"eastmoney"|"json", klineUrl, searchUrl?, testCode?, jsonMap?, symbols? }。klineUrl 中的占位符：{code} {start} {end}（YYYYMMDD）{startIso} {endIso}（YYYY-MM-DD）；format=json 时 jsonMap 为 { rowsPath, rowKind: "array"|"object", cols: { date, open, close, high, low, vol, amount? } }',
      confirm: true,
      run: async (args, ctx) => {
        const raw = args.def;
        if (typeof raw !== "object" || raw === null) throw new Error("def 必须是对象");
        const def = raw as CustomSourceDef;
        if (!def.id || !def.name || !def.klineUrl) throw new Error("def 缺少 id / name / klineUrl");
        if (!["tencent", "eastmoney", "json"].includes(def.format)) {
          throw new Error(`无效的 format：${def.format}`);
        }
        def.enabled = def.enabled !== false;
        await ctx.saveCustomSource(def);
        return `已保存自定义数据源「${def.name}」（${def.id}）。`;
      },
    },
  ];
}

function iso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}
