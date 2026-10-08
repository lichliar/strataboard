import type { SeriesMarker, Time } from "lightweight-charts";
import type { SignalEvent } from "../types";

// Pure helpers turning signal events into lightweight-charts markers. Shared
// by the K-line renderer (rise/fall colors) and the series renderer (fixed
// palette). No obsidian imports — node-exercisable.

// Fixed marker colors on series (overlay/spread) cards, whose lines have no
// rise/fall color concept. Matches the quote card's default rise/fall pair.
export const SIGNAL_BUY_COLOR = "#ef4444";
export const SIGNAL_SELL_COLOR = "#22c55e";

const MAX_MARKER_TEXT = 12;

// Snaps each event to the LAST bar with barDate <= event.date (events are
// dated YYYYMMDD like OhlcvRow.tradeDate; a signal on a non-trading day
// sticks to the previous bar — the same convention as MA-on-resampled-bars).
// Events before the first bar are dropped. Returns barIndex -> events
// (multiple signals on one bar stack, lightweight-charts draws them all).
export function snapEventsToBars(events: SignalEvent[], barDates: string[]): Map<number, SignalEvent[]> {
  const byBar = new Map<number, SignalEvent[]>();
  for (const event of events) {
    const index = floorIndex(barDates, event.date);
    if (index < 0) continue;
    const list = byBar.get(index);
    if (list) list.push(event);
    else byBar.set(index, [event]);
  }
  return byBar;
}

// One event → one marker: buy = arrowUp below the bar, sell = arrowDown
// above it, text truncated so long notes don't flood the chart.
export function eventToMarker(
  event: SignalEvent,
  time: Time,
  colors: { buy: string; sell: string }
): SeriesMarker<Time> {
  const text = event.text
    ? event.text.length > MAX_MARKER_TEXT
      ? `${event.text.slice(0, MAX_MARKER_TEXT)}…`
      : event.text
    : undefined;
  return {
    time,
    position: event.side === "buy" ? "belowBar" : "aboveBar",
    shape: event.side === "buy" ? "arrowUp" : "arrowDown",
    color: event.side === "buy" ? colors.buy : colors.sell,
    ...(text ? { text } : {}),
  };
}

// Index of the last element <= key in an ascending array, -1 when the key
// precedes every element. Local copy of chart-renderer's floorIndex so this
// module stays dependency-free.
function floorIndex(values: string[], key: string): number {
  let lo = 0;
  let hi = values.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= key) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
