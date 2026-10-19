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
  listIndicatorGroups,
  listSources,
  probeData,
  renderCardToFile,
  renderDoc,
  searchSymbols,
  validateCards,
} from "./commands";
import { ASSET_TYPES } from "../types";
import { redactSecrets } from "../modules/redact";

interface ParsedArgs {
  _: string[];
  // A repeated flag collects all values into an array (e.g. --api-key).
  flags: Record<string, string | boolean | string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { _: [], flags: {} };
  const put = (name: string, value: string | boolean) => {
    const prev = args.flags[name];
    if (prev === undefined) args.flags[name] = value;
    else if (Array.isArray(prev)) prev.push(String(value));
    else args.flags[name] = [String(prev), String(value)];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        put(a.slice(2, eq), a.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        put(a.slice(2), argv[++i]);
      } else {
        put(a.slice(2), true);
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function out(data: unknown): void {
  // All CLI output passes the central redactor (secrets enter the process via
  // env vars and could be echoed back inside error payloads or responses).
  process.stdout.write(redactSecrets(JSON.stringify(data, null, 2)) + "\n");
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
  groups
      列出全部指标组（命名指标组合，可在卡片编辑弹窗一键应用）。
  validate <文件路径|->
      校验一个 Markdown 文件中所有 StrataBoard 卡片块（"-" 表示从 stdin 读）。
      全部通过退出码 0，任一失败退出码 1。
  probe <代码> [--type <资产类型>=custom] [--source <数据源id>] [--days N=14]
      探测某代码最近 N 天是否真有数据。必须带 --source。
  render-card <文件路径|-> [--out <png路径>] [--width N=960] [--height N]
      把输入 Markdown 里的第一个卡片块（quote/overlay/spread）渲染成 PNG 图片
      （"-" 表示从 stdin 读）。默认输出 ./<标题>-<日期>.png。
      需要插件目录里有 canvas 原生模块（npm run build 部署时自带）。
  render-doc <文章.md> [--out-dir <目录>] [--out-md <路径>] [--width N=960] [--height N]
      把文章里所有卡片块渲染成 PNG（默认输出到 <文章名>.assets/），并生成一份
      图片链接版 Markdown（默认 <文章名>.images.md），可直接发布到飞书等平台。
      不支持的卡片类型（financial-widget/calendar）保留原文。路径可以是绝对
      路径或 vault 相对路径。全部渲染成功退出码 0，任一失败退出码 1。
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
  // cwd. Commands that need the vault resolve it lazily; validate works
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
    case "groups":
      out(listIndicatorGroups(needVault()));
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
      if (result.hint) process.stderr.write(`提示：${redactSecrets(result.hint)}\n`);
      out(result);
      break;
    }
    case "render-card": {
      const target = args._[1];
      if (!target) throw new CliError("render-card 需要一个 Markdown 文件路径（或 - 表示 stdin）。");
      let text: string;
      if (target === "-") {
        text = fs.readFileSync(0, "utf8");
      } else {
        const file = path.resolve(target);
        if (!fs.existsSync(file)) throw new CliError(`文件不存在: ${file}`);
        text = fs.readFileSync(file, "utf8");
      }
      const result = await renderCardToFile(needVault(), {
        markdown: text,
        out: flagString(args.flags, "out"),
        width: flagInt(args.flags, "width", 960),
        height: flagInt(args.flags, "height", 0) || undefined,
      });
      out(result);
      break;
    }
    case "render-doc": {
      const target = args._[1];
      if (!target) throw new CliError("render-doc 需要一个 Markdown 文件路径（绝对路径或 vault 相对路径）。");
      const result = await renderDoc(needVault(), {
        file: target,
        outDir: flagString(args.flags, "out-dir"),
        outMd: flagString(args.flags, "out-md"),
        width: flagInt(args.flags, "width", 960),
        height: flagInt(args.flags, "height", 0) || undefined,
      });
      out(result);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    default:
      process.stderr.write(`未知命令: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  // Thrown values are not always Error instances (some parsers throw plain
  // {message} objects) — dig the message out instead of "[object Object]".
  const message =
    e instanceof Error ? e.message
    : typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message)
    : String(e);
  process.stderr.write(JSON.stringify({ ok: false, error: redactSecrets(message) }, null, 2) + "\n");
  process.exitCode = 1;
});
