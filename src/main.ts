import {
  ItemView,
  MarkdownRenderChild,
  Menu,
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
import { WidgetRenderer } from "./modules/widget-renderer";
import { parseWidgetInput } from "./modules/widget-parser";
import { CanvasToolbar } from "./modules/toolbar";
import { SymbolSearchModal } from "./ui/symbol-search-modal";
import { WidgetInputModal } from "./ui/widget-input-modal";
import type { AssetType, ParsedCardSpec, SymbolItem } from "./types";
import { resolveDateRange, formatIsoDate, parseDateYmd } from "./utils/date";

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
  }

  private async render() {
    this.containerEl.empty();
    this.containerEl.addClass("financial-canvas-card");
    this.tagParentPreviewAsCard();

    if (!this.result.ok) {
      this.containerEl.createEl("div", {
        text: `错误：${this.result.error.message}`,
        cls: "financial-canvas-error",
      });
      return;
    }

    const spec = this.result.spec;

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
      this.containerEl.createEl("div", {
        cls: "financial-canvas-empty",
        text: `加载数据失败：${e instanceof Error ? e.message : String(e)}`,
      });
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
    const newSpec: ParsedCardSpec = { ...this.result.spec, freq };

    try {
      await this.plugin.cardService.updateCardSpec(this.sourcePath, newSpec);
      this.result = { ok: true, spec: newSpec };
      await this.render();
    } catch (e) {
      new Notice(`切换周期失败：${e instanceof Error ? e.message : String(e)}`);
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
    this.tagParentPreviewAsCard();

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
      name: "插入金融卡片",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            this.openSymbolSearch("stock", (item) => this.insertCard(item, "stock"));
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

    this.registerMarkdownCodeBlockProcessor("tushare", (source, el, ctx) => {
      const renderer = new TushareCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerMarkdownCodeBlockProcessor("financial-widget", (source, el, ctx) => {
      const renderer = new WidgetCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
        this.attachToolbarToCanvas(leaf);
      })
    );

    this.registerDomEvent(document, "contextmenu", (evt: MouseEvent) => {
      this.handleCanvasContextMenu(evt);
    });

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

  openSymbolSearch(assetType: AssetType, onSelect: (item: SymbolItem) => void) {
    new SymbolSearchModal({
      app: this.app,
      symbolIndex: this.symbolIndex,
      assetType,
      onSelect,
    }).open();
  }

  async insertCard(item: SymbolItem, assetType: AssetType) {
    if (!this.pluginSettings.tushareToken) {
      new Notice("请先在金融卡片设置中配置 Tushare Token。");
      return;
    }

    const spec: ParsedCardSpec = {
      symbol: item.tsCode,
      assetType,
      freq: this.pluginSettings.defaultFreq,
      range: this.resolveDefaultRange(),
      version: 1,
      height: this.pluginSettings.defaultChartHeight,
      headerCollapsed: true,
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

  private handleCanvasContextMenu(evt: MouseEvent) {
    const target = evt.target as HTMLElement;
    if (!target.closest(".canvas-wrapper")) return;
    if (target.closest(".canvas-node")) return;

    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("插入股票卡片")
        .setIcon("trending-up")
        .onClick(() => this.openSymbolSearch("stock", (item) => this.insertCard(item, "stock")))
    );
    menu.addItem((item) =>
      item
        .setTitle("插入基金卡片")
        .setIcon("piggy-bank")
        .onClick(() => this.openSymbolSearch("fund", (item) => this.insertCard(item, "fund")))
    );
    menu.addItem((item) =>
      item
        .setTitle("插入指数卡片")
        .setIcon("bar-chart")
        .onClick(() => this.openSymbolSearch("index", (item) => this.insertCard(item, "index")))
    );
    menu.addItem((item) =>
      item
        .setTitle("插入 HTML / TradingView 小组件")
        .setIcon("code")
        .onClick(() => this.openWidgetInputModal())
    );
    menu.showAtMouseEvent(evt);
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
