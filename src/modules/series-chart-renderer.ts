import { MarkdownRenderChild } from "obsidian";
import {
  createChart,
  LineSeries,
  type BusinessDay,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type LineData,
  type IRange,
  type Time,
  type LineWidth,
} from "lightweight-charts";
import type { ChartTheme, SeriesPoint } from "../types";
import { onAttached, resolveEffectiveTheme, toLayoutPoint, installZoomEventFix } from "../utils/dom";
import { buildChartOptions, suppressMarkdownChrome } from "./chart-renderer";

export interface SeriesChartLine {
  name: string;
  color?: string;
  lineWidth?: number; // px, 1–4 (lightweight-charts LineWidth), default 2
  points: SeriesPoint[];
}

interface SeriesChartRendererOptions {
  title?: string;      // header title, e.g. "资产叠加（M1-M2+上证指数）（归一化）"; omitted = no header (the FRED card renders its own tushare-style header)
  subtitle?: string;   // small muted line under the title, e.g. the normalization base date
  lines: SeriesChartLine[];
  height?: number;     // px, default 400
  valueSuffix?: string; // e.g. "%" appended to legend values and price-axis ticks
  theme?: ChartTheme;  // default "auto" (follow Obsidian; only then is the theme watcher attached)
  freezeWidth?: boolean; // canvas only: pin the first-layout width (tushare spec 宽度自适应 off)
  initialVisibleRange?: { from: string; to: string };  // YYYY-MM-DD, from the card YAML
}

const DEFAULT_HEIGHT = 400;

// Line palette for overlay/spread charts; cycles when a card has more lines
// than colors. Colors stay readable on both themes.
const SERIES_LINE_COLORS = [
  "#2563eb", "#dc2626", "#f59e0b", "#8b5cf6",
  "#14b8a6", "#ec4899", "#0ea5e9", "#84cc16",
];

function formatValue(n: number | undefined, suffix: string): string {
  if (n == null || Number.isNaN(n)) return "--";
  const text = n.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${text}${suffix}`;
}

// Index of the last point with date <= target (-1 when target precedes the
// first point). Points are ascending ISO dates, so lexicographic compare works.
function floorIndex(points: SeriesPoint[], target: string): number {
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].date <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

// Converts a chart Time (string or BusinessDay) to YYYY-MM-DD.
function timeToYmd(time: Time): string {
  if (typeof time === "string") return time;
  const day = time as BusinessDay;
  return `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

// Shared multi-line chart for the overlay (资产叠加), spread (差值计算) and
// standalone FRED cards: one lightweight-charts LineSeries per line, a
// crosshair legend with one colored entry per line, theme-aware rebuild, and
// a Chinese empty state.
export class SeriesChartRenderer extends MarkdownRenderChild {
  private options: SeriesChartRendererOptions;
  private chart: IChartApi | null = null;
  private chartContainerEl: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private uninstallZoomFix: (() => void) | null = null;
  private legendDateEl: HTMLElement | null = null;
  private legendLines: { points: SeriesPoint[]; valueEl: HTMLElement }[] = [];
  private latestDate = "";
  private initialVisibleRange: IRange<Time> | null = null;
  private stackEl: HTMLElement | null = null;

  constructor(containerEl: HTMLElement, options: SeriesChartRendererOptions) {
    super(containerEl);
    this.options = options;
  }

  onload() {
    this.render();
  }

  onunload() {
    this.cleanup();
  }

  private render() {
    this.cleanup();
    this.containerEl.empty();
    this.containerEl.addClass("strataboard-card");
    this.containerEl.addClass("financial-series-chart");
    onAttached(this.containerEl, () => suppressMarkdownChrome(this.containerEl));

    const lines = this.options.lines.filter((line) => line.points.length > 0);
    if (lines.length === 0) {
      this.containerEl.createEl("div", {
        cls: "strataboard-empty",
        text: "暂无数据：所选系列在该时间范围内没有数据。",
      });
      return;
    }

    // Header row with the card title (and optional subtitle, e.g. the
    // normalization base date). Skipped when no title is given — the FRED
    // card renders its own tushare-style header above the chart.
    if (this.options.title) {
      const headerEl = this.containerEl.createEl("div", { cls: "financial-series-chart-header" });
      headerEl.createEl("span", { cls: "financial-series-chart-title", text: this.options.title });
      if (this.options.subtitle) {
        headerEl.createEl("div", { cls: "financial-series-chart-subtitle", text: this.options.subtitle });
      }
    }

    // Chart stack: the inline height acts as the flex basis (same sizing
    // model as the tushare chart card).
    const stackEl = this.containerEl.createEl("div", { cls: "strataboard-chart-stack" });
    this.stackEl = stackEl;
    stackEl.style.height = `${this.options.height ?? DEFAULT_HEIGHT}px`;
    this.chartContainerEl = stackEl.createEl("div", { cls: "strataboard-chart-container" });

    const theme = this.options.theme ?? "auto";
    const isDark = resolveEffectiveTheme(theme) === "dark";
    this.containerEl.toggleClass("fc-hermes", isDark);
    const chartOptions: DeepPartial<ChartOptions> = buildChartOptions(isDark);
    // Wheel ZOOMS the time axis on series cards (wheel-pan is disabled so the
    // two don't fight). buildChartOptions is shared with the tushare K-line
    // card, so override the returned object here instead of changing it; it
    // currently sets only handleScale.axisPressedMouseMove and no handleScroll.
    chartOptions.handleScale = { axisPressedMouseMove: true, mouseWheel: true, pinch: true };
    chartOptions.handleScroll = { mouseWheel: false };
    this.chart = createChart(this.chartContainerEl, chartOptions);
    // Zoom-correct mouse coordinates before the library sees them (Obsidian
    // canvas scales node content with a CSS transform).
    this.uninstallZoomFix = installZoomEventFix(this.chartContainerEl);

    lines.forEach((line, i) => {
      const color = line.color ?? SERIES_LINE_COLORS[i % SERIES_LINE_COLORS.length];
      const data: LineData[] = line.points.map((p) => ({ time: p.date, value: p.value }));
      // When every line is percent-ish the legend carries a "%" suffix; put
      // the same suffix on the price-axis ticks via a custom price format.
      const suffix = this.options.valueSuffix ?? "";
      const series = this.chart!.addSeries(
        LineSeries,
        {
          color,
          lineWidth: (line.lineWidth ?? 2) as LineWidth,
          priceLineVisible: false,
          priceFormat: suffix
            ? { type: "custom", formatter: (price: number) => `${price.toFixed(2)}${suffix}`, minMove: 0.01 }
            : { type: "price", precision: 2, minMove: 0.01 },
        },
        0
      );
      series.setData(data);
      line.color = color;
    });

    // Restore the persisted visible range when present; it can fall outside
    // the loaded data after a range/spec change, so fall back to fitContent.
    this.initialVisibleRange = this.options.initialVisibleRange
      ? {
          from: this.options.initialVisibleRange.from as Time,
          to: this.options.initialVisibleRange.to as Time,
        }
      : null;
    if (this.initialVisibleRange) {
      try {
        this.applyTimeRange(this.initialVisibleRange.from, this.initialVisibleRange.to);
      } catch {
        this.chart.timeScale().fitContent();
        this.initialVisibleRange = null;
      }
    } else {
      this.chart.timeScale().fitContent();
    }
    this.addLegend(lines);
    this.setupResizeObserver();
  }

  private cleanup() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.uninstallZoomFix?.();
    this.uninstallZoomFix = null;
    this.chart?.remove();
    this.chart = null;
    this.chartContainerEl = null;
    this.stackEl = null;    this.legendDateEl = null;
    this.legendLines = [];
    this.latestDate = "";
    this.initialVisibleRange = null;
  }

  // Current visible time range as YYYY-MM-DD, or null when no chart/range.
  getVisibleRangeYmd(): { from: string; to: string } | null {
    const range = this.chart?.timeScale().getVisibleRange();
    if (!range) return null;
    return { from: timeToYmd(range.from), to: timeToYmd(range.to) };
  }

  // Manually zooms the time axis one wheel step around the cursor. Driven by
  // the wrapper's window-capture wheel listener in canvas chart mode, where
  // the canvas swallows wheel events before they reach the chart (so the
  // library's own wheel-zoom never fires there).
  applyTimeAxisWheelZoom(deltaY: number, clientX: number): void {
    if (!this.chart || !this.chartContainerEl) return;
    const ts = this.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    // Sign only: wheel up zooms in, wheel down zooms out.
    const factor = deltaY < 0 ? 1 / 1.15 : 1.15;

    // Anchor at the cursor's logical index; fall back to the range center
    // when the cursor maps to empty space. toLayoutPoint zoom-corrects the
    // coordinate (the canvas CSS-scales node content).
    const logical = ts.coordinateToLogical(toLayoutPoint(this.chartContainerEl, clientX, 0).x);
    const anchor: number = logical ?? (range.from + range.to) / 2;

    const from = anchor - (anchor - range.from) * factor;
    const to = anchor + (range.to - anchor) * factor;
    if (!(to > from)) return; // degenerate range (e.g. a single bar)
    ts.setVisibleLogicalRange({ from, to });
  }

  // ===== Crosshair legend =====

  private addLegend(lines: SeriesChartLine[]) {
    const legendEl = this.chartContainerEl!.createEl("div", {
      cls: "strataboard-chart-legend",
    });
    this.legendDateEl = legendEl.createEl("span", { cls: "strataboard-chart-legend-date" });

    this.legendLines = lines.map((line) => {
      const wrap = legendEl.createEl("span", { cls: "strataboard-chart-legend-item" });
      const labelEl = wrap.createEl("span", {
        cls: "strataboard-chart-legend-label",
        text: line.name,
      });
      // Labels are colored to match their lines, so each line is
      // identifiable from the legend.
      labelEl.style.color = line.color!;
      const valueEl = wrap.createEl("span", { cls: "strataboard-chart-legend-value" });
      return { points: line.points, valueEl };
    });

    this.latestDate = lines.reduce(
      (max, line) => (line.points[line.points.length - 1].date > max ? line.points[line.points.length - 1].date : max),
      lines[0].points[lines[0].points.length - 1].date
    );
    this.updateLegend(this.latestDate);

    this.chart!.subscribeCrosshairMove((param) => {
      this.updateLegend(param.time != null ? String(param.time) : this.latestDate);
    });
  }

  private updateLegend(date: string) {
    if (!this.legendDateEl) return;
    const suffix = this.options.valueSuffix ?? "";
    this.legendDateEl.textContent = date;
    for (const line of this.legendLines) {
      const index = floorIndex(line.points, date);
      line.valueEl.textContent = formatValue(index >= 0 ? line.points[index].value : undefined, suffix);
    }
  }

  // ===== Resize =====

  // Applies a visible time range. setVisibleRange pins `to` at the right edge
  // (overriding the timeScale rightOffset), leaving the last point half-clipped
  // under the price axis; and time ranges are clamped to the loaded data, so
  // right-side whitespace past the last point cannot be expressed as a time
  // range. When the range reaches the latest point, extend the logical range
  // by the configured rightOffset so the line ends stay fully visible — the
  // same fix as the tushare chart card's applyTimeRange.
  private applyTimeRange(from: Time, to: Time) {
    const ts = this.chart!.timeScale();
    ts.setVisibleRange({ from, to });
    const lines = this.options.lines.filter((line) => line.points.length > 0);
    if (lines.length === 0) return;
    const lastTime = lines.reduce(
      (max, line) => (line.points[line.points.length - 1].date > max ? line.points[line.points.length - 1].date : max),
      ""
    );
    if (timeToYmd(to) < lastTime) return;
    const logical = ts.getVisibleLogicalRange();
    if (!logical) return;
    const rightOffset = ts.options().rightOffset;
    ts.setVisibleLogicalRange({ from: logical.from, to: logical.to + rightOffset });
  }

  private setupResizeObserver() {
    if (!this.chartContainerEl) return;
    this.resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        // Re-apply the persisted range (or fit) only once, right after the
        // container gets its real size; lightweight-charts preserves the
        // logical range across later resizes on its own.
        if (this.initialVisibleRange) {
          try {
            this.applyTimeRange(this.initialVisibleRange.from, this.initialVisibleRange.to);
          } catch {
            this.chart?.timeScale().fitContent();
            this.initialVisibleRange = null;
          }
        } else {
          this.chart?.timeScale().fitContent();
        }
        // 宽度自适应 off: pin the stack to its first-layout width so later
        // canvas node width changes stop reaching the chart (canvas-only,
        // same as the tushare chart's freezeWidth).
        if (this.options.freezeWidth && this.stackEl && this.containerEl.closest(".canvas-node")) {
          this.stackEl.style.width = `${this.chartContainerEl!.clientWidth}px`;
        }
        this.resizeObserver?.disconnect();
      });
    });
    this.resizeObserver.observe(this.chartContainerEl);
  }
}
