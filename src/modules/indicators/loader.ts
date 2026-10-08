/**
 * Custom indicator loader: every .js file under the configured indicator
 * folder is executed in a tiny CJS sandbox (`new Function`, no require /
 * process — only a curated oakscriptjs API is injected as `oak`) and must
 * export a valid IndicatorDef via module.exports. Custom indicators live
 * ONLY in the in-memory registry: each sync clears and re-registers them,
 * so renames/deletes take effect on the next sync.
 *
 * Mirrors script-sources.ts conventions: module-level promise chain
 * serializes concurrent syncs; per-file failures are collected, never thrown.
 */

import type { App } from "obsidian";
import { Series, ta, taCore, math, getSourceSeries, compare, color, na, nz, fixnan } from "oakscriptjs";
import { normalizePath, sanitizeFileNamePart } from "../../utils/slug";
import { validateIndicatorDef, type IndicatorDef } from "./contract";
import { indicatorRegistry } from "./registry";

// Structural host type (the real plugin object satisfies it); keeps this
// module free of the main.ts import cycle. The settings fields are added by
// the settings layer; both are read defensively with fallbacks.
export interface IndicatorLoaderHost {
  app: App;
  pluginSettings: {
    indicatorFolderPath?: string;
    disabledIndicators?: string[];
  };
}

const DEFAULT_INDICATOR_FOLDER = "指标";

// Curated oakscriptjs surface handed to custom indicator scripts as `oak`.
const oak = { Series, ta, taCore, math, getSourceSeries, compare, color, na, nz, fixnan };

export interface IndicatorLoadError {
  path: string;
  error: string;
}

let loadErrors: IndicatorLoadError[] = [];
let conflictErrors: IndicatorLoadError[] = [];

/** Errors from the most recent sync, for the settings UI. */
export function getIndicatorLoadErrors(): { errors: IndicatorLoadError[]; conflicts: IndicatorLoadError[] } {
  return { errors: loadErrors, conflicts: conflictErrors };
}

// Serialize concurrent syncs on a module-level chain so a file event landing
// during a plugin-load sync always observes the first one's registrations.
let syncChain: Promise<unknown> = Promise.resolve();

export function syncIndicatorFiles(plugin: IndicatorLoaderHost): Promise<void> {
  const run = syncChain.then(() => syncIndicatorFilesOnce(plugin));
  syncChain = run.catch(() => {});
  return run;
}

async function syncIndicatorFilesOnce(plugin: IndicatorLoaderHost): Promise<void> {
  const settings = plugin.pluginSettings;
  const folder = normalizePath(settings.indicatorFolderPath ?? DEFAULT_INDICATOR_FOLDER);
  const disabled = new Set(settings.disabledIndicators ?? []);
  const prefix = `${folder}/`;

  const errors: IndicatorLoadError[] = [];
  const conflicts: IndicatorLoadError[] = [];

  // Customs are pure in-memory state: rebuild the whole set from disk.
  indicatorRegistry.clearCustom();

  for (const file of plugin.app.vault.getFiles()) {
    if (file.extension !== "js" || !file.path.startsWith(prefix)) continue;
    const relativePath = file.path.slice(prefix.length);
    if (disabled.has(relativePath)) continue;

    const slug = sanitizeFileNamePart(file.basename);
    if (!slug) {
      errors.push({ path: file.path, error: "文件名无法生成有效的指标 id" });
      continue;
    }

    let def: IndicatorDef;
    try {
      const body = await plugin.app.vault.cachedRead(file);
      const module = { exports: {} as unknown };
      // CJS-style contract: the script assigns module.exports = {...}.
      // `oak` is the only injected capability — never require/process.
      const run = new Function("module", "exports", "oak", body);
      run(module, module.exports, oak);

      const validated = validateIndicatorDef(module.exports);
      if (!validated.ok) {
        errors.push({ path: file.path, error: validated.error });
        continue;
      }
      // The file name owns the id (stable across edits of the script body);
      // custom origin and default category are forced.
      def = {
        ...validated.def,
        id: slug,
        origin: "custom",
        category: validated.def.category || "自定义",
      };
    } catch (e) {
      errors.push({ path: file.path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    const registered = indicatorRegistry.registerCustom(def);
    if (!registered.ok) {
      conflicts.push({ path: file.path, error: registered.error ?? "注册失败" });
    }
  }

  loadErrors = errors;
  conflictErrors = conflicts;
}
