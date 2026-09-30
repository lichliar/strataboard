import {
  ItemView,
  MarkdownRenderChild,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  type Editor,
  type WorkspaceLeaf,
} from "obsidian";
import { DEFAULT_SETTINGS, StrataBoardSettingTab, type StrataBoardSettings } from "./settings";
import { DEFAULT_CARD_HEIGHT, DEFAULT_CARD_BLEED, parseCardSpec, stringifyCardSpec, type ParseResult } from "./modules/card-spec";
import { DataAdapter } from "./modules/data-adapter";
import { SqliteCache } from "./modules/sqlite-cache";
import { CardService, codeBlockTypeFor } from "./modules/card-service";
import { ChartRenderer } from "./modules/chart-renderer";
import { CalendarRenderer } from "./modules/calendar-renderer";
import { WidgetRenderer } from "./modules/widget-renderer";
import { parseWidgetInput } from "./modules/widget-parser";
import { CanvasToolbar } from "./modules/toolbar";
import { ChartCardCodeBlockRenderer, applyCanvasDisplayOptions, type ChartCardRefreshHandle } from "./modules/chart-card-base";
import { SeriesAdapter } from "./modules/series-adapter";
import { formatExpressionTitle } from "./modules/expression";
import { setRequestInterval } from "./modules/http";
import { ensureBundledAssets } from "./modules/bundled-assets";
import { SeriesChartRenderer, type SeriesChartLine } from "./modules/series-chart-renderer";
import {
  DEFAULT_OVERLAY_SPEC,
  DEFAULT_SPREAD_SPEC,
  parseOverlaySpec,
  parseSpreadSpec,
  stringifyOverlaySpec,
  stringifySpreadSpec,
  type SeriesSpecParseResult,
} from "./modules/series-spec";
import { RemoteQuoteSearchModal } from "./ui/remote-quote-modal";
import { ManualSymbolModal } from "./ui/manual-symbol-modal";
import { UnifiedSearchModal, type CategoryId } from "./ui/unified-search-modal";
import { SourcePickerModal, type SourcePickerEntry } from "./ui/source-picker-modal";
import { WidgetInputModal } from "./ui/widget-input-modal";
import { UnifiedCardEditModal } from "./ui/unified-card-edit-modal";
import { CalendarEditModal } from "./ui/calendar-edit-modal";
import { OverlayEditModal } from "./ui/overlay-edit-modal";
import { SpreadEditModal } from "./ui/spread-edit-modal";
import { ConfirmModal } from "./ui/confirm-modal";
import { cacheAssetKey, sourceSupportsRemoteSearch } from "./types";
import type { AssetType, CustomSourceDef, OverlayCompareMode, OverlaySpec, ParsedCardSpec, ReferenceableCard, ReferenceableCardKind, SeriesPoint, SeriesRef, SpreadSpec, SymbolItem, ToolbarSourceId } from "./types";
import { resolveDateRange, formatIsoDate, parseDateYmd } from "./utils/date";
import { normalizePath } from "./utils/slug";
import { onAttached } from "./utils/dom";
import { getCanvasView, openPluginSettings, type CanvasNodeLike } from "./utils/obsidian-internals";
import { t, setLanguage } from "./i18n";
import { syncScriptSources } from "./modules/script-sources";
import { ScriptManagerModal } from "./ui/script-manager-modal";
import { SetupGuideModal } from "./ui/setup-guide-modal";

class QuoteCodeBlockRenderer extends MarkdownRenderChild {
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
    this.containerEl.setAttribute("data-strataboard-block", "quote");
  }

  onload() {
    this.plugin.chartRenderers.add(this);
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
    this.plugin.chartRenderers.delete(this);
    // Not user-initiated: never persist during unload.
    this.setChartActive(false);
  }

  // Public re-render entry for the plugin-level registry (script-output
  // invalidation refreshes every chart card): same path as the header
  // refresh button.
  refreshCard(): void {
    void this.render();
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
    new ConfirmModal(this.plugin.app, t("从画布中移除该卡片？卡片文件仍保留在卡片库中。"), () => {
      const canvas = getCanvasView(this.plugin.app)?.canvas;
      if (!canvas?.nodes) {
        new Notice(t("当前没有激活的 Canvas 视图。"));
        return;
      }
      let target: CanvasNodeLike | null = null;
      for (const node of canvas.nodes.values()) {
        const el = node.nodeEl ?? node.el;
        if (el === nodeEl || el?.contains(nodeEl)) {
          target = node;
          break;
        }
      }
      if (!target) {
        new Notice(t("找不到对应的画布节点。"));
        return;
      }
      if (typeof canvas.removeNode === "function") {
        canvas.removeNode(target);
      } else if (typeof target.remove === "function") {
        target.remove();
      } else {
        new Notice(t("当前 Obsidian 版本不支持从画布移除节点。"));
        return;
      }
      canvas.requestSave?.();
      new Notice(t("已从画布移除卡片（文件保留在卡片库中）。"));
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
      this.containerEl.createDiv({
        text: t("错误：{msg}", { msg: this.result.error.message }),
        cls: "strataboard-error",
      });
      return;
    }

    const spec = this.result.spec;

    // Placeholder while OHLCV data is fetched; ChartRenderer (or the error
    // path below) empties the container when done.
    this.containerEl.createDiv({
      cls: "strataboard-empty",
      text: t("正在加载数据：{symbol}…", { symbol: spec.symbol }),
    });

    try {
      const data = await this.loadData(spec);
      // MA 口径：均线周期永远以交易日为单位，W/M 卡需要同一资产的日线
      // 数据（daily-only 类型本就以日线缓存，等于重取一次缓存）来计算。
      // 失败降级为 null，ChartRenderer 回退到按显示频率计算。均线关闭时
      // 跳过重取（无谓的缓存读）。
      const showMA = spec.showMA ?? this.plugin.pluginSettings.showChartMA;
      const maBaseData =
        spec.freq === "D" || !showMA
          ? null
          : await this.loadData({ ...spec, freq: "D" }).catch(() => null);
      const cachedSymbol = await this.plugin.sqliteCache.lookupSymbol(
        spec.symbol,
        cacheAssetKey(spec.assetType, spec.sourceId)
      );
      const symbolInfo = cachedSymbol ? { ...cachedSymbol, assetType: "custom" as const, sourceId: spec.sourceId } : undefined;
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
        maBaseData,
        showLegend: spec.showLegend ?? this.plugin.pluginSettings.showChartLegend,
        legendFrosted: spec.legendFrosted ?? this.plugin.pluginSettings.legendFrostedBackground,
        legendOpacity: spec.legendOpacity ?? this.plugin.pluginSettings.legendBackgroundOpacity,
        showMA,
        showGrid: spec.showGrid ?? this.plugin.pluginSettings.showChartGrid,
        gridOpacity: spec.gridOpacity ?? this.plugin.pluginSettings.gridOpacity,
        onRefresh: () => void this.refresh(),
        onSwitchFreq: (freq) => void this.switchFrequency(freq),
        onEdit: () => this.openEditModal(),
        onDelete: () => this.deleteFromCanvas(),
      });
      this.addChild(this.chartRenderer);
    } catch (e) {
      this.containerEl.empty();
      const errorEl = this.containerEl.createDiv({
        cls: "strataboard-empty strataboard-load-error",
      });
      errorEl.createDiv({
        text: t("加载数据失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }),
      });
      const retryBtn = errorEl.createEl("button", {
        cls: "strataboard-retry-btn",
        text: t("重试"),
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
      spec: resolved,
      openSymbolPicker: (onSelect, sourceId) => this.plugin.openSymbolSearch(onSelect, sourceId),
      customSources: this.plugin.enabledCustomSources(),
      onSubmit: (newSpec) => {
        void this.saveSpec(newSpec);
      },
    }).open();
  }

  private async saveSpec(newSpec: ParsedCardSpec) {
    try {
      await this.plugin.cardService.updateCardSpec(this.sourcePath, newSpec);
      this.result = { ok: true, spec: newSpec };
      await this.render();
    } catch (e) {
      new Notice(t("保存卡片设置失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
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
      this.containerEl.createDiv({
        text: t("错误：{msg}", { msg: this.result.error.message }),
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
      this.containerEl.createDiv({
        text: t("错误：{msg}", { msg: this.result.error.message }),
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

// Z-score standardization: (x − mean) / std over the loaded range. Puts every
// line on an equal-volatility footing — the principled way to compare shape
// between a high-vol series (stocks) and a low-vol one (FX).
function toZScore(points: SeriesPoint[]): SeriesPoint[] {
  if (points.length === 0) return points;
  const mean = points.reduce((sum, p) => sum + p.value, 0) / points.length;
  const variance = points.reduce((sum, p) => sum + (p.value - mean) ** 2, 0) / points.length;
  const std = Math.sqrt(variance);
  if (std === 0) return points.map((p) => ({ date: p.date, value: 0 }));
  return points.map((p) => ({ date: p.date, value: (p.value - mean) / std }));
}

function buildOverlayLine(ref: SeriesRef, points: SeriesPoint[], mode: OverlayCompareMode): OverlayLine {
  let name = ref.label || t(SeriesAdapter.defaultLabel(ref));

  // Quote lines normalize to % change only in percent mode (the default);
  // only then do they count as percent-ish for the legend suffix.
  if (ref.source === "quote") {
    if (mode === "percent") {
      return { line: { name, points: normalizeToPctChange(points) }, percentish: true };
    }
    return { line: { name, points }, percentish: false };
  }

  // Card-ref lines (an existing 数据计算卡) are plotted raw and count as
  // percent-ish — the common case is a spread of percent legs.
  return { line: { name, points }, percentish: true };
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
    this.containerEl.setAttribute("data-strataboard-block", "overlay");
  }

  protected async renderBody() {
    if (this.chartRenderer) {
      this.removeChild(this.chartRenderer);
      this.chartRenderer = null;
    }
    this.appliedRange = null;
    this.containerEl.empty();

    if (!this.result.spec) {
      this.containerEl.createDiv({
        text: t("错误：{msg}", { msg: this.result.error ?? t("无效的卡片配置。") }),
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
    this.containerEl.createDiv({
      cls: "strataboard-empty",
      text: t("正在加载数据…"),
    });

    try {
      const period = spec.period ?? "D";
      const compareMode = spec.normalize ?? "percent";
      const allPoints = await Promise.all(
        spec.series.map((ref) => this.fcPlugin.seriesAdapter.loadSeries(ref, spec.range, period))
      );
      const overlayLines = spec.series.map((ref, i) => {
        const built = buildOverlayLine(ref, allPoints[i], compareMode);
        // Per-series 缩放系数: a pure visual multiplier on the plotted values
        // (e.g. ×10 on a low-vol FX line so its swings stay visible next to a
        // stock). Applied before the z-score pass, which is scale-invariant.
        const scale = ref.scale ?? 1;
        if (scale !== 1) {
          built.line.points = built.line.points.map((p) => ({ date: p.date, value: p.value * scale }));
        }
        return built;
      });
      // z-score mode standardizes EVERY line post-hoc (including card-ref
      // legs); the result is dimensionless, so no line is percent-ish.
      if (compareMode === "zscore") {
        for (const line of overlayLines) {
          line.line.points = toZScore(line.line.points);
          line.percentish = false;
        }
      }
      // A "%" legend suffix only makes sense when every displayed line is a
      // percent-ish series.
      const displayed = overlayLines.filter((l) => l.line.points.length > 0);
      const valueSuffix =
        displayed.length > 0 && displayed.every((l) => l.percentish) ? "%" : undefined;

      // Title composes the line names plus the compare-mode marker.
      const lineNames = spec.series.map((ref) => ref.label || SeriesAdapter.defaultLabel(ref));
      let title = t("资产叠加（{names}）", { names: lineNames.join("+") });
      if (compareMode === "percent") title += t("（归一化）");
      else if (compareMode === "zscore") title += t("（标准化）");
      else if (compareMode === "axis") title += t("（独立纵轴）");

      // Subtitle explains the mode: percent shows the rebase date of each
      // (quote) line — its first point's actual observation date (resampling
      // keeps real dates); zscore/axis carry a short mode description.
      let subtitle: string | undefined;
      if (compareMode === "percent") {
        const bases: { name: string; date: string }[] = [];
        spec.series.forEach((ref, i) => {
          if (ref.source === "quote" && allPoints[i].length > 0) {
            bases.push({ name: lineNames[i], date: allPoints[i][0].date });
          }
        });
        if (bases.length > 0) {
          subtitle = bases.every((b) => b.date === bases[0].date)
            ? t("归一基准：{date}", { date: bases[0].date })
            : t("归一基准：{bases}", { bases: bases.map((b) => `${b.name} ${b.date}`).join(" · ") });
        }
      } else if (compareMode === "zscore") {
        subtitle = t("标准化：z = (x − 区间均值) ÷ 区间标准差");
      } else if (compareMode === "axis") {
        subtitle = t("各系列使用独立纵轴，按各自数值范围缩放");
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
        independentScales: compareMode === "axis",
        initialVisibleRange: spec.viewStart && spec.viewEnd ? { from: spec.viewStart, to: spec.viewEnd } : undefined,
        onEdit: () => this.openEditModal(),
        showLegend: spec.showLegend ?? this.fcPlugin.pluginSettings.showChartLegend,
        legendFrosted: spec.legendFrosted ?? this.fcPlugin.pluginSettings.legendFrostedBackground,
        legendOpacity: spec.legendOpacity ?? this.fcPlugin.pluginSettings.legendBackgroundOpacity,
        showLatestValue: spec.showLatestValue ?? this.fcPlugin.pluginSettings.showSeriesLatestValue,
        showPointMarkers: spec.showPointMarkers ?? this.fcPlugin.pluginSettings.showSeriesPointMarkers,
        showGrid: spec.showGrid ?? this.fcPlugin.pluginSettings.showChartGrid,
        gridOpacity: spec.gridOpacity ?? this.fcPlugin.pluginSettings.gridOpacity,
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
      (onSelect, sourceId) => this.fcPlugin.openSymbolSearch(onSelect, sourceId),
      () => this.fcPlugin.listReferenceableCards(),
      undefined,
      this.fcPlugin.enabledCustomSources()
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
    const errorEl = this.containerEl.createDiv({
      cls: "strataboard-empty strataboard-load-error",
    });
    errorEl.createDiv({
      text: t("加载数据失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }),
    });
    const retryBtn = errorEl.createEl("button", {
      cls: "strataboard-retry-btn",
      text: t("重试"),
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
    this.containerEl.setAttribute("data-strataboard-block", "spread");
  }

  protected async renderBody() {
    if (this.chartRenderer) {
      this.removeChild(this.chartRenderer);
      this.chartRenderer = null;
    }
    this.appliedRange = null;
    this.containerEl.empty();

    if (!this.result.spec) {
      this.containerEl.createDiv({
        text: t("错误：{msg}", { msg: this.result.error ?? t("无效的卡片配置。") }),
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

    this.containerEl.createDiv({
      cls: "strataboard-empty",
      text: t("正在加载数据…"),
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
        onEdit: () => this.openEditModal(),
        showLegend: spec.showLegend ?? this.fcPlugin.pluginSettings.showChartLegend,
        legendFrosted: spec.legendFrosted ?? this.fcPlugin.pluginSettings.legendFrostedBackground,
        legendOpacity: spec.legendOpacity ?? this.fcPlugin.pluginSettings.legendBackgroundOpacity,
        showLatestValue: spec.showLatestValue ?? this.fcPlugin.pluginSettings.showSeriesLatestValue,
        showPointMarkers: spec.showPointMarkers ?? this.fcPlugin.pluginSettings.showSeriesPointMarkers,
        showGrid: spec.showGrid ?? this.fcPlugin.pluginSettings.showChartGrid,
        gridOpacity: spec.gridOpacity ?? this.fcPlugin.pluginSettings.gridOpacity,
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
      (onSelect, sourceId) => this.fcPlugin.openSymbolSearch(onSelect, sourceId),
      undefined,
      this.fcPlugin.enabledCustomSources()
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
    const errorEl = this.containerEl.createDiv({
      cls: "strataboard-empty strataboard-load-error",
    });
    errorEl.createDiv({
      text: t("加载数据失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }),
    });
    const retryBtn = errorEl.createEl("button", {
      cls: "strataboard-retry-btn",
      text: t("重试"),
    });
    retryBtn.addEventListener("click", () => void this.renderBody());
  }
}

export default class StrataBoardPlugin extends Plugin {
  pluginSettings!: StrataBoardSettings;
  sqliteCache!: SqliteCache;
  dataAdapter!: DataAdapter;
  seriesAdapter!: SeriesAdapter;
  cardService!: CardService;
  toolbar!: CanvasToolbar;
  // Live chart card renderers; the script-output invalidation re-renders all
  // of them (renderers register/unregister themselves in onload/onunload).
  readonly chartRenderers = new Set<ChartCardRefreshHandle>();
  // Per-path debounce timers for the script-output watcher (scripts may
  // write their CSV in several IO bursts).
  private scriptOutputTimers = new Map<string, number>();

  async onload() {
    await this.loadSettings();

    const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const dataCachePath = this.pluginSettings.dataCachePath;
    const symbolCachePath = this.pluginSettings.symbolCachePath;

    // Store installs lack the release extras; fetch them before the SQLite
    // cache init needs sql-wasm.wasm.
    await ensureBundledAssets(this.app, pluginDir, this.manifest.version);

    this.sqliteCache = new SqliteCache({ vault: this.app.vault, pluginDir });
    await this.sqliteCache.init({
      ohlcvDbPath: `${dataCachePath}/ohlcv.db`,
      symbolsDbPath: `${symbolCachePath}/symbols.db`,
    });

    this.dataAdapter = new DataAdapter({
      cache: this.sqliteCache,
      customSources: this.pluginSettings.customSources,
      readVaultFile: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          throw new Error(t("文件不存在：{path}", { path }));
        }
        return this.app.vault.cachedRead(file);
      },
    });

    this.seriesAdapter = new SeriesAdapter({
      app: this.app,
      cache: this.sqliteCache,
      dataAdapter: this.dataAdapter,
    });

    this.cardService = new CardService({
      app: this.app,
      cardLibraryPath: this.pluginSettings.cardLibraryPath,
      widgetCardPath: this.pluginSettings.widgetCardPath,
      componentCardPath: this.pluginSettings.componentCardPath,
      resolveSourceName: (sourceId) => this.pluginSettings.customSources.find((s) => s.id === sourceId)?.name,
    });

    this.toolbar = new CanvasToolbar(this);

    this.addSettingTab(new StrataBoardSettingTab(this.app, this));

    this.addCommand({
      id: "open-settings",
      name: t("打开金融卡片设置"),
      callback: () => {
        openPluginSettings(this.app, this.manifest.id);
      },
    });

    this.addCommand({
      id: "insert-financial-card",
      name: t("插入资产数据卡片"),
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
      name: t("插入 HTML / TradingView 小组件"),
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
      name: t("插入日历卡片"),
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
      name: t("插入资产叠加卡片"),
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
      name: t("插入数据计算卡片"),
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
      id: "open-script-manager",
      name: t("打开脚本管理"),
      callback: () => this.openScriptManager(),
    });

    this.registerMarkdownCodeBlockProcessor("quote", (source, el, ctx) => {
      const renderer = new QuoteCodeBlockRenderer(this, el, source, ctx.sourcePath);
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
            .setTitle(t("插入金融卡片"))
            .setIcon("line-chart")
            .onClick(() => this.insertCardIntoMd(editor));
        });
      })
    );

    // Canvas node context menu: 「编辑…卡」opens the same edit modal the
    // double-click flow uses. The item must be added SYNCHRONOUSLY (Obsidian's
    // Menu.addItem is a no-op once the menu is shown), so the card type is
    // read from the rendered node's data-strataboard-block attribute instead
    // of an async file read; the click handler then parses the file.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source) => {
        if (source !== "canvas-menu") return;
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const type = this.detectCanvasCardType(file);
        if (!type) return;
        const titles: Record<string, string> = {
          quote: t("编辑数据卡"),
          overlay: t("编辑资产叠加卡"),
          spread: t("编辑数据计算卡"),
        };
        menu.addItem((item) => {
          item
            .setTitle(titles[type])
            .setIcon("pencil")
            .onClick(() => void this.openCardEditorFromMenu(file, type));
        });
      })
    );

    // Script-output watcher (脚本处理): a script rewriting its CSV is
    // invisible to the incremental cache (the cached extent already covers
    // the rewritten history), so a modify clears the matching source's cache
    // keys and re-renders every chart card; a create registers the new file
    // as a source. Deletes are left to manual source management (settings
    // 自定义数据源 list). Debounced per file — scripts may write in bursts.
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.isScriptOutputFile(file)) {
          this.debounceScriptOutput(file.path, () => void syncScriptSources(this));
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.isScriptOutputFile(file)) {
          this.debounceScriptOutput(file.path, () => void this.invalidateScriptOutput(file.path));
        }
      })
    );

    // Register script outputs that already exist (first run / plugin reload).
    void syncScriptSources(this);

    // Legacy cleanup: the AI card-authoring guide used to be written into
    // the card library on every load; it now lives in 设置 → AI 辅助.
    void this.removeLegacyAiGuide();

    this.attachToolbarToCanvas(this.app.workspace.getActiveViewOfType(ItemView)?.leaf ?? null);
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
    // Drop leftover keys from the removed built-in data sources (Tushare/FRED
    // connectors, per-source toggles) and the symbol-index refresh setting.
    if (stored) {
      const legacy = stored as Record<string, unknown>;
      delete legacy.tushareToken;
      delete legacy.fredApiKey;
      delete legacy.dataSources;
      delete legacy.symbolListRefreshIntervalDays;
    }
    this.pluginSettings = Object.assign({}, DEFAULT_SETTINGS, stored);
    setRequestInterval(this.pluginSettings.requestIntervalMs);
    setLanguage(this.pluginSettings.language);
    // Merge per-source toolbar visibility so a stale data.json (missing
    // sources added later) still gets defaults, and the live settings never
    // share object references with DEFAULT_SETTINGS. Keys are filtered
    // against the known sources so dropped ones vanish.
    const storedSources: Record<string, boolean> = stored?.toolbarSources ?? {};
    const knownSourceKeys = new Set<string>(Object.keys(DEFAULT_SETTINGS.toolbarSources));
    this.pluginSettings.toolbarSources = { ...DEFAULT_SETTINGS.toolbarSources };
    for (const [key, value] of Object.entries(storedSources)) {
      if (knownSourceKeys.has(key)) {
        this.pluginSettings.toolbarSources[key as ToolbarSourceId] = value;
      }
    }
    // Fresh object so a stale data.json gets the default and the live
    // settings never share a reference with DEFAULT_SETTINGS.
    this.pluginSettings.sourceGroupIcons = { ...(stored?.sourceGroupIcons ?? {}) };
    // Normalize the stored order: drop unknown ids, append entries the stored
    // list doesn't know about yet (new plugin-version entries). 「插入图表」is
    // pinned first — a stored legacy order must not push it down.
    const defaultOrder = DEFAULT_SETTINGS.toolbarOrder;
    const storedOrder = (stored?.toolbarOrder ?? []).filter((id) => defaultOrder.includes(id));
    const merged = [
      ...storedOrder,
      ...defaultOrder.filter((id) => !storedOrder.includes(id)),
    ];
    this.pluginSettings.toolbarOrder = [
      "insert-data",
      ...merged.filter((id) => id !== "insert-data"),
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
    setRequestInterval(this.pluginSettings.requestIntervalMs);
    this.dataAdapter?.setCustomSources(this.pluginSettings.customSources);
    this.cardService?.setPaths({
      cardLibraryPath: this.pluginSettings.cardLibraryPath,
      widgetCardPath: this.pluginSettings.widgetCardPath,
      componentCardPath: this.pluginSettings.componentCardPath,
    });
    this.toolbar?.reload();
  }

  // Enabled custom sources, for the pickers and edit modals.
  enabledCustomSources(): CustomSourceDef[] {
    return this.pluginSettings.customSources.filter((s) => s.enabled);
  }

  // Trashes the pre-refactor copy of the AI guide in the card library (the
  // guide moved into 设置 → AI 辅助). No-op once the file is gone.
  private async removeLegacyAiGuide() {
    try {
      const file = this.app.vault.getAbstractFileByPath(
        `${normalizePath(this.pluginSettings.cardLibraryPath)}/StrataBoard卡片编写指南.md`
      );
      if (file instanceof TFile) await this.app.fileManager.trashFile(file);
    } catch (e) {
      console.error("StrataBoard: failed to remove legacy AI guide", e);
    }
  }

  // ==================== 脚本处理 (user Python scripts → CSV sources) ====================

  // Opens the script manager modal (toolbar 数据处理 menu + command).
  openScriptManager() {
    new ScriptManagerModal(this.app, this).open();
  }

  private isScriptOutputFile(file: unknown): file is TFile {
    if (!(file instanceof TFile) || file.extension !== "csv") return false;
    const outputDir = `${normalizePath(this.pluginSettings.scriptFolderPath)}/output`;
    return file.parent?.path === outputDir;
  }

  private debounceScriptOutput(path: string, fn: () => void) {
    const existing = this.scriptOutputTimers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    this.scriptOutputTimers.set(
      path,
      window.setTimeout(() => {
        this.scriptOutputTimers.delete(path);
        fn();
      }, 2000)
    );
  }

  // Clears every cache key of the custom source fed by a script-output CSV
  // (registering the file first when it is new), then re-renders ALL chart
  // cards — no precise reference tracking: local CSV reads are cheap and the
  // cache merge is idempotent. Called by the vault watcher (debounced) and
  // directly by 立即运行 in the script manager.
  async invalidateScriptOutput(path: string) {
    let source = this.pluginSettings.customSources.find((s) => s.format === "csv" && s.filePath === path);
    if (!source) {
      // Force-register past the seen-stickiness: the script ran again (立即运行
      // or an output rewrite), so the data is wanted even if the source was
      // deleted before.
      await syncScriptSources(this, new Set([path]));
      source = this.pluginSettings.customSources.find((s) => s.format === "csv" && s.filePath === path);
    }
    if (source) {
      const assetKey = cacheAssetKey("custom", source.id) as AssetType;
      for (const key of await this.sqliteCache.listOhlcvKeys()) {
        if (key.assetType === assetKey) {
          await this.sqliteCache.deleteOhlcv(key.symbol, key.assetType);
        }
      }
    }
    for (const renderer of this.chartRenderers) renderer.refreshCard();
  }

  // Unified 「插入图表」 entry (canvas toolbar submenu / command palette): one
  // search modal fanning out across the sources in scope. Picked items are
  // upserted into the symbol cache first (keyed custom:<sourceId>) so chart
  // headers resolve
  // names later.
  openUnifiedSearch(scope: CategoryId = "all") {
    const sources = this.enabledCustomSources();
    if (sources.length === 0) {
      new SetupGuideModal(this.app).open();
      return;
    }
    new UnifiedSearchModal(this.app, {
      customSources: sources,
      searchCustom: (sourceId, text) => this.dataAdapter.searchRemoteQuotes(sourceId, text),
      onSymbol: (item) => this.insertSymbolCard(item),
      onManual: (sourceId, sourceName) =>
        new ManualSymbolModal(
          this.app,
          sourceId,
          sourceName,
          (item) => this.insertSymbolCard(item),
          this.pluginSettings.customSources.find((s) => s.id === sourceId)?.symbols
        ).open(),
      scope,
    }).open();
  }

  private insertSymbolCard(item: SymbolItem) {
    void this.sqliteCache.upsertSymbols([item]);
    void this.insertCard(item);
  }

  // Single entry point for the asset picker (toolbar menu + command). Every
  // card is backed by a custom source: remote search when the source defines
  // one (searchUrl / searchBodyTemplate), manual code entry otherwise; the
  // picked item is upserted into the symbol cache (keyed custom:<sourceId>)
  // so chart headers can resolve its name later.
  openSymbolSearch(onSelect: (item: SymbolItem) => void, sourceId?: string) {
    const def = this.pluginSettings.customSources.find((s) => s.id === sourceId && s.enabled);
    if (!def) {
      new Notice(t("自定义数据源「{id}」不存在或已停用，请在设置页检查。", { id: sourceId ?? "" }));
      return;
    }
    const onPick = (item: SymbolItem) => {
      const picked: SymbolItem = { ...item, assetType: "custom", sourceId: def.id };
      void this.sqliteCache.upsertSymbols([picked]);
      onSelect(picked);
    };
    if (sourceSupportsRemoteSearch(def)) {
      new RemoteQuoteSearchModal(
        this.app,
        def.name,
        (text) => this.dataAdapter.searchRemoteQuotes(def.id, text),
        onPick
      ).open();
    } else {
      new ManualSymbolModal(this.app, def.id, def.name, onPick, def.symbols).open();
    }
  }

  // 插入资产数据 unified entry (command palette counterpart of the toolbar):
  // one entry per source group plus one per ungrouped source (project rule:
  // any series usable in overlay/spread cards must also exist as a
  // standalone card).
  insertAssetDataCard() {
    const entries = this.buildSourcePickerEntries((def) =>
      this.openSymbolSearch((item) => void this.insertCard(item), def.id)
    );

    if (entries.length === 0) {
      new SetupGuideModal(this.app).open();
      return;
    }
    new SourcePickerModal(this.app, entries).open();
  }

  // Source-picker entries with grouped sources collapsed into one card per
  // group: picking a group opens the unified search scoped to that group;
  // ungrouped sources keep their single-source flow via onUngrouped.
  private buildSourcePickerEntries(
    onUngrouped: (def: CustomSourceDef) => void
  ): SourcePickerEntry[] {
    const entries: SourcePickerEntry[] = [];
    const seenGroups = new Set<string>();
    for (const def of this.pluginSettings.customSources) {
      if (!def.enabled) continue;
      if (def.group) {
        if (seenGroups.has(def.group)) continue;
        seenGroups.add(def.group);
        const group = def.group;
        const count = this.pluginSettings.customSources.filter(
          (s) => s.enabled && s.group === group
        ).length;
        entries.push({
          name: group,
          desc: t("数据源组 · {n} 个源", { n: count }),
          onPick: () => this.openUnifiedSearch(`group:${group}`),
        });
      } else {
        entries.push({
          name: def.name,
          desc: t("自定义数据源 · 用户配置"),
          onPick: () => onUngrouped(def),
        });
      }
    }
    return entries;
  }

  // Md-note counterpart of the canvas toolbar: one picker covering every
  // card type (project rule: every source reachable from every entry point).
  // Widget/calendar need no data source.
  // Each flow receives the editor and writes its fenced block at the cursor
  // instead of creating a card file.
  insertCardIntoMd(editor: Editor) {
    // No enabled source: the plugin ships no data sources, so guide the user
    // to configure one first. Widget/calendar stay reachable through their
    // own commands/menus — no exceptions in this guide.
    if (this.enabledCustomSources().length === 0) {
      new SetupGuideModal(this.app).open();
      return;
    }
    const entries: SourcePickerEntry[] = [
      ...this.buildSourcePickerEntries((def) =>
        this.openSymbolSearch((item) => void this.insertCard(item, editor), def.id)
      ),
      {
        name: "TradingView 小组件",
        desc: t("嵌入 TradingView 脚本或 iframe 小组件"),
        onPick: () => this.openWidgetInputModal(editor),
      },
      {
        name: t("日历"),
        desc: t("联动日记的月历卡片"),
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
      ...(item.sourceId ? { sourceId: item.sourceId } : {}),
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
      new Notice(t("创建卡片失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
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
      new Notice(t("输入内容为空或无法解析。"));
      return;
    }

    const symbol = sanitizeSymbol(title) || parsed.title || "widget";
    const spec: ParsedCardSpec = {
      contentType: "widget",
      symbol,
      assetType: "custom",
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
      new Notice(t("创建小组件卡片失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
      console.error("创建小组件卡片失败:", e);
    }
  }

  async insertCalendarCard(editor?: Editor) {
    const spec: ParsedCardSpec = {
      contentType: "calendar",
      symbol: "calendar",
      assetType: "custom",
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
      new Notice(t("创建日历卡片失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
      console.error("创建日历卡片失败:", e);
    }
  }

  // Modal-first insertion: the edit modal opens pre-filled with the default
  // spec; the card is only created when the user clicks 保存. Cancelling
  // inserts nothing.
  async insertOverlayCard(editor?: Editor) {
    const sources = this.enabledCustomSources();
    if (sources.length === 0) {
      new Notice(t("请先在设置页添加并启用自定义数据源。"));
      return;
    }

    new OverlayEditModal(
      this.app,
      DEFAULT_OVERLAY_SPEC,
      (spec) => void this.createOverlayCard(spec, editor),
      (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
      () => this.listReferenceableCards(),
      t("新建资产叠加卡"),
      sources
    ).open();
  }

  async insertSpreadCard(editor?: Editor) {
    const sources = this.enabledCustomSources();
    if (sources.length === 0) {
      new Notice(t("请先在设置页添加并启用自定义数据源。"));
      return;
    }

    new SpreadEditModal(
      this.app,
      DEFAULT_SPREAD_SPEC,
      (spec) => void this.createSpreadCard(spec, editor),
      (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
      t("新建数据计算卡"),
      sources
    ).open();
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
      new Notice(t("创建资产叠加卡片失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
      console.error("创建资产叠加卡片失败:", e);
    }
  }

  // Lists existing card files an overlay series can reference (md files under
  // the card library with a ```quote / ```spread block). Overlay cards are
  // not referenceable (which of the normalized lines would it resolve to?).
  // Display name is the file basename, sorted by name; `kind` is the block
  // type, used for dropdown grouping.
  async listReferenceableCards(): Promise<ReferenceableCard[]> {
    const libraryPath = this.pluginSettings.cardLibraryPath;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(libraryPath + "/"));

    const cards: ReferenceableCard[] = [];
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const match = content.match(/```(quote|spread)\n[\s\S]*?\n```/);
      if (!match) continue;
      cards.push({ path: file.path, name: file.basename, kind: match[1] as ReferenceableCardKind });
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
      new Notice(t("创建数据计算卡片失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
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

  // Replaces only the fenced code block of the given type inside the card
  // file, so notes elsewhere in the file survive. No file rename.
  private async replaceCardBlock(
    sourcePath: string,
    blockType: "quote" | "overlay" | "spread",
    body: string,
    cardLabel: string
  ) {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) {
      new Notice(t("找不到{label}文件。", { label: t(cardLabel) }));
      return;
    }

    try {
      const content = await this.app.vault.cachedRead(file);
      const blockRe = new RegExp("```" + blockType + "\\n[\\s\\S]*?\\n```");
      const newBlock = ["```" + blockType, body, "```"].join("\n");
      const newContent = blockRe.test(content)
        ? content.replace(blockRe, newBlock)
        : `${content.trimEnd()}\n\n${newBlock}\n`;
      if (newContent !== content) {
        await this.app.vault.modify(file, newContent);
      }
      new Notice(t("{label}已保存。", { label: t(cardLabel) }));
    } catch (e) {
      new Notice(t("保存{label}失败：{msg}", { label: t(cardLabel), msg: e instanceof Error ? e.message : String(e) }));
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

    const canvas = getCanvasView(this.app)?.canvas;
    if (!canvas) return false;

    const newNode = canvas.createFileNode?.({
      file,
      pos: { x: sourceNode.x + sourceNode.width + 50, y: sourceNode.y },
      size: { width: sourceNode.width, height: sourceNode.height },
    });

    if (newNode) {
      canvas.requestSave?.();
      return true;
    }
    return false;
  }

  private findCanvasNodeForPath(sourcePath: string): { x: number; y: number; width: number; height: number } | null {
    const canvas = getCanvasView(this.app)?.canvas;
    if (!canvas) return null;

    for (const node of canvas.nodes.values()) {
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

  // Canvas context-menu support: which StrataBoard card type (if any) the
  // node for this file renders. Read from the data-strataboard-block
  // attribute each chart-card renderer stamps on its container — synchronous,
  // because Menu.addItem is a no-op once the menu is shown.
  private detectCanvasCardType(file: TFile): string | null {
    const canvas = getCanvasView(this.app)?.canvas;
    if (!canvas?.nodes) return null;
    for (const node of canvas.nodes.values()) {
      if (node.filePath !== file.path) continue;
      const el = node.nodeEl ?? node.el;
      return el?.querySelector("[data-strataboard-block]")?.getAttribute("data-strataboard-block") ?? null;
    }
    return null;
  }

  // 「编辑…卡」menu action: parse the card file and open the same edit modal
  // the double-click flow uses. Saves go through the regular update/convert
  // paths, so the canvas preview re-renders on the modify event.
  private async openCardEditorFromMenu(file: TFile, type: string) {
    const content = await this.app.vault.cachedRead(file);
    const blockRe = new RegExp("```" + type + "\\n([\\s\\S]*?)\\n```");
    const match = blockRe.exec(content);
    if (!match) {
      new Notice(t("无法解析卡片配置。"));
      return;
    }
    const body = match[1];
    const path = file.path;

    if (type === "quote") {
      const result = parseCardSpec(body, { height: DEFAULT_CARD_HEIGHT });
      if (!result.ok) {
        new Notice(t("无法解析卡片配置。"));
        return;
      }
      const spec = result.spec;
      // Same default resolution as QuoteCodeBlockRenderer.openEditModal.
      const resolved: ParsedCardSpec = {
        ...spec,
        chartType: spec.chartType ?? "candlestick",
        theme: spec.theme ?? "auto",
        riseColor: spec.riseColor ?? "#ef4444",
        fallColor: spec.fallColor ?? "#22c55e",
        height: spec.height ?? DEFAULT_CARD_HEIGHT,
      };
      new UnifiedCardEditModal(this.app, {
        spec: resolved,
        openSymbolPicker: (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
        customSources: this.enabledCustomSources(),
        onSubmit: (newSpec) => {
          void this.cardService.updateCardSpec(path, newSpec);
        },
      }).open();
      return;
    }

    if (type === "overlay") {
      const result = parseOverlaySpec(body);
      if (!result.spec) {
        new Notice(t("无法解析卡片配置。"));
        return;
      }
      new OverlayEditModal(
        this.app,
        result.spec,
        (newSpec) => void this.updateOverlayCard(path, newSpec),
        (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
        () => this.listReferenceableCards(),
        undefined,
        this.enabledCustomSources()
      ).open();
      return;
    }

    if (type === "spread") {
      const result = parseSpreadSpec(body);
      if (!result.spec) {
        new Notice(t("无法解析卡片配置。"));
        return;
      }
      new SpreadEditModal(
        this.app,
        result.spec,
        (newSpec) => void this.updateSpreadCard(path, newSpec),
        (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
        undefined,
        this.enabledCustomSources()
      ).open();
    }
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
