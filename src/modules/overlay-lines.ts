import type { OverlayCompareMode, SeriesLineType, SeriesPoint, SeriesRef } from "../types";

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
