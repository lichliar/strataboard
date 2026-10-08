/**
 * Unified indicator contract: the single shape every indicator (builtin
 * wrapper around a vendored lci file, self-written builtin, or user custom
 * script) is registered under. Obsidian-free so the CLI/MCP bundles and the
 * node benchmark can use it too.
 *
 * Chinese display strings (name / category / error messages) are carried as
 * data; display layers wrap them with t() — this module never calls t().
 */

import type { Bar, IndicatorResult, InputConfig, PlotConfig, HLineConfig, FillConfig } from "oakscriptjs";
import type { MarkerData } from "../../vendor/lci/types";

// The vendored standard files widen IndicatorResult the same way (see
// lci/standard/rsi.ts): markers are MarkerData from lci/types.
export type IndicatorResultLike = Omit<IndicatorResult, "markers"> & { markers?: MarkerData[] };

// Trading-day basis for indicators whose period means N TRADING days on
// resampled (W/M/Q/Y) charts. Only "ma" consumes it today.
export interface IndicatorContext {
  nativeBars?: Bar[];
}

export type IndicatorCalculate = (
  bars: Bar[],
  inputs: Record<string, unknown>,
  ctx?: IndicatorContext
) => IndicatorResultLike;

export interface IndicatorDef {
  /** Stable registry id, referenced from card YAML */
  id: string;
  /** Chinese display name (UI wraps with t() at display time) */
  name: string;
  /** 均线 | 通道 | 震荡 | 动量 | 趋势 | 波动 | 成交量 | 自定义 */
  category: string;
  origin: "builtin" | "custom";
  metadata: { title: string; shortTitle: string; overlay: boolean };
  inputConfig: InputConfig[];
  defaultInputs: Record<string, unknown>;
  plotConfig?: PlotConfig[];
  hlineConfig?: HLineConfig[];
  fillConfig?: FillConfig[];
  calculate: IndicatorCalculate;
}

/** What card YAML stores: registry id plus optional input overrides. */
export interface IndicatorInstance {
  id: string;
  inputs?: Record<string, unknown>;
  /** true = kept in the list but not drawn (per-card visibility toggle). */
  hidden?: boolean;
}

export type ValidateIndicatorResult = { ok: true; def: IndicatorDef } | { ok: false; error: string };

// Structural validation for custom indicator module.exports. Chinese errors
// name the missing/invalid field so users can fix their script directly.
export function validateIndicatorDef(raw: unknown): ValidateIndicatorResult {
  if (raw == null || typeof raw !== "object") {
    return { ok: false, error: "指标导出必须是一个对象（module.exports = {...}）" };
  }
  const obj = raw as Record<string, unknown>;

  const metadata = obj.metadata;
  if (metadata == null || typeof metadata !== "object") {
    return { ok: false, error: "缺少 metadata 字段（需含 title/shortTitle/overlay）" };
  }
  const meta = metadata as Record<string, unknown>;
  if (typeof meta.title !== "string" || meta.title.length === 0) {
    return { ok: false, error: "metadata.title 缺失或不是非空字符串" };
  }
  if (typeof meta.shortTitle !== "string" || meta.shortTitle.length === 0) {
    return { ok: false, error: "metadata.shortTitle 缺失或不是非空字符串" };
  }
  if (typeof meta.overlay !== "boolean") {
    return { ok: false, error: "metadata.overlay 缺失或不是布尔值" };
  }

  if (!Array.isArray(obj.inputConfig)) {
    return { ok: false, error: "inputConfig 缺失或不是数组" };
  }
  for (const entry of obj.inputConfig as unknown[]) {
    const cfg = entry as Record<string, unknown>;
    if (cfg == null || typeof cfg !== "object" || typeof cfg.id !== "string" || typeof cfg.type !== "string") {
      return { ok: false, error: "inputConfig 中存在缺少 id/type 的条目" };
    }
  }

  if (obj.defaultInputs == null || typeof obj.defaultInputs !== "object" || Array.isArray(obj.defaultInputs)) {
    return { ok: false, error: "defaultInputs 缺失或不是对象" };
  }

  if (typeof obj.calculate !== "function") {
    return { ok: false, error: "calculate 缺失或不是函数" };
  }

  const def: IndicatorDef = {
    id: typeof obj.id === "string" ? obj.id : "",
    name: typeof obj.name === "string" && obj.name ? obj.name : (meta.title as string),
    category: typeof obj.category === "string" && obj.category ? obj.category : "自定义",
    origin: obj.origin === "builtin" ? "builtin" : "custom",
    metadata: {
      title: meta.title as string,
      shortTitle: meta.shortTitle as string,
      overlay: meta.overlay as boolean,
    },
    inputConfig: obj.inputConfig as InputConfig[],
    defaultInputs: obj.defaultInputs as Record<string, unknown>,
    plotConfig: Array.isArray(obj.plotConfig) ? (obj.plotConfig as PlotConfig[]) : undefined,
    hlineConfig: Array.isArray(obj.hlineConfig) ? (obj.hlineConfig as HLineConfig[]) : undefined,
    fillConfig: Array.isArray(obj.fillConfig) ? (obj.fillConfig as FillConfig[]) : undefined,
    calculate: obj.calculate as IndicatorCalculate,
  };
  return { ok: true, def };
}
