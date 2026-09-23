import { MarkdownRenderChild, setIcon, setTooltip } from "obsidian";
import {
  createChart,
  LineSeries,
  LineStyle,
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
import { buildChartOptions, exportChartPng, floorIndex, suppressMarkdownChrome } from "./chart-renderer";
import { ChartSizeGuard } from "./chart-size-guard";
import { t } from "../i18n";

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
  onEdit?: () => void; // pencil button in the header (only rendered when a title is present)
  // Overlay 独立纵轴 mode: every line gets its own invisible overlay price
  // scale (auto-fitted to its own range); the shared right axis is hidden.
  independentScales?: boolean;
  // Global 显示设置 (applied at render time); opacity values are percents
  // (0-100), gated by their companion toggle at render time.
  showLegend: boolean;
  legendFrosted: boolean;
  legendOpacity: number;
  showLatestValue: boolean;
  // Vertex dots on every data point (noisy on long series; default off in
  // settings). Independent of showLatestValue, which keeps the axis label /
  // dashed guide line.
  showPointMarkers: boolean;
  showGrid: boolean;
  gridOpacity: number;
}

const DEFAULT_HEIGHT = 400;

// Line palette for overlay/spread charts; cycles when a card has more lines
// than colors. Colors stay readable on both themes. Length matches
// MAX_OVERLAY_SERIES so a full overlay card never repeats a color.
const SERIES_LINE_COLORS = [
  "#2563eb", "#dc2626", "#f59e0b", "#8b5cf6", "#14b8a6",
  "#ec4899", "#0ea5e9", "#84cc16", "#f97316", "#6366f1",
];

function formatValue(n: number | undefined, suffix: string): string {
  if (n == null || Number.isNaN(n)) return "--";
  const text = n.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${text}${suffix}`;
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
  private sizeGuard: ChartSizeGuard | null = null;
  private uninstallZoomFix: (() => void) | null = null;
  private legendDateEl: HTMLElement | null = null;
  private legendEl: HTMLElement | null = null;
  private legendLines: { points: SeriesPoint[]; valueEl: HTMLElement }[] = [];
  private latestDate = "";
  private initialVisibleRange: IRange<Time> | null = null;
  private stackEl: HTMLElement | null = null;
  // Price-scale ids carrying a line each — ["right"] normally, one overlay
  // scale per line in 独立纵轴 mode (drives the legend-clearance margins).
  private scaleIds: string[] = ["right"];

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
        text: t("暂无数据：所选系列在该时间范围内没有数据。"),
      });
      return;
    }

    // Header row with the card title (and optional subtitle, e.g. the
    // normalization base date) plus action buttons on the right (edit opens
    // the card's edit modal; export screenshots the chart to a PNG). Skipped
    // when no title is given — the FRED/macro cards render their own
    // tushare-style header above the chart.
    if (this.options.title) {
      const headerEl = this.containerEl.createEl("div", { cls: "financial-series-chart-header" });
      const mainEl = headerEl.createEl("div", { cls: "financial-series-chart-header-main" });
      // Long titles (an overlay card composes every series name — up to
      // MAX_OVERLAY_SERIES of them) are ellipsized in CSS; the full text
      // stays available on hover.
      const titleEl = mainEl.createEl("span", { cls: "financial-series-chart-title", text: this.options.title });
      setTooltip(titleEl, this.options.title);
      if (this.options.subtitle) {
        const subtitleEl = mainEl.createEl("div", { cls: "financial-series-chart-subtitle", text: this.options.subtitle });
        setTooltip(subtitleEl, this.options.subtitle);
      }
      const actions = headerEl.createEl("div", { cls: "strataboard-header-actions" });
      if (this.options.onEdit) {
        const editBtn = actions.createEl("button", { cls: "strataboard-header-btn" });
        setIcon(editBtn, "pencil");
        setTooltip(editBtn, t("编辑参数"));
        editBtn.addEventListener("click", () => this.options.onEdit?.());
      }
      const exportBtn = actions.createEl("button", { cls: "strataboard-header-btn" });
      setIcon(exportBtn, "image");
      setTooltip(exportBtn, t("导出图片"));
      exportBtn.addEventListener("click", () => {
        if (this.chart) {
          void exportChartPng(
            this.chart,
            this.options.title ?? "chart",
            { title: this.options.title ?? "", subtitle: this.options.subtitle },
            this.containerEl
          );
        }
      });
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
    const chartOptions: DeepPartial<ChartOptions> = buildChartOptions(isDark, this.options.showGrid, this.options.gridOpacity);
    // Wheel ZOOMS the time axis on series cards (wheel-pan is disabled so the
    // two don't fight). buildChartOptions is shared with the tushare K-line
    // card, so override the returned object here instead of changing it; it
    // currently sets only handleScale.axisPressedMouseMove and no handleScroll.
    chartOptions.handleScale = { axisPressedMouseMove: true, mouseWheel: true, pinch: true };
    chartOptions.handleScroll = { mouseWheel: false };
    if (this.options.independentScales) {
      // All series live on their own overlay scales; hide the empty shared axis.
      chartOptions.rightPriceScale = { ...(chartOptions.rightPriceScale ?? {}), visible: false };
    }
    // Seed the size from the container's current layout size (0x0 while
    // still detached — the ChartSizeGuard fixes it on attach).
    chartOptions.width = this.chartContainerEl.clientWidth;
    chartOptions.height = this.chartContainerEl.clientHeight;
    this.chart = createChart(this.chartContainerEl, chartOptions);
    // Zoom-correct mouse coordinates before the library sees them (Obsidian
    // canvas scales node content with a CSS transform).
    this.uninstallZoomFix = installZoomEventFix(this.chartContainerEl);

    this.scaleIds = this.options.independentScales ? lines.map((_, i) => `s${i}`) : ["right"];
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
          ...(this.options.independentScales ? { priceScaleId: this.scaleIds[i] } : {}),
          // Latest-value label on the price axis (colored with the line) —
          // the series-chart equivalent of the tushare card's latest-price
          // line (global 系列图最新值标记 setting). Vertex dots are a separate
          // setting (折线图数据点标记, default off).
          lastValueVisible: this.options.showLatestValue,
          pointMarkersVisible: this.options.showPointMarkers,
          priceFormat: suffix
            ? { type: "custom", formatter: (price: number) => `${price.toFixed(2)}${suffix}`, minMove: 0.01 }
            : { type: "price", precision: 2, minMove: 0.01 },
        },
        0
      );
      series.setData(data);
      line.color = color;
      // Single-line cards (FRED/macro/spread) also get a dashed guide line at
      // the latest value; axisLabelVisible stays off so it doesn't duplicate
      // the last-value label. Multi-line overlays skip it to keep the axis
      // uncluttered.
      if (this.options.showLatestValue && lines.length === 1) {
        series.createPriceLine({
          price: line.points[line.points.length - 1].value,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: "",
        });
      }
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
    if (this.options.showLegend) {
      this.addLegend(lines);
    }
    this.setupSizeGuard();
  }

  private cleanup() {
    this.sizeGuard?.destroy();
    this.sizeGuard = null;
    this.uninstallZoomFix?.();
    this.uninstallZoomFix = null;
    this.chart?.remove();
    this.chart = null;
    this.chartContainerEl = null;
    this.stackEl = null;    this.legendDateEl = null;
    this.legendEl = null;
    this.legendLines = [];
    this.latestDate = "";
    this.initialVisibleRange = null;
    this.scaleIds = ["right"];
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
    this.legendEl = legendEl;
    legendEl.style.setProperty("--fc-legend-opacity", String(this.options.legendOpacity));
    // 图例半透明背景 off: plain text over the chart, no blurred chip.
    if (!this.options.legendFrosted) {
      legendEl.addClass("strataboard-chart-legend-plain");
    }
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

    this.updateLegendClearance();
  }

  // Same legend-overlay headroom fix as the tushare chart card: the legend
  // is an absolute DOM overlay at the top of the chart, so the price scale
  // reserves real headroom for it (recomputed on every resize — the margin
  // is a pane-height ratio, the legend is fixed pixels).
  private updateLegendClearance() {
    if (!this.chart || !this.legendEl) return;
    const pane = this.chart.panes()[0];
    const paneHeight = pane.getHeight();
    if (paneHeight <= 0) return;
    const top = Math.min(0.5, Math.max(0.02, (this.legendEl.offsetHeight + 8) / paneHeight));
    for (const id of this.scaleIds) {
      pane.priceScale(id).applyOptions({ scaleMargins: { top, bottom: 0.02 } });
    }
  }

  private updateLegend(date: string) {
    if (!this.legendDateEl) return;
    const suffix = this.options.valueSuffix ?? "";
    this.legendDateEl.textContent = date;
    for (const line of this.legendLines) {
      const index = floorIndex(line.points, date, (p) => p.date);
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

  // The guard owns the chart's size (library autoSize is off) and re-applies
  // the persisted range (or fit) once the container gets its real layout
  // size; lightweight-charts preserves the logical range across later
  // resizes on its own. It also re-applies when it detects a stale frame
  // (see chart-size-guard.ts).
  private setupSizeGuard() {
    if (!this.chart || !this.chartContainerEl) return;
    const containerEl = this.chartContainerEl;
    this.sizeGuard = new ChartSizeGuard(this.chart, containerEl, () => {
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
        this.stackEl.style.width = `${containerEl.clientWidth}px`;
      }
    }, () => this.updateLegendClearance());
  }
}
