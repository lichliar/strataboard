import { App, Modal, Notice, Setting, TextComponent } from "obsidian";
import type { CustomSourceDef, JsonSourceMap, OhlcvRow, ResolvedCustomSourceDef } from "../types";
import { sourceNeedsApiKey } from "../types";
import { newCredentialId, type CredentialStore } from "../modules/credentials";
import { CREDENTIAL_NEW, renderCredentialField, type CredentialFieldHandle } from "./credential-field";
import { redactSecretsWith } from "../modules/redact";
import type { AiTaskContext, AiTaskRequest } from "../modules/ai/tasks";
import { outlineSample } from "../utils/sample-outline";
import { evaluateUrl } from "../utils/url-policy";
import { ConfirmModal } from "./confirm-modal";
import { AiCopyPreviewModal } from "./ai-copy-preview-modal";
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
import { parseSymbolList, resolveSymbolParams, stringifySymbolList } from "../utils/symbol-list";
import { applyInfoDescs } from "./info-desc";
import { t } from "../i18n";
import { findEmbeddedCredentialFields } from "../utils/source-credentials";
import { reportSourceHealth } from "../modules/source-health";

// AI_SOURCE_PROMPT lives in modules/source-prompt.ts (shared with the
// in-plugin AI assistant's tasks); re-exported here for existing UI
// importers (setup-guide-modal.ts, settings.ts).
export { AI_SOURCE_PROMPT } from "../modules/source-prompt";

// Setup dialog for one user-defined custom data source (设置页 → 数据源 →
// 添加数据源 → 远程接口).
// The plugin ships no endpoint URLs — the user pastes a working URL and the
// dialog templates it (autoTemplateUrl), probes it inline as they type, and
// auto-detects the response format (腾讯/东方财富 presets or a guessed
// generic-JSON mapping). While ADDING a source the layout is two sections
// on one page; editing an existing source shows only the first one:
//   1. 配置 — 名称 first, then K线接口地址 (pasting one auto-fills name /
//      sample code / credential), 示例代码 and 凭据, then the probe status
//      with its 测试并预览 button; rarely-touched inputs (请求方式 / 请求体 /
//      鉴权 Header / 兼容模式 / 搜索 URL / 代码表) live under 高级选项, the
//      manual field mapping under 字段映射（可选）(auto-opens when a
//      generic-JSON source parses nothing). A failed probe offers 复制报错 — a copyable
//      error report for the user's AI — in edit mode too. Field descriptions
//      render as hover-only info icons (applyInfoDescs), not text under the
//      field name.
//   2. AI 助手设置 — a jump into the plugin's task assistant when available;
//      MCP/CLI remains available from the settings tab for advanced users.
// Placeholders: klineUrl / bodyTemplate {code} {start} {end} {startIso}
// {endIso} {apiKey}, searchUrl / searchBodyTemplate {query}.

// Credential picker (sentinel values, dropdown, password input) lives in
// ui/credential-field.ts, shared with the AI 助手 BYOK settings block.

export const CUSTOM_FORMAT_LABELS: Record<CustomSourceDef["format"], string> = {
  tencent: "腾讯格式",
  eastmoney: "东方财富格式",
  json: "通用 JSON",
  csv: "CSV 文件",
};

// Guided prompt for adding a data source with AI help: moved to
// modules/source-prompt.ts and re-exported above (see that file's comment).

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

// Shape of the mapping JSON an AI assistant returns for 应用映射; validated
// structurally before any of it touches the source definition.
interface AiMappingPayload {
  rowsPath: string;
  rowKind: "object" | "array" | "fields";
  fieldsPath?: string;
  cols: {
    date: string;
    close: string;
    open?: string;
    high?: string;
    low?: string;
    vol?: string;
    amount?: string;
  };
  errorPath?: string;
  errorMessagePath?: string;
}

function isAiMappingPayload(value: unknown): value is AiMappingPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  const cols = payload.cols as Record<string, unknown> | null | undefined;
  return (
    typeof payload.rowsPath === "string" &&
    (payload.rowKind === "object" || payload.rowKind === "array" || payload.rowKind === "fields") &&
    (payload.rowKind !== "fields" || typeof payload.fieldsPath === "string") &&
    !!cols &&
    typeof cols.date === "string" &&
    cols.date !== "" &&
    typeof cols.close === "string" &&
    cols.close !== ""
  );
}

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
  // Credential UI state: undefined = 不配置凭据, CREDENTIAL_NEW = 新建凭据…
  // (ui/credential-field.ts), otherwise a stored credential id. pendingSecret
  // is the (unsaved) secret typed for a new credential or a rotation of the
  // selected one — it never touches the def.
  private credentialChoice: string | undefined;
  private pendingSecret = "";
  private credentialField: CredentialFieldHandle | null = null;

  constructor(
    app: App,
    // Full def = edit; a Partial without id = AI-drafted prefill (new-source
    // semantics, defaults fill the gaps). No arg = blank new source.
    def: Partial<CustomSourceDef> | undefined,
    onSubmit: (def: CustomSourceDef) => void,
    // Opens the settings window on the AI 助手 tab (AI section step 1).
    private onOpenAiSettings: () => void,
    // Existing sources, for labeling shared credentials in the picker.
    private allSources: CustomSourceDef[] = [],
    // Central credential seam (modules/credentials.ts).
    private credentials: CredentialStore,
    // URL policy plumbing: confirmed loopback-http origins + the callback
    // that persists a freshly confirmed one (settings.ts wires both).
    private allowedLoopbackHttpOrigins: string[],
    private onAllowLoopbackHttp: (origin: string) => Promise<void>,
    // In-plugin AI assistant (W08): hands a failed probe over to the AI
    // panel as an add-source / fix-source task. Absent = no「让 AI 诊断」button.
    private onOpenAiPanel?: (task: AiTaskRequest) => void
  ) {
    super(app);
    this.isNew = !def?.id;
    if (def?.id) {
      this.def = {
        ...(def as CustomSourceDef),
        jsonMap: def.jsonMap ? { ...def.jsonMap, cols: { ...def.jsonMap.cols }, searchCols: def.jsonMap.searchCols ? { ...def.jsonMap.searchCols } : undefined } : undefined,
      };
    } else {
      // AI drafts never carry id (whitelist), but drop it defensively so a
      // stray empty id can't blank the generated one.
      const prefill = { ...(def ?? {}) };
      delete prefill.id;
      this.def = {
        id: `src-${Date.now().toString(36)}`,
        name: "",
        enabled: true,
        format: "tencent",
        klineUrl: "",
        ...prefill,
      } as CustomSourceDef;
    }
    this.rawKlineUrl = this.def.klineUrl ?? "";
    this.rawSearchUrl = this.def.searchUrl ?? "";
    // New sources default the sample code to the SSE Composite Index — the
    // most likely code a user's AI will put in the URL it suggests.
    this.sampleCode = this.def.testCode ?? (this.isNew ? "sh000001" : "");
    if (this.isNew && !this.def.testCode) this.def.testCode = this.sampleCode;
    this.mappingOpen = this.def.format === "json";
    this.credentialChoice = this.def.credentialId;
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

    // AI 助手设置 is an add-flow feature only — editing an existing source
    // never shows it.
    if (this.isNew) {
      const aiSection = contentEl.createEl("details", { cls: "fc-settings-sub" });
      aiSection.setAttr("open", "");
      aiSection.createEl("summary", { text: `2. ${t("AI 助手设置")}` });
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

    applyInfoDescs(contentEl);
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
    let sampleCodeText: TextComponent | null = null;

    const nameSetting = new Setting(container).setName(t("名称")).setDesc(t("显示在选择器、工具栏和卡片文件名中；粘贴 URL 时自动取域名，可改。")).addText((text) => {
      nameText = text;
      text.setPlaceholder(t("如：我的行情源")).setValue(def.name).onChange((value) => {
        this.nameTouched = true;
        def.name = value.trim();
      });
    });
    nameSetting.settingEl.addClass("fc-setting-stacked");

    const klinePreview = container.createDiv({ cls: "fc-field-hint fc-mono fc-template-preview fc-hidden" });
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
          // A pasted URL carrying its credential inline seeds the
          // new-credential input; the template keeps only the {apiKey}
          // placeholder and the secret goes to SecretStorage on save. The
          // field itself decides whether the current selection allows this
          // (an explicitly chosen existing credential is never hijacked).
          const extracted = extractApiKey(this.rawKlineUrl);
          if (extracted) this.credentialField?.seedNewSecret(extracted);
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

    // 示例代码 stays on the first screen next to the URL (the paste
    // auto-guess fills it): it locates {code} and doubles as the probe code.
    const sampleSetting = new Setting(container)
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

    this.renderCredentialSection(container);

    // Inline probe status: detecting / error / parsed-row preview, plus the
    // explicit 测试并预览 button.
    this.renderDetectStatus(container.createDiv("fc-hint-mt"));

    // Rarely-touched knobs live under 高级选项: the request method/body (most
    // sources are plain GET), the auth header, the Node transport, the
    // search endpoint and the static code table.
    const advanced = container.createEl("details", { cls: "fc-settings-sub" });
    advanced.createEl("summary", { text: t("高级选项") });
    advanced.createDiv({
      cls: "fc-field-hint",
      text: t("一般无需改动：接口多为 GET 请求；鉴权 Header、搜索接口与静态代码表按需配置。"),
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
      .setDesc(t("个别站点在 Obsidian 默认网络栈（HTTP/2）下连接失败时开启；请求改用 Node https（HTTP/1.1）发送。"))
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
      // Symbol-level params / profile ({p.*} template variables and named
      // tiers) are not editable anywhere in the UI; editing the table here
      // carries them over by code so a name fix doesn't silently drop them.
      const previous = new Map((def.symbols ?? []).map((s) => [s.code, s]));
      const entries = parseSymbolList(symbolArea.value);
      for (const entry of entries) {
        const old = previous.get(entry.code);
        if (old?.params) entry.params = old.params;
        if (old?.profile) entry.profile = old.profile;
      }
      def.symbols = entries.length > 0 ? entries : undefined;
    });
    symbolHelp.createDiv({
      cls: "fc-field-hint",
      text: t("当前设置页不编辑符号级 params/profile；此处编辑会按代码保留已有值。接口依赖这类复杂参数时，请改用本地脚本。"),
    });

    if (def.format === "json") this.renderMappingSection(container);
  }

  // ===== 凭据 =====
  // The secret lives in Obsidian SecretStorage behind def.credentialId; the
  // dialog never stores it on the def. Selecting an existing credential id
  // shares it (e.g. across a source group); filling the password box while an
  // existing id is selected ROTATES the stored secret on save. Picker UI is
  // the shared component (ui/credential-field.ts); this dialog persists on
  // 保存, so onChange only mirrors the selection into dialog state.
  private renderCredentialSection(container: HTMLElement) {
    const def = this.def;
    const needs = sourceNeedsApiKey(def);

    this.credentialField = renderCredentialField(container, {
      credentials: this.credentials,
      selectedId: this.credentialChoice,
      pendingSecret: this.pendingSecret,
      describeId: (id) => {
        const users = this.allSources.filter((s) => s.credentialId === id).map((s) => s.name);
        return users.length > 0
          ? t("已有凭据（使用者：{names}）", { names: users.join("、") })
          : t("已有凭据（未被引用）");
      },
      desc: (sel) => {
        const desc: string[] = [
          t("密钥保存在 Obsidian SecretStorage，不写入 data.json；请求时仅按 {apiKey} 占位符发送到你配置的接口。多个数据源可引用同一凭据。"),
        ];
        if (needs && !sel.id) {
          desc.unshift(t("该源的模板包含 {apiKey} 占位符：不配置凭据将无法取数。"));
        }
        // {apiKey} in the URL query or the body travels through proxies and
        // logs — nudge towards the header without breaking a deliberate setup.
        const keyInQuery = /[?&][\w.-]*=\{apiKey\}/.test(def.klineUrl ?? "") || /[?&][\w.-]*=\{apiKey\}/.test(def.searchUrl ?? "");
        const keyInBody = (def.bodyTemplate ?? "").includes("{apiKey}") || (def.searchBodyTemplate ?? "").includes("{apiKey}");
        if (keyInQuery || keyInBody) {
          desc.push(t("注意：当前密钥会出现在{where}中，可能被代理或日志记录；接口支持时建议改用「鉴权 Header」。", {
            where: keyInQuery && keyInBody ? t(" URL 查询串和请求体") : keyInQuery ? t(" URL 查询串") : t(" 请求体"),
          }));
        }
        return desc.join(" ");
      },
      onChange: (sel) => {
        this.credentialChoice = sel.id;
        this.pendingSecret = sel.pendingSecret ?? "";
      },
    });
  }

  // The secret a probe should send right now: the pending new entry, the
  // selected stored credential, or none.
  private probeApiKey(): string | undefined {
    if (this.credentialChoice === CREDENTIAL_NEW) return this.pendingSecret.trim() || undefined;
    if (!this.credentialChoice) return undefined;
    return this.credentials.get(this.credentialChoice) ?? undefined;
  }

  // Secrets the central redactor does not know yet (unsaved input).
  private extraSecrets(): string[] {
    const pending = this.pendingSecret.trim();
    return pending ? [pending] : [];
  }

  // ===== 2. AI 助手设置 =====
  // Open the in-plugin task assistant when this modal has a host callback;
  // otherwise keep the settings shortcut for configuring BYOK.
  private renderAiSection(container: HTMLElement) {
    container.createDiv({
      cls: "fc-field-hint",
      text: t("不想手动配置？让插件内 AI 助手根据当前任务生成数据源草稿，并在确认后打开表单完成保存。"),
    });
    const openBtn = container.createEl("button", { text: t(this.onOpenAiPanel ? "让 AI 帮我配置" : "打开 AI 设置") });
    openBtn.addEventListener("click", () => {
      if (this.onOpenAiPanel) this.openAiDiagnosis();
      else this.onOpenAiSettings();
    });

    // The debug loop only makes sense once a probe produced a real response.
    if (this.sampleText) this.renderAiFixBlock(container);
  }

  // Probe status block inside「1. 配置」: detecting / error / preview. The
  // 测试并预览 button re-probes immediately, bypassing the edit debounce (the
  // paste-triggered auto probe still runs on its own). A failed probe also
  // offers 复制报错 — a ready-to-send AI error report — in edit mode too,
  // which has no AI section.
  private renderDetectStatus(statusEl: HTMLElement) {
    const testBtn = () => {
      const btn = statusEl.createEl("button", { text: t("测试并预览") });
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
        new AiCopyPreviewModal(this.app, this.buildErrorPrompt()).open();
      });
      if (this.onOpenAiPanel) {
        const aiBtn = statusEl.createEl("button", { text: t("让 AI 诊断") });
        aiBtn.addEventListener("click", () => this.openAiDiagnosis());
      }
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
    // Probes run with the dialog's pending/selected credential applied,
    // matching how the saved source will fetch at runtime.
    const probeDef: ResolvedCustomSourceDef = { ...this.def, apiKey: this.probeApiKey() };
    try {
      const sample = await fetchKlineSample(probeDef, this.sampleCode);
      if (key !== this.probeKey()) {
        // Inputs changed mid-flight — discard the stale sample and re-probe.
        this.probedKey = "";
        this.scheduleDetection();
        return;
      }
      this.sampleJson = sample.json;
      this.sampleText = sample.text;
      // Session health record: the settings-page badge shows the wizard
      // probe outcome for this source id (which survives the save).
      reportSourceHealth(this.def.id, true);
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
          const searchFormat = await autoDetectSearchFormat(probeDef);
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
      this.detectError = redactSecretsWith(err instanceof Error ? err.message : String(err), this.extraSecrets());
      reportSourceHealth(this.def.id, false, this.detectError);
      // A failed probe invalidates any earlier sample — dropping it keeps the
      // mapping section and the error report from showing stale data.
      this.sampleJson = undefined;
      this.sampleText = "";
      this.detectedRows = [];
      this.candidates = [];
      // Diagnosis hints (HTML interstitial / HTTP/2 transport) ride the error
      // message itself — see sendSourceRequest in custom-quote-client.
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
    for (const template of [this.def.klineUrl, this.def.searchUrl, ...(this.def.searches ?? []).map((s) => s.url)]) {
      if (!template) continue;
      const verdict = evaluateUrl(template, this.allowedLoopbackHttpOrigins);
      if (verdict.kind === "reject") {
        new Notice(verdict.reason, 10000);
        return;
      }
      if (verdict.kind === "warn-private") {
        new Notice(t("高风险：目标地址 {host} 指向私网/链路本地地址，请确认这是你有权访问的自有服务。", { host: verdict.host }), 8000);
      }
      if (verdict.kind === "loopback-http") {
        const origin = verdict.origin;
        new ConfirmModal(this.app, t("数据源将用明文 http 访问本机地址 {origin}。仅在确认这是你自己的服务时允许；允许后该地址会加入本机明文允许清单。", { origin }), () => {
          void this.onAllowLoopbackHttp(origin).then(() => void this.saveWithProbe());
        }).open();
        return;
      }
    }
    const credentialFields = findEmbeddedCredentialFields(this.def);
    if (credentialFields.length > 0) {
      new Notice(t("检测到疑似明文凭据：{fields}。请把密钥只填入「凭据」字段，并在这些位置改用 {apiKey} 占位符。", {
        fields: credentialFields.join("、"),
      }), 10000);
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
      outlineSample(redactSecretsWith(this.sampleText, this.extraSecrets())) +
      t(AI_DEBUG_PROMPT_TAIL)
    );
  }

  // Error report behind「复制报错（发给 AI）」: URL template, method and the
  // (already redacted) thrown error. The credential never leaves the dialog.
  private buildErrorPrompt(): string {
    return t(AI_ERROR_PROMPT, {
      url: this.def.klineUrl ?? "",
      method: this.def.method ?? "GET",
      sample: this.sampleCode || t("（无代码）"),
      error: redactSecretsWith(this.detectError, this.extraSecrets()),
    });
  }

  // Current config as AI-task context: the credential reference and the
  // enabled flag never leave the dialog; id stays so a fix-source proposal
  // can align its sourceId with this source.
  private aiContextDraft(): Partial<CustomSourceDef> {
    const draft: Partial<CustomSourceDef> & { apiKey?: string } = { ...this.def };
    delete draft.credentialId;
    delete draft.apiKey;
    delete draft.enabled;
    return draft;
  }

  // Hands a failed probe to the in-plugin AI panel: add-source while adding,
  // fix-source while editing. The panel runs the task and proposes a draft /
  // patch, which comes back here as a prefilled form (never a direct write).
  private openAiDiagnosis() {
    if (!this.onOpenAiPanel) return;
    const context: AiTaskContext = {
      existingSources: this.allSources.map((s) => ({ id: s.id, name: s.name, format: s.format })),
      sourceDraft: this.aiContextDraft(),
      errorText: redactSecretsWith(this.detectError, this.extraSecrets()),
    };
    if (this.sampleText) {
      context.sampleText = redactSecretsWith(this.sampleText, this.extraSecrets());
    }
    this.close();
    this.onOpenAiPanel({ kind: this.isNew ? "add-source" : "fix-source", goal: "", context });
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
      new AiCopyPreviewModal(this.app, this.buildDebugPrompt()).open();
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
    let parsed: unknown;
    try {
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      parsed = JSON.parse(cleaned);
    } catch {
      new Notice(t("无法解析映射 JSON，请确认粘贴的是 AI 返回的完整 JSON。"));
      return;
    }
    if (!isAiMappingPayload(parsed)) {
      new Notice(t("映射 JSON 不完整：需要 rowsPath、rowKind，以及 cols.date、cols.close。"));
      return;
    }
    const cols = parsed.cols;
    const rowKind = parsed.rowKind;
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
      rows = parseMappedKline(
        this.sampleJson,
        resolveMapCode(this.def.jsonMap, splitCompositeCode(this.sampleCode).mapCode, resolveSymbolParams(this.def, this.sampleCode))
      );
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
        pre.setText(redactSecretsWith(this.sampleText.slice(0, 400), this.extraSecrets()));
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
    const rows = parseMappedKline(
      this.sampleJson,
      resolveMapCode(map, splitCompositeCode(this.sampleCode).mapCode, resolveSymbolParams(this.def, this.sampleCode))
    );
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
    const credentialFields = findEmbeddedCredentialFields(def);
    if (credentialFields.length > 0) {
      new Notice(t("检测到疑似明文凭据：{fields}。请把密钥只填入「凭据」字段，并在这些位置改用 {apiKey} 占位符。", {
        fields: credentialFields.join("、"),
      }), 10000);
      return;
    }
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
    // Persist the credential through the credential seam — never on the def.
    if (this.credentialChoice === CREDENTIAL_NEW) {
      const secret = this.pendingSecret.trim();
      if (!secret) {
        if (sourceNeedsApiKey(def)) {
          new Notice(t("该源的模板包含 {apiKey} 占位符：请输入新密钥，或选择「不配置凭据」。"));
          return;
        }
        def.credentialId = undefined;
      } else {
        const id = newCredentialId();
        this.credentials.set(id, secret);
        def.credentialId = id;
      }
    } else if (!this.credentialChoice) {
      def.credentialId = undefined;
    } else {
      def.credentialId = this.credentialChoice;
      const rotated = this.pendingSecret.trim();
      if (rotated) this.credentials.set(this.credentialChoice, rotated);
    }
    this.close();
    this.onSubmit(def);
  }
}
