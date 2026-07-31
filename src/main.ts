import {
  ItemView,
  MarkdownRenderChild,
  Notice,
  Plugin,
  TFile,
  type WorkspaceLeaf,
} from "obsidian";
import { DEFAULT_SETTINGS, FinancialCanvasSettingTab, type FinancialCanvasSettings } from "./settings";
import { parseCardSpec, type ParseResult } from "./modules/card-spec";
import { DataAdapter } from "./modules/data-adapter";
import { SymbolIndex } from "./modules/symbol-index";
import { SqliteCache } from "./modules/sqlite-cache";
import { CardService } from "./modules/card-service";
import { ChartRenderer } from "./modules/chart-renderer";
import { CalendarRenderer } from "./modules/calendar-renderer";
import { TimelineRenderer, parseTimelineSpec, timelineCardFileName, type TimelineParseResult } from "./modules/timeline-renderer";
import { WidgetRenderer } from "./modules/widget-renderer";
import { parseWidgetInput } from "./modules/widget-parser";
import { CanvasToolbar } from "./modules/toolbar";
import { SymbolSearchModal } from "./ui/symbol-search-modal";
import { WidgetInputModal } from "./ui/widget-input-modal";
import { TimelineEditModal, type TimelineEditResult } from "./ui/timeline-edit-modal";
import { TushareCardEditModal } from "./ui/tushare-card-edit-modal";
import type { ParsedCardSpec, SymbolItem } from "./types";
import { resolveDateRange, formatIsoDate, parseDateYmd } from "./utils/date";
import { onAttached } from "./utils/dom";

class TushareCodeBlockRenderer extends MarkdownRenderChild {
  private plugin: FinancialCanvasPlugin;
  private source: string;
  private sourcePath: string;
  private result: ParseResult;
  private chartRenderer: ChartRenderer | null = null;

  constructor(plugin: FinancialCanvasPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.source = source;
    this.sourcePath = sourcePath;
    this.result = parseCardSpec(source, { height: this.plugin.pluginSettings.defaultChartHeight });
  }

  onload() {
    this.render();

    // Double-click on a canvas file node natively enters the embedded edit
    // mode; capture the event before that handler so the settings modal wins.
    this.registerDomEvent(
      this.containerEl,
      "dblclick",
      (event) => {
        // Let header buttons (refresh / period tabs) keep their
        // own behavior.
        if ((event.target as HTMLElement | null)?.closest("button")) return;
        event.preventDefault();
        event.stopPropagation();
        this.openEditModal();
      },
      { capture: true }
    );
  }

  private async render() {
    this.containerEl.empty();
    this.containerEl.addClass("financial-canvas-card");
    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());

    if (!this.result.ok) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error.message}`,
        cls: "financial-canvas-error",
      });
      return;
    }

    const spec = this.result.spec;

    // Placeholder while OHLCV data is fetched; ChartRenderer (or the error
    // path below) empties the container when done.
    this.containerEl.createEl("div", {
      cls: "financial-canvas-empty",
      text: `正在加载数据：${spec.symbol}…`,
    });

    try {
      const data = await this.loadData(spec);
      const symbolInfo = await this.plugin.symbolIndex.lookup(spec.symbol, spec.assetType);
      this.chartRenderer = new ChartRenderer(this.containerEl, {
        spec,
        data,
        theme: spec.theme ?? this.plugin.pluginSettings.chartTheme,
        chartType: spec.chartType ?? this.plugin.pluginSettings.chartType,
        riseColor: spec.riseColor ?? this.plugin.pluginSettings.riseColor,
        fallColor: spec.fallColor ?? this.plugin.pluginSettings.fallColor,
        symbolInfo,
        height: spec.height ?? this.plugin.pluginSettings.defaultChartHeight,
        loadMarketData: (tradeDate) => this.loadMarketData(spec, tradeDate),
        onRefresh: () => this.refresh(),
        onSwitchFreq: (freq) => this.switchFrequency(freq),
      });
      this.addChild(this.chartRenderer);
    } catch (e) {
      this.containerEl.empty();
      const errorEl = this.containerEl.createEl("div", {
        cls: "financial-canvas-empty financial-canvas-load-error",
      });
      errorEl.createEl("div", {
        text: `加载数据失败：${e instanceof Error ? e.message : String(e)}`,
      });
      const retryBtn = errorEl.createEl("button", {
        cls: "financial-canvas-retry-btn",
        text: "重试",
      });
      retryBtn.addEventListener("click", () => void this.render());
    }
  }

  private async refresh() {
    this.render();
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
      canvasNode.classList.add("financial-canvas-card-note");
      if (markdownPreview) {
        markdownPreview.classList.add("financial-canvas-card-note");
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
    const settings = this.plugin.pluginSettings;
    // Resolve every display field against the plugin defaults so the modal
    // shows the values the card is actually rendered with.
    const resolved: ParsedCardSpec = {
      ...spec,
      chartType: spec.chartType ?? settings.chartType,
      theme: spec.theme ?? settings.chartTheme,
      riseColor: spec.riseColor ?? settings.riseColor,
      fallColor: spec.fallColor ?? settings.fallColor,
      height: spec.height ?? settings.defaultChartHeight,
    };
    new TushareCardEditModal(this.plugin.app, resolved, (newSpec) => {
      void this.saveSpec(newSpec);
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
  private plugin: FinancialCanvasPlugin;
  private source: string;
  private sourcePath: string;
  private result: ParseResult;
  private widgetRenderer: WidgetRenderer | null = null;

  constructor(plugin: FinancialCanvasPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.source = source;
    this.sourcePath = sourcePath;
    this.result = parseCardSpec(source, { height: this.plugin.pluginSettings.defaultChartHeight });
  }

  onload() {
    this.render();
  }

  private render() {
    this.containerEl.empty();
    this.containerEl.addClass("financial-canvas-card");
    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());

    if (!this.result.ok) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error.message}`,
        cls: "financial-canvas-error",
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
      canvasNode.classList.add("financial-canvas-card-note");
      if (markdownPreview) {
        markdownPreview.classList.add("financial-canvas-card-note");
      }
    }
  }
}

class CalendarCodeBlockRenderer extends MarkdownRenderChild {
  private plugin: FinancialCanvasPlugin;
  private result: ParseResult;
  private calendarRenderer: CalendarRenderer | null = null;

  constructor(plugin: FinancialCanvasPlugin, containerEl: HTMLElement, source: string) {
    super(containerEl);
    this.plugin = plugin;
    this.result = parseCardSpec(source, { height: plugin.pluginSettings.defaultChartHeight });
  }

  onload() {
    this.render();
  }

  private render() {
    this.containerEl.empty();
    this.containerEl.addClass("financial-canvas-card");
    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());

    if (!this.result.ok) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error.message}`,
        cls: "financial-canvas-error",
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
    });
    this.addChild(this.calendarRenderer);
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
      canvasNode.classList.add("financial-canvas-card-note");
      if (markdownPreview) {
        markdownPreview.classList.add("financial-canvas-card-note");
      }
    }
  }
}

class TimelineCodeBlockRenderer extends MarkdownRenderChild {
  private plugin: FinancialCanvasPlugin;
  private sourcePath: string;
  private result: TimelineParseResult;
  private timelineRenderer: TimelineRenderer | null = null;

  constructor(plugin: FinancialCanvasPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.result = parseTimelineSpec(source);
  }

  onload() {
    this.render();

    // Double-click on a canvas file node natively enters the embedded edit
    // mode; capture the event before that handler so the edit modal wins.
    this.registerDomEvent(
      this.containerEl,
      "dblclick",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openEditModal();
      },
      { capture: true }
    );
  }

  private render() {
    this.containerEl.empty();
    this.containerEl.addClass("financial-canvas-card");
    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());

    if (!this.result.ok) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error}`,
        cls: "financial-canvas-error",
      });
      return;
    }

    this.timelineRenderer = new TimelineRenderer(this.containerEl, {
      app: this.plugin.app,
      spec: this.result.spec,
      getFontSize: () => this.plugin.pluginSettings.timelineFontSize,
    });
    this.addChild(this.timelineRenderer);
  }

  private openEditModal() {
    if (!this.result.ok) return;
    const spec = this.result.spec;
    new TimelineEditModal(
      this.plugin.app,
      {
        start: formatIsoDate(spec.start),
        end: spec.end ? formatIsoDate(spec.end) : null,
        unit: spec.unit,
      },
      (edit) => {
        void this.plugin.updateTimelineCard(this.sourcePath, edit);
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
      canvasNode.classList.add("financial-canvas-card-note");
      if (markdownPreview) {
        markdownPreview.classList.add("financial-canvas-card-note");
      }
    }
  }
}

export default class FinancialCanvasPlugin extends Plugin {
  pluginSettings!: FinancialCanvasSettings;
  sqliteCache!: SqliteCache;
  dataAdapter!: DataAdapter;
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

    this.symbolIndex = new SymbolIndex({
      cache: this.sqliteCache,
      token: this.pluginSettings.tushareToken,
      refreshIntervalDays: this.pluginSettings.symbolListRefreshIntervalDays,
    });

    this.cardService = new CardService({
      app: this.app,
      cardLibraryPath: this.pluginSettings.cardLibraryPath,
    });

    this.toolbar = new CanvasToolbar(this);

    this.addSettingTab(new FinancialCanvasSettingTab(this.app, this));

    this.addCommand({
      id: "open-financial-canvas-settings",
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
            this.openSymbolSearch((item) => this.insertCard(item));
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
      id: "insert-timeline-card",
      name: "插入时间线卡片",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            void this.insertTimelineCard();
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
      const renderer = new CalendarCodeBlockRenderer(this, el, source);
      ctx.addChild(renderer);
    });

    this.registerMarkdownCodeBlockProcessor("timeline", (source, el, ctx) => {
      const renderer = new TimelineCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
        this.attachToolbarToCanvas(leaf);
      })
    );

    this.attachToolbarToCanvas(this.app.workspace.activeLeaf);

    console.log("Financial Canvas plugin loaded");
  }

  onunload() {
    this.toolbar.detach();
    this.sqliteCache?.save().then(() => this.sqliteCache?.close()).catch((e) => {
      console.error("Financial Canvas: failed to save SQLite cache on unload", e);
      this.sqliteCache?.close();
    });
    console.log("Financial Canvas plugin unloaded");
  }

  async loadSettings() {
    this.pluginSettings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.pluginSettings);
    this.dataAdapter?.setToken(this.pluginSettings.tushareToken);
    this.symbolIndex?.setToken(this.pluginSettings.tushareToken);
    this.cardService?.setLibraryPath(this.pluginSettings.cardLibraryPath);
    this.toolbar?.updatePosition();
  }

  // Single entry point for the asset search modal (toolbar menu + command).
  // The token check lives here so both paths fail with the same guidance
  // instead of an empty search modal.
  openSymbolSearch(onSelect: (item: SymbolItem) => void) {
    if (!this.pluginSettings.tushareToken) {
      new Notice("请先在金融卡片设置中配置 Tushare Token。");
      return;
    }
    new SymbolSearchModal({
      app: this.app,
      symbolIndex: this.symbolIndex,
      onSelect,
    }).open();
  }

  async insertCard(item: SymbolItem) {
    const spec: ParsedCardSpec = {
      symbol: item.tsCode,
      assetType: item.assetType,
      freq: this.pluginSettings.defaultFreq,
      range: this.resolveDefaultRange(),
      version: 1,
      height: this.pluginSettings.defaultChartHeight,
    };

    try {
      const file = await this.cardService.createOrReuse(spec);
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(`创建卡片失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建卡片失败:", e);
    }
  }

  openWidgetInputModal() {
    new WidgetInputModal(this.app, async ({ title, input, savePath }) => {
      await this.insertWidgetCard(title, input, savePath);
    }).open();
  }

  async insertWidgetCard(title: string, input: string, savePath?: string) {
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
      height: this.pluginSettings.defaultChartHeight,
      widgetType: parsed.widgetType,
      iframeUrl: parsed.iframeUrl,
      widgetHtml: parsed.widgetHtml,
      widgetTitle: title || parsed.title || symbol,
    };

    try {
      const file = await this.cardService.createOrReuse(spec, savePath);
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(`创建小组件卡片失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建小组件卡片失败:", e);
    }
  }

  async insertCalendarCard() {
    const spec: ParsedCardSpec = {
      contentType: "calendar",
      symbol: "calendar",
      assetType: "stock",
      freq: "D",
      range: "1y",
      version: 1,
      height: this.pluginSettings.defaultChartHeight,
    };

    try {
      const file = await this.cardService.createOrReuse(spec);
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(`创建日历卡片失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建日历卡片失败:", e);
    }
  }

  async insertTimelineCard() {
    // Default ruler: from the 1st of the current month, auto-ending today.
    const now = new Date();
    const start = formatIsoDate(new Date(now.getFullYear(), now.getMonth(), 1));
    const body = `start: ${start}\nunit: day`;
    // Auto end resolves to today for the file name only; the spec keeps it
    // omitted so the ruler keeps extending.
    const baseName = timelineCardFileName(start, formatIsoDate(now));

    try {
      const file = await this.cardService.createRawCard(baseName, "timeline", body);
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(`创建时间线卡片失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建时间线卡片失败:", e);
    }
  }

  // Saves an edited timeline spec back into the card file and renames the
  // file to match the new (resolved) range. Called from the edit modal.
  async updateTimelineCard(sourcePath: string, edit: TimelineEditResult) {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("找不到时间线卡片文件。");
      return;
    }

    const body = edit.end
      ? `start: ${edit.start}\nend: ${edit.end}\nunit: ${edit.unit}`
      : `start: ${edit.start}\nunit: ${edit.unit}`;

    try {
      const content = await this.app.vault.cachedRead(file);
      const blockRe = /```timeline\n[\s\S]*?\n```/;
      const newBlock = ["```timeline", body, "```"].join("\n");
      // Replace only the code block so notes elsewhere in the file survive;
      // the canvas preview re-renders on the modify event.
      const newContent = blockRe.test(content)
        ? content.replace(blockRe, newBlock)
        : `${content.trimEnd()}\n\n${newBlock}\n`;
      if (newContent !== content) {
        await this.app.vault.modify(file, newContent);
      }

      const resolvedEnd = edit.end ?? formatIsoDate(new Date());
      const baseName = timelineCardFileName(edit.start, resolvedEnd);
      if (file.name !== baseName) {
        const folder = file.parent && file.parent.path !== "/" ? file.parent.path : "";
        const target = await this.cardService.uniqueFilePath(folder, baseName);
        if (target !== file.path) {
          // renameFile routes through Obsidian's link updater, which rewrites
          // the node's file path inside open .canvas files.
          await this.app.fileManager.renameFile(file, target);
        }
      }
    } catch (e) {
      new Notice(`保存时间线失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("保存时间线失败:", e);
    }
  }

  private resolveDefaultRange(): string {
    const raw = this.pluginSettings.defaultRange.trim() || "1y";
    const { start, end } = resolveDateRange(raw);
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
