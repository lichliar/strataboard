/**
 * Plot style histogram (plot.style_histogram) as a custom series: per value, a vertical bar `histWidth` px wide (the
 * plot line width, not the bar slot like columns) from the histogram base to the value:
 *   width  n = max(1, floor(histWidth * hpr)), centre round(x * hpr) (+0.5 when n is odd), left = floor(centre - n / 2)
 *   base   a = round(baseY * vpr) - floor(l / 2), l = max(1, floor(hpr))
 *   value  p = round(y * vpr); above the base: p .. a + l; below: a .. p - floor(l / 2) + l
 *          (the bar always covers the 1 px base row)
 * Per-point colours win over the series colour. The base is the plot's histbase price (PineScript default 0).
 */
import type {
  CustomSeriesOptions,
  CustomSeriesPricePlotValues,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  PaneRendererCustomData,
  PriceToCoordinateConverter,
  Time,
} from 'lightweight-charts';
import { customSeriesDefaultOptions } from 'lightweight-charts';

/** One histogram value; `fill`, not `color`: lightweight-charts reserves `color` on custom series data */
export type HistogramItem = { time: Time; value: number; fill?: string };

export interface ThinHistogramOptions extends CustomSeriesOptions {
  histColor: string;
  histWidth: number;
  histBase: number;
}

type BitmapScope = {
  context: CanvasRenderingContext2D;
  horizontalPixelRatio: number;
  verticalPixelRatio: number;
};
type DrawTarget = Parameters<ICustomSeriesPaneRenderer['draw']>[0];

export class ThinHistogramPaneView implements ICustomSeriesPaneView<Time, HistogramItem, ThinHistogramOptions> {
  private data: PaneRendererCustomData<Time, HistogramItem> | null = null;
  private options: ThinHistogramOptions | null = null;

  /** The base is part of the value range (like the library histogram), the value last for the axis label */
  priceValueBuilder(item: HistogramItem): CustomSeriesPricePlotValues {
    return [this.options?.histBase ?? 0, item.value];
  }

  isWhitespace(d: HistogramItem | { time: Time }): d is { time: Time } {
    return !('value' in d) || !Number.isFinite((d as HistogramItem).value);
  }

  update(data: PaneRendererCustomData<Time, HistogramItem>, options: ThinHistogramOptions): void {
    this.data = data;
    this.options = options;
  }

  defaultOptions(): ThinHistogramOptions {
    return { ...customSeriesDefaultOptions, histColor: '#2962FF', histWidth: 1, histBase: 0 };
  }

  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: DrawTarget, ptc: PriceToCoordinateConverter) => {
        const data = this.data;
        const o = this.options;
        if (!data || !o || !data.bars.length) return;
        const baseY = ptc(o.histBase);
        if (baseY == null) return;
        (target as unknown as { useBitmapCoordinateSpace: (fn: (s: BitmapScope) => void) => void }).useBitmapCoordinateSpace(
          ({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
            const n = Math.max(1, Math.floor(o.histWidth * hpr));
            const half = n / 2;
            const l = Math.max(1, Math.floor(hpr));
            const a = Math.round(baseY * vpr) - Math.floor(l / 2);
            const r = a + l;
            const from = data.visibleRange?.from ?? 0;
            const to = data.visibleRange?.to ?? data.bars.length;
            for (let i = from; i < to; i++) {
              const bar = data.bars[i];
              const y = ptc(bar.originalData.value);
              if (y == null) continue;
              ctx.fillStyle = bar.originalData.fill ?? o.histColor;
              const cx = Math.round(bar.x * hpr) + (n % 2 ? 0.5 : 0);
              const p = Math.round((y as number) * vpr);
              let top: number;
              let bottom: number;
              if (p <= a) {
                top = p;
                bottom = r;
              } else {
                top = a;
                bottom = p - Math.floor(l / 2) + l;
              }
              ctx.fillRect(Math.floor(cx - half), top, n, bottom - top);
            }
          }
        );
      },
    } as ICustomSeriesPaneRenderer;
  }
}
