// MCP stdio server exposing the StrataBoard CLI's capabilities to external
// AI agents (Claude Code, Hermes, ...). Bundled to mcp-server.js next to the
// plugin's main.js by scripts/build-mcp.mjs (obsidian aliased to the CLI's
// shim, platform node). All tool logic lives in src/cli/commands.ts — this
// file only registers tools and adapts results to MCP content blocks.

import * as fs from "fs";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createVaultContext,
  getAgentGuide,
  listIndicatorGroups,
  listSources,
  probeData,
  renderCardPngBase64,
  renderDoc,
  searchSymbols,
  validateCardsInVault,
  type VaultContext,
} from "../cli/commands";
import { ASSET_TYPES, type AssetType } from "../types";
import { redactSecrets } from "../modules/redact";

// --vault flag > STRATABOARD_VAULT env > walk up from cwd (createVaultContext).
function vaultOverrideFromArgv(): string | undefined {
  const i = process.argv.indexOf("--vault");
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ASSET_TYPE_LIST = ASSET_TYPES.join(" | ");
const assetTypeSchema = z
  .enum(ASSET_TYPES as [AssetType, ...AssetType[]])
  .describe(`资产类型：${ASSET_TYPE_LIST}`);

type JsonContent = { content: { type: "text"; text: string }[]; isError?: boolean };

function jsonResult(data: unknown): JsonContent {
  // All MCP output passes the central redactor (env-var secrets could be
  // echoed back inside error payloads or responses).
  return { content: [{ type: "text", text: redactSecrets(JSON.stringify(data, null, 2)) }] };
}

function errorResult(e: unknown): JsonContent {
  // Errors are not always Error instances (some libs throw plain objects) —
  // stringify those instead of emitting "[object Object]".
  const message = e instanceof Error ? e.message : typeof e === "object" && e !== null ? JSON.stringify(e) : String(e);
  return {
    content: [{ type: "text", text: redactSecrets(message) }],
    isError: true,
  };
}

// Adapts a commands.ts function to a tool handler: result objects go out as
// JSON text (same shape the CLI prints); thrown errors become isError
// results so the server process never dies on a bad call.
function wrap<A>(fn: (args: A) => unknown): (args: A) => Promise<JsonContent> {
  return async (args) => {
    try {
      return jsonResult(await fn(args));
    } catch (e) {
      return errorResult(e);
    }
  };
}

function readPluginVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
    return String(manifest.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  // Resolved once at startup and injected into every handler.
  const ctx: VaultContext = createVaultContext(vaultOverrideFromArgv() ?? process.env.STRATABOARD_VAULT);

  const instructions = [
    "你正在通过 StrataBoard 的 MCP 工具协助用户操作 Obsidian 金融卡片。按任务先读取对应指南：数据源用 get_source_guide，卡片用 get_card_guide，本地脚本用 get_script_guide，自定义指标用 get_indicator_guide。",
    "写卡片前用 list_sources / search_symbols 确认数据源和代码，不要凭记忆猜；写完或改完后必须调用 validate_cards。需要确认真实数据可用时调用 probe_data。",
    "数据源只能由用户在设置页逐项确认并保存；不得直接修改 data.json，不得生成配置导入文件。API 密钥只能由用户填入插件的凭据字段，不得索取、复述或写入 AI 上下文。",
    `MCP 不可用时可使用 CLI 备用入口：node "${__dirname}/cli.js" guide <source|card|script|indicator> --vault "${ctx.vault}"；其余命令可通过 node "${__dirname}/cli.js" --help 查看。`,
  ].join("\n");
  const server = new McpServer(
    { name: "strataboard", version: readPluginVersion() },
    { instructions }
  );

  server.registerTool(
    "search_symbols",
    {
      description:
        "在 vault 的本地符号库（含各自定义数据源的静态代码表）里搜索金融代码。写卡片前先用它确认代码与资产类型，不要凭记忆猜。",
      inputSchema: {
        query: z.string().describe("搜索关键词：名称（如 茅台）或代码片段（如 600519）"),
        assetType: assetTypeSchema.optional().describe("可选，按资产类型过滤"),
        limit: z.number().int().positive().optional().describe("最多返回条数，默认 20"),
      },
    },
    wrap(({ query, assetType, limit }) => searchSymbols(ctx, { query, assetType, limit }))
  );

  server.registerTool(
    "list_sources",
    {
      description: "列出 vault 里配置的全部自定义数据源（id/名称/格式/是否启用/是否脚本产物）。custom 类型卡片需要这里的 id 作为 sourceId。",
    },
    wrap(() => listSources(ctx))
  );

  server.registerTool(
    "list_indicator_groups",
    {
      description:
        "列出用户在设置页定义的全部指标组（命名指标组合，含各组的指标实例列表）。写卡时可把某个指标组展开为 indicators 列表。设置为 server 启动时读取，插件运行期间新建/修改的组需重启 MCP server 后可见。",
    },
    wrap(() => listIndicatorGroups(ctx))
  );

  server.registerTool(
    "validate_cards",
    {
      description:
        "校验一段 Markdown 文本里的全部 StrataBoard 卡片块及 quote 卡指标。检查卡片字段、指标存在性、审批/加载状态和参数键；写完或改完卡片后调用，逐块返回行号与错误原因。",
      inputSchema: {
        markdown: z.string().describe("完整的 Markdown 文本（直接传内容，不是文件路径）"),
      },
    },
    wrap(({ markdown }) => validateCardsInVault(ctx, { markdown, label: "mcp" }))
  );

  server.registerTool(
    "probe_data",
    {
      description:
        "真实调用数据接口，确认某代码最近是否有数据。search 查不到或不确定数据是否可用时使用；rows=0 时读 hint 字段里的可能原因。",
      inputSchema: {
        code: z.string().describe("资产代码，如 600519.SH"),
        assetType: assetTypeSchema.optional().describe("资产类型，默认 custom"),
        sourceId: z.string().optional().describe("自定义数据源 id（见 list_sources）"),
        days: z.number().int().positive().optional().describe("回看天数（日历日），默认 14"),
      },
    },
    wrap(({ code, assetType, sourceId, days }) => probeData(ctx, { code, assetType, sourceId, days }))
  );

  server.registerTool(
    "get_card_guide",
    {
      description: "返回《StrataBoard 卡片编写指南》全文（各卡片块的完整 YAML schema 与示例）。第一次要写卡片时先读它。",
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: getAgentGuide(ctx, "card", __dirname).guide,
        },
      ],
    })
  );

  server.registerTool(
    "get_script_guide",
    {
      description:
        "返回 StrataBoard「本地脚本」功能的编写指南：CSV 产物契约（宽表 / 单序列 OHLCV）、系统权限提示与合规规则。用户要写数据处理脚本时先读它；脚本放进 scriptFolderPath，产物写到其 output/ 子目录、文件名与脚本同名，插件会自动注册为数据源。",
    },
    async () => jsonResult(getAgentGuide(ctx, "script", __dirname))
  );

  server.registerTool(
    "get_indicator_guide",
    {
      description:
        "返回 StrataBoard「自定义指标」功能的编写指南：指标文件的 module.exports 契约（metadata/inputConfig/defaultInputs/plotConfig/calculate）、注入的 oak API（oakscriptjs 精选表面）与合规红线（纯计算，禁 require/网络/DOM）。用户要写或修改有权使用的技术指标代码时先读它；指标文件放进 indicatorFolderPath，文件名 slug 即指标 id，插件自动注册进指标系统。插件不内置指标。",
    },
    async () => jsonResult(getAgentGuide(ctx, "indicator", __dirname))
  );

  server.registerTool(
    "get_source_guide",
    {
      description:
        "返回 StrataBoard「自定义数据源」配置指南。需要添加或修复数据源时先读它；数据源只能由用户在设置页逐项填写、确认并保存，不支持配置导入/导出。API 密钥只能由用户填入数据源弹窗的「凭据」字段，不进入 AI 上下文。",
    },
    async () => jsonResult(getAgentGuide(ctx, "source", __dirname))
  );

  server.registerTool(
    "render_card_png",
    {
      description:
        "把一段 Markdown 里的第一个 StrataBoard 卡片块（quote/overlay/spread）渲染成 PNG 图片，直接返回图片内容。用于把图表带给不支持本插件的平台（如飞书文档）。financial-widget/calendar 卡片不支持渲染。",
      inputSchema: {
        markdown: z.string().describe("包含一个卡片围栏块（```quote/```overlay/```spread）的 Markdown 文本"),
        width: z.number().int().positive().optional().describe("图片宽度（CSS px，按 2x 输出），默认 960"),
        height: z.number().int().positive().optional().describe("图片高度，默认 400"),
      },
    },
    async ({ markdown, width, height }) => {
      try {
        const rendered = await renderCardPngBase64(ctx, { markdown, width, height });
        return {
          content: [
            { type: "image" as const, data: rendered.pngBase64, mimeType: "image/png" as const },
            { type: "text" as const, text: JSON.stringify({ ok: true, title: rendered.title, width: rendered.width, height: rendered.height }) },
          ],
        };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "render_doc_images",
    {
      description:
        "把一篇 Markdown 文章里的全部 StrataBoard 卡片块渲染成 PNG（写入 <文章名>.assets/ 或 outDir），并生成一份图片链接版 Markdown（<文章名>.images.md），用于发布到飞书等平台。逐块返回渲染状态；失败的块保留原文。",
      inputSchema: {
        file: z.string().describe("文章路径：绝对路径或 vault 相对路径"),
        outDir: z.string().optional().describe("PNG 输出目录，默认 <文章目录>/<文章名>.assets/"),
        width: z.number().int().positive().optional().describe("图片宽度（CSS px，按 2x 输出），默认 960"),
        height: z.number().int().positive().optional().describe("图片高度，默认 400"),
      },
    },
    wrap(({ file, outDir, width, height }) => renderDoc(ctx, { file, outDir, width, height }))
  );

  await server.connect(new StdioServerTransport());
  console.error(`StrataBoard MCP server 已启动（vault: ${ctx.vault}）`);
}

main().catch((e) => {
  console.error(`StrataBoard MCP server 启动失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
