import { App, Modal, Notice, Setting, TextComponent } from "obsidian";
import type { CustomSourceDef, JsonSourceMap, OhlcvRow } from "../types";
import {
  detectBuiltinKlineFormat,
  detectJsonMapping,
  digPathValue,
  findFieldsMappings,
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
// generic-JSON mapping). While ADDING a source the layout is two sections
// on one page; editing an existing source shows only the first one:
//   1. 配置 — URL first (pasting one auto-fills name / sample code / API
//      key), then 名称 / API Key and the probe status with its 检测连接
//      button; rarely-touched inputs (请求方式 / 请求体 / 示例代码 / 鉴权
//      Header / 兼容模式 / 搜索 URL / 代码表) live under 高级选项, the manual
//      field mapping under 字段映射（可选）(auto-opens when a generic-JSON
//      source parses nothing). A failed probe offers 复制报错 — a copyable
//      error report for the user's AI — in edit mode too.
//   2. AI 辅助设置 — a single jump button to the settings tab's AI 辅助
//      page, which now hosts both the MCP/CLI one-click setup and the
//      AI_SOURCE_PROMPT guided prompt (the plugin has no built-in
//      assistant). A separate debug prompt fixes failed probes (its
//      mapping JSON reply can be pasted back and applied).
// Placeholders: klineUrl / bodyTemplate {code} {start} {end} {startIso}
// {endIso} {apiKey}, searchUrl / searchBodyTemplate {query}.

export const CUSTOM_FORMAT_LABELS: Record<CustomSourceDef["format"], string> = {
  tencent: "腾讯格式",
  eastmoney: "东方财富格式",
  json: "通用 JSON",
  csv: "CSV 文件",
};

// Guided prompt for adding a data source with AI help — shown in
// 设置 → AI 辅助 (settings.ts) and reused by the no-source setup guide
// modal (setup-guide-modal.ts). It assumes the user's AI is already wired
// to the plugin through the MCP server or CLI (list_sources / probe_data /
// ...), so instead of just "find me an endpoint" it walks the user through
// the whole setup — including telling them plainly when the plugin has no
// matching adapter and pointing them at the 脚本处理 CSV route instead. It
// deliberately names no concrete endpoints — the user's own AI picks one,
// keeping the plugin a pure data-access framework. The EN translation
// lives in i18n.ts under this exact string as key; keep the two in sync.
export const AI_SOURCE_PROMPT = `你将帮我为 Obsidian 插件 StrataBoard 配置一个「自定义数据源」。插件不内置任何数据源，所有数据都来自用户自行配置的 REST/JSON 接口或 vault 内 CSV 文件。你已通过 MCP server 或 CLI 接入该插件（可用工具：list_sources / search_symbols / probe_data / validate_cards）。请按以下流程一步步引导我，每步先跟我确认再往下走：

1. 先问清楚我想要什么：想配置哪个平台/来源的数据、具体标的/指标、频率、需要的字段（开高低收还是单值序列）；同时确认该平台是否需要 API key/token——如果需要，先告诉我申请方式，等我把可用的 key 直接发给你之后再带着它继续配置（key 由我自己保管，不要写进任何会分享出去的配置）。
2. 用 list_sources 查我已配置的自定义源，用 search_symbols 查本地代码库。如果已有源已覆盖我的需求，直接告诉我用哪个源建卡即可，不要新建数据源。
3. 确需新源时，帮我找一个无需登录、可直接访问的 JSON REST 接口，并用我提供的 key（如有）实际请求验证它能返回数据。优先官方或有公开文档的 API；不要使用未公开文档的抓取端点。
4. 核对该接口是否落在插件的适配范围内。插件只支持：
   - GET 请求（所有参数在 URL query 中）或 POST 请求（JSON 请求体，自动带 Content-Type: application/json）；可选一个鉴权 Header，值用 {apiKey} 占位；
   - 响应为 JSON；常见的按代码返回 K 线的行情格式会被自动识别，其它 JSON 必须能指出「数据行数组的路径 + 每行的日期列与数值列」（日期支持 ISO 日期时间、YYYYMMDD、时间戳）；
   - 「列名数组 + 数据行数组」的两段式响应（如 data.fields + data.items）也支持：rowKind 用 "fields"，cols 填列名；
   - 接口把业务错误放在 200 响应里时，可以用 errorPath / errorMessagePath 指明错误字段与消息字段；
   - 占位符：{code} 证券代码、{start}/{end} 为 YYYYMMDD 起止日期、{startIso}/{endIso} 为 YYYY-MM-DD 起止日期、{apiKey} 密钥（URL 与请求体模板通用）；
   - 搜索接口（可选，但有就强烈建议配置）：GET 搜索接口配 searchUrl（搜索词用 {query} 占位，{apiKey} 等鉴权占位符同样可用）；接口为 POST 时改配 searchBodyTemplate（搜索请求体模板，可用 {query} 与 {apiKey} 占位，URL 取 searchUrl、未配则复用 klineUrl）；接口只能整表返回、不支持按关键词查询时，配一个不含 {query} 的搜索模板即可，插件会拉回整表后本地过滤（结果有缓存，不会每次搜索都重新请求）。响应格式需与 K 线接口一致（同一 format）。json 格式时在 jsonMap 里加 searchRowsPath（搜索结果数组的点号路径）与 searchCols（{"code":"代码列","name":"名称列","market":"可选"}——rowKind 为 object 填字段名，array 填从 0 开始的列序号，fields 填列名或列序号）；
   - 固定报表宽表（一个 URL 返回整张表、每列一个序列）也支持：把列名当作代码，字段映射中用 {code} 选列；
   - 个别站点在 Obsidian 默认网络栈下连接失败时，可以开 transport: "node"（改用 Node https 发送）。
5. 如果接口不符合以上任一形态（需要登录 Cookie、返回 HTML/XML、需要多页拼装、请求体不是 JSON 等），插件的自定义数据源无法适配——请明确告诉我「该接口插件不支持」，并建议改用「脚本处理」：写一个 Python 脚本把数据输出为 CSV，插件会自动注册为 CSV 数据源（脚本编写提示词在 插件设置 → AI 辅助 →「提示词：编写数据处理脚本」）。
6. 适配可行时产出最终配置。如果这个平台能取的数据很多（如 tushare、fred 这类一个密钥覆盖大量指标的），不要只配我当下点名的那一项：把插件适配形态能覆盖的常用数据尽量一次配齐。同一个来源尽量合并为一个数据源条目：能用同一个 URL/请求体模板（仅靠 {code} 等占位符区分标的）覆盖的数据全部放进这一个源，名称直接用平台名（如 Tushare、FRED），并用 symbols 代码表把可用代码/指标尽量列全（代码 + 中文名称），让我之后按名称挑选，而不是逐个来问我。另外，如果平台提供查代码/指标的接口（GET 关键词搜索或 POST 基础信息表都算），务必一并配置 searchUrl 或 searchBodyTemplate——没有远程搜索，插卡时的搜索框只能查本地代码表，代码表之外的标的完全搜不到；接口只能整表返回时配不含 {query} 的模板让插件本地过滤，不要用 symbols 塞全量码表代替搜索。只有请求模板确实不同时（不同端点、不同接口名、不同请求方式）才拆成多个条目——不要按数据类别随意拆分（如不要拆出「Tushare 股票」「Tushare 指数」一堆源，能合则合）。确实需要拆成多个条目时，给同一平台拆出的所有条目填上相同的 group 字段（用平台名，如 "Tushare"）：插件会把同组的源在插入菜单和搜索框里折叠为一个分组入口，搜索时对组内所有源联合查询，我就不会面对一长串源列表。最终配置的交付方式二选一：
   a. 简单情况（单个 GET 接口、格式可自动识别）：给一个完整、可直接访问的 URL（含真实证券代码和起止日期）+ URL 中实际使用的代码。我会把 URL 粘贴到插件「添加数据源」弹窗，插件自动生成模板并检测格式；
   b. 其它情况（POST、宽表、手工字段映射，或一次配置多个条目）：把完整配置 JSON（一个数组）写入 vault 内的一个 .json 文件（如 vault 根目录下的 数据源配置.json），并把文件路径告诉我，我会在 插件设置 → 数据源设置 → 导入 里选择该文件导入——不要把 JSON 贴在对话里让我复制，手动粘贴容易丢格式。配置字段：name（名称）、group（可选，数据源分组名：同组的源在插入菜单/统一搜索里折叠为一个分组入口并联合搜索，同一平台拆出的多个条目填同一个平台名）、icon（可选，该源在插入菜单里显示的自定义 SVG 图标源码，留空则用颜色圆点）、format（"tencent"|"eastmoney"|"json"）、klineUrl（URL 模板）、method（"GET"|"POST"，默认 GET）、bodyTemplate（POST 请求体模板，支持同一套占位符）、transport（"node"，可选）、testCode（示例代码）、searchUrl（可选，GET 搜索 URL 模板，{query} 占位）、searchBodyTemplate（可选，POST 搜索请求体模板，{query} 与 {apiKey} 占位，URL 取 searchUrl、未配则复用 klineUrl；不含 {query} 表示整表返回、插件本地过滤）、jsonMap（{"rowsPath":"数据行数组的点号路径，顶层即数组则空串","rowKind":"object|array|fields","fieldsPath":"rowKind 为 fields 时的列名数组路径","cols":{"date":"必填","close":"必填","open/high/low/vol":"没有则空串"},"errorPath":"可选","errorMessagePath":"可选","searchRowsPath":"可选，搜索结果数组的点号路径，配了 searchUrl 或 searchBodyTemplate 才需要","searchCols":"可选，{\"code\",\"name\"，market 可选}，rowKind 为 object 填字段名、array 填列序号、fields 填列名或列序号"}）、symbols（可选，代码表 [{"code","name"}]）。文件里不要包含 apiKey 字段，密钥我在插件里单独填。
7. 我保存或导入后，用 list_sources 找到新源的 id，再用 probe_data（assetType="custom", sourceId=<id>, code=<示例代码>）做端到端验证，把结果告诉我；若 rows=0 或报错，按返回的 hint / 错误消息分析原因并修正配置后让我重新导入。

用我使用的语言与我交流，发现插件能力边界时直接说清楚，不要绕弯子。`;

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
  "rowKind": "object、array 或 fields（每行数据是对象 / 数组 / 数组且按列名寻址）",
  "fieldsPath": "仅 rowKind 为 fields 时必填：列名数组的点号路径，如 data.fields",
  "cols": {
    "date": "日期列：object 行填字段名，array 行填从 0 开始的列序号（字符串），fields 行填列名",
    "close": "收盘价/数值列",
    "open": "开盘价列，没有则填空字符串",
    "high": "最高价列，没有则填空字符串",
    "low": "最低价列，没有则填空字符串",
    "vol": "成交量列，没有则填空字符串",
    "amount": "成交额列，没有则填空字符串"
  },
  "errorPath": "可选：业务错误指示字段的点号路径，值非 0/空/null 视为错误",
  "errorMessagePath": "可选：错误消息字段的点号路径"
}
date 和 close 必填；单值序列（收益率、宏观指标等）把数值列填给 close 即可。日期可以是 ISO 日期时间、YYYYMMDD 或时间戳。`;

// Error report behind「复制报错（发给 AI）」(shown on a failed probe, in edit
// mode too): the AI is asked to fix the request itself — URL template,
// method, auth, transport — not a field mapping. {code}/{start}/... inside
// are literal text; t() only replaces the vars it is given.
const AI_ERROR_PROMPT = `我在给一个 Obsidian 插件配置自定义行情数据源，接口请求失败，请帮我分析原因并修正配置。

接口 URL 模板：{url}
其中 {code} 会被替换为证券代码，{start}/{end} 为 YYYYMMDD 起止日期，{startIso}/{endIso} 为 YYYY-MM-DD 起止日期，{apiKey} 为密钥占位符。请求方式：{method}。
用示例代码 {sample} 实际请求时报错：{error}

请分析报错原因，给出修正建议（URL 模板、请求方式、请求体模板、占位符、鉴权方式；个别站点在 Obsidian 默认网络栈下连接失败时，可开启兼容模式 transport: "node" 改用 Node https 发送），并告诉我修改后的配置。用我使用的语言与我交流。`;

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
    // Opens the settings window on the AI 辅助 tab (AI section step 1).
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
    configSection.createEl("summary", { text: this.isNew ? `1. ${t("配置")}` : t("配置") });
    this.renderConfigSection(configSection);

    // AI 辅助设置 is an add-flow feature only — editing an existing source
    // never shows it.
    if (this.isNew) {
      const aiSection = contentEl.createEl("details", { cls: "fc-settings-sub" });
      aiSection.setAttr("open", "");
      aiSection.createEl("summary", { text: `2. ${t("AI 辅助设置")}` });
      this.renderAiSection(aiSection);
    }

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

  // Everything that changes what the probe sends: URL template, sample code,
  // method/body, transport. A mismatch against probedKey means the inputs
  // changed since the last probe.
  private probeKey(): string {
    return [
      this.def.klineUrl,
      this.sampleCode,
      this.def.method ?? "GET",
      this.def.bodyTemplate ?? "",
      this.def.transport ?? "",
    ].join("::");
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

    const nameSetting = new Setting(container).setName(t("名称")).setDesc(t("显示在选择器、工具栏和卡片文件名中；粘贴 URL 时自动取域名，可改。")).addText((text) => {
      nameText = text;
      text.setPlaceholder(t("如：我的行情源")).setValue(def.name).onChange((value) => {
        this.nameTouched = true;
        def.name = value.trim();
      });
    });
    nameSetting.settingEl.addClass("fc-setting-stacked");

    const iconSetting = new Setting(container)
      .setName(t("自定义图标（可选）"))
      .setDesc(t("粘贴 SVG 代码；留空则在「插入图表」菜单中用颜色圆点区分。"));
    iconSetting.settingEl.addClass("fc-setting-stacked");
    iconSetting.addTextArea((text) => {
      text.setValue(def.icon ?? "").onChange((value) => {
        def.icon = value.trim() || undefined;
      });
      text.inputEl.addClass("fc-mono");
    });

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

    // Inline probe status: detecting / error / parsed-row preview, plus the
    // explicit 检测连接 button.
    this.renderDetectStatus(container.createDiv("fc-hint-mt"));

    // Rarely-touched knobs live under 高级选项: the request method/body (most
    // sources are plain GET), the sample code (normally auto-guessed from the
    // pasted URL), the auth header, the Node transport, the search endpoint
    // and the static code table.
    const advanced = container.createEl("details", { cls: "fc-settings-sub" });
    advanced.createEl("summary", { text: t("高级选项") });
    advanced.createDiv({
      cls: "fc-field-hint",
      text: t("一般无需改动：接口多为 GET 请求；示例代码会自动从 URL 猜测；鉴权 Header、搜索接口与静态代码表按需配置。"),
    });

    // POST sources (e.g. a JSON-RPC-style endpoint) send the body template
    // as the request body; the template reuses the URL's placeholder set.
    let bodySetting: Setting | null = null;
    new Setting(advanced)
      .setName(t("请求方式"))
      .setDesc(t("GET 把参数放在 URL 查询串中；POST 把下方请求体模板作为 JSON 请求体发送（自动带 Content-Type: application/json）。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("GET", "GET")
          .addOption("POST", "POST")
          .setValue(def.method ?? "GET")
          .onChange((value) => {
            def.method = value === "POST" ? "POST" : undefined;
            bodySetting?.settingEl.toggleClass("fc-hidden", value !== "POST");
            this.scheduleDetection();
          })
      );
    bodySetting = new Setting(advanced)
      .setName(t("请求体模板"))
      .setDesc(t("POST 请求体，与 URL 使用同一套占位符：{code} {start} {end} {startIso} {endIso} {apiKey}。"))
      .addTextArea((text) => {
        text
          .setPlaceholder('{"api_name":"…","token":"{apiKey}","params":{"ts_code":"{code}","start_date":"{start}","end_date":"{end}"}}')
          .setValue(def.bodyTemplate ?? "")
          .onChange((value) => {
            def.bodyTemplate = value.trim() ? value : undefined;
            this.scheduleDetection();
          });
        text.inputEl.addClass("fc-mono");
      });
    bodySetting.settingEl.addClass("fc-setting-stacked");
    bodySetting.settingEl.toggleClass("fc-hidden", (def.method ?? "GET") !== "POST");

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

    new Setting(advanced)
      .setName(t("兼容模式（Node https）"))
      .setDesc(t("个别站点（如 api.stlouisfed.org）在 Obsidian 默认网络栈下连接失败时开启；请求改用 Node https（HTTP/1.1）发送。"))
      .addToggle((toggle) =>
        toggle.setValue(def.transport === "node").onChange((value) => {
          def.transport = value ? "node" : undefined;
          this.scheduleDetection();
        })
      );

    const searchPreview = advanced.createDiv({ cls: "fc-field-hint fc-mono fc-template-preview fc-hidden" });
    const searchSetting = new Setting(advanced)
      .setName(t("搜索 URL（可选）"))
      .setDesc(t("粘贴一个带搜索词的完整搜索 URL，插件会自动将搜索词替换为 {query}；搜索接口为 POST 时留空、改填下方搜索请求体；都不配则该源使用手工录入代码。"))
      .addTextArea((text) => {
        text.setPlaceholder("https://…?q=000001").setValue(this.rawSearchUrl).onChange((value) => {
          this.rawSearchUrl = value.replace(/\s+/g, "");
          def.searchUrl = autoTemplateSearchUrl(this.rawSearchUrl) || undefined;
          updateSearchPreview();
        });
        text.inputEl.addClass("fc-mono");
      });
    searchSetting.settingEl.addClass("fc-setting-stacked");

    // POST search (e.g. Tushare-style endpoints where the API name lives in
    // the body): the request goes to 搜索 URL, falling back to the K线 URL.
    // A template without {query} fetches the whole list and the plugin
    // filters locally — a legitimate mode, not a misconfiguration.
    const searchBodySetting = new Setting(advanced)
      .setName(t("搜索请求体（POST，可选）"))
      .setDesc(t("搜索接口为 POST 时填写，可用 {query}、{apiKey} 占位。配置后搜索走 POST，URL 取上方「搜索 URL」，留空则复用 K线 URL。模板不含 {query} 表示接口只能整表返回，插件会拉回后按关键词本地过滤（结果有缓存）。"))
      .addTextArea((text) => {
        text
          .setPlaceholder('{"api_name":"stock_basic","token":"{apiKey}","params":{"list_status":"L"},"fields":"ts_code,name"}')
          .setValue(def.searchBodyTemplate ?? "")
          .onChange((value) => {
            def.searchBodyTemplate = value.trim() ? value : undefined;
            updateSearchPreview();
          });
        text.inputEl.addClass("fc-mono");
      });
    searchBodySetting.settingEl.addClass("fc-setting-stacked");

    const updateSearchPreview = () => {
      const body = def.searchBodyTemplate;
      if (!def.searchUrl && !body) {
        searchPreview.addClass("fc-hidden");
        return;
      }
      searchPreview.removeClass("fc-hidden");
      const hasQuery = (def.searchUrl ?? "").includes("{query}") || (body ?? "").includes("{query}");
      if (!hasQuery && body) {
        searchPreview.setText(t("搜索模板不含 {query}：搜索时整表拉回，由插件按关键词本地过滤。"));
      } else if (!hasQuery) {
        searchPreview.setText(t("未识别到搜索词参数，请手动把 URL 中的搜索词替换为 {query}。"));
      } else if (def.searchUrl) {
        searchPreview.setText(`${t("自动生成的模板")}: ${def.searchUrl}`);
      } else {
        searchPreview.setText(t("搜索 URL 未配置，POST 搜索将复用 K线 URL。"));
      }
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
  // Just a jump button: the MCP/CLI one-click setup and the guided prompt
  // (AI_SOURCE_PROMPT) both live in 设置 → AI 辅助 now.
  private renderAiSection(container: HTMLElement) {
    container.createDiv({
      cls: "fc-field-hint",
      text: t("不想手动配置？让 AI 代劳：在「AI 辅助」设置里完成一键接入（MCP / CLI），再把「添加数据源」引导提示词发给它——AI 会一步步引导你完成配置、自己验证接口，插件不支持时会明确告知。"),
    });
    const openBtn = container.createEl("button", { text: t("打开「AI 辅助」设置") });
    openBtn.addEventListener("click", () => this.onOpenAiSettings());

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

  // Probe status block inside「1. 配置」: detecting / error / preview. The
  // 检测连接 button re-probes immediately, bypassing the edit debounce (the
  // paste-triggered auto probe still runs on its own). A failed probe also
  // offers 复制报错 — a ready-to-send AI error report — in edit mode too,
  // which has no AI section.
  private renderDetectStatus(statusEl: HTMLElement) {
    const testBtn = () => {
      const btn = statusEl.createEl("button", { text: t("检测连接") });
      btn.addEventListener("click", () => void this.runDetection());
    };
    if (!this.def.klineUrl) {
      statusEl.createDiv({ cls: "fc-field-hint", text: t("粘贴 URL 后将自动检测接口与数据格式。") });
      return;
    }
    if (this.detecting || this.probeKey() !== this.probedKey) {
      // In flight, or inputs edited since the last probe (the debounced
      // re-probe is coming).
      statusEl.createDiv({ cls: "fc-field-hint", text: t("正在检测接口…") });
      return;
    }
    if (this.detectError) {
      statusEl.createDiv({ cls: "fc-field-hint fc-detect-error", text: t("检测失败：{msg}", { msg: this.detectError }) });
      testBtn();
      const copyBtn = statusEl.createEl("button", { text: t("复制报错（发给 AI）") });
      copyBtn.addEventListener("click", () => {
        void navigator.clipboard.writeText(this.buildErrorPrompt()).then(
          () => new Notice(t("报错与调试信息已复制，去发给你的 AI 吧。")),
          () => new Notice(t("复制失败，请手动选中提示词复制。")),
        );
      });
      return;
    }
    if (this.detectedRows.length === 0) {
      statusEl.createDiv({
        cls: "fc-field-hint fc-detect-error",
        text: t("已识别为{format}，但未解析出 K 线数据。", { format: t(CUSTOM_FORMAT_LABELS[this.def.format]) }),
      });
      testBtn();
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
    testBtn();
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
      // A failed probe invalidates any earlier sample — dropping it keeps the
      // mapping section and the error report from showing stale data.
      this.sampleJson = undefined;
      this.sampleText = "";
      this.detectedRows = [];
      this.candidates = [];
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

  // Error report behind「复制报错（发给 AI）」: URL template, method and the
  // thrown error (key-masked). The API key never leaves the dialog.
  private buildErrorPrompt(): string {
    return t(AI_ERROR_PROMPT, {
      url: this.def.klineUrl ?? "",
      method: this.def.method ?? "GET",
      sample: this.sampleCode || t("（无代码）"),
      error: this.maskApiKey(this.detectError),
    });
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
  // code fence around the payload. Accepts rowKind "fields" (with fieldsPath)
  // and the optional errorPath/errorMessagePath business-error contract.
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
    const rowKind = parsed?.rowKind;
    if (
      typeof parsed?.rowsPath !== "string" ||
      (rowKind !== "object" && rowKind !== "array" && rowKind !== "fields") ||
      (rowKind === "fields" && typeof parsed?.fieldsPath !== "string") ||
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
      rowKind,
      fieldsPath: rowKind === "fields" ? parsed.fieldsPath : undefined,
      cols: {
        date: cols.date,
        close: cols.close,
        open: typeof cols.open === "string" ? cols.open : "",
        high: typeof cols.high === "string" ? cols.high : "",
        low: typeof cols.low === "string" ? cols.low : "",
        vol: typeof cols.vol === "string" ? cols.vol : "",
        amount: typeof cols.amount === "string" && cols.amount ? cols.amount : undefined,
      },
      errorPath: typeof parsed.errorPath === "string" && parsed.errorPath.trim() ? parsed.errorPath.trim() : undefined,
      errorMessagePath:
        typeof parsed.errorMessagePath === "string" && parsed.errorMessagePath.trim() ? parsed.errorMessagePath.trim() : undefined,
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

    // Fields-mode mappings (rows addressed by column NAME — a fields+items
    // response) are offered next to the plain row lists the heuristic found.
    // A stored/AI-pasted fields mapping the heuristic missed gets synthesized
    // from the sample so the dropdown can still select and preview it.
    const fieldsMappings = this.sampleJson ? findFieldsMappings(this.sampleJson) : [];
    if (def.jsonMap?.rowKind === "fields" && this.sampleJson && !fieldsMappings.some((m) => m.rowsPath === def.jsonMap!.rowsPath)) {
      const fields = digPathValue(this.sampleJson, def.jsonMap.fieldsPath ?? "");
      const rows = digPathValue(this.sampleJson, def.jsonMap.rowsPath);
      if (
        Array.isArray(fields) && fields.length > 0 && fields.every((f) => typeof f === "string") &&
        Array.isArray(rows) && rows.length > 0
      ) {
        fieldsMappings.unshift({
          rowsPath: def.jsonMap.rowsPath,
          rowKind: "fields",
          fieldsPath: def.jsonMap.fieldsPath,
          cols: { ...def.jsonMap.cols },
        });
      }
    }

    if (this.candidates.length === 0 && fieldsMappings.length === 0) {
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

      // The 数据列表 dropdown mixes plain row lists (key = rowsPath) and
      // fields-mode mappings (key = "fields:<rowsPath>", distinct because the
      // same items array can appear in both forms).
      type ListOption =
        | { key: string; kind: "array" | "object"; candidate: JsonRowCandidate }
        | { key: string; kind: "fields"; mapping: JsonSourceMap };
      const listOptions: ListOption[] = [
        ...this.candidates.map((c): ListOption => ({ key: c.rowsPath, kind: c.rowKind, candidate: c })),
        ...fieldsMappings.map((m): ListOption => ({ key: `fields:${m.rowsPath}`, kind: "fields", mapping: m })),
      ];

      const currentKey = def.jsonMap
        ? def.jsonMap.rowKind === "fields"
          ? `fields:${def.jsonMap.rowsPath}`
          : def.jsonMap.rowsPath
        : "";
      let selected = listOptions.find((o) => o.key === currentKey);
      if (!selected && def.jsonMap?.rowsPath && def.jsonMap.rowKind !== "fields" && this.sampleJson) {
        // Legacy/manual mapping whose path the heuristic missed: synthesize a
        // candidate from the sample so the column dropdowns still work.
        const rows = digPathValue(this.sampleJson, def.jsonMap.rowsPath);
        if (Array.isArray(rows) && rows.length > 0) {
          const candidate: JsonRowCandidate = {
            rowsPath: def.jsonMap.rowsPath,
            rowKind: def.jsonMap.rowKind === "object" ? "object" : "array",
            row: rows[0],
          };
          this.candidates.unshift(candidate);
          selected = { key: candidate.rowsPath, kind: candidate.rowKind, candidate };
          listOptions.unshift(selected);
        }
      }
      selected ??= listOptions[0];
      if (!def.jsonMap && selected) {
        def.jsonMap =
          selected.kind === "fields"
            ? { rowsPath: selected.mapping.rowsPath, rowKind: "fields", fieldsPath: selected.mapping.fieldsPath, cols: { ...selected.mapping.cols } }
            : { rowsPath: selected.candidate.rowsPath, rowKind: selected.candidate.rowKind, cols: guessCols(selected.candidate) ?? this.emptyCols() };
      }

      new Setting(details)
        .setName(t("数据列表"))
        .setDesc(t("从响应中识别到的列表，选一个包含 K 线数据的。"))
        .addDropdown((dropdown) => {
          for (const option of listOptions) {
            const label =
              option.kind === "fields"
                ? `${option.mapping.rowsPath || "/"}（${t("列名数组")}）`
                : `${option.candidate.rowsPath || "/"}（${option.candidate.rowKind === "array" ? t("数组") : t("对象")}）`;
            dropdown.addOption(option.key, label);
          }
          dropdown.setValue(selected?.key ?? "").onChange((value) => {
            const option = listOptions.find((o) => o.key === value);
            if (!option || !def.jsonMap) return;
            if (option.kind === "fields") {
              def.jsonMap.rowsPath = option.mapping.rowsPath;
              def.jsonMap.rowKind = "fields";
              def.jsonMap.fieldsPath = option.mapping.fieldsPath;
              def.jsonMap.cols = { ...option.mapping.cols };
            } else {
              def.jsonMap.rowsPath = option.candidate.rowsPath;
              def.jsonMap.rowKind = option.candidate.rowKind;
              def.jsonMap.fieldsPath = undefined;
              def.jsonMap.cols = guessCols(option.candidate) ?? this.emptyCols();
            }
            this.render();
          });
        });

      // One dropdown per OHLCV column, options labeled with real values from
      // the first row so the user recognizes each column by its content. Only
      // date+close are required — single-value series (yields, macro
      // readings) leave the rest unmapped. Fields-mode columns are the column
      // NAMES from the fields list.
      const options =
        selected?.kind === "fields"
          ? this.fieldsColumnOptions(selected.mapping)
          : selected
            ? this.columnOptions(selected.candidate)
            : [];
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
          if (field.key !== "date" && selected?.kind === "object") dropdown.addOption("{code}", t("代码占位符 {code}"));
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

    if (def.searchUrl || def.searchBodyTemplate) {
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

  // Column options for a rowKind "fields" mapping: the choices are the column
  // NAMES from the fields list, labeled with the first row's value at the
  // matching index.
  private fieldsColumnOptions(mapping: JsonSourceMap): { value: string; label: string }[] {
    const fields: unknown = digPathValue(this.sampleJson, mapping.fieldsPath ?? "");
    const rows: unknown = digPathValue(this.sampleJson, mapping.rowsPath);
    const firstRow = Array.isArray(rows) ? rows[0] : undefined;
    if (!Array.isArray(fields)) return [];
    return fields.map((name, index) => {
      const value = String(name);
      const text = String(Array.isArray(firstRow) ? (firstRow[index] ?? "") : "");
      return { value, label: `${value}: ${text.length > 20 ? `${text.slice(0, 20)}…` : text}` };
    });
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
    const colsHint =
      map.rowKind === "object" ? t("字段名") : map.rowKind === "fields" ? t("列名或列序号") : t("列序号（从 0 开始）");
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
// Configs move as user-to-user JSON files; the plugin itself ships no
// endpoint URLs, keeping the "data-access framework only" stance.

// Validates an imported config payload and returns fresh defs (new ids, so an
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
    if (e.method !== undefined && e.method !== "GET" && e.method !== "POST") throw new Error("invalid method");
    if (e.transport !== undefined && e.transport !== "node") throw new Error("invalid transport");
    defs.push({
      id: `src-${Date.now().toString(36)}-${defs.length}`,
      name: e.name.trim(),
      enabled: e.enabled !== false,
      format: e.format,
      klineUrl: e.format === "csv" ? undefined : e.klineUrl!.trim(),
      filePath: e.format === "csv" ? e.filePath!.trim() : undefined,
      searchUrl: typeof e.searchUrl === "string" && e.searchUrl.trim() ? e.searchUrl.trim() : undefined,
      searchBodyTemplate:
        typeof e.searchBodyTemplate === "string" && e.searchBodyTemplate.trim() ? e.searchBodyTemplate : undefined,
      testCode: typeof e.testCode === "string" && e.testCode.trim() ? e.testCode.trim() : undefined,
      apiKey: typeof e.apiKey === "string" && e.apiKey.trim() ? e.apiKey.trim() : undefined,
      apiKeyHeader: typeof e.apiKeyHeader === "string" && e.apiKeyHeader.trim() ? e.apiKeyHeader.trim() : undefined,
      method: e.method === "POST" ? "POST" : undefined,
      bodyTemplate:
        e.method === "POST" && typeof e.bodyTemplate === "string" && e.bodyTemplate.trim() ? e.bodyTemplate : undefined,
      transport: e.transport === "node" ? "node" : undefined,
      group: typeof e.group === "string" && e.group.trim() ? e.group.trim() : undefined,
      icon: typeof e.icon === "string" && e.icon.trim() ? e.icon.trim() : undefined,
      jsonMap: (e.format === "json" || e.format === "csv") && e.jsonMap ? e.jsonMap : undefined,
      // Wide-table CSV and fixed-report JSON sources (tushare, FRED, …) are
      // useless without their pasted code table.
      symbols: (e.format === "csv" || e.format === "json") && Array.isArray(e.symbols) ? e.symbols : undefined,
    });
  }
  return defs;
}

// File-picker modal behind the settings-tab 导入 button. Configs arrive as
// complete .json files (written by the user's AI or exported earlier) rather
// than pasted text — pasting through a chat window can lose formatting.
export class CustomSourceImportModal extends Modal {
  private fileInput: HTMLInputElement | null = null;

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
      text: t("选择 AI 写入 vault 或之前导出的数据源 JSON 配置文件（.json）。请自行确认接口来源合规。"),
    });
    this.fileInput = contentEl.createEl("input", {
      cls: "fc-hidden",
      attr: { type: "file", accept: ".json,application/json" },
    });
    const row = contentEl.createDiv("fc-import-file");
    const pickBtn = row.createEl("button", { text: t("选择文件…") });
    const nameEl = row.createSpan({ cls: "fc-field-hint", text: t("未选择文件") });
    pickBtn.addEventListener("click", () => this.fileInput?.click());
    this.fileInput.addEventListener("change", () => {
      nameEl.setText(this.fileInput?.files?.[0]?.name ?? t("未选择文件"));
    });
    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const importBtn = footer.createEl("button", { text: t("导入"), cls: "mod-cta" });
    importBtn.addEventListener("click", () => {
      void (async () => {
        const file = this.fileInput?.files?.[0];
        if (!file) {
          new Notice(t("请先选择要导入的 JSON 配置文件。"));
          return;
        }
        try {
          const defs = parseImportedSources(await file.text());
          this.close();
          this.onSubmit(defs);
        } catch {
          new Notice(t("导入失败：内容不是有效的数据源配置。"));
        }
      })();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
