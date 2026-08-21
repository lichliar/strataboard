import { App, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import type StrataBoardPlugin from "./main";
import type { MacroSeriesDef, ToolbarEntryId, ToolbarPosition, ToolbarSourceId, ToolbarStyle } from "./types";
import { MACRO_SERIES_OPTIONS } from "./types";
import { FolderPathSelect } from "./ui/folder-suggester";
import { CleanupConfirmModal } from "./ui/cleanup-modal";
import {
  collectUsedCacheKeys,
  deleteStaleCacheEntry,
  findOrphanCardFiles,
  findStaleCacheEntries,
} from "./modules/maintenance";

export interface StrataBoardSettings {
  tushareToken: string;
  fredApiKey: string;
  // Per-source toolbar visibility (数据源 API 设置 / 工具栏设置 both surface
  // these; a source without its key configured is usually hidden here).
  toolbarSources: Record<ToolbarSourceId, boolean>;
  toolbarStyle: ToolbarStyle;
  // User-defined order of the top-level toolbar entries (全部刷新/设置 stay
  // pinned at the bottom and are not part of this list).
  toolbarOrder: ToolbarEntryId[];
  toolbarIconSize: number;
  toolbarWidth: number;
  cardLibraryPath: string;
  widgetCardPath: string;
  componentCardPath: string;
  dataCachePath: string;
  symbolCachePath: string;
  autoRefreshOnOpen: boolean;
  toolbarPosition: ToolbarPosition;
  toolbarOffsetX: number;
  toolbarOffsetY: number;
  toolbarCollapsed: boolean;
  symbolListRefreshIntervalDays: number;
  widgetIframeHeight: number;
  dailyNotesFolder: string;
  dailyNotesFormat: string;
  calendarExcerptFontSize: number;
  calendarDayFontSize: number;
  calendarExcerptLineHeight: number;
  calendarExcerptMaxLines: number;
}

export const DEFAULT_SETTINGS: StrataBoardSettings = {
  tushareToken: "",
  fredApiKey: "",
  toolbarSources: { tushare: true, tencent: true, eastmoney: true, fred: true, tradingview: true },
  toolbarStyle: "icon",
  toolbarOrder: ["tushare", "tencent", "eastmoney", "fred", "tradingview", "overlay", "spread", "components"],
  toolbarIconSize: 16,
  toolbarWidth: 44,
  cardLibraryPath: "金融卡片",
  widgetCardPath: "金融卡片/TradingView Widgets",
  componentCardPath: "金融卡片/组件",
  dataCachePath: "金融卡片/数据缓存",
  symbolCachePath: "金融卡片/股票代码缓存",
  autoRefreshOnOpen: true,
  toolbarPosition: "right",
  toolbarOffsetX: 16,
  toolbarOffsetY: 16,
  toolbarCollapsed: false,
  symbolListRefreshIntervalDays: 7,
  widgetIframeHeight: 400,
  // Empty means "follow the core Daily notes plugin, else built-in defaults".
  dailyNotesFolder: "",
  dailyNotesFormat: "",
  calendarExcerptFontSize: 15,
  calendarDayFontSize: 20,
  calendarExcerptLineHeight: 2,
  calendarExcerptMaxLines: 4,
};

const TOOLBAR_SOURCE_LABELS: Record<ToolbarSourceId, string> = {
  tushare: "Tushare",
  tencent: "腾讯行情",
  eastmoney: "东方财富",
  fred: "FRED",
  tradingview: "TradingView Widget",
};

const TOOLBAR_ENTRY_LABELS: Record<ToolbarEntryId, string> = {
  ...TOOLBAR_SOURCE_LABELS,
  overlay: "数据叠加",
  spread: "数据计算",
  components: "组件",
};

type SettingsTabId = "data-source" | "paths" | "cards" | "toolbar";

const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: "data-source", label: "数据源设置" },
  { id: "paths", label: "路径设置" },
  { id: "cards", label: "卡片与组件" },
  { id: "toolbar", label: "工具栏设置" },
];

export class StrataBoardSettingTab extends PluginSettingTab {
  plugin: StrataBoardPlugin;
  private activeTab: SettingsTabId = "data-source";

  constructor(app: App, plugin: StrataBoardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const tabBar = containerEl.createDiv("fc-settings-tabbar");
    for (const tab of SETTINGS_TABS) {
      const button = tabBar.createEl("button", {
        text: tab.label,
        cls: `fc-settings-tab${tab.id === this.activeTab ? " fc-settings-tab-active" : ""}`,
      });
      button.addEventListener("click", () => {
        if (this.activeTab === tab.id) return;
        this.activeTab = tab.id;
        this.display();
      });
    }

    const contentEl = containerEl.createDiv("fc-settings-content");
    switch (this.activeTab) {
      case "data-source":
        this.renderDataSourceSettings(contentEl);
        break;
      case "paths":
        this.renderPathSettings(contentEl);
        break;
      case "cards":
        this.renderCardSettings(contentEl);
        break;
      case "toolbar":
        this.renderToolbarSettings(contentEl);
        break;
    }
  }

  private renderDataSourceSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("数据源 API 设置").setHeading();

    // Each keyed source gets its own <details> subgroup; info-only content
    // (free sources) is folded away by default.
    const tushareDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    tushareDetails.setAttr("open", "");
    tushareDetails.createEl("summary", { text: "Tushare 设置" });

    new Setting(tushareDetails)
      .setName("Tushare Token")
      .setDesc("你的 Tushare Pro API Token。")
      .addText((text) => {
        text
          .setPlaceholder("请输入 Token")
          .setValue(this.plugin.pluginSettings.tushareToken)
          .onChange(async (value) => {
            this.plugin.pluginSettings.tushareToken = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass("fc-mono");
      });

    this.renderTusharePointsInfo(tushareDetails);

    const fredDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    fredDetails.setAttr("open", "");
    fredDetails.createEl("summary", { text: "FRED 设置" });

    const fredSetting = new Setting(fredDetails).setName("FRED API Key");
    fredSetting.descEl.appendText("用于获取美联储 FRED 宏观数据（如 DGS10/DGS2），可免费申请：");
    fredSetting.descEl.createEl("a", {
      text: "https://fredaccount.stlouisfed.org/apikeys",
      href: "https://fredaccount.stlouisfed.org/apikeys",
    });
    fredSetting.addText((text) => {
      text
        .setPlaceholder("请输入 API Key")
        .setValue(this.plugin.pluginSettings.fredApiKey)
        .onChange(async (value) => {
          this.plugin.pluginSettings.fredApiKey = value;
          await this.plugin.saveSettings();
        });
      text.inputEl.addClass("fc-mono");
    });

    const freeDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    freeDetails.createEl("summary", { text: "免费行情源 · 无需密钥" });
    for (const source of [
      { name: "腾讯行情", desc: "A股 / 港股 / 美股 / 指数 / ETF 日K · 已接入" },
      { name: "东方财富", desc: "A股 / 港股 / 美股 / 指数 / ETF 日K · 已接入" },
    ]) {
      const setting = new Setting(freeDetails).setName(source.name).setDesc(source.desc);
      setting.controlEl.createSpan({ cls: "fc-pill fc-pill-sm fc-pill-muted", text: "无需密钥" });
    }

    new Setting(containerEl)
      .setName("股票列表刷新间隔（天）")
      .setDesc("多久刷新一次本地股票代码列表缓存。")
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.pluginSettings.symbolListRefreshIntervalDays)
          .onChange(async (value) => {
            this.plugin.pluginSettings.symbolListRefreshIntervalDays = value;
            await this.plugin.saveSettings();
          })
      );
  }

  // Static reference of the Tushare points each used API requires (per
  // tushare.pro 关于权限 doc). Quote APIs are listed literally; macro APIs
  // are aggregated from MACRO_SERIES_OPTIONS (one row per api). Rendered as a
  // collapsed <details> inside Tushare 设置.
  private renderTusharePointsInfo(containerEl: HTMLElement): void {
    const details = containerEl.createEl("details", { cls: "fc-settings-sub fc-settings-sub-nested" });
    details.createEl("summary", { text: "Tushare 接口积分要求" });

    const block = details.createDiv("fc-points-table");
    const quoteApis: { label: string; points: string }[] = [
      { label: "股票日线 daily", points: "积分≥120 起" },
      { label: "股票周/月K weekly · monthly", points: "积分≥2000" },
      { label: "基金 fund_basic · fund_daily", points: "积分≥2000" },
      { label: "指数 index_basic · index_daily/weekly/monthly", points: "积分≥2000 起" },
      { label: "南华期货指数 fut_index_daily", points: "积分≥2000" },
      { label: "港股 hk_basic · hk_daily", points: "积分≥2000（hk_daily 需单独开通权限）" },
      { label: "国际指数 index_global", points: "积分≥6000" },
      { label: "可转债 cb_basic · cb_daily", points: "积分≥2000" },
      { label: "期货 fut_basic · fut_daily", points: "积分≥2000" },
      { label: "外汇 fx_obasic · fx_daily", points: "积分≥2000" },
      { label: "申万行业指数 index_classify · sw_daily", points: "积分≥2000" },
      { label: "每日指标 daily_basic（市场数据行）", points: "积分≥2000 起" },
      { label: "美股 us_daily", points: "单独付费权限，未接入（可用腾讯/东财源替代）" },
    ];
    for (const row of quoteApis) {
      block.createDiv({ cls: "fc-field-hint", text: `${row.label} —— ${row.points}` });
    }

    const macroApis = new Map<string, MacroSeriesDef>();
    for (const def of MACRO_SERIES_OPTIONS) {
      if (!macroApis.has(def.api)) macroApis.set(def.api, def);
    }
    for (const [api, def] of macroApis) {
      const points =
        def.points === "special" ? "需单独权限（联系 Tushare 管理员开通）" : `积分≥${def.points}`;
      block.createDiv({ cls: "fc-field-hint", text: `${def.group} ${api} —— ${points}` });
    }

    const linkLine = block.createDiv({ cls: "fc-field-hint" });
    linkLine.appendText("积分只是调取门槛，不会消耗；获取办法见 ");
    linkLine.createEl("a", {
      text: "Tushare 积分说明",
      href: "https://tushare.pro/document/1?doc_id=13",
    });
    linkLine.appendText("。");
  }

  private renderPathSettings(containerEl: HTMLElement): void {
    containerEl.createDiv({
      cls: "fc-field-hint",
      text: "从仓库已有文件夹中选择，也可在菜单底部手动输入新路径。",
    });

    // 卡片路径: the three card folders, folded like 缓存路径 below.
    const cardDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    cardDetails.setAttr("open", "");
    cardDetails.createEl("summary", { text: "卡片路径" });

    this.addFolderPathSetting(cardDetails, {
      name: "图表卡片路径",
      desc: "存放图表卡片 Markdown 文件的文件夹（资产叠加、数据计算等卡片默认也放在这里）。",
      value: this.plugin.pluginSettings.cardLibraryPath,
      defaultValue: DEFAULT_SETTINGS.cardLibraryPath,
      onChange: async (value) => {
        this.plugin.pluginSettings.cardLibraryPath = value;
        await this.plugin.saveSettings();
      },
    });

    this.addFolderPathSetting(cardDetails, {
      name: "TradingView Widgets 路径",
      desc: "存放 HTML / TradingView 小组件卡片的文件夹。",
      value: this.plugin.pluginSettings.widgetCardPath,
      defaultValue: DEFAULT_SETTINGS.widgetCardPath,
      onChange: async (value) => {
        this.plugin.pluginSettings.widgetCardPath = value;
        await this.plugin.saveSettings();
      },
    });

    this.addFolderPathSetting(cardDetails, {
      name: "组件路径",
      desc: "存放日历、时间线组件卡片的文件夹。",
      value: this.plugin.pluginSettings.componentCardPath,
      defaultValue: DEFAULT_SETTINGS.componentCardPath,
      onChange: async (value) => {
        this.plugin.pluginSettings.componentCardPath = value;
        await this.plugin.saveSettings();
      },
    });

    const cacheDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    cacheDetails.createEl("summary", { text: "缓存路径（高级）" });

    this.addFolderPathSetting(cacheDetails, {
      name: "数据缓存路径",
      desc: "SQLite 行情/市场数据缓存所在文件夹（会在此目录下创建 ohlcv.db 和 market.db）。",
      value: this.plugin.pluginSettings.dataCachePath,
      defaultValue: DEFAULT_SETTINGS.dataCachePath,
      onChange: async (value) => {
        this.plugin.pluginSettings.dataCachePath = value;
        await this.plugin.saveSettings();
      },
    });

    this.addFolderPathSetting(cacheDetails, {
      name: "股票代码缓存路径",
      desc: "SQLite 股票代码缓存所在文件夹（会在此目录下创建 symbols.db）。",
      value: this.plugin.pluginSettings.symbolCachePath,
      defaultValue: DEFAULT_SETTINGS.symbolCachePath,
      onChange: async (value) => {
        this.plugin.pluginSettings.symbolCachePath = value;
        await this.plugin.saveSettings();
      },
    });

    this.renderCleanupSettings(containerEl);
  }

  // 清理维护: two-step cleanup tools (scan → checklist → confirm) for orphan
  // card files and stale cache data. Scan logic lives in modules/maintenance.ts.
  private renderCleanupSettings(containerEl: HTMLElement): void {
    const details = containerEl.createEl("details", { cls: "fc-settings-sub" });
    details.createEl("summary", { text: "清理维护" });
    details.createDiv({
      cls: "fc-field-hint",
      text: "扫描后先列出清单，勾选确认后再执行删除。",
    });

    new Setting(details)
      .setName("清理孤立卡片文件")
      .setDesc("清理卡片路径下没有被任何画布、笔记链接或数据计算卡片引用的卡片文件（删除后进入回收站）。")
      .addButton((btn) =>
        btn.setButtonText("扫描孤立文件").onClick(() => void this.runOrphanFileCleanup())
      );

    new Setting(details)
      .setName("清理闲置数据缓存")
      .setDesc("清理数据缓存中不再被任何卡片使用的行情、市场数据与宏观/FRED 序列，保持缓存体积合理。")
      .addButton((btn) =>
        btn.setButtonText("扫描闲置缓存").onClick(() => void this.runStaleCacheCleanup())
      );
  }

  private async runOrphanFileCleanup(): Promise<void> {
    new Notice("正在扫描孤立卡片文件…");
    const { cardLibraryPath, widgetCardPath, componentCardPath } = this.plugin.pluginSettings;
    const orphans = await findOrphanCardFiles(this.app, [
      cardLibraryPath,
      widgetCardPath,
      componentCardPath,
    ]);
    if (orphans.length === 0) {
      new Notice("没有发现孤立卡片文件。");
      return;
    }
    new CleanupConfirmModal(this.app, {
      title: "清理孤立卡片文件",
      desc: `以下 ${orphans.length} 个卡片文件没有被任何画布、笔记链接或数据计算卡片引用。取消勾选可保留对应文件。`,
      confirmLabel: "删除文件",
      items: orphans.map((file) => ({ id: file.path, label: file.basename, hint: file.path })),
      onConfirm: async (selected) => {
        for (const item of selected) {
          const file = this.app.vault.getAbstractFileByPath(item.id);
          if (file instanceof TFile) await this.app.fileManager.trashFile(file);
        }
        new Notice(`已删除 ${selected.length} 个孤立卡片文件。`);
      },
    }).open();
  }

  private async runStaleCacheCleanup(): Promise<void> {
    new Notice("正在扫描闲置数据缓存…");
    const used = await collectUsedCacheKeys(this.app);
    const stale = await findStaleCacheEntries(this.plugin.sqliteCache, used);
    if (stale.length === 0) {
      new Notice("没有发现闲置的数据缓存。");
      return;
    }
    const totalRows = stale.reduce((sum, entry) => sum + entry.rows, 0);
    new CleanupConfirmModal(this.app, {
      title: "清理闲置数据缓存",
      desc: `以下 ${stale.length} 组缓存数据（共 ${totalRows} 行）不再被任何卡片使用。清理后对应卡片重新创建时会重新拉取数据。`,
      confirmLabel: "清理缓存",
      items: stale.map((entry, index) => ({
        id: String(index),
        label: entry.label,
        hint: entry.detail,
      })),
      onConfirm: async (selected) => {
        let rows = 0;
        for (const item of selected) {
          const entry = stale[Number(item.id)];
          await deleteStaleCacheEntry(this.plugin.sqliteCache, entry);
          rows += entry.rows;
        }
        new Notice(`已清理 ${selected.length} 组缓存数据（${rows} 行）。`);
      },
    }).open();
  }

  /** Path row: folder suggester dropdown, empty value falls back to the default. */
  private addFolderPathSetting(
    containerEl: HTMLElement,
    options: {
      name: string;
      desc: string;
      value: string;
      defaultValue: string;
      onChange: (value: string) => void | Promise<void>;
    }
  ): void {
    const setting = new Setting(containerEl).setName(options.name).setDesc(options.desc);
    new FolderPathSelect(setting.controlEl, {
      app: this.app,
      value: options.value,
      placeholder: options.defaultValue,
      onChange: (path) => {
        void options.onChange(path.trim() || options.defaultValue);
      },
    });
  }

  // Card-level display config (周期 / 时间范围 / 图表类型 / 主题 / 涨跌色 /
  // 图表高度) lives in each card's unified edit modal — global defaults were
  // deliberately removed to avoid two config sources overriding each other.
  private renderCardSettings(containerEl: HTMLElement): void {
    // 通用设置 open by default; the widget/calendar subgroups fold away.
    const generalDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    generalDetails.setAttr("open", "");
    generalDetails.createEl("summary", { text: "通用设置" });

    new Setting(generalDetails)
      .setName("打开时自动刷新")
      .setDesc("打开文件或画布时自动刷新卡片数据。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.autoRefreshOnOpen).onChange(async (value) => {
          this.plugin.pluginSettings.autoRefreshOnOpen = value;
          await this.plugin.saveSettings();
        })
      );

    const note = generalDetails.createDiv("fc-settings-note");
    note.appendText("卡片级配置（周期 / 时间范围 / 图表类型 / 主题 / 涨跌色 / 图表高度）由各卡片的");
    note.createEl("b", { text: "统合编辑弹窗" });
    note.appendText("独立设置并随卡片保存，此处不再提供全局默认，避免两处配置互相覆盖；新建卡片使用内置默认值。");

    const widgetDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    widgetDetails.createEl("summary", { text: "TradingView Widgets" });

    new Setting(widgetDetails)
      .setName("小组件 iframe 高度")
      .setDesc("HTML / TradingView 小组件在卡片内部渲染时 iframe 的高度（像素）。")
      .addSlider((slider) =>
        slider
          .setLimits(200, 1600, 50)
          .setValue(this.plugin.pluginSettings.widgetIframeHeight)
          .onChange(async (value) => {
            this.plugin.pluginSettings.widgetIframeHeight = value;
            await this.plugin.saveSettings();
          })
      );

    const calendarDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    calendarDetails.createEl("summary", { text: "日历卡片" });

    new Setting(calendarDetails)
      .setName("日记文件夹")
      .setDesc("日历卡片按天查找/创建日记的文件夹。留空则跟随核心「日记」插件的设置，否则默认为「日记」。")
      .addText((text) =>
        text
          .setPlaceholder("日记")
          .setValue(this.plugin.pluginSettings.dailyNotesFolder)
          .onChange(async (value) => {
            this.plugin.pluginSettings.dailyNotesFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(calendarDetails)
      .setName("日记文件名格式")
      .setDesc("日记文件名的日期格式（Moment 格式，如 YYYY-MM-DD）。留空则跟随核心「日记」插件的设置。")
      .addText((text) =>
        text
          .setPlaceholder("YYYY-MM-DD")
          .setValue(this.plugin.pluginSettings.dailyNotesFormat)
          .onChange(async (value) => {
            this.plugin.pluginSettings.dailyNotesFormat = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(calendarDetails)
      .setName("摘要字号")
      .setDesc("日历格子内日记摘要的字号（像素），重新打开卡片后生效。")
      .addSlider((slider) =>
        slider
          .setLimits(10, 24, 1)
          .setValue(this.plugin.pluginSettings.calendarExcerptFontSize)
          .onChange(async (value) => {
            this.plugin.pluginSettings.calendarExcerptFontSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(calendarDetails)
      .setName("日期数字字号")
      .setDesc("日历格子内日期数字的字号（像素），重新打开卡片后生效。")
      .addSlider((slider) =>
        slider
          .setLimits(12, 32, 1)
          .setValue(this.plugin.pluginSettings.calendarDayFontSize)
          .onChange(async (value) => {
            this.plugin.pluginSettings.calendarDayFontSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(calendarDetails)
      .setName("摘要行高")
      .setDesc("日历格子内日记摘要的行高倍数，重新打开卡片后生效。")
      .addSlider((slider) =>
        slider
          .setLimits(1, 3, 0.1)
          .setValue(this.plugin.pluginSettings.calendarExcerptLineHeight)
          .onChange(async (value) => {
            this.plugin.pluginSettings.calendarExcerptLineHeight = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(calendarDetails)
      .setName("摘要最大行数")
      .setDesc("日历格子内日记摘要最多显示的行数，重新打开卡片后生效。")
      .addSlider((slider) =>
        slider
          .setLimits(1, 8, 1)
          .setValue(this.plugin.pluginSettings.calendarExcerptMaxLines)
          .onChange(async (value) => {
            this.plugin.pluginSettings.calendarExcerptMaxLines = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private renderToolbarSettings(containerEl: HTMLElement): void {
    // 外观 open by default; source visibility and button order fold away.
    const lookDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    lookDetails.setAttr("open", "");
    lookDetails.createEl("summary", { text: "外观" });

    new Setting(lookDetails)
      .setName("工具栏位置")
      .setDesc("画布上的竖条浮动工具栏锚定在左侧还是右侧。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("left", "左侧")
          .addOption("right", "右侧")
          .setValue(this.plugin.pluginSettings.toolbarPosition)
          .onChange(async (value) => {
            this.plugin.pluginSettings.toolbarPosition = value as ToolbarPosition;
            await this.plugin.saveSettings();
          })
      );

    new Setting(lookDetails)
      .setName("显示效果")
      .setDesc("工具栏按钮显示为纯图标（悬停显示名称）或文字。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("icon", "图标")
          .addOption("text", "文字")
          .setValue(this.plugin.pluginSettings.toolbarStyle)
          .onChange(async (value) => {
            this.plugin.pluginSettings.toolbarStyle = value as ToolbarStyle;
            await this.plugin.saveSettings();
            // Icon size only applies in icon mode; re-render to flip its
            // disabled state.
            this.display();
          })
      );

    new Setting(lookDetails)
      .setName("图标大小")
      .setDesc(
        this.plugin.pluginSettings.toolbarStyle === "text"
          ? "文字显示效果下不生效（仅图标模式可调）。"
          : "工具栏按钮图标的尺寸（像素）。"
      )
      .addSlider((slider) =>
        slider
          .setLimits(12, 24, 1)
          .setValue(this.plugin.pluginSettings.toolbarIconSize)
          .setDisabled(this.plugin.pluginSettings.toolbarStyle === "text")
          .onChange(async (value) => {
            this.plugin.pluginSettings.toolbarIconSize = value;
            await this.plugin.saveSettings();
          })
      );

    const sourceDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    sourceDetails.createEl("summary", { text: "工具栏显示的数据源" });
    sourceDetails.createDiv({
      cls: "fc-field-hint",
      text: "关闭后对应源不再出现在画布工具栏（命令面板与右键菜单不受影响）。没有配置密钥的收费源建议关闭。",
    });
    for (const id of Object.keys(TOOLBAR_SOURCE_LABELS) as ToolbarSourceId[]) {
      new Setting(sourceDetails).setName(TOOLBAR_SOURCE_LABELS[id]).addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.toolbarSources[id]).onChange(async (value) => {
          this.plugin.pluginSettings.toolbarSources[id] = value;
          await this.plugin.saveSettings();
        })
      );
    }

    const orderDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    orderDetails.createEl("summary", { text: "按钮排序" });
    orderDetails.createDiv({
      cls: "fc-field-hint",
      text: "调整工具栏顶部按钮的先后顺序；「全部刷新」「设置」始终固定在底部。工具栏宽度可在画布上直接拖拽边缘调整。",
    });
    const order = this.plugin.pluginSettings.toolbarOrder;
    order.forEach((id, index) => {
      const row = new Setting(orderDetails).setName(TOOLBAR_ENTRY_LABELS[id]);
      row.addButton((btn) =>
        btn
          .setIcon("arrow-up")
          .setDisabled(index === 0)
          .onClick(async () => {
            [order[index - 1], order[index]] = [order[index], order[index - 1]];
            await this.plugin.saveSettings();
            this.display();
          })
      );
      row.addButton((btn) =>
        btn
          .setIcon("arrow-down")
          .setDisabled(index === order.length - 1)
          .onClick(async () => {
            [order[index], order[index + 1]] = [order[index + 1], order[index]];
            await this.plugin.saveSettings();
            this.display();
          })
      );
    });
  }
}
