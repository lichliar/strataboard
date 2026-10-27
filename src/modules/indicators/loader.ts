/**
 * Custom indicator loader: every .js file under the configured indicator
 * folder is executed in a Node VM context (no require / network / DOM /
 * process — only a curated oakscriptjs API is injected as `oak`) and must
 * export a valid IndicatorDef via module.exports. Custom indicators live
 * ONLY in the in-memory registry: each sync clears and re-registers them,
 * so renames/deletes take effect on the next sync.
 *
 * Approval gate (W02-B): a file only executes when its vault path + content
 * SHA-256 match an entry the user confirmed (settings.approvedIndicatorHashes).
 * New or changed files are collected once per sync and handed to the host's
 * confirmIndicatorApprovals hook (batch modal); declined files are skipped for the
 * rest of the session so every settings save doesn't re-open the modal.
 * Without the hook (tests / non-interactive hosts) unapproved files never run.
 *
 * Mirrors script-sources.ts conventions: module-level promise chain
 * serializes concurrent syncs; per-file failures are collected, never thrown.
 */

import { createHash } from "crypto";
import { createContext, Script } from "vm";
import { serialize } from "v8";
import { Series, ta, taCore, math, getSourceSeries, compare, color, na, nz, fixnan } from "oakscriptjs";
import { normalizePath, sanitizeFileNamePart } from "../../utils/slug";
import { validateIndicatorDef, type IndicatorDef } from "./contract";
import { clearIndicatorRuntimeErrors } from "./compute";
import { indicatorRegistry } from "./registry";

// Structural host type (the real plugin object satisfies it); keeps this
// module free of the main.ts import cycle. The settings fields are added by
// the settings layer; both are read defensively with fallbacks.
export interface IndicatorLoaderHost {
  // Keep the loader host structural so the standalone CLI can provide a
  // filesystem-backed vault without importing Obsidian's Electron App type.
  app: {
    vault: {
      getFiles(): IndicatorFile[];
      cachedRead(file: IndicatorFile): Promise<string>;
    };
  };
  pluginSettings: {
    indicatorFolderPath?: string;
    disabledIndicators?: string[];
    approvedIndicatorHashes?: Record<string, string>;
    indicatorOverrides?: Record<string, { name?: string; description?: string; defaultInputs?: Record<string, unknown> }>;
  };
  // Batch confirmation for files whose path+hash have no stored approval.
  // The host persists accepted approvals (path → hash) itself and returns the
  // approved/declined partition; declined files are skipped until their
  // content changes or the plugin reloads.
  confirmIndicatorApprovals?: (pending: PendingIndicatorApproval[]) => Promise<IndicatorApprovalDecision>;
}

/** Minimal vault file shape required by the loader. */
export interface IndicatorFile {
  path: string;
  basename: string;
  extension: string;
}

export interface PendingIndicatorApproval {
  /** Vault path of the indicator file (approval key). */
  path: string;
  /** Path relative to the indicator folder, for display. */
  relativePath: string;
  /** SHA-256 of the current file content. */
  hash: string;
  /** True when an approval for this path exists but no longer matches. */
  changed: boolean;
}

export interface IndicatorApprovalDecision {
  approved: PendingIndicatorApproval[];
  rejected: PendingIndicatorApproval[];
}

const DEFAULT_INDICATOR_FOLDER = "指标";

// Curated oakscriptjs surface handed to custom indicator scripts as `oak`.
const oak = Object.freeze({
  Series,
  ta: Object.freeze({ ...ta }),
  taCore: Object.freeze({ ...taCore }),
  math: Object.freeze({ ...math }),
  getSourceSeries,
  compare,
  color: Object.freeze({ ...color }),
  na,
  nz,
  fixnan,
});

const MODULE_LOAD_TIMEOUT_MS = 1_000;
const CALCULATE_TIMEOUT_MS = 2_000;
// Block capability-bearing globals and code-generation/network/DOM APIs. Do
// not blacklist generic object-language words such as constructor/prototype:
// normal bundled indicator code commonly contains Object.prototype and class
// constructors, neither of which grants the script a host capability here.
const FORBIDDEN_SOURCE_TOKEN = /\b(?:require|import|process|globalThis|global|Buffer|fetch|XMLHttpRequest|WebSocket|EventSource|document|window|navigator|localStorage|sessionStorage|indexedDB|Worker|SharedWorker|setTimeout|setInterval|eval|Function|__proto__)\b/;

function assertRestrictedSource(body: string): void {
  const match = FORBIDDEN_SOURCE_TOKEN.exec(body);
  if (match) throw new Error(`指标代码包含受限标识符：${match[0]}`);
}

function assertBoundedResult(raw: unknown, barCount: number): asserts raw is ReturnType<IndicatorDef["calculate"]> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("calculate 必须返回指标结果对象");
  }
  const result = raw as Record<string, unknown>;
  const maxPoints = Math.max(1_000, barCount * 3);
  for (const field of ["plots", "plotCandles", "plotBars"] as const) {
    const record = result[field];
    if (record === undefined) continue;
    if (record == null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`calculate 返回的 ${field} 必须是对象`);
    }
    const entries = Object.entries(record as Record<string, unknown>);
    if (entries.length > 64) throw new Error(`指标输出 ${field} 超过 64 条序列`);
    for (const [id, points] of entries) {
      if (!Array.isArray(points)) throw new Error(`指标输出 ${field}.${id} 不是数组`);
      if (points.length > maxPoints) throw new Error(`指标输出 ${field}.${id} 超过长度上限 ${maxPoints}`);
    }
  }
  for (const field of ["hlines", "fills", "markers", "arrows", "bgColors", "barColors", "labels", "lines", "boxes", "linefills", "polylines", "tables"] as const) {
    const items = result[field];
    if (items === undefined) continue;
    if (!Array.isArray(items)) throw new Error(`指标输出 ${field} 不是数组`);
    if (items.length > maxPoints) throw new Error(`指标输出 ${field} 超过长度上限 ${maxPoints}`);
  }
  if (serialize(raw).byteLength > 16 * 1024 * 1024) throw new Error("指标输出超过 16 MB 上限");
}

export interface IndicatorLoadError {
  path: string;
  error: string;
}

let loadErrors: IndicatorLoadError[] = [];
let conflictErrors: IndicatorLoadError[] = [];
// Files that currently have no valid approval (declined this session, or no
// confirm hook to ask with). Surfaced in the 指标 tab so an unloaded
// indicator is distinguishable from a broken one.
let unapproved: { path: string; changed: boolean }[] = [];

// Session-scoped memory of declined `${path}\n${hash}` pairs: a declined file
// is not asked about again until its content changes or the plugin reloads,
// so the modal cannot reappear on every settings save / file event.
const sessionRejected = new Set<string>();

/** Errors from the most recent sync, for the settings UI. */
export function getIndicatorLoadErrors(): { errors: IndicatorLoadError[]; conflicts: IndicatorLoadError[] } {
  return { errors: loadErrors, conflicts: conflictErrors };
}

/** Files skipped by the approval gate in the most recent sync. */
export function getUnapprovedIndicators(): { path: string; changed: boolean }[] {
  return unapproved;
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
  const approvedHashes = settings.approvedIndicatorHashes ?? {};
  const prefix = `${folder}/`;

  const errors: IndicatorLoadError[] = [];
  const conflicts: IndicatorLoadError[] = [];
  const pending: PendingIndicatorApproval[] = [];
  const pendingBodies = new Map<string, { file: IndicatorFile; body: string }>();
  const unapprovedNext: { path: string; changed: boolean }[] = [];

  // Customs are pure in-memory state: rebuild the whole set from disk.
  indicatorRegistry.clearCustom();
  clearIndicatorRuntimeErrors();

  const loadOne = async (file: IndicatorFile, body: string) => {
    const slug = sanitizeFileNamePart(file.basename);
    if (!slug) {
      errors.push({ path: file.path, error: "文件名无法生成有效的指标 id" });
      return;
    }
    try {
      // Conservative source gate blocks common capability and VM-escape
      // primitives before execution. It may also match comments/strings;
      // custom indicator files should omit those restricted identifiers.
      assertRestrictedSource(body);
      const module = { exports: {} as unknown };
      const sandbox: Record<string, unknown> = { module, exports: module.exports, oak };
      const context = createContext(sandbox, {
        name: `StrataBoard indicator: ${file.path}`,
        codeGeneration: { strings: false, wasm: false },
      });
      // CJS-style contract: the script assigns module.exports = {...}.
      new Script(`"use strict";\n${body}`, { filename: file.path }).runInContext(context, {
        timeout: MODULE_LOAD_TIMEOUT_MS,
      });

      const validated = validateIndicatorDef(module.exports);
      if (!validated.ok) {
        errors.push({ path: file.path, error: validated.error });
        return;
      }
      // The file name owns the id (stable across edits of the script body);
      // category defaults to 自定义.
      const def: IndicatorDef = {
        ...validated.def,
        id: slug,
        category: validated.def.category || "自定义",
        name: settings.indicatorOverrides?.[slug]?.name?.trim() || validated.def.name,
        description: settings.indicatorOverrides?.[slug]?.description || undefined,
        metadata: settings.indicatorOverrides?.[slug]?.name?.trim()
          ? {
              ...validated.def.metadata,
              title: settings.indicatorOverrides[slug]!.name!.trim(),
              shortTitle: settings.indicatorOverrides[slug]!.name!.trim(),
            }
          : validated.def.metadata,
        defaultInputs: {
          ...validated.def.defaultInputs,
          ...(settings.indicatorOverrides?.[slug]?.defaultInputs ?? {}),
        },
        calculate: (bars, inputs) => {
          // Copies prevent an indicator from mutating chart data or settings.
          sandbox.__bars = bars.map((bar) => ({ ...bar }));
          sandbox.__inputs = structuredClone(inputs);
          try {
            const raw = new Script("module.exports.calculate(__bars, __inputs)").runInContext(context, {
              timeout: CALCULATE_TIMEOUT_MS,
            });
            assertBoundedResult(raw, bars.length);
            return raw;
          } finally {
            delete sandbox.__bars;
            delete sandbox.__inputs;
          }
        },
      };
      const registered = indicatorRegistry.registerCustom(def);
      if (!registered.ok) {
        conflicts.push({ path: file.path, error: registered.error ?? "注册失败" });
      }
    } catch (e) {
      errors.push({ path: file.path, error: e instanceof Error ? e.message : String(e) });
    }
  };

  // Pass 1: load approved files immediately; collect everything else.
  for (const file of plugin.app.vault.getFiles()) {
    if (file.extension !== "js" || !file.path.startsWith(prefix)) continue;
    const relativePath = file.path.slice(prefix.length);
    if (disabled.has(relativePath)) continue;

    const body = await plugin.app.vault.cachedRead(file);
    const approvalBody = body.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const hash = createHash("sha256").update(approvalBody).digest("hex");
    if (approvedHashes[file.path] === hash) {
      await loadOne(file, body);
      continue;
    }
    const changed = Object.prototype.hasOwnProperty.call(approvedHashes, file.path);
    if (sessionRejected.has(`${file.path}\n${hash}`)) {
      unapprovedNext.push({ path: file.path, changed });
      continue;
    }
    pending.push({ path: file.path, relativePath, hash, changed });
    pendingBodies.set(file.path, { file, body });
  }

  // Pass 2: one batch confirmation for everything that lacks an approval.
  if (pending.length > 0 && plugin.confirmIndicatorApprovals) {
    const decision = await plugin.confirmIndicatorApprovals(pending);
    for (const entry of decision.rejected) {
      sessionRejected.add(`${entry.path}\n${entry.hash}`);
      unapprovedNext.push({ path: entry.path, changed: entry.changed });
    }
    for (const entry of decision.approved) {
      const cached = pendingBodies.get(entry.path);
      if (cached) await loadOne(cached.file, cached.body);
    }
  } else {
    for (const entry of pending) {
      unapprovedNext.push({ path: entry.path, changed: entry.changed });
    }
  }

  loadErrors = errors;
  conflictErrors = conflicts;
  unapproved = unapprovedNext;
}
