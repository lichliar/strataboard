/**
 * Per-instance line colors for indicators, cycled when an instance has more
 * plots than there are colors. Readable on both chart themes.
 * chart-renderer.ts will import this palette (replacing its MA_COLORS) when
 * the MA overlay migrates to the indicator system — do not duplicate it there.
 */
export const INDICATOR_PALETTE = [
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
  "#f97316",
  "#0ea5e9",
  "#84cc16",
  "#e879f9",
];
