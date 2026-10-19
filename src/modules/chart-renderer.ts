import { MarkdownRenderChild, Notice, setIcon, setTooltip } from "obsidian";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  type IChartApi,
  type IPaneApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type Time,
} from "lightweight-charts";
import {
  addTitleWatermark,
  buildChartOptions,
  CHART_PALETTE,
  composePng,
  drawChartPaneLabels,
  DETACHED_CHART_WIDTH,
  toChartTime,
  timeToYmd,
  type ChartPngHeader,
  type ComposePngOptions,
  type ChartPaneLabel,
} from "./chart-png";
// Re-exports for the series chart renderer (and any other card renderer)
// that historically imported these from this module.
export {
  addTitleWatermark,
  buildChartOptions,
  CHART_PALETTE,
  DETACHED_CHART_WIDTH,
  floorIndex,
  toChartTime,
  timeToYmd,
  type ChartPngHeader,
} from "./chart-png";
import type { Freq, OhlcvRow, ParsedCardSpec, SymbolItem } from "../types";
import { ChartSizeGuard } from "./chart-size-guard";
import { resolveEffectiveTheme, onAttached, toLayoutPoint, installZoomEventFix } from "../utils/dom";
import { formatDate, formatDateTime } from "../utils/date";
import { FREQ_BADGE, freqRank, maxFreq } from "../utils/frequency";
import { renderCacheBadge, renderEmptyState, renderStaleBadge, isDataStale, type EmptyKind } from "./card-status";
import { t, getLanguage } from "../i18n";
import type { Bar, IndicatorResult } from "oakscriptjs";
import { IndicatorRenderer } from "../vendor/lci/render";
import {
  computeIndicatorForInstance,
  getIndicatorRuntimeError,
  recordIndicatorRuntimeError,
  ohlcvToBars,
  type IndicatorDef,
  type IndicatorInstance,
  type IndicatorResultLike,
  formatIndicatorLabel,
} from "./indicators";

interface ChartRendererOptions {
  spec: ParsedCardSpec;
  data: OhlcvRow[];
  // Native frequency of the source's raw rows (auto-detected per symbol).
  // Period buttons below it are frozen — upsampling only, never fabricating
  // smaller-period bars from coarser data. Drives the header's 级别 badge.
  nativeFreq?: Freq;
  theme: "auto" | "dark" | "light";
  chartType: "candlestick" | "line";
  riseColor: string;
  fallColor: string;
  // Manual chart height. Undefined means the card is in Canvas auto-height
  // mode and the flex layout fills the containing Canvas node.
  height?: number;
  symbolInfo?: SymbolItem;
  // User-provided indicator instances from the card; [] = no indicators.
  // Overlay indicators draw
  // on the price pane, the rest get their own panes after the volume pane.
  indicators: IndicatorInstance[];
  // Global 显示设置 (applied at render time); opacity values are percents
  // (0-100), gated by their companion toggle at render time.
  showLegend: boolean;
  legendFrosted: boolean;
  legendOpacity: number;
  showGrid: boolean;
  gridOpacity: number;
  // 本地脚本 provenance (script-produced sources only): the header gets a
  // provenance line (script · data-through · last run). scriptStale = the
  // script file was edited after the output CSV was last written. The script
  // rerun entry lives in the load-error block (card-status.ts), not here.
  scriptInfo?: { scriptName: string; lastRun: number | null; scriptStale: boolean };
  // Click on a bar (chart mode / reading mode only — the caller gates canvas
  // view mode) → open that date's daily note.
  onDateClick?: (ymd: string) => void;
  onRefresh?: () => void;
  onSwitchFreq?: (freq: Freq) => void;
  // Footer tool buttons: 编辑参数 / 刷新数据 / 导出图片 (unified with the
  // series cards).
  onEdit?: () => void;
  onIndicatorLabelClick?: (indicatorId: string) => void;
  // Cache badge at the top of the card when the data came from a failure
  // fallback instead of a fresh fetch (card-status.ts).
  cacheBadge?: { lastDataAt?: string };
  // Which empty-state copy to show when data is empty (source vs range).
  emptyKind?: EmptyKind;
}

function formatNumber(n: number | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "--";
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatBigNumber(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return "--";
  // English UI uses T/B/M magnitudes instead of 万亿/亿/万.
  if (getLanguage() === "en") {
    const abs = Math.abs(n);
    if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    return n.toFixed(2);
  }
  const wan = 10000;
  const yi = wan * wan;
  const wanYi = yi * wan;
  if (Math.abs(n) >= wanYi) {
    return `${(n / wanYi).toFixed(2)}万亿`;
  }
  if (Math.abs(n) >= yi) {
    return `${(n / yi).toFixed(2)}亿`;
  }
  if (Math.abs(n) >= wan) {
    return `${(n / wan).toFixed(2)}万`;
  }
  return n.toFixed(2);
}

function formatPercent(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return "--";
  return `${n.toFixed(2)}%`;
}

// One overlay indicator plot surfaced in the crosshair legend: the label is
// colored like its line, values aligned to the displayed bar index.
interface OverlayLegendPlot {
  label: string;
  color: string;
  values: (number | null)[];
}

// DOM handles for the crosshair legend; open/high/low only exist on
// candlestick charts.
interface LegendRefs {
  date: HTMLElement;
  open: HTMLElement | null;
  high: HTMLElement | null;
  low: HTMLElement | null;
  close: HTMLElement;
  change: HTMLElement;
  vol: HTMLElement;
  indicators: HTMLElement[];
}

export class ChartRenderer extends MarkdownRenderChild {
  private options: ChartRendererOptions;
  private chart: IChartApi | null = null;
  private chartContainerEl: HTMLElement | null = null;
  private sizeGuard: ChartSizeGuard | null = null;
  private autoHeightObserver: ResizeObserver | null = null;
  private autoHeightTimers: number[] = [];
  private uninstallZoomFix: (() => void) | null = null;
  private initialVisibleRange: { from: Time; to: Time } | null = null;

  // DOM refs
  private headerEl: HTMLElement | null = null;
  private periodTabsEl: HTMLElement | null = null;
  private chartStackEl: HTMLElement | null = null;
  private priceSeries: ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null = null;
  private legendRefs: LegendRefs | null = null;
  private legendEl: HTMLElement | null = null;
  private overlayLegendPlots: OverlayLegendPlot[] = [];
  // Indicators that failed during this render (compute or draw). A bad
  // indicator is isolated: it is skipped, listed in a warning line on the
  // card, and never blocks the chart or the other indicators.
  private indicatorFailures: { name: string; error: string }[] = [];
  private paneLabels: { pane: number; el: HTMLElement; indicatorId?: string }[] = [];
  private dataIndexByTime = new Map<string, number>();
  private readyPromise: Promise<void> = Promise.resolve();

  constructor(containerEl: HTMLElement, options: ChartRendererOptions) {
    super(containerEl);
    this.options = options;
  }

  // Resolves when the initial render finished (render() handles its own
  // errors, so this never rejects). Awaited by the code-block renderer so
  // Obsidian's PDF export waits for the chart instead of capturing the
  // loading placeholder.
  whenReady(): Promise<void> {
    return this.readyPromise;
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

  onload() {
    this.readyPromise = this.render();
  }

  onunload() {
    this.cleanup();
  }

  private async render() {
    this.cleanup();
    this.containerEl.empty();
    this.containerEl.addClass("strataboard-card");
    onAttached(this.containerEl, () => suppressMarkdownChrome(this.containerEl));

    const { spec, data } = this.options;

    if (data.length === 0) {
      renderEmptyState(this.containerEl, this.options.emptyKind ?? "range-empty");
      return;
    }

    // Status badges (card-status.ts): the cache badge wins over the stale
    // badge — served-from-cache already implies the data may be old.
    const lastBarYmd = toChartTime(data[data.length - 1].tradeDate);
    if (this.options.cacheBadge) {
      renderCacheBadge(this.containerEl, this.options.cacheBadge.lastDataAt, () => this.options.onRefresh?.());
    } else if (isDataStale(lastBarYmd, maxFreq(spec.freq, this.nativeFreq()))) {
      renderStaleBadge(this.containerEl, lastBarYmd, () => this.options.onRefresh?.());
    }

    if (spec.showHeader !== false) {
      void this.addHeader(data);
    }

    this.addChartStack();

    const effectiveTheme = resolveEffectiveTheme(this.options.theme);
    const isDark = effectiveTheme === "dark";
    this.applyThemeScope(isDark);

    if (this.options.height != null) {
      this.chartStackEl!.style.height = `${this.options.height}px`;
    } else {
      this.chartStackEl!.style.removeProperty("height");
    }
    this.chartContainerEl = this.chartStackEl!.createDiv({
      cls: "strataboard-chart-container",
    });

    this.chart = createChart(this.chartContainerEl, {
      ...buildChartOptions(isDark, this.options.showGrid, this.options.gridOpacity),
      // Seed the size from the container's current layout size, falling back
      // to DETACHED_CHART_WIDTH/the configured height when there is no layout
      // yet (detached mount, or Obsidian's hidden PDF-export render pass —
      // the ChartSizeGuard only fixes sizing on attach/resize, which never
      // happens there, and a 0x0 chart prints as a blank canvas).
      width: this.chartContainerEl.clientWidth || DETACHED_CHART_WIDTH,
      height: this.chartContainerEl.clientHeight || this.options.height || 400,
    });
    // Zoom-correct mouse coordinates before the library sees them (Obsidian
    // canvas scales node content with a CSS transform).
    this.uninstallZoomFix = installZoomEventFix(this.chartContainerEl);
    addTitleWatermark(this.chart, this.options.spec.title ?? this.options.symbolInfo?.name ?? this.options.spec.symbol, isDark);
    if (this.options.onDateClick) {
      const onDateClick = this.options.onDateClick;
      this.chart.subscribeClick((param) => {
        if (param.time == null) return;
        onDateClick(timeToYmd(param.time));
      });
    }

    this.priceSeries = this.addPriceSeries(0, data, isDark);
    // Overlay indicators draw on the price pane (before the volume pane
    // exists); non-overlay ones get panes AFTER it, so pane order is always
    // price → volume → indicator panes.
    this.addOverlayIndicators(data);
    // 成交量 pane 默认开（卡片级 显示成交量 可关）。
    const showVolume = spec.showVolume !== false;
    if (showVolume) {
      this.addVolumeSeries(1, data);
    }
    this.configurePane(this.chart.panes()[0], { leftVisible: false, rightVisible: true }, isDark);
    const volumePane = this.chart.panes()[1];
    if (volumePane) {
      this.configureAuxPane(volumePane);
    }
    this.addIndicatorPanes(data, showVolume ? 2 : 1);
    this.addPaneLabels(showVolume);
    this.addIndicatorFailureNote();
    // Fixed pane stretch: main pane 3, every aux pane 1.
    this.chart.panes().forEach((pane, i) => pane.setStretchFactor(i === 0 ? 3 : 1));
    this.addLatestPriceLine(data);
    this.addCustomPriceLines(isDark);
    if (this.options.showLegend) {
      this.addLegend(data);
    }

    if (spec.visibleStart && spec.visibleEnd) {
      // Persisted chart-mode zoom/pan range. It can fall outside the loaded
      // data after a range change, so fall back to fitContent on failure.
      const persisted = { from: spec.visibleStart as Time, to: spec.visibleEnd as Time };
      try {
        this.applyTimeRange(persisted.from, persisted.to);
        this.initialVisibleRange = persisted;
      } catch {
        this.chart.timeScale().fitContent();
      }
    } else {
      this.chart.timeScale().fitContent();
    }

    this.setupSizeGuard();

    // Footer (wireframe #screen-card): freq tabs + SVG tool buttons.
    this.addFooter();
    this.setupAutoHeight();
  }

  // The card surface carries the hermes dark palette via the fc-hermes scope
  // class (styles.css); explicit per-card light theme opts out.
  private applyThemeScope(isDark: boolean) {
    this.containerEl.toggleClass("fc-hermes", isDark);
  }

  private cleanup() {
    this.sizeGuard?.destroy();
    this.sizeGuard = null;
    this.autoHeightObserver?.disconnect();
    this.autoHeightObserver = null;
    for (const timer of this.autoHeightTimers) window.clearTimeout(timer);
    this.autoHeightTimers = [];
    this.uninstallZoomFix?.();
    this.uninstallZoomFix = null;
    this.chart?.remove();
    this.chart = null;
    this.chartContainerEl = null;
    this.initialVisibleRange = null;
    this.headerEl = null;
    this.periodTabsEl = null;
    this.chartStackEl = null;
    this.priceSeries = null;
    this.legendRefs = null;
    this.legendEl = null;
    this.overlayLegendPlots = [];
    this.indicatorFailures = [];
    this.paneLabels = [];
    this.dataIndexByTime.clear();
  }

  /**
   * Automatic quote-card height follows the actual Canvas node. Obsidian's
   * nested markdown/embed wrappers do not consistently resolve percentage
   * heights, so measure the card's fixed header/footer and assign the chart
   * stack's remaining height explicitly.
   */
  private setupAutoHeight() {
    if (this.options.height != null || !this.chartStackEl) return;
    const node = this.containerEl.closest(".canvas-node") as HTMLElement | null;
    if (!node) return;
    this.autoHeightObserver = new ResizeObserver(() => this.syncAutoHeight());
    this.autoHeightObserver.observe(node);
    this.syncAutoHeight();
    for (const delay of [100, 300, 800, 1600]) {
      this.autoHeightTimers.push(window.setTimeout(() => this.syncAutoHeight(), delay));
    }
  }

  private syncAutoHeight() {
    if (this.options.height != null || !this.chartStackEl) return;
    const node = this.containerEl.closest(".canvas-node") as HTMLElement | null;
    if (!node) return;
    // Use the Canvas node's fixed layout box as the sole source of truth.
    // Measuring the card itself is circular: its flex children can change its
    // scroll/client height, which would otherwise make the node grow forever.
    const nodeHeight = node.clientHeight;
    if (nodeHeight <= 0) return;
    const fixedHeight = Array.from(this.containerEl.children)
      .filter((child) => child !== this.chartStackEl)
      .reduce((sum, child) => sum + (child as HTMLElement).offsetHeight, 0);
    const cardStyle = window.getComputedStyle(this.containerEl);
    const cardInsets =
      parseFloat(cardStyle.paddingTop) +
      parseFloat(cardStyle.paddingBottom) +
      parseFloat(cardStyle.borderTopWidth) +
      parseFloat(cardStyle.borderBottomWidth);
    // Canvas rounds transformed node bounds; keep a small reserve so the
    // footer's bottom border and button row are never clipped by that round.
    const nextHeight = Math.max(200, Math.floor(nodeHeight - fixedHeight - cardInsets - 24));
    if (Math.abs(this.chartStackEl.offsetHeight - nextHeight) < 2) return;
    this.chartStackEl.style.height = `${nextHeight}px`;
    if (this.chart && this.chartContainerEl) {
      this.chart.resize(this.chartContainerEl.clientWidth, this.chartContainerEl.clientHeight);
    }
  }

  // Current visible time range as YYYY-MM-DD, or null when no chart/range.
  getVisibleRangeYmd(): { from: string; to: string } | null {
    const range = this.chart?.timeScale().getVisibleRange();
    if (!range) return null;
    return { from: timeToYmd(range.from), to: timeToYmd(range.to) };
  }

  // The range initially applied at render time (preset or persisted custom
  // dates), as YYYY-MM-DD; null when the chart started on fitContent.
  getInitialVisibleRangeYmd(): { from: string; to: string } | null {
    if (!this.initialVisibleRange) return null;
    return { from: timeToYmd(this.initialVisibleRange.from), to: timeToYmd(this.initialVisibleRange.to) };
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

  // ===== Header =====

  private async addHeader(data: OhlcvRow[]) {
    const symbol = this.options.symbolInfo;
    const latest = data[data.length - 1];
    const prev = data.length > 1 ? data[data.length - 2] : latest;
    const change = latest.close - prev.close;
    const changePct = prev.close !== 0 ? (change / prev.close) * 100 : 0;
    const isRise = change >= 0;
    const color = isRise ? this.options.riseColor : this.options.fallColor;

    this.headerEl = this.containerEl.createDiv({ cls: "strataboard-header" });

    const topRow = this.headerEl.createDiv({ cls: "strataboard-header-top" });

    const titleWrap = topRow.createDiv({ cls: "strataboard-header-title-wrap" });
    const title = titleWrap.createDiv({ cls: "strataboard-header-title" });
    // 标题 override: the name row shows the custom title and the code line is
    // dropped entirely (the override is the card's whole identity).
    const customTitle = this.options.spec.title;
    title.createSpan({ cls: "strataboard-header-name", text: customTitle ?? symbol?.name ?? this.options.spec.symbol });
    title.createSpan({ cls: "strataboard-header-freq", text: t(FREQ_BADGE[this.nativeFreq()]) });
    if (!customTitle && symbol?.enname) {
      title.createSpan({ cls: "strataboard-header-enname", text: ` · ${symbol.enname}` });
    }
    if (!customTitle) {
      titleWrap.createDiv({ cls: "strataboard-header-code", text: symbol?.tsCode ?? this.options.spec.symbol });
    }

    const quoteRow = this.headerEl.createDiv({ cls: "strataboard-header-quote" });
    quoteRow.createSpan({
      cls: "strataboard-header-price",
      text: formatNumber(latest.close, 2),
      attr: { style: `color: ${color}` },
    });
    quoteRow.createSpan({
      cls: "strataboard-header-change",
      text: `${change >= 0 ? "+" : ""}${formatNumber(change, 2)}`,
      attr: { style: `color: ${color}` },
    });
    quoteRow.createSpan({
      cls: "strataboard-header-change-pct",
      text: `${change >= 0 ? "+" : ""}${formatPercent(changePct)}`,
      attr: { style: `color: ${color}` },
    });

    // 本地脚本 provenance line (script-produced sources only): which script
    // feeds the card, how fresh the data is, and when the script last ran —
    // the maintenance trail when a script source rots.
    const scriptInfo = this.options.scriptInfo;
    if (scriptInfo) {
      const line = this.headerEl.createDiv({ cls: "strataboard-header-script" });
      line.createSpan({
        text: t("本地脚本 · {name} · 数据至 {date} · 更新于 {time}", {
          name: scriptInfo.scriptName,
          date: toChartTime(latest.tradeDate),
          time: scriptInfo.lastRun ? formatDateTime(scriptInfo.lastRun) : t("从未"),
        }),
      });
      if (scriptInfo.scriptStale) {
        line.createSpan({ cls: "strataboard-header-script-stale", text: t("脚本已修改未运行") });
      }
    }
  }

  // Header text for PNG exports (name + code + latest quote, rise/fall
  // colored) — mirrors the DOM header, so the exported image identifies the
  // card even when the on-screen header is hidden (显示标题栏 off).
  private buildExportHeader(): ChartPngHeader {
    const symbol = this.options.symbolInfo;
    const data = this.options.data;
    const latest = data[data.length - 1];
    const prev = data.length > 1 ? data[data.length - 2] : latest;
    const change = latest.close - prev.close;
    const changePct = prev.close !== 0 ? (change / prev.close) * 100 : 0;
    const color = change >= 0 ? this.options.riseColor : this.options.fallColor;
    const customTitle = this.options.spec.title;
    return {
      title: customTitle ?? symbol?.name ?? this.options.spec.symbol,
      // With a custom title the code would duplicate the overridden identity;
      // keep only the freq badge in the subtitle.
      subtitle: customTitle ? t(FREQ_BADGE[this.nativeFreq()]) : `${symbol?.tsCode ?? this.options.spec.symbol} · ${t(FREQ_BADGE[this.nativeFreq()])}`,
      quote: [
        { text: formatNumber(latest.close, 2), color },
        { text: `${change >= 0 ? "+" : ""}${formatNumber(change, 2)}`, color },
        { text: `${change >= 0 ? "+" : ""}${formatPercent(changePct)}`, color },
      ],
      legend: this.overlayLegendPlots.length > 0 ? {
        items: this.overlayLegendPlots.map((plot) => ({
          label: plot.label,
          color: plot.color,
          value: formatNumber(plot.values[plot.values.length - 1] ?? undefined, 2),
        })),
      } : undefined,
    };
  }

  // ===== Footer: freq tabs + SVG tool buttons (wireframe #screen-card) =====

  private nativeFreq(): Freq {
    return this.options.nativeFreq ?? "D";
  }

  private addFooter() {
    const footerEl = this.containerEl.createDiv({ cls: "strataboard-card-footer" });
    this.periodTabsEl = footerEl.createDiv({ cls: "strataboard-period-tabs" });
    const freqs: { id: Freq; label: string }[] = [
      { id: "D", label: "日K" },
      { id: "W", label: "周K" },
      { id: "M", label: "月K" },
      { id: "Q", label: "季K" },
      { id: "Y", label: "年K" },
    ];

    const native = this.nativeFreq();
    // A spec.freq below the native frequency is clamped for display (main.ts
    // renders effFreq instead), so the active tab follows the effective one.
    const activeFreq = maxFreq(this.options.spec.freq, native);
    for (const f of freqs) {
      // Freeze periods finer than the source's native granularity: weekly
      // bars built from monthly rows would be fabricated, not resampled.
      const frozen = freqRank(f.id) < freqRank(native);
      const btn = this.periodTabsEl.createEl("button", {
        text: t(f.label),
        cls: `${f.id === activeFreq ? "is-active" : ""} ${frozen ? "is-disabled" : ""}`.trim(),
      });
      if (frozen) {
        btn.disabled = true;
        setTooltip(btn, t("数据源原始粒度为{label}，不支持切换到更小周期。", { label: t(FREQ_BADGE[native]) }));
        continue;
      }
      btn.addEventListener("click", () => {
        if (f.id !== activeFreq) {
          this.options.onSwitchFreq?.(f.id);
        }
      });
    }

    const tools = footerEl.createDiv({ cls: "strataboard-card-tools" });
    const addTool = (icon: string, tooltip: string, onClick?: () => void) => {
      const btn = tools.createEl("button", { cls: "strataboard-tool-btn" });
      setIcon(btn, icon);
      setTooltip(btn, tooltip);
      if (onClick) {
        btn.addEventListener("click", onClick);
      }
      return btn;
    };
    // Unified tool order across all chart cards: 编辑 → 刷新 → 导出.
    addTool("pencil", t("编辑参数"), () => this.options.onEdit?.());
    addTool("refresh-cw", t("刷新数据"), () => this.options.onRefresh?.());
    addTool("image", t("导出图片"), () => {
      if (!this.chart) return;
      const name = this.options.spec.title ?? this.options.symbolInfo?.name ?? this.options.spec.symbol;
      void exportChartPng(
        this.chart,
        name,
        this.buildExportHeader(),
        this.containerEl,
        this.paneLabels.map((entry) => ({ pane: entry.pane, text: entry.el.textContent ?? "" }))
      );
    });
  }

  // ===== Chart stack =====

  private addChartStack() {
    this.chartStackEl = this.containerEl.createDiv({ cls: "strataboard-chart-stack" });
  }

  // ===== Series creation =====

  private addPriceSeries(
    paneIndex: number,
    data: OhlcvRow[],
    isDark: boolean
  ): ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> {
    if (this.options.chartType === "line") {
      const lineData: LineData[] = data.map((row) => ({
        time: toChartTime(row.tradeDate),
        value: row.close,
      }));
      const series = this.chart!.addSeries(
        LineSeries,
        {
          color: isDark ? "#60a5fa" : "#2563eb",
          lineWidth: 2,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        },
        paneIndex
      );
      series.setData(lineData);
      return series;
    }

    const candleData: CandlestickData[] = data.map((row) => ({
      time: toChartTime(row.tradeDate),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    }));
    const series = this.chart!.addSeries(
      CandlestickSeries,
      {
        upColor: this.options.riseColor,
        downColor: this.options.fallColor,
        borderUpColor: this.options.riseColor,
        borderDownColor: this.options.fallColor,
        wickUpColor: this.options.riseColor,
        wickDownColor: this.options.fallColor,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      },
      paneIndex
    );
    series.setData(candleData);
    return series;
  }

  // ===== Indicators =====

  // unix-second Bars for calculate() plus the chart-time ("YYYY-MM-DD")
  // counterpart handed to the vendored renderer: the renderer forwards
  // bar/result times straight into series data and our time scale is
  // string-based, so everything it receives uses adapted string times (the
  // calculation itself runs on unix seconds; the cast localizes the
  // oakscriptjs Bar time-type mismatch — vendored files stay untouched).
  private indicatorContext(data: OhlcvRow[]): { bars: Bar[]; renderBars: Bar[] } {
    const bars = ohlcvToBars(data);
    const renderBars = bars.map((bar, i) => ({
      ...bar,
      time: toChartTime(data[i].tradeDate) as unknown as number,
    }));
    return { bars, renderBars };
  }

  // Resolve + compute (compute-cached) + adapt one instance to chart times.
  // Thin wrapper over computeIndicatorForInstance (indicators/compute.ts) so
  // the CLI/MCP headless path shares the exact same logic.
  private computeIndicator(
    instance: IndicatorInstance,
    ctx: { bars: Bar[] },
    data: OhlcvRow[]
  ): { def: IndicatorDef; inputs: Record<string, unknown>; adapted: IndicatorResultLike } | null {
    return computeIndicatorForInstance(instance, ctx.bars, data);
  }

  // Overlay indicators on the price pane (called before the volume pane
  // exists). Each visible plot also gets a crosshair-legend entry.
  private addOverlayIndicators(data: OhlcvRow[]) {
    if (this.options.indicators.length === 0 || !this.chart || !this.priceSeries) return;
    const ctx = this.indicatorContext(data);
    for (const instance of this.options.indicators) {
      if (instance.hidden) continue;
      const computed = this.computeIndicator(instance, ctx, data);
      if (!computed) {
        this.noteSkippedIndicator(instance);
        continue;
      }
      if (!computed.def.metadata.overlay) continue;
      try {
        const { def, inputs, adapted } = computed;
        const renderer = new IndicatorRenderer(this.chart, { paneIndex: 0, mainSeries: this.priceSeries });
        renderer.render(
          {
            overlay: true,
            plotConfig: def.plotConfig ?? [],
            hlineConfig: def.hlineConfig,
            fillConfig: def.fillConfig,
          },
          adapted as unknown as IndicatorResult,
          ctx.renderBars,
          { inputs }
        );
        const visiblePlots = (def.plotConfig ?? []).filter((plot) => plot.display !== "none");
        for (const [plotIndex, plot] of visiblePlots.entries()) {
          const points = adapted.plots?.[plot.id];
          if (!points?.length) continue;
          const byTime = new Map(points.map((point) => [String(point.time), point.value]));
          this.overlayLegendPlots.push({
            label: visiblePlots.length === 1 && plotIndex === 0 ? formatIndicatorLabel(def, inputs) : plotIndex === 0 ? formatIndicatorLabel(def, inputs) : plot.title ?? plot.id,
            color: plot.color ?? "#2962FF",
            values: data.map((row) => {
              const value = byTime.get(toChartTime(row.tradeDate));
              return value != null && !Number.isNaN(value) ? value : null;
            }),
          });
        }
      } catch (e) {
        this.noteIndicatorFailure(instance, e);
      }
    }
  }

  // Non-overlay indicators, one new pane each, starting at firstPane (after
  // the volume pane). Their plots show the latest value on their own price
  // scale instead of entering the main legend.
  private addIndicatorPanes(data: OhlcvRow[], firstPane: number) {
    if (this.options.indicators.length === 0 || !this.chart) return;
    const ctx = this.indicatorContext(data);
    let pane = firstPane;
    for (const instance of this.options.indicators) {
      if (instance.hidden) continue;
      const computed = this.computeIndicator(instance, ctx, data);
      if (!computed) {
        this.noteSkippedIndicator(instance);
        continue;
      }
      if (computed.def.metadata.overlay) continue;
      try {
        const { def, inputs, adapted } = computed;
        const renderer = new IndicatorRenderer(this.chart, {
          paneIndex: pane,
          mainSeries: this.priceSeries ?? undefined,
        });
        renderer.render(
          {
            overlay: false,
            plotConfig: def.plotConfig ?? [],
            hlineConfig: def.hlineConfig,
            fillConfig: def.fillConfig,
          },
          adapted as unknown as IndicatorResult,
          ctx.renderBars,
          { inputs, lastValueVisible: true }
        );
        // Every pane must keep its right scale visible or chart layout throws
        // (same constraint as the volume pane, see configureAuxPane).
        const paneApi = this.chart.panes()[pane];
        if (paneApi) {
          this.configureAuxPane(paneApi);
        }
        pane++;
      } catch (e) {
        this.noteIndicatorFailure(instance, e);
      }
    }
  }

  private addPaneLabels(showVolume: boolean) {
    if (!this.chartContainerEl || !this.chart) return;
    const add = (pane: number, text: string, indicatorId?: string) => {
      const el = this.chartContainerEl!.createDiv({ cls: "fc-chart-pane-label", text: t(text) });
      if (indicatorId && this.options.onIndicatorLabelClick) {
        el.addClass("fc-chart-pane-label-clickable");
        el.addEventListener("pointerdown", (event) => {
          event.stopPropagation();
        });
        el.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.options.onIndicatorLabelClick?.(indicatorId);
        });
      }
      this.paneLabels.push({ pane, el, indicatorId });
    };
    if (showVolume) add(1, "成交量");
    const firstIndicatorPane = showVolume ? 2 : 1;
    let pane = firstIndicatorPane;
    for (const instance of this.options.indicators) {
      if (instance.hidden) continue;
      const computed = this.computeIndicator(instance, this.indicatorContext(this.options.data), this.options.data);
      const def = computed?.def;
      if (!def || def.metadata.overlay) continue;
      add(pane, computed ? formatIndicatorLabel(computed.def, computed.inputs) : def.metadata.shortTitle || def.name || instance.id, instance.id);
      pane++;
    }
    this.syncPaneLabels();
  }

  private syncPaneLabels() {
    if (!this.chart || !this.chartContainerEl) return;
    let top = 0;
    const panes = this.chart.panes();
    for (let i = 0; i < panes.length; i++) {
      const label = this.paneLabels.find((entry) => entry.pane === i);
      if (label) {
        label.el.style.top = `${Math.max(2, top + 4)}px`;
      }
      top += panes[i].getHeight() + (i < panes.length - 1 ? 1 : 0);
    }
  }

  // computeIndicator returned null: either the id is unknown (already warned
  // by compute.ts) or the calculation failed (recorded in the runtime-error
  // store). Only the latter shows up on the card.
  private noteSkippedIndicator(instance: IndicatorInstance) {
    const error = getIndicatorRuntimeError(instance.id);
    if (error) this.indicatorFailures.push({ name: instance.id, error });
  }

  // The indicator's draw step threw (malformed output that passed the loader's
  // bounds check, renderer incompatibility, …). Record + list on the card.
  private noteIndicatorFailure(instance: IndicatorInstance, e: unknown) {
    recordIndicatorRuntimeError(instance.id, e);
    this.indicatorFailures.push({ name: instance.id, error: e instanceof Error ? e.message : String(e) });
  }

  // Warning line at the top of the card (below the header) when any indicator
  // failed; the rest of the card stays fully usable.
  private addIndicatorFailureNote() {
    if (this.indicatorFailures.length === 0) return;
    const note = createDiv({ cls: "strataboard-indicator-warning" });
    note.createSpan({
      text: t("⚠ 指标计算失败：{names}（图表其余内容不受影响，详见 设置 → 指标）", {
        names: this.indicatorFailures.map((f) => f.name).join("、"),
      }),
    });
    setTooltip(
      note,
      this.indicatorFailures.map((f) => `${f.name}: ${f.error}`).join("\n"),
      { placement: "bottom" }
    );
    if (this.chartStackEl) {
      this.containerEl.insertBefore(note, this.chartStackEl);
    } else {
      this.containerEl.appendChild(note);
    }
  }

  private addVolumeSeries(paneIndex: number, data: OhlcvRow[]) {
    const volumeData: HistogramData[] = data.map((row, i) => ({
      time: toChartTime(row.tradeDate),
      value: row.vol,
      // Color by change vs the previous close (same convention as the
      // header quote); the first bar falls back to close vs open.
      color: (i > 0 ? row.close >= data[i - 1].close : row.close >= row.open)
        ? this.options.riseColor
        : this.options.fallColor,
    }));
    const series = this.chart!.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      paneIndex
    );
    series.setData(volumeData);
  }

  // Shared secondary-pane scale config (volume pane, indicator panes).
  private configureAuxPane(pane: IPaneApi<Time>) {
    pane.priceScale("left").applyOptions({ visible: false });
    // The right scale must stay visible on EVERY pane: the chart-level
    // rightPriceScale.visible=true makes adjustSizeImpl() call
    // ensureNotNull(rightPriceAxisWidget) on each pane, and a pane whose
    // right scale is hidden has no axis widget — the chart then throws
    // "Value is null" and renders nothing at all.
    pane.priceScale("right").applyOptions({
      visible: true,
      borderVisible: false,
      scaleMargins: { top: 0.1, bottom: 0 },
    });
  }

  private addLatestPriceLine(data: OhlcvRow[]) {
    if (!this.priceSeries || data.length === 0) return;
    const latest = data[data.length - 1];
    const prev = data.length > 1 ? data[data.length - 2] : latest;
    this.priceSeries.createPriceLine({
      price: latest.close,
      color: latest.close >= prev.close ? this.options.riseColor : this.options.fallColor,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "",
    });
  }

  // 价位线 (YAML): user-defined horizontal reference lines (成本线/关注价位).
  private addCustomPriceLines(isDark: boolean) {
    if (!this.priceSeries) return;
    const p = isDark ? CHART_PALETTE.dark : CHART_PALETTE.light;
    for (const line of this.options.spec.priceLines ?? []) {
      this.priceSeries.createPriceLine({
        price: line.price,
        color: line.color ?? p.muted,
        lineWidth: 1,
        lineStyle: LineStyle.SparseDotted,
        axisLabelVisible: true,
        title: line.title ?? "",
      });
    }
  }

  // ===== Crosshair legend =====

  private addLegend(data: OhlcvRow[]) {
    const legendEl = this.chartContainerEl!.createDiv({
      cls: "strataboard-chart-legend",
    });
    this.legendEl = legendEl;
    legendEl.style.setProperty("--fc-legend-opacity", String(this.options.legendOpacity));
    // 图例半透明背景 off: plain text over the chart, no blurred chip.
    if (!this.options.legendFrosted) {
      legendEl.addClass("strataboard-chart-legend-plain");
    }
    const isCandle = this.options.chartType !== "line";

    const dateEl = legendEl.createSpan({ cls: "strataboard-chart-legend-date" });
    const mkItem = (label: string, labelColor?: string): HTMLElement => {
      const wrap = legendEl.createSpan({ cls: "strataboard-chart-legend-item" });
      const labelEl = wrap.createSpan({ cls: "strataboard-chart-legend-label", text: label });
      if (labelColor) labelEl.style.color = labelColor;
      return wrap.createSpan({ cls: "strataboard-chart-legend-value" });
    };

    this.legendRefs = {
      date: dateEl,
      open: isCandle ? mkItem(t("开")) : null,
      high: isCandle ? mkItem(t("高")) : null,
      low: isCandle ? mkItem(t("低")) : null,
      close: mkItem(t("收")),
      change: mkItem(t("涨跌")),
      vol: mkItem(t("量")),
      // Overlay indicator plots are colored to match their lines, so each
      // line is identifiable from the legend.
      indicators: this.overlayLegendPlots.map(({ label, color }) => mkItem(label, color)),
    };

    this.dataIndexByTime = new Map(
      data.map((row, i) => [toChartTime(row.tradeDate), i])
    );
    this.updateLegend(data.length - 1);

    this.chart!.subscribeCrosshairMove((param) => {
      let index = data.length - 1;
      if (param.time != null) {
        const found = this.dataIndexByTime.get(String(param.time));
        if (found != null) {
          index = found;
        }
      }
      this.updateLegend(index);
    });

    this.updateLegendClearance();
  }

  // The crosshair legend is an absolute-positioned DOM overlay at the top of
  // the chart, while the autoscale top margin is only 2% of the pane — the
  // highest candles/wicks would render underneath the legend and look
  // clipped. Reserve real headroom for the legend instead. The margin is a
  // RATIO of the pane height while the legend is fixed pixels (and wraps
  // with width), so this is recomputed on every chart resize.
  private updateLegendClearance() {
    if (!this.chart || !this.legendEl) return;
    const pane = this.chart.panes()[0];
    const paneHeight = pane.getHeight();
    if (paneHeight <= 0) return;
    const top = Math.min(0.5, Math.max(0.02, (this.legendEl.offsetHeight + 8) / paneHeight));
    pane.priceScale("right").applyOptions({ scaleMargins: { top, bottom: 0.02 } });
  }

  private updateLegend(index: number) {
    const refs = this.legendRefs;
    const data = this.options.data;
    const row = data[index];
    if (!refs || !row) return;

    const prev = index > 0 ? data[index - 1] : row;
    const changeAbs = row.close - prev.close;
    const change = prev.close !== 0 ? (changeAbs / prev.close) * 100 : 0;
    const color = change >= 0 ? this.options.riseColor : this.options.fallColor;

    refs.date.textContent = toChartTime(row.tradeDate);
    if (refs.open) {
      refs.open.textContent = formatNumber(row.open, 2);
      refs.open.style.color = color;
    }
    if (refs.high) {
      refs.high.textContent = formatNumber(row.high, 2);
      refs.high.style.color = color;
    }
    if (refs.low) {
      refs.low.textContent = formatNumber(row.low, 2);
      refs.low.style.color = color;
    }
    refs.close.textContent = formatNumber(row.close, 2);
    refs.close.style.color = color;
    refs.change.textContent = `${changeAbs >= 0 ? "+" : ""}${formatNumber(changeAbs, 2)} (${change >= 0 ? "+" : ""}${formatPercent(change)})`;
    refs.change.style.color = color;
    refs.vol.textContent = formatBigNumber(row.vol);
    for (let i = 0; i < refs.indicators.length; i++) {
      const value = this.overlayLegendPlots[i]?.values[index];
      refs.indicators[i].textContent = formatNumber(value ?? undefined, 2);
    }
  }

  // ===== Helpers =====

  private configurePane(
    pane: IPaneApi<Time>,
    opts: { leftVisible: boolean; rightVisible: boolean },
    isDark: boolean
  ) {
    const borderColor = isDark ? CHART_PALETTE.dark.scaleBorder : CHART_PALETTE.light.scaleBorder;
    pane.priceScale("left").applyOptions({
      visible: opts.leftVisible,
      borderColor,
      autoScale: true,
      scaleMargins: { top: 0.02, bottom: 0.02 },
    });
    pane.priceScale("right").applyOptions({
      visible: opts.rightVisible,
      borderColor,
      autoScale: true,
      scaleMargins: { top: 0.02, bottom: 0.02 },
      mode: this.options.spec.logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }

  // Applies a visible time range. setVisibleRange pins `to` at the right edge
  // (overriding the timeScale rightOffset), which leaves the last bar
  // half-clipped under the price axis; and lightweight-charts clamps both
  // ends of a time range to the loaded data, so right-side whitespace past
  // the last bar cannot be expressed as a time range at all. When the range
  // reaches the latest bar, extend the logical range by the configured
  // rightOffset so the last day stays fully visible — both on initial render
  // and when a persisted range is re-applied after a pan (without this, a
  // user pan that reveals the last day reverts on the next render).
  private applyTimeRange(from: Time, to: Time) {
    const ts = this.chart!.timeScale();
    ts.setVisibleRange({ from, to });
    const data = this.options.data;
    if (data.length === 0) return;
    const lastTime = toChartTime(data[data.length - 1].tradeDate);
    if (timeToYmd(to) < lastTime) return;
    const logical = ts.getVisibleLogicalRange();
    if (!logical) return;
    const rightOffset = ts.options().rightOffset;
    ts.setVisibleLogicalRange({
      from: logical.from,
      to: data.length - 1 + rightOffset,
    });
  }

  // ===== Resize / theme =====

  // The guard owns the chart's size (library autoSize is off) and re-applies
  // the initial visible range once the container gets its real layout size —
  // the library preserves the visible logical range across later resizes on
  // its own, so re-fitting here every time would reset the user's zoom/pan.
  // It also re-applies the range when it detects a stale frame (see
  // chart-size-guard.ts).
  private setupSizeGuard() {
    if (!this.chart || !this.chartContainerEl) return;
    const containerEl = this.chartContainerEl;
    this.sizeGuard = new ChartSizeGuard(this.chart, containerEl, () => {
      if (this.initialVisibleRange) {
        this.applyTimeRange(this.initialVisibleRange.from, this.initialVisibleRange.to);
      } else {
        this.chart?.timeScale().fitContent();
      }
    }, () => {
      this.updateLegendClearance();
      this.syncPaneLabels();
    });
  }
}

// ===== Shared module-level helpers (also used by the series chart renderer) =====
//
// CHART_PALETTE / buildChartOptions / addTitleWatermark / floorIndex /
// DETACHED_CHART_WIDTH / ChartPngHeader / composePng / toChartTime /
// timeToYmd moved to the obsidian-free chart-png.ts (re-exported above) so
// the CLI/MCP headless renderer can import them without the Obsidian runtime.

// Hides Obsidian's markdown chrome (frontmatter, inline title, …) around a
// card rendered inside a canvas node. No-op outside a canvas.
export function suppressMarkdownChrome(containerEl: HTMLElement) {
  if (!findAncestor(containerEl, "canvas-node-content")) return;

  const preview = findAncestor(containerEl, "markdown-preview-view");
  if (!preview) return;

  const selectors = [
    ".metadata-container",
    ".frontmatter-container",
    ".frontmatter",
    ".mod-header",
    ".markdown-preview-pusher",
    ".inline-title",
    ".properties-heading",
  ];

  for (const selector of selectors) {
    const el = preview.querySelector(selector);
    if (el) {
      el.addClass("fc-el-hidden");
    }
  }
}

function findAncestor(containerEl: HTMLElement, className: string): HTMLElement | null {
  let el: HTMLElement | null = containerEl;
  while (el && !el.classList.contains(className)) {
    el = el.parentElement;
  }
  return el;
}

// Exports the chart canvas as a PNG: prefers copying to the clipboard
// (Notice on success), falls back to a <a download> file save when the
// clipboard API rejects (permissions, non-image MIME support). When `header`
// is given, a text header strip is composited above the chart screenshot;
// `surfaceEl` (the card container) supplies the background color and font so
// the export matches the card's theme.
export async function exportChartPng(
  chart: IChartApi,
  name: string,
  header?: ChartPngHeader,
  surfaceEl?: HTMLElement,
  paneLabels: ChartPaneLabel[] = []
) {
  let canvas = chart.takeScreenshot();
  if (surfaceEl) {
    const composeOptions = composeOptionsFromSurface(surfaceEl);
    drawChartPaneLabels(chart, canvas, paneLabels, composeOptions);
    canvas = composePng(chart, canvas, composeOptions, header);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    new Notice(t("导出图片失败。"));
    return;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    new Notice(t("图表已复制到剪贴板"));
    return;
  } catch {
    // Clipboard unavailable: fall through to a file download.
  }
  const url = URL.createObjectURL(blob);
  const anchor = createEl("a");
  anchor.href = url;
  anchor.download = `${name}-${formatDate(new Date())}.png`;
  anchor.click();
  URL.revokeObjectURL(url);
  new Notice(t("图表已保存为 PNG 图片"));
}

// Reads the theme/background/font inputs composePng needs off the card
// surface element (fc-hermes scope class + computed style).
function composeOptionsFromSurface(surfaceEl: HTMLElement): ComposePngOptions {
  const style = getComputedStyle(surfaceEl);
  return {
    isDark: surfaceEl.classList.contains("fc-hermes"),
    backgroundColor: style.backgroundColor,
    fontFamily: style.fontFamily,
  };
}

// Opaque PNG canvas of the current chart frame for the print snapshot:
// takeScreenshot() forces a synchronous repaint, then the frame is composited
// onto the card surface color so the image stays legible even when the PDF
// omits element backgrounds (the chart's own layout background is
// transparent).
export function renderChartSnapshot(chart: IChartApi, surfaceEl: HTMLElement): HTMLCanvasElement {
  return composePng(chart, chart.takeScreenshot(), composeOptionsFromSurface(surfaceEl), undefined);
}

// Creates or refreshes the card's print-snapshot <img> inside the chart
// container. Hidden by default; @media print swaps it in for the live chart.
export function upsertPrintSnapshot(containerEl: HTMLElement, canvas: HTMLCanvasElement): void {
  let img = containerEl.querySelector<HTMLImageElement>("img.strataboard-print-snapshot");
  if (!img) {
    img = containerEl.createEl("img", { cls: "strataboard-print-snapshot" });
  }
  img.src = canvas.toDataURL("image/png");
}
