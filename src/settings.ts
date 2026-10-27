import { App, Menu, Modal, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import { setTooltip } from "./ui/tooltip";
import type StrataBoardPlugin from "./main";
import type { ChartThemeDefault, CustomSourceDef, IndicatorGroup, ToolbarPosition } from "./types";
import { DEFAULT_FALL_COLOR, DEFAULT_RISE_COLOR, sourceNeedsApiKey, cacheAssetKey } from "./types";
import { t, setLanguage, type Language } from "./i18n";
import { FolderPathSelect } from "./ui/folder-suggester";
import { CleanupConfirmModal } from "./ui/cleanup-modal";
import { ConfirmModal } from "./ui/confirm-modal";
import { TextInputModal } from "./ui/text-input-modal";
import { CustomSourceModal } from "./ui/custom-source-modal";
import { CredentialSyncPasswordModal } from "./ui/credential-sync-modal";
import { CsvSourceModal } from "./ui/csv-source-modal";
import { IndicatorGroupModal, mergeImportedGroups, parseImportedGroups } from "./ui/indicator-group-modal";
import { IndicatorEditModal } from "./ui/indicator-edit-modal";
import { MIN_REQUEST_INTERVAL_MS } from "./modules/http";
import {
  collectUsedCacheKeys,
  deleteStaleCacheEntry,
  findOrphanCardFiles,
  findStaleCacheEntries,
  repairCards,
  scanCardRepairs,
  type CardRepairReport,
} from "./modules/maintenance";
import { getScriptProvenance, isScriptSource, syncScriptSources } from "./modules/script-sources";
import { ScriptDatasetsModal } from "./ui/script-datasets-modal";
import {
  runCardRefMigration,
  scanLegacyCardRefs,
  type CardRefMigrationReport,
  type CardRefScanResult,
} from "./modules/card-ref-migration";
import { syncIndicatorFiles, getIndicatorLoadErrors, getUnapprovedIndicators } from "./modules/indicators/loader";
import { syncIndicatorGroupToCards } from "./modules/indicator-group-sync";
import { getIndicatorRuntimeErrors } from "./modules/indicators/compute";
import { indicatorRegistry } from "./modules/indicators/registry";
import { ensureFolder } from "./modules/daily-notes";
import { applyInfoDescs } from "./ui/info-desc";
import { openPluginSettings, type MenuItemWithSubmenu } from "./utils/obsidian-internals";
import { normalizePath, sanitizeFileNamePart } from "./utils/slug";
import { formatDateTime } from "./utils/date";
import { ChoiceModal } from "./ui/choice-modal";
import { paletteColor } from "./modules/toolbar";
import { clearSourceHealth, getSourceHealth } from "./modules/source-health";

// Human-readable byte size for the 诊断与运行环境 cache rows.
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export interface StrataBoardSettings {
  // User-defined custom REST quote sources (数据源 tab → 自定义数据源).
  customSources: CustomSourceDef[];
  // UI language (通用 tab); command names only update after reload.
  language: Language;
  // Unified search pick history: the sensitive minimum (name/code/source id
  // only), newest first.
  searchHistory: { name: string; tsCode: string; sourceId?: string }[];
  // 凭据命名: user-given labels for credentials, keyed by credentialId. Not a
  // secret — shown in the credential picker dropdown.
  credentialNames: Record<string, string>;
  // Sync only ciphertext under the plugin's credentials folder. The password
  // and data key are never persisted in data.json.
  credentialSyncEnabled: boolean;
  cardLibraryPath: string;
  widgetCardPath: string;
  componentCardPath: string;
  // 本地脚本: folder holding user Python scripts; their CSV outputs land in
  // its output/ subfolder and are auto-registered as csv custom sources.
  scriptFolderPath: string;
  // 本地脚本: script paths (relative to scriptFolderPath, e.g.
  // "macro/cpi.py") the user disabled in the script manager.
  disabledScripts: string[];
  // 本地脚本: absolute path of the Python interpreter used to run scripts.
  // Spawned directly (no shell); empty = scripts cannot run.
  pythonInterpreterPath: string;
  // SHA-256 of each Python script whose current contents the user approved,
  // keyed by the script's resolved REAL path. A rename/move or content change
  // requires approval again.
  approvedScriptHashes: Record<string, string>;
  // 本地脚本: output CSV filePaths already processed by syncScriptSources —
  // a file is registered at most once, so a source the user deleted is never
  // rebuilt.
  seenScriptOutputs: string[];
  // 指标: folder holding user custom-indicator .js files (oakscriptjs
  // contract); synced into the indicator registry on load and on changes.
  indicatorFolderPath: string;
  // 指标: indicator file paths (relative to indicatorFolderPath) the user
  // disabled in the 指标 tab.
  disabledIndicators: string[];
  // SHA-256 of each indicator file after stripping a leading BOM and
  // normalizing line endings, keyed by vault path. A rename or other content
  // change requires approval again; unapproved files are never executed.
  approvedIndicatorHashes: Record<string, string>;
  indicatorOverrides: Record<string, { name?: string; description?: string; defaultInputs?: Record<string, unknown> }>;
  // 指标 → 指标组: named bundles of indicator instances. Applying a group to
  // a card expands it into the card's own indicators list with a card-local
  // group label; edits here are synced back to those cards (see
  // modules/indicator-group-sync.ts).
  indicatorGroups: IndicatorGroup[];
  // 指标: global switch for the overlay (compare) card correlation badge.
  // Off hides the badge everywhere; a card can still opt out individually
  // while this is on (editor 显示相关系数 toggle / YAML `correlation: false`).
  showOverlayCorrelation: boolean;
  // One-shot flag for the cardPath→cardId reference upgrade: false until a
  // scan proves the vault clean (startup probe, or the 清理维护 dry-run), the
  // upgrade runs with nothing left behind, or the user explicitly marks it
  // complete. While false, a banner is shown above 清理维护.
  cardRefsUpgraded: boolean;
  dataCachePath: string;
  symbolCachePath: string;
  autoRefreshOnOpen: boolean;
  toolbarPosition: ToolbarPosition;
  toolbarOffsetX: number;
  toolbarOffsetY: number;
  // One-shot UI hints, persisted once shown so they never reappear.
  toolbarHintShown: boolean;
  chartModeHintShown: boolean;
  // Global minimum interval between outbound data requests (ms), clamped to
  // MIN_REQUEST_INTERVAL_MS. Enforced by modules/http.ts, applied on load/save.
  requestIntervalMs: number;
  // Loopback http origins (scheme+host+port) the user explicitly confirmed
  // for plaintext requests (utils/url-policy.ts); everything else over http
  // is rejected.
  allowedLoopbackHttpOrigins: string[];
  widgetIframeHeight: number;
  dailyNotesFolder: string;
  dailyNotesFormat: string;
  calendarExcerptFontSize: number;
  calendarDayFontSize: number;
  calendarExcerptLineHeight: number;
  calendarExcerptMaxLines: number;
  // 显示设置 (通用 tab): chart-wide display settings applied at render
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
  // Global candlestick/series rise & fall colors (applied to every chart).
  riseColor: string;
  fallColor: string;
  // Default 图表主题 for newly created cards ("obsidian" writes no theme field).
  chartThemeDefault: ChartThemeDefault;
}

export const DEFAULT_SETTINGS: StrataBoardSettings = {
  customSources: [],
  language: "zh",
  searchHistory: [],
  credentialNames: {},
  credentialSyncEnabled: false,
  cardLibraryPath: "金融卡片",
  widgetCardPath: "金融卡片/TradingView Widgets",
  componentCardPath: "金融卡片/组件",
  scriptFolderPath: "金融卡片/脚本",
  disabledScripts: [],
  pythonInterpreterPath: "",
  approvedScriptHashes: {},
  seenScriptOutputs: [],
  indicatorFolderPath: "指标",
  disabledIndicators: [],
  approvedIndicatorHashes: {},
  indicatorOverrides: {},
  indicatorGroups: [],
  showOverlayCorrelation: true,
  cardRefsUpgraded: false,
  dataCachePath: "金融卡片/数据缓存",
  symbolCachePath: "金融卡片/股票代码缓存",
  autoRefreshOnOpen: true,
  toolbarPosition: "bottom-left",
  toolbarOffsetX: 16,
  toolbarOffsetY: 16,
  toolbarHintShown: false,
  chartModeHintShown: false,
  requestIntervalMs: 1000,
  allowedLoopbackHttpOrigins: [],
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
  riseColor: DEFAULT_RISE_COLOR,
  fallColor: DEFAULT_FALL_COLOR,
  chartThemeDefault: "obsidian",
};

type SettingsTabId = "general" | "data-sources" | "indicators" | "advanced";

// Optional hasContent lets a tab hide itself when it would render nothing;
// every tab currently has content, but empty shells never reach the tabbar.
const SETTINGS_TABS: { id: SettingsTabId; label: string; hasContent?: () => boolean }[] = [
  { id: "general", label: "通用" },
  { id: "data-sources", label: "数据源" },
  { id: "indicators", label: "指标" },
  { id: "advanced", label: "高级" },
];

// Set by openSettingsTab and consumed by the next display() so the settings
// window opens directly on the requested tab.
let pendingTab: SettingsTabId | null = null;

export function openSettingsTab(app: App, tab: SettingsTabId): void {
  pendingTab = tab;
  openPluginSettings(app, "strataboard");
}

// Opens the source dialog for the settings page's 添加/编辑 buttons. A draft
// WITHOUT an id opens as a new source (the dialog mints the id itself); one
// WITH an id edits that source (upsert replaces by id on save). format "csv"
// routes to the CSV dialog. Saving runs through the dialog's own
// probe/validation/credential UI.
export function openPrefilledSourceModal(
  app: App,
  plugin: StrataBoardPlugin,
  draft: Partial<CustomSourceDef> | undefined,
  onSaved?: () => void
): void {
  const expectedExistingSnapshot = draft?.id
    ? JSON.stringify(plugin.pluginSettings.customSources.find((source) => source.id === draft.id) ?? null)
    : undefined;
  const onSubmit = async (result: CustomSourceDef): Promise<void> => {
    // Commit a new array only after deriving the complete next state. If the
    // settings write fails, restore the previous reference so an in-memory
    // source cannot look saved while data.json still contains the old value.
    const previous = plugin.pluginSettings.customSources;
    if (expectedExistingSnapshot !== undefined) {
      const current = previous.find((source) => source.id === result.id);
      if (JSON.stringify(current ?? null) !== expectedExistingSnapshot) {
        throw new Error(t("数据源已被其他窗口修改，请重新打开后再保存。"));
      }
    }
    const next = previous.slice();
    const index = next.findIndex((s) => s.id === result.id);
    if (expectedExistingSnapshot === undefined && index >= 0) {
      throw new Error(t("数据源 ID 已存在，请重新打开添加流程。"));
    }
    if (index >= 0) next[index] = result;
    else next.push(result);
    plugin.pluginSettings.customSources = next;
    try {
      await plugin.saveSettings();
      onSaved?.();
    } catch (error) {
      plugin.pluginSettings.customSources = previous;
      throw error;
    }
  };
  if (draft?.format === "csv") {
    new CsvSourceModal(app, draft, onSubmit).open();
    return;
  }
  new CustomSourceModal(
    app,
    draft,
    onSubmit,
    plugin.pluginSettings.customSources,
    plugin.credentials,
    plugin.pluginSettings.credentialNames,
    plugin.pluginSettings.allowedLoopbackHttpOrigins,
    async (origin) => {
      plugin.pluginSettings.allowedLoopbackHttpOrigins = [
        ...plugin.pluginSettings.allowedLoopbackHttpOrigins.filter((o) => o !== origin),
        origin,
      ];
      await plugin.saveSettings();
    }
  ).open();
}

export class StrataBoardSettingTab extends PluginSettingTab {
  plugin: StrataBoardPlugin;
  private activeTab: SettingsTabId = "general";
  // 数据源 groups render collapsed by default; expanded state lives on
  // the tab instance so it survives re-renders within a session (but is not
  // persisted to settings).
  private expandedSourceGroups = new Set<string>();

  constructor(app: App, plugin: StrataBoardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    if (pendingTab) {
      this.activeTab = pendingTab;
      pendingTab = null;
    }
    const { containerEl } = this;
    containerEl.empty();

    // Tabs without real content are hidden; fall back to the first visible
    // tab if the active one (or a pendingTab target) has nothing to show.
    const visibleTabs = SETTINGS_TABS.filter((tab) => tab.hasContent?.() ?? true);
    if (!visibleTabs.some((tab) => tab.id === this.activeTab)) {
      this.activeTab = visibleTabs[0].id;
    }

    const tabBar = containerEl.createDiv("fc-settings-tabbar");
    for (const tab of visibleTabs) {
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
      case "data-sources":
        this.renderDataSourceSettings(contentEl);
        break;
      case "indicators":
        this.renderIndicatorSettings(contentEl);
        break;
      case "advanced":
        this.renderAdvancedSettings(contentEl);
        break;
    }

    // Field explanations collapse to hover-only info icons (说明文字悬停才
    // 显示); content rows opt out via .fc-keep-desc / .fc-source-group-header.
    applyInfoDescs(containerEl);
  }

  private renderGeneralSettings(containerEl: HTMLElement): void {
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

    new Setting(containerEl)
      .setName(t("涨色"))
      .setDesc(t("所有图表的上涨颜色（K 线 / 基线面积图）。"))
      .addColorPicker((picker) =>
        picker.setValue(this.plugin.pluginSettings.riseColor).onChange(async (value) => {
          this.plugin.pluginSettings.riseColor = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("跌色"))
      .setDesc(t("所有图表的下跌颜色（K 线 / 基线面积图）。"))
      .addColorPicker((picker) =>
        picker.setValue(this.plugin.pluginSettings.fallColor).onChange(async (value) => {
          this.plugin.pluginSettings.fallColor = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("图表主题默认"))
      .setDesc(t("新建卡片的初始图表主题；已创建的卡片保留自己的主题设置。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("obsidian", t("跟随 Obsidian 主题"))
          .addOption("dark", t("深色"))
          .addOption("light", t("浅色"))
          .setValue(this.plugin.pluginSettings.chartThemeDefault)
          .onChange(async (value) => {
            this.plugin.pluginSettings.chartThemeDefault = value as ChartThemeDefault;
            await this.plugin.saveSettings();
          })
      );

    // Card/widget display sections (TradingView widgets, calendar cards,
    // chart display defaults) and the canvas toolbar sections also live on
    // the 通用 tab.
    this.renderCardSettings(containerEl);
    this.renderToolbarSettings(containerEl);

    // Legal text lives at the bottom of 通用, collapsed by default like
    // every other settings sub-section.
    const disclaimerDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    disclaimerDetails.createEl("summary", { text: t("免责声明") });
    this.renderDisclaimerSettings(disclaimerDetails);
  }

  // 数据源 tab: credential sync, user-configured sources, and network policy.
  private renderDataSourceSettings(containerEl: HTMLElement): void {
    this.renderCredentialSyncSettings(containerEl);
    this.renderCustomSourceSettings(containerEl);

    const networkDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    networkDetails.createEl("summary", { text: t("高级网络设置") });

    new Setting(networkDetails)
      .setName(t("请求最小间隔（毫秒）"))
      .setDesc(t("所有数据请求按此间隔串行发出。这只是客户端技术节流，不代表符合任何数据平台的配额或条款；请按所用服务的条款自行设置。下限 200ms，默认 1000ms。"))
      .addSlider((slider) =>
        slider
          .setLimits(MIN_REQUEST_INTERVAL_MS, 2000, 50)
          .setValue(Math.max(MIN_REQUEST_INTERVAL_MS, this.plugin.pluginSettings.requestIntervalMs))
          .onChange(async (value) => {
            this.plugin.pluginSettings.requestIntervalMs = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private renderCredentialSyncSettings(containerEl: HTMLElement): void {
    const details = containerEl.createEl("details", { cls: "fc-settings-sub" });
    details.createEl("summary", { text: t("凭证同步") });
    const state = this.plugin.credentials.getSyncState();
    const showError = (error: unknown) => {
      new Notice(error instanceof Error ? error.message : t("凭证同步操作失败。"), 10000);
    };
    const status = !state.enabled
      ? t("未开启；凭证仅保存在本机 SecretStorage。")
      : state.status === "unlocked"
        ? t("已解锁；加密凭证会随 vault 同步。")
        : state.status === "locked"
          ? t("待解锁；本机已有凭证仍可使用。")
          : state.detail ?? t("同步暂不可用；本机已有凭证仍可使用。");

    new Setting(details)
      .setName(t("多设备加密同步"))
      .setDesc(t("{status} 密文位于 .obsidian/plugins/strataboard/credentials/；同步软件需包含此目录。明文密钥、解锁密码不会写入 vault。", { status }));
    const controls = new Setting(details);
    if (!state.enabled) {
      controls.addButton((button) => button.setButtonText(t("开启同步")).setCta().onClick(() => {
        void this.plugin.credentials.hasSyncManifest().then((exists) => {
          new CredentialSyncPasswordModal(this.app, exists ? "unlock" : "create", async (password, remember) => {
            if (exists) await this.plugin.credentials.unlockSync(password, remember);
            else await this.plugin.credentials.enableSync(password, remember);
            this.plugin.pluginSettings.credentialSyncEnabled = true;
            await this.plugin.saveSettings();
            this.display();
            new Notice(t("凭证同步已开启。"));
          }).open();
        }).catch(showError);
      }));
    } else {
      if (state.status !== "unlocked") {
        controls.addButton((button) => button.setButtonText(t("解锁")).setCta().onClick(() => {
          new CredentialSyncPasswordModal(this.app, "unlock", async (password, remember) => {
            await this.plugin.credentials.unlockSync(password, remember);
            this.display();
            new Notice(t("凭证同步已解锁。"));
          }).open();
        }));
      } else {
        controls.addButton((button) => button.setButtonText(t("锁定")).onClick(() => {
          void this.plugin.credentials.lockSync().then(() => this.display()).catch(showError);
        }));
      }
      controls.addButton((button) => button.setButtonText(t("立即同步")).onClick(() => {
        void this.plugin.credentials.reloadSync().then(() => {
          this.display();
          new Notice(t("凭证同步已完成。"));
        }).catch(showError);
      }));
      controls.addButton((button) => button.setButtonText(t("停用并删除")).setWarning().onClick(() => {
        new ConfirmModal(this.app, t("停用凭证同步并删除 vault 中的加密凭证？各设备已保存到本机的凭证会保留，但无法再通过同步恢复。"), () => {
          void (async () => {
            await this.plugin.credentials.disableSync();
            this.plugin.pluginSettings.credentialSyncEnabled = false;
            await this.plugin.saveSettings();
            this.display();
          })().catch(showError);
        }).open();
      }));
    }
  }

  // 指标 tab: user-provided files only. The loader registers enabled
  // files and keeps load errors for display here.
  private renderIndicatorSettings(containerEl: HTMLElement): void {
    containerEl.createDiv({
      cls: "fc-field-hint",
      text: t("自定义指标由用户提供，插件不内置、审核或背书任何指标及其输出。指标在受限运行环境中执行（无网络、文件与 Obsidian API），该环境只用于降低误操作风险，不能抵御恶意代码；指标首次运行或内容变化后需要你确认。仅添加你理解且信任的代码。"),
    });

    // Global switch for the overlay card correlation badge; per-card opt-out
    // stays in the overlay editor (显示相关系数) / YAML `correlation: false`.
    const correlationSetting = new Setting(containerEl)
      .setName(t("对比卡相关系数"))
      .setDesc(t("全局开关：关闭后所有对比卡都不再计算和显示相关系数徽标。"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.showOverlayCorrelation).onChange(async (value) => {
          this.plugin.pluginSettings.showOverlayCorrelation = value;
          await this.plugin.saveSettings();
        })
      );
    setTooltip(
      correlationSetting.nameEl,
      t(
        "使用方法：恰有两个系列的对比卡会在副标题显示相关系数徽标——价格类序列按收益率、利率/利差等水平值按一阶差分、已是涨跌幅的按原值，在共同交易日上计算逐期相关（Pearson）；统计与图上的归一化线条无关，悬停副标题可见完整口径说明。单张卡片可在「编辑对比卡 → 数据」中单独关闭。"
      )
    );

    const folder = normalizePath(this.plugin.pluginSettings.indicatorFolderPath);
    const customDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    customDetails.createEl("summary", { text: t("自定义指标") });

    // Editable indicator folder (changing it re-syncs the indicator files),
    // with the open-folder / import actions on the same row.
    const folderSetting = this.addFolderPathSetting(customDetails, {
      name: t("指标文件夹"),
      desc: t("存放自定义指标文件（.js）的文件夹；插件自动把其中的指标注册进指标系统。"),
      value: this.plugin.pluginSettings.indicatorFolderPath,
      defaultValue: DEFAULT_SETTINGS.indicatorFolderPath,
      onChange: async (value) => {
        this.plugin.pluginSettings.indicatorFolderPath = value;
        await this.plugin.saveSettings();
        // Pick up indicator files already sitting in the new folder.
        void syncIndicatorFiles(this.plugin);
      },
    });
    folderSetting
      .addButton((btn) => btn.setButtonText(t("打开文件夹")).onClick(() => void this.openIndicatorFolder()))
      .addButton((btn) => btn.setButtonText(t("从文件导入")).onClick(() => this.importIndicatorFile(customDetails)));

    const prefix = `${folder}/`;
    const files = this.app.vault
      .getFiles()
      .filter((file) => file.extension === "js" && file.path.startsWith(prefix))
      .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
    if (files.length === 0) {
      customDetails.createDiv({
        cls: "fc-field-hint",
        text: t("指标文件夹中还没有自定义指标（.js 文件）：自行编写或用 AI 编写后放入该文件夹，或用上方「从文件导入」添加。"),
      });
    }
    for (const file of files) {
      this.renderCustomIndicatorRow(customDetails, file, folder);
    }

    const { errors, conflicts } = getIndicatorLoadErrors();
    for (const entry of [...errors, ...conflicts]) {
      customDetails.createDiv({
        cls: "fc-detect-error",
        text: t("{path} — {error}", { path: entry.path, error: entry.error }),
      });
    }
    // Compute/render failures isolated at runtime (see indicators/compute.ts).
    for (const entry of getIndicatorRuntimeErrors()) {
      customDetails.createDiv({
        cls: "fc-detect-error",
        text: t("{path} — {error}", { path: t("指标「{id}」计算失败", { id: entry.id }), error: entry.error }),
      });
    }

    // 指标组: named bundles of indicators, applied to a card in one click
    // from the card edit modal (expanded into plain instances on apply).
    // Editing a group here syncs the new definition to every card that
    // carries its label; deleting a group leaves cards untouched.
    const groupDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    groupDetails.createEl("summary", { text: t("指标组") });

    new Setting(groupDetails)
      .addButton((btn) =>
        btn
          .setButtonText(t("新建指标组"))
          .setCta()
          .onClick(() => this.openIndicatorGroupModal(null))
      )
      .addButton((btn) => btn.setButtonText(t("导入")).onClick(() => this.importIndicatorGroups(groupDetails)))
      .addButton((btn) => btn.setButtonText(t("导出")).onClick(() => this.exportIndicatorGroups()));

    const groups = this.plugin.pluginSettings.indicatorGroups;
    if (groups.length === 0) {
      groupDetails.createDiv({
        cls: "fc-field-hint",
        text: t("指标组是若干指标的命名组合，可在卡片编辑弹窗一键应用。"),
      });
    }
    for (const group of groups) {
      const names = group.indicators.map((inst) => {
        const def = indicatorRegistry.resolve(inst.id);
        return def ? t(def.name) : inst.id;
      });
      const row = new Setting(groupDetails)
        .setName(group.name)
        .setDesc(`${t("{n} 个指标", { n: group.indicators.length })}：${names.join("、")}`);
      // The row desc carries content (the member indicators), not an
      // explanation — keep it visible instead of an info-icon tooltip.
      row.settingEl.addClass("fc-keep-desc");
      row.addButton((btn) => btn.setButtonText(t("编辑")).onClick(() => this.openIndicatorGroupModal(group)));
      row.addButton((btn) =>
        btn
          .setButtonText(t("删除"))
          .setWarning()
          .onClick(() => {
            new ConfirmModal(
              this.app,
              t("删除指标组「{name}」？已应用到卡片的指标不受影响。", { name: group.name }),
              () => {
                this.plugin.pluginSettings.indicatorGroups = this.plugin.pluginSettings.indicatorGroups.filter(
                  (g) => g.id !== group.id
                );
                void this.plugin.saveSettings().then(() => this.display());
              }
            ).open();
          })
      );
    }
  }

  // One custom-indicator file row: enable toggle (keyed by folder-relative
  // path), 编辑 (system editor), 删除 (confirm; referencing cards lose the
  // indicator).
  private renderCustomIndicatorRow(containerEl: HTMLElement, file: TFile, folder: string): void {
    const rel = file.path.slice(folder.length + 1);
    const def = indicatorRegistry.resolve(sanitizeFileNamePart(file.basename));
    const disabled = this.plugin.pluginSettings.disabledIndicators.includes(rel);
    // 待确认运行: the file's path+hash has no stored approval and the user
    // declined (or hasn't answered) the confirmation — it is never executed.
    const awaitingApproval = getUnapprovedIndicators().some((u) => u.path === file.path);
    const setting = new Setting(containerEl)
      .setName(def && !disabled ? t(def.name) : file.name)
      .setDesc(
        [
          rel,
          def && !disabled ? `${t(def.category)} · ${def.metadata.overlay ? t("主图") : t("副图")}` : null,
          disabled ? t("已禁用") : !def ? (awaitingApproval ? t("待确认运行") : t("未加载")) : null,
        ]
          .filter((part): part is string => !!part)
          .join(" · ")
      );
    setting.settingEl.addClass("fc-keep-desc");
    setting.addToggle((toggle) => {
      setTooltip(toggle.toggleEl, t("启用/禁用指标"));
      toggle.setValue(!disabled).onChange(async (value) => {
        const list = this.plugin.pluginSettings.disabledIndicators.filter((p) => p !== rel);
        if (!value) list.push(rel);
        this.plugin.pluginSettings.disabledIndicators = list;
        await this.plugin.saveSettings();
        await syncIndicatorFiles(this.plugin);
        this.display();
      });
    });
    setting.addButton((btn) => btn.setButtonText(t("编辑")).onClick(() => this.openIndicatorEditModal(def)));
    setting.addButton((btn) =>
      btn
        .setButtonText(t("删除"))
        .setWarning()
        .onClick(() => {
          new ConfirmModal(
            this.app,
            t("删除指标文件「{name}」？引用它的卡片将失去该指标。", { name: file.name }),
            () => {
              void (async () => {
                await this.app.vault.delete(file);
                this.plugin.pluginSettings.disabledIndicators =
                  this.plugin.pluginSettings.disabledIndicators.filter((p) => p !== rel);
                await syncIndicatorFiles(this.plugin);
                await this.plugin.saveSettings();
                this.display();
              })();
            }
          ).open();
        })
    );
  }

  // 从文件导入: pick a local .js file and copy it into the indicator folder;
  // a name collision asks before overwriting.
  private importIndicatorFile(containerEl: HTMLElement): void {
    const folder = normalizePath(this.plugin.pluginSettings.indicatorFolderPath);
    const input = containerEl.createEl("input", {
      cls: "fc-hidden",
      attr: { type: "file", accept: ".js" },
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      void (async () => {
        const body = await file.text();
        await ensureFolder(this.app, folder);
        const path = `${folder}/${file.name}`;
        const existing = this.app.vault.getAbstractFileByPath(path);
        const finish = async () => {
          if (existing instanceof TFile) {
            await this.app.vault.modify(existing, body);
          } else {
            await this.app.vault.create(path, body);
          }
          await syncIndicatorFiles(this.plugin);
          new Notice(t("已导入指标：{name}", { name: file.name }));
          this.display();
        };
        if (existing instanceof TFile) {
          new ConfirmModal(this.app, t("指标文件「{name}」已存在，覆盖？", { name: file.name }), () => void finish()).open();
        } else {
          await finish();
        }
      })();
    });
    input.click();
  }

  // 指标组 新建/编辑弹窗; on submit the group is upserted by id. Edits are
  // then synced to every card carrying the group's label (renames included).
  private openIndicatorGroupModal(group: IndicatorGroup | null): void {
    new IndicatorGroupModal(this.app, group, (result) => {
      const groups = this.plugin.pluginSettings.indicatorGroups;
      const index = groups.findIndex((g) => g.id === result.id);
      const previousName = index >= 0 ? groups[index].name : undefined;
      if (index >= 0) {
        groups[index] = result;
      } else {
        groups.push(result);
      }
      void this.plugin.saveSettings().then(() => this.display());
      if (index >= 0) {
        void this.syncGroupToCards(result, previousName);
      }
    }).open();
  }

  // Pushes an edited group into every card that carries its label, with a
  // summary Notice when at least one card file was rewritten.
  private async syncGroupToCards(group: IndicatorGroup, previousName?: string): Promise<void> {
    const result = await syncIndicatorGroupToCards(
      this.app,
      group,
      previousName !== group.name ? previousName : undefined
    );
    if (result.filesChanged > 0) {
      new Notice(t("已同步 {n} 张卡片中的指标组「{name}」。", { n: result.filesChanged, name: group.name }));
    }
  }

  // 导入: pick a local .json file of indicator groups; same-name entries
  // overwrite in place (old id kept), anything else appends.
  private importIndicatorGroups(containerEl: HTMLElement): void {
    const input = containerEl.createEl("input", {
      cls: "fc-hidden",
      attr: { type: "file", accept: ".json" },
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      void (async () => {
        try {
          const { groups, warnings } = parseImportedGroups(await file.text());
          const { updated, added, updatedGroups } = mergeImportedGroups(this.plugin.pluginSettings.indicatorGroups, groups);
          await this.plugin.saveSettings();
          new Notice(t("导入成功：更新 {updated} 个、新增 {added} 个指标组。", { updated, added }));
          for (const warning of warnings.slice(0, 5)) new Notice(warning, 8000);
          if (warnings.length > 5) new Notice(t("另有 {n} 条导入警告未显示。", { n: warnings.length - 5 }));
          // Name-overwritten groups are edits — sync them to cards too.
          let filesChanged = 0;
          for (const group of updatedGroups) {
            filesChanged += (await syncIndicatorGroupToCards(this.app, group)).filesChanged;
          }
          if (filesChanged > 0) {
            new Notice(t("已同步 {n} 张卡片中被导入覆盖的指标组。", { n: filesChanged }));
          }
        } catch {
          new Notice(t("导入失败：内容不是有效的指标组配置。"));
        }
        this.display();
      })();
    });
    input.click();
  }

  // 导出: copy all groups as JSON to the clipboard.
  private exportIndicatorGroups(): void {
    const groups = this.plugin.pluginSettings.indicatorGroups;
    if (groups.length === 0) {
      new Notice(t("没有可导出的指标组。"));
      return;
    }
    void navigator.clipboard.writeText(JSON.stringify(groups, null, 2)).then(
      () => new Notice(t("已导出 {n} 个指标组到剪贴板。", { n: groups.length })),
      () => new Notice(t("导出失败：无法访问剪贴板。"))
    );
  }

  // Desktop-only plugin, so electron is reachable via window.require; no
  // static import (the build keeps electron external).
  private openPathInSystem(path: string): void {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const abs = `${adapter.getBasePath?.() ?? ""}/${path}`;
    const electron = (
      window as unknown as { require?: (mod: string) => { shell?: { openPath?: (path: string) => Promise<string> } } }
    ).require?.("electron");
    if (electron?.shell?.openPath) {
      void electron.shell.openPath(abs);
    } else {
      new Notice(t("无法打开文件夹：当前环境不支持。"));
    }
  }

  private async openIndicatorFolder(): Promise<void> {
    const folder = normalizePath(this.plugin.pluginSettings.indicatorFolderPath);
    await ensureFolder(this.app, folder);
    this.openPathInSystem(folder);
  }

  private openIndicatorEditModal(def: import("./modules/indicators/contract").IndicatorDef | undefined): void {
    if (!def) {
      new Notice(t("指标尚未成功加载，暂时无法编辑设置。"));
      return;
    }
    const current = this.plugin.pluginSettings.indicatorOverrides[def.id] ?? {};
    new IndicatorEditModal(this.app, def, current, async (next) => {
      this.plugin.pluginSettings.indicatorOverrides[def.id] = next;
      await this.plugin.saveSettings();
      await syncIndicatorFiles(this.plugin);
      this.display();
    }).open();
  }

  // Full legal text, rendered inside the collapsed 免责声明 block at the
  // bottom of 通用.
  private renderDisclaimerSettings(containerEl: HTMLElement): void {
    const root = containerEl.createDiv("fc-disclaimer");

    const section = (title: string, body: string): HTMLElement => {
      const el = root.createDiv("fc-disclaimer-section");
      new Setting(el).setName(t(title)).setHeading();
      el.createEl("p", { text: t(body) });
      return el;
    };

    section(
      "插件性质",
      "本插件仅为数据接入框架与展示工具，本身不提供、不存储、不分发任何金融数据，与任何数据平台均不存在合作、授权或背书关系。"
    );

    section(
      "自定义数据源",
      "本插件不内置任何数据源：所有接口地址（URL）、参数与凭据均由您自行配置并自行调用，或由您运行的脚本产出本地 CSV 文件。您应确保其配置与使用行为符合数据来源平台的服务条款及适用法律，不得利用本插件从事未经授权的数据抓取或访问。"
    );

    section(
      "凭据存储与传输",
      "您填写的 API Key 默认只保存在 Obsidian 的 SecretStorage 中；主动开启多设备同步后，vault 中另存使用独立解锁密码保护的加密凭证，明文密钥与解锁密码均不写入 vault。插件的 data.json 只保存凭据引用（credentialId）和同步开关，不包含密钥本身。调用 CLI 或 MCP 时，密钥只通过您显式设置的环境变量（STRATABOARD_API_KEY_<数据源ID>）提供，进程不读取 SecretStorage 或同步密文。插件仅在您主动请求数据时，按 {apiKey} 占位符把密钥发送到您配置的接口。请使用最小权限密钥，限制来源与额度，并在怀疑泄露时及时轮换。"
    );

    section(
      "本地脚本",
      "Python 脚本由您在设置页配置的解释器直接启动（不经过 shell），以当前系统用户的完整权限运行，可访问网络、读写文件并启动其他进程；运行环境只包含最小环境变量，不包含数据源或 AI 密钥。插件会在首次运行、路径改变或内容改变后重新请求确认，但不审查、不担保脚本安全。脚本的数据获取行为及授权关系由您自行负责；脚本功能不适合高频数据，不得作为批量下载工具使用。"
    );

    section(
      "自定义指标",
      "自定义指标由您提供，在不含网络、文件、DOM、Obsidian API 与 require 的受限环境中运行，并设有执行时间与输出数量上限；首次运行或内容变化后需经您确认才会执行。该环境只用于降低误操作风险，不能抵御恶意代码，也不能替代代码审查。插件不生成、提供、审核、验证或背书指标及其中的买卖标记；仅使用您理解且信任的代码。"
    );

    section(
      "TradingView 小组件",
      "TradingView 是独立的第三方服务，与本插件及 Obsidian 均无隶属、合作或背书关系。小组件卡仅允许嵌入 TradingView 官方 HTTPS URL 或官方组件代码，其内容由 TradingView 提供并受其服务条款与隐私政策约束；组件中的归属信息与官方链接始终保留。"
    );

    section(
      "软件许可证",
      "本插件代码依据 MIT 许可证发布，您可以在该许可证允许的范围内使用本插件，包括商业使用。MIT 许可证仅适用于插件代码，不会授予任何第三方数据、内容、商标或服务的额外权利。"
    );

    section(
      "第三方数据授权",
      "第三方数据的访问、存储、处理、展示、导出、商业使用及再分发范围，以相应数据来源的许可证、服务条款及您实际取得的授权为准。您应自行确认并遵守所需授权、使用配额及适用法律。"
    );

    section(
      "不构成投资建议",
      "通过本插件展示的数据、脚本结果、自定义指标及其标记可能存在延迟、错误、遗漏或中断，均不构成投资建议、要约或招揽。据此操作，风险自担。"
    );

    section(
      "无担保与责任限制",
      "本插件按\"现状\"提供，作者不作任何明示或默示的担保。在适用法律允许的最大范围内，作者不对因使用或无法使用本插件而产生的任何直接或间接损失承担责任。"
    );
  }

  // 自定义数据源 management: the plugin ships no data sources — each entry
  // is a user-configured REST/JSON endpoint template or vault CSV file (see
  // CustomSourceModal / CsvSourceModal). Rendered at the top level of the
  // 数据源 tab. Toggling 启用 gates pickers/toolbar entries; deleting a
  // source breaks cards that reference it (they render the missing-source
  // error).
  private renderCustomSourceSettings(containerEl: HTMLElement): void {
    // Single add entry point: the first layer picks the source kind (script
    // outputs keep auto-registering from the script folder — they never
    // appear here).
    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText(t("添加数据源"))
        .setCta()
        .onClick(() => {
          new ChoiceModal(this.app, t("选择数据源类型"), [
            { label: t("远程接口"), onPick: () => this.openCustomSourceModal(), cta: true },
            { label: t("vault CSV"), onPick: () => this.openCsvSourceModal() },
          ]).open();
        })
    );

    // Script-produced sources render in their own 本地脚本 section below —
    // they are maintained by the scripts, not by the source wizard.
    const sources = this.plugin.pluginSettings.customSources.filter((s) => !isScriptSource(s));
    // Group labels in first-appearance order; ungrouped sources render last.
    const groupNames = [
      ...new Set(sources.map((s) => s.group).filter((g): g is string => !!g)),
    ];
    for (const group of groupNames) {
      const members = sources.filter((s) => s.group === group);
      // Groups render collapsed by default; the chevron toggles expansion
      // (state kept on the tab instance for the session).
      const expanded = this.expandedSourceGroups.has(group);
      const header = new Setting(containerEl)
        .setClass("fc-source-group-header")
        .setName(group)
        .setDesc(t("数据源组 · {n} 个源", { n: members.length }));
      header.nameEl.prepend(this.sourceAvatar(group, paletteColor(`group:${group}`)));
      header
        .addExtraButton((btn) => {
          btn.setIcon(expanded ? "chevron-down" : "chevron-right");
          setTooltip(btn.extraSettingsEl, expanded ? t("收起分组") : t("展开分组"));
          btn.onClick(() => {
            if (this.expandedSourceGroups.has(group)) {
              this.expandedSourceGroups.delete(group);
            } else {
              this.expandedSourceGroups.add(group);
            }
            this.display();
          });
        })
        .addButton((btn) =>
          btn.setButtonText(t("重命名")).onClick(() => {
            new TextInputModal(this.app, t("重命名分组"), (name) => {
              // Group names compare trimmed at key-resolution time; keep the
              // stored name clean so a stray space can't cut a source off
              // from its group's shared apiKey.
              const trimmed = name.trim();
              if (!trimmed || trimmed === group) return;
              for (const s of sources) {
                if (s.group === group) s.group = trimmed;
              }
              void this.plugin.saveSettings().then(() => this.display());
            }, group).open();
          })
        )
        .addButton((btn) =>
          btn
            .setButtonText(t("解散分组"))
            .setWarning()
            .onClick(() => {
              new ConfirmModal(this.app, t("解散分组「{name}」？组内数据源会保留，仅取消归类。", { name: group }), () => {
                for (const s of sources) {
                  if (s.group === group) delete s.group;
                }
                void this.plugin.saveSettings().then(() => this.display());
              }).open();
            })
        );
      if (!expanded) continue;
      for (const def of members) {
        this.renderCustomSourceRow(containerEl, def, groupNames, true);
      }
    }
    for (const def of sources.filter((s) => !s.group)) {
      this.renderCustomSourceRow(containerEl, def, groupNames, false);
    }

    this.renderScriptSourceSettings(containerEl);
  }

  // 本地脚本 sources (auto-registered from script outputs): kept apart from
  // the hand-configured list above — they are maintained by the scripts, not
  // by the source wizard. Each row carries provenance (script · output ·
  // last run) and offers 命名 (rename the source and each of its datasets —
  // one script can emit several series), 运行 (rerun the script), 编辑/删除.
  private renderScriptSourceSettings(containerEl: HTMLElement): void {
    const folder = normalizePath(this.plugin.pluginSettings.scriptFolderPath);
    const scriptSources = this.plugin.pluginSettings.customSources.filter((s) => isScriptSource(s));
    const details = containerEl.createEl("details", { cls: "fc-settings-sub" });
    details.createEl("summary", { text: t("本地脚本") });
    if (scriptSources.length === 0) {
      details.createDiv({
        cls: "fc-field-hint",
        text: t("脚本产物（{folder}/output/*.csv）会自动注册为数据源并显示在这里；脚本管理见画布工具栏「更多 → 本地脚本」。", { folder }),
      });
      return;
    }
    for (const def of scriptSources) {
      const prov = getScriptProvenance(this.plugin, def.id);
      const scriptRel = prov?.scriptFile ? prov.scriptFile.path.slice(folder.length + 1) : null;
      const outputRel = def.filePath?.startsWith(`${folder}/`) ? def.filePath.slice(folder.length + 1) : def.filePath;
      const lastRun = prov?.outputFile ? formatDateTime(prov.outputFile.stat.mtime) : null;
      const setting = new Setting(details)
        .setName(def.name)
        .setDesc(
          [
            scriptRel ? t("脚本：{path}", { path: scriptRel }) : t("脚本文件缺失"),
            outputRel ? t("产物：{path}", { path: outputRel }) : null,
            t("最近运行：{time}", { time: lastRun ?? t("从未") }),
          ]
            .filter((part): part is string => !!part)
            .join(" · ")
        );
      // The row desc carries identifying content, not an explanation — keep
      // it visible instead of an info-icon tooltip.
      setting.settingEl.addClass("fc-keep-desc");
      setting.addButton((btn) => btn.setButtonText(t("命名")).onClick(() => this.openScriptDatasetsModal(def)));
      setting.addButton((btn) =>
        btn.setButtonText(t("运行")).onClick(() => void this.plugin.runScriptForSource(def.id).then(() => this.display()))
      );
      setting.addButton((btn) => btn.setButtonText(t("编辑")).onClick(() => this.openCsvSourceModal(def)));
      setting.addButton((btn) =>
        btn
          .setButtonText(t("删除"))
          .setWarning()
          .onClick(() => {
            new ConfirmModal(this.app, t("删除数据源「{name}」？脚本下次运行时会重新注册；引用它的卡片将无法加载。", { name: def.name }), () => {
              this.plugin.pluginSettings.customSources = this.plugin.pluginSettings.customSources.filter(
                (s) => s.id !== def.id
              );
              void this.plugin.saveSettings().then(() => this.display());
            }).open();
          })
      );
    }
  }

  // 命名 entry of a 本地脚本 source row: renames the source and each of its
  // datasets (wide-table columns), then propagates the new names into the
  // symbol cache so existing card headers pick them up.
  private openScriptDatasetsModal(def: CustomSourceDef): void {
    new ScriptDatasetsModal(this.app, def, (name, renames) => {
      def.name = name;
      for (const symbol of def.symbols ?? []) {
        const renamed = renames.get(symbol.code);
        if (renamed) symbol.name = renamed;
      }
      void this.plugin.saveSettings().then(async () => {
        const assetKey = cacheAssetKey("custom", def.id);
        for (const symbol of def.symbols ?? []) {
          const existing = await this.plugin.sqliteCache.lookupSymbol(symbol.code, assetKey).catch(() => undefined);
          if (existing) {
            void this.plugin.sqliteCache.upsertSymbols([{ ...existing, name: symbol.name }]);
          }
        }
        for (const renderer of this.plugin.chartRenderers) renderer.refreshCard();
        this.display();
      });
    }).open();
  }

  // Palette-dot avatar with the entry's first character (same idea as the
  // Obsidian community-plugin list); the color is the stable palette hash
  // the 插入图表 menu uses for its dots (modules/toolbar.ts paletteColor).
  private sourceAvatar(label: string, color: string): HTMLElement {
    const avatar = createSpan({ cls: "fc-source-avatar", text: label.trim().charAt(0) || "?" });
    avatar.style.backgroundColor = color;
    return avatar;
  }

  // One custom-source row: palette-dot avatar (first name character, same
  // idea as the community-plugin list) + name, a desc line of 类型 · 地址 ·
  // 凭据状态, the session connection badge, the enable toggle, and a kebab
  // menu holding every action (编辑 / 移动到分组 / 删除).
  private renderCustomSourceRow(
    containerEl: HTMLElement,
    def: CustomSourceDef,
    groupNames: string[],
    indented: boolean
  ): void {
    // Source-kind label: REST covers every remote-JSON parser format; the
    // parser format labels (CUSTOM_FORMAT_LABELS) stay inside the wizard.
    const typeLabel = isScriptSource(def) ? t("脚本") : def.format === "csv" ? t("CSV") : t("REST");
    const setting = new Setting(containerEl)
      .setName(def.name)
      .setDesc(
        [
          typeLabel,
          def.format === "csv" ? def.filePath ?? def.klineUrl ?? "" : def.klineUrl ?? "",
          this.describeCredentialStatus(def),
        ]
          .filter(Boolean)
          .join(" · ")
      );
    if (indented) setting.setClass("fc-source-group-member");
    // The row desc carries identifying content (type · address · key state),
    // not an explanation — keep it visible instead of an info-icon tooltip.
    setting.settingEl.addClass("fc-keep-desc");
    setting.nameEl.prepend(this.sourceAvatar(def.name, paletteColor(def.id)));

    // Session-scoped connection badge (modules/source-health.ts): the last
    // request/probe outcome for this source; no record = never probed. The
    // tooltip carries the failure reason and timestamp.
    const health = getSourceHealth(def.id);
    const badge = setting.controlEl.createSpan({
      cls: `fc-source-health fc-source-health-${health?.state ?? "unknown"}`,
      text: !health ? t("未探测") : health.state === "ok" ? t("正常") : t("失败"),
    });
    if (health?.state === "ok") {
      setTooltip(badge, t("最近成功：{time}", { time: formatDateTime(health.at) }));
    } else if (health?.state === "failed") {
      setTooltip(badge, t("最近失败：{time}\n{msg}", { time: formatDateTime(health.at), msg: health.message ?? "" }));
    }

    setting.addToggle((toggle) =>
      toggle.setValue(def.enabled).onChange(async (value) => {
        def.enabled = value;
        await this.plugin.saveSettings();
        this.display();
      })
    );
    setting.addExtraButton((btn) => {
      btn.setIcon("ellipsis-vertical");
      setTooltip(btn.extraSettingsEl, t("更多操作"));
      btn.onClick(() => {
        const rect = btn.extraSettingsEl.getBoundingClientRect();
        this.openSourceRowMenu({ x: rect.left, y: rect.bottom + 4 }, def, groupNames);
      });
    });
  }

  // Kebab menu of a source row. Force a DOM menu (like the canvas toolbar):
  // on macOS Obsidian defaults to native menus, which can't host the
  // 移动到分组 hover submenu.
  private openSourceRowMenu(at: { x: number; y: number }, def: CustomSourceDef, groupNames: string[]): void {
    const menu = new Menu().setUseNativeMenu(false);
    menu.addItem((item) =>
      item
        .setTitle(t("编辑"))
        .setIcon("pencil")
        .onClick(() => {
          if (def.format === "csv") {
            this.openCsvSourceModal(def);
          } else {
            this.openCustomSourceModal(def);
          }
        })
    );
    menu.addItem((item) => {
      item.setTitle(t("移动到分组")).setIcon("folder-input");
      // setSubmenu() is internal (absent from obsidian.d.ts) but is how
      // Obsidian itself nests menus; a submenu keeps the parent menu open.
      const submenu = (item as MenuItemWithSubmenu).setSubmenu();
      submenu.setUseNativeMenu(false);
      const move = (group?: string) => {
        if (group) {
          def.group = group;
        } else {
          delete def.group;
        }
        void this.plugin.saveSettings().then(() => this.display());
      };
      if (def.group) {
        submenu.addItem((sub) => sub.setTitle(t("未分组")).onClick(() => move()));
      }
      for (const name of groupNames) {
        submenu.addItem((sub) => sub.setTitle(name).onClick(() => move(name)));
      }
      submenu.addItem((sub) =>
        sub.setTitle(t("新建分组…")).onClick(() => {
          new TextInputModal(this.app, t("新建分组"), (name) => {
            const trimmed = name.trim();
            if (trimmed) move(trimmed);
          }).open();
        })
      );
    });
    menu.addItem((item) =>
      item
        .setTitle(t("删除"))
        .setIcon("trash-2")
        .onClick(() => this.confirmDeleteCustomSource(def))
    );
    menu.showAtPosition(at);
  }

  // Row deletion: confirm, then offer to delete an orphaned credential from
  // both the synced ciphertext and this device's SecretStorage.
  private confirmDeleteCustomSource(def: CustomSourceDef): void {
    new ConfirmModal(this.app, t("删除自定义数据源「{name}」？引用它的卡片将无法加载。", { name: def.name }), () => {
      const sources = this.plugin.pluginSettings.customSources;
      this.plugin.pluginSettings.customSources = sources.filter((s) => s.id !== def.id);
      clearSourceHealth(def.id);
      void this.plugin.saveSettings().then(() => this.display());
      const credentialId = def.credentialId;
      if (credentialId && !this.plugin.pluginSettings.customSources.some((s) => s.credentialId === credentialId)) {
        new ConfirmModal(this.app, t("数据源已删除。它引用的凭据已没有其他数据源使用，是否一并删除保存的密钥？"), () => {
          void (async () => {
            await this.plugin.credentials.remove(credentialId);
            delete this.plugin.pluginSettings.credentialNames[credentialId];
            await this.plugin.saveSettings();
            this.display();
          })().catch((error) => {
            new Notice(error instanceof Error ? error.message : t("凭证同步操作失败。"), 10000);
          });
        }).open();
      }
    }).open();
  }

  private describeCredentialStatus(def: CustomSourceDef): string | null {
    if (!sourceNeedsApiKey(def)) return null;
    if (!def.credentialId) return t("凭据：未设置（需要重新选择凭据）");
    if (!this.plugin.credentials.get(def.credentialId)) {
      if (this.plugin.credentials.isSyncLocked()) return t("凭据：待解锁（解锁同步后恢复）");
      return t("凭据：已失效（引用的凭据不存在，请重新选择）");
    }
    const shared = this.plugin.pluginSettings.customSources.filter(
      (s) => s.id !== def.id && s.credentialId === def.credentialId
    );
    return shared.length > 0
      ? t("凭据：已设置（与 {names} 共享）", { names: shared.map((s) => s.name).join("、") })
      : t("凭据：已设置");
  }

  // Both entry points delegate to the shared source-modal helper above
  // (upsert by id) and one probe/credential UI.
  private openCustomSourceModal(def?: CustomSourceDef): void {
    openPrefilledSourceModal(this.app, this.plugin, def, () => this.display());
  }

  private openCsvSourceModal(def?: CustomSourceDef): void {
    openPrefilledSourceModal(this.app, this.plugin, def, () => this.display());
  }

  // Path sections of the 高级 tab: card folders, script folder, Python
  // interpreter, and the cache folders. The indicator folder lives on the
  // 指标 tab instead (it is edited next to the indicator list itself).
  private renderPathSettings(containerEl: HTMLElement): void {
    // 卡片路径: the three card folders, folded like 缓存路径 below.
    const cardDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    cardDetails.createEl("summary", { text: t("卡片路径") });

    this.addFolderPathSetting(cardDetails, {
      name: t("图表卡片路径"),
      desc: t("存放图表卡片 Markdown 文件的文件夹（对比卡、计算卡等默认也放在这里）。"),
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

    this.addFolderPathSetting(cardDetails, {
      name: t("脚本文件夹"),
      desc: t("存放 Python 脚本的文件夹；脚本把计算结果 CSV 写入其 output/ 子目录，插件自动注册为数据源。"),
      value: this.plugin.pluginSettings.scriptFolderPath,
      defaultValue: DEFAULT_SETTINGS.scriptFolderPath,
      onChange: async (value) => {
        this.plugin.pluginSettings.scriptFolderPath = value;
        await this.plugin.saveSettings();
        // Pick up outputs already sitting in the new folder.
        void syncScriptSources(this.plugin);
      },
    });

    // Python interpreter: absolute path only, spawned directly without a
    // shell (W02-A). A plain text input — a folder suggester makes no sense
    // for an executable path outside the vault.
    new Setting(cardDetails)
      .setName(t("Python 解释器"))
      .setDesc(t("运行本地脚本使用的 Python 解释器绝对路径（如 /usr/bin/python3）。脚本不经过 shell 直接以该解释器启动；留空则无法运行本地脚本。"))
      .addText((text) =>
        text
          .setPlaceholder("/usr/bin/python3")
          .setValue(this.plugin.pluginSettings.pythonInterpreterPath)
          .onChange(async (value) => {
            this.plugin.pluginSettings.pythonInterpreterPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    const cacheDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    cacheDetails.createEl("summary", { text: t("缓存路径") });

    this.addFolderPathSetting(cacheDetails, {
      name: t("数据缓存路径"),
      desc: t("SQLite 行情数据缓存所在文件夹（会在此目录下创建 ohlcv.db）。"),
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
  }

  // 高级 tab: vault paths, cleanup/maintenance tools, and the diagnostics
  // block (plugin version, cache file sizes).
  private renderAdvancedSettings(containerEl: HTMLElement): void {
    this.renderPathSettings(containerEl);
    this.renderCleanupSettings(containerEl);
    this.renderDiagnosticsSettings(containerEl);
  }

  // 诊断与运行环境: read-only runtime facts — the plugin version from the
  // manifest and the sizes of the SQLite files under dataCachePath /
  // symbolCachePath.
  private renderDiagnosticsSettings(containerEl: HTMLElement): void {
    const details = containerEl.createEl("details", { cls: "fc-settings-sub" });
    details.createEl("summary", { text: t("诊断与运行环境") });

    // Plugin version from manifest.json; release.mjs tags GitHub releases
    // with exactly this version, so the two always match. The version number
    // is content, not an explanation — keep it visible (fc-keep-desc).
    new Setting(details)
      .setName(t("插件版本"))
      .setDesc(this.plugin.manifest.version)
      .settingEl.addClass("fc-keep-desc");

    this.addCacheFileSizeSetting(details, "ohlcv.db", `${normalizePath(this.plugin.pluginSettings.dataCachePath)}/ohlcv.db`);
    this.addCacheFileSizeSetting(details, "symbols.db", `${normalizePath(this.plugin.pluginSettings.symbolCachePath)}/symbols.db`);
  }

  // One diagnostics row showing a cache file's size ("无" when absent).
  private addCacheFileSizeSetting(details: HTMLElement, fileName: string, path: string): void {
    const setting = new Setting(details).setName(fileName).setDesc(t("检查中…"));
    setting.settingEl.addClass("fc-keep-desc");
    void this.app.vault.adapter.stat(path).then((stat) => {
      setting.setDesc(stat ? formatBytes(stat.size) : t("无"));
    });
  }

  // 清理维护: two-step cleanup tools (scan → checklist → confirm) for orphan
  // card files and stale cache data. Scan logic lives in modules/maintenance.ts.
  private renderCleanupSettings(containerEl: HTMLElement): void {
    // The legacy cardPath upgrade banner stays visible outside the collapsed
    // details until a scan proves the vault clean (or the user marks it).
    if (!this.plugin.pluginSettings.cardRefsUpgraded) {
      const banner = containerEl.createDiv({ cls: "fc-migration-banner" });
      banner.createDiv({ cls: "fc-migration-banner-icon", text: "⚠" });
      const text = banner.createDiv({ cls: "fc-migration-banner-text" });
      text.createDiv({ cls: "fc-migration-banner-title", text: t("检测到旧格式的卡片引用") });
      text.createDiv({
        cls: "fc-field-hint",
        text: t("旧格式（cardPath）的卡片引用已无法解析，请扫描确认后批量升级为稳定 id 引用；升级后卡片改名、移动都不再断引用。"),
      });
      const button = banner.createEl("button", { cls: "mod-cta", text: t("扫描并升级卡片引用") });
      button.addEventListener("click", () => void this.runCardRefUpgrade());
    }

    const details = containerEl.createEl("details", { cls: "fc-settings-sub" });
    details.createEl("summary", { text: t("清理维护") });
    details.createDiv({
      cls: "fc-field-hint",
      text: t("扫描后先列出清单，勾选确认后再执行操作。"),
    });

    new Setting(details)
      .setName(t("卡片修理"))
      .setDesc(t("扫描卡片中的未知或已删除字段，并批量移除这些多余字段。"))
      .addButton((btn) =>
        btn.setButtonText(t("扫描并修理卡片")).onClick(() => void this.runCardRepair())
      );

    new Setting(details)
      .setName(t("清理孤立卡片文件"))
      .setDesc(t("清理卡片路径下没有被任何画布、笔记链接或计算卡引用的卡片文件（删除后进入回收站）。"))
      .addButton((btn) =>
        btn.setButtonText(t("扫描孤立文件")).onClick(() => void this.runOrphanFileCleanup())
      );

    new Setting(details)
      .setName(t("清理闲置数据缓存"))
      .setDesc(t("清理数据缓存中不再被任何卡片使用的行情数据，保持缓存体积合理。"))
      .addButton((btn) =>
        btn.setButtonText(t("扫描闲置缓存")).onClick(() => void this.runStaleCacheCleanup())
      );
  }

  // CardPath→cardId upgrade, step 1: dry-run scan. Nothing pending → mark
  // the vault complete right away; otherwise open the confirm dialog.
  private async runCardRefUpgrade(): Promise<void> {
    new Notice(t("正在扫描旧格式卡片引用…"));
    const scan = await scanLegacyCardRefs(this.app, this.plugin.pluginSettings.cardLibraryPath);
    const pending = scan.idsToAssign + scan.refsToRewrite;
    if (pending === 0 && scan.unresolvable.length === 0 && scan.errors.length === 0) {
      await this.markCardRefsUpgraded();
      new Notice(t("未发现待处理的旧格式卡片引用，已标记为完成。"));
      return;
    }
    new CardRefUpgradeConfirmModal(this.app, scan, {
      onConfirm: () => void this.executeCardRefUpgrade(),
    }).open();
  }

  // Step 2 (after the confirm dialog): run the real migration and show the
  // result checklist. The completion flag is set only when nothing failed
  // and no ref was left behind; left-behind refs (target gone) need the
  // user's explicit 「仍然标记为完成」, execution errors never get it.
  private async executeCardRefUpgrade(): Promise<void> {
    new Notice(t("正在升级卡片引用…"));
    const report = await runCardRefMigration(this.app, this.plugin.pluginSettings.cardLibraryPath);
    const clean = report.errors.length === 0 && report.failures.length === 0;
    if (clean) {
      this.plugin.pluginSettings.cardRefsUpgraded = true;
      await this.plugin.saveSettings();
    }
    new Notice(
      t("升级完成：补 id {ids} 张计算卡，改写引用 {refs} 条。", {
        ids: report.idsAssigned,
        refs: report.refsRewritten,
      })
    );
    new CardRefMigrationReportModal(this.app, report, {
      onRescan: () => void this.runCardRefUpgrade(),
      onMarkComplete:
        !clean && report.errors.length === 0
          ? async () => {
              await this.markCardRefsUpgraded();
              new Notice(t("已标记为完成。"));
            }
          : undefined,
    }).open();
    this.display(); // refresh the banner
  }

  private async markCardRefsUpgraded(): Promise<void> {
    this.plugin.pluginSettings.cardRefsUpgraded = true;
    await this.plugin.saveSettings();
    this.display(); // remove the banner
  }

  private async runCardRepair(): Promise<void> {
    new Notice(t("正在扫描卡片错误…"));
    const candidates = await scanCardRepairs(this.app);
    if (candidates.length === 0) {
      new Notice(t("没有发现可自动修理的卡片字段。"));
      return;
    }
    new CleanupConfirmModal(this.app, {
      title: t("卡片修理"),
      desc: t("以下卡片包含未知或已删除字段。取消勾选可跳过对应卡片。"),
      confirmLabel: t("修理卡片"),
      items: candidates.map((candidate, index) => ({
        id: String(index),
        label: `${candidate.file} · ${candidate.blockType}`,
        hint: t("将移除字段：{keys}", { keys: candidate.keys.join(", ") }),
      })),
      onConfirm: async (selected) => {
        const report = await repairCards(this.app, selected.map((item) => candidates[Number(item.id)]));
        new CardRepairReportModal(this.app, report, { onRescan: () => void this.runCardRepair() }).open();
      },
    }).open();
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
      desc: t("以下 {n} 个卡片文件没有被任何画布、笔记链接或计算卡引用。取消勾选可保留对应文件。", { n: orphans.length }),
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
    const used = await collectUsedCacheKeys(this.app, this.plugin.cardIndex, this.plugin.pluginSettings.customSources);
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
  ): Setting {
    const setting = new Setting(containerEl).setName(options.name).setDesc(options.desc);
    new FolderPathSelect(setting.controlEl, {
      app: this.app,
      value: options.value,
      placeholder: options.defaultValue,
      onChange: (path) => {
        void options.onChange(path.trim() || options.defaultValue);
      },
    });
    return setting;
  }

  // 通用 tab sections: card/widget display defaults (TradingView widget
  // iframe height, calendar cards, chart-wide 显示设置). Card-level display
  // config (周期 / 时间范围 / 图表类型 / 主题) lives in each card's unified
  // edit modal; quote cards follow Canvas height when 高度 is omitted.
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
      text: t("以下为全局默认显示设置，各卡片可在编辑弹窗的「外观」中单独覆盖。"),
    });

    new Setting(chartDetails)
      .setName(t("显示图表图例"))
      .setDesc(t("K 线卡的十字光标图例（开/高/低/收/涨跌/量/自定义指标）和系列图的图例。"))
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
          .onChange(async (value) => {
            this.plugin.pluginSettings.gridOpacity = value;
            await this.plugin.saveSettings();
          })
      );
    gridOpacitySetting.setDisabled(!this.plugin.pluginSettings.showChartGrid);

    const note = containerEl.createDiv("fc-settings-note");
    note.appendText(t("卡片级配置（周期 / 时间范围 / 图表类型 / 主题）由各卡片的"));
    note.createEl("b", { text: t("统合编辑弹窗") });
    note.appendText(t("独立设置并随卡片保存；涨跌色与新建卡片的默认主题在本页上方全局配置，数据卡高度可自动匹配 Canvas 或在编辑弹窗中手动设置。"));
  }

  // 通用 tab section: canvas toolbar placement.
  private renderToolbarSettings(containerEl: HTMLElement): void {
    const lookDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
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

    new Setting(lookDetails).addButton((button) =>
      button.setButtonText(t("恢复默认位置")).onClick(async () => {
        const settings = this.plugin.pluginSettings;
        settings.toolbarPosition = "bottom-left";
        settings.toolbarOffsetX = 0;
        settings.toolbarOffsetY = 0;
        await this.plugin.saveSettings();
        this.plugin.toolbar.reload();
      })
    );
  }
}

// Dry-run confirmation for the cardPath→cardId upgrade: what will change,
// plus the refs that cannot be upgraded (they stay untouched either way).
class CardRefUpgradeConfirmModal extends Modal {
  private scan: CardRefScanResult;
  private onConfirm: () => void;

  constructor(app: App, scan: CardRefScanResult, options: { onConfirm: () => void }) {
    super(app);
    this.scan = scan;
    this.onConfirm = options.onConfirm;
  }

  onOpen() {
    this.setTitle(t("确认升级卡片引用"));
    const { contentEl } = this;
    contentEl.createDiv({
      cls: "fc-field-hint",
      text: t("将修改 {files} 个文件：为 {ids} 张计算卡补 id，改写 {refs} 条引用。", {
        files: this.scan.filesAffected.length,
        ids: this.scan.idsToAssign,
        refs: this.scan.refsToRewrite,
      }),
    });
    if (this.scan.unresolvable.length > 0) {
      contentEl.createEl("h4", { text: t("无法升级的引用（{n} 条，将保持原样）", { n: this.scan.unresolvable.length }) });
      const list = contentEl.createDiv({ cls: "fc-migration-report" });
      for (const failure of this.scan.unresolvable) {
        const row = list.createDiv({ cls: "fc-migration-report-row" });
        row.createDiv({ text: failure.ref, cls: "fc-mono" });
        row.createDiv({ cls: "fc-field-hint", text: t("{file} — {reason}", { file: failure.file, reason: failure.reason }) });
      }
    }
    if (this.scan.errors.length > 0) {
      contentEl.createEl("h4", { text: t("扫描出错（{n} 个文件）", { n: this.scan.errors.length }) });
      const list = contentEl.createDiv({ cls: "fc-migration-report" });
      for (const error of this.scan.errors) {
        const row = list.createDiv({ cls: "fc-migration-report-row" });
        row.createDiv({ text: error.file, cls: "fc-mono" });
        row.createDiv({ cls: "fc-field-hint", text: error.reason });
      }
    }
    const footer = contentEl.createDiv("fc-cleanup-footer");
    const cancel = footer.createEl("button", { text: t("取消") });
    cancel.addEventListener("click", () => this.close());
    const confirm = footer.createEl("button", { cls: "mod-cta", text: t("确认升级") });
    confirm.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

interface CardRefReportOptions {
  onRescan: () => void;
  // Offered only when execution succeeded but some refs were left as-is
  // (target gone/invalid) — the user explicitly accepts them as done.
  onMarkComplete?: () => void;
}

// Result checklist after 扫描并升级卡片引用: rewritten refs, refs left
// untouched (with reasons), and file-level execution errors. Notices only
// carry the transient summary; this modal is the real outcome.
class CardRefMigrationReportModal extends Modal {
  private report: CardRefMigrationReport;
  private options: CardRefReportOptions;

  constructor(app: App, report: CardRefMigrationReport, options: CardRefReportOptions) {
    super(app);
    this.report = report;
    this.options = options;
  }

  onOpen() {
    this.setTitle(t("卡片引用升级报告"));
    const { contentEl } = this;
    contentEl.createDiv({
      cls: "fc-field-hint",
      text: t("已补 id {ids} 张计算卡，改写引用 {refs} 条，涉及 {files} 个文件。", {
        ids: this.report.idsAssigned,
        refs: this.report.refsRewritten,
        files: this.report.filesChanged.length,
      }),
    });

    if (this.report.rewritten.length > 0) {
      contentEl.createEl("h4", { text: t("成功改写的引用（{n} 条）", { n: this.report.rewritten.length }) });
      const list = contentEl.createDiv({ cls: "fc-migration-report" });
      for (const entry of this.report.rewritten) {
        const row = list.createDiv({ cls: "fc-migration-report-row" });
        row.createDiv({ text: entry.ref, cls: "fc-mono" });
        row.createDiv({ cls: "fc-field-hint", text: entry.file });
      }
    }

    if (this.report.failures.length > 0) {
      contentEl.createEl("h4", { text: t("保持原样的引用（{n} 条）", { n: this.report.failures.length }) });
      contentEl.createDiv({
        cls: "fc-field-hint",
        text: t("这些引用的目标已丢失或无效，未做改动。确认无需保留后可点「仍然标记为完成」。"),
      });
      const list = contentEl.createDiv({ cls: "fc-migration-report" });
      for (const failure of this.report.failures) {
        const row = list.createDiv({ cls: "fc-migration-report-row" });
        row.createDiv({ text: failure.ref, cls: "fc-mono" });
        row.createDiv({ cls: "fc-field-hint", text: t("{file} — {reason}", { file: failure.file, reason: failure.reason }) });
      }
    }

    if (this.report.errors.length > 0) {
      contentEl.createEl("h4", { text: t("执行失败（{n} 个文件）", { n: this.report.errors.length }) });
      const list = contentEl.createDiv({ cls: "fc-migration-report" });
      for (const error of this.report.errors) {
        const row = list.createDiv({ cls: "fc-migration-report-row" });
        row.createDiv({ text: error.file, cls: "fc-mono" });
        row.createDiv({ cls: "fc-field-hint", text: error.reason });
      }
    }

    const footer = contentEl.createDiv("fc-cleanup-footer");
    const rescan = footer.createEl("button", { text: t("重新扫描") });
    rescan.addEventListener("click", () => {
      this.close();
      this.options.onRescan();
    });
    if (this.options.onMarkComplete) {
      const mark = footer.createEl("button", { cls: "mod-warning", text: t("仍然标记为完成") });
      mark.addEventListener("click", () => {
        this.close();
        this.options.onMarkComplete!();
      });
    }
    const done = footer.createEl("button", { cls: "mod-cta", text: t("关闭") });
    done.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class CardRepairReportModal extends Modal {
  constructor(
    app: App,
    private readonly report: CardRepairReport,
    private readonly options: { onRescan: () => void },
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: t("卡片修理结果") });
    if (this.report.repaired.length > 0) {
      contentEl.createEl("h4", { text: t("已修理（{n} 张卡片）", { n: this.report.repaired.length }) });
      const list = contentEl.createDiv({ cls: "fc-migration-report" });
      for (const item of this.report.repaired) {
        const row = list.createDiv({ cls: "fc-migration-report-row" });
        row.createDiv({ text: `${item.file} · ${item.blockType}`, cls: "fc-mono" });
        row.createDiv({ cls: "fc-field-hint", text: t("已移除字段：{keys}", { keys: item.keys.join(", ") }) });
      }
    }
    if (this.report.skipped.length > 0) {
      contentEl.createEl("h4", { text: t("保持原样（{n} 张卡片）", { n: this.report.skipped.length }) });
      const list = contentEl.createDiv({ cls: "fc-migration-report" });
      for (const item of this.report.skipped) {
        const row = list.createDiv({ cls: "fc-migration-report-row" });
        row.createDiv({ text: `${item.file} · ${item.blockType}`, cls: "fc-mono" });
        row.createDiv({ cls: "fc-field-hint", text: item.reason });
      }
    }
    if (this.report.errors.length > 0) {
      contentEl.createEl("h4", { text: t("执行失败（{n} 个文件）", { n: this.report.errors.length }) });
      const list = contentEl.createDiv({ cls: "fc-migration-report" });
      for (const error of this.report.errors) {
        const row = list.createDiv({ cls: "fc-migration-report-row" });
        row.createDiv({ text: error.file, cls: "fc-mono" });
        row.createDiv({ cls: "fc-field-hint", text: error.reason });
      }
    }
    const footer = contentEl.createDiv("fc-cleanup-footer");
    footer.createEl("button", { text: t("重新扫描") }).addEventListener("click", () => {
      this.close();
      this.options.onRescan();
    });
    footer.createEl("button", { cls: "mod-cta", text: t("关闭") }).addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
