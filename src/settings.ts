import { App, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import type StrataBoardPlugin from "./main";
import type { CustomSourceDef, ToolbarEntryId, ToolbarPosition, ToolbarSourceId, ToolbarStyle } from "./types";
import { t, setLanguage, type Language } from "./i18n";
import { FolderPathSelect } from "./ui/folder-suggester";
import { CleanupConfirmModal } from "./ui/cleanup-modal";
import { ConfirmModal } from "./ui/confirm-modal";
import { TextInputModal } from "./ui/text-input-modal";
import { AI_SOURCE_PROMPT, CUSTOM_FORMAT_LABELS, CustomSourceImportModal, CustomSourceModal } from "./ui/custom-source-modal";
import { CsvSourceModal } from "./ui/csv-source-modal";
import { MIN_REQUEST_INTERVAL_MS } from "./modules/http";
import {
  collectUsedCacheKeys,
  deleteStaleCacheEntry,
  findOrphanCardFiles,
  findStaleCacheEntries,
} from "./modules/maintenance";
import { syncScriptSources, AI_SCRIPT_PROMPT } from "./modules/script-sources";
import { renderAiGuide } from "./modules/ai-guide";

// One-click MCP/CLI setup prompt (AI 辅助 tab): the user pastes it into
// their own AI agent, which locates the vault itself and registers the MCP
// server in its own config — that way the settings tab never has to display
// the machine-local paths. The EN translation lives in i18n.ts under this
// exact string as key; keep the two in sync.
export const MCP_SETUP_PROMPT = `请帮我把 Obsidian 插件 StrataBoard 的 MCP server 配置好，之后你就可以直接调用它的工具了。

背景：StrataBoard 是一个 Obsidian 金融数据卡片插件，附带一个 MCP stdio server（需要 Node 18+），入口文件是 <vault根目录>/.obsidian/plugins/strataboard/mcp-server.js。它提供这些工具：search_symbols / list_sources / validate_cards / probe_data / get_card_guide。

请按以下步骤操作：
1. 确定我的 vault 根目录：如果当前工作目录在某个 Obsidian vault 内（向上查找包含 .obsidian 目录的位置）就直接用它；找不到就问我，不要猜。
2. 按你的客户端注册名为 strataboard 的 MCP server：command 为 node，args 为 ["<vault根目录>/.obsidian/plugins/strataboard/mcp-server.js", "--vault", "<vault根目录>"]（也可以用环境变量 STRATABOARD_VAULT 传 vault 路径）。
   - Codex：写入 ~/.codex/config.toml 的 [mcp_servers.strataboard]；
   - Claude Code：执行 claude mcp add，或编辑对应的配置文件；
   - 其它客户端：用它自己的 MCP 配置方式写入等价的 JSON。
3. 写完后把最终配置内容给我看一遍，并告诉我是否需要重启或重载客户端才能生效。
4. 如果 MCP 始终不可用，改用插件附带的 CLI：node "<vault根目录>/.obsidian/plugins/strataboard/cli.js" <命令> --vault "<vault根目录>"，命令有 search / sources / validate / probe。

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
  // 脚本处理: folder holding user Python scripts; their CSV outputs land in
  // its output/ subfolder and are auto-registered as csv custom sources.
  scriptFolderPath: string;
  // 脚本处理: script paths (relative to scriptFolderPath, e.g.
  // "macro/cpi.py") the user disabled in the script manager.
  disabledScripts: string[];
  // 脚本处理: output CSV filePaths already processed by syncScriptSources —
  // a file is registered at most once, so a source the user deleted is never
  // rebuilt.
  seenScriptOutputs: string[];
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
  // Moving-average lines on K-line cards; off by default.
  showChartMA: boolean;
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
  showChartMA: false,
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

type SettingsTabId = "general" | "data-source" | "external-ai" | "paths" | "cards" | "toolbar";

const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: "general", label: "通用设置" },
  { id: "data-source", label: "数据源设置" },
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
  // app.setting is not in the public d.ts but is the standard way plugins
  // open the settings window.
  const setting = (app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
  setting?.open();
  setting?.openTabById("strataboard");
}

export class StrataBoardSettingTab extends PluginSettingTab {
  plugin: StrataBoardPlugin;
  private activeTab: SettingsTabId = "general";

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
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.pluginSettings.requestIntervalMs = value;
            await this.plugin.saveSettings();
          })
      );
  }

  // Full legal text, rendered inside the collapsed 免责声明 block at the
  // bottom of 通用设置.
  private renderDisclaimerSettings(containerEl: HTMLElement): void {
    const root = containerEl.createDiv("fc-disclaimer");

    const section = (title: string, body: string): HTMLElement => {
      const el = root.createDiv("fc-disclaimer-section");
      el.createEl("h4", { text: t(title) });
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
      "脚本处理",
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
    containerEl.createDiv({
      cls: "fc-field-hint",
      text: t("本插件不内置 AI 助手，由你自己的 AI agent（Codex、Claude Code 等）配合提示词操作插件。流程：先接入 AI（只需一次），之后按场景复制对应提示词发给它。"),
    });

    // Placeholder standing in for the vault root everywhere a snippet would
    // otherwise embed the real (private) absolute path. The plugin id itself
    // is public, so only the vault part is masked.
    const pluginDir = `<vault路径>/.obsidian/plugins/${this.plugin.manifest.id}`;

    const accessDetails = containerEl.createEl("details", { cls: "fc-settings-sub" });
    accessDetails.createEl("summary", { text: t("接入你的 AI（MCP / CLI，只需一次）") });
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
      text: t("想让 AI 帮你找接口、生成数据源配置时使用（需先完成上方接入）。AI 会引导你确认需求、检查已有数据源是否已覆盖，再找接口并核对插件适配范围，能配的数据尽量一次配齐，产出可直接粘贴的 URL 或写入 vault 的配置 JSON（在 数据源设置 → 导入 中选择导入），并自行验证；插件不支持的接口形态会明确告知，并建议改用脚本处理。"),
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
      text: t("接口形态插件不支持（需要登录、返回 HTML/XML 等）、或想自己抓取 / 加工数据时使用。在「{folder}」中放置 Python 脚本，脚本把结果 CSV 写入其 output/ 子目录，插件会自动把它注册为自定义数据源（之后可建独立卡、叠加卡、计算卡）；画布工具栏「数据处理 → 脚本管理」（或命令「打开脚本管理」）里可立即运行、查看日志。复制下方提示词（已附产物契约与合规规则），连同你的需求或报错一起发给你的 AI。", {
        folder: this.plugin.pluginSettings.scriptFolderPath,
      }),
    });
    this.addCodeSnippet(scriptDetails, t("脚本编写提示词（复制给你的 AI）"), t(AI_SCRIPT_PROMPT));
  }

  // Monospace snippet block with a copy button (MCP/CLI config fragments).
  private addCodeSnippet(container: HTMLElement, label: string, code: string): void {
    const block = container.createDiv("fc-code-snippet");
    const head = block.createDiv("fc-code-snippet-head");
    head.createEl("span", { text: label });
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
    containerEl.createDiv({
      cls: "fc-field-hint",
      text: t("自行配置任意 RESTful / JSON 数据接口或 vault 内的 CSV 文件：粘贴完整 URL 即可自动生成模板（支持 {code} {start} {end} {startIso} {endIso} 占位符），K 线行情、单值序列、固定报表均可接入，响应格式自动识别。"),
    });

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
          // API keys stay local — they never leave in an exported config.
          const exported = sources.map(({ apiKey: _apiKey, ...rest }) => rest);
          void navigator.clipboard.writeText(JSON.stringify(exported, null, 2)).then(
            () => new Notice(t("已导出 {n} 个数据源到剪贴板（API Key 不随配置导出）。", { n: sources.length })),
            () => new Notice(t("导出失败：无法访问剪贴板。")),
          );
        })
      );

    const sources = this.plugin.pluginSettings.customSources;
    // Group labels in first-appearance order; ungrouped sources render last.
    const groupNames = [
      ...new Set(sources.map((s) => s.group).filter((g): g is string => !!g)),
    ];
    for (const group of groupNames) {
      const members = sources.filter((s) => s.group === group);
      new Setting(containerEl)
        .setClass("fc-source-group-header")
        .setName(group)
        .setDesc(t("数据源组 · {n} 个源", { n: members.length }))
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
              for (const s of sources) {
                if (s.group === group) s.group = name;
              }
              const icons = this.plugin.pluginSettings.sourceGroupIcons;
              if (icons[group]) {
                icons[name] = icons[group];
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
      for (const def of members) {
        this.renderCustomSourceRow(containerEl, def, groupNames, true);
      }
    }
    for (const def of sources.filter((s) => !s.group)) {
      this.renderCustomSourceRow(containerEl, def, groupNames, false);
    }
  }

  private renderCustomSourceRow(
    containerEl: HTMLElement,
    def: CustomSourceDef,
    groupNames: string[],
    indented: boolean
  ): void {
    const setting = new Setting(containerEl)
      .setName(def.name)
      .setDesc(`${t(CUSTOM_FORMAT_LABELS[def.format])} · ${def.format === "csv" ? def.filePath ?? "" : def.klineUrl ?? ""}`);
    if (indented) setting.setClass("fc-source-group-member");
    setting.addDropdown((dropdown) => {
      dropdown.addOption("", t("未分组"));
      for (const name of groupNames) {
        dropdown.addOption(name, name);
      }
      dropdown.addOption(NEW_SOURCE_GROUP, t("新建分组…"));
      dropdown.setValue(def.group ?? "").onChange((value) => {
        if (value === NEW_SOURCE_GROUP) {
          new TextInputModal(this.app, t("新建分组"), (name) => {
            def.group = name;
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

  private openCustomSourceModal(def?: CustomSourceDef): void {
    new CustomSourceModal(this.app, def, (result) => this.upsertCustomSource(result), () =>
      openSettingsTab(this.app, "external-ai")
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
    containerEl.createDiv({
      cls: "fc-field-hint",
      text: t("从仓库已有文件夹中选择，也可在菜单底部手动输入新路径。"),
    });

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

    new Setting(chartDetails)
      .setName(t("显示均线（MA）"))
      .setDesc(t("K 线卡的移动平均线（周期以交易日为单位），默认关闭；每张卡片可在编辑弹窗中单独覆盖。"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.pluginSettings.showChartMA).onChange(async (value) => {
          this.plugin.pluginSettings.showChartMA = value;
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
