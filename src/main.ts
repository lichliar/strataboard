import {
  ItemView,
  MarkdownRenderChild,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  setIcon,
  setTooltip,
  type Editor,
  type WorkspaceLeaf,
} from "obsidian";
import { DEFAULT_SETTINGS, StrataBoardSettingTab, type StrataBoardSettings } from "./settings";
import { DEFAULT_CARD_HEIGHT, DEFAULT_CARD_BLEED, parseCardSpec, stringifyCardSpec, type ParseResult } from "./modules/card-spec";
import { DataAdapter } from "./modules/data-adapter";
import { SymbolIndex } from "./modules/symbol-index";
import { SqliteCache } from "./modules/sqlite-cache";
import { CardService, codeBlockTypeFor } from "./modules/card-service";
import { ChartRenderer } from "./modules/chart-renderer";
import { CalendarRenderer } from "./modules/calendar-renderer";
import { WidgetRenderer } from "./modules/widget-renderer";
import { parseWidgetInput } from "./modules/widget-parser";
import { CanvasToolbar } from "./modules/toolbar";
import { ChartCardCodeBlockRenderer, applyCanvasDisplayOptions } from "./modules/chart-card-base";
import { SeriesAdapter } from "./modules/series-adapter";
import { formatExpressionTitle } from "./modules/expression";
import { SeriesChartRenderer, type SeriesChartLine } from "./modules/series-chart-renderer";
import {
  DEFAULT_OVERLAY_SPEC,
  DEFAULT_SPREAD_SPEC,
  parseFredCardSpec,
  parseMacroCardSpec,
  parseOverlaySpec,
  parseSpreadSpec,
  stringifyFredCardSpec,
  stringifyMacroCardSpec,
  stringifyOverlaySpec,
  stringifySpreadSpec,
  type SeriesSpecParseResult,
} from "./modules/series-spec";
import { SymbolSearchModal } from "./ui/symbol-search-modal";
import { FredSearchModal } from "./ui/fred-search-modal";
import { MacroSearchModal } from "./ui/macro-search-modal";
import { RemoteQuoteSearchModal } from "./ui/remote-quote-modal";
import { SourcePickerModal } from "./ui/source-picker-modal";
import { WidgetInputModal } from "./ui/widget-input-modal";
import { UnifiedCardEditModal } from "./ui/unified-card-edit-modal";
import { CalendarEditModal } from "./ui/calendar-edit-modal";
import { OverlayEditModal } from "./ui/overlay-edit-modal";
import { SpreadEditModal } from "./ui/spread-edit-modal";
import { ConfirmModal } from "./ui/confirm-modal";
import { findMacroSeriesDef, ASSET_TYPE_LABELS, fredTransformIsPercent, fredTransformLabel } from "./types";
import type { AssetType, FredCardSpec, FredSeriesInfo, MacroCardSpec, MacroSeriesDef, OverlaySpec, ParsedCardSpec, SeriesPeriod, SeriesPoint, SeriesRef, SpreadSpec, SymbolItem } from "./types";
import { resolveDateRange, formatIsoDate, parseDateYmd } from "./utils/date";
import { onAttached } from "./utils/dom";

class TushareCodeBlockRenderer extends MarkdownRenderChild {
  private plugin: StrataBoardPlugin;
  private source: string;
  private sourcePath: string;
  private result: ParseResult;
  private chartRenderer: ChartRenderer | null = null;
  private chartActive = false;
  // Baseline visible range captured on first chart-mode entry; used to tell
  // whether the user actually zoomed/panned during the session.
  private appliedRange: { from: string; to: string } | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.source = source;
    this.sourcePath = sourcePath;
    this.result = parseCardSpec(source, { height: DEFAULT_CARD_HEIGHT });
  }

  onload() {
    void this.render();

    // Canvas interaction model (three tiers):
    //  - single click/drag on the card: selects and moves the canvas node
    //    (the node's content blocker keeps pointer events at canvas level);
    //  - double-click: activates chart mode — the fc-chart-active class on
    //    the node hides the blocker (styles.css), so hover drives the
    //    crosshair and dragging pans the K-line;
    //  - double-click while active: opens the settings modal.
    // Outside a canvas (regular md pages) there is no blocker and the chart
    // is always live, so double-click opens the modal directly.
    //
    // The listener sits on DOCUMENT (capture), not on the card: while
    // inactive the card is covered by Obsidian's content blocker, which is a
    // SIBLING of the node content rather than an ancestor of the card, so
    // double-clicks on the covered card never bubble through the card's
    // container — a card-level listener would never see them and Obsidian's
    // own handler would open the node's source edit mode instead. preventDefault
    // here also suppresses that native edit mode; source is edited only in
    // the underlying md file.
    this.registerDomEvent(
      document,
      "dblclick",
      (event) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        const inCard = this.containerEl.contains(target);
        const nodeEl = this.findCanvasNodeEl();
        const onOwnBlocker =
          nodeEl != null &&
          nodeEl.contains(target) &&
          target.classList.contains("canvas-node-content-blocker");
        if (!inCard && !onOwnBlocker) return;
        // Let header buttons (refresh / period tabs) keep their own behavior.
        if (inCard && target.closest("button")) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.chartActive || !nodeEl) {
          this.openEditModal();
        } else {
          this.setChartActive(true);
        }
      },
      { capture: true }
    );

    // In chart mode keep the canvas' node-drag handler from starting a drag:
    // Obsidian initiates node selection/dragging from POINTERDOWN listeners
    // on ancestor elements (verified against app.asar), so stop pointerdown
    // from bubbling past the card. Do NOT stop/preventDefault mousedown —
    // lightweight-charts pans via mousedown on its own (descendant) elements,
    // and canceling pointerdown would also suppress the compatibility mouse
    // events the chart needs. (While inactive the blocker intercepts events
    // before they reach the card at all.)
    this.registerDomEvent(
      this.containerEl,
      "pointerdown",
      (event) => {
        if (this.chartActive) event.stopPropagation();
      },
      { capture: true }
    );

    // In chart mode, drive the time-axis wheel zoom manually from a
    // window-capture listener: Obsidian's canvas intercepts wheel at window
    // level (same pattern as the pointerdown exit, see below), so the
    // chart's own wheel handler never sees the event. stopPropagation +
    // preventDefault keep BOTH the canvas zoom and the library's wheel
    // handler from acting — no double zoom. Outside chart mode the event
    // flows untouched.
    this.registerDomEvent(
      window,
      "wheel",
      (event) => {
        if (!this.chartActive || !this.containerEl.contains(event.target as Node)) return;
        event.stopPropagation();
        event.preventDefault();
        this.chartRenderer?.applyTimeAxisWheelZoom(event.deltaY, event.clientX);
      },
      { capture: true, passive: false }
    );

    // Leave chart mode on outside click or Escape.
    //
    // The outside-click listener sits on WINDOW (capture), not on document:
    // Obsidian's canvas initiates drag/pan from window-level capture
    // pointerdown listeners and stops propagation there, so a document-level
    // listener never sees the event and chart mode never exited (activation
    // via dblclick was unaffected because that event flows to document).
    this.registerDomEvent(
      window,
      "pointerdown",
      (event) => {
        if (this.containerEl.contains(event.target as Node)) return;
        if (this.chartActive) {
          this.setChartActive(false, true);
        } else {
          // Sweep a stale fc-chart-active left on the node by a destroyed
          // instance (a re-render replaces the renderer but the canvas node
          // keeps its classes).
          this.containerEl.removeClass("fc-chart-active");
          this.findCanvasNodeEl()?.removeClass("fc-chart-active");
        }
      },
      { capture: true }
    );
    this.registerDomEvent(document, "keydown", (event) => {
      if (this.chartActive && event.key === "Escape") {
        this.setChartActive(false, true);
      }
    });
  }

  onunload() {
    // Not user-initiated: never persist during unload.
    this.setChartActive(false);
  }

  private setChartActive(active: boolean, userInitiated = false) {
    const wasActive = this.chartActive;
    this.chartActive = active;
    this.containerEl.toggleClass("fc-chart-active", active);
    this.findCanvasNodeEl()?.toggleClass("fc-chart-active", active);
    if (active && !wasActive) {
      // Capture the settled baseline lazily on first entry: by then the
      // chart has laid out and applied its initial range (persisted custom
      // dates, preset, or fitContent).
      this.appliedRange ??= this.chartRenderer?.getVisibleRangeYmd() ?? null;
    } else if (!active && wasActive && userInitiated) {
      this.persistVisibleRangeOnExit();
    }
  }

  // Persists a user-changed visible range into the card spec when chart mode
  // exits — exactly one write, only when the range actually changed during
  // the session. The write re-renders the block; the fresh instance is
  // inactive, so no further writes happen (no loop).
  private persistVisibleRangeOnExit() {
    if (!this.result.ok || !this.chartRenderer) return;
    const current = this.chartRenderer.getVisibleRangeYmd();
    if (!current) return;
    const baseline = this.appliedRange ?? this.chartRenderer.getInitialVisibleRangeYmd();
    if (!baseline) return;
    if (current.from === baseline.from && current.to === baseline.to) return;
    const spec = this.result.spec;
    if (current.from === spec.visibleStart && current.to === spec.visibleEnd) return;
    void this.saveSpec({ ...spec, visibleStart: current.from, visibleEnd: current.to });
  }

  private findCanvasNodeEl(): HTMLElement | null {
    let el: HTMLElement | null = this.containerEl;
    while (el && !el.classList.contains("canvas-node")) {
      el = el.parentElement;
    }
    return el;
  }

  // 删除卡片 (footer trash button): removes the NODE from the canvas after
  // confirmation; the underlying card file stays in the card library.
  private deleteFromCanvas() {
    const nodeEl = this.findCanvasNodeEl();
    if (!nodeEl) return;
    new ConfirmModal(this.plugin.app, "从画布中移除该卡片？卡片文件仍保留在卡片库中。", () => {
      const view = this.plugin.app.workspace.getActiveViewOfType(ItemView) as any;
      const canvas = view?.canvas;
      if (!canvas?.nodes) {
        new Notice("当前没有激活的 Canvas 视图。");
        return;
      }
      let target: any = null;
      for (const node of canvas.nodes.values()) {
        const el = node.nodeEl ?? node.el;
        if (el === nodeEl || el?.contains?.(nodeEl)) {
          target = node;
          break;
        }
      }
      if (!target) {
        new Notice("找不到对应的画布节点。");
        return;
      }
      if (typeof canvas.removeNode === "function") {
        canvas.removeNode(target);
      } else if (typeof target.remove === "function") {
        target.remove();
      } else {
        new Notice("当前 Obsidian 版本不支持从画布移除节点。");
        return;
      }
      canvas.requestSave?.();
      new Notice("已从画布移除卡片（文件保留在卡片库中）。");
    }).open();
  }

  private async render() {
    this.containerEl.empty();
    this.containerEl.addClass("strataboard-card");
    this.appliedRange = null;
    // Obsidian's canvas file node enters its embedded edit mode when a click
    // lands on node content — UNLESS the target is inside an element marked
    // .interactive-child (the escape hatch its own bases embed uses; verified
    // against app.asar). Mark the card so clicks in chart mode can never
    // switch the node to source view; source is edited only in the md file.
    this.containerEl.addClass("interactive-child");
    onAttached(this.containerEl, () => {
      this.tagParentPreviewAsCard();
      // Canvas 显示逻辑 (统合编辑弹窗): bleed padding / fixed height, applied
      // once attached so the canvas-node ancestor lookup works. No-op outside
      // a canvas; widthAuto === false is handled by the chart's freezeWidth.
      if (this.result.ok) {
        const spec = this.result.spec;
        applyCanvasDisplayOptions(this.containerEl, {
          widthAuto: spec.widthAuto ?? true,
          heightAuto: spec.heightAuto ?? true,
          bleed: spec.bleed ?? DEFAULT_CARD_BLEED,
        });
      }
    });

    if (!this.result.ok) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error.message}`,
        cls: "strataboard-error",
      });
      return;
    }

    const spec = this.result.spec;

    // Placeholder while OHLCV data is fetched; ChartRenderer (or the error
    // path below) empties the container when done.
    this.containerEl.createEl("div", {
      cls: "strataboard-empty",
      text: `正在加载数据：${spec.symbol}…`,
    });

    try {
      const data = await this.loadData(spec);
      const symbolInfo = await this.plugin.symbolIndex.lookup(spec.symbol, spec.assetType);
      this.chartRenderer = new ChartRenderer(this.containerEl, {
        spec,
        data,
        theme: spec.theme ?? "auto",
        chartType: spec.chartType ?? "candlestick",
        riseColor: spec.riseColor ?? "#ef4444",
        fallColor: spec.fallColor ?? "#22c55e",
        symbolInfo,
        height: spec.height ?? DEFAULT_CARD_HEIGHT,
        freezeWidth: spec.widthAuto === false,
        loadMarketData: (tradeDate) => this.loadMarketData(spec, tradeDate),
        onRefresh: () => void this.refresh(),
        onSwitchFreq: (freq) => void this.switchFrequency(freq),
        onEdit: () => this.openEditModal(),
        onDelete: () => this.deleteFromCanvas(),
      });
      this.addChild(this.chartRenderer);
    } catch (e) {
      this.containerEl.empty();
      const errorEl = this.containerEl.createEl("div", {
        cls: "strataboard-empty strataboard-load-error",
      });
      errorEl.createEl("div", {
        text: `加载数据失败：${e instanceof Error ? e.message : String(e)}`,
      });
      const retryBtn = errorEl.createEl("button", {
        cls: "strataboard-retry-btn",
        text: "重试",
      });
      retryBtn.addEventListener("click", () => void this.render());
    }
  }

  private async refresh() {
    void this.render();
  }

  private async loadData(spec: ParsedCardSpec) {
    if (this.plugin.pluginSettings.autoRefreshOnOpen) {
      return this.plugin.dataAdapter.loadOhlcv(spec);
    }
    const cached = await this.plugin.dataAdapter.loadCachedOhlcv(spec);
    if (cached.length > 0) return cached;
    // First use (or cache miss): fetch once even when auto-refresh is off,
    // otherwise a card with an empty cache shows "暂无数据" forever.
    return this.plugin.dataAdapter.loadOhlcv(spec);
  }

  private tagParentPreviewAsCard() {
    let el: HTMLElement | null = this.containerEl;
    let canvasNode: HTMLElement | null = null;
    let markdownPreview: HTMLElement | null = null;

    while (el) {
      if (el.classList.contains("canvas-node")) {
        canvasNode = el;
      }
      if (el.classList.contains("markdown-preview-view")) {
        markdownPreview = el;
      }
      el = el.parentElement;
    }

    if (canvasNode) {
      canvasNode.classList.add("strataboard-card-note");
      if (markdownPreview) {
        markdownPreview.classList.add("strataboard-card-note");
      }
    }
  }

  private async loadMarketData(spec: ParsedCardSpec, tradeDate: string): Promise<import("./types").MarketData | null> {
    return this.plugin.dataAdapter.loadMarketData(spec, tradeDate);
  }

  private async switchFrequency(freq: "D" | "W" | "M") {
    if (!this.result.ok) return;
    await this.saveSpec({ ...this.result.spec, freq });
  }

  private openEditModal() {
    if (!this.result.ok) return;
    const spec = this.result.spec;
    // Resolve every display field against the built-in defaults so the modal
    // shows the values the card is actually rendered with.
    const resolved: ParsedCardSpec = {
      ...spec,
      chartType: spec.chartType ?? "candlestick",
      theme: spec.theme ?? "auto",
      riseColor: spec.riseColor ?? "#ef4444",
      fallColor: spec.fallColor ?? "#22c55e",
      height: spec.height ?? DEFAULT_CARD_HEIGHT,
    };
    new UnifiedCardEditModal(this.plugin.app, {
      source: "tushare",
      tushareSpec: resolved,
      tushareAvailable: this.plugin.pluginSettings.tushareToken.trim().length > 0,
      fredAvailable: this.plugin.pluginSettings.fredApiKey.trim().length > 0,
      openFredPicker: (onSelect) => this.plugin.openFredSearch(onSelect),
      openMacroPicker: (onSelect) => this.plugin.openMacroSearch(onSelect),
      openSymbolPicker: (onSelect) => this.plugin.openSymbolSearch(onSelect),
      onSubmit: (source, newSpec) => {
        if (source === "tushare") {
          void this.saveSpec(newSpec as ParsedCardSpec);
        } else if (source === "fred") {
          void this.plugin.convertCardToFred(this.sourcePath, newSpec as FredCardSpec);
        } else {
          void this.plugin.convertCardToMacro(this.sourcePath, newSpec as MacroCardSpec);
        }
      },
    }).open();
  }

  private async saveSpec(newSpec: ParsedCardSpec) {
    try {
      await this.plugin.cardService.updateCardSpec(this.sourcePath, newSpec);
      this.result = { ok: true, spec: newSpec };
      await this.render();
    } catch (e) {
      new Notice(`保存卡片设置失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

class WidgetCodeBlockRenderer extends MarkdownRenderChild {
  private plugin: StrataBoardPlugin;
  private source: string;
  private sourcePath: string;
  private result: ParseResult;
  private widgetRenderer: WidgetRenderer | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.source = source;
    this.sourcePath = sourcePath;
    this.result = parseCardSpec(source, { height: DEFAULT_CARD_HEIGHT });
  }

  onload() {
    this.render();
  }

  private render() {
    this.containerEl.empty();
    this.containerEl.addClass("strataboard-card");
    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());

    if (!this.result.ok) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error.message}`,
        cls: "strataboard-error",
      });
      return;
    }

    const spec = this.result.spec;
    this.widgetRenderer = new WidgetRenderer(this.containerEl, spec, {
      height: this.plugin.pluginSettings.widgetIframeHeight,
      plugin: this.plugin,
      sourcePath: this.sourcePath,
    });
    this.addChild(this.widgetRenderer);
  }

  private tagParentPreviewAsCard() {
    let el: HTMLElement | null = this.containerEl;
    let canvasNode: HTMLElement | null = null;
    let markdownPreview: HTMLElement | null = null;

    while (el) {
      if (el.classList.contains("canvas-node")) {
        canvasNode = el;
      }
      if (el.classList.contains("markdown-preview-view")) {
        markdownPreview = el;
      }
      el = el.parentElement;
    }

    if (canvasNode) {
      canvasNode.classList.add("strataboard-card-note");
      if (markdownPreview) {
        markdownPreview.classList.add("strataboard-card-note");
      }
    }
  }
}

class CalendarCodeBlockRenderer extends MarkdownRenderChild {
  private plugin: StrataBoardPlugin;
  private sourcePath: string;
  private result: ParseResult;
  private calendarRenderer: CalendarRenderer | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.result = parseCardSpec(source, { height: DEFAULT_CARD_HEIGHT });
  }

  onload() {
    this.render();
  }

  private render() {
    this.containerEl.empty();
    this.containerEl.addClass("strataboard-card");
    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());

    if (!this.result.ok) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error.message}`,
        cls: "strataboard-error",
      });
      return;
    }

    this.calendarRenderer = new CalendarRenderer(this.containerEl, {
      app: this.plugin.app,
      spec: this.result.spec,
      getDailyNotesSettings: () => ({
        dailyNotesFolder: this.plugin.pluginSettings.dailyNotesFolder,
        dailyNotesFormat: this.plugin.pluginSettings.dailyNotesFormat,
      }),
      getDisplaySettings: () => ({
        calendarExcerptFontSize: this.plugin.pluginSettings.calendarExcerptFontSize,
        calendarDayFontSize: this.plugin.pluginSettings.calendarDayFontSize,
        calendarExcerptLineHeight: this.plugin.pluginSettings.calendarExcerptLineHeight,
        calendarExcerptMaxLines: this.plugin.pluginSettings.calendarExcerptMaxLines,
      }),
      onOpenEditor: () => this.openEditModal(),
    });
    this.addChild(this.calendarRenderer);
  }

  private openEditModal() {
    if (!this.result.ok) return;
    const spec = this.result.spec;
    const settings = this.plugin.pluginSettings;
    new CalendarEditModal(
      this.plugin.app,
      { month: spec.calendarMonth, height: spec.height },
      {
        dayFontSize: settings.calendarDayFontSize,
        excerptFontSize: settings.calendarExcerptFontSize,
        maxLines: settings.calendarExcerptMaxLines,
      },
      (result) => {
        // The display steppers edit PLUGIN-GLOBAL settings; 月份/高度 persist
        // into the card spec (the file modify re-renders the card).
        settings.calendarDayFontSize = result.display.dayFontSize;
        settings.calendarExcerptFontSize = result.display.excerptFontSize;
        settings.calendarExcerptMaxLines = result.display.maxLines;
        void this.plugin.saveSettings();
        void this.plugin.cardService.updateCardSpec(this.sourcePath, {
          ...spec,
          calendarMonth: result.month,
          height: result.height ?? DEFAULT_CARD_HEIGHT,
        });
      }
    ).open();
  }

  private tagParentPreviewAsCard() {
    let el: HTMLElement | null = this.containerEl;
    let canvasNode: HTMLElement | null = null;
    let markdownPreview: HTMLElement | null = null;

    while (el) {
      if (el.classList.contains("canvas-node")) {
        canvasNode = el;
      }
      if (el.classList.contains("markdown-preview-view")) {
        markdownPreview = el;
      }
      el = el.parentElement;
    }

    if (canvasNode) {
      canvasNode.classList.add("strataboard-card-note");
      if (markdownPreview) {
        markdownPreview.classList.add("strataboard-card-note");
      }
    }
  }
}
// One overlay line plus whether it is a percent-ish series (drives the "%"
// suffix in the legend).
interface OverlayLine {
  line: SeriesChartLine;
  percentish: boolean;
}

// Quote series are normalized to % change from the first point in range.
function normalizeToPctChange(points: SeriesPoint[]): SeriesPoint[] {
  if (points.length === 0) return points;
  const base = points[0].value;
  if (base === 0) return points;
  return points.map((p) => ({ date: p.date, value: (p.value / base - 1) * 100 }));
}

function buildOverlayLine(ref: SeriesRef, points: SeriesPoint[], normalize: boolean): OverlayLine {
  let name = ref.label || SeriesAdapter.defaultLabel(ref);

  // Quote lines normalize to % change only when the card's 归一化 toggle is
  // on; only then do they count as percent-ish for the legend suffix.
  if (ref.source === "quote") {
    if (normalize) {
      return { line: { name, points: normalizeToPctChange(points) }, percentish: true };
    }
    return { line: { name, points }, percentish: false };
  }

  // Card-ref lines (an existing 差值计算卡) are plotted raw and count as
  // percent-ish — the common case is a spread of percent legs.
  if (ref.source === "card") {
    return { line: { name, points }, percentish: true };
  }

  // FRED lines count as percent-ish only when the stored units say so (e.g.
  // "Percent"); refs without units (older hand-written cards) keep the
  // legacy percent-ish default. A transform overrides the heuristic:
  // pch/pc1/... output percentages regardless of the raw units. The line
  // name carries the transform so raw and transformed legs of the same
  // series stay distinguishable.
  if (ref.source === "fred") {
    const percentish = fredTransformIsPercent(ref.transform) ?? (ref.units ? /percent/i.test(ref.units) : true);
    if (ref.transform) {
      name += `（${fredTransformLabel(ref.transform)}）`;
    }
    return { line: { name, points }, percentish };
  }

  // Macro money series (m0/m1/m2 余额, GDP, 社融) are shown in 万亿元;
  // percent series (同比/环比, LPR) plot raw and count as percent-ish; PMI
  // 指数 plot raw without the percent legend suffix.
  const def = ref.seriesId ? findMacroSeriesDef(ref.seriesId) : undefined;
  if (def?.kind === "money") {
    const divisor = def.divisor ?? 10000;
    name += "（万亿元）";
    return {
      line: { name, points: points.map((p) => ({ date: p.date, value: p.value / divisor })) },
      percentish: false,
    };
  }
  return { line: { name, points }, percentish: def ? def.kind === "percent" : true };
}

class OverlayCodeBlockRenderer extends ChartCardCodeBlockRenderer {
  private fcPlugin: StrataBoardPlugin;
  private result: SeriesSpecParseResult<OverlaySpec>;
  private chartRenderer: SeriesChartRenderer | null = null;
  // Baseline visible range captured on first chart-mode entry; used to tell
  // whether the user actually zoomed/panned during the session.
  private appliedRange: { from: string; to: string } | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(plugin, containerEl, source, sourcePath);
    this.fcPlugin = plugin;
    this.result = parseOverlaySpec(source);
  }

  protected async renderBody() {
    if (this.chartRenderer) {
      this.removeChild(this.chartRenderer);
      this.chartRenderer = null;
    }
    this.appliedRange = null;
    this.containerEl.empty();

    if (!this.result.spec) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error ?? "无效的卡片配置。"}`,
        cls: "strataboard-error",
      });
      return;
    }
    const spec = this.result.spec;

    // Canvas 显示逻辑 (资产叠加卡弹窗): bleed padding / fixed height in
    // canvas; widthAuto === false is handled by the chart's freezeWidth.
    onAttached(this.containerEl, () => {
      applyCanvasDisplayOptions(this.containerEl, {
        widthAuto: spec.widthAuto ?? true,
        heightAuto: spec.heightAuto ?? true,
        bleed: spec.bleed ?? DEFAULT_CARD_BLEED,
      });
    });

    // Placeholder while series data is fetched; SeriesChartRenderer (or the
    // error path below) empties the container when done.
    this.containerEl.createEl("div", {
      cls: "strataboard-empty",
      text: "正在加载数据…",
    });

    try {
      const period = spec.period ?? "D";
      const normalize = spec.normalize !== false;
      const allPoints = await Promise.all(
        spec.series.map((ref) => this.fcPlugin.seriesAdapter.loadSeries(ref, spec.range, period))
      );
      const overlayLines = spec.series.map((ref, i) => buildOverlayLine(ref, allPoints[i], normalize));
      // A "%" legend suffix only makes sense when every displayed line is a
      // percent-ish series.
      const displayed = overlayLines.filter((l) => l.line.points.length > 0);
      const valueSuffix =
        displayed.length > 0 && displayed.every((l) => l.percentish) ? "%" : undefined;

      // Title composes the line names; 归一化 marks normalized cards.
      const lineNames = spec.series.map((ref) => ref.label || SeriesAdapter.defaultLabel(ref));
      let title = `资产叠加（${lineNames.join("+")}）`;
      if (normalize) title += "（归一化）";

      // Subtitle: the date each normalized (quote) line is rebased to — its
      // first point's actual observation date (resampling keeps real dates).
      let subtitle: string | undefined;
      if (normalize) {
        const bases: { name: string; date: string }[] = [];
        spec.series.forEach((ref, i) => {
          if (ref.source === "quote" && allPoints[i].length > 0) {
            bases.push({ name: lineNames[i], date: allPoints[i][0].date });
          }
        });
        if (bases.length > 0) {
          subtitle = bases.every((b) => b.date === bases[0].date)
            ? `归一基准：${bases[0].date}`
            : `归一基准：${bases.map((b) => `${b.name} ${b.date}`).join(" · ")}`;
        }
      }

      this.containerEl.empty();
      this.chartRenderer = new SeriesChartRenderer(this.containerEl, {
        title,
        subtitle,
        lines: overlayLines.map((l) => l.line),
        height: spec.height ?? DEFAULT_CARD_HEIGHT,
        valueSuffix,
        theme: spec.theme ?? "auto",
        freezeWidth: spec.widthAuto === false,
        initialVisibleRange: spec.viewStart && spec.viewEnd ? { from: spec.viewStart, to: spec.viewEnd } : undefined,
      });
      this.addChild(this.chartRenderer);
    } catch (e) {
      this.renderLoadError(e);
    }
  }

  protected openEditModal() {
    if (!this.result.spec) return;
    new OverlayEditModal(
      this.fcPlugin.app,
      this.result.spec,
      (newSpec) => {
        void this.fcPlugin.updateOverlayCard(this.sourcePath, newSpec);
      },
      (onSelect, assetType) => this.fcPlugin.openSymbolSearch(onSelect, assetType),
      () => this.fcPlugin.listSpreadCards(),
      (onSelect) => this.fcPlugin.openFredSearch(onSelect)
    ).open();
  }

  protected onChartModeEnter() {
    // Capture the settled baseline lazily on first entry: by then the chart
    // has laid out and applied the persisted range (or fitContent).
    this.appliedRange ??= this.chartRenderer?.getVisibleRangeYmd() ?? null;
  }

  // Persists a user-changed visible range into the card YAML on chart-mode
  // exit — exactly one write, only when the range actually changed during
  // the session. The write re-renders the block; the fresh instance is
  // inactive, so no further writes happen (no loop).
  protected onChartModeExit() {
    const current = this.chartRenderer?.getVisibleRangeYmd();
    const spec = this.result.spec;
    if (!current || !spec) return;
    const baseline = this.appliedRange;
    if (baseline && current.from === baseline.from && current.to === baseline.to) return;
    if (current.from === spec.viewStart && current.to === spec.viewEnd) return;
    const newSpec: OverlaySpec = { ...spec, viewStart: current.from, viewEnd: current.to };
    this.result = { spec: newSpec };
    void this.fcPlugin.updateOverlayCard(this.sourcePath, newSpec);
  }

  protected onChartWheel(event: WheelEvent) {
    // The changed logical range is picked up by onChartModeExit's persist.
    this.chartRenderer?.applyTimeAxisWheelZoom(event.deltaY, event.clientX);
  }

  private renderLoadError(e: unknown) {
    this.containerEl.empty();
    const errorEl = this.containerEl.createEl("div", {
      cls: "strataboard-empty strataboard-load-error",
    });
    errorEl.createEl("div", {
      text: `加载数据失败：${e instanceof Error ? e.message : String(e)}`,
    });
    const retryBtn = errorEl.createEl("button", {
      cls: "strataboard-retry-btn",
      text: "重试",
    });
    retryBtn.addEventListener("click", () => void this.renderBody());
  }
}

class SpreadCodeBlockRenderer extends ChartCardCodeBlockRenderer {
  private fcPlugin: StrataBoardPlugin;
  private result: SeriesSpecParseResult<SpreadSpec>;
  private chartRenderer: SeriesChartRenderer | null = null;
  private appliedRange: { from: string; to: string } | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(plugin, containerEl, source, sourcePath);
    this.fcPlugin = plugin;
    this.result = parseSpreadSpec(source);
  }

  protected async renderBody() {
    if (this.chartRenderer) {
      this.removeChild(this.chartRenderer);
      this.chartRenderer = null;
    }
    this.appliedRange = null;
    this.containerEl.empty();

    if (!this.result.spec) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error ?? "无效的卡片配置。"}`,
        cls: "strataboard-error",
      });
      return;
    }
    const spec = this.result.spec;

    // Canvas 显示逻辑 (数据计算卡弹窗): bleed padding / fixed height in
    // canvas; widthAuto === false is handled by the chart's freezeWidth.
    onAttached(this.containerEl, () => {
      applyCanvasDisplayOptions(this.containerEl, {
        widthAuto: spec.widthAuto ?? true,
        heightAuto: spec.heightAuto ?? true,
        bleed: spec.bleed ?? DEFAULT_CARD_BLEED,
      });
    });

    this.containerEl.createEl("div", {
      cls: "strataboard-empty",
      text: "正在加载数据…",
    });

    try {
      const labels = spec.series.map((ref) => ref.label || SeriesAdapter.defaultLabel(ref));
      const points = await this.fcPlugin.seriesAdapter.loadSpread(spec, spec.range, spec.period ?? "D");
      const title = formatExpressionTitle(spec.expression, labels);

      this.containerEl.empty();
      this.chartRenderer = new SeriesChartRenderer(this.containerEl, {
        title,
        lines: [{ name: title, points, color: spec.lineColor, lineWidth: spec.lineWidth }],
        height: spec.height ?? DEFAULT_CARD_HEIGHT,
        theme: spec.theme ?? "auto",
        freezeWidth: spec.widthAuto === false,
        initialVisibleRange: spec.viewStart && spec.viewEnd ? { from: spec.viewStart, to: spec.viewEnd } : undefined,
      });
      this.addChild(this.chartRenderer);
    } catch (e) {
      this.renderLoadError(e);
    }
  }

  protected openEditModal() {
    if (!this.result.spec) return;
    new SpreadEditModal(
      this.fcPlugin.app,
      this.result.spec,
      (newSpec) => {
        void this.fcPlugin.updateSpreadCard(this.sourcePath, newSpec);
      },
      (onSelect, assetType) => this.fcPlugin.openSymbolSearch(onSelect, assetType),
      (onSelect) => this.fcPlugin.openFredSearch(onSelect)
    ).open();
  }

  protected onChartModeEnter() {
    this.appliedRange ??= this.chartRenderer?.getVisibleRangeYmd() ?? null;
  }

  // Same persist-on-exit discipline as the overlay wrapper (see there).
  protected onChartModeExit() {
    const current = this.chartRenderer?.getVisibleRangeYmd();
    const spec = this.result.spec;
    if (!current || !spec) return;
    const baseline = this.appliedRange;
    if (baseline && current.from === baseline.from && current.to === baseline.to) return;
    if (current.from === spec.viewStart && current.to === spec.viewEnd) return;
    const newSpec: SpreadSpec = { ...spec, viewStart: current.from, viewEnd: current.to };
    this.result = { spec: newSpec };
    void this.fcPlugin.updateSpreadCard(this.sourcePath, newSpec);
  }

  protected onChartWheel(event: WheelEvent) {
    this.chartRenderer?.applyTimeAxisWheelZoom(event.deltaY, event.clientX);
  }

  private renderLoadError(e: unknown) {
    this.containerEl.empty();
    const errorEl = this.containerEl.createEl("div", {
      cls: "strataboard-empty strataboard-load-error",
    });
    errorEl.createEl("div", {
      text: `加载数据失败：${e instanceof Error ? e.message : String(e)}`,
    });
    const retryBtn = errorEl.createEl("button", {
      cls: "strataboard-retry-btn",
      text: "重试",
    });
    retryBtn.addEventListener("click", () => void this.renderBody());
  }
}

// Standalone FRED card: tushare-asset-card-like presentation (header with
// name/code/refresh, latest-value row, period tabs) over a single line chart.
class FredCodeBlockRenderer extends ChartCardCodeBlockRenderer {
  private fcPlugin: StrataBoardPlugin;
  private result: SeriesSpecParseResult<FredCardSpec>;
  private chartRenderer: SeriesChartRenderer | null = null;
  private appliedRange: { from: string; to: string } | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(plugin, containerEl, source, sourcePath);
    this.fcPlugin = plugin;
    this.result = parseFredCardSpec(source);
  }

  protected async renderBody(forceRefresh = false) {
    if (this.chartRenderer) {
      this.removeChild(this.chartRenderer);
      this.chartRenderer = null;
    }
    this.appliedRange = null;
    this.containerEl.empty();

    if (!this.result.spec) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error ?? "无效的卡片配置。"}`,
        cls: "strataboard-error",
      });
      return;
    }
    const spec = this.result.spec;
    const period = spec.period ?? "D";
    const name = spec.label || spec.seriesId;
    // A transform (pch/pc1/...) decides the % suffix; otherwise fall back to
    // the units metadata heuristic.
    const percentish = fredTransformIsPercent(spec.transform) ?? (spec.units ? /percent/i.test(spec.units) : true);
    const valueSuffix = percentish ? "%" : undefined;

    this.containerEl.createEl("div", {
      cls: "strataboard-empty",
      text: "正在加载数据…",
    });

    let points: SeriesPoint[];
    try {
      const ref: SeriesRef = { source: "fred", seriesId: spec.seriesId, label: spec.label, units: spec.units, transform: spec.transform };
      points = await this.fcPlugin.seriesAdapter.loadSeries(ref, spec.range, period, forceRefresh);
    } catch (e) {
      this.renderLoadError(e);
      return;
    }

    this.containerEl.empty();

    // Header, reusing the tushare card's CSS classes: name + code (+frequency)
    // + refresh button, then the latest observation.
    const headerEl = this.containerEl.createEl("div", { cls: "strataboard-header" });
    const topRow = headerEl.createEl("div", { cls: "strataboard-header-top" });
    const titleWrap = topRow.createEl("div", { cls: "strataboard-header-title-wrap" });
    const title = titleWrap.createEl("div", { cls: "strataboard-header-title" });
    title.createEl("span", { cls: "strataboard-header-name", text: name });
    titleWrap.createEl("div", {
      cls: "strataboard-header-code",
      text: [spec.seriesId, spec.frequency, spec.transform ? fredTransformLabel(spec.transform) : undefined]
        .filter(Boolean)
        .join(" · "),
    });
    const actions = topRow.createEl("div", { cls: "strataboard-header-actions" });
    const refreshBtn = actions.createEl("button", { cls: "strataboard-header-refresh" });
    setIcon(refreshBtn, "refresh-cw");
    setTooltip(refreshBtn, "刷新数据");
    refreshBtn.addEventListener("click", () => void this.renderBody(true));

    if (points.length > 0) {
      const latest = points[points.length - 1];
      const quoteRow = headerEl.createEl("div", { cls: "strataboard-header-quote" });
      quoteRow.createEl("span", {
        cls: "strataboard-header-price",
        text: `${latest.value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${valueSuffix ?? ""}`,
      });
      quoteRow.createEl("span", { cls: "strataboard-header-code", text: latest.date });
    }

    // Period tabs (resample granularity), reusing the tushare card's tabs.
    const tabsEl = this.containerEl.createEl("div", { cls: "strataboard-period-tabs" });
    const periods: { id: SeriesPeriod; label: string }[] = [
      { id: "D", label: "日线" },
      { id: "M", label: "月线" },
      { id: "Q", label: "季线" },
      { id: "Y", label: "年线" },
    ];
    for (const p of periods) {
      const btn = tabsEl.createEl("button", {
        text: p.label,
        cls: p.id === period ? "is-active" : "",
      });
      btn.addEventListener("click", () => {
        if (p.id === period) return;
        // Persist through the same replace-block path; the file modify event
        // re-renders the card. Zoom persistence is intentionally kept.
        const newSpec: FredCardSpec = { ...spec, period: p.id };
        this.result = { spec: newSpec };
        void this.fcPlugin.updateFredCard(this.sourcePath, newSpec);
      });
    }

    // Chart (no title — the header above plays that role). An all-empty
    // series renders the renderer's Chinese empty state below the header.
    const chartEl = this.containerEl.createEl("div");
    this.chartRenderer = new SeriesChartRenderer(chartEl, {
      lines: [{ name, points }],
      height: spec.height ?? DEFAULT_CARD_HEIGHT,
      valueSuffix,
      initialVisibleRange: spec.viewStart && spec.viewEnd ? { from: spec.viewStart, to: spec.viewEnd } : undefined,
    });
    this.addChild(this.chartRenderer);
  }

  protected openEditModal() {
    if (!this.result.spec) return;
    new UnifiedCardEditModal(this.fcPlugin.app, {
      source: "fred",
      fredSpec: this.result.spec,
      tushareAvailable: this.fcPlugin.pluginSettings.tushareToken.trim().length > 0,
      fredAvailable: this.fcPlugin.pluginSettings.fredApiKey.trim().length > 0,
      openFredPicker: (onSelect) => this.fcPlugin.openFredSearch(onSelect),
      openMacroPicker: (onSelect) => this.fcPlugin.openMacroSearch(onSelect),
      openSymbolPicker: (onSelect) => this.fcPlugin.openSymbolSearch(onSelect),
      onSubmit: (source, newSpec) => {
        if (source === "fred") {
          void this.fcPlugin.updateFredCard(this.sourcePath, newSpec as FredCardSpec);
        } else if (source === "macro") {
          void this.fcPlugin.convertFredCardToMacro(this.sourcePath, newSpec as MacroCardSpec);
        } else {
          void this.fcPlugin.convertFredCardToTushare(this.sourcePath, newSpec as ParsedCardSpec);
        }
      },
    }).open();
  }

  protected onChartModeEnter() {
    this.appliedRange ??= this.chartRenderer?.getVisibleRangeYmd() ?? null;
  }

  // Same persist-on-exit discipline as the overlay wrapper (see there).
  protected onChartModeExit() {
    const current = this.chartRenderer?.getVisibleRangeYmd();
    const spec = this.result.spec;
    if (!current || !spec) return;
    const baseline = this.appliedRange;
    if (baseline && current.from === baseline.from && current.to === baseline.to) return;
    if (current.from === spec.viewStart && current.to === spec.viewEnd) return;
    const newSpec: FredCardSpec = { ...spec, viewStart: current.from, viewEnd: current.to };
    this.result = { spec: newSpec };
    void this.fcPlugin.updateFredCard(this.sourcePath, newSpec);
  }

  protected onChartWheel(event: WheelEvent) {
    this.chartRenderer?.applyTimeAxisWheelZoom(event.deltaY, event.clientX);
  }

  private renderLoadError(e: unknown) {
    this.containerEl.empty();
    const errorEl = this.containerEl.createEl("div", {
      cls: "strataboard-empty strataboard-load-error",
    });
    errorEl.createEl("div", {
      text: `加载数据失败：${e instanceof Error ? e.message : String(e)}`,
    });
    const retryBtn = errorEl.createEl("button", {
      cls: "strataboard-retry-btn",
      text: "重试",
    });
    retryBtn.addEventListener("click", () => void this.renderBody());
  }
}

// Standalone macro card (```macro block): one Tushare China-macro series with
// the same presentation as the FRED card. Display name, unit handling and
// money scaling (万亿元) come from the MACRO_SERIES_OPTIONS catalog entry.
class MacroCodeBlockRenderer extends ChartCardCodeBlockRenderer {
  private fcPlugin: StrataBoardPlugin;
  private result: SeriesSpecParseResult<MacroCardSpec>;
  private chartRenderer: SeriesChartRenderer | null = null;
  private appliedRange: { from: string; to: string } | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(plugin, containerEl, source, sourcePath);
    this.fcPlugin = plugin;
    this.result = parseMacroCardSpec(source);
  }

  protected async renderBody(forceRefresh = false) {
    if (this.chartRenderer) {
      this.removeChild(this.chartRenderer);
      this.chartRenderer = null;
    }
    this.appliedRange = null;
    this.containerEl.empty();

    if (!this.result.spec) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error ?? "无效的卡片配置。"}`,
        cls: "strataboard-error",
      });
      return;
    }
    const spec = this.result.spec;
    const def = findMacroSeriesDef(spec.seriesId);
    if (!def) {
      this.containerEl.createEl("div", {
        text: `错误：未知的宏观序列 ${spec.seriesId}。`,
        cls: "strataboard-error",
      });
      return;
    }
    const period = spec.period ?? "D";
    const valueSuffix = def.kind === "percent" ? "%" : undefined;
    let name = def.label;
    if (def.kind === "money") {
      name += "（万亿元）";
    }

    this.containerEl.createEl("div", {
      cls: "strataboard-empty",
      text: "正在加载数据…",
    });

    let points: SeriesPoint[];
    try {
      const ref: SeriesRef = { source: "macro", seriesId: spec.seriesId };
      points = await this.fcPlugin.seriesAdapter.loadSeries(ref, spec.range, period, forceRefresh);
    } catch (e) {
      this.renderLoadError(e);
      return;
    }
    // Money series are stored raw (亿元 / 万亿元 depending on the field);
    // scale to 万亿元 for display, same as the overlay legend.
    if (def.kind === "money") {
      const divisor = def.divisor ?? 10000;
      points = points.map((p) => ({ date: p.date, value: p.value / divisor }));
    }

    this.containerEl.empty();

    // Header, reusing the tushare card's CSS classes: name + group/frequency
    // + refresh button, then the latest observation.
    const headerEl = this.containerEl.createEl("div", { cls: "strataboard-header" });
    const topRow = headerEl.createEl("div", { cls: "strataboard-header-top" });
    const titleWrap = topRow.createEl("div", { cls: "strataboard-header-title-wrap" });
    const title = titleWrap.createEl("div", { cls: "strataboard-header-title" });
    title.createEl("span", { cls: "strataboard-header-name", text: name });
    titleWrap.createEl("div", {
      cls: "strataboard-header-code",
      text: `${def.group} · ${def.freq === "Q" ? "季度" : def.freq === "D" ? "日度" : "月度"}`,
    });
    const actions = topRow.createEl("div", { cls: "strataboard-header-actions" });
    const refreshBtn = actions.createEl("button", { cls: "strataboard-header-refresh" });
    setIcon(refreshBtn, "refresh-cw");
    setTooltip(refreshBtn, "刷新数据");
    refreshBtn.addEventListener("click", () => void this.renderBody(true));

    if (points.length > 0) {
      const latest = points[points.length - 1];
      const quoteRow = headerEl.createEl("div", { cls: "strataboard-header-quote" });
      quoteRow.createEl("span", {
        cls: "strataboard-header-price",
        text: `${latest.value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${valueSuffix ?? ""}`,
      });
      quoteRow.createEl("span", { cls: "strataboard-header-code", text: latest.date });
    }

    // Period tabs (resample granularity), reusing the tushare card's tabs.
    const tabsEl = this.containerEl.createEl("div", { cls: "strataboard-period-tabs" });
    const periods: { id: SeriesPeriod; label: string }[] = [
      { id: "D", label: "日线" },
      { id: "M", label: "月线" },
      { id: "Q", label: "季线" },
      { id: "Y", label: "年线" },
    ];
    for (const p of periods) {
      const btn = tabsEl.createEl("button", {
        text: p.label,
        cls: p.id === period ? "is-active" : "",
      });
      btn.addEventListener("click", () => {
        if (p.id === period) return;
        // Persist through the same replace-block path; the file modify event
        // re-renders the card. Zoom persistence is intentionally kept.
        const newSpec: MacroCardSpec = { ...spec, period: p.id };
        this.result = { spec: newSpec };
        void this.fcPlugin.updateMacroCard(this.sourcePath, newSpec);
      });
    }

    // Chart (no title — the header above plays that role). An all-empty
    // series renders the renderer's Chinese empty state below the header.
    const chartEl = this.containerEl.createEl("div");
    this.chartRenderer = new SeriesChartRenderer(chartEl, {
      lines: [{ name, points }],
      height: spec.height ?? DEFAULT_CARD_HEIGHT,
      valueSuffix,
      initialVisibleRange: spec.viewStart && spec.viewEnd ? { from: spec.viewStart, to: spec.viewEnd } : undefined,
    });
    this.addChild(this.chartRenderer);
  }

  protected openEditModal() {
    if (!this.result.spec) return;
    new UnifiedCardEditModal(this.fcPlugin.app, {
      source: "macro",
      macroSpec: this.result.spec,
      tushareAvailable: this.fcPlugin.pluginSettings.tushareToken.trim().length > 0,
      fredAvailable: this.fcPlugin.pluginSettings.fredApiKey.trim().length > 0,
      openFredPicker: (onSelect) => this.fcPlugin.openFredSearch(onSelect),
      openMacroPicker: (onSelect) => this.fcPlugin.openMacroSearch(onSelect),
      openSymbolPicker: (onSelect) => this.fcPlugin.openSymbolSearch(onSelect),
      onSubmit: (source, newSpec) => {
        if (source === "macro") {
          void this.fcPlugin.updateMacroCard(this.sourcePath, newSpec as MacroCardSpec);
        } else if (source === "fred") {
          void this.fcPlugin.convertMacroCardToFred(this.sourcePath, newSpec as FredCardSpec);
        } else {
          void this.fcPlugin.convertMacroCardToTushare(this.sourcePath, newSpec as ParsedCardSpec);
        }
      },
    }).open();
  }

  protected onChartModeEnter() {
    this.appliedRange ??= this.chartRenderer?.getVisibleRangeYmd() ?? null;
  }

  // Same persist-on-exit discipline as the overlay wrapper (see there).
  protected onChartModeExit() {
    const current = this.chartRenderer?.getVisibleRangeYmd();
    const spec = this.result.spec;
    if (!current || !spec) return;
    const baseline = this.appliedRange;
    if (baseline && current.from === baseline.from && current.to === baseline.to) return;
    if (current.from === spec.viewStart && current.to === spec.viewEnd) return;
    const newSpec: MacroCardSpec = { ...spec, viewStart: current.from, viewEnd: current.to };
    this.result = { spec: newSpec };
    void this.fcPlugin.updateMacroCard(this.sourcePath, newSpec);
  }

  protected onChartWheel(event: WheelEvent) {
    this.chartRenderer?.applyTimeAxisWheelZoom(event.deltaY, event.clientX);
  }

  private renderLoadError(e: unknown) {
    this.containerEl.empty();
    const errorEl = this.containerEl.createEl("div", {
      cls: "strataboard-empty strataboard-load-error",
    });
    errorEl.createEl("div", {
      text: `加载数据失败：${e instanceof Error ? e.message : String(e)}`,
    });
    const retryBtn = errorEl.createEl("button", {
      cls: "strataboard-retry-btn",
      text: "重试",
    });
    retryBtn.addEventListener("click", () => void this.renderBody());
  }
}

export default class StrataBoardPlugin extends Plugin {
  pluginSettings!: StrataBoardSettings;
  sqliteCache!: SqliteCache;
  dataAdapter!: DataAdapter;
  seriesAdapter!: SeriesAdapter;
  symbolIndex!: SymbolIndex;
  cardService!: CardService;
  toolbar!: CanvasToolbar;

  async onload() {
    await this.loadSettings();

    const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const dataCachePath = this.pluginSettings.dataCachePath;
    const symbolCachePath = this.pluginSettings.symbolCachePath;

    this.sqliteCache = new SqliteCache({ vault: this.app.vault, pluginDir });
    await this.sqliteCache.init({
      ohlcvDbPath: `${dataCachePath}/ohlcv.db`,
      marketDbPath: `${dataCachePath}/market.db`,
      symbolsDbPath: `${symbolCachePath}/symbols.db`,
    });

    // One-time migration from legacy JSON caches.
    await this.sqliteCache.migrateFromLegacy(
      `${pluginDir}/cache/data`,
      `${pluginDir}/cache/symbols`
    );

    this.dataAdapter = new DataAdapter({
      cache: this.sqliteCache,
      token: this.pluginSettings.tushareToken,
    });

    this.seriesAdapter = new SeriesAdapter({
      app: this.app,
      cache: this.sqliteCache,
      dataAdapter: this.dataAdapter,
      getFredApiKey: () => this.pluginSettings.fredApiKey,
    });

    this.symbolIndex = new SymbolIndex({
      cache: this.sqliteCache,
      token: this.pluginSettings.tushareToken,
      refreshIntervalDays: this.pluginSettings.symbolListRefreshIntervalDays,
    });

    this.cardService = new CardService({
      app: this.app,
      cardLibraryPath: this.pluginSettings.cardLibraryPath,
      widgetCardPath: this.pluginSettings.widgetCardPath,
      componentCardPath: this.pluginSettings.componentCardPath,
    });

    this.toolbar = new CanvasToolbar(this);

    this.addSettingTab(new StrataBoardSettingTab(this.app, this));

    this.addCommand({
      id: "open-settings",
      name: "打开金融卡片设置",
      callback: () => {
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById(this.manifest.id);
      },
    });

    this.addCommand({
      id: "insert-financial-card",
      name: "插入资产数据卡片",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            this.insertAssetDataCard();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "insert-widget-card",
      name: "插入 HTML / TradingView 小组件",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            this.openWidgetInputModal();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "insert-calendar-card",
      name: "插入日历卡片",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            void this.insertCalendarCard();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "insert-overlay-card",
      name: "插入资产叠加卡片",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            void this.insertOverlayCard();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "insert-spread-card",
      name: "插入数据计算卡片",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            void this.insertSpreadCard();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "insert-fred-card",
      name: "插入FRED数据卡片",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            void this.insertFredCard();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "insert-macro-card",
      name: "插入宏观数据卡片",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            void this.insertMacroCard();
          }
          return true;
        }
        return false;
      },
    });

    this.registerMarkdownCodeBlockProcessor("tushare", (source, el, ctx) => {
      const renderer = new TushareCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerMarkdownCodeBlockProcessor("financial-widget", (source, el, ctx) => {
      const renderer = new WidgetCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerMarkdownCodeBlockProcessor("calendar", (source, el, ctx) => {
      const renderer = new CalendarCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerMarkdownCodeBlockProcessor("overlay", (source, el, ctx) => {
      const renderer = new OverlayCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerMarkdownCodeBlockProcessor("spread", (source, el, ctx) => {
      const renderer = new SpreadCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerMarkdownCodeBlockProcessor("fred", (source, el, ctx) => {
      const renderer = new FredCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerMarkdownCodeBlockProcessor("macro", (source, el, ctx) => {
      const renderer = new MacroCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
        this.attachToolbarToCanvas(leaf);
      })
    );

    // Md-note insertion: same card flows as the canvas, but the finished spec
    // is written as a fenced code block at the cursor instead of creating a
    // card file + canvas node. The editor captured here stays valid while its
    // leaf lives; the modals below run long after the menu closes.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        menu.addItem((item) => {
          item
            .setTitle("插入金融卡片")
            .setIcon("line-chart")
            .onClick(() => this.insertCardIntoMd(editor));
        });
      })
    );

    this.attachToolbarToCanvas(this.app.workspace.activeLeaf);
  }

  onunload() {
    this.toolbar.detach();
    this.sqliteCache?.save().then(() => this.sqliteCache?.close()).catch((e) => {
      console.error("StrataBoard: failed to save SQLite cache on unload", e);
      this.sqliteCache?.close();
    });
  }

  async loadSettings() {
    const stored = (await this.loadData()) as Partial<StrataBoardSettings> | null;
    this.pluginSettings = Object.assign({}, DEFAULT_SETTINGS, stored);
    // Merge per-source toolbar visibility so a stale data.json (missing
    // sources added later) still gets defaults, and the live settings never
    // share object references with DEFAULT_SETTINGS.
    this.pluginSettings.toolbarSources = { ...DEFAULT_SETTINGS.toolbarSources, ...stored?.toolbarSources };
    // Normalize the stored order: drop unknown ids, append entries the stored
    // list doesn't know about yet (e.g. added by a newer plugin version).
    const storedOrder = (stored?.toolbarOrder ?? []).filter((id) =>
      DEFAULT_SETTINGS.toolbarOrder.includes(id)
    );
    this.pluginSettings.toolbarOrder = [
      ...storedOrder,
      ...DEFAULT_SETTINGS.toolbarOrder.filter((id) => !storedOrder.includes(id)),
    ];
    // Corner anchors; old "left" | "right" values (and anything unknown) map
    // to the bottom corner on the same side. Idempotent for valid values.
    const pos = this.pluginSettings.toolbarPosition as string;
    this.pluginSettings.toolbarPosition = `${pos.startsWith("top") ? "top" : "bottom"}-${
      pos.endsWith("left") ? "left" : "right"
    }`;
  }

  async saveSettings() {
    await this.saveData(this.pluginSettings);
    this.dataAdapter?.setToken(this.pluginSettings.tushareToken);
    this.symbolIndex?.setToken(this.pluginSettings.tushareToken);
    this.cardService?.setPaths({
      cardLibraryPath: this.pluginSettings.cardLibraryPath,
      widgetCardPath: this.pluginSettings.widgetCardPath,
      componentCardPath: this.pluginSettings.componentCardPath,
    });
    this.toolbar?.reload();
  }

  // Single entry point for the asset search modal (toolbar menu + command).
  // tx/em are the token-free sources: they skip the Tushare-token guard and
  // open a remote search modal instead of the local symbol index; the picked
  // item is upserted into the symbol cache so chart headers can resolve its
  // name later. The token check for Tushare types lives here so every path
  // fails with the same guidance instead of an empty search modal.
  openSymbolSearch(onSelect: (item: SymbolItem) => void, assetType?: AssetType) {
    if (assetType === "tx" || assetType === "em") {
      new RemoteQuoteSearchModal(
        this.app,
        ASSET_TYPE_LABELS[assetType],
        (text) => this.dataAdapter.searchRemoteQuotes(assetType, text),
        (item) => {
          void this.sqliteCache.upsertSymbols([item]);
          onSelect(item);
        }
      ).open();
      return;
    }
    if (!this.pluginSettings.tushareToken) {
      new Notice("请先在金融卡片设置中配置 Tushare Token。");
      return;
    }
    new SymbolSearchModal({
      app: this.app,
      symbolIndex: this.symbolIndex,
      onSelect,
      assetType,
    }).open();
  }

  // 插入资产数据 unified entry (command palette counterpart of the toolbar):
  // every data source leads to its own standalone-card picker — project rule:
  // any series usable in overlay/spread cards must also exist as a standalone
  // card. tx/em are always listed (token-free); Tushare/FRED entries appear
  // only when their key is configured.
  insertAssetDataCard() {
    const hasTushare = this.pluginSettings.tushareToken.trim().length > 0;
    const hasFred = this.pluginSettings.fredApiKey.trim().length > 0;

    const entries = [
      ...(hasTushare
        ? [
            {
              name: "Tushare 资产",
              desc: "股票/基金/指数/南华指数/港股/全球指数/可转债/期货/外汇/申万行业 · 日K/周K/月K",
              onPick: () => this.openSymbolSearch((item) => void this.insertCard(item)),
            },
            {
              name: "Tushare 宏观",
              desc: "货币供应/CPI/PMI/社融/LPR/国债收益率",
              onPick: () => void this.insertMacroCard(),
            },
          ]
        : []),
      {
        name: "腾讯行情",
        desc: "A股/港股/美股/指数/ETF · 免 Token",
        onPick: () => this.openSymbolSearch((item) => void this.insertCard(item), "tx"),
      },
      {
        name: "东方财富",
        desc: "A股/港股/美股/指数/ETF · 免 Token",
        onPick: () => this.openSymbolSearch((item) => void this.insertCard(item), "em"),
      },
      ...(hasFred
        ? [
            {
              name: "FRED",
              desc: "美国宏观 · 利率/就业/GDP…",
              onPick: () => void this.insertFredCard(),
            },
          ]
        : []),
    ];

    new SourcePickerModal(this.app, entries).open();
  }

  // Md-note counterpart of the canvas toolbar: one picker covering every card
  // type (project rule: every source reachable from every entry point). Data
  // sources keep their token/key gates; widget/calendar need none.
  // Each flow receives the editor and writes its fenced block at the cursor
  // instead of creating a card file.
  insertCardIntoMd(editor: Editor) {
    const hasTushare = this.pluginSettings.tushareToken.trim().length > 0;
    const hasFred = this.pluginSettings.fredApiKey.trim().length > 0;

    const entries = [
      ...(hasTushare
        ? [
            {
              name: "Tushare 资产",
              desc: "股票/基金/指数/南华指数/港股/全球指数/可转债/期货/外汇/申万行业 · 日K/周K/月K",
              onPick: () => this.openSymbolSearch((item) => void this.insertCard(item, editor)),
            },
            {
              name: "Tushare 宏观",
              desc: "货币供应/CPI/PMI/社融/LPR/国债收益率",
              onPick: () => void this.insertMacroCard(editor),
            },
            {
              name: "数据叠加",
              desc: "多个资产/宏观/FRED序列叠加在一张图上",
              onPick: () => void this.insertOverlayCard(editor),
            },
            {
              name: "数据计算",
              desc: "对字母标记的序列做四则运算，如 A-B",
              onPick: () => void this.insertSpreadCard(editor),
            },
          ]
        : []),
      {
        name: "腾讯行情",
        desc: "A股/港股/美股/指数/ETF · 免 Token",
        onPick: () => this.openSymbolSearch((item) => void this.insertCard(item, editor), "tx"),
      },
      {
        name: "东方财富",
        desc: "A股/港股/美股/指数/ETF · 免 Token",
        onPick: () => this.openSymbolSearch((item) => void this.insertCard(item, editor), "em"),
      },
      ...(hasFred
        ? [
            {
              name: "FRED",
              desc: "美国宏观 · 利率/就业/GDP…",
              onPick: () => void this.insertFredCard(editor),
            },
          ]
        : []),
      {
        name: "TradingView 小组件",
        desc: "嵌入 TradingView 脚本或 iframe 小组件",
        onPick: () => this.openWidgetInputModal(editor),
      },
      {
        name: "日历",
        desc: "联动日记的月历卡片",
        onPick: () => void this.insertCalendarCard(editor),
      },
    ];

    new SourcePickerModal(this.app, entries).open();
  }

  // Writes a fenced card block at the cursor. A mid-line cursor pushes the
  // block to the next line so it never lands inside prose.
  private insertBlockIntoEditor(editor: Editor, blockType: string, body: string) {
    const cursor = editor.getCursor("from");
    const prefix = cursor.ch > 0 && editor.getLine(cursor.line).trim().length > 0 ? "\n" : "";
    editor.replaceSelection(`${prefix}\`\`\`${blockType}\n${body}\n\`\`\`\n`);
  }

  async insertCard(item: SymbolItem, editor?: Editor) {
    const spec: ParsedCardSpec = {
      symbol: item.tsCode,
      assetType: item.assetType,
      freq: "D",
      range: this.resolveDefaultRange(),
      version: 1,
      height: DEFAULT_CARD_HEIGHT,
    };

    if (editor) {
      this.insertBlockIntoEditor(editor, codeBlockTypeFor(spec), stringifyCardSpec(spec));
      return;
    }

    try {
      const file = await this.cardService.createOrReuse(spec, undefined, item.name);
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(`创建卡片失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建卡片失败:", e);
    }
  }

  openWidgetInputModal(editor?: Editor) {
    new WidgetInputModal(
      this.app,
      ({ title, input, savePath }) => {
        void this.insertWidgetCard(title, input, savePath, editor);
      },
      this.pluginSettings.widgetCardPath
    ).open();
  }

  async insertWidgetCard(title: string, input: string, savePath?: string, editor?: Editor) {
    const parsed = parseWidgetInput(input, title || undefined);
    if (!parsed) {
      new Notice("输入内容为空或无法解析。");
      return;
    }

    const symbol = sanitizeSymbol(title) || parsed.title || "widget";
    const spec: ParsedCardSpec = {
      contentType: "widget",
      symbol,
      assetType: "stock",
      freq: "D",
      range: "1y",
      version: 1,
      height: DEFAULT_CARD_HEIGHT,
      widgetType: parsed.widgetType,
      iframeUrl: parsed.iframeUrl,
      widgetHtml: parsed.widgetHtml,
      widgetTitle: title || parsed.title || symbol,
    };

    if (editor) {
      this.insertBlockIntoEditor(editor, codeBlockTypeFor(spec), stringifyCardSpec(spec));
      return;
    }

    try {
      const file = await this.cardService.createOrReuse(spec, savePath);
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(`创建小组件卡片失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建小组件卡片失败:", e);
    }
  }

  async insertCalendarCard(editor?: Editor) {
    const spec: ParsedCardSpec = {
      contentType: "calendar",
      symbol: "calendar",
      assetType: "stock",
      freq: "D",
      range: "1y",
      version: 1,
      height: DEFAULT_CARD_HEIGHT,
    };

    if (editor) {
      this.insertBlockIntoEditor(editor, codeBlockTypeFor(spec), stringifyCardSpec(spec));
      return;
    }

    try {
      const file = await this.cardService.createOrReuse(spec);
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(`创建日历卡片失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建日历卡片失败:", e);
    }
  }

  // Modal-first insertion: the edit modal opens pre-filled with the default
  // spec; the card is only created when the user clicks 保存. Cancelling
  // inserts nothing.
  async insertOverlayCard(editor?: Editor) {
    // Same token guard as openSymbolSearch; a FRED key is NOT required at
    // insert time (the default series are macro).
    if (!this.pluginSettings.tushareToken) {
      new Notice("请先在金融卡片设置中配置 Tushare Token。");
      return;
    }

    new OverlayEditModal(
      this.app,
      DEFAULT_OVERLAY_SPEC,
      (spec) => void this.createOverlayCard(spec, editor),
      (onSelect, assetType) => this.openSymbolSearch(onSelect, assetType),
      () => this.listSpreadCards(),
      (onSelect) => this.openFredSearch(onSelect),
      "新建资产叠加卡"
    ).open();
  }

  async insertSpreadCard(editor?: Editor) {
    if (!this.pluginSettings.tushareToken) {
      new Notice("请先在金融卡片设置中配置 Tushare Token。");
      return;
    }

    new SpreadEditModal(
      this.app,
      DEFAULT_SPREAD_SPEC,
      (spec) => void this.createSpreadCard(spec, editor),
      (onSelect, assetType) => this.openSymbolSearch(onSelect, assetType),
      (onSelect) => this.openFredSearch(onSelect),
      "新建数据计算卡"
    ).open();
  }

  // Single entry point for the FRED series search modal (toolbar menu +
  // command + series-row editors). The key check lives here so every path
  // fails with the same guidance instead of an empty modal.
  openFredSearch(onSelect: (info: FredSeriesInfo) => void) {
    if (!this.pluginSettings.fredApiKey) {
      new Notice("请先在金融卡片设置中配置 FRED API Key。");
      return;
    }
    new FredSearchModal(
      this.app,
      (text) => this.seriesAdapter.searchFredSeries(text),
      onSelect
    ).open();
  }

  // Standalone FRED card: a dedicated ```fred block (single series) with a
  // tushare-asset-card-like presentation — NOT an overlay card.
  async insertFredCard(editor?: Editor) {
    this.openFredSearch((info) => void this.createFredCard(info, editor));
  }

  private async createFredCard(info: FredSeriesInfo, editor?: Editor) {
    const spec: FredCardSpec = {
      seriesId: info.id,
      label: info.title,
      units: info.units,
      frequency: info.frequency,
      range: "10y",
    };

    if (editor) {
      this.insertBlockIntoEditor(editor, "fred", stringifyFredCardSpec(spec));
      return;
    }
    // Same filename sanitization as widget cards; FRED titles are English,
    // fall back to the series id when nothing usable survives.
    const safe = info.title.replace(/[^a-zA-Z0-9\-_一-龥]/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const baseName = `${safe || `FRED-${info.id}`}.md`;

    try {
      const file = await this.cardService.createRawCard(baseName, "fred", stringifyFredCardSpec(spec));
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(`创建FRED数据卡片失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建FRED数据卡片失败:", e);
    }
  }

  // Macro series picker for the standalone-card flow and the unified edit
  // modal; local catalog, no token check beyond a configured Tushare token.
  openMacroSearch(onSelect: (def: MacroSeriesDef) => void) {
    if (!this.pluginSettings.tushareToken) {
      new Notice("请先在设置中配置 Tushare Token。");
      return;
    }
    new MacroSearchModal(this.app, onSelect).open();
  }

  // Standalone macro card: a dedicated ```macro block (single series) with
  // the same presentation as the FRED card.
  async insertMacroCard(editor?: Editor) {
    this.openMacroSearch((def) => void this.createMacroCard(def, editor));
  }

  private async createMacroCard(def: MacroSeriesDef, editor?: Editor) {
    const spec: MacroCardSpec = {
      seriesId: def.id,
      range: "10y",
    };

    if (editor) {
      this.insertBlockIntoEditor(editor, "macro", stringifyMacroCardSpec(spec));
      return;
    }
    const safe = def.label.replace(/[^a-zA-Z0-9\-_一-龥]/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const baseName = `${safe || `宏观-${def.id}`}.md`;

    try {
      const file = await this.cardService.createRawCard(baseName, "macro", stringifyMacroCardSpec(spec));
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(`创建宏观数据卡片失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建宏观数据卡片失败:", e);
    }
  }

  private async createOverlayCard(spec: OverlaySpec, editor?: Editor) {
    if (editor) {
      this.insertBlockIntoEditor(editor, "overlay", stringifyOverlaySpec(spec));
      return;
    }

    try {
      const file = await this.cardService.createRawCard("资产叠加.md", "overlay", stringifyOverlaySpec(spec));
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(`创建资产叠加卡片失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建资产叠加卡片失败:", e);
    }
  }

  // Lists existing spread cards (md files under the card library whose
  // content has a ```spread block) for the 已有卡片 dropdown in the overlay
  // editor. Display name is the file basename, sorted by name.
  async listSpreadCards(): Promise<{ path: string; name: string }[]> {
    const libraryPath = this.pluginSettings.cardLibraryPath;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(libraryPath + "/"));

    const cards: { path: string; name: string }[] = [];
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      if (!/```spread\n[\s\S]*?\n```/.test(content)) continue;
      cards.push({ path: file.path, name: file.basename });
    }
    return cards.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  private async createSpreadCard(spec: SpreadSpec, editor?: Editor) {
    if (editor) {
      this.insertBlockIntoEditor(editor, "spread", stringifySpreadSpec(spec));
      return;
    }

    try {
      const file = await this.cardService.createRawCard("数据计算.md", "spread", stringifySpreadSpec(spec));
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(`创建数据计算卡片失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建数据计算卡片失败:", e);
    }
  }

  // Saves an edited overlay spec back into the card file. Called from the
  // edit modal; the canvas preview re-renders on the modify event.
  async updateOverlayCard(sourcePath: string, spec: OverlaySpec) {
    await this.replaceCardBlock(sourcePath, "overlay", stringifyOverlaySpec(spec), "资产叠加卡片");
  }

  async updateSpreadCard(sourcePath: string, spec: SpreadSpec) {
    await this.replaceCardBlock(sourcePath, "spread", stringifySpreadSpec(spec), "数据计算卡片");
  }

  async updateFredCard(sourcePath: string, spec: FredCardSpec) {
    await this.replaceCardBlock(sourcePath, "fred", stringifyFredCardSpec(spec), "FRED数据卡片");
  }

  async updateMacroCard(sourcePath: string, spec: MacroCardSpec) {
    await this.replaceCardBlock(sourcePath, "macro", stringifyMacroCardSpec(spec), "宏观数据卡片");
  }

  // Card-type conversions from the unified edit modal's source selector:
  // the fenced block is swapped for the other type in place (file untouched
  // otherwise), and the now-stale fc-* frontmatter lines are stripped.
  async convertCardToFred(sourcePath: string, spec: FredCardSpec) {
    await this.replaceCardBlock(sourcePath, "fred", stringifyFredCardSpec(spec), "FRED数据卡片", {
      fromType: "tushare",
      stripFcFrontmatter: true,
    });
  }

  async convertCardToMacro(sourcePath: string, spec: MacroCardSpec) {
    await this.replaceCardBlock(sourcePath, "macro", stringifyMacroCardSpec(spec), "宏观数据卡片", {
      fromType: "tushare",
      stripFcFrontmatter: true,
    });
  }

  async convertFredCardToTushare(sourcePath: string, spec: ParsedCardSpec) {
    await this.replaceCardBlock(sourcePath, "tushare", stringifyCardSpec(spec), "资产数据卡片", {
      fromType: "fred",
      stripFcFrontmatter: true,
    });
  }

  async convertFredCardToMacro(sourcePath: string, spec: MacroCardSpec) {
    await this.replaceCardBlock(sourcePath, "macro", stringifyMacroCardSpec(spec), "宏观数据卡片", {
      fromType: "fred",
      stripFcFrontmatter: true,
    });
  }

  async convertMacroCardToTushare(sourcePath: string, spec: ParsedCardSpec) {
    await this.replaceCardBlock(sourcePath, "tushare", stringifyCardSpec(spec), "资产数据卡片", {
      fromType: "macro",
      stripFcFrontmatter: true,
    });
  }

  async convertMacroCardToFred(sourcePath: string, spec: FredCardSpec) {
    await this.replaceCardBlock(sourcePath, "fred", stringifyFredCardSpec(spec), "FRED数据卡片", {
      fromType: "macro",
      stripFcFrontmatter: true,
    });
  }

  // Replaces only the fenced code block of the given type inside the card
  // file, so notes elsewhere in the file survive. No file rename.
  private async replaceCardBlock(
    sourcePath: string,
    blockType: "tushare" | "overlay" | "spread" | "fred" | "macro",
    body: string,
    cardLabel: string,
    options?: { fromType?: "tushare" | "overlay" | "spread" | "fred" | "macro"; stripFcFrontmatter?: boolean }
  ) {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) {
      new Notice(`找不到${cardLabel}文件。`);
      return;
    }

    try {
      const content = await this.app.vault.cachedRead(file);
      const blockRe = new RegExp("```" + (options?.fromType ?? blockType) + "\\n[\\s\\S]*?\\n```");
      const newBlock = ["```" + blockType, body, "```"].join("\n");
      let newContent = blockRe.test(content)
        ? content.replace(blockRe, newBlock)
        : `${content.trimEnd()}\n\n${newBlock}\n`;
      if (options?.stripFcFrontmatter) {
        newContent = newContent.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (match, fmBody: string) => {
          const kept = fmBody.split("\n").filter((line) => !line.startsWith("fc-") && line.trim() !== "");
          return kept.length > 0 ? `---\n${kept.join("\n")}\n---` : "";
        });
      }
      if (newContent !== content) {
        await this.app.vault.modify(file, newContent);
      }
      new Notice(`${cardLabel}已保存。`);
    } catch (e) {
      new Notice(`保存${cardLabel}失败：${e instanceof Error ? e.message : String(e)}`);
      console.error(`保存${cardLabel}失败:`, e);
    }
  }

  private resolveDefaultRange(): string {
    // New cards always start from the built-in default range (1y).
    const { start, end } = resolveDateRange("1y");
    return `${formatIsoDate(parseDateYmd(start))}~${formatIsoDate(parseDateYmd(end))}`;
  }

  async placeDerivedCard(file: TFile, sourcePath: string): Promise<boolean> {
    const sourceNode = this.findCanvasNodeForPath(sourcePath);
    if (!sourceNode) return false;

    const view = this.app.workspace.getActiveViewOfType(ItemView) as any;
    if (!view?.canvas) return false;

    const newNode = view.canvas.createFileNode({
      file,
      pos: { x: sourceNode.x + sourceNode.width + 50, y: sourceNode.y },
      size: { width: sourceNode.width, height: sourceNode.height },
    });

    if (newNode) {
      view.canvas.requestSave();
      return true;
    }
    return false;
  }

  private findCanvasNodeForPath(sourcePath: string): { x: number; y: number; width: number; height: number } | null {
    const view = this.app.workspace.getActiveViewOfType(ItemView) as any;
    if (!view?.canvas) return null;

    for (const node of view.canvas.nodes.values()) {
      if (node.filePath === sourcePath) {
        return {
          x: node.x ?? 0,
          y: node.y ?? 0,
          width: node.width ?? 600,
          height: node.height ?? 400,
        };
      }
    }

    return null;
  }

  private attachToolbarToCanvas(leaf: WorkspaceLeaf | null) {
    if (leaf?.view?.getViewType?.() === "canvas") {
      this.toolbar.attach(leaf);
    } else {
      this.toolbar.detach();
    }
  }
}

function sanitizeSymbol(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
