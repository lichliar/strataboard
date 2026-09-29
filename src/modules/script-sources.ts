import { TFile } from "obsidian";
import type StrataBoardPlugin from "../main";
import type { CustomSourceDef } from "../types";
import { deriveCsvMapping, parseCsvKline, parseCsvTable } from "./csv-quote-client";
import { normalizePath, sanitizeFileNamePart } from "../utils/slug";

// Prompt the user copies (plus their script / error output) to their own AI.
// Carries the CSV contract validated by buildScriptSourceDef below plus the
// compliance rules, and names no concrete endpoints. Shared by the script
// manager's「AI 辅助」section and 设置 → AI 辅助.
export const AI_SCRIPT_PROMPT = `我在用一个 Obsidian 插件（StrataBoard）的「脚本处理」功能：自己写 Python 脚本做数据计算，脚本把结果写成 CSV，插件自动把 CSV 注册为数据源并画成图表卡。请帮我写一个 python3 脚本，并把完整脚本内容给我。

这个脚本要做的事情：【在这里描述你想要的数据或计算；如果是修错，粘贴你的现有脚本和完整报错】

产物契约（必须遵守）：
- 输出文件写到脚本所在目录下的 output/ 子目录，文件名与脚本同名（foo.py → output/foo.csv），UTF-8 编码，首行表头；
- 两种格式二选一：(1) 宽表（推荐，可多条序列）：首列是日期（YYYY-MM-DD / YYYYMMDD / 时间戳均可），其余每个数值列是一条序列，列名即代码，空值表示该日无数据；(2) 单序列 OHLCV：表头含 date,open,high,low,close（vol/amount 可选）；
- 日期升序或乱序均可。

合规规则（必须遵守）：
- 不高频抓取、不批量下载保存；请求间隔 ≥ 1 秒（time.sleep(1)）；
- 优先增量抓取：先读已有 CSV 的最大日期，只补之后的数据，合并去重后重写；
- 只写 output/ 目录，不改其他文件；
- 尽量只用 python3 标准库；确实需要第三方库时在脚本顶部注释写明 pip install 命令。`;

// Script-output auto-registration (脚本处理): every CSV a user script drops
// into <脚本文件夹>/output/ becomes a format "csv" custom source, so the
// whole card stack (standalone / overlay / spread) can plot it with no
// manual setup. A file is auto-registered at most ONCE: settings.seenScriptOutputs
// remembers every filePath already processed, so a source the user deleted is
// not rebuilt by passive syncs (plugin load / file create). It IS re-registered
// when the script runs again — invalidateScriptOutput passes the path via
// forcePaths — or when the file is deleted and re-created (seen entries whose
// file no longer exists are pruned). Files that fail validation are NOT marked
// seen — a half-written CSV gets retried by the next sync.
export async function syncScriptSources(
  plugin: StrataBoardPlugin,
  forcePaths?: ReadonlySet<string>
): Promise<string[]> {
  const outputDir = `${normalizePath(plugin.pluginSettings.scriptFolderPath)}/output`;
  const seen = new Set(plugin.pluginSettings.seenScriptOutputs);
  const sources = plugin.pluginSettings.customSources;
  const registered: string[] = [];
  const existing = new Set<string>();
  let dirty = false;

  for (const file of plugin.app.vault.getFiles()) {
    if (file.extension !== "csv" || file.parent?.path !== outputDir) continue;
    existing.add(file.path);
    if (seen.has(file.path) && !forcePaths?.has(file.path)) continue;
    const slug = sanitizeFileNamePart(file.basename);
    if (!slug) continue; // no usable id — leave unseen, retry next sync
    const alreadyRegistered = sources.some(
      (s) => s.id === `script:${slug}` || (s.format === "csv" && s.filePath === file.path)
    );
    if (!alreadyRegistered) {
      const def = await buildScriptSourceDef(plugin, file, slug);
      if (!def) continue; // unparsable so far — leave unseen, retry later
      sources.push(def);
      registered.push(file.path);
    }
    seen.add(file.path);
    dirty = true;
  }

  // Prune seen entries whose file is gone — they can never match again, and
  // pruning lets a re-created output file register fresh.
  const kept = [...seen].filter((p) => existing.has(p));
  if (kept.length !== seen.size) dirty = true;

  if (dirty) {
    plugin.pluginSettings.seenScriptOutputs = kept;
    // The settings save channel hot-updates the data adapter's source list.
    await plugin.saveSettings();
  }
  return registered;
}

// Builds a CustomSourceDef for one output CSV, reusing the same mapping
// derivation + test-parse validation as the CSV setup wizard's save. Returns
// null when the file is not (yet) a valid contract CSV.
async function buildScriptSourceDef(
  plugin: StrataBoardPlugin,
  file: TFile,
  slug: string
): Promise<CustomSourceDef | null> {
  let text: string;
  try {
    text = await plugin.app.vault.cachedRead(file);
  } catch {
    return null;
  }
  const table = parseCsvTable(text);
  if (table.fields.length === 0 || table.rows.length === 0) return null;
  const { jsonMap, symbols } = deriveCsvMapping(table, { fallbackCode: file.basename });
  if (!jsonMap.cols.date) return null;
  const wide = jsonMap.cols.close === "{code}";
  if (wide && symbols.length === 0) return null;
  if (parseCsvKline(text, jsonMap, wide ? symbols[0].code : "").length === 0) return null;
  return {
    id: `script:${slug}`,
    name: file.basename,
    enabled: true,
    format: "csv",
    filePath: file.path,
    jsonMap,
    symbols,
  };
}
