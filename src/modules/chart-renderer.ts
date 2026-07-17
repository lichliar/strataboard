import { MarkdownRenderChild } from "obsidian";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  PriceScaleMode,
  type IChartApi,
  type IPaneApi,
  type CandlestickData,
  type LineData,
  type Time,
} from "lightweight-charts";
import type { MarketData, OhlcvRow, ParsedCardSpec, SymbolItem } from "../types";
import { resolveEffectiveTheme, watchThemeChange, onAttached } from "../utils/dom";
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
  loadMarketData?: (tradeDate: string) => Promise<MarketData | null>;
  onRefresh?: () => void;
  onSwitchFreq?: (freq: "D" | "W" | "M") => void;
}

function toChartTime(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
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

export class ChartRenderer extends MarkdownRenderChild {
  private options: ChartRendererOptions;
  private chart: IChartApi | null = null;
  private chartContainerEl: HTMLElement | null = null;
  private themeObserver: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private initialVisibleRange: { from: Time; to: Time } | null = null;
  private isHeaderCollapsed = false;

  // DOM refs
  private headerEl: HTMLElement | null = null;
  private periodTabsEl: HTMLElement | null = null;
  private chartStackEl: HTMLElement | null = null;

  constructor(containerEl: HTMLElement, options: ChartRendererOptions) {
    super(containerEl);
    this.options = options;
    this.isHeaderCollapsed = options.spec.headerCollapsed ?? false;
  }

  onload() {
    this.render();
  }

  onunload() {
    this.cleanup();
  }

  private async render() {
    this.cleanup();
    this.containerEl.empty();
    this.containerEl.addClass("financial-canvas-card");
    onAttached(this.containerEl, () => this.suppressMarkdownChrome());

    const { spec, data } = this.options;

    if (data.length === 0) {
      this.containerEl.createEl("div", {
        cls: "financial-canvas-empty",
        text: `暂无数据：${spec.symbol} 在所选时间范围内没有数据。`,
      });
      return;
    }

    if (spec.showHeader !== false) {
      this.addHeader(data);
    }

    this.addPeriodTabs();
    this.addChartStack();

    const effectiveTheme = resolveEffectiveTheme(this.options.theme);
    const isDark = effectiveTheme === "dark";

    this.chartStackEl!.style.height = `${this.options.height}px`;
    this.chartContainerEl = this.chartStackEl!.createEl("div", {
      cls: "financial-canvas-chart-container",
    });

    this.chart = createChart(this.chartContainerEl, this.buildChartOptions(isDark));

    this.addPriceSeries(0, data, isDark);
    this.configurePane(this.chart.panes()[0], { leftVisible: false, rightVisible: true }, isDark);

    const visibleRange = this.options.spec.visibleRange;
    if (visibleRange) {
      const range = this.resolveVisibleRange(visibleRange, data);
      if (range) {
        this.chart.timeScale().setVisibleRange(range);
        this.initialVisibleRange = range;
      } else {
        this.chart.timeScale().fitContent();
        this.initialVisibleRange = null;
      }
    } else {
      this.chart.timeScale().fitContent();
      this.initialVisibleRange = null;
    }

    this.setupResizeObserver();

    if (this.options.theme === "auto") {
      this.themeObserver = watchThemeChange(() => this.rebuildChart());
    }
  }

  private rebuildChart() {
    this.cleanup();
    this.render();
  }

  private cleanup() {
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.chart?.remove();
    this.chart = null;
    this.chartContainerEl = null;
    this.initialVisibleRange = null;
    this.headerEl = null;
    this.periodTabsEl = null;
    this.chartStackEl = null;
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

    this.headerEl = this.containerEl.createEl("div", { cls: "financial-canvas-header" });

    const topRow = this.headerEl.createEl("div", { cls: "financial-canvas-header-top" });

    const titleWrap = topRow.createEl("div", { cls: "financial-canvas-header-title-wrap" });
    const title = titleWrap.createEl("div", { cls: "financial-canvas-header-title" });
    title.createEl("span", { cls: "financial-canvas-header-name", text: symbol?.name ?? this.options.spec.symbol });
    if (symbol?.enname) {
      title.createEl("span", { cls: "financial-canvas-header-enname", text: ` · ${symbol.enname}` });
    }
    titleWrap.createEl("div", { cls: "financial-canvas-header-code", text: symbol?.tsCode ?? this.options.spec.symbol });

    const actions = topRow.createEl("div", { cls: "financial-canvas-header-actions" });
    const refreshBtn = actions.createEl("button", { cls: "financial-canvas-header-refresh", text: "🔄" });
    refreshBtn.addEventListener("click", () => this.options.onRefresh?.());

    const collapseBtn = actions.createEl("button", {
      cls: "financial-canvas-header-collapse",
      text: this.isHeaderCollapsed ? "展开" : "折叠",
      attr: { "aria-label": this.isHeaderCollapsed ? "展开详细信息" : "折叠详细信息" },
    });

    const quoteRow = this.headerEl.createEl("div", { cls: "financial-canvas-header-quote" });
    quoteRow.createEl("span", {
      cls: "financial-canvas-header-price",
      text: formatNumber(latest.close, 2),
      attr: { style: `color: ${color}` },
    });
    quoteRow.createEl("span", {
      cls: "financial-canvas-header-change",
      text: `${change >= 0 ? "+" : ""}${formatNumber(change, 2)}`,
      attr: { style: `color: ${color}` },
    });
    quoteRow.createEl("span", {
      cls: "financial-canvas-header-change-pct",
      text: `${change >= 0 ? "+" : ""}${formatPercent(changePct)}`,
      attr: { style: `color: ${color}` },
    });

    // daily_basic only covers stocks; funds and indexes would show a row of
    // "--", so skip the market data row (and its collapse toggle) for them.
    const showMarketData = this.options.spec.showMarketData !== false && this.options.spec.assetType === "stock";
    let marketRow: HTMLElement | null = null;

    if (showMarketData) {
      marketRow = this.headerEl.createEl("div", { cls: "financial-canvas-header-market" });
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
        const wrap = marketRow.createEl("span", { cls: "financial-canvas-header-market-item" });
        wrap.createEl("span", { cls: "financial-canvas-header-market-label", text: `${item.label} ` });
        wrap.createEl("span", { cls: "financial-canvas-header-market-value", text: item.value });
      }

      marketRow.style.display = this.isHeaderCollapsed ? "none" : "flex";
    }

    collapseBtn.addEventListener("click", () => {
      this.isHeaderCollapsed = !this.isHeaderCollapsed;
      if (marketRow) {
        marketRow.style.display = this.isHeaderCollapsed ? "none" : "flex";
      }
      collapseBtn.textContent = this.isHeaderCollapsed ? "展开" : "折叠";
      collapseBtn.setAttribute("aria-label", this.isHeaderCollapsed ? "展开详细信息" : "折叠详细信息");
    });

    if (!marketRow) {
      collapseBtn.style.display = "none";
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

  // ===== Period tabs =====

  private addPeriodTabs() {
    this.periodTabsEl = this.containerEl.createEl("div", { cls: "financial-canvas-period-tabs" });
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
  }

  // ===== Chart stack =====

  private addChartStack() {
    this.chartStackEl = this.containerEl.createEl("div", { cls: "financial-canvas-chart-stack" });
  }

  // ===== Series creation =====

  private addPriceSeries(paneIndex: number, data: OhlcvRow[], isDark: boolean) {
    if (this.options.chartType === "line") {
      const lineData: LineData[] = data.map((row) => ({
        time: toChartTime(row.tradeDate) as Time,
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
    } else {
      const candleData: CandlestickData[] = data.map((row) => ({
        time: toChartTime(row.tradeDate) as Time,
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
    }
  }

  // ===== Helpers =====

  private configurePane(
    pane: IPaneApi<Time>,
    opts: { leftVisible: boolean; rightVisible: boolean },
    isDark: boolean
  ) {
    const borderColor = isDark ? "#4b5563" : "#d1d5db";
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

  private resolveVisibleRange(
    preset: import("../types").VisibleRangePreset,
    data: OhlcvRow[]
  ): { from: Time; to: Time } | null {
    if (data.length === 0) return null;

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

  // ===== Chart options =====

  private buildChartOptions(isDark: boolean) {
    return {
      layout: {
        background: { color: "transparent" },
        textColor: isDark ? "#d1d5db" : "#374151",
      },
      grid: {
        vertLines: { color: isDark ? "#374151" : "#e5e7eb" },
        horzLines: { color: isDark ? "#374151" : "#e5e7eb" },
      },
      crosshair: {
        mode: 1,
      },
      rightPriceScale: {
        visible: true,
        borderColor: isDark ? "#4b5563" : "#d1d5db",
        autoScale: true,
        scaleMargins: { top: 0.02, bottom: 0.02 },
      },
      leftPriceScale: {
        visible: false,
        borderColor: isDark ? "#4b5563" : "#d1d5db",
        autoScale: true,
        scaleMargins: { top: 0.02, bottom: 0.02 },
      },
      timeScale: {
        borderColor: isDark ? "#4b5563" : "#d1d5db",
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

  // ===== Resize / theme =====

  private setupResizeObserver() {
    if (!this.chartContainerEl) return;
    this.resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (this.initialVisibleRange) {
          this.chart?.timeScale().setVisibleRange(this.initialVisibleRange);
        } else {
          this.chart?.timeScale().fitContent();
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

  private suppressMarkdownChrome() {
    if (!this.findCanvasContentContainer()) return;

    const preview = this.findMarkdownPreviewView();
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
      const el = preview.querySelector(selector) as HTMLElement | null;
      if (el) {
        el.style.display = "none";
      }
    }
  }

  private findCanvasContentContainer(): HTMLElement | null {
    let el: HTMLElement | null = this.containerEl;
    while (el) {
      if (el.classList.contains("canvas-node-content")) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  private findMarkdownPreviewView(): HTMLElement | null {
    let el: HTMLElement | null = this.containerEl;
    while (el && !el.classList.contains("markdown-preview-view")) {
      el = el.parentElement;
    }
    return el;
  }
}
