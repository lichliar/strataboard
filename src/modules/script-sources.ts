import { App, TFile } from "obsidian";
import type StrataBoardPlugin from "../main";
import type { CustomSourceDef } from "../types";
import { deriveCsvMapping, isSignalTable, parseCsvKline, parseCsvTable, parseSignalTable } from "./csv-quote-client";
import { normalizePath, sanitizeFileNamePart } from "../utils/slug";

// Script-output auto-registration (本地脚本): every CSV a user script drops
// into <脚本文件夹>/output/ becomes a format "csv" custom source, so the
// whole card stack (standalone / overlay / spread) can plot it with no
// manual setup. A file is auto-registered at most ONCE: settings.seenScriptOutputs
// remembers every filePath already processed, so a source the user deleted is
// not rebuilt by passive syncs (plugin load / file create). It IS re-registered
// when the script runs again — invalidateScriptOutput passes the path via
// forcePaths — or when the file is deleted and re-created (seen entries whose
// file no longer exists are pruned). Files that fail validation are NOT marked
// seen — a half-written CSV gets retried by the next sync.
// Concurrent syncs (plugin load + a file-create event landing together) race
// past the alreadyRegistered check — both see the source missing and both
// push it. Serialize syncs on a module-level chain so the second caller
// always observes the first one's registrations.
let syncChain: Promise<unknown> = Promise.resolve();

export function syncScriptSources(
  plugin: StrataBoardPlugin,
  forcePaths?: ReadonlySet<string>
): Promise<string[]> {
  const run = syncChain.then(() => syncScriptSourcesOnce(plugin, forcePaths));
  syncChain = run.catch(() => {});
  return run;
}

async function syncScriptSourcesOnce(
  plugin: StrataBoardPlugin,
  forcePaths?: ReadonlySet<string>
): Promise<string[]> {
  const outputDir = `${normalizePath(plugin.pluginSettings.scriptFolderPath)}/output`;
  const seen = new Set(plugin.pluginSettings.seenScriptOutputs);
  const registered: string[] = [];
  const existing = new Set<string>();
  let dirty = false;

  // Self-heal settings duplicated by the old race (or by merging devices):
  // keep the first copy of each script source id, drop the rest.
  const seenScriptIds = new Set<string>();
  const sources = plugin.pluginSettings.customSources.filter((s) => {
    if (!s.id.startsWith("script:")) return true;
    if (seenScriptIds.has(s.id)) {
      console.warn(`[StrataBoard] dropping duplicate script source "${s.name}" (${s.id})`);
      dirty = true;
      return false;
    }
    seenScriptIds.add(s.id);
    return true;
  });
  if (dirty) plugin.pluginSettings.customSources = sources;

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
  // Signal event tables (date,code,side,text) register as annotation sources
  // (purpose "signals") — no jsonMap/symbols, cards reference them via their
  // 信号/signals YAML fields.
  if (isSignalTable(table.fields)) {
    if (parseSignalTable(text).events.length === 0) return null;
    return {
      id: `script:${slug}`,
      name: file.basename,
      enabled: true,
      format: "csv",
      filePath: file.path,
      purpose: "signals",
    };
  }
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

// ===== Provenance helpers (chart cards + settings 本地脚本 section) =====

// Script-produced sources keep their auto-registered `script:<slug>` id even
// after the user renames them — the id prefix is the provenance marker.
export function isScriptSource(def: CustomSourceDef): boolean {
  return def.id.startsWith("script:");
}

// The producing script of an output CSV: same basename, .py, anywhere under
// the script folder (subfolders allowed). First match in path order wins.
export function findScriptForOutput(app: App, scriptFolder: string, outputPath: string): TFile | null {
  const base = outputPath.slice(outputPath.lastIndexOf("/") + 1).replace(/\.csv$/i, "");
  const prefix = `${normalizePath(scriptFolder)}/`;
  const matches = app.vault
    .getFiles()
    .filter((f) => f.extension === "py" && f.basename === base && f.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  return matches[0] ?? null;
}

export interface ScriptProvenance {
  def: CustomSourceDef;
  outputFile: TFile | null;
  scriptFile: TFile | null;
}

// Resolves a source id to its script provenance, or null when the source is
// not script-produced. Chart cards (provenance line / run button) and the
// settings 本地脚本 section both key everything off this.
export function getScriptProvenance(plugin: StrataBoardPlugin, sourceId: string): ScriptProvenance | null {
  const def = plugin.pluginSettings.customSources.find((s) => s.id === sourceId);
  if (!def || !isScriptSource(def) || !def.filePath) return null;
  const outputFile = plugin.app.vault.getAbstractFileByPath(def.filePath);
  return {
    def,
    outputFile: outputFile instanceof TFile ? outputFile : null,
    scriptFile: findScriptForOutput(plugin.app, plugin.pluginSettings.scriptFolderPath, def.filePath),
  };
}
