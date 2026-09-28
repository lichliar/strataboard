// Standalone Node CLI for external AI agents working in a vault with the
// StrataBoard plugin installed. No Obsidian runtime: esbuild bundles this
// entry with the plugin's parser/client modules, aliasing "obsidian" to
// ./obsidian-shim.ts (see scripts/build-cli.mjs). This file is only argument
// parsing and JSON printing — the command logic lives in ./commands.ts and
// is shared with the MCP server (src/mcp/server.ts). Every command prints
// JSON to stdout; failures print {"ok":false,...} JSON to stderr, exit 1.

import * as fs from "fs";
import * as path from "path";
import {
  CliError,
  createVaultContext,
  listMacroSeries,
  listSources,
  probeData,
  probeFred,
  searchSymbols,
  validateCards,
} from "./commands";
import { ASSET_TYPES } from "../types";

interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        args.flags[a.slice(2)] = argv[++i];
      } else {
        args.flags[a.slice(2)] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function out(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

const USAGE = `StrataBoard CLI — 供外部 AI 在不启动 Obsidian 的情况下查询本 vault 的金融数据配置。

用法: node cli.js <命令> [参数] [--vault <vault路径>]

通用:
  --vault <路径>   vault 根目录；缺省读环境变量 STRATABOARD_VAULT，再从当前目录向上查找含 .obsidian 的目录。

命令:
  search <关键词> [--type <资产类型>] [--limit N=20]
      搜索符号代码（本地代码库 + 各自定义数据源的静态代码表）。
      资产类型: ${ASSET_TYPES.join(" | ")}
  sources
      列出全部自定义数据源（含脚本产物标记）。
  macro [--query <关键词>]
      列出可用的 Tushare 宏观序列（seriesId/名称/频率/所需积分）。
  validate <文件路径|->
      校验一个 Markdown 文件中所有 StrataBoard 卡片块（"-" 表示从 stdin 读）。
      全部通过退出码 0，任一失败退出码 1。
  probe <代码> [--type <资产类型>=stock] [--source <数据源id>] [--days N=14]
      探测某代码最近 N 天是否真有数据。--type custom 必须带 --source。
  probe-fred <seriesId> [--days N=400]
      探测某 FRED 系列最近 N 天是否有观测值。
`;

function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function flagInt(flags: ParsedArgs["flags"], name: string, def: number): number {
  const v = flagString(flags, name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`--${name} 需要正整数，收到: ${v}`);
  return Math.floor(n);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || args.flags.help || args.flags.h) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  // Vault resolution order: --vault flag > STRATABOARD_VAULT > walk up from
  // cwd. Commands that need the vault resolve it lazily; validate/macro work
  // anywhere (even outside a vault).
  const needVault = () => createVaultContext(flagString(args.flags, "vault") ?? process.env.STRATABOARD_VAULT);

  switch (command) {
    case "search": {
      const result = await searchSymbols(needVault(), {
        query: args._[1] ?? "",
        assetType: flagString(args.flags, "type"),
        limit: flagInt(args.flags, "limit", 20),
      });
      out(result);
      break;
    }
    case "sources":
      out(listSources(needVault()));
      break;
    case "macro":
      out(listMacroSeries({ query: flagString(args.flags, "query") }));
      break;
    case "validate": {
      const target = args._[1];
      if (!target) throw new CliError("validate 需要一个 Markdown 文件路径（或 - 表示 stdin）。");
      let text: string;
      if (target === "-") {
        text = fs.readFileSync(0, "utf8");
      } else {
        const file = path.resolve(target);
        if (!fs.existsSync(file)) throw new CliError(`文件不存在: ${file}`);
        text = fs.readFileSync(file, "utf8");
      }
      const result = validateCards({ markdown: text, label: target });
      out(result);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case "probe": {
      const result = await probeData(needVault(), {
        code: args._[1] ?? "",
        assetType: flagString(args.flags, "type"),
        sourceId: flagString(args.flags, "source"),
        days: flagInt(args.flags, "days", 14),
      });
      if (result.hint) process.stderr.write(`提示：${result.hint}\n`);
      out(result);
      break;
    }
    case "probe-fred": {
      const result = await probeFred(needVault(), {
        seriesId: args._[1] ?? "",
        days: flagInt(args.flags, "days", 400),
      });
      if (result.hint) process.stderr.write(`提示：${result.hint}\n`);
      out(result);
      break;
    }
    default:
      process.stderr.write(`未知命令: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
  process.exitCode = 1;
});
