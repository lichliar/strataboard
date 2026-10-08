import { App, Modal, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import type StrataBoardPlugin from "./main";
import type { CustomSourceDef, IndicatorInstance, ToolbarEntryId, ToolbarPosition, ToolbarSourceId, ToolbarStyle } from "./types";
import { isWholeTableSearchSource, resolveApiKeySource, sourceNeedsApiKey, cacheAssetKey } from "./types";
import { t, setLanguage, type Language } from "./i18n";
import { FolderPathSelect } from "./ui/folder-suggester";
import { CleanupConfirmModal } from "./ui/cleanup-modal";
import { ConfirmModal } from "./ui/confirm-modal";
import { TextInputModal } from "./ui/text-input-modal";
import { AI_SOURCE_PROMPT, CUSTOM_FORMAT_LABELS, CustomSourceImportModal, CustomSourceModal, mergeImportedSources } from "./ui/custom-source-modal";
import { CsvSourceModal } from "./ui/csv-source-modal";
import { BuiltinIndicatorEditModal } from "./ui/builtin-indicator-edit-modal";
import { MIN_REQUEST_INTERVAL_MS } from "./modules/http";
import {
  collectUsedCacheKeys,
  deleteStaleCacheEntry,
  findMissingIndicatorRefs,
  findOrphanCardFiles,
  findStaleCacheEntries,
  type MissingIndicatorRef,
} from "./modules/maintenance";
import { getScriptProvenance, isScriptSource, syncScriptSources } from "./modules/script-sources";
import { AI_SCRIPT_PROMPT } from "./modules/script-prompt";
import { AI_INDICATOR_PROMPT } from "./modules/indicator-prompt";
import { ScriptDatasetsModal } from "./ui/script-datasets-modal";
import { runCardRefMigration, type CardRefMigrationReport } from "./modules/card-ref-migration";
import { runMaMigration, type MaMigrationReport } from "./modules/card-ma-migration";
import { syncIndicatorFiles, getIndicatorLoadErrors } from "./modules/indicators/loader";
import { indicatorRegistry } from "./modules/indicators/registry";
import { ensureFolder } from "./modules/daily-notes";
import { renderAiGuide } from "./modules/ai-guide";
import { applyInfoDescs } from "./ui/info-desc";
import { openPluginSettings } from "./utils/obsidian-internals";
import { normalizePath, sanitizeFileNamePart } from "./utils/slug";
import { formatDateTime } from "./utils/date";

// One-click MCP/CLI setup prompt (AI 辅助 tab): the user pastes it into
// their own AI agent, which locates the vault itself and registers the MCP
// server in its own config — that way the settings tab never has to display
// the machine-local paths. The EN translation lives in i18n.ts under this
// exact string as key; keep the two in sync.
export const MCP_SETUP_PROMPT = `请帮我把 Obsidian 插件 StrataBoard 的 MCP server 配置好，之后你就可以直接调用它的工具了。

背景：StrataBoard 是一个 Obsidian 金融数据卡片插件，附带一个 MCP stdio server（需要 Node 18+），入口文件是 <vault根目录>/.obsidian/plugins/strataboard/mcp-server.js。它提供这些工具：search_symbols / list_sources / validate_cards / probe_data / get_card_guide。

请按以下步骤操作：
1. 确定我的 vault 根目录：如果当前工作目录在某个 Obsidian vault 内（向上查找包含 .obsidian 目录的位置）就直接用它；找不到就问我，不要猜。
2. 确认 mcp-server.js 已就位：检查 <vault根目录>/.obsidian/plugins/strataboard/ 下是否存在 mcp-server.js 和 cli.js。从 Obsidian 第三方插件市场安装的插件只包含 main.js / manifest.json / styles.css，这两个文件由插件在启动时从 GitHub release 自动补齐，所以：
   - 文件不存在时，先让我重启 Obsidian（或在插件设置里把 StrataBoard 禁用再启用），等插件自动下载完成后重新检查；
   - 重启后仍不存在（自动下载失败）时，打开 https://github.com/lichliar/strataboard/releases ，找到与插件版本号完全一致的 release（版本号见 Obsidian 设置 → StrataBoard → 通用设置顶部的「插件版本」），从该 release 下载 mcp-server.js 和 cli.js，手动放进插件目录。
   两个文件确认就位之前不要继续下一步。
3. 按你的客户端注册名为 strataboard 的 MCP server：command 为 node，args 为 ["<vault根目录>/.obsidian/plugins/strataboard/mcp-server.js", "--vault", "<vault根目录>"]（也可以用环境变量 STRATABOARD_VAULT 传 vault 路径）。
   - Codex：写入 ~/.codex/config.toml 的 [mcp_servers.strataboard]；
   - Claude Code：执行 claude mcp add，或编辑对应的配置文件；
   - 其它客户端：用它自己的 MCP 配置方式写入等价的 JSON。
4. 写完后把最终配置内容给我看一遍，并告诉我是否需要重启或重载客户端才能生效。
5. 如果 MCP 始终不可用，改用插件附带的 CLI：node "<vault根目录>/.obsidian/plugins/strataboard/cli.js" <命令> --vault "<vault根目录>"，命令有 search / sources / validate / probe。

用我使用的语言与我交流，遇到拿不准的地方先问我再动手。`;

// Dropdown sentinel value for the 新建分组… option in the source-group
// picker (a group name could never collide since we control the option).
const NEW_SOURCE_GROUP = "__new_group__";

export interface StrataBoardSettings {
  // User-defined custom REST quote sources (数据源设置 → 自定义数据源).
  customSources: CustomSourceDef[];
  // Custom SVG icons for source groups, keyed by group name (per-source
  // icons live on CustomSourceDef.icon).
  sourceGroupIcons: Record<string, string>;
  // UI language (通用设置 tab); command names only update after reload.
  language: Language;
  // Per-source toolbar visibility (工具栏设置 surfaces these toggles). Only
  // TradingView remains per-source; data inserts all go through 「插入图表」.
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
  // 本地脚本: folder holding user Python scripts; their CSV outputs land in
  // its output/ subfolder and are auto-registered as csv custom sources.
  scriptFolderPath: string;
  // 本地脚本: script paths (relative to scriptFolderPath, e.g.
  // "macro/cpi.py") the user disabled in the script manager.
  disabledScripts: string[];
  // 本地脚本: output CSV filePaths already processed by syncScriptSources —
  // a file is registered at most once, so a source the user deleted is never
  // rebuilt.
  seenScriptOutputs: string[];
  // 指标管理: folder holding user custom-indicator .js files (oakscriptjs
  // contract); synced into the indicator registry on load and on changes.
  indicatorFolderPath: string;
  // 指标管理: indicator file paths (relative to indicatorFolderPath) the user
  // disabled in the 指标管理 tab.
  disabledIndicators: string[];
  // 指标管理: user overrides of built-in indicator default parameters, keyed
  // by indicator id. Merge order at compute time is def.defaultInputs <
  // builtinIndicatorInputs[id] < card-instance inputs.
  builtinIndicatorInputs: Record<string, Record<string, unknown>>;
  // 新卡默认指标 (卡片与组件 tab): instances applied to quote cards whose
  // YAML has no `indicators` key. Default: ma 5/10/20/60.
  defaultIndicators: IndicatorInstance[];
  // One-shot latch for the 均线/显示均线 → indicators card migration: false
  // until the startup scan proves the vault clean or the user runs
  // 升级均线指标 in 清理维护. While false, that section shows a hint.
  maMigrationDone: boolean;
  // One-shot flag for the cardPath→cardId reference upgrade: false until the
  // startup scan proves the vault clean (then set silently) or the user runs
  // 升级卡片引用 in 清理维护. While false, that section shows a hint.
  cardRefsUpgraded: boolean;
  dataCachePath: string;
  symbolCachePath: string;
  autoRefreshOnOpen: boolean;
  toolbarPosition: ToolbarPosition;
  toolbarOffsetX: number;
  toolbarOffsetY: number;
  toolbarCollapsed: boolean;
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
}

export const DEFAULT_SETTINGS: StrataBoardSettings = {
  customSources: [],
  sourceGroupIcons: {},
  language: "zh",
  toolbarSources: { tradingview: true },
  toolbarStyle: "text",
  toolbarOrder: ["insert-data", "data-tools", "tradingview", "components"],
  toolbarIconSize: 16,
  toolbarWidth: 44,
  cardLibraryPath: "金融卡片",
  widgetCardPath: "金融卡片/TradingView Widgets",
  componentCardPath: "金融卡片/组件",
  scriptFolderPath: "金融卡片/脚本",
  disabledScripts: [],
  seenScriptOutputs: [],
  indicatorFolderPath: "指标",
  disabledIndicators: [],
  builtinIndicatorInputs: {},
  defaultIndicators: [
    { id: "ma", inputs: { length: 5 } },
    { id: "ma", inputs: { length: 10 } },
    { id: "ma", inputs: { length: 20 } },
    { id: "ma", inputs: { length: 60 } },
  ],
  maMigrationDone: false,
  cardRefsUpgraded: false,
  dataCachePath: "金融卡片/数据缓存",
  symbolCachePath: "金融卡片/股票代码缓存",
  autoRefreshOnOpen: true,
  toolbarPosition: "bottom-left",
  toolbarOffsetX: 16,
  toolbarOffsetY: 16,
  toolbarCollapsed: false,
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
};

// Static source labels for the 工具栏显示 toggles (Chinese keys, translated
// at render time via t()).
const TOOLBAR_SOURCE_LABELS: Record<ToolbarSourceId, string> = {
  tradingview: "TradingView Widget",
};

const TOOLBAR_ENTRY_LABELS: Record<ToolbarEntryId, string> = {
  "insert-data": "插入图表",
  "data-tools": "数据处理",
  tradingview: "TradingView Widget",
  components: "组件",
};

type SettingsTabId = "general" | "data-source" | "indicators" | "external-ai" | "paths" | "cards" | "toolbar";

const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: "general", label: "通用设置" },
  { id: "data-source", label: "数据源设置" },
  { id: "indicators", label: "指标管理" },
  { id: "external-ai", label: "AI 辅助" },
  { id: "paths", label: "路径设置" },
  { id: "cards", label: "卡片与组件" },
  { id: "toolbar", label: "工具栏设置" },
];

// Set by openSettingsTab and consumed by the next display() so the settings
// window opens directly on the requested tab (e.g. AI 辅助 from the
// custom-source modal's AI section).
let pendingTab: SettingsTabId | null = null;

export function openSettingsTab(app: App, tab: SettingsTabId): void {
  pendingTab = tab;
  openPluginSettings(app, "strataboard");
}

export class StrataBoardSettingTab extends PluginSettingTab {
  plugin: StrataBoardPlugin;
  private activeTab: SettingsTabId = "general";
  // 数据源设置 groups render collapsed by default; expanded state lives on
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
      case "indicators":
        this.renderIndicatorSettings(contentEl);
        break;
      case "external-ai":
        this.renderExternalAiSettings(contentEl);
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

    // Field explanations collapse to hover-only info icons (说明文字悬停才
    // 显示); content rows opt out via .fc-keep-desc / .fc-source-group-header.
    applyInfoDescs(containerEl);
  }

  private renderGeneralSettings(containerEl: HTMLElement): void {
    // Plugin version from manifest.json; release.mjs tags GitHub releases with
    // exactly this version, so the two always match. The version number is
    // content, not an explanation — keep it visible (fc-keep-desc).
    new Setting(containerEl)
      .setName(t("插件版本"))
      .setDesc(this.plugin.manifest.version)
      .settingEl.addClass("fc-keep-desc");

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

    // Legal text lives at the bottom of 通用设置, collapsed by default like
    // every other settings sub-section.
    const disclaimerDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    disclaimerDetails.createEl("summary", { text: t("免责声明") });
    this.renderDisclaimerSettings(disclaimerDetails);
  }

  // 数据源设置 tab: the plugin ships no data sources — this tab is the
  // user-configured custom source list (top level) plus the global request
  // throttle.
  private renderDataSourceSettings(containerEl: HTMLElement): void {
    this.renderCustomSourceSettings(containerEl);

    new Setting(containerEl)
      .setName(t("请求最小间隔（毫秒）"))
      .setDesc(t("所有数据请求按此间隔串行发出，间隔过低可能被数据平台限流或封禁 IP。下限 200ms（保守安全值），默认 500ms。"))
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

  // 指标管理 tab: builtins are a read-only reference list; customs are
  // per-file rows (the loader only registers ENABLED files, so rows are
  // enumerated from the indicator folder itself and cross-referenced with the
  // registry by file-name slug) plus the load errors of the last sync.
  private renderIndicatorSettings(containerEl: HTMLElement): void {
    containerEl.createDiv({
      cls: "fc-field-hint",
      text: t("自定义指标文件是拥有完整插件权限的可信代码（与本地脚本同理）：只添加来源可信的文件。"),
    });

    const builtinDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    builtinDetails.createEl("summary", { text: t("内置指标") });
    for (const def of indicatorRegistry.list().filter((d) => d.origin === "builtin")) {
      const overrides = this.plugin.pluginSettings.builtinIndicatorInputs[def.id] ?? {};
      const changed = def.inputConfig
        .filter((cfg) => overrides[cfg.id] !== undefined)
        .map((cfg) => `${cfg.title ?? cfg.id}=${String(overrides[cfg.id])}`);
      const row = new Setting(builtinDetails)
        .setName(`${t(def.name)} · ${def.id}`)
        .setDesc(
          [
            `${t(def.category)} · ${def.metadata.overlay ? t("主图") : t("副图")}`,
            changed.length > 0 ? t("已改：{list}", { list: changed.join(" · ") }) : null,
          ]
            .filter((part): part is string => !!part)
            .join(" · ")
        );
      // The row desc carries identifying content, not an explanation.
      row.settingEl.addClass("fc-keep-desc");
      row.addButton((btn) =>
        btn.setButtonText(t("编辑")).onClick(() => {
          new BuiltinIndicatorEditModal(this.app, def, overrides, (next) => {
            void (async () => {
              const all = this.plugin.pluginSettings.builtinIndicatorInputs;
              if (Object.keys(next).length > 0) {
                all[def.id] = next;
              } else {
                delete all[def.id];
              }
              await this.plugin.saveSettings();
              // Existing cards pick up the new defaults immediately.
              for (const renderer of this.plugin.chartRenderers) renderer.refreshCard();
              this.display();
            })();
          }).open();
        })
      );
    }

    const folder = normalizePath(this.plugin.pluginSettings.indicatorFolderPath);
    const customDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    customDetails.createEl("summary", { text: t("自定义指标") });

    new Setting(customDetails)
      .setName(t("指标文件夹"))
      .setDesc(t("{folder}（在设置页「路径设置」中修改）", { folder }))
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

    new Setting(containerEl)
      .setName(t("AI 辅助"))
      .setDesc(t("编写自定义指标的提示词在设置页「AI 辅助」tab。"))
      .addButton((btn) =>
        btn.setButtonText(t("前往 AI 辅助")).onClick(() => openSettingsTab(this.app, "external-ai"))
      );
  }

  // One custom-indicator file row: enable toggle (keyed by folder-relative
  // path), 编辑 (system editor), 删除 (confirm; referencing cards lose the
  // indicator).
  private renderCustomIndicatorRow(containerEl: HTMLElement, file: TFile, folder: string): void {
    const rel = file.path.slice(folder.length + 1);
    const def = indicatorRegistry.resolve(sanitizeFileNamePart(file.basename));
    const disabled = this.plugin.pluginSettings.disabledIndicators.includes(rel);
    const setting = new Setting(containerEl)
      .setName(def && !disabled ? t(def.name) : file.name)
      .setDesc(
        [
          rel,
          def && !disabled ? `${t(def.category)} · ${def.metadata.overlay ? t("主图") : t("副图")}` : null,
          disabled ? t("已禁用") : !def ? t("未加载") : null,
        ]
          .filter((part): part is string => !!part)
          .join(" · ")
      );
    setting.settingEl.addClass("fc-keep-desc");
    setting.addToggle((toggle) =>
      toggle
        .setTooltip(t("启用/禁用指标"))
        .setValue(!disabled)
        .onChange(async (value) => {
          const list = this.plugin.pluginSettings.disabledIndicators.filter((p) => p !== rel);
          if (!value) list.push(rel);
          this.plugin.pluginSettings.disabledIndicators = list;
          await this.plugin.saveSettings();
          await syncIndicatorFiles(this.plugin);
          this.display();
        })
    );
    setting.addButton((btn) => btn.setButtonText(t("编辑")).onClick(() => this.openIndicatorFile(file)));
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

  private openIndicatorFile(file: TFile): void {
    this.openPathInSystem(file.path);
  }

  // Full legal text, rendered inside the collapsed 免责声明 block at the
  // bottom of 通用设置.
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
      "本地脚本",
      "脚本由您自行编写与运行（包括借助 AI 生成的脚本），本插件不审查、不担保脚本的行为。脚本的数据获取行为及其与数据来源之间的授权关系由您自行负责，您须遵守数据来源平台的服务条款；本插件仅读取脚本产出的本地 CSV 文件。脚本功能不适合高频数据，不得作为批量下载工具使用。"
    );

    section(
      "数据版权与使用范围",
      "行情、宏观等数据的一切权利归原始发布平台所有。相关数据仅供您个人学习与研究使用，不得用于商业用途，不得对外再分发。"
    );

    section(
      "不构成投资建议",
      "通过本插件展示的数据可能存在延迟、错误、遗漏或中断。插件展示的任何内容均不构成投资建议、要约或招揽。据此操作，风险自担。"
    );

    section(
      "无担保与责任限制",
      "本插件按\"现状\"提供，作者不作任何明示或默示的担保。在适用法律允许的最大范围内，作者不对因使用或无法使用本插件而产生的任何直接或间接损失承担责任。"
    );
  }

  // AI 辅助: no built-in assistant — external agents (Codex, Claude Code,
  // …) drive the plugin through the bundled MCP server or CLI. Layout: one
  // 接入 block (MCP one-click prompt + manual snippets + CLI) followed by
  // one prompt block per task scenario (add a data source / author cards /
  // write scripts), so the user picks a prompt by what they want to do. No
  // machine-local paths are shown (they would leak private directory names):
  // every snippet uses the <vault路径> placeholder, and the one-click setup
  // prompt lets the user's AI agent locate the vault and register the server
  // itself.
  private renderExternalAiSettings(containerEl: HTMLElement): void {
    // Placeholder standing in for the vault root everywhere a snippet would
    // otherwise embed the real (private) absolute path. The plugin id itself
    // is public, so only the vault part is masked.
    const pluginDir = `<vault路径>/.obsidian/plugins/${this.plugin.manifest.id}`;

    const accessDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    accessDetails.createEl("summary", { text: t("接入 StrataBoard MCP / CLI") });
    accessDetails.createDiv({
      cls: "fc-field-hint",
      text: t("最省事的方式：复制「一键配置提示词」发给你的 AI agent，它会自动定位 vault 路径并完成注册；下方配置片段供手动配置，把 <vault路径> 换成你的 vault 根目录。"),
    });
    this.addCodeSnippet(accessDetails, t("一键配置提示词（复制给你的 AI）"), t(MCP_SETUP_PROMPT));
    this.addCodeSnippet(
      accessDetails,
      t("Codex（~/.codex/config.toml）"),
      `[mcp_servers.strataboard]\ncommand = "node"\nargs = ["${pluginDir}/mcp-server.js", "--vault", "<vault路径>"]`
    );
    this.addCodeSnippet(
      accessDetails,
      t("其他 agent（Claude Code 等，JSON 配置）"),
      JSON.stringify(
        { mcpServers: { strataboard: { command: "node", args: [`${pluginDir}/mcp-server.js`, "--vault", "<vault路径>"] } } },
        null,
        2
      )
    );
    this.addCodeSnippet(
      accessDetails,
      t("CLI 命令（MCP 不可用时的替代）"),
      `node ${pluginDir}/cli.js <命令> [--vault <vault路径>]\n\nsearch / sources / validate / probe`
    );
    accessDetails.createDiv({
      cls: "fc-field-hint",
      text: t("提供工具：search_symbols / list_sources / validate_cards / probe_data / get_card_guide。"),
    });
    accessDetails.createDiv({
      cls: "fc-field-hint",
      text: t("所有命令输出 JSON，适合脚本与 agent 调用；--vault 缺省时读环境变量 STRATABOARD_VAULT，再从当前目录向上查找含 .obsidian 的目录。"),
    });

    const sourceDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    sourceDetails.createEl("summary", { text: t("提示词：添加数据源") });
    sourceDetails.createDiv({
      cls: "fc-field-hint",
      text: t("想让 AI 帮你找接口、生成数据源配置时使用（需先完成上方接入）。AI 会引导你确认需求、检查已有数据源是否已覆盖，再找接口并核对插件适配范围，能配的数据尽量一次配齐，产出可直接粘贴的 URL 或写入 vault 的配置 JSON（在 数据源设置 → 导入 中选择导入），并自行验证；插件不支持的接口形态会明确告知，并建议改用本地脚本。"),
    });
    this.addCodeSnippet(sourceDetails, t("引导提示词（复制给你的 AI）"), t(AI_SOURCE_PROMPT));

    const cardDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    cardDetails.createEl("summary", { text: t("提示词：编写 / 修改卡片") });
    cardDetails.createDiv({
      cls: "fc-field-hint",
      text: t("想让 AI 直接创建或修改卡片文件时使用：完整的卡片块 YAML 规范与示例，复制全文交给 AI 先读再写。MCP 客户端可直接调用 get_card_guide 工具获取，无需手动复制。"),
    });
    this.addCodeSnippet(cardDetails, t("指南全文（Markdown）"), renderAiGuide(pluginDir));

    const scriptDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    scriptDetails.createEl("summary", { text: t("提示词：编写数据处理脚本") });
    scriptDetails.createDiv({
      cls: "fc-field-hint",
      text: t("接口形态插件不支持（需要登录、返回 HTML/XML 等）、或想自己抓取 / 加工数据时使用。在「{folder}」中放置 Python 脚本，脚本把结果 CSV 写入其 output/ 子目录，插件会自动把它注册为自定义数据源（之后可建独立卡、叠加卡、计算卡）；画布工具栏「数据处理 → 本地脚本」（或命令「打开本地脚本管理」）里可立即运行、查看日志。复制下方提示词（已附产物契约与合规规则），连同你的需求或报错一起发给你的 AI。", {
        folder: this.plugin.pluginSettings.scriptFolderPath,
      }),
    });
    this.addCodeSnippet(scriptDetails, t("脚本编写提示词（复制给你的 AI）"), t(AI_SCRIPT_PROMPT));

    const indicatorDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    indicatorDetails.createEl("summary", { text: t("提示词：编写技术指标") });
    indicatorDetails.createDiv({
      cls: "fc-field-hint",
      text: t("想在 K 线卡上加自定义技术指标时使用。把 .js 指标文件放进「{folder}」，插件会自动注册进指标系统（管理见设置页「指标管理」tab：逐行启用/编辑/删除/从文件导入，加载失败会红字列出原因）。复制下方提示词（已附文件契约、注入的 oak API 与合规红线），连同你的需求或报错一起发给你的 AI。", {
        folder: this.plugin.pluginSettings.indicatorFolderPath,
      }),
    });
    this.addCodeSnippet(indicatorDetails, t("指标编写提示词（复制给你的 AI）"), t(AI_INDICATOR_PROMPT));
  }

  // Monospace snippet block with a copy button (MCP/CLI config fragments).
  private addCodeSnippet(container: HTMLElement, label: string, code: string): void {
    const block = container.createDiv("fc-code-snippet");
    const head = block.createDiv("fc-code-snippet-head");
    head.createSpan({ text: label });
    const copyBtn = head.createEl("button", { text: t("复制") });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(code).then(
        () => new Notice(t("已复制到剪贴板。")),
        () => new Notice(t("复制失败，请手动选中复制。")),
      );
    });
    block.createEl("pre", { cls: "fc-mono", text: code });
  }

  // 自定义数据源 management: the plugin ships no data sources — each entry
  // is a user-configured REST/JSON endpoint template or vault CSV file (see
  // CustomSourceModal / CsvSourceModal). Rendered at the top level of the
  // 数据源设置 tab. Toggling 启用 gates pickers/toolbar entries; deleting a
  // source breaks cards that reference it (they render the missing-source
  // error).
  private renderCustomSourceSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .addButton((btn) =>
        btn
          .setButtonText(t("添加数据源"))
          .setCta()
          .onClick(() => this.openCustomSourceModal())
      )
      .addButton((btn) =>
        btn.setButtonText(t("添加 CSV 源")).onClick(() => this.openCsvSourceModal())
      )
      .addButton((btn) =>
        btn.setButtonText(t("导入")).onClick(() => {
          new CustomSourceImportModal(this.app, (defs, warnings) => {
            // Same-name entries overwrite in place (old id and apiKey are
            // kept), so re-importing a corrected config never duplicates.
            const { updated, added } = mergeImportedSources(this.plugin.pluginSettings.customSources, defs);
            void this.plugin.saveSettings().then(() => {
              new Notice(t("导入成功：更新 {updated} 个、新增 {added} 个数据源。", { updated, added }));
              for (const warning of warnings.slice(0, 5)) new Notice(warning, 8000);
              if (warnings.length > 5) new Notice(t("另有 {n} 条导入警告未显示。", { n: warnings.length - 5 }));
              this.warmWholeTableSearchCache(defs);
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
          // API keys stay local — they never leave in an exported config.
          const exported = sources.map(({ apiKey: _apiKey, ...rest }) => rest);
          void navigator.clipboard.writeText(JSON.stringify(exported, null, 2)).then(
            () => new Notice(t("已导出 {n} 个数据源到剪贴板（API Key 不随配置导出）。", { n: sources.length })),
            () => new Notice(t("导出失败：无法访问剪贴板。")),
          );
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
      new Setting(containerEl)
        .setClass("fc-source-group-header")
        .setName(group)
        .setDesc(t("数据源组 · {n} 个源", { n: members.length }))
        .addExtraButton((btn) =>
          btn
            .setIcon(expanded ? "chevron-down" : "chevron-right")
            .setTooltip(expanded ? t("收起分组") : t("展开分组"))
            .onClick(() => {
              if (this.expandedSourceGroups.has(group)) {
                this.expandedSourceGroups.delete(group);
              } else {
                this.expandedSourceGroups.add(group);
              }
              this.display();
            })
        )
        .addButton((btn) =>
          btn.setButtonText(t("图标")).onClick(() => {
            const icons = this.plugin.pluginSettings.sourceGroupIcons;
            new TextInputModal(
              this.app,
              t("自定义组图标"),
              (svg) => {
                if (svg) {
                  icons[group] = svg;
                } else {
                  delete icons[group];
                }
                void this.plugin.saveSettings().then(() => this.display());
              },
              icons[group] ?? "",
              { multiline: true, allowEmpty: true }
            ).open();
          })
        )
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
              const icons = this.plugin.pluginSettings.sourceGroupIcons;
              if (icons[group]) {
                icons[trimmed] = icons[group];
                delete icons[group];
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
                delete this.plugin.pluginSettings.sourceGroupIcons[group];
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
        text: t("脚本产物（{folder}/output/*.csv）会自动注册为数据源并显示在这里；脚本管理见画布工具栏「数据处理 → 本地脚本」。", { folder }),
      });
      return;
    }
    for (const def of scriptSources) {
      const prov = getScriptProvenance(this.plugin, def.id);
      const scriptRel = prov?.scriptFile ? prov.scriptFile.path.slice(folder.length + 1) : null;
      const outputRel = def.filePath?.startsWith(`${folder}/`) ? def.filePath.slice(folder.length + 1) : def.filePath;
      const lastRun = prov?.outputFile ? formatDateTime(prov.outputFile.stat.mtime) : null;
      const setting = new Setting(details)
        .setName(def.purpose === "signals" ? t("{name}（信号源）", { name: def.name }) : def.name)
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

  private renderCustomSourceRow(
    containerEl: HTMLElement,
    def: CustomSourceDef,
    groupNames: string[],
    indented: boolean
  ): void {
    const setting = new Setting(containerEl)
      .setName(def.name)
      .setDesc(
        [
          `${t(CUSTOM_FORMAT_LABELS[def.format])} · ${def.format === "csv" ? def.filePath ?? def.klineUrl ?? "" : def.klineUrl ?? ""}`,
          this.describeApiKeySource(def),
        ]
          .filter(Boolean)
          .join(" · ")
      );
    if (indented) setting.setClass("fc-source-group-member");
    // The row desc carries identifying content (format · URL · key source),
    // not an explanation — keep it visible instead of an info-icon tooltip.
    setting.settingEl.addClass("fc-keep-desc");
    setting.addDropdown((dropdown) => {
      dropdown.addOption("", t("未分组"));
      for (const name of groupNames) {
        dropdown.addOption(name, name);
      }
      dropdown.addOption(NEW_SOURCE_GROUP, t("新建分组…"));
      dropdown.setValue(def.group ?? "").onChange((value) => {
        if (value === NEW_SOURCE_GROUP) {
          new TextInputModal(this.app, t("新建分组"), (name) => {
            const trimmed = name.trim();
            if (!trimmed) return;
            def.group = trimmed;
            void this.plugin.saveSettings().then(() => this.display());
          }).open();
          return;
        }
        if (value) {
          def.group = value;
        } else {
          delete def.group;
        }
        void this.plugin.saveSettings().then(() => this.display());
      });
    });
    setting.addToggle((toggle) =>
      toggle.setValue(def.enabled).onChange(async (value) => {
        def.enabled = value;
        await this.plugin.saveSettings();
        this.display();
      })
    );
    setting.addButton((btn) =>
      btn.setButtonText(t("编辑")).onClick(() => {
        if (def.format === "csv") {
          this.openCsvSourceModal(def);
        } else {
          this.openCustomSourceModal(def);
        }
      })
    );
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

  // Where the source's runtime apiKey comes from, for the row description:
  // own entry, borrowed from a named group member, or missing even though
  // the templates ask for one (a silent-401 trap worth surfacing).
  private describeApiKeySource(def: CustomSourceDef): string | null {
    const info = resolveApiKeySource(def, this.plugin.pluginSettings.customSources);
    if (info.source === "self") return t("密钥：本条目");
    if (info.source === "group") return t("密钥：复用自「{name}」", { name: info.donorName ?? "" });
    if (def.group?.trim() && sourceNeedsApiKey(def)) return t("密钥：未找到（组内无已填密钥的启用源）");
    return null;
  }

  // Warms the whole-table search cache for freshly imported enabled
  // sources, so the first search after import doesn't stall on a cold
  // multi-thousand-row fetch through the serial throttle. Fire-and-forget.
  private warmWholeTableSearchCache(defs: CustomSourceDef[]): void {
    for (const def of defs) {
      if (!def.enabled || !isWholeTableSearchSource(def)) continue;
      void this.plugin.dataAdapter?.searchRemoteQuotes(def.id, "").catch(() => undefined);
    }
  }

  private openCustomSourceModal(def?: CustomSourceDef): void {
    new CustomSourceModal(
      this.app,
      def,
      (result) => this.upsertCustomSource(result),
      () => openSettingsTab(this.app, "external-ai"),
      this.plugin.pluginSettings.customSources
    ).open();
  }

  private openCsvSourceModal(def?: CustomSourceDef): void {
    new CsvSourceModal(this.app, def, (result) => this.upsertCustomSource(result)).open();
  }

  private upsertCustomSource(result: CustomSourceDef): void {
    const sources = this.plugin.pluginSettings.customSources;
    const index = sources.findIndex((s) => s.id === result.id);
    if (index >= 0) {
      sources[index] = result;
    } else {
      sources.push(result);
    }
    void this.plugin.saveSettings().then(() => this.display());
  }

  private renderPathSettings(containerEl: HTMLElement): void {
    // 卡片路径: the three card folders, folded like 缓存路径 below.
    const cardDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
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

    this.addFolderPathSetting(cardDetails, {
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

    const cacheDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    cacheDetails.createEl("summary", { text: t("缓存路径（高级）") });

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

    // Shown until the startup scan proves the vault clean (or the upgrade has
    // run): legacy cardPath references no longer resolve and need the
    // one-click upgrade below.
    if (!this.plugin.pluginSettings.cardRefsUpgraded) {
      details.createDiv({
        cls: "fc-field-hint",
        text: t("⚠ 本库可能仍存在旧格式（cardPath）的卡片引用——旧引用已无法解析，请运行下方「升级卡片引用」。"),
      });
    }

    new Setting(details)
      .setName(t("升级卡片引用"))
      .setDesc(t("把旧格式（cardPath 文件路径）的卡片引用批量升级为稳定 id 引用：给计算卡补 id、把指向资产卡的引用改写为直接数据引用。升级后卡片改名、移动都不再断引用。目标文件已丢失的引用不会改动，会在报告中列出。"))
      .addButton((btn) =>
        btn.setButtonText(t("升级卡片引用")).onClick(() => void this.runCardRefUpgrade())
      );

    // Shown until the startup scan proves the vault clean (or the upgrade has
    // run): legacy 均线/显示均线 keys no longer render and need the one-click
    // upgrade below.
    if (!this.plugin.pluginSettings.maMigrationDone) {
      details.createDiv({
        cls: "fc-field-hint",
        text: t("⚠ 本库可能仍存在旧格式（均线/显示均线）的卡片设置——旧键已不再生效，请运行下方「升级均线指标」。"),
      });
    }

    new Setting(details)
      .setName(t("升级均线指标"))
      .setDesc(t("把资产卡 YAML 里的旧均线设置（均线 / 显示均线）批量改写为统一的 indicators 指标列表：均线周期列表转为对应数量的 ma 指标，显示均线: false 转为空指标列表，显示均线: true 直接删键（跟随全局默认）。无法解析的卡片不会改动，会在报告中列出。"))
      .addButton((btn) =>
        btn.setButtonText(t("升级均线指标")).onClick(() => void this.runMaMigrationUpgrade())
      );

    new Setting(details)
      .setName(t("检查失效指标引用"))
      .setDesc(t("扫描卡片库中资产卡的指标列表，找出引用了不存在（已删除/改名或拼写错误）指标的卡片。"))
      .addButton((btn) =>
        btn.setButtonText(t("扫描失效引用")).onClick(() => void this.runIndicatorRefCheck())
      );

    new Setting(details)
      .setName(t("清理孤立卡片文件"))
      .setDesc(t("清理卡片路径下没有被任何画布、笔记链接或数据计算卡片引用的卡片文件（删除后进入回收站）。"))
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

  private async runCardRefUpgrade(): Promise<void> {
    new Notice(t("正在升级卡片引用…"));
    const report = await runCardRefMigration(this.app, this.plugin.pluginSettings.cardLibraryPath);
    this.plugin.pluginSettings.cardRefsUpgraded = true;
    await this.plugin.saveSettings();
    new Notice(
      t("升级完成：补 id {ids} 张计算卡，改写引用 {refs} 条，失败 {fails} 条。", {
        ids: report.idsAssigned,
        refs: report.refsRewritten,
        fails: report.failures.length,
      })
    );
    if (report.failures.length > 0) {
      new CardRefMigrationReportModal(this.app, report).open();
    }
    this.display(); // refresh the ⚠ hint line
  }

  private async runMaMigrationUpgrade(): Promise<void> {
    new Notice(t("正在升级均线指标…"));
    const report = await runMaMigration(this.app, this.plugin.pluginSettings.cardLibraryPath);
    this.plugin.pluginSettings.maMigrationDone = true;
    await this.plugin.saveSettings();
    new Notice(
      t("升级完成：改写 {cards} 张卡片，涉及 {files} 个文件，失败 {fails} 个。", {
        cards: report.cardsRewritten,
        files: report.filesChanged,
        fails: report.failures.length,
      })
    );
    if (report.failures.length > 0) {
      new MaMigrationReportModal(this.app, report).open();
    }
    this.display(); // refresh the ⚠ hint line
  }

  // Read-only scan: quote cards referencing an indicator id the registry no
  // longer resolves (custom indicator deleted/renamed, or a typo).
  private async runIndicatorRefCheck(): Promise<void> {
    new Notice(t("正在扫描失效指标引用…"));
    const missing = await findMissingIndicatorRefs(this.app, [this.plugin.pluginSettings.cardLibraryPath]);
    if (missing.length === 0) {
      new Notice(t("没有发现失效的指标引用。"));
      return;
    }
    new MissingIndicatorRefsModal(this.app, missing).open();
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
    const used = await collectUsedCacheKeys(this.app, this.plugin.cardIndex);
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

    new Setting(chartDetails)
      .setName(t("新卡默认显示均线（5/10/20/60）"))
      .setDesc(t("新建 K 线卡默认叠加的四条均线指标；关闭后新卡不叠加任何指标。每张卡片可在编辑弹窗的「技术指标」中自定义，自定义后不再跟随此处。"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.defaultIndicators.length > 0).onChange(async (value) => {
          // Fresh array each time: the toggle only ever produces the two
          // canonical states (four ma instances / none).
          this.plugin.pluginSettings.defaultIndicators = value
            ? [
                { id: "ma", inputs: { length: 5 } },
                { id: "ma", inputs: { length: 10 } },
                { id: "ma", inputs: { length: 20 } },
                { id: "ma", inputs: { length: 60 } },
              ]
            : [];
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
    note.appendText(t("卡片级配置（周期 / 时间范围 / 图表类型 / 主题 / 涨跌色 / 图表高度）由各卡片的"));
    note.createEl("b", { text: t("统合编辑弹窗") });
    note.appendText(t("独立设置并随卡片保存，此处不再提供全局默认，避免两处配置互相覆盖；新建卡片使用内置默认值。"));
  }

  private renderToolbarSettings(containerEl: HTMLElement): void {
    // 外观 open by default; source visibility and button order fold away.
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

    new Setting(lookDetails)
      .setName(t("显示效果"))
      .setDesc(t("工具栏按钮显示为纯图标（悬停显示名称）或文字。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("text", t("文字"))
          .addOption("icon", t("图标"))
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
      text: t("关闭后对应入口不再出现在画布工具栏（命令面板与右键菜单不受影响）。其余数据入口统一走「插入图表」。"),
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

// Read-only report after 升级卡片引用: lists the legacy refs that could not
// be rewritten (target file gone / target not a valid card). Those YAML
// entries are intentionally left untouched as the only clue to what was
// referenced.
class CardRefMigrationReportModal extends Modal {
  private report: CardRefMigrationReport;

  constructor(app: App, report: CardRefMigrationReport) {
    super(app);
    this.report = report;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: t("卡片引用升级报告") });
    contentEl.createDiv({
      cls: "fc-field-hint",
      text: t("已补 id {ids} 张计算卡，改写引用 {refs} 条，涉及 {files} 个文件。", {
        ids: this.report.idsAssigned,
        refs: this.report.refsRewritten,
        files: this.report.filesChanged.length,
      }),
    });
    contentEl.createEl("h4", { text: t("未能升级的引用（{n} 条，已原样保留）", { n: this.report.failures.length }) });
    const list = contentEl.createDiv({ cls: "fc-migration-report" });
    for (const failure of this.report.failures) {
      const row = list.createDiv({ cls: "fc-migration-report-row" });
      row.createDiv({ text: failure.ref, cls: "fc-mono" });
      row.createDiv({ cls: "fc-field-hint", text: t("{file} — {reason}", { file: failure.file, reason: failure.reason }) });
    }
    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText(t("知道了")).setCta().onClick(() => this.close())
    );
  }
}

// Read-only report after 升级均线指标: lists the quote blocks whose legacy MA
// keys could not be rewritten (broken YAML / unusable 均线 value). Those
// blocks are intentionally left untouched.
class MaMigrationReportModal extends Modal {
  private report: MaMigrationReport;

  constructor(app: App, report: MaMigrationReport) {
    super(app);
    this.report = report;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: t("均线指标升级报告") });
    contentEl.createDiv({
      cls: "fc-field-hint",
      text: t("已改写 {cards} 张卡片，涉及 {files} 个文件。", {
        cards: this.report.cardsRewritten,
        files: this.report.filesChanged,
      }),
    });
    contentEl.createEl("h4", { text: t("未能升级的卡片（{n} 个，已原样保留）", { n: this.report.failures.length }) });
    const list = contentEl.createDiv({ cls: "fc-migration-report" });
    for (const failure of this.report.failures) {
      const row = list.createDiv({ cls: "fc-migration-report-row" });
      row.createDiv({ text: failure.file, cls: "fc-mono" });
      row.createDiv({ cls: "fc-field-hint", text: failure.reason });
    }
    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText(t("知道了")).setCta().onClick(() => this.close())
    );
  }
}

// Read-only list of quote cards referencing an indicator id the registry
// cannot resolve (custom indicator deleted/renamed, or a typo in YAML).
class MissingIndicatorRefsModal extends Modal {
  private missing: MissingIndicatorRef[];

  constructor(app: App, missing: MissingIndicatorRef[]) {
    super(app);
    this.missing = missing;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: t("失效指标引用（{n} 处）", { n: this.missing.length }) });
    contentEl.createDiv({
      cls: "fc-field-hint",
      text: t("以下卡片的 indicators 列表引用了不存在的指标 id；请编辑卡片修正，或检查指标文件是否被删除/改名。"),
    });
    const list = contentEl.createDiv({ cls: "fc-migration-report" });
    for (const entry of this.missing) {
      const row = list.createDiv({ cls: "fc-migration-report-row" });
      row.createDiv({ text: entry.id, cls: "fc-mono" });
      row.createDiv({ cls: "fc-field-hint", text: entry.file });
    }
    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText(t("知道了")).setCta().onClick(() => this.close())
    );
  }
}
