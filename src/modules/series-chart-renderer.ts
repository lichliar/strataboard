import { MarkdownRenderChild, setIcon, setTooltip } from "obsidian";
import {
  createChart,
  AreaSeries,
  BaselineSeries,
  LineSeries,
  LineStyle,
  LineType,
  type BusinessDay,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type LineData,
  type IRange,
  type Time,
  type LineWidth,
} from "lightweight-charts";
import type { ChartTheme, Freq, SeriesLineType, SeriesPoint } from "../types";
import { DEFAULT_RISE_COLOR, DEFAULT_FALL_COLOR } from "../types";
import { onAttached, resolveEffectiveTheme, toLayoutPoint, installZoomEventFix } from "../utils/dom";
import { addTitleWatermark, buildChartOptions, exportChartPng, floorIndex, suppressMarkdownChrome, DETACHED_CHART_WIDTH, renderChartSnapshot, upsertPrintSnapshot, type ChartPngHeader } from "./chart-renderer";
import { DEFAULT_CARD_HEIGHT } from "./card-spec";
import { ChartSizeGuard } from "./chart-size-guard";
import { SERIES_LINE_COLORS, type SeriesChartLine } from "./overlay-lines";
import { renderCacheBadge, renderEmptyState, renderStaleBadge, isDataStale, type EmptyKind } from "./card-status";
import { t } from "../i18n";

interface SeriesChartRendererOptions {
  title?: string;      // header title, e.g. "对比（美的集团+贵州茅台）（归一化）"; omitted = no header
  subtitle?: string;   // small muted line under the title, e.g. the normalization base date
  lines: SeriesChartLine[];
  valueSuffix?: string; // e.g. "%" appended to legend values and price-axis ticks
  theme?: ChartTheme;  // default "auto" (follow Obsidian; only then is the theme watcher attached)
  // Global 涨色/跌色 (settings): the spread baseline style shades above/below
  // the 0 axis with them.
  riseColor?: string;
  fallColor?: string;
  initialVisibleRange?: { from: string; to: string };  // YYYY-MM-DD, from the card YAML
  onEdit?: () => void; // pencil button in the footer tools
  onRefresh?: () => void; // refresh button in the footer tools
  // 本地脚本 provenance (when any series is script-produced): muted note
  // line under the title (script names + last-run stamps). The rerun entry
  // lives in the load-error block (card-status.ts), not here.
  scriptNote?: string;
  // Card period (D/W/M/…) driving the stale-badge threshold.
  freq?: Freq;
  // Cache badge at the top of the card when any leg came from a failure
  // fallback instead of a fresh fetch (card-status.ts).
  cacheBadge?: { lastDataAt?: string };
  // Which empty-state copy to show when every line is empty (source vs range).
  emptyKind?: EmptyKind;
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

const LINE_TYPE_MAP: Record<SeriesLineType, LineType> = {
  simple: LineType.Simple,
  curved: LineType.Curved,
  steps: LineType.WithSteps,
};

// Alpha-blended variant of a #rrggbb line color for the area-style gradient.
// Non-hex colors fall back to the raw color / fully transparent.
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(color);
  if (!m) return alpha >= 0.5 ? color : "transparent";
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

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

// Shared multi-line chart for the overlay (compare) and spread (calc)
// cards: one lightweight-charts LineSeries per line, a crosshair legend with
// one colored entry per line, theme-aware rebuild, and a Chinese empty state.
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
      renderEmptyState(this.containerEl, this.options.emptyKind ?? "range-empty");
      return;
    }

    // Status badges (card-status.ts): the cache badge wins over the stale
    // badge — served-from-cache already implies the data may be old.
    const lastBarYmd = lines.reduce(
      (max, line) => (line.points[line.points.length - 1].date > max ? line.points[line.points.length - 1].date : max),
      lines[0].points[lines[0].points.length - 1].date
    );
    if (this.options.cacheBadge) {
      renderCacheBadge(this.containerEl, this.options.cacheBadge.lastDataAt, () => this.options.onRefresh?.());
    } else if (this.options.freq && isDataStale(lastBarYmd, this.options.freq)) {
      renderStaleBadge(this.containerEl, lastBarYmd, () => this.options.onRefresh?.());
    }

    // Header row with the card title (and optional subtitle, e.g. the
    // normalization base date). 编辑参数/刷新数据/导出图片 live in the footer
    // (same layout as the quote card). Skipped when no title is given.
    if (this.options.title) {
      const headerEl = this.containerEl.createDiv({ cls: "financial-series-chart-header" });
      const mainEl = headerEl.createDiv({ cls: "financial-series-chart-header-main" });
      // Long titles (an overlay card composes every series name — up to
      // MAX_OVERLAY_SERIES of them) are ellipsized in CSS; the full text
      // stays available on hover.
      const titleEl = mainEl.createSpan({ cls: "financial-series-chart-title", text: this.options.title });
      setTooltip(titleEl, this.options.title);
      if (this.options.subtitle) {
        const subtitleEl = mainEl.createDiv({ cls: "financial-series-chart-subtitle", text: this.options.subtitle });
        setTooltip(subtitleEl, this.options.subtitle);
      }
      if (this.options.scriptNote) {
        const noteEl = mainEl.createDiv({ cls: "financial-series-chart-script-note", text: this.options.scriptNote });
        setTooltip(noteEl, this.options.scriptNote);
      }
    }

    // Chart stack: the inline height acts as the flex basis (same sizing
    // model as the quote chart card).
    const stackEl = this.containerEl.createDiv({ cls: "strataboard-chart-stack" });
    this.stackEl = stackEl;
    stackEl.style.height = `${DEFAULT_CARD_HEIGHT}px`;
    this.chartContainerEl = stackEl.createDiv({ cls: "strataboard-chart-container" });

    // Footer: tool buttons pinned to the bottom-right (same style and order
    // as the quote card footer: 编辑 → 刷新 → 导出; series cards have no
    // period tabs on the left).
    const footerEl = this.containerEl.createDiv({ cls: "strataboard-card-footer" });
    const tools = footerEl.createDiv({ cls: "strataboard-card-tools" });
    if (this.options.onEdit) {
      const editBtn = tools.createEl("button", { cls: "strataboard-tool-btn" });
      setIcon(editBtn, "pencil");
      setTooltip(editBtn, t("编辑参数"));
      editBtn.addEventListener("click", () => this.options.onEdit?.());
    }
    if (this.options.onRefresh) {
      const refreshBtn = tools.createEl("button", { cls: "strataboard-tool-btn" });
      setIcon(refreshBtn, "refresh-cw");
      setTooltip(refreshBtn, t("刷新数据"));
      refreshBtn.addEventListener("click", () => this.options.onRefresh?.());
    }
    const exportBtn = tools.createEl("button", { cls: "strataboard-tool-btn" });
    setIcon(exportBtn, "image");
    setTooltip(exportBtn, t("导出图片"));
    exportBtn.addEventListener("click", () => {
      if (this.chart) {
        void exportChartPng(
          this.chart,
          this.options.title ?? "chart",
          { title: this.options.title ?? "", subtitle: this.options.subtitle, legend: this.buildExportLegend() },
          this.containerEl
        );
      }
    });

    const theme = this.options.theme ?? "auto";
    const isDark = resolveEffectiveTheme(theme) === "dark";
    this.containerEl.toggleClass("fc-hermes", isDark);
    const chartOptions: DeepPartial<ChartOptions> = buildChartOptions(isDark, this.options.showGrid, this.options.gridOpacity);
    // Wheel ZOOMS the time axis on series cards (wheel-pan is disabled so the
    // two don't fight). buildChartOptions is shared with the quote K-line
    // card, so override the returned object here instead of changing it; it
    // currently sets only handleScale.axisPressedMouseMove and no handleScroll.
    chartOptions.handleScale = { axisPressedMouseMove: true, mouseWheel: true, pinch: true };
    chartOptions.handleScroll = { mouseWheel: false };
    if (this.options.independentScales) {
      // All series live on their own overlay scales; hide the empty shared axis.
      chartOptions.rightPriceScale = { ...(chartOptions.rightPriceScale ?? {}), visible: false };
    }
    // Seed the size from the container's current layout size, falling back to
    // DETACHED_CHART_WIDTH/the configured height when there is no layout yet
    // (detached mount, or Obsidian's hidden PDF-export render pass — the
    // ChartSizeGuard only fixes sizing on attach/resize, which never happens
    // there, and a 0x0 chart prints as a blank canvas).
    chartOptions.width = this.chartContainerEl.clientWidth || DETACHED_CHART_WIDTH;
    chartOptions.height = this.chartContainerEl.clientHeight || DEFAULT_CARD_HEIGHT;
    this.chart = createChart(this.chartContainerEl, chartOptions);
    // Zoom-correct mouse coordinates before the library sees them (Obsidian
    // canvas scales node content with a CSS transform).
    this.uninstallZoomFix = installZoomEventFix(this.chartContainerEl);
    addTitleWatermark(this.chart, this.options.title, isDark);

    this.scaleIds = this.options.independentScales ? lines.map((_, i) => `s${i}`) : ["right"];
    // Baseline (spread style: baseline) colors: the global 涨色/跌色, with
    // gradient fills fading toward the 0 axis.
    const baselineTop = { line: this.options.riseColor ?? DEFAULT_RISE_COLOR };
    const baselineBottom = { line: this.options.fallColor ?? DEFAULT_FALL_COLOR };
    lines.forEach((line, i) => {
      const data: LineData[] = line.points.map((p) => ({ time: p.date, value: p.value }));
      // Baseline lines (spread 基线 style) ignore the palette color: the
      // legend dot and latest-value guide line follow the sign of the latest
      // value instead (rise color above / fall color below the 0 axis).
      const color =
        line.style === "baseline"
          ? line.points[line.points.length - 1].value >= 0
            ? baselineTop.line
            : baselineBottom.line
          : line.color ?? SERIES_LINE_COLORS[i % SERIES_LINE_COLORS.length];
      // When every line is percent-ish the legend carries a "%" suffix; put
      // the same suffix on the price-axis ticks via a custom price format.
      const suffix = this.options.valueSuffix ?? "";
      const sharedOptions = {
        lineWidth: (line.lineWidth ?? 2) as LineWidth,
        lineType: LINE_TYPE_MAP[line.lineType ?? "simple"],
        priceLineVisible: false,
        ...(this.options.independentScales ? { priceScaleId: this.scaleIds[i] } : {}),
        // Latest-value label on the price axis (colored with the line) —
        // the series-chart equivalent of the quote card's latest-price
        // line (global 系列图最新值标记 setting). Vertex dots are a separate
        // setting (折线图数据点标记, default off).
        lastValueVisible: this.options.showLatestValue,
        pointMarkersVisible: this.options.showPointMarkers,
        priceFormat: suffix
          ? { type: "custom" as const, formatter: (price: number) => `${price.toFixed(2)}${suffix}`, minMove: 0.01 }
          : { type: "price" as const, precision: 2, minMove: 0.01 },
      };
      const series =
        line.style === "baseline"
          ? this.chart!.addSeries(
              BaselineSeries,
              {
                ...sharedOptions,
                baseValue: { type: "price", price: 0 },
                topLineColor: baselineTop.line,
                topFillColor1: withAlpha(baselineTop.line, 0.28),
                topFillColor2: withAlpha(baselineTop.line, 0.04),
                bottomLineColor: baselineBottom.line,
                bottomFillColor1: withAlpha(baselineBottom.line, 0.28),
                bottomFillColor2: withAlpha(baselineBottom.line, 0.04),
              },
              0
            )
          : line.style === "area"
            ? this.chart!.addSeries(
                AreaSeries,
                {
                  ...sharedOptions,
                  lineColor: color,
                  topColor: withAlpha(color, 0.35),
                  bottomColor: withAlpha(color, 0.02),
                },
                0
              )
            : this.chart!.addSeries(LineSeries, { ...sharedOptions, color }, 0);
      series.setData(data);
      line.color = color;
      // Single-line cards (spread, or a one-line overlay) also get a dashed
      // guide line at the latest value; axisLabelVisible stays off so it
      // doesn't duplicate the last-value label. Multi-line overlays skip it
      // to keep the axis uncluttered.
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

  // takeScreenshot() forces a synchronous full repaint — used after the
  // initial render so the canvas bitmap is populated even when the library's
  // rAF-batched paint never runs (hidden PDF-export render pass). Also
  // refreshes the print snapshot: in @media print the live chart DOM is
  // hidden and this static image is what lands in the PDF (a monolithic
  // bitmap the paginator can never slice mid-chart).
  forcePaint(): void {
    if (!this.chart || !this.chartContainerEl) return;
    upsertPrintSnapshot(this.chartContainerEl, renderChartSnapshot(this.chart, this.containerEl));
  }

  // Legend snapshot for PNG exports. Recomputed from the series data at the
  // LATEST date — never read from the DOM legend, which may be showing a
  // crosshair-hovered date or not exist at all (显示图例 off). Colors come
  // from the render pass, which writes the resolved color back onto each line.
  private buildExportLegend(): ChartPngHeader["legend"] {
    const lines = this.options.lines.filter((line) => line.points.length > 0);
    if (lines.length === 0) return undefined;
    const date = lines.reduce(
      (max, line) => (line.points[line.points.length - 1].date > max ? line.points[line.points.length - 1].date : max),
      lines[0].points[lines[0].points.length - 1].date
    );
    const suffix = this.options.valueSuffix ?? "";
    return {
      date,
      items: lines.map((line) => {
        const index = floorIndex(line.points, date, (p) => p.date);
        return {
          label: line.name,
          color: line.color ?? "#868e99",
          value: formatValue(index >= 0 ? line.points[index].value : undefined, suffix),
        };
      }),
    };
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
    const legendEl = this.chartContainerEl!.createDiv({
      cls: "strataboard-chart-legend",
    });
    this.legendEl = legendEl;
    legendEl.style.setProperty("--fc-legend-opacity", String(this.options.legendOpacity));
    // 图例半透明背景 off: plain text over the chart, no blurred chip.
    if (!this.options.legendFrosted) {
      legendEl.addClass("strataboard-chart-legend-plain");
    }
    this.legendDateEl = legendEl.createSpan({ cls: "strataboard-chart-legend-date" });

    this.legendLines = lines.map((line) => {
      const wrap = legendEl.createSpan({ cls: "strataboard-chart-legend-item" });
      const labelEl = wrap.createSpan({
        cls: "strataboard-chart-legend-label",
        text: line.name,
      });
      // Labels are colored to match their lines, so each line is
      // identifiable from the legend.
      labelEl.style.color = line.color!;
      const valueEl = wrap.createSpan({ cls: "strataboard-chart-legend-value" });
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

  // Same legend-overlay headroom fix as the quote chart card: the legend
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
  // same fix as the quote chart card's applyTimeRange.
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
    }, () => this.updateLegendClearance());
  }
}
