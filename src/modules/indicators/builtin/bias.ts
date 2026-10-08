/**
 * BIAS (乖离率): percentage distance of the close from its N-day SMA.
 *
 * BIAS = (close − sma(close, n)) / sma(close, n) × 100
 */

import { Series, ta, type Bar, type InputConfig, type PlotConfig } from "oakscriptjs";
import type { IndicatorResultLike } from "../contract";

export interface BiasInputs {
  length: number;
}

export const defaultInputs: BiasInputs = {
  length: 20,
};

export const inputConfig: InputConfig[] = [
  { id: "length", type: "int", title: "周期 Length", defval: 20, min: 1 },
];

export const plotConfig: PlotConfig[] = [
  { id: "plot0", title: "BIAS", color: "#2962FF", lineWidth: 1 },
];

export const metadata = {
  title: "Bias Ratio",
  shortTitle: "BIAS",
  overlay: false,
};

export function calculate(bars: Bar[], inputs: Partial<BiasInputs> = {}): IndicatorResultLike {
  const { length } = { ...defaultInputs, ...inputs };

  const closes = new Series(bars, (b) => b.close);
  const closeArr = closes.toArray();
  const smaArr = ta.sma(closes, length).toArray();

  const plotData = closeArr.map((close, i) => {
    const ma = smaArr[i];
    const value = close != null && ma != null && ma !== 0 ? ((close - ma) / ma) * 100 : NaN;
    return { time: bars[i].time, value };
  });

  return {
    metadata: { title: metadata.title, shorttitle: metadata.shortTitle, overlay: metadata.overlay },
    plots: {
      plot0: plotData,
    },
  };
}

export const BIAS = { calculate, metadata, defaultInputs, inputConfig, plotConfig };
