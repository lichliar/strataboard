import type { Bar } from "oakscriptjs";
import type { OhlcvRow } from "../../types";
import { adaptResultTimes } from "./bars";
import { indicatorComputeCache } from "./compute-cache";
import { indicatorRegistry } from "./registry";
import type { IndicatorDef, IndicatorInstance, IndicatorResultLike } from "./contract";

// Latest compute-time failure per indicator id (load failures live in the
// loader). A failing indicator is isolated: it is skipped, recorded here, and
// never blocks the chart or other indicators. The 指标 tab surfaces this
// list; the loader clears it on every sync.
const runtimeErrors = new Map<string, string>();

export function recordIndicatorRuntimeError(id: string, error: unknown): void {
  runtimeErrors.set(id, error instanceof Error ? error.message : String(error));
}

export function getIndicatorRuntimeError(id: string): string | undefined {
  return runtimeErrors.get(id);
}

export function getIndicatorRuntimeErrors(): { id: string; error: string }[] {
  return [...runtimeErrors.entries()].map(([id, error]) => ({ id, error }));
}

export function clearIndicatorRuntimeErrors(): void {
  runtimeErrors.clear();
}

// Resolve + compute (compute-cached) + adapt one instance to chart times.
// Null = unknown id (warn and skip) OR failed calculation (recorded in the
// runtime-error store above, then skipped): a missing/broken custom indicator
// must never block the chart or the other indicators.
export function computeIndicatorForInstance(
  instance: IndicatorInstance,
  bars: Bar[],
  data: OhlcvRow[]
): { def: IndicatorDef; inputs: Record<string, unknown>; adapted: IndicatorResultLike } | null {
  const def = indicatorRegistry.resolve(instance.id);
  if (!def) {
    console.warn(`[StrataBoard] 未找到指标「${instance.id}」，已跳过（若是自定义指标，请确认脚本已启用且加载成功）。`);
    return null;
  }
  const inputs = { ...def.defaultInputs, ...instance.inputs };
  let result = indicatorComputeCache.get(def.id, inputs, bars);
  if (!result) {
    try {
      result = def.calculate(bars, inputs);
    } catch (e) {
      recordIndicatorRuntimeError(def.id, e);
      console.warn(`[StrataBoard] 指标「${def.id}」计算失败，已跳过：`, e);
      return null;
    }
    indicatorComputeCache.set(def.id, inputs, bars, result);
  }
  return { def, inputs, adapted: adaptResultTimes(result, data) };
}
