import type { CorrTransform, CustomSourceDef, OverlayCompareMode, SeriesLineType, SeriesPoint, SeriesRef, SeriesValueKind } from "../types";

// One line on a series (overlay/spread) chart. Defined here (not in
// series-chart-renderer.ts) so the headless CLI renderer can use it without
// importing the obsidian-bound renderer module.
export interface SeriesChartLine {
  name: string;
  color?: string;
  lineWidth?: number; // px, 1–4 (lightweight-charts LineWidth), default 2
  lineType?: SeriesLineType; // default "simple" straight segments
  // "baseline" (spread cards): 0-axis baseline area series shaded in the
  // 红涨绿跌 defaults; `color` is then unused (legend/guide follow the sign
  // of the latest value). "area" (spread cards): gradient fill under the line.
  style?: "baseline" | "area";
  points: SeriesPoint[];
}

// Line palette for overlay/spread charts; cycles when a card has more lines
// than colors. Colors stay readable on both themes. Length matches
// MAX_OVERLAY_SERIES so a full overlay card never repeats a color.
export const SERIES_LINE_COLORS = [
  "#2563eb", "#dc2626", "#f59e0b", "#8b5cf6", "#14b8a6",
  "#ec4899", "#0ea5e9", "#84cc16", "#f97316", "#6366f1",
];

// One overlay line plus whether it is a percent-ish series (drives the "%"
// suffix in the legend).
export interface OverlayLine {
  line: SeriesChartLine;
  percentish: boolean;
}

// Below this many paired samples the badge reports 样本不足 instead of a
// coefficient: a correlation on a handful of pairs is noise (and two pairs
// always produce a mathematically valid but meaningless ±1).
export const MIN_CORR_SAMPLES = 30;

export interface CorrelationReport {
  // Present unless the computation was impossible (see reason).
  coefficient?: number;
  sampleCount: number;
  // Why there is no coefficient: too few paired samples, or a constant
  // (zero-variance) transformed leg.
  reason?: "insufficient" | "constant";
  // 5% two-sided significance (normal approximation of the t statistic,
  // adequate at the enforced n ≥ MIN_CORR_SAMPLES).
  significant?: boolean;
  transformA: CorrTransform;
  transformB: CorrTransform;
}

// Default correlation transform per value kind: prices get returns, yields /
// spreads / cross-zero levels get first differences, and series that already
// ARE a change participate raw (never double-differenced).
const KIND_DEFAULT_TRANSFORM: Record<SeriesValueKind, CorrTransform> = {
  price: "return",
  yield: "diff",
  spread: "diff",
  level: "diff",
  change: "raw",
};

// The transform one series leg contributes to the correlation badge:
// explicit `corr` > explicit `kind` mapping > the source's declared
// seriesKind > the global price default. Semantics are always DECLARED —
// never inferred from the profile string, code suffix, or source name.
export function resolveCorrTransform(ref: SeriesRef, def?: CustomSourceDef): CorrTransform {
  if (ref.corr) return ref.corr;
  const kind = ref.kind ?? def?.seriesKind ?? "price";
  return KIND_DEFAULT_TRANSFORM[kind];
}

// Pearson correlation between two series after per-leg transforms. The level
// series are first cleaned of non-finite observations, then aligned to their
// common dates; transforms run between adjacent COMMON observations so both
// legs cover the same interval (the zero guard applies to ratio transforms
// only — 0 is a legitimate value for differences). The two transformed
// series are intersected once more before the correlation, which is what
// lets a "raw" leg pair with a "return"/"diff" leg.
export function computeSeriesCorrelation(
  a: SeriesPoint[],
  b: SeriesPoint[],
  transformA: CorrTransform,
  transformB: CorrTransform
): CorrelationReport {
  const aByDate = cleanByDate(a);
  const bByDate = cleanByDate(b);
  const dates = [...aByDate.keys()].filter((date) => bByDate.has(date)).sort();
  const seriesA = applyCorrTransform(dates, aByDate, transformA);
  const seriesB = applyCorrTransform(dates, bByDate, transformB);
  const bValues = new Map(seriesB.map((p) => [p.date, p.value]));
  const pairsA: number[] = [];
  const pairsB: number[] = [];
  for (const p of seriesA) {
    const valueB = bValues.get(p.date);
    if (valueB === undefined) continue;
    pairsA.push(p.value);
    pairsB.push(valueB);
  }
  const report = { sampleCount: pairsA.length, transformA, transformB };
  if (pairsA.length < MIN_CORR_SAMPLES) return { ...report, reason: "insufficient" };

  const meanA = pairsA.reduce((sum, value) => sum + value, 0) / pairsA.length;
  const meanB = pairsB.reduce((sum, value) => sum + value, 0) / pairsB.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < pairsA.length; i++) {
    const deltaA = pairsA[i] - meanA;
    const deltaB = pairsB[i] - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA * deltaA;
    varianceB += deltaB * deltaB;
  }
  if (varianceA === 0 || varianceB === 0) return { ...report, reason: "constant" };
  const coefficient = covariance / Math.sqrt(varianceA * varianceB);
  const t = Math.abs(coefficient) * Math.sqrt((pairsA.length - 2) / (1 - coefficient * coefficient));
  return { ...report, coefficient, significant: t > 1.96 };
}

// date → value map with non-finite observations dropped BEFORE alignment, so
// one bad observation doesn't also kill the neighbouring intervals.
function cleanByDate(points: SeriesPoint[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of points) {
    if (Number.isFinite(p.value)) map.set(p.date, p.value);
  }
  return map;
}

// Transforms one leg over the common dates. return/diff/bond emit at dates
// i ≥ 1 (they need the previous common observation); raw emits at every
// common date. All emitted values are finite by construction (inputs are
// pre-cleaned; the ratio guard skips zero/∞ results).
function applyCorrTransform(dates: string[], byDate: Map<string, number>, transform: CorrTransform): SeriesPoint[] {
  const result: SeriesPoint[] = [];
  for (let i = 0; i < dates.length; i++) {
    const current = byDate.get(dates[i])!;
    if (transform === "raw") {
      result.push({ date: dates[i], value: current });
      continue;
    }
    if (i === 0) continue;
    const previous = byDate.get(dates[i - 1])!;
    let value: number;
    if (transform === "return") {
      if (previous === 0) continue;
      value = current / previous - 1;
    } else if (transform === "diff") {
      value = current - previous;
    } else {
      // "bond": negated first difference — the bond-return direction. ("none"
      // legs never reach here; the caller excludes them upfront.)
      value = previous - current;
    }
    if (Number.isFinite(value)) result.push({ date: dates[i], value });
  }
  return result;
}

// Quote series are normalized to % change from the first point in range.
export function normalizeToPctChange(points: SeriesPoint[]): SeriesPoint[] {
  if (points.length === 0) return points;
  const base = points[0].value;
  if (base === 0) return points;
  return points.map((p) => ({ date: p.date, value: (p.value / base - 1) * 100 }));
}

// Z-score standardization: (x − mean) / std over the loaded range. Puts every
// line on an equal-volatility footing — the principled way to compare shape
// between a high-vol series (stocks) and a low-vol one (FX).
export function toZScore(points: SeriesPoint[]): SeriesPoint[] {
  if (points.length === 0) return points;
  const mean = points.reduce((sum, p) => sum + p.value, 0) / points.length;
  const variance = points.reduce((sum, p) => sum + (p.value - mean) ** 2, 0) / points.length;
  const std = Math.sqrt(variance);
  if (std === 0) return points.map((p) => ({ date: p.date, value: 0 }));
  return points.map((p) => ({ date: p.date, value: (p.value - mean) / std }));
}

export function buildOverlayLine(ref: SeriesRef, points: SeriesPoint[], mode: OverlayCompareMode, name: string): OverlayLine {
  // Quote lines normalize to % change only in percent mode (the default);
  // only then do they count as percent-ish for the legend suffix.
  if (ref.source === "quote") {
    if (mode === "percent") {
      return { line: { name, points: normalizeToPctChange(points) }, percentish: true };
    }
    return { line: { name, points }, percentish: false };
  }

  // Card-ref lines (an existing spread card) are plotted raw and count as
  // percent-ish — the common case is a spread of percent legs.
  return { line: { name, points }, percentish: true };
}
