import { MarkdownRenderChild, setIcon, setTooltip } from "obsidian";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  type BusinessDay,
  type IChartApi,
  type IPaneApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type Time,
} from "lightweight-charts";
import type { MarketData, OhlcvRow, ParsedCardSpec, SymbolItem } from "../types";
import { resolveEffectiveTheme, onAttached, toLayoutPoint, installZoomEventFix } from "../utils/dom";
import { parseDateYmd, formatDate } from "../utils/date";

interface ChartRendererOptions {
  spec: ParsedCardSpec;
  data: OhlcvRow[];
  theme: "auto" | "dark" | "light";
  chartType: "candlestick" | "line";
  riseColor: string;
  fallColor: string;
  height: number;
  symbolInfo?: SymbolItem;
  // 宽度自适应 off (canvas only): freeze the chart width at first layout so
  // the chart stops following canvas node width changes.
  freezeWidth?: boolean;
  loadMarketData?: (tradeDate: string) => Promise<MarketData | null>;
  onRefresh?: () => void;
  onSwitchFreq?: (freq: "D" | "W" | "M") => void;
  // Footer tool buttons (wireframe #screen-card): edit opens the card's edit
  // modal; delete removes the canvas node (canvas-only, hidden elsewhere).
  onEdit?: () => void;
  onDelete?: () => void;
}

function toChartTime(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// Converts a chart Time (string or BusinessDay) to YYYY-MM-DD.
function timeToYmd(time: Time): string {
  if (typeof time === "string") return time;
  const day = time as BusinessDay;
  return `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
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

// MA defaults and overlay palette; the palette cycles when a card asks for
// more periods than there are colors. Colors stay readable on both themes.
// Exported for the unified edit modal's MA preview chips.
const DEFAULT_MA_PERIODS = [5, 10, 20, 60];
export const MA_COLORS = ["#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#f97316", "#0ea5e9", "#84cc16", "#e879f9"];

// Per-MA computed series, kept so the crosshair legend can show the hovered
// bar's MA values (and color the labels to match the lines).
interface MaSeriesData {
  period: number;
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
  ma: { period: number; valueEl: HTMLElement }[];
}

export class ChartRenderer extends MarkdownRenderChild {
  private options: ChartRendererOptions;
  private chart: IChartApi | null = null;
  private chartContainerEl: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private uninstallZoomFix: (() => void) | null = null;
  private initialVisibleRange: { from: Time; to: Time } | null = null;

  // DOM refs
  private headerEl: HTMLElement | null = null;
  private periodTabsEl: HTMLElement | null = null;
  private chartStackEl: HTMLElement | null = null;
  private priceSeries: ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null = null;
  private legendRefs: LegendRefs | null = null;
  private maSeriesData: MaSeriesData[] = [];
  private dataIndexByTime = new Map<string, number>();

  constructor(containerEl: HTMLElement, options: ChartRendererOptions) {
    super(containerEl);
    this.options = options;
  }

  onload() {
    void this.render();
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
      this.containerEl.createEl("div", {
        cls: "strataboard-empty",
        text: `暂无数据：${spec.symbol} 在所选时间范围内没有数据。`,
      });
      return;
    }

    if (spec.showHeader !== false) {
      void this.addHeader(data);
    }

    this.addChartStack();

    const effectiveTheme = resolveEffectiveTheme(this.options.theme);
    const isDark = effectiveTheme === "dark";
    this.applyThemeScope(isDark);

    this.chartStackEl!.style.height = `${this.options.height}px`;
    this.chartContainerEl = this.chartStackEl!.createEl("div", {
      cls: "strataboard-chart-container",
    });

    this.chart = createChart(this.chartContainerEl, buildChartOptions(isDark));
    // Zoom-correct mouse coordinates before the library sees them (Obsidian
    // canvas scales node content with a CSS transform).
    this.uninstallZoomFix = installZoomEventFix(this.chartContainerEl);

    this.priceSeries = this.addPriceSeries(0, data, isDark);
    this.addMovingAverages(0, data);
    // 成交量 pane 默认开（卡片级 显示成交量 可关）。
    if (spec.showVolume !== false) {
      this.addVolumeSeries(1, data);
    }
    this.configurePane(this.chart.panes()[0], { leftVisible: false, rightVisible: true }, isDark);
    const volumePane = this.chart.panes()[1];
    if (volumePane) {
      this.configureVolumePane(volumePane);
    }
    this.applyPaneRatios();
    this.addLatestPriceLine(data);
    this.addLegend(data);

    if (spec.visibleStart && spec.visibleEnd) {
      // Persisted chart-mode zoom/pan range takes precedence over the 可见范围
      // preset. It can fall outside the loaded data after a range change, so
      // fall back to the preset/fit path on failure.
      const persisted = { from: spec.visibleStart as Time, to: spec.visibleEnd as Time };
      try {
        this.applyTimeRange(persisted.from, persisted.to);
        this.initialVisibleRange = persisted;
      } catch {
        this.applyVisibleRangePreset(data);
      }
    } else {
      this.applyVisibleRangePreset(data);
    }

    this.setupResizeObserver();

    // Footer (wireframe #screen-card): freq tabs + SVG tool buttons.
    this.addFooter();
  }

  // The card surface carries the hermes dark palette via the fc-hermes scope
  // class (styles.css); explicit per-card light theme opts out.
  private applyThemeScope(isDark: boolean) {
    this.containerEl.toggleClass("fc-hermes", isDark);
  }

  private cleanup() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
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
    this.maSeriesData = [];
    this.dataIndexByTime.clear();
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

    this.headerEl = this.containerEl.createEl("div", { cls: "strataboard-header" });

    const topRow = this.headerEl.createEl("div", { cls: "strataboard-header-top" });

    const titleWrap = topRow.createEl("div", { cls: "strataboard-header-title-wrap" });
    const title = titleWrap.createEl("div", { cls: "strataboard-header-title" });
    title.createEl("span", { cls: "strataboard-header-name", text: symbol?.name ?? this.options.spec.symbol });
    if (symbol?.enname) {
      title.createEl("span", { cls: "strataboard-header-enname", text: ` · ${symbol.enname}` });
    }
    titleWrap.createEl("div", { cls: "strataboard-header-code", text: symbol?.tsCode ?? this.options.spec.symbol });

    const quoteRow = this.headerEl.createEl("div", { cls: "strataboard-header-quote" });
    quoteRow.createEl("span", {
      cls: "strataboard-header-price",
      text: formatNumber(latest.close, 2),
      attr: { style: `color: ${color}` },
    });
    quoteRow.createEl("span", {
      cls: "strataboard-header-change",
      text: `${change >= 0 ? "+" : ""}${formatNumber(change, 2)}`,
      attr: { style: `color: ${color}` },
    });
    quoteRow.createEl("span", {
      cls: "strataboard-header-change-pct",
      text: `${change >= 0 ? "+" : ""}${formatPercent(changePct)}`,
      attr: { style: `color: ${color}` },
    });

    // daily_basic only covers stocks; funds and indexes would show a row of
    // "--", so the market data row is only offered for them. Visibility is
    // controlled by the card's 显示市场数据 setting (double-click editor).
    const showMarketData = this.options.spec.showMarketData !== false && this.options.spec.assetType === "stock";

    if (showMarketData) {
      const marketRow = this.headerEl.createEl("div", { cls: "strataboard-header-market" });
      const marketData = await this.loadMarketData(latest.tradeDate);

      const marketItems = [
        { label: "市值", value: marketData?.totalMv != null ? formatBigNumber(marketData.totalMv) : "--" },
        { label: "流通", value: marketData?.circMv != null ? formatBigNumber(marketData.circMv) : "--" },
        { label: "市盈", value: marketData?.pe != null ? formatNumber(marketData.pe, 2) : "--" },
        { label: "量比", value: marketData?.volumeRatio != null ? formatNumber(marketData.volumeRatio, 2) : "--" },
        { label: "换", value: marketData?.turnoverRate != null ? formatPercent(marketData.turnoverRate) : "--" },
        { label: "额", value: formatBigNumber(latest.amount * 1000) },
      ];

      for (const item of marketItems) {
        const wrap = marketRow.createEl("span", { cls: "strataboard-header-market-item" });
        wrap.createEl("span", { cls: "strataboard-header-market-label", text: `${item.label} ` });
        wrap.createEl("span", { cls: "strataboard-header-market-value", text: item.value });
      }
    }
  }

  private async loadMarketData(tradeDate: string): Promise<MarketData | null> {
    if (!this.options.loadMarketData) return null;
    try {
      return await this.options.loadMarketData(tradeDate);
    } catch {
      return null;
    }
  }

  // ===== Footer: freq tabs + SVG tool buttons (wireframe #screen-card) =====

  private addFooter() {
    const footerEl = this.containerEl.createEl("div", { cls: "strataboard-card-footer" });
    this.periodTabsEl = footerEl.createEl("div", { cls: "strataboard-period-tabs" });
    const freqs: { id: "D" | "W" | "M"; label: string }[] = [
      { id: "D", label: "日K" },
      { id: "W", label: "周K" },
      { id: "M", label: "月K" },
    ];

    for (const f of freqs) {
      const btn = this.periodTabsEl.createEl("button", {
        text: f.label,
        cls: f.id === this.options.spec.freq ? "is-active" : "",
      });
      btn.addEventListener("click", () => {
        if (f.id !== this.options.spec.freq) {
          this.options.onSwitchFreq?.(f.id);
        }
      });
    }

    const tools = footerEl.createEl("div", { cls: "strataboard-card-tools" });
    const addTool = (icon: string, tooltip: string, onClick?: () => void) => {
      const btn = tools.createEl("button", { cls: "strataboard-tool-btn" });
      setIcon(btn, icon);
      setTooltip(btn, tooltip);
      if (onClick) {
        btn.addEventListener("click", onClick);
      }
      return btn;
    };
    addTool("pencil", "编辑参数", () => this.options.onEdit?.());
    addTool("refresh-cw", "刷新数据", () => this.options.onRefresh?.());
    // 删除卡片 removes the canvas node (the card file stays in the library),
    // so it only makes sense inside a canvas — decided once attached.
    const deleteBtn = addTool("trash-2", "删除卡片", () => this.options.onDelete?.());
    onAttached(this.containerEl, () => {
      deleteBtn.toggleClass("fc-hidden", !this.containerEl.closest(".canvas-node"));
    });
  }

  // ===== Chart stack =====

  private addChartStack() {
    this.chartStackEl = this.containerEl.createEl("div", { cls: "strataboard-chart-stack" });
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

  private addMovingAverages(paneIndex: number, data: OhlcvRow[]) {
    const periods = this.options.spec.maPeriods ?? DEFAULT_MA_PERIODS;
    this.maSeriesData = [];
    periods.forEach((period, i) => {
      const color = MA_COLORS[i % MA_COLORS.length];
      const maData: LineData[] = [];
      const values: (number | null)[] = [];
      let sum = 0;
      for (let j = 0; j < data.length; j++) {
        sum += data[j].close;
        if (j >= period) {
          sum -= data[j - period].close;
        }
        if (j >= period - 1) {
          const value = sum / period;
          maData.push({
            time: toChartTime(data[j].tradeDate),
            value,
          });
          values.push(value);
        } else {
          values.push(null);
        }
      }
      this.maSeriesData.push({ period, color, values });
      const series = this.chart!.addSeries(
        LineSeries,
        {
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        },
        paneIndex
      );
      series.setData(maData);
    });
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

  private configureVolumePane(pane: IPaneApi<Time>) {
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

  private applyPaneRatios() {
    const ratios = this.options.spec.paneRatios;
    const panes = this.chart!.panes();
    panes[0].setStretchFactor(ratios?.[0] ?? 3);
    panes[1]?.setStretchFactor(ratios?.[1] ?? 1);
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

  // ===== Crosshair legend =====

  private addLegend(data: OhlcvRow[]) {
    const legendEl = this.chartContainerEl!.createEl("div", {
      cls: "strataboard-chart-legend",
    });
    const isCandle = this.options.chartType !== "line";

    const dateEl = legendEl.createEl("span", { cls: "strataboard-chart-legend-date" });
    const mkItem = (label: string, labelColor?: string): HTMLElement => {
      const wrap = legendEl.createEl("span", { cls: "strataboard-chart-legend-item" });
      const labelEl = wrap.createEl("span", { cls: "strataboard-chart-legend-label", text: label });
      if (labelColor) labelEl.style.color = labelColor;
      return wrap.createEl("span", { cls: "strataboard-chart-legend-value" });
    };

    this.legendRefs = {
      date: dateEl,
      open: isCandle ? mkItem("开") : null,
      high: isCandle ? mkItem("高") : null,
      low: isCandle ? mkItem("低") : null,
      close: mkItem("收"),
      change: mkItem("涨跌"),
      vol: mkItem("量"),
      // MA labels are colored to match their lines, so each line is
      // identifiable from the legend.
      ma: this.maSeriesData.map(({ period, color }) => ({
        period,
        valueEl: mkItem(`MA${period}`, color),
      })),
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
    for (let i = 0; i < refs.ma.length; i++) {
      const value = this.maSeriesData[i]?.values[index];
      refs.ma[i].valueEl.textContent = formatNumber(value ?? undefined, 2);
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

  // Applies the 可见范围 preset (or fitContent when unset/unresolvable) and
  // records the applied range for later re-application after resizes.
  private applyVisibleRangePreset(data: OhlcvRow[]) {
    const visibleRange = this.options.spec.visibleRange;
    if (visibleRange) {
      const range = this.resolveVisibleRange(visibleRange, data);
      if (range) {
        this.applyTimeRange(range.from, range.to);
        this.initialVisibleRange = range;
        return;
      }
    }
    this.chart!.timeScale().fitContent();
    this.initialVisibleRange = null;
  }

  private resolveVisibleRange(
    preset: import("../types").VisibleRangePreset,
    data: OhlcvRow[]
  ): { from: Time; to: Time } | null {    if (data.length === 0) return null;

    const toYmd = data[data.length - 1].tradeDate;
    const toDate = parseDateYmd(toYmd);
    let fromDate: Date;

    switch (preset) {
      case "1m":
        fromDate = new Date(toDate.getFullYear(), toDate.getMonth() - 1, toDate.getDate());
        break;
      case "3m":
        fromDate = new Date(toDate.getFullYear(), toDate.getMonth() - 3, toDate.getDate());
        break;
      case "6m":
        fromDate = new Date(toDate.getFullYear(), toDate.getMonth() - 6, toDate.getDate());
        break;
      case "1y":
        fromDate = new Date(toDate.getFullYear() - 1, toDate.getMonth(), toDate.getDate());
        break;
      case "ytd":
        fromDate = new Date(toDate.getFullYear(), 0, 1);
        break;
      case "max":
        fromDate = parseDateYmd(data[0].tradeDate);
        break;
      default:
        return null;
    }

    const firstYmd = data[0].tradeDate;
    const fromYmd = formatDate(fromDate);
    const startYmd = fromYmd < firstYmd ? firstYmd : fromYmd;

    return {
      from: toChartTime(startYmd) as Time,
      to: toChartTime(toYmd) as Time,
    };
  }

  // ===== Resize / theme =====

  private setupResizeObserver() {
    if (!this.chartContainerEl) return;
    this.resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        if (this.initialVisibleRange) {
          this.applyTimeRange(this.initialVisibleRange.from, this.initialVisibleRange.to);
        } else {
          this.chart?.timeScale().fitContent();
        }
        // 宽度自适应 off: pin the stack to the width it first laid out with,
        // so later canvas node width changes no longer reach the chart
        // (autoSize tracks the stack, not the node). Canvas-only — in notes
        // the chart keeps following the container (e.g. window resizes).
        if (this.options.freezeWidth && this.chartStackEl && findAncestor(this.containerEl, "canvas-node")) {
          this.chartStackEl.style.width = `${this.chartContainerEl!.clientWidth}px`;
        }
        // Re-apply the initial range only once, right after the container
        // gets its real size. lightweight-charts preserves the visible
        // logical range across later resizes on its own; re-fitting here
        // every time would reset the user's zoom/pan.
        this.resizeObserver?.disconnect();
      });
    });
    this.resizeObserver.observe(this.chartContainerEl);
  }
}

// ===== Shared module-level helpers (also used by the series chart renderer) =====

// Hermes chart palette. The dark values mirror the .fc-hermes scope in
// styles.css — canvas drawing can't read CSS variables, so the two must be
// kept in sync. The light variant only applies to cards explicitly set to
// 浅色主题 in the card editor.
export const CHART_PALETTE = {
  dark: {
    text: "#d7dbe0",
    muted: "#868e99",
    grid: "rgba(140, 150, 165, 0.07)",
    scaleBorder: "#272e38",
    crosshairLine: "rgba(245, 158, 11, 0.45)",
    crosshairLabel: "#f59e0b",
  },
  light: {
    text: "#374151",
    muted: "#6b7280",
    grid: "rgba(60, 70, 85, 0.08)",
    scaleBorder: "#d1d5db",
    crosshairLine: "rgba(180, 83, 9, 0.4)",
    crosshairLabel: "#d97706",
  },
};

// Base chart options shared by every lightweight-charts card in the plugin.
export function buildChartOptions(isDark: boolean) {
  const p = isDark ? CHART_PALETTE.dark : CHART_PALETTE.light;
  return {
    layout: {
      background: { color: "transparent" },
      textColor: p.text,
    },
    grid: {
      vertLines: { color: p.grid, style: LineStyle.Dashed },
      horzLines: { color: p.grid, style: LineStyle.Dashed },
    },
    crosshair: {
      mode: 1,
      // TradingView-style: amber crosshair lines + solid amber axis labels.
      vertLine: { color: p.crosshairLine, labelBackgroundColor: p.crosshairLabel },
      horzLine: { color: p.crosshairLine, labelBackgroundColor: p.crosshairLabel },
    },
    rightPriceScale: {
      visible: true,
      borderColor: p.scaleBorder,
      autoScale: true,
      scaleMargins: { top: 0.02, bottom: 0.02 },
    },
    leftPriceScale: {
      visible: false,
      borderColor: p.scaleBorder,
      autoScale: true,
      scaleMargins: { top: 0.02, bottom: 0.02 },
    },
    timeScale: {
      borderColor: p.scaleBorder,
      timeVisible: false,
      visible: true,
      borderVisible: true,
      rightOffset: 10,
      minBarSpacing: 4,
    },
    localization: {
      locale: "zh-CN",
      dateFormat: "yyyy-MM-dd",
    },
    handleScale: {
      axisPressedMouseMove: true,
    },
    autoSize: true,
  };
}

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
