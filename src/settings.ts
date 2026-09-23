import { App, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import type StrataBoardPlugin from "./main";
import type { ApiProviderDef, CustomCliDef, CustomSourceDef, ToolbarEntryId, ToolbarPosition, ToolbarSourceId, ToolbarStyle } from "./types";
import { t, setLanguage, type Language } from "./i18n";
import { FolderPathSelect } from "./ui/folder-suggester";
import { CleanupConfirmModal } from "./ui/cleanup-modal";
import { ConfirmModal } from "./ui/confirm-modal";
import { CUSTOM_FORMAT_LABELS, CustomSourceImportModal, CustomSourceModal } from "./ui/custom-source-modal";
import { MIN_REQUEST_INTERVAL_MS } from "./modules/http";
import { AI_CLI_PRESETS, detectCliPath } from "./modules/ai-cli";
import { AiCliEditModal } from "./ui/ai-cli-modal";
import { AiApiEditModal } from "./ui/ai-api-modal";
import {
  collectUsedCacheKeys,
  deleteStaleCacheEntry,
  findOrphanCardFiles,
  findStaleCacheEntries,
} from "./modules/maintenance";

export interface StrataBoardSettings {
  tushareToken: string;
  fredApiKey: string;
  // User-defined custom REST quote sources (数据源设置 → 自定义数据源).
  customSources: CustomSourceDef[];
  // UI language (通用设置 tab); command names only update after reload.
  language: Language;
  // Per-source toolbar visibility (工具栏设置 surfaces these toggles). Only
  // TradingView remains per-source; data inserts all go through 「插入数据」.
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
  // Global minimum interval between outbound data requests (ms), clamped to
  // MIN_REQUEST_INTERVAL_MS. Enforced by modules/http.ts, applied on load/save.
  requestIntervalMs: number;
  widgetIframeHeight: number;
  dailyNotesFolder: string;
  dailyNotesFormat: string;
  calendarExcerptFontSize: number;
  calendarDayFontSize: number;
  calendarExcerptLineHeight: number;
  calendarExcerptMaxLines: number;
  // 显示设置 (卡片与组件 tab): chart-wide display settings applied at render
  // time — a change takes effect the next time a card renders.
  showChartLegend: boolean;
  legendFrostedBackground: boolean;
  // Legend chip opacity (percent 0-100); only applies when
  // legendFrostedBackground is on.
  legendBackgroundOpacity: number;
  showSeriesLatestValue: boolean;
  // Vertex dots on every line-chart data point; off by default (noisy on
  // long series).
  showSeriesPointMarkers: boolean;
  showChartGrid: boolean;
  // Grid line opacity (percent 0-100); only applies when showChartGrid is on.
  gridOpacity: number;
  // AI 助手: which model the chat view uses ("" = first available), manual
  // path overrides per preset CLI command, user-defined CLI entries, and
  // user-configured online API models (OpenAI-compatible endpoints).
  aiCliId: string;
  aiCliPaths: Record<string, string>;
  aiCustomClis: CustomCliDef[];
  aiApiProviders: ApiProviderDef[];
  // Write-capable AI tools (create card / upsert custom source / place on
  // canvas) ask in the chat before running; off = run immediately.
  aiConfirmWrites: boolean;
  // Max tool-call rounds per user message before the loop forces an answer.
  aiMaxRounds: number;
}

export const DEFAULT_SETTINGS: StrataBoardSettings = {
  tushareToken: "",
  fredApiKey: "",
  customSources: [],
  language: "zh",
  toolbarSources: { tradingview: true },
  toolbarStyle: "icon",
  toolbarOrder: ["insert-data", "data-tools", "tradingview", "components", "ai-chat"],
  toolbarIconSize: 16,
  toolbarWidth: 44,
  cardLibraryPath: "金融卡片",
  widgetCardPath: "金融卡片/TradingView Widgets",
  componentCardPath: "金融卡片/组件",
  dataCachePath: "金融卡片/数据缓存",
  symbolCachePath: "金融卡片/股票代码缓存",
  autoRefreshOnOpen: true,
  toolbarPosition: "bottom-left",
  toolbarOffsetX: 16,
  toolbarOffsetY: 16,
  toolbarCollapsed: false,
  symbolListRefreshIntervalDays: 7,
  requestIntervalMs: 500,
  widgetIframeHeight: 400,
  // Empty means "follow the core Daily notes plugin, else built-in defaults".
  dailyNotesFolder: "",
  dailyNotesFormat: "",
  calendarExcerptFontSize: 15,
  calendarDayFontSize: 20,
  calendarExcerptLineHeight: 2,
  calendarExcerptMaxLines: 4,
  showChartLegend: true,
  legendFrostedBackground: true,
  legendBackgroundOpacity: 72,
  showSeriesLatestValue: true,
  showSeriesPointMarkers: false,
  showChartGrid: true,
  gridOpacity: 20,
  aiCliId: "",
  aiCliPaths: {},
  aiCustomClis: [],
  aiApiProviders: [],
  aiConfirmWrites: true,
  aiMaxRounds: 8,
};

// Static source labels for the 工具栏显示 toggles (Chinese keys, translated
// at render time via t()).
const TOOLBAR_SOURCE_LABELS: Record<ToolbarSourceId, string> = {
  tradingview: "TradingView Widget",
};

const TOOLBAR_ENTRY_LABELS: Record<ToolbarEntryId, string> = {
  "insert-data": "插入数据",
  "data-tools": "数据处理",
  tradingview: "TradingView Widget",
  components: "组件",
  "ai-chat": "AI 助手",
};

type SettingsTabId = "general" | "data-source" | "ai" | "paths" | "cards" | "toolbar";

const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: "general", label: "通用设置" },
  { id: "data-source", label: "数据源设置" },
  { id: "ai", label: "AI 助手" },
  { id: "paths", label: "路径设置" },
  { id: "cards", label: "卡片与组件" },
  { id: "toolbar", label: "工具栏设置" },
];

export class StrataBoardSettingTab extends PluginSettingTab {
  plugin: StrataBoardPlugin;
  private activeTab: SettingsTabId = "general";

  constructor(app: App, plugin: StrataBoardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Deep-link entry (AI 助手面板 → 设置按钮): switch to a tab programmatically.
  navigateTo(tab: SettingsTabId): void {
    this.activeTab = tab;
    this.display();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const tabBar = containerEl.createDiv("fc-settings-tabbar");
    for (const tab of SETTINGS_TABS) {
      const button = tabBar.createEl("button", {
        text: t(tab.label),
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
      case "general":
        this.renderGeneralSettings(contentEl);
        break;
      case "data-source":
        this.renderDataSourceSettings(contentEl);
        break;
      case "ai":
        this.renderAiSettings(contentEl);
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

  private renderGeneralSettings(containerEl: HTMLElement): void {
    // Plugin version from manifest.json; release.mjs tags GitHub releases with
    // exactly this version, so the two always match.
    new Setting(containerEl)
      .setName(t("插件版本"))
      .setDesc(this.plugin.manifest.version);

    // Language switch; applies immediately except command-palette names
    // (registered at plugin load).
    new Setting(containerEl)
      .setName(t("语言 / Language"))
      .setDesc(t("切换界面语言，即时生效；命令面板中的命令名在插件加载时注册，需重载插件后更新。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("zh", "中文")
          .addOption("en", "English")
          .setValue(this.plugin.pluginSettings.language)
          .onChange(async (value) => {
            this.plugin.pluginSettings.language = value as Language;
            setLanguage(this.plugin.pluginSettings.language);
            await this.plugin.saveSettings();
            this.display();
            this.plugin.toolbar?.reload();
          })
      );

    new Setting(containerEl)
      .setName(t("打开时自动刷新"))
      .setDesc(t("打开文件或画布时自动刷新卡片数据。"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.autoRefreshOnOpen).onChange(async (value) => {
          this.plugin.pluginSettings.autoRefreshOnOpen = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private renderDataSourceSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("数据源 API 设置")).setHeading();

    // Each keyed source gets its own <details> subgroup.
    const tushareDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    tushareDetails.setAttr("open", "");
    tushareDetails.createEl("summary", { text: t("Tushare 设置") });

    const tushareSetting = new Setting(tushareDetails).setName("Tushare Token");
    tushareSetting.descEl.appendText(t("你的 Tushare Pro API Token。"));
    tushareSetting.descEl.createEl("a", {
      text: t("没有 Token？前往 tushare.pro 申请 →"),
      href: "https://tushare.pro/user/token",
    });
    tushareSetting.addText((text) => {
      text
        .setPlaceholder(t("请输入 Token"))
        .setValue(this.plugin.pluginSettings.tushareToken)
        .onChange(async (value) => {
          this.plugin.pluginSettings.tushareToken = value;
          await this.plugin.saveSettings();
        });
      text.inputEl.addClass("fc-mono");
    });

    const fredDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    fredDetails.setAttr("open", "");
    fredDetails.createEl("summary", { text: t("FRED 设置") });

    const fredSetting = new Setting(fredDetails).setName("FRED API Key");
    fredSetting.descEl.appendText(t("用于获取美联储 FRED 宏观数据（如 DGS10/DGS2），可免费申请："));
    fredSetting.descEl.createEl("a", {
      text: "https://fredaccount.stlouisfed.org/apikeys",
      href: "https://fredaccount.stlouisfed.org/apikeys",
    });
    fredSetting.addText((text) => {
      text
        .setPlaceholder(t("请输入 API Key"))
        .setValue(this.plugin.pluginSettings.fredApiKey)
        .onChange(async (value) => {
          this.plugin.pluginSettings.fredApiKey = value;
          await this.plugin.saveSettings();
        });
      text.inputEl.addClass("fc-mono");
    });

    this.renderCustomSourceSettings(containerEl);

    new Setting(containerEl)
      .setName(t("股票列表刷新间隔（天）"))
      .setDesc(t("多久刷新一次本地股票代码列表缓存。"))
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.pluginSettings.symbolListRefreshIntervalDays)
          .onChange(async (value) => {
            this.plugin.pluginSettings.symbolListRefreshIntervalDays = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("请求最小间隔（毫秒）"))
      .setDesc(t("所有数据请求按此间隔串行发出，间隔过低可能被数据平台限流或封禁 IP。下限 200ms（保守安全值），默认 500ms。"))
      .addSlider((slider) =>
        slider
          .setLimits(MIN_REQUEST_INTERVAL_MS, 2000, 50)
          .setValue(Math.max(MIN_REQUEST_INTERVAL_MS, this.plugin.pluginSettings.requestIntervalMs))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.pluginSettings.requestIntervalMs = value;
            await this.plugin.saveSettings();
          })
      );

    // Static disclaimer (the former first-load modal): third-party endpoints
    // are user-configured, so the terms live here permanently instead.
    containerEl.createDiv({
      cls: "fc-field-hint fc-hint-mt",
      text: t("免责声明：本插件仅作为数据展示工具，所有第三方接口均由用户自行配置/调用，数据版权归原平台所有，不得用于商业用途。"),
    });
    containerEl.createDiv({
      cls: "fc-field-hint",
      text: t("本插件仅提供数据接入框架，用户需自行遵守各数据平台的服务条款。"),
    });
  }

  // AI 助手 settings: online API models, local AI CLI detection, default
  // picker, custom CLI entries, and agent-loop behavior. CLI detection
  // probes run async after the tab renders.
  private renderAiSettings(containerEl: HTMLElement): void {
    containerEl.createDiv({
      cls: "fc-field-hint",
      text: t("AI 助手可以使用在线 API 模型（DeepSeek、GPT 等 OpenAI 兼容接口）或你本机已安装的 AI 命令行工具（CLI）运行，插件不内置任何 AI 服务或密钥。在侧边栏「AI 助手」面板对话，AI 可调用插件能力查询数据、创建卡片、协助配置数据源。"),
    });

    const apiDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    apiDetails.setAttr("open", "");
    apiDetails.createEl("summary", { text: t("在线 API 模型") });
    apiDetails.createDiv({
      cls: "fc-field-hint",
      text: t("接入任何兼容 OpenAI Chat Completions 接口的在线模型（DeepSeek、GPT、Kimi、通义千问等）；API Key 由你自行申请，仅保存在本库设置中。"),
    });
    for (const def of this.plugin.pluginSettings.aiApiProviders) {
      const setting = new Setting(apiDetails).setName(def.name).setDesc(`${def.model} · ${def.baseUrl}`);
      setting.addButton((btn) =>
        btn.setButtonText(t("编辑")).onClick(() => {
          new AiApiEditModal(this.app, def, (result) => {
            const list = this.plugin.pluginSettings.aiApiProviders;
            const index = list.findIndex((p) => p.id === result.id);
            if (index >= 0) list[index] = result;
            void this.plugin.saveSettings().then(() => this.display());
          }).open();
        })
      );
      setting.addButton((btn) =>
        btn
          .setButtonText(t("删除"))
          .setWarning()
          .onClick(() => {
            new ConfirmModal(this.app, t("删除 API 模型「{name}」？", { name: def.name }), () => {
              this.plugin.pluginSettings.aiApiProviders = this.plugin.pluginSettings.aiApiProviders.filter(
                (p) => p.id !== def.id
              );
              void this.plugin.saveSettings().then(() => this.display());
            }).open();
          })
      );
    }
    new Setting(apiDetails).addButton((btn) =>
      btn
        .setButtonText(t("添加 API 模型"))
        .setCta()
        .onClick(() => {
          new AiApiEditModal(this.app, undefined, (result) => {
            this.plugin.pluginSettings.aiApiProviders.push(result);
            void this.plugin.saveSettings().then(() => this.display());
          }).open();
        })
    );

    const detectedDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    detectedDetails.setAttr("open", "");
    detectedDetails.createEl("summary", { text: t("本机 AI 命令行工具") });
    const detectedEl = detectedDetails.createDiv();
    new Setting(detectedDetails)
      .addButton((btn) =>
        btn.setButtonText(t("重新检测")).onClick(async () => {
          await this.plugin.redetectAiClis();
          this.display();
        })
      );

    void (async () => {
      detectedEl.createDiv({ cls: "fc-field-hint", text: t("正在检测…") });
      const rows = await Promise.all(
        AI_CLI_PRESETS.map(async (preset) => {
          const override = this.plugin.pluginSettings.aiCliPaths[preset.command]?.trim() ?? "";
          const path = override || (await detectCliPath(preset.command));
          return { preset, override, path };
        })
      );
      detectedEl.empty();
      for (const { preset, override, path } of rows) {
        const setting = new Setting(detectedEl).setName(preset.label).setDesc(
          path
            ? override
              ? t("手动路径：{path}", { path })
              : t("已检测到：{path}", { path })
            : t("未检测到（可手动指定可执行文件路径）")
        );
        setting.addText((text) => {
          text
            .setPlaceholder(t("路径覆盖（可选）"))
            .setValue(override)
            .onChange(async (value) => {
              const trimmed = value.trim();
              if (trimmed) {
                this.plugin.pluginSettings.aiCliPaths[preset.command] = trimmed;
              } else {
                delete this.plugin.pluginSettings.aiCliPaths[preset.command];
              }
              await this.plugin.saveSettings();
            });
          text.inputEl.addClass("fc-mono");
        });
      }
    })();

    const defaultSetting = new Setting(containerEl)
      .setName(t("默认 AI"))
      .setDesc(t("侧边栏 AI 助手默认使用的模型，面板顶栏可随时切换。"));
    void this.plugin.listAiClis().then((clis) => {
      defaultSetting.addDropdown((dropdown) => {
        if (clis.length === 0) {
          dropdown.addOption("", t("（未配置可用模型）"));
        }
        for (const cli of clis) {
          dropdown.addOption(cli.id, cli.label);
        }
        const current = this.plugin.pluginSettings.aiCliId;
        dropdown.setValue(clis.some((c) => c.id === current) ? current : "");
        dropdown.onChange(async (value) => {
          this.plugin.pluginSettings.aiCliId = value;
          await this.plugin.saveSettings();
        });
      });
    });

    const customDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    customDetails.createEl("summary", { text: t("自定义 AI 命令") });
    customDetails.createDiv({
      cls: "fc-field-hint",
      text: t("任何「接收一条提示词、把回答打印到标准输出」的命令行工具都可接入；参数模板中用 {prompt} 表示提示词位置。"),
    });
    for (const def of this.plugin.pluginSettings.aiCustomClis) {
      const setting = new Setting(customDetails)
        .setName(def.name)
        .setDesc(`${def.command} ${def.argsTemplate.join(" ")}`);
      setting.addButton((btn) =>
        btn.setButtonText(t("编辑")).onClick(() => {
          new AiCliEditModal(this.app, def, (result) => {
            const list = this.plugin.pluginSettings.aiCustomClis;
            const index = list.findIndex((c) => c.id === result.id);
            if (index >= 0) list[index] = result;
            void this.plugin.saveSettings().then(() => this.display());
          }).open();
        })
      );
      setting.addButton((btn) =>
        btn
          .setButtonText(t("删除"))
          .setWarning()
          .onClick(() => {
            new ConfirmModal(this.app, t("删除自定义 AI 命令「{name}」？", { name: def.name }), () => {
              this.plugin.pluginSettings.aiCustomClis = this.plugin.pluginSettings.aiCustomClis.filter(
                (c) => c.id !== def.id
              );
              void this.plugin.saveSettings().then(() => this.display());
            }).open();
          })
      );
    }
    new Setting(customDetails).addButton((btn) =>
      btn
        .setButtonText(t("添加 AI 命令"))
        .setCta()
        .onClick(() => {
          new AiCliEditModal(this.app, undefined, (result) => {
            this.plugin.pluginSettings.aiCustomClis.push(result);
            void this.plugin.saveSettings().then(() => this.display());
          }).open();
        })
    );

    new Setting(containerEl)
      .setName(t("AI 写操作需确认"))
      .setDesc(t("开启后，AI 创建卡片、放上画布、修改数据源等写操作会先在对话中请求你的允许。"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.aiConfirmWrites).onChange(async (value) => {
          this.plugin.pluginSettings.aiConfirmWrites = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("单轮最大工具调用轮数"))
      .setDesc(t("AI 为回答一条消息最多连续调用工具的次数，防止失控循环。"))
      .addSlider((slider) =>
        slider
          .setLimits(3, 20, 1)
          .setValue(this.plugin.pluginSettings.aiMaxRounds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.pluginSettings.aiMaxRounds = value;
            await this.plugin.saveSettings();
          })
      );
  }

  // 自定义数据源 management: the plugin ships no URLs — each entry is a
  // user-configured REST/JSON endpoint template (see CustomSourceModal).
  // Toggling 启用 gates pickers/toolbar entries; deleting a source breaks
  // cards that reference it (they render the missing-source error).
  private renderCustomSourceSettings(containerEl: HTMLElement): void {
    const details = containerEl.createEl("details", { cls: "fc-settings-sub" });
    details.setAttr("open", "");
    details.createEl("summary", { text: t("自定义数据源") });
    details.createDiv({
      cls: "fc-field-hint",
      text: t("自行配置任意 RESTful / JSON 数据接口：粘贴完整 URL 即可自动生成模板（支持 {code} {start} {end} {startIso} {endIso} 占位符），K 线行情、单值序列、固定报表均可接入，响应格式自动识别。"),
    });

    for (const def of this.plugin.pluginSettings.customSources) {
      const setting = new Setting(details)
        .setName(def.name)
        .setDesc(`${t(CUSTOM_FORMAT_LABELS[def.format])} · ${def.klineUrl}`);
      setting.addToggle((toggle) =>
        toggle.setValue(def.enabled).onChange(async (value) => {
          def.enabled = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );
      setting.addButton((btn) => btn.setButtonText(t("编辑")).onClick(() => this.openCustomSourceModal(def)));
      setting.addButton((btn) =>
        btn
          .setButtonText(t("删除"))
          .setWarning()
          .onClick(() => {
            new ConfirmModal(this.app, t("删除自定义数据源「{name}」？引用它的卡片将无法加载。", { name: def.name }), () => {
              const sources = this.plugin.pluginSettings.customSources;
              this.plugin.pluginSettings.customSources = sources.filter((s) => s.id !== def.id);
              void this.plugin.saveSettings().then(() => this.display());
            }).open();
          })
      );
    }

    new Setting(details)
      .addButton((btn) =>
        btn
          .setButtonText(t("添加数据源"))
          .setCta()
          .onClick(() => this.openCustomSourceModal())
      )
      .addButton((btn) =>
        btn.setButtonText(t("导入")).onClick(() => {
          new CustomSourceImportModal(this.app, (defs) => {
            this.plugin.pluginSettings.customSources.push(...defs);
            void this.plugin.saveSettings().then(() => {
              new Notice(t("导入成功：新增 {n} 个数据源。", { n: defs.length }));
              this.display();
            });
          }).open();
        })
      )
      .addButton((btn) =>
        btn.setButtonText(t("导出")).onClick(() => {
          const sources = this.plugin.pluginSettings.customSources;
          if (sources.length === 0) {
            new Notice(t("没有可导出的自定义数据源。"));
            return;
          }
          void navigator.clipboard.writeText(JSON.stringify(sources, null, 2)).then(
            () => new Notice(t("已导出 {n} 个数据源到剪贴板。", { n: sources.length })),
            () => new Notice(t("导出失败：无法访问剪贴板。")),
          );
        })
      );
  }

  private openCustomSourceModal(def?: CustomSourceDef): void {
    // The wizard embeds the source-assist chat when a local AI CLI is
    // configured; otherwise it falls back to copyable prompts.
    void this.plugin.listAiClis().then((clis) => {
      new CustomSourceModal(this.app, def, (result) => {
        const sources = this.plugin.pluginSettings.customSources;
        const index = sources.findIndex((s) => s.id === result.id);
        if (index >= 0) {
          sources[index] = result;
        } else {
          sources.push(result);
        }
        void this.plugin.saveSettings().then(() => this.display());
      }, {
        clis,
        cliId: this.plugin.pluginSettings.aiCliId,
        maxRounds: this.plugin.pluginSettings.aiMaxRounds,
        openAiSettings: () => this.navigateTo("ai"),
      }).open();
    });
  }

  private renderPathSettings(containerEl: HTMLElement): void {
    containerEl.createDiv({
      cls: "fc-field-hint",
      text: t("从仓库已有文件夹中选择，也可在菜单底部手动输入新路径。"),
    });

    // 卡片路径: the three card folders, folded like 缓存路径 below.
    const cardDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    cardDetails.setAttr("open", "");
    cardDetails.createEl("summary", { text: t("卡片路径") });

    this.addFolderPathSetting(cardDetails, {
      name: t("图表卡片路径"),
      desc: t("存放图表卡片 Markdown 文件的文件夹（资产叠加、数据计算等卡片默认也放在这里）。"),
      value: this.plugin.pluginSettings.cardLibraryPath,
      defaultValue: DEFAULT_SETTINGS.cardLibraryPath,
      onChange: async (value) => {
        this.plugin.pluginSettings.cardLibraryPath = value;
        await this.plugin.saveSettings();
      },
    });

    this.addFolderPathSetting(cardDetails, {
      name: t("TradingView Widgets 路径"),
      desc: t("存放 HTML / TradingView 小组件卡片的文件夹。"),
      value: this.plugin.pluginSettings.widgetCardPath,
      defaultValue: DEFAULT_SETTINGS.widgetCardPath,
      onChange: async (value) => {
        this.plugin.pluginSettings.widgetCardPath = value;
        await this.plugin.saveSettings();
      },
    });

    this.addFolderPathSetting(cardDetails, {
      name: t("组件路径"),
      desc: t("存放日历、时间线组件卡片的文件夹。"),
      value: this.plugin.pluginSettings.componentCardPath,
      defaultValue: DEFAULT_SETTINGS.componentCardPath,
      onChange: async (value) => {
        this.plugin.pluginSettings.componentCardPath = value;
        await this.plugin.saveSettings();
      },
    });

    const cacheDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    cacheDetails.createEl("summary", { text: t("缓存路径（高级）") });

    this.addFolderPathSetting(cacheDetails, {
      name: t("数据缓存路径"),
      desc: t("SQLite 行情/市场数据缓存所在文件夹（会在此目录下创建 ohlcv.db 和 market.db）。"),
      value: this.plugin.pluginSettings.dataCachePath,
      defaultValue: DEFAULT_SETTINGS.dataCachePath,
      onChange: async (value) => {
        this.plugin.pluginSettings.dataCachePath = value;
        await this.plugin.saveSettings();
      },
    });

    this.addFolderPathSetting(cacheDetails, {
      name: t("股票代码缓存路径"),
      desc: t("SQLite 股票代码缓存所在文件夹（会在此目录下创建 symbols.db）。"),
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
    details.createEl("summary", { text: t("清理维护") });
    details.createDiv({
      cls: "fc-field-hint",
      text: t("扫描后先列出清单，勾选确认后再执行删除。"),
    });

    new Setting(details)
      .setName(t("清理孤立卡片文件"))
      .setDesc(t("清理卡片路径下没有被任何画布、笔记链接或数据计算卡片引用的卡片文件（删除后进入回收站）。"))
      .addButton((btn) =>
        btn.setButtonText(t("扫描孤立文件")).onClick(() => void this.runOrphanFileCleanup())
      );

    new Setting(details)
      .setName(t("清理闲置数据缓存"))
      .setDesc(t("清理数据缓存中不再被任何卡片使用的行情、市场数据与宏观/FRED 序列，保持缓存体积合理。"))
      .addButton((btn) =>
        btn.setButtonText(t("扫描闲置缓存")).onClick(() => void this.runStaleCacheCleanup())
      );
  }

  private async runOrphanFileCleanup(): Promise<void> {
    new Notice(t("正在扫描孤立卡片文件…"));
    const { cardLibraryPath, widgetCardPath, componentCardPath } = this.plugin.pluginSettings;
    const orphans = await findOrphanCardFiles(this.app, [
      cardLibraryPath,
      widgetCardPath,
      componentCardPath,
    ]);
    if (orphans.length === 0) {
      new Notice(t("没有发现孤立卡片文件。"));
      return;
    }
    new CleanupConfirmModal(this.app, {
      title: t("清理孤立卡片文件"),
      desc: t("以下 {n} 个卡片文件没有被任何画布、笔记链接或数据计算卡片引用。取消勾选可保留对应文件。", { n: orphans.length }),
      confirmLabel: t("删除文件"),
      items: orphans.map((file) => ({ id: file.path, label: file.basename, hint: file.path })),
      onConfirm: async (selected) => {
        for (const item of selected) {
          const file = this.app.vault.getAbstractFileByPath(item.id);
          if (file instanceof TFile) await this.app.fileManager.trashFile(file);
        }
        new Notice(t("已删除 {n} 个孤立卡片文件。", { n: selected.length }));
      },
    }).open();
  }

  private async runStaleCacheCleanup(): Promise<void> {
    new Notice(t("正在扫描闲置数据缓存…"));
    const used = await collectUsedCacheKeys(this.app);
    const stale = await findStaleCacheEntries(this.plugin.sqliteCache, used);
    if (stale.length === 0) {
      new Notice(t("没有发现闲置的数据缓存。"));
      return;
    }
    const totalRows = stale.reduce((sum, entry) => sum + entry.rows, 0);
    new CleanupConfirmModal(this.app, {
      title: t("清理闲置数据缓存"),
      desc: t("以下 {n} 组缓存数据（共 {rows} 行）不再被任何卡片使用。清理后对应卡片重新创建时会重新拉取数据。", { n: stale.length, rows: totalRows }),
      confirmLabel: t("清理缓存"),
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
        new Notice(t("已清理 {n} 组缓存数据（{rows} 行）。", { n: selected.length, rows }));
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
    const widgetDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    widgetDetails.createEl("summary", { text: "TradingView Widgets" });

    new Setting(widgetDetails)
      .setName(t("小组件 iframe 高度"))
      .setDesc(t("HTML / TradingView 小组件在卡片内部渲染时 iframe 的高度（像素）。"))
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
    calendarDetails.createEl("summary", { text: t("日历卡片") });

    new Setting(calendarDetails)
      .setName(t("日记文件夹"))
      .setDesc(t("日历卡片按天查找/创建日记的文件夹。留空则跟随核心「日记」插件的设置，否则默认为「日记」。"))
      .addText((text) =>
        text
          .setPlaceholder(t("日记"))
          .setValue(this.plugin.pluginSettings.dailyNotesFolder)
          .onChange(async (value) => {
            this.plugin.pluginSettings.dailyNotesFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(calendarDetails)
      .setName(t("日记文件名格式"))
      .setDesc(t("日记文件名的日期格式（Moment 格式，如 YYYY-MM-DD）。留空则跟随核心「日记」插件的设置。"))
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
      .setName(t("摘要字号"))
      .setDesc(t("日历格子内日记摘要的字号（像素），重新打开卡片后生效。"))
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
      .setName(t("日期数字字号"))
      .setDesc(t("日历格子内日期数字的字号（像素），重新打开卡片后生效。"))
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
      .setName(t("摘要行高"))
      .setDesc(t("日历格子内日记摘要的行高倍数，重新打开卡片后生效。"))
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
      .setName(t("摘要最大行数"))
      .setDesc(t("日历格子内日记摘要最多显示的行数，重新打开卡片后生效。"))
      .addSlider((slider) =>
        slider
          .setLimits(1, 8, 1)
          .setValue(this.plugin.pluginSettings.calendarExcerptMaxLines)
          .onChange(async (value) => {
            this.plugin.pluginSettings.calendarExcerptMaxLines = value;
            await this.plugin.saveSettings();
          })
      );

    const chartDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    chartDetails.createEl("summary", { text: t("显示设置") });
    chartDetails.createDiv({
      cls: "fc-settings-note",
      text: t("以下为全局默认显示设置，各卡片可在编辑弹窗的「显示设置」中单独覆盖。"),
    });

    new Setting(chartDetails)
      .setName(t("显示图表图例"))
      .setDesc(t("K 线卡的十字光标图例（开/高/低/收/涨跌/量/均线）和系列图的图例。"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.showChartLegend).onChange(async (value) => {
          this.plugin.pluginSettings.showChartLegend = value;
          await this.plugin.saveSettings();
        })
      );

    // The opacity slider is only meaningful while 图例半透明背景 is on; the
    // toggle flips its disabled state (the Setting is created just below,
    // hence the closure variable).
    let legendOpacitySetting: Setting | null = null;
    new Setting(chartDetails)
      .setName(t("图例半透明背景"))
      .setDesc(t("关闭后图例退回无背景、无模糊的纯文字样式。"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.legendFrostedBackground).onChange(async (value) => {
          this.plugin.pluginSettings.legendFrostedBackground = value;
          await this.plugin.saveSettings();
          legendOpacitySetting?.setDisabled(!value);
        })
      );

    legendOpacitySetting = new Setting(chartDetails)
      .setName(t("图例背景透明度"))
      .setDesc(t("图例背景的不透明程度，仅在选择半透明背景时生效。"))
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 1)
          .setValue(this.plugin.pluginSettings.legendBackgroundOpacity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.pluginSettings.legendBackgroundOpacity = value;
            await this.plugin.saveSettings();
          })
      );
    legendOpacitySetting.setDisabled(!this.plugin.pluginSettings.legendFrostedBackground);

    new Setting(chartDetails)
      .setName(t("系列图最新值标记"))
      .setDesc(t("系列图在右轴显示最新值标签，单线卡叠加最新值虚线。"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.showSeriesLatestValue).onChange(async (value) => {
          this.plugin.pluginSettings.showSeriesLatestValue = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(chartDetails)
      .setName(t("折线图数据点标记"))
      .setDesc(t("在折线的每个数据点上绘制圆点；数据点较多时会显得密集。"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.showSeriesPointMarkers).onChange(async (value) => {
          this.plugin.pluginSettings.showSeriesPointMarkers = value;
          await this.plugin.saveSettings();
        })
      );

    // Same linkage as the legend slider: 网格线透明度 only applies while
    // 显示网格线 is on.
    let gridOpacitySetting: Setting | null = null;
    new Setting(chartDetails)
      .setName(t("显示网格线"))
      .setDesc(t("图表背景的水平/垂直网格虚线。"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.showChartGrid).onChange(async (value) => {
          this.plugin.pluginSettings.showChartGrid = value;
          await this.plugin.saveSettings();
          gridOpacitySetting?.setDisabled(!value);
        })
      );

    gridOpacitySetting = new Setting(chartDetails)
      .setName(t("网格线透明度"))
      .setDesc(t("网格线的明显程度。"))
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 1)
          .setValue(this.plugin.pluginSettings.gridOpacity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.pluginSettings.gridOpacity = value;
            await this.plugin.saveSettings();
          })
      );
    gridOpacitySetting.setDisabled(!this.plugin.pluginSettings.showChartGrid);

    const note = containerEl.createDiv("fc-settings-note");
    note.appendText(t("卡片级配置（周期 / 时间范围 / 图表类型 / 主题 / 涨跌色 / 图表高度）由各卡片的"));
    note.createEl("b", { text: t("统合编辑弹窗") });
    note.appendText(t("独立设置并随卡片保存，此处不再提供全局默认，避免两处配置互相覆盖；新建卡片使用内置默认值。"));
  }

  private renderToolbarSettings(containerEl: HTMLElement): void {
    // 外观 open by default; source visibility and button order fold away.
    const lookDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    lookDetails.setAttr("open", "");
    lookDetails.createEl("summary", { text: t("外观") });

    new Setting(lookDetails)
      .setName(t("工具栏位置"))
      .setDesc(t("画布上的竖条浮动工具栏锚定在哪个角落（默认左下，避免遮挡画布返回按钮）；也可以直接拖动手柄移动。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("bottom-left", t("左下角"))
          .addOption("bottom-right", t("右下角"))
          .addOption("top-left", t("左上角"))
          .addOption("top-right", t("右上角"))
          .setValue(this.plugin.pluginSettings.toolbarPosition)
          .onChange(async (value) => {
            this.plugin.pluginSettings.toolbarPosition = value as ToolbarPosition;
            await this.plugin.saveSettings();
          })
      );

    new Setting(lookDetails)
      .setName(t("显示效果"))
      .setDesc(t("工具栏按钮显示为纯图标（悬停显示名称）或文字。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("icon", t("图标"))
          .addOption("text", t("文字"))
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
      .setName(t("图标大小"))
      .setDesc(
        this.plugin.pluginSettings.toolbarStyle === "text"
          ? t("文字显示效果下不生效（仅图标模式可调）。")
          : t("工具栏按钮图标的尺寸（像素）。")
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
    sourceDetails.createEl("summary", { text: t("工具栏显示的数据源") });
    sourceDetails.createDiv({
      cls: "fc-field-hint",
      text: t("关闭后对应入口不再出现在画布工具栏（命令面板与右键菜单不受影响）。其余数据入口统一走「插入数据」。"),
    });
    for (const id of Object.keys(TOOLBAR_SOURCE_LABELS) as ToolbarSourceId[]) {
      new Setting(sourceDetails).setName(t(TOOLBAR_SOURCE_LABELS[id])).addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.toolbarSources[id]).onChange(async (value) => {
          this.plugin.pluginSettings.toolbarSources[id] = value;
          await this.plugin.saveSettings();
        })
      );
    }

    const orderDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    orderDetails.createEl("summary", { text: t("按钮排序") });
    orderDetails.createDiv({
      cls: "fc-field-hint",
      text: t("调整工具栏顶部按钮的先后顺序；「全部刷新」「设置」始终排在最后。工具栏位置可拖拽手柄移动，宽度可拖拽边缘调整。"),
    });
    const order = this.plugin.pluginSettings.toolbarOrder;
    order.forEach((id, index) => {
      const row = new Setting(orderDetails).setName(t(TOOLBAR_ENTRY_LABELS[id]));
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
