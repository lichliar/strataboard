/**
 * Simple Moving Average (MA) — N TRADING days, always.
 *
 * On resampled charts (W/M/Q/Y) the rolling mean is computed on the native
 * daily closes (ctx.nativeBars) and each displayed bar takes the MA value at
 * the last native bar with time <= the displayed bar's time (floorIndex,
 * same convention as chart-renderer.addMovingAverages). Without native bars
 * (daily chart) it is a plain rolling SMA over the displayed closes.
 */

import type { Bar, InputConfig, PlotConfig } from "oakscriptjs";
import type { IndicatorContext, IndicatorResultLike } from "../contract";

export interface MAInputs {
  length: number;
}

export const defaultInputs: MAInputs = {
  length: 20,
};

export const inputConfig: InputConfig[] = [
  { id: "length", type: "int", title: "周期 Length", defval: 20, min: 1 },
];

// Color is a placeholder: the renderer assigns per-instance palette colors.
export const plotConfig: PlotConfig[] = [
  { id: "plot0", title: "MA", color: "#2962FF", lineWidth: 1 },
];

export const metadata = {
  title: "Moving Average",
  shortTitle: "MA",
  overlay: true,
};

// Rolling SMA of closes; null before the window fills.
function rollingSma(closes: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= length) sum -= closes[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

// Index of the last bar whose time is <= target (-1 when target precedes the
// first bar). Bars must be ascending by time.
function floorIndexByTime(bars: readonly Bar[], target: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function calculate(bars: Bar[], inputs: Partial<MAInputs> = {}, ctx?: IndicatorContext): IndicatorResultLike {
  const { length } = { ...defaultInputs, ...inputs };
  const native = ctx?.nativeBars;
  // Resampled chart: the displayed bars cover a different length/span than
  // the native daily basis.
  const useNative =
    !!native && native.length > 0 &&
    (native.length !== bars.length ||
      native[0].time !== bars[0].time ||
      native[native.length - 1].time !== bars[bars.length - 1].time);

  let values: (number | null)[];
  if (useNative && native) {
    const nativeMa = rollingSma(native.map((bar) => bar.close), length);
    values = bars.map((bar) => {
      const idx = floorIndexByTime(native, bar.time);
      return idx >= 0 ? nativeMa[idx] : null;
    });
  } else {
    values = rollingSma(bars.map((bar) => bar.close), length);
  }

  return {
    metadata: { title: metadata.title, shorttitle: metadata.shortTitle, overlay: metadata.overlay },
    plots: {
      plot0: bars.map((bar, i) => ({ time: bar.time, value: values[i] ?? NaN })),
    },
  };
}

export const MA = { calculate, metadata, defaultInputs, inputConfig, plotConfig };
