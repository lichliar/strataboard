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
  listSources,
  probeData,
  searchSymbols,
  validateCards,
  type VaultContext,
} from "../cli/commands";
import { renderAiGuide } from "../modules/ai-guide";
import { ASSET_TYPES, type AssetType } from "../types";

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
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(e: unknown): JsonContent {
  return {
    content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  };
}

// Adapts a commands.ts function to a tool handler: result objects go out as
// JSON text (same shape the CLI prints); thrown errors become isError
// results so the server process never dies on a bad call.
function wrap<A>(fn: (args: A) => unknown | Promise<unknown>): (args: A) => Promise<JsonContent> {
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

  const server = new McpServer({ name: "strataboard", version: readPluginVersion() });

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
    "validate_cards",
    {
      description:
        "校验一段 Markdown 文本里的全部 StrataBoard 卡片块（quote/overlay/spread/financial-widget/calendar）。写完或改完卡片后调用，逐块返回行号与错误原因。",
      inputSchema: {
        markdown: z.string().describe("完整的 Markdown 文本（直接传内容，不是文件路径）"),
      },
    },
    wrap(({ markdown }) => validateCards({ markdown, label: "mcp" }))
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
          text: renderAiGuide(__dirname),
        },
      ],
    })
  );

  await server.connect(new StdioServerTransport());
  console.error(`StrataBoard MCP server 已启动（vault: ${ctx.vault}）`);
}

main().catch((e) => {
  console.error(`StrataBoard MCP server 启动失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
