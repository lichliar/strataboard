import type { Freq, OhlcvRow } from "../types";
import { parseDateYmd } from "./date";

// Coarsest-to-finest ordering of chart frequencies; rank comparisons decide
// which period buttons a card may offer (upsampling only, never downsampling).
export const FREQ_ORDER: Freq[] = ["D", "W", "M", "Q", "Y"];

export function freqRank(freq: Freq): number {
  return FREQ_ORDER.indexOf(freq);
}

export function maxFreq(a: Freq, b: Freq): Freq {
  return freqRank(a) >= freqRank(b) ? a : b;
}

// Header badge label for a source's native frequency (shown on every card).
export const FREQ_BADGE: Record<Freq, string> = {
  D: "日频",
  W: "周频",
  M: "月频",
  Q: "季频",
  Y: "年频",
};

const DAY_MS = 86400000;

// Detects a series' native frequency from the median gap between consecutive
// observations: ≤5 days → daily, ≤10 → weekly, ≤45 → monthly, ≤120 →
// quarterly, beyond → yearly. Fewer than 4 rows is too little evidence, so
// it conservatively reports "D" (which freezes nothing). Detection is
// per-symbol on purpose: a merged source can serve daily and monthly codes
// through the same endpoint, so a source-level declaration would be wrong.
export function detectNativeFreq(rows: OhlcvRow[]): Freq {
  if (rows.length < 4) return "D";
  const sorted = [...rows].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((parseDateYmd(sorted[i].tradeDate).getTime() - parseDateYmd(sorted[i - 1].tradeDate).getTime()) / DAY_MS);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median <= 5) return "D";
  if (median <= 10) return "W";
  if (median <= 45) return "M";
  if (median <= 120) return "Q";
  return "Y";
}
