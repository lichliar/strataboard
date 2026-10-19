/**
 * Indicator system barrel: contract types, registry + cache singletons,
 * custom-indicator loader, bar converters.
 */

export type {
  IndicatorDef,
  IndicatorInstance,
  IndicatorCalculate,
  IndicatorResultLike,
  ValidateIndicatorResult,
} from "./contract";
export { validateIndicatorDef, formatIndicatorLabel } from "./contract";
export { IndicatorRegistry, indicatorRegistry } from "./registry";
export { IndicatorComputeCache, indicatorComputeCache } from "./compute-cache";
export {
  syncIndicatorFiles,
  getIndicatorLoadErrors,
  getUnapprovedIndicators,
  type IndicatorLoaderHost,
  type IndicatorLoadError,
  type PendingIndicatorApproval,
  type IndicatorApprovalDecision,
} from "./loader";
export { ohlcvToBars, adaptResultTimes } from "./bars";
export {
  computeIndicatorForInstance,
  recordIndicatorRuntimeError,
  getIndicatorRuntimeError,
  getIndicatorRuntimeErrors,
  clearIndicatorRuntimeErrors,
} from "./compute";
