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
  listSources,
  probeData,
  searchSymbols,
  validateCards,
  validateConfig,
} from "./commands";
import { ASSET_TYPES } from "../types";

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
  validate <文件路径|->
      校验一个 Markdown 文件中所有 StrataBoard 卡片块（"-" 表示从 stdin 读）。
      全部通过退出码 0，任一失败退出码 1。
  probe <代码> [--type <资产类型>=custom] [--source <数据源id>] [--days N=14]
      探测某代码最近 N 天是否真有数据。必须带 --source。
  validate-config <配置文件路径> [--days N=400] [--api-key <密钥|名称=密钥>]... [--api-key-file <json路径>] [--structural-only]
      导入前验证一个数据源配置 JSON（数组）：逐源结构校验 + 对 testCode 与
      全部 symbols 实发请求探测（默认 400 天窗口，--days 覆盖；干净 0 行会自动加宽到
      约 10 年复核一次以区分退市与配置错误），配了搜索模板的源发一次搜索（模板含
      {p.*} 时还会加测一个搜索结果代码，覆盖"代码不在符号表"的场景）。
      密钥解析顺序：文件内（含同组回落）→ 注入 → vault 里同名或同组的已配源。
      注入：--api-key 可重复，值是 <密钥>（全局兜底）或 <组名或源名>=<密钥>
      （按组名 > 源名 > 全局兜底指派）；--api-key-file 读 {"组名或源名": "密钥"} JSON
      （路径绝对或 vault 相对）；再兜底 STRATABOARD_API_KEY 环境变量。
      --structural-only 只做结构校验、不发任何请求。
      路径可以是绝对路径或 vault 相对路径。全部通过退出码 0，任一失败退出码 1。
`;

function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

// All values of a repeatable flag (single value comes back as a one-element
// list; boolean-only flags come back empty).
function flagStrings(flags: ParsedArgs["flags"], name: string): string[] {
  const v = flags[name];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v;
  return [];
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
    case "validate-config": {
      const target = args._[1];
      if (!target) throw new CliError("validate-config 需要一个配置文件路径（绝对路径或 vault 相对路径）。");
      const ctx = needVault();
      // Named key injections: "--api-key <key>" is the global fallback (the
      // "" entry), "--api-key <组名或源名>=<key>" targets one group/source;
      // --api-key-file merges a {"name": "key"} JSON object underneath.
      const apiKeys: Record<string, string> = {};
      const keyFile = flagString(args.flags, "api-key-file");
      if (keyFile) {
        const keyPath = path.isAbsolute(keyFile) ? keyFile : path.join(ctx.vault, keyFile);
        if (!fs.existsSync(keyPath)) throw new CliError(`密钥文件不存在: ${keyPath}`);
        try {
          const parsed = JSON.parse(fs.readFileSync(keyPath, "utf8"));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("必须是对象");
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string" && v.trim()) apiKeys[k.trim()] = v.trim();
          }
        } catch (e) {
          throw new CliError(`密钥文件不是合法 JSON（{"组名或源名": "密钥"}）: ${keyPath} — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      for (const spec of flagStrings(args.flags, "api-key")) {
        const eq = spec.indexOf("=");
        if (eq > 0) apiKeys[spec.slice(0, eq).trim()] = spec.slice(eq + 1).trim();
        else apiKeys[""] = spec.trim();
      }
      const result = await validateConfig(ctx, {
        file: target,
        days: flagInt(args.flags, "days", 400),
        apiKeys: Object.keys(apiKeys).length > 0 ? apiKeys : undefined,
        structuralOnly: Boolean(args.flags["structural-only"]),
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
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
  process.exitCode = 1;
});
