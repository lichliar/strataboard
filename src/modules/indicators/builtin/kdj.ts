/**
 * KDJ stochastic oscillator.
 *
 * RSV = (C − LLV(low, n)) / (HHV(high, n) − LLV(low, n)) × 100
 * K = rma(RSV, signalK); D = rma(K, signalD); J = 3K − 2D
 * (the classic Chinese KDJ: SMA(X, N, 1) smoothing equals Pine's rma).
 */

import { Series, ta, type Bar, type InputConfig, type PlotConfig } from "oakscriptjs";
import type { IndicatorResultLike } from "../contract";

export interface KDJInputs {
  length: number;
  signalK: number;
  signalD: number;
}

export const defaultInputs: KDJInputs = {
  length: 9,
  signalK: 3,
  signalD: 3,
};

export const inputConfig: InputConfig[] = [
  { id: "length", type: "int", title: "周期 Length", defval: 9, min: 1 },
  { id: "signalK", type: "int", title: "K 平滑 Signal K", defval: 3, min: 1 },
  { id: "signalD", type: "int", title: "D 平滑 Signal D", defval: 3, min: 1 },
];

export const plotConfig: PlotConfig[] = [
  { id: "plot0", title: "K", color: "#2962FF", lineWidth: 1 },
  { id: "plot1", title: "D", color: "#FF6D00", lineWidth: 1 },
  { id: "plot2", title: "J", color: "#7E57C2", lineWidth: 1 },
];

export const metadata = {
  title: "KDJ",
  shortTitle: "KDJ",
  overlay: false,
};

export function calculate(bars: Bar[], inputs: Partial<KDJInputs> = {}): IndicatorResultLike {
  const { length, signalK, signalD } = { ...defaultInputs, ...inputs };

  const highs = new Series(bars, (b) => b.high);
  const lows = new Series(bars, (b) => b.low);
  const closes = new Series(bars, (b) => b.close);
  const hhv = ta.highest(highs, length).toArray();
  const llv = ta.lowest(lows, length).toArray();
  const closeArr = closes.toArray();

  // RSV is na before the window fills and when HHV == LLV (flat range).
  const rsvArr: (number | null)[] = closeArr.map((close, i) => {
    const h = hhv[i];
    const l = llv[i];
    if (close == null || h == null || l == null || h === l) return null;
    return ((close - l) / (h - l)) * 100;
  });

  // Series.fromArray models Pine na as NaN (toArray hands back null).
  const kArr = ta.rma(Series.fromArray(bars, rsvArr.map((v) => v ?? NaN)), signalK).toArray();
  const dArr = ta.rma(Series.fromArray(bars, kArr.map((v) => v ?? NaN)), signalD).toArray();
  const jArr = kArr.map((k, i) => {
    const d = dArr[i];
    return k == null || d == null ? null : 3 * k - 2 * d;
  });

  const toPlot = (arr: (number | null)[]) => arr.map((value, i) => ({ time: bars[i].time, value: value ?? NaN }));

  return {
    metadata: { title: metadata.title, shorttitle: metadata.shortTitle, overlay: metadata.overlay },
    plots: {
      plot0: toPlot(kArr),
      plot1: toPlot(dArr),
      plot2: toPlot(jArr),
    },
  };
}

export const KDJ = { calculate, metadata, defaultInputs, inputConfig, plotConfig };
