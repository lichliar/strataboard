/**
 * Ichimoku Cloud Indicator
 *
 * A trend-following system that shows support/resistance, momentum and trend direction at once.
 * Conversion and Base lines are Donchian midlines; the Leading Spans are drawn `displacement - 1` bars ahead
 * (on future bars after the last bar) and the Lagging Span `displacement - 1` bars back. The cloud between the
 * Leading Spans is green when Leading Span A is above Leading Span B, red otherwise.
 *
 * Based on the standard "Ichimoku Cloud" indicator.
 */

import { ta, Series, type IndicatorResult, type InputConfig, type PlotConfig, type Bar } from 'oakscriptjs';
import { barInterval, barTime } from '../bar-time';

/**
 * Ichimoku Cloud indicator input parameters
 */
export interface IchimokuInputs {
  /** Conversion Line (Tenkan-sen) period */
  conversionPeriods: number;
  /** Base Line (Kijun-sen) period */
  basePeriods: number;
  /** Leading Span B (Senkou Span B) period */
  laggingSpan2Periods: number;
  /** Displacement for Leading Spans and Lagging Span */
  displacement: number;
}

/**
 * Default input values matching the standard indicator defaults
 */
export const defaultInputs: IchimokuInputs = {
  conversionPeriods: 9,
  basePeriods: 26,
  laggingSpan2Periods: 52,
  displacement: 26,
};

/**
 * Input configuration for UI
 */
export const inputConfig: InputConfig[] = [
  { id: 'conversionPeriods', type: 'int', title: 'Conversion Line Length', defval: 9, min: 1 },
  { id: 'basePeriods', type: 'int', title: 'Base Line Length', defval: 26, min: 1 },
  { id: 'laggingSpan2Periods', type: 'int', title: 'Leading Span B Length', defval: 52, min: 1 },
  { id: 'displacement', type: 'int', title: 'Lagging Span', defval: 26, min: 1 },
];

/**
 * Plot configuration
 */
export const plotConfig: PlotConfig[] = [
  { id: 'plot0', title: 'Conversion Line', color: '#2962FF', lineWidth: 1 },
  { id: 'plot1', title: 'Base Line', color: '#B71C1C', lineWidth: 1 },
  { id: 'plot2', title: 'Lagging Span', color: '#43A047', lineWidth: 1 },
  { id: 'plot3', title: 'Leading Span A', color: '#A5D6A7', lineWidth: 1 },
  { id: 'plot4', title: 'Leading Span B', color: '#EF9A9A', lineWidth: 1 },
  { id: 'plot7', title: 'Kumo Cloud Upper Line', color: '#2962FF', lineWidth: 1, display: 'none' },
  { id: 'plot8', title: 'Kumo Cloud Lower Line', color: '#2962FF', lineWidth: 1, display: 'none' },
];

/**
 * Indicator metadata
 */
export const metadata = {
  title: 'Ichimoku Cloud',
  shortTitle: 'Ichimoku',
  overlay: true,
};

/** Pine float comparisons: a > b only when a - b > 1e-10 (na compares false) */
const EPS = 1e-10;
const gt = (a: number, b: number) => a - b > EPS;

type Point = { time: number; value: number };

/**
 * Calculate Ichimoku Cloud indicator
 *
 * @param bars - OHLCV bar data
 * @param inputs - Indicator parameters (optional, uses defaults)
 * @returns Indicator result with plot data
 */
export function calculate(bars: Bar[], inputs: Partial<IchimokuInputs> = {}): IndicatorResult {
  const { conversionPeriods, basePeriods, laggingSpan2Periods, displacement } = { ...defaultInputs, ...inputs };
  const n = bars.length;
  const A = (s: Series) => s.toArray().map((v) => v ?? NaN);
  const high = new Series(bars, (bar) => bar.high);
  const low = new Series(bars, (bar) => bar.low);

  // donchian(len) => math.avg(ta.lowest(len), ta.highest(len))
  const donchian = (len: number) => {
    const lo = A(ta.lowest(low, len));
    const hi = A(ta.highest(high, len));
    return lo.map((l, i) => (l + hi[i]) / 2);
  };
  const conversionLine = donchian(conversionPeriods);
  const baseLine = donchian(basePeriods);
  const leadLine1 = conversionLine.map((c, i) => (c + baseLine[i]) / 2);
  const leadLine2 = donchian(laggingSpan2Periods);

  const interval = barInterval(bars);
  // plot(value, offset = off): the value of bar i is drawn on bar i + off (future bars after the last bar)
  const shifted = (value: (i: number) => number, off: number): Point[] => {
    const out: Point[] = [];
    for (let i = 0; i < n; i++) {
      if (i + off < 0) continue;
      out.push({ time: barTime(bars, i + off, interval), value: value(i) });
    }
    return out;
  };
  const lead = displacement - 1;

  // leadLine1 > leadLine2 ? leadLine1 : leadLine2 (na compares false)
  const upper = (i: number) => (gt(leadLine1[i], leadLine2[i]) ? leadLine1[i] : leadLine2[i]);
  // leadLine1 < leadLine2 ? leadLine1 : leadLine2
  const lower = (i: number) => (gt(leadLine2[i], leadLine1[i]) ? leadLine1[i] : leadLine2[i]);

  // fill(p1, p2, color = leadLine1 > leadLine2 ? color.rgb(67, 160, 71, 90) : color.rgb(244, 67, 54, 90));
  // the colour of bar i goes with the plot points of bar i
  const cloudColors = bars.map((_b, i) => (gt(leadLine1[i], leadLine2[i]) ? '#43A0471A' : '#F443361A'));

  return {
    metadata: {
      title: metadata.title,
      shorttitle: metadata.shortTitle,
      overlay: metadata.overlay,
    },
    plots: {
      plot0: shifted((i) => conversionLine[i], 0),
      plot1: shifted((i) => baseLine[i], 0),
      plot2: shifted((i) => bars[i].close, -displacement + 1),
      plot3: shifted((i) => leadLine1[i], lead),
      plot4: shifted((i) => leadLine2[i], lead),
      plot7: shifted(upper, lead),
      plot8: shifted(lower, lead),
    },
    fills: [{ plot1: 'plot3', plot2: 'plot4', options: { title: 'Cloud Fill' }, colors: cloudColors }],
  };
}

/**
 * Ichimoku Cloud indicator module
 */
export const IchimokuCloud = {
  calculate,
  metadata,
  defaultInputs,
  inputConfig,
  plotConfig,
};
