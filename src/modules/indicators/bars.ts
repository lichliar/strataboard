/**
 * Converters between the plugin's OhlcvRow rows and oakscriptjs Bars, plus
 * the result time adapter: indicator outputs carry unix-second times, the
 * chart needs "YYYY-MM-DD" strings.
 */

import type { Bar } from "oakscriptjs";
import type { OhlcvRow } from "../../types";
import type { IndicatorResultLike } from "./contract";

/** tradeDate "YYYYMMDD" → UTC unix seconds. */
function tradeDateToUnix(tradeDate: string): number {
  const y = Number(tradeDate.slice(0, 4));
  const m = Number(tradeDate.slice(4, 6));
  const d = Number(tradeDate.slice(6, 8));
  return Date.UTC(y, m - 1, d) / 1000;
}

/** "YYYYMMDD" → "YYYY-MM-DD" (the chart series time format). */
function tradeDateToChartTime(tradeDate: string): string {
  return `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`;
}

export function ohlcvToBars(rows: OhlcvRow[]): Bar[] {
  return rows.map((row) => ({
    time: tradeDateToUnix(row.tradeDate),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.vol,
  }));
}

// Rewrites every time-carrying field of an indicator result from unix
// seconds back to "YYYY-MM-DD" chart times. Points on future bars (Pine
// draws displaced plots past the last bar, e.g. Ichimoku leading spans) have
// no row to map to and are dropped; the drop count is warned once per call.
export function adaptResultTimes(result: IndicatorResultLike, rows: OhlcvRow[]): IndicatorResultLike {
  const timeMap = new Map<number, string>();
  for (const row of rows) {
    timeMap.set(tradeDateToUnix(row.tradeDate), tradeDateToChartTime(row.tradeDate));
  }

  let dropped = 0;
  const mapTime = (time: unknown): string | null => {
    const mapped = typeof time === "number" ? timeMap.get(time) : undefined;
    if (mapped === undefined) {
      dropped++;
      return null;
    }
    return mapped;
  };

  const mapPoints = <T extends { time: unknown }>(points: T[] | undefined): T[] | undefined => {
    if (!points) return points;
    const out: T[] = [];
    for (const point of points) {
      const time = mapTime(point.time);
      if (time !== null) out.push({ ...point, time });
    }
    return out;
  };

  const mapRecord = <T extends { time: unknown }>(record: Record<string, T[]> | undefined): Record<string, T[]> | undefined => {
    if (!record) return record;
    const out: Record<string, T[]> = {};
    for (const [key, points] of Object.entries(record)) {
      out[key] = mapPoints(points) ?? [];
    }
    return out;
  };

  const mapDrawing = <T extends { time1: number; time2: number }>(items: T[] | undefined): T[] | undefined => {
    if (!items) return items;
    const out: T[] = [];
    for (const item of items) {
      const time1 = mapTime(item.time1);
      const time2 = mapTime(item.time2);
      if (time1 !== null && time2 !== null) out.push({ ...item, time1: time1 as unknown as number, time2: time2 as unknown as number });
    }
    return out;
  };

  const adapted: IndicatorResultLike = {
    ...result,
    plots: mapRecord(result.plots) ?? {},
    markers: mapPoints(result.markers),
    arrows: mapPoints(result.arrows),
    bgColors: mapPoints(result.bgColors),
    barColors: mapPoints(result.barColors),
    plotCandles: mapRecord(result.plotCandles),
    plotBars: mapRecord(result.plotBars),
    labels: mapPoints(result.labels),
    lines: mapDrawing(result.lines),
    boxes: mapDrawing(result.boxes),
    linefills: result.linefills?.map((fill) => {
      const [line1] = mapDrawing([fill.line1]) ?? [];
      const [line2] = mapDrawing([fill.line2]) ?? [];
      return line1 && line2 ? { ...fill, line1, line2 } : null;
    }).filter((fill): fill is NonNullable<typeof fill> => fill !== null),
    polylines: result.polylines
      ?.map((polyline) => {
        const points = mapPoints(polyline.points) ?? [];
        return points.length > 0 ? { ...polyline, points: points as typeof polyline.points } : null;
      })
      .filter((polyline): polyline is NonNullable<typeof polyline> => polyline !== null),
    // hlines/fills/tables carry no bar times — passed through by the spread.
  };

  if (dropped > 0) {
    console.warn(`[StrataBoard] indicator result: dropped ${dropped} point(s) on future bars`);
  }
  return adapted;
}
