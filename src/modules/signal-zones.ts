import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { SignalEvent } from "../types";

// A buy→sell holding period between two snapped bar indices (inclusive).
export interface SignalZone {
  from: number;
  to: number;
}

// Pairs buy→sell events (bar indices ascending) into holding zones: a buy
// opens a zone while flat, a sell closes it while holding; repeated events in
// the same state are ignored. A still-open zone runs to the last bar.
export function buildSignalZones(snapped: Map<number, SignalEvent[]>, barCount: number): SignalZone[] {
  const zones: SignalZone[] = [];
  let openFrom = -1;
  for (let index = 0; index < barCount; index++) {
    const events = snapped.get(index);
    if (!events) continue;
    for (const ev of events) {
      if (ev.side === "buy" && openFrom < 0) {
        openFrom = index;
      } else if (ev.side === "sell" && openFrom >= 0) {
        zones.push({ from: openFrom, to: index });
        openFrom = -1;
      }
    }
  }
  if (openFrom >= 0 && barCount > 0) {
    zones.push({ from: openFrom, to: barCount - 1 });
  }
  return zones;
}

// Paints translucent holding-period bands behind the price series (zOrder
// bottom). Coordinates are resolved from the live time scale on every
// repaint, so scrolling/zooming needs no explicit update pass.
export class SignalZonesPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;

  constructor(
    private readonly zones: { from: Time; to: Time }[],
    private readonly color: string
  ) {}

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart;
  }

  detached(): void {
    this.chart = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.paneView];
  }

  private readonly paneView: IPrimitivePaneView = {
    zOrder: () => "bottom",
    renderer: () => this.renderer,
  };

  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) => {
      const chart = this.chart;
      if (!chart) return;
      const timeScale = chart.timeScale();
      target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
        ctx.fillStyle = this.color;
        for (const zone of this.zones) {
          const x1 = timeScale.timeToCoordinate(zone.from);
          const x2 = timeScale.timeToCoordinate(zone.to);
          if (x1 === null || x2 === null) continue;
          ctx.fillRect(x1, 0, Math.max(1, x2 - x1), mediaSize.height);
        }
      });
    },
  };
}
