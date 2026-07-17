import { App, PluginSettingTab, Setting } from "obsidian";
import type FinancialCanvasPlugin from "./main";
import type { ChartTheme, ChartType, Freq, ToolbarPosition } from "./types";
import { DEFAULT_CARD_HEIGHT } from "./modules/card-spec";

export interface FinancialCanvasSettings {
  tushareToken: string;
  cardLibraryPath: string;
  dataCachePath: string;
  symbolCachePath: string;
  autoRefreshOnOpen: boolean;
  defaultRange: string;
  defaultFreq: Freq;
  chartTheme: ChartTheme;
  chartType: ChartType;
  riseColor: string;
  fallColor: string;
  toolbarPosition: ToolbarPosition;
  toolbarOffsetX: number;
  toolbarOffsetY: number;
  symbolListRefreshIntervalDays: number;
  defaultChartHeight: number;
  widgetIframeHeight: number;
}

export const DEFAULT_SETTINGS: FinancialCanvasSettings = {
  tushareToken: "",
  cardLibraryPath: "金融卡片",
  dataCachePath: "金融卡片/数据缓存",
  symbolCachePath: "金融卡片/股票代码缓存",
  autoRefreshOnOpen: true,
  defaultRange: "1y",
  defaultFreq: "D",
  chartTheme: "auto",
  chartType: "candlestick",
  riseColor: "#ef4444",
  fallColor: "#22c55e",
  toolbarPosition: "bottom-right",
  toolbarOffsetX: 16,
  toolbarOffsetY: 16,
  symbolListRefreshIntervalDays: 7,
  defaultChartHeight: DEFAULT_CARD_HEIGHT,
  widgetIframeHeight: 400,
};

export class FinancialCanvasSettingTab extends PluginSettingTab {
  plugin: FinancialCanvasPlugin;

  constructor(app: App, plugin: FinancialCanvasPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "金融卡片设置" });

    new Setting(containerEl)
      .setName("Tushare Token")
      .setDesc("你的 Tushare Pro API Token。")
      .addText((text) =>
        text
          .setPlaceholder("请输入 Token")
          .setValue(this.plugin.pluginSettings.tushareToken)
          .onChange(async (value) => {
            this.plugin.pluginSettings.tushareToken = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("卡片库路径")
      .setDesc("存放卡片 Markdown 文件的文件夹。")
      .addText((text) =>
        text
          .setPlaceholder("金融卡片")
          .setValue(this.plugin.pluginSettings.cardLibraryPath)
          .onChange(async (value) => {
            this.plugin.pluginSettings.cardLibraryPath = value.trim() || DEFAULT_SETTINGS.cardLibraryPath;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("数据缓存路径")
      .setDesc("SQLite 行情/市场数据缓存所在文件夹（会在此目录下创建 ohlcv.db 和 market.db）。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.dataCachePath)
          .setValue(this.plugin.pluginSettings.dataCachePath)
          .onChange(async (value) => {
            this.plugin.pluginSettings.dataCachePath = value.trim() || DEFAULT_SETTINGS.dataCachePath;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("股票代码缓存路径")
      .setDesc("SQLite 股票代码缓存所在文件夹（会在此目录下创建 symbols.db）。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.symbolCachePath)
          .setValue(this.plugin.pluginSettings.symbolCachePath)
          .onChange(async (value) => {
            this.plugin.pluginSettings.symbolCachePath = value.trim() || DEFAULT_SETTINGS.symbolCachePath;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("打开时自动刷新")
      .setDesc("打开文件或画布时自动刷新卡片数据。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.autoRefreshOnOpen).onChange(async (value) => {
          this.plugin.pluginSettings.autoRefreshOnOpen = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("默认时间范围")
      .setDesc("新建卡片的默认时间范围。支持 yyyy-mm-dd~yyyy-mm-dd，或快捷值 1y、3y、5y、ytd、max。")
      .addText((text) =>
        text
          .setPlaceholder("yyyy-mm-dd~yyyy-mm-dd")
          .setValue(this.plugin.pluginSettings.defaultRange)
          .onChange(async (value) => {
            this.plugin.pluginSettings.defaultRange = value.trim() || "1y";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("默认周期")
      .setDesc("新建卡片的默认 K 线周期。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("D", "日线")
          .addOption("W", "周线")
          .addOption("M", "月线")
          .setValue(this.plugin.pluginSettings.defaultFreq)
          .onChange(async (value) => {
            this.plugin.pluginSettings.defaultFreq = value as Freq;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "图表主题" });

    new Setting(containerEl)
      .setName("图表主题")
      .setDesc("跟随 Obsidian 主题或强制使用固定主题。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "跟随 Obsidian")
          .addOption("dark", "深色")
          .addOption("light", "浅色")
          .setValue(this.plugin.pluginSettings.chartTheme)
          .onChange(async (value) => {
            this.plugin.pluginSettings.chartTheme = value as ChartTheme;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("默认图表类型")
      .setDesc("新建卡片的默认图表样式。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("candlestick", "K 线图")
          .addOption("line", "折线图")
          .setValue(this.plugin.pluginSettings.chartType)
          .onChange(async (value) => {
            this.plugin.pluginSettings.chartType = value as ChartType;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("默认图表高度")
      .setDesc("新建卡片的默认图表总高度（像素）。")
      .addSlider((slider) =>
        slider
          .setLimits(200, 1200, 50)
          .setValue(this.plugin.pluginSettings.defaultChartHeight)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.pluginSettings.defaultChartHeight = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("上涨颜色")
      .setDesc("上涨 K 线的颜色。")
      .addColorPicker((picker) =>
        picker.setValue(this.plugin.pluginSettings.riseColor).onChange(async (value) => {
          this.plugin.pluginSettings.riseColor = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("下跌颜色")
      .setDesc("下跌 K 线的颜色。")
      .addColorPicker((picker) =>
        picker.setValue(this.plugin.pluginSettings.fallColor).onChange(async (value) => {
          this.plugin.pluginSettings.fallColor = value;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "HTML / TradingView 小组件" });

    new Setting(containerEl)
      .setName("小组件 iframe 高度")
      .setDesc("HTML / TradingView 小组件在卡片内部渲染时 iframe 的高度（像素）。")
      .addSlider((slider) =>
        slider
          .setLimits(200, 1600, 50)
          .setValue(this.plugin.pluginSettings.widgetIframeHeight)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.pluginSettings.widgetIframeHeight = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "工具栏与其他" });

    new Setting(containerEl)
      .setName("工具栏位置")
      .setDesc("画布上浮动工具栏所在角落。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("top-left", "左上")
          .addOption("top-right", "右上")
          .addOption("bottom-left", "左下")
          .addOption("bottom-right", "右下")
          .setValue(this.plugin.pluginSettings.toolbarPosition)
          .onChange(async (value) => {
            this.plugin.pluginSettings.toolbarPosition = value as ToolbarPosition;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("股票列表刷新间隔（天）")
      .setDesc("多久刷新一次本地股票代码列表缓存。")
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.pluginSettings.symbolListRefreshIntervalDays)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.pluginSettings.symbolListRefreshIntervalDays = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
