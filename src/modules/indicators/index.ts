/**
 * Indicator system barrel: contract types, registry + cache singletons,
 * custom-indicator loader, bar converters, palette.
 */

export type {
  IndicatorDef,
  IndicatorInstance,
  IndicatorCalculate,
  IndicatorContext,
  IndicatorResultLike,
  ValidateIndicatorResult,
} from "./contract";
export { validateIndicatorDef } from "./contract";
export { BUILTIN_INDICATORS } from "./builtins";
export { IndicatorRegistry, indicatorRegistry } from "./registry";
export { IndicatorComputeCache, indicatorComputeCache } from "./compute-cache";
export { syncIndicatorFiles, getIndicatorLoadErrors, type IndicatorLoaderHost, type IndicatorLoadError } from "./loader";
export { ohlcvToBars, adaptResultTimes } from "./bars";
export { INDICATOR_PALETTE } from "./palette";
