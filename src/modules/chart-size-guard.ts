import type { IChartApi } from "lightweight-charts";

// Drives a lightweight-charts instance's size from its container's LAYOUT
// size (clientWidth/clientHeight) instead of the library's autoSize.
//
// Why not autoSize: the library measures the initial size via
// container.getBoundingClientRect(), which is affected by CSS transforms.
// Obsidian's canvas scales node content with a transform on the .canvas
// wrapper, so a chart created while the canvas is zoomed initializes at the
// SCALED size; and because transform changes never fire ResizeObserver,
// nothing corrects it afterwards — the chart stays frozen with a stale
// bitmap (series clipped at the pane top, garbled axis text) until some
// unrelated layout change happens to arrive. clientWidth/clientHeight are
// layout units and immune to transforms, so owning the sizing removes the
// whole class of failure.
//
// The guard also verifies after layout settles that every visible series
// extreme maps inside its pane. Every full repaint recalculates autoscale
// over the visible window, so an out-of-pane extreme means the chart is
// showing a stale frame; re-applying the initial range forces the repaint
// + recalc that heals it.
export class ChartSizeGuard {
  private chart: IChartApi;
  private containerEl: HTMLElement;
  private onRealSize: () => void;
  private onResize: () => void;
  private resizeObserver: ResizeObserver | null = null;
  private rafId = 0;
  private timers: number[] = [];
  private lastWidth = 0;
  private lastHeight = 0;
  private sawRealSize = false;

  constructor(chart: IChartApi, containerEl: HTMLElement, onRealSize: () => void, onResize?: () => void) {
    this.chart = chart;
    this.containerEl = containerEl;
    this.onRealSize = onRealSize;
    this.onResize = onResize ?? (() => {});

    this.resizeObserver = new ResizeObserver(() => {
      if (this.rafId !== 0) return;
      this.rafId = window.requestAnimationFrame(() => {
        this.rafId = 0;
        this.syncSize();
      });
    });
    this.resizeObserver.observe(containerEl);

    // Settle passes catch states the observer missed (detached mount,
    // multi-step canvas layout at app start, ...).
    for (const delay of [250, 800, 2000]) {
      this.timers.push(window.setTimeout(() => this.verify(), delay));
    }
  }

  destroy() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.rafId !== 0) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers = [];
  }

  private syncSize() {
    const width = this.containerEl.clientWidth;
    const height = this.containerEl.clientHeight;
    if (width === 0 || height === 0) return;
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.chart.resize(width, height);
    this.onResize();
    if (!this.sawRealSize) {
      this.sawRealSize = true;
      // The chart just got its real layout size for the first time: re-apply
      // the initial visible range (preset / persisted) — any fit computed at
      // a transient size (e.g. 0x0 while detached) is meaningless.
      this.onRealSize();
    }
  }

  private verify() {
    this.syncSize();
    if (!this.sawRealSize) return;
    if (this.hasClippedSeries()) {
      // Stale frame: re-applying the range triggers a full repaint and an
      // autoscale recalculation over the current visible window.
      this.onRealSize();
    }
  }

  private hasClippedSeries(): boolean {
    let logical = null;
    try {
      logical = this.chart.timeScale().getVisibleLogicalRange();
    } catch {
      return false;
    }
    if (!logical) return false;

    for (const pane of this.chart.panes()) {
      let paneHeight = 0;
      try {
        paneHeight = pane.getHeight();
      } catch {
        continue;
      }
      if (paneHeight <= 0) continue;

      for (const series of pane.getSeries()) {
        const data = series.data();
        if (data.length === 0) continue;
        const from = Math.max(0, Math.floor(logical.from));
        const to = Math.min(data.length - 1, Math.ceil(logical.to));
        if (to < from) continue;

        let high = -Infinity;
        let low = Infinity;
        for (let i = from; i <= to; i++) {
          const row = data[i] as { high?: number; low?: number; value?: number };
          const hi = row.high ?? row.value;
          const lo = row.low ?? row.value;
          if (typeof hi === "number" && hi > high) high = hi;
          if (typeof lo === "number" && lo < low) low = lo;
        }
        if (high === -Infinity || low === Infinity) continue;

        let yHigh = null;
        let yLow = null;
        try {
          yHigh = series.priceToCoordinate(high);
          yLow = series.priceToCoordinate(low);
        } catch {
          continue;
        }
        if (yHigh === null || yLow === null) continue;
        // Tolerance: wicks/markers may legitimately touch the pane edge.
        if (yHigh < -2 || yLow > paneHeight + 2) return true;
      }
    }
    return false;
  }
}
