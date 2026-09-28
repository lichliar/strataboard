import { App, Modal, Notice, Setting, TextComponent } from "obsidian";
import type { CustomSourceDef, JsonSourceMap, OhlcvRow } from "../types";
import {
  detectBuiltinKlineFormat,
  detectJsonMapping,
  digPathValue,
  findRowCandidates,
  guessCols,
  parseEastmoneyKline,
  parseMappedKline,
  parseTencentKline,
  resolveMapCode,
  splitCompositeCode,
} from "../modules/quote-format-parsers";
import type { JsonRowCandidate } from "../modules/quote-format-parsers";
import { autoDetectSearchFormat, fetchKlineSample } from "../modules/custom-quote-client";
import { autoTemplateSearchUrl, autoTemplateUrl, extractApiKey } from "../utils/url-template";
import { parseSymbolList, stringifySymbolList } from "../utils/symbol-list";
import { t } from "../i18n";

// Setup dialog for one user-defined custom data source (设置页 → 自定义数据源).
// The plugin ships no endpoint URLs — the user pastes a working URL and the
// dialog templates it (autoTemplateUrl), probes it inline as they type, and
// auto-detects the response format (腾讯/东方财富 presets or a guessed
// generic-JSON mapping). The layout is two sections on one page:
//   1. 配置 — name + URL + inline probe status; rarely-touched inputs (示例
//      代码 / 搜索 URL / 代码表) live under 高级选项, the manual field mapping
//      under 字段映射（可选）(auto-opens when a generic-JSON source parses
//      nothing).
//   2. AI 辅助设置 — MCP/CLI-first: step 1 points the user at the 外部 AI
//      接入 settings tab; step 2 is a copyable guided prompt the user sends
//      to their own AI (the plugin has no built-in assistant) that walks
//      them through the whole setup. A separate debug prompt fixes failed
//      probes (its mapping JSON reply can be pasted back and applied).
// Placeholders: klineUrl {code} {start} {end} {startIso} {endIso}, searchUrl
// {query}.

export const CUSTOM_FORMAT_LABELS: Record<CustomSourceDef["format"], string> = {
  tencent: "腾讯格式",
  eastmoney: "东方财富格式",
  json: "通用 JSON",
  csv: "CSV 文件",
};

// Guided prompt for「2. AI 辅助设置」: assumes the user's AI is already wired
// to the plugin through the MCP server or CLI (list_sources / probe_data /
// ...), so instead of just "find me an endpoint" it walks the user through
// the whole setup — including telling them plainly when the plugin has no
// matching adapter and pointing them at the 脚本处理 CSV route instead. It
// deliberately names no concrete endpoints — the user's own AI picks one,
// keeping the plugin a pure data-access framework. The EN translation lives
// in i18n.ts under this exact string as key; keep the two in sync.
const AI_GUIDED_SETUP_PROMPT = `你将帮我为 Obsidian 插件 StrataBoard 配置一个「自定义数据源」。你已通过 MCP server 或 CLI 接入该插件（可用工具：list_sources / search_symbols / list_macro_series / probe_data / validate_cards）。请按以下流程一步步引导我，每步先跟我确认再往下走：

1. 先问清楚我想要什么数据：标的/指标、频率、需要的字段（开高低收还是单值序列）。
2. 先查插件内置能力是否已覆盖：用 list_macro_series 查中国宏观序列，用 search_symbols 查内置行情代码，用 list_sources 查我已配置的自定义源。如果已覆盖，直接告诉我用哪种内置卡片即可，不要新建数据源。
3. 确需新源时，帮我找一个无需登录、可直接用 GET 访问的 JSON REST 接口，并实际请求验证它能返回数据。优先官方或有公开文档的 API；不要使用未公开文档的抓取端点。若接口需要 token，告诉我申请方式（token 由我自己保管，不要写进任何会分享出去的配置）。
4. 核对该接口是否落在插件的适配范围内。插件只支持：
   - GET 请求，所有参数在 URL query 中（可选一个鉴权 Header，值用 {apiKey} 占位）；
   - 响应为 JSON；常见的按代码返回 K 线的行情格式会被自动识别，其它 JSON 必须能指出「数据行数组的路径 + 每行的日期列与数值列」（日期支持 ISO 日期时间、YYYYMMDD、时间戳）；
   - URL 模板占位符：{code} 证券代码、{start}/{end} 为 YYYYMMDD 起止日期、{startIso}/{endIso} 为 YYYY-MM-DD 起止日期；
   - 固定报表宽表（一个 URL 返回整张表、每列一个序列）也支持：把列名当作代码，字段映射中用 {code} 选列。
5. 如果接口不符合以上任一形态（需要 POST、登录 Cookie、返回 HTML/XML、需要多页拼装等），插件的自定义数据源无法适配——请明确告诉我「该接口插件不支持」，并建议改用「脚本处理」：写一个 Python 脚本把数据输出为 CSV，插件会自动注册为 CSV 数据源（脚本编写提示词在 插件设置 → 外部 AI 接入 → 脚本处理）。
6. 适配可行时，给我最终配置，二选一：
   a. 简单情况：给一个完整、可直接访问的 URL（含真实证券代码和起止日期）+ URL 中实际使用的代码。我会把 URL 粘贴到插件「添加数据源」弹窗，插件自动生成模板并检测格式；
   b. 复杂情况（宽表或需手工字段映射）：直接给一段可导入的配置 JSON（一个数组），字段：name（名称）、format（"tencent"|"eastmoney"|"json"）、klineUrl（URL 模板）、testCode（示例代码）、jsonMap（{"rowsPath":"数据行数组的点号路径，顶层即数组则空串","rowKind":"object|array","cols":{"date":"必填","close":"必填","open/high/low/vol":"没有则空串"}}）、symbols（可选，代码表 [{"code","name"}]）。我会粘贴到 插件设置 → 数据源设置 → 自定义数据源 → 导入。
7. 我保存或导入后，用 list_sources 找到新源的 id，再用 probe_data（assetType="custom", sourceId=<id>, code=<示例代码>）做端到端验证，把结果告诉我；若 rows=0，按返回的 hint 分析原因并修正配置后让我重新导入。

全程用中文交流，发现插件能力边界时直接说清楚，不要绕弯子。`;

// Debug prompt for the「让 AI 帮你修」block: head carries the URL
// template and sample code via t() vars, then the truncated raw response is
// concatenated, then the tail specifies the exact mapping JSON shape the
// dialog can apply. The {code}/{start}/... placeholders inside the head are
// literal text, not t() vars — t() only replaces the vars it is given.
const AI_DEBUG_PROMPT_HEAD = `我在给一个 Obsidian 插件配置自定义行情数据源，接口的响应格式插件没能自动识别，请帮我生成字段映射配置。

接口 URL 模板：{url}
其中 {code} 会被替换为证券代码，{start}/{end} 为 YYYYMMDD 起止日期，{startIso}/{endIso} 为 YYYY-MM-DD 起止日期。
用示例代码 {sample} 实际请求后，响应内容（有截断）如下：
`;

const AI_DEBUG_PROMPT_TAIL = `
请只返回一个 JSON 对象（不要任何其他文字、不要 Markdown 代码块以外的内容），格式如下：
{
  "rowsPath": "数据行数组在 JSON 中的点号路径，如 data.list；响应顶层就是数组时填空字符串",
  "rowKind": "object 或 array（每行数据是对象还是数组）",
  "cols": {
    "date": "日期列：object 行填字段名，array 行填从 0 开始的列序号（字符串）",
    "close": "收盘价/数值列",
    "open": "开盘价列，没有则填空字符串",
    "high": "最高价列，没有则填空字符串",
    "low": "最低价列，没有则填空字符串",
    "vol": "成交量列，没有则填空字符串",
    "amount": "成交额列，没有则填空字符串"
  }
}
date 和 close 必填；单值序列（收益率、宏观指标等）把数值列填给 close 即可。日期可以是 ISO 日期时间、YYYYMMDD 或时间戳。`;

// How long after the last edit the inline auto-detection fires.
const DETECT_DEBOUNCE_MS = 800;

export class CustomSourceModal extends Modal {
  private def: CustomSourceDef;
  private isNew: boolean;
  private onSubmit: (def: CustomSourceDef) => void;
  // Raw inputs (what the user pasted; def carries the templated form).
  private rawKlineUrl: string;
  private rawSearchUrl: string;
  private sampleCode: string;
  // Once the user edits 名称 / 示例代码 by hand, URL pastes stop overwriting
  // them with auto-guessed values.
  private nameTouched = false;
  private sampleCodeTouched = false;
  // Probe state for the inline auto-detection.
  private detecting = false;
  private detectError = "";
  private sampleJson: any;
  private sampleText = "";
  private detectedRows: OhlcvRow[] = [];
  private candidates: JsonRowCandidate[] = [];
  private searchHint = "";
  // "url::sampleCode" of the last completed probe; a mismatch means the
  // inputs changed since the probe ran (or none ran yet).
  private probedKey = "";
  private detectTimer: number | undefined;
  // Skip re-guessing jsonMap on the next probe (an existing json source being
  // re-probed on open keeps its stored mapping).
  private keepJsonMapOnNextProbe = false;
  // 字段映射（可选）details state; auto-opens when a json source parses nothing.
  private mappingOpen = false;
  private scrollToMapping = false;

  constructor(
    app: App,
    def: CustomSourceDef | undefined,
    onSubmit: (def: CustomSourceDef) => void,
    // Opens the settings window on the 外部 AI 接入 tab (AI section step 1).
    private onOpenAiSettings: () => void
  ) {
    super(app);
    this.isNew = !def;
    this.def = def
      ? { ...def, jsonMap: def.jsonMap ? { ...def.jsonMap, cols: { ...def.jsonMap.cols }, searchCols: def.jsonMap.searchCols ? { ...def.jsonMap.searchCols } : undefined } : undefined }
      : {
          id: `src-${Date.now().toString(36)}`,
          name: "",
          enabled: true,
          format: "tencent",
          klineUrl: "",
        };
    this.rawKlineUrl = this.def.klineUrl ?? "";
    this.rawSearchUrl = this.def.searchUrl ?? "";
    // New sources default the sample code to the SSE Composite Index — the
    // most likely code a user's AI will put in the URL it suggests.
    this.sampleCode = this.def.testCode ?? (this.isNew ? "sh000001" : "");
    if (this.isNew && !this.def.testCode) this.def.testCode = this.sampleCode;
    this.mappingOpen = this.def.format === "json";
    // Editing a json source: the open-time probe must reuse the stored
    // mapping instead of re-guessing it.
    this.keepJsonMapOnNextProbe = !this.isNew && this.def.format === "json" && !!this.def.jsonMap;
    this.onSubmit = onSubmit;
    this.setTitle(this.isNew ? t("添加自定义数据源") : t("编辑自定义数据源"));
  }

  onOpen() {
    this.render();
    // Editing an existing source: probe right away so the status block
    // confirms the endpoint still works.
    if (this.def.klineUrl) void this.runDetection();
  }

  onClose() {
    if (this.detectTimer !== undefined) window.clearTimeout(this.detectTimer);
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    const configSection = contentEl.createEl("details", { cls: "fc-settings-sub" });
    configSection.setAttr("open", "");
    configSection.createEl("summary", { text: `1. ${t("配置")}` });
    this.renderConfigSection(configSection);

    const aiSection = contentEl.createEl("details", { cls: "fc-settings-sub" });
    aiSection.setAttr("open", "");
    aiSection.createEl("summary", { text: `2. ${t("AI 辅助设置")}` });
    this.renderAiSection(aiSection);

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => void this.saveWithProbe());

    if (this.scrollToMapping) {
      this.scrollToMapping = false;
      contentEl.querySelector(".fc-mapping-section")?.scrollIntoView({ block: "nearest" });
    }
  }

  private probeKey(): string {
    return `${this.def.klineUrl}::${this.sampleCode}`;
  }

  // Fires the inline probe shortly after the user stops editing the URL or
  // the sample code; skips when the current inputs were already probed.
  private scheduleDetection() {
    if (this.detectTimer !== undefined) window.clearTimeout(this.detectTimer);
    this.detectTimer = window.setTimeout(() => {
      this.detectTimer = undefined;
      if (!this.def.klineUrl || this.probeKey() === this.probedKey) return;
      void this.runDetection();
    }, DETECT_DEBOUNCE_MS);
  }

  // Best-effort extraction of the security code from a pasted URL: a
  // well-known query param first, then common embedded code shapes
  // (sh600519 / 600519.SH). Used only until the user edits 示例代码 manually.
  private guessSampleCode(url: string): string {
    const param = url.match(/[?&](?:secid|symbol|scode|stock|ts_code|code)=([A-Za-z0-9._-]{2,24})/i);
    if (param) return param[1];
    const embedded = url.match(/(?<![A-Za-z0-9])(?:sh|sz|bj)\d{6}(?!\d)/i) ?? url.match(/\b\d{6}\.(?:SH|SZ|SS|BJ)\b/);
    return embedded ? embedded[0] : "";
  }

  // Default display name for a freshly pasted URL: the endpoint host. Only
  // applies while the user hasn't typed a name themselves.
  private guessSourceName(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  // ===== 1. 配置 =====
  private renderConfigSection(container: HTMLElement) {
    const def = this.def;

    let nameText: TextComponent | null = null;
    const nameSetting = new Setting(container).setName(t("名称")).setDesc(t("显示在选择器、工具栏和卡片文件名中。")).addText((text) => {
      nameText = text;
      text.setPlaceholder(t("如：我的行情源")).setValue(def.name).onChange((value) => {
        this.nameTouched = true;
        def.name = value.trim();
      });
    });
    nameSetting.settingEl.addClass("fc-setting-stacked");

    const klinePreview = container.createDiv({ cls: "fc-field-hint fc-mono fc-template-preview fc-hidden" });
    let sampleCodeText: TextComponent | null = null;
    let apiKeyText: TextComponent | null = null;
    const klineSetting = new Setting(container)
      .setName(t("K线接口地址"))
      .setDesc(t("粘贴一个能直接访问的完整 URL（带真实代码与日期），插件会自动识别代码与日期并生成模板、自动检测数据格式。"))
      .addTextArea((text) => {
        text.setPlaceholder("https://…?code=sh600519&beg=20240101&end=20241231").setValue(this.rawKlineUrl).onChange((value) => {
          // URLs cannot legally contain whitespace — any inside the paste is
          // a copy artifact (e.g. from a wrapped chat message) and would
          // silently corrupt query params, so strip it all.
          this.rawKlineUrl = value.replace(/\s+/g, "");
          if (!this.nameTouched && !def.name) {
            const host = this.guessSourceName(this.rawKlineUrl);
            if (host) {
              def.name = host;
              nameText?.setValue(host);
            }
          }
          if (!this.sampleCodeTouched) {
            const guessed = this.guessSampleCode(this.rawKlineUrl);
            if (guessed && guessed !== this.sampleCode) {
              this.sampleCode = guessed;
              this.def.testCode = guessed;
              sampleCodeText?.setValue(guessed);
            }
          }
          if (!def.apiKey) {
            // A pasted URL carrying its credential inline seeds the key
            // field; the template keeps only the {apiKey} placeholder.
            const extracted = extractApiKey(this.rawKlineUrl);
            if (extracted) {
              def.apiKey = extracted;
              apiKeyText?.setValue(extracted);
            }
          }
          def.klineUrl = autoTemplateUrl(this.rawKlineUrl, splitCompositeCode(this.sampleCode).urlCode);
          updateKlinePreview();
          this.scheduleDetection();
        });
        text.inputEl.addClass("fc-mono");
      });
    klineSetting.settingEl.addClass("fc-setting-stacked");
    const updateKlinePreview = () => {
      const show = def.klineUrl && def.klineUrl !== this.rawKlineUrl;
      klinePreview.toggleClass("fc-hidden", !show);
      if (show) klinePreview.setText(`${t("自动生成的模板")}: ${def.klineUrl}`);
    };
    updateKlinePreview();

    const apiKeySetting = new Setting(container)
      .setName(t("API Key（可选）"))
      .setDesc(t("接口要求密钥时填写，URL 模板中用 {apiKey} 占位引用。密钥只存在本地设置里，导出配置时不会包含。"))
      .addText((text) => {
        apiKeyText = text;
        text.setPlaceholder(t("粘贴 URL 时自动抽取，也可手动填写")).setValue(def.apiKey ?? "").onChange((value) => {
          def.apiKey = value.trim() || undefined;
        });
        text.inputEl.type = "password";
        text.inputEl.addClass("fc-mono");
      });
    apiKeySetting.settingEl.addClass("fc-setting-stacked");

    // Inline probe status: detecting / error / parsed-row preview.
    this.renderDetectStatus(container.createDiv("fc-hint-mt"));

    // Rarely-touched knobs live under 高级选项: the sample code (normally
    // auto-guessed from the pasted URL), the search endpoint and the static
    // code table.
    const advanced = container.createEl("details", { cls: "fc-settings-sub" });
    advanced.createEl("summary", { text: t("高级选项") });
    advanced.createDiv({
      cls: "fc-field-hint",
      text: t("一般无需改动：示例代码会自动从 URL 猜测；搜索接口与静态代码表按需配置。"),
    });

    const sampleSetting = new Setting(advanced)
      .setName(t("示例代码"))
      .setDesc(t("URL 中实际使用的代码，用于识别 {code} 位置并作为接口检测代码；URL 不含代码的固定报表类接口可留空。支持复合代码「URL部分@映射列名」（如 REPORT_NAME@COL_NAME）：URL 中的 {code} 用前半部分填充，字段映射中的 {code} 用后半部分选列。"))
      .addText((text) => {
        sampleCodeText = text;
        text.setPlaceholder("sh000001").setValue(this.sampleCode).onChange((value) => {
          this.sampleCodeTouched = true;
          this.sampleCode = value.trim();
          def.testCode = this.sampleCode || undefined;
          def.klineUrl = autoTemplateUrl(this.rawKlineUrl, splitCompositeCode(this.sampleCode).urlCode);
          updateKlinePreview();
          this.scheduleDetection();
        });
        text.inputEl.addClass("fc-mono");
      });
    sampleSetting.settingEl.addClass("fc-setting-stacked");

    const headerSetting = new Setting(advanced)
      .setName(t("鉴权 Header（可选）"))
      .setDesc(t("接口要求密钥放在请求头时填写：只写「Header名」表示值为 API Key 本身；「Header名: 值模板」中可用 {apiKey} 占位。"))
      .addText((text) => {
        text.setPlaceholder("X-Finnhub-Token 或 Authorization: Bearer {apiKey}").setValue(def.apiKeyHeader ?? "").onChange((value) => {
          def.apiKeyHeader = value.trim() || undefined;
        });
        text.inputEl.addClass("fc-mono");
      });
    headerSetting.settingEl.addClass("fc-setting-stacked");

    const searchPreview = advanced.createDiv({ cls: "fc-field-hint fc-mono fc-template-preview fc-hidden" });
    const searchSetting = new Setting(advanced)
      .setName(t("搜索 URL（可选）"))
      .setDesc(t("粘贴一个带搜索词的完整搜索 URL，插件会自动将搜索词替换为 {query}；留空则该源使用手工录入代码。"))
      .addTextArea((text) => {
        text.setPlaceholder("https://…?q=000001").setValue(this.rawSearchUrl).onChange((value) => {
          this.rawSearchUrl = value.replace(/\s+/g, "");
          def.searchUrl = autoTemplateSearchUrl(this.rawSearchUrl) || undefined;
          updateSearchPreview();
        });
        text.inputEl.addClass("fc-mono");
      });
    searchSetting.settingEl.addClass("fc-setting-stacked");
    const updateSearchPreview = () => {
      if (!def.searchUrl) {
        searchPreview.addClass("fc-hidden");
        return;
      }
      searchPreview.removeClass("fc-hidden");
      searchPreview.setText(
        def.searchUrl.includes("{query}")
          ? `${t("自动生成的模板")}: ${def.searchUrl}`
          : t("未识别到搜索词参数，请手动把 URL 中的搜索词替换为 {query}。"),
      );
    };
    updateSearchPreview();

    // Static code table: sources without a server-side search (fixed
    // reports, wide tables) paste a "代码 名称" list once, and card creation
    // then offers named picks instead of raw code entry.
    const symbolHelp = advanced.createEl("details", { cls: "fc-settings-sub" });
    symbolHelp.createEl("summary", { text: t("代码表（可选）") });
    symbolHelp.createDiv({
      cls: "fc-field-hint",
      text: t("每行一条「代码 名称」（空格或逗号分隔，名称可含空格）。配置后，插入数据时按名称搜索选择，无需记代码。"),
    });
    const symbolArea = symbolHelp.createEl("textarea", { cls: "fc-mono", attr: { rows: "6" } });
    symbolArea.placeholder = t("如：CODE_10Y 十年期国债收益率");
    symbolArea.value = stringifySymbolList(def.symbols ?? []);
    symbolArea.addEventListener("input", () => {
      const entries = parseSymbolList(symbolArea.value);
      def.symbols = entries.length > 0 ? entries : undefined;
    });

    if (def.format === "json") this.renderMappingSection(container);
  }

  // ===== 2. AI 辅助设置 =====
  // The plugin has no built-in assistant: step 1 wires the user's own AI to
  // the plugin through the MCP server / CLI (settings → 外部 AI 接入), step 2
  // is a copyable guided prompt — with tools attached, the AI can walk the
  // user through the whole setup and verify the result itself.
  private renderAiSection(container: HTMLElement) {
    container.createDiv({
      cls: "fc-field-hint",
      text: t("推荐流程：先为你的 AI 配置本插件的 MCP server 或 CLI，再把引导提示词发给它——AI 会一步步引导你完成配置、自己验证接口，并在插件不支持时明确告诉你。"),
    });

    const step1 = container.createEl("details", { cls: "fc-settings-sub fc-ai-help" });
    step1.setAttr("open", "");
    step1.createEl("summary", { text: t("第 1 步：为你的 AI 配置 MCP / CLI") });
    step1.createDiv({
      cls: "fc-field-hint",
      text: t("配置片段在 设置 → 外部 AI 接入（推荐 MCP server，也有命令行 CLI）。配置好后，你的 AI 就能直接调用插件的查询与验证工具（list_sources / probe_data 等）。"),
    });
    const openBtn = step1.createEl("button", { text: t("打开「外部 AI 接入」设置") });
    openBtn.addEventListener("click", () => this.onOpenAiSettings());

    const step2 = container.createEl("details", { cls: "fc-settings-sub fc-ai-help" });
    step2.setAttr("open", "");
    step2.createEl("summary", { text: t("第 2 步：复制引导提示词发给你的 AI") });
    step2.createDiv({
      cls: "fc-field-hint",
      text: t("AI 会按提示词引导你：先确认需求并检查内置数据源是否已覆盖，再找接口、核对插件适配范围，最后产出可直接粘贴的 URL 或可导入的配置 JSON，并自行验证。插件不支持的接口形态它会明确告知，并建议改用脚本处理。"),
    });
    const promptArea = step2.createEl("textarea", { cls: "fc-mono fc-prompt-area", attr: { readonly: "true" } });
    promptArea.value = t(AI_GUIDED_SETUP_PROMPT);
    const copyBtn = step2.createEl("button", { text: t("复制提示词") });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(promptArea.value).then(
        () => new Notice(t("提示词已复制到剪贴板，去发给你的 AI 吧。")),
        () => new Notice(t("复制失败，请手动选中提示词复制。")),
      );
    });

    // The debug loop only makes sense once a probe produced a real response.
    if (this.sampleText) this.renderAiFixBlock(container);
  }

  // The API key must never leave the dialog: replace every occurrence (raw
  // or URL-encoded) in text the user might paste to an external AI.
  private maskApiKey(text: string): string {
    const key = this.def.apiKey;
    if (!key) return text;
    return text.split(key).join("***").split(encodeURIComponent(key)).join("***");
  }

  // Probe status block inside「1. 配置」: detecting / error / preview.
  private renderDetectStatus(statusEl: HTMLElement) {
    if (!this.def.klineUrl) {
      statusEl.createDiv({ cls: "fc-field-hint", text: t("粘贴 URL 后将自动检测接口与数据格式。") });
      return;
    }
    if (this.detecting) {
      statusEl.createDiv({ cls: "fc-field-hint", text: t("正在检测接口…") });
      return;
    }
    if (this.probeKey() !== this.probedKey) {
      // Inputs edited since the last probe; the debounced re-probe is coming.
      statusEl.createDiv({ cls: "fc-field-hint", text: t("正在检测接口…") });
      return;
    }
    if (this.detectError) {
      statusEl.createDiv({ cls: "fc-field-hint fc-detect-error", text: t("检测失败：{msg}", { msg: this.detectError }) });
      const retryBtn = statusEl.createEl("button", { text: t("重新检测") });
      retryBtn.addEventListener("click", () => void this.runDetection());
      return;
    }
    if (this.detectedRows.length === 0) {
      statusEl.createDiv({
        cls: "fc-field-hint fc-detect-error",
        text: t("已识别为{format}，但未解析出 K 线数据。", { format: t(CUSTOM_FORMAT_LABELS[this.def.format]) }),
      });
      // The mapping section only exists for generic JSON; other formats fall
      // back to the AI section below.
      if (this.def.format === "json") {
        const mappingBtn = statusEl.createEl("button", { text: t("调整字段映射") });
        mappingBtn.addEventListener("click", () => this.openMappingSection());
      }
      return;
    }
    statusEl.createDiv({
      cls: "fc-field-hint",
      text: t("识别为{format}，共 {n} 条 K 线。请核对下方数据是否正确：", {
        format: t(CUSTOM_FORMAT_LABELS[this.def.format]),
        n: this.detectedRows.length,
      }),
    });
    this.renderRowsTable(statusEl, this.detectedRows);
    if (this.searchHint) {
      statusEl.createDiv({ cls: "fc-field-hint fc-hint-mt", text: this.searchHint });
    }
    if (this.def.format === "json") {
      const mappingBtn = statusEl.createEl("button", { text: t("调整字段映射") });
      mappingBtn.addEventListener("click", () => this.openMappingSection());
    }
  }

  private openMappingSection() {
    this.mappingOpen = true;
    this.scrollToMapping = true;
    this.render();
  }

  // Serializes probes so the 保存 path can await an in-flight detection
  // instead of silently dropping the click.
  private detectionPromise: Promise<void> | null = null;

  private runDetection(): Promise<void> {
    this.detectionPromise ??= this.runDetectionOnce().finally(() => {
      this.detectionPromise = null;
    });
    return this.detectionPromise;
  }

  private async runDetectionOnce() {
    const key = this.probeKey();
    this.probedKey = key;
    this.detecting = true;
    this.detectError = "";
    this.render();
    try {
      const sample = await fetchKlineSample(this.def, this.sampleCode);
      if (key !== this.probeKey()) {
        // Inputs changed mid-flight — discard the stale sample and re-probe.
        this.probedKey = "";
        this.scheduleDetection();
        return;
      }
      this.sampleJson = sample.json;
      this.sampleText = sample.text;
      const builtin = detectBuiltinKlineFormat(sample.json, this.sampleCode);
      if (builtin) {
        this.keepJsonMapOnNextProbe = false;
        this.def.format = builtin;
        this.def.jsonMap = undefined;
        this.detectedRows = builtin === "tencent" ? parseTencentKline(sample.json, this.sampleCode) : parseEastmoneyKline(sample.json);
        this.candidates = [];
      } else {
        // An explicit jsonMap (stored on an existing source, or pasted back
        // from the debug prompt) wins over the guessing heuristic for this
        // probe.
        const keepMap = this.keepJsonMapOnNextProbe ? this.def.jsonMap : undefined;
        this.keepJsonMapOnNextProbe = false;
        const map = keepMap ?? detectJsonMapping(sample.json);
        this.def.format = "json";
        this.def.jsonMap = map ?? undefined;
        this.candidates = findRowCandidates(sample.json);
        this.detectedRows = map ? parseMappedKline(sample.json, map) : [];
      }
      this.searchHint = "";
      if (this.def.searchUrl) {
        try {
          const searchFormat = await autoDetectSearchFormat(this.def);
          if (searchFormat !== this.def.format) {
            this.searchHint = t("检测到搜索接口的响应格式与 K 线接口不同，搜索可能不可用；两者需为同一格式。");
          } else if (searchFormat === "json") {
            this.searchHint = t("搜索接口为通用 JSON，如需使用搜索请在字段映射中配置搜索映射。");
          }
        } catch {
          this.searchHint = t("搜索接口检测失败，不影响 K 线使用。");
        }
      }
    } catch (err) {
      this.detectError = err instanceof Error ? err.message : String(err);
    } finally {
      this.detecting = false;
      this.render();
    }
  }

  // Save: make sure the current inputs have been probed before committing,
  // and open the mapping section when a generic-JSON source still parses
  // nothing.
  private async saveWithProbe() {
    if (!this.def.name) {
      new Notice(t("请填写数据源名称。"));
      return;
    }
    if (!this.def.klineUrl) {
      new Notice(t("请填写 K线 URL。"));
      return;
    }
    // A probe for the latest edits may still be in flight (or only
    // debounce-scheduled) — always let the current inputs get probed before
    // deciding, so 保存 never judges stale state.
    if (this.detecting && this.detectionPromise) await this.detectionPromise;
    if (this.probeKey() !== this.probedKey) await this.runDetection();
    if (this.detectError) {
      new Notice(t("检测失败：{msg}", { msg: this.detectError }));
      return;
    }
    if (this.def.format === "json" && this.detectedRows.length === 0) {
      new Notice(t("已识别为通用 JSON，但未解析出数据，请先调整字段映射。"));
      this.openMappingSection();
      return;
    }
    this.save();
  }

  // ===== AI debug prompt =====
  // The user copies a prompt that carries the URL template plus a truncated
  // real response; their AI returns a mapping JSON which is pasted back and
  // applied here. The prompt names no endpoints — it only describes the
  // response the user's own URL produced.

  private buildDebugPrompt(): string {
    return (
      t(AI_DEBUG_PROMPT_HEAD, { url: this.def.klineUrl ?? "", sample: this.sampleCode || t("（无代码）") }) +
      this.maskApiKey(this.sampleText.slice(0, 1500)) +
      t(AI_DEBUG_PROMPT_TAIL)
    );
  }

  private renderAiFixBlock(containerEl: HTMLElement) {
    const fix = containerEl.createEl("details", { cls: "fc-settings-sub fc-ai-help" });
    fix.createEl("summary", { text: t("检测失败？让 AI 帮你修") });
    fix.createDiv({
      cls: "fc-field-hint",
      text: t("复制调试提示词发给你的 AI（如 ChatGPT / Kimi / DeepSeek），它会返回一段映射 JSON；粘贴到下方并点「应用映射」。"),
    });
    const copyBtn = fix.createEl("button", { text: t("复制调试提示词") });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.buildDebugPrompt()).then(
        () => new Notice(t("提示词已复制到剪贴板，去发给你的 AI 吧。")),
        () => new Notice(t("复制失败，请手动选中提示词复制。")),
      );
    });
    const area = fix.createEl("textarea", { cls: "fc-mono", attr: { rows: "4" } });
    area.placeholder = t("粘贴 AI 返回的映射 JSON…");
    const applyBtn = fix.createEl("button", { text: t("应用映射"), cls: "mod-cta" });
    applyBtn.addEventListener("click", () => this.applyAiMapping(area.value));
  }

  // Parses and applies the AI-returned mapping JSON. Tolerates a Markdown
  // code fence around the payload.
  private applyAiMapping(raw: string) {
    let parsed: any;
    try {
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      parsed = JSON.parse(cleaned);
    } catch {
      new Notice(t("无法解析映射 JSON，请确认粘贴的是 AI 返回的完整 JSON。"));
      return;
    }
    const cols = parsed?.cols;
    if (
      typeof parsed?.rowsPath !== "string" ||
      (parsed?.rowKind !== "object" && parsed?.rowKind !== "array") ||
      !cols ||
      typeof cols.date !== "string" ||
      !cols.date ||
      typeof cols.close !== "string" ||
      !cols.close
    ) {
      new Notice(t("映射 JSON 不完整：需要 rowsPath、rowKind，以及 cols.date、cols.close。"));
      return;
    }
    this.def.format = "json";
    this.def.jsonMap = {
      ...this.def.jsonMap,
      rowsPath: parsed.rowsPath,
      rowKind: parsed.rowKind,
      cols: {
        date: cols.date,
        close: cols.close,
        open: typeof cols.open === "string" ? cols.open : "",
        high: typeof cols.high === "string" ? cols.high : "",
        low: typeof cols.low === "string" ? cols.low : "",
        vol: typeof cols.vol === "string" ? cols.vol : "",
        amount: typeof cols.amount === "string" && cols.amount ? cols.amount : undefined,
      },
    };
    let rows: OhlcvRow[] = [];
    if (this.sampleJson) {
      rows = parseMappedKline(this.sampleJson, resolveMapCode(this.def.jsonMap, splitCompositeCode(this.sampleCode).mapCode));
      this.detectedRows = rows;
      this.detectError = "";
    }
    if (rows.length > 0) {
      new Notice(t("映射已应用，共解析出 {n} 条。", { n: rows.length }));
    } else {
      new Notice(t("映射已应用，但仍未解析出数据，请在字段映射中检查。"));
      // Nothing parsed — open the mapping section for a manual fix.
      this.mappingOpen = true;
    }
    this.render();
  }

  // 字段映射（可选）: generic-JSON mapping picked from real response values —
  // no paths or column indexes to type in the common case.
  private renderMappingSection(parent: HTMLElement) {
    const def = this.def;
    const details = parent.createEl("details", { cls: "fc-settings-sub fc-mapping-section" });
    // Open on demand, or automatically while a probed json source parses
    // nothing (the moment the mapping is what blocks saving).
    details.open =
      this.mappingOpen ||
      (!this.detecting &&
        !this.detectError &&
        (this.def.klineUrl?.length ?? 0) > 0 &&
        this.probeKey() === this.probedKey &&
        this.detectedRows.length === 0);
    details.createEl("summary", { text: t("字段映射（可选）") });

    if (this.candidates.length === 0) {
      details.createDiv({
        cls: "fc-field-hint",
        text: this.sampleText
          ? t("响应中未找到可用的数据列表，请检查 URL 与示例代码。")
          : t("尚未获取到接口响应，请先粘贴 URL 完成自动检测。"),
      });
      if (this.sampleText) {
        const pre = details.createEl("pre", { cls: "fc-sample-dump" });
        pre.setText(this.sampleText.slice(0, 400));
      }
    } else {
      details.createDiv({
        cls: "fc-field-hint",
        text: t("无法自动识别数据格式（或识别结果不对）。请选出包含 K 线行的数据列表，并核对每一列的对应关系。"),
      });

      let selected = this.candidates.find((c) => c.rowsPath === def.jsonMap?.rowsPath);
      if (!selected && def.jsonMap?.rowsPath && this.sampleJson) {
        // Legacy/manual mapping whose path the heuristic missed: synthesize a
        // candidate from the sample so the column dropdowns still work.
        const rows = digPathValue(this.sampleJson, def.jsonMap.rowsPath);
        if (Array.isArray(rows) && rows.length > 0) {
          selected = { rowsPath: def.jsonMap.rowsPath, rowKind: def.jsonMap.rowKind, row: rows[0] };
          this.candidates.unshift(selected);
        }
      }
      selected ??= this.candidates[0];
      if (!def.jsonMap) {
        def.jsonMap = { rowsPath: selected.rowsPath, rowKind: selected.rowKind, cols: guessCols(selected) ?? this.emptyCols() };
      }

      new Setting(details)
        .setName(t("数据列表"))
        .setDesc(t("从响应中识别到的列表，选一个包含 K 线数据的。"))
        .addDropdown((dropdown) => {
          for (const candidate of this.candidates) {
            const label = `${candidate.rowsPath || "/"}（${candidate.rowKind === "array" ? t("数组") : t("对象")}）`;
            dropdown.addOption(candidate.rowsPath, label);
          }
          dropdown.setValue(selected.rowsPath).onChange((value) => {
            const candidate = this.candidates.find((c) => c.rowsPath === value);
            if (!candidate || !def.jsonMap) return;
            def.jsonMap.rowsPath = candidate.rowsPath;
            def.jsonMap.rowKind = candidate.rowKind;
            def.jsonMap.cols = guessCols(candidate) ?? this.emptyCols();
            this.render();
          });
        });

      // One dropdown per OHLCV column, options labeled with real values from
      // the first row so the user recognizes each column by its content. Only
      // date+close are required — single-value series (yields, macro
      // readings) leave the rest unmapped.
      const options = this.columnOptions(selected);
      const colFields: { key: keyof JsonSourceMap["cols"]; label: string; optional?: boolean }[] = [
        { key: "date", label: t("日期") },
        { key: "open", label: t("开盘价"), optional: true },
        { key: "close", label: t("收盘价") },
        { key: "high", label: t("最高价"), optional: true },
        { key: "low", label: t("最低价"), optional: true },
        { key: "vol", label: t("成交量"), optional: true },
        { key: "amount", label: t("成交额"), optional: true },
      ];
      for (const field of colFields) {
        new Setting(details).setName(field.label + (field.optional ? t("（可选）") : "")).addDropdown((dropdown) => {
          if (field.optional) dropdown.addOption("", t("（不映射）"));
          // Object rows: the {code} placeholder lets the requested code pick
          // the column at fetch time (fixed-report sources, e.g. one yield
          // curve tenor per column).
          if (field.key !== "date" && selected.rowKind === "object") dropdown.addOption("{code}", t("代码占位符 {code}"));
          for (const option of options) {
            dropdown.addOption(option.value, option.label);
          }
          dropdown.setValue(def.jsonMap!.cols[field.key] ?? "").onChange((value) => {
            if (!def.jsonMap) return;
            if (field.key === "amount") {
              def.jsonMap.cols.amount = value || undefined;
            } else {
              def.jsonMap.cols[field.key] = value;
            }
            this.refreshMappingPreview();
          });
        });
      }
    }

    if (def.searchUrl) {
      this.renderSearchMapping(details);
    }

    const previewEl = details.createDiv("fc-mapping-preview");
    this.renderMappingPreview(previewEl);
  }

  private columnOptions(candidate: JsonRowCandidate): { value: string; label: string }[] {
    const preview = (value: unknown) => {
      const text = String(value ?? "");
      return text.length > 20 ? `${text.slice(0, 20)}…` : text;
    };
    if (candidate.rowKind === "array" && Array.isArray(candidate.row)) {
      return candidate.row.map((value, index) => ({ value: String(index), label: `${index}: ${preview(value)}` }));
    }
    if (candidate.rowKind === "object" && candidate.row && typeof candidate.row === "object") {
      return Object.entries(candidate.row).map(([key, value]) => ({ value: key, label: `${key}: ${preview(value)}` }));
    }
    return [];
  }

  private emptyCols(): JsonSourceMap["cols"] {
    return { date: "", open: "", close: "", high: "", low: "", vol: "" };
  }

  // Re-renders just the preview block after a mapping change.
  private refreshMappingPreview() {
    const previewEl = this.contentEl.querySelector(".fc-mapping-preview");
    if (previewEl instanceof HTMLElement) this.renderMappingPreview(previewEl);
  }

  private renderMappingPreview(previewEl: HTMLElement) {
    previewEl.empty();
    const map = this.def.jsonMap;
    if (!map || !this.sampleJson) return;
    if (Object.values(map.cols).some((v) => v?.includes("{code}"))) {
      previewEl.createDiv({
        cls: "fc-field-hint",
        text: t("映射包含代码占位符 {code}：取数时按实际代码选列，下方预览使用示例代码。"),
      });
    }
    const rows = parseMappedKline(this.sampleJson, resolveMapCode(map, splitCompositeCode(this.sampleCode).mapCode));
    if (rows.length === 0) {
      previewEl.createDiv({ cls: "fc-field-hint fc-detect-error", text: t("当前映射未解析出任何 K 线数据。") });
      return;
    }
    previewEl.createDiv({ cls: "fc-field-hint", text: t("共 {n} 条，预览最新 5 条：", { n: rows.length }) });
    this.renderRowsTable(previewEl, rows);
  }

  private renderRowsTable(containerEl: HTMLElement, rows: OhlcvRow[]) {
    const table = containerEl.createEl("table", { cls: "fc-preview-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const label of [t("日期"), t("开盘价"), t("收盘价"), t("最高价"), t("最低价"), t("成交量")]) {
      head.createEl("th", { text: label });
    }
    const body = table.createEl("tbody");
    for (const row of rows.slice(-5)) {
      const tr = body.createEl("tr");
      for (const value of [row.tradeDate, row.open, row.close, row.high, row.low, row.vol]) {
        tr.createEl("td", { text: String(value) });
      }
    }
  }

  // Search field mapping (generic JSON only) — kept manual: search payloads
  // vary too much to guess reliably, and the mapping is optional.
  private renderSearchMapping(contentEl: HTMLElement) {
    const def = this.def;
    if (def.format !== "json") return;
    const map = def.jsonMap;
    if (!map) return;

    const details = contentEl.createEl("details", { cls: "fc-settings-sub fc-hint-mt" });
    details.createEl("summary", { text: t("JSON 字段映射（搜索，可选）") });

    new Setting(details)
      .setName(t("搜索列表路径"))
      .setDesc(t("搜索结果数组在返回 JSON 中的位置，点号分隔。"))
      .addText((text) => {
        text.setPlaceholder("data.list").setValue(map.searchRowsPath ?? "").onChange((value) => {
          map.searchRowsPath = value.trim() || undefined;
        });
        text.inputEl.addClass("fc-mono");
      });

    const searchCols = map.searchCols ?? { code: "", name: "" };
    const searchFields: { key: "code" | "name" | "market"; label: string; optional?: boolean }[] = [
      { key: "code", label: t("代码") },
      { key: "name", label: t("名称") },
      { key: "market", label: t("市场"), optional: true },
    ];
    const colsHint = map.rowKind === "array" ? t("列序号（从 0 开始）") : t("字段名");
    for (const field of searchFields) {
      new Setting(details).setName(t("搜索{label}（{cols}）{optional}", {
        label: field.label,
        cols: colsHint,
        optional: field.optional ? t(" · 可选") : "",
      })).addText((text) => {
        text.setValue(searchCols[field.key] ?? "").onChange((value) => {
          const trimmed = value.trim();
          if (field.key === "market") {
            searchCols.market = trimmed || undefined;
          } else {
            searchCols[field.key] = trimmed;
          }
          map.searchCols = searchCols.code || searchCols.name ? searchCols : undefined;
        });
        text.inputEl.addClass("fc-mono");
      });
    }
  }

  private save() {
    const def = this.def;
    if (!def.name) {
      new Notice(t("请填写数据源名称。"));
      return;
    }
    if (!def.klineUrl) {
      new Notice(t("请填写 K线 URL。"));
      return;
    }
    if (def.format === "json") {
      const map = def.jsonMap;
      // rowsPath may be empty (a top-level array response); the two column
      // mappings are what actually matter.
      if (!map || !map.cols.date || !map.cols.close) {
        new Notice(t("通用 JSON 格式需要数据列表路径，以及日期、收盘价两列的映射。"));
        this.openMappingSection();
        return;
      }
    }
    this.close();
    this.onSubmit(def);
  }
}

// ===== Import / export (settings tab) =====
// Configs move as user-to-user JSON snippets; the plugin itself ships no
// endpoint URLs, keeping the "data-access framework only" stance.

// Validates a pasted export payload and returns fresh defs (new ids, so an
// imported copy never collides with an existing source). Throws on malformed
// input.
export function parseImportedSources(text: string): CustomSourceDef[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("not a source list");
  const defs: CustomSourceDef[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") throw new Error("invalid entry");
    const e = entry as Partial<CustomSourceDef>;
    if (typeof e.name !== "string" || !e.name.trim()) throw new Error("missing name");
    if (e.format !== "tencent" && e.format !== "eastmoney" && e.format !== "json" && e.format !== "csv") throw new Error("invalid format");
    if (e.format === "csv") {
      if (typeof e.filePath !== "string" || !e.filePath.trim()) throw new Error("missing filePath");
    } else if (typeof e.klineUrl !== "string" || !e.klineUrl.trim()) {
      throw new Error("missing klineUrl");
    }
    defs.push({
      id: `src-${Date.now().toString(36)}-${defs.length}`,
      name: e.name.trim(),
      enabled: e.enabled !== false,
      format: e.format,
      klineUrl: e.format === "csv" ? undefined : e.klineUrl!.trim(),
      filePath: e.format === "csv" ? e.filePath!.trim() : undefined,
      searchUrl: typeof e.searchUrl === "string" && e.searchUrl.trim() ? e.searchUrl.trim() : undefined,
      testCode: typeof e.testCode === "string" && e.testCode.trim() ? e.testCode.trim() : undefined,
      apiKey: typeof e.apiKey === "string" && e.apiKey.trim() ? e.apiKey.trim() : undefined,
      apiKeyHeader: typeof e.apiKeyHeader === "string" && e.apiKeyHeader.trim() ? e.apiKeyHeader.trim() : undefined,
      jsonMap: (e.format === "json" || e.format === "csv") && e.jsonMap ? e.jsonMap : undefined,
      // Wide-table CSV sources are useless without their column code table.
      symbols: e.format === "csv" && Array.isArray(e.symbols) ? e.symbols : undefined,
    });
  }
  return defs;
}

// Paste-box modal behind the settings-tab 导入 button.
export class CustomSourceImportModal extends Modal {
  constructor(app: App, onSubmit: (defs: CustomSourceDef[]) => void) {
    super(app);
    this.onSubmit = onSubmit;
    this.setTitle(t("导入自定义数据源"));
  }

  private onSubmit: (defs: CustomSourceDef[]) => void;

  onOpen() {
    const { contentEl } = this;
    contentEl.createDiv({
      cls: "fc-field-hint",
      text: t("粘贴他人分享或之前导出的数据源 JSON 配置。请自行确认接口来源合规。"),
    });
    const area = contentEl.createEl("textarea", { cls: "fc-mono fc-import-area" });
    area.placeholder = "[{ … }]";
    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const importBtn = footer.createEl("button", { text: t("导入"), cls: "mod-cta" });
    importBtn.addEventListener("click", () => {
      try {
        const defs = parseImportedSources(area.value);
        this.close();
        this.onSubmit(defs);
      } catch {
        new Notice(t("导入失败：内容不是有效的数据源配置。"));
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
