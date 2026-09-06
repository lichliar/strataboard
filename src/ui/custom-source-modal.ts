import { App, Modal, Notice, Setting } from "obsidian";
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
} from "../modules/quote-format-parsers";
import type { JsonRowCandidate } from "../modules/quote-format-parsers";
import { autoDetectSearchFormat, fetchKlineSample } from "../modules/custom-quote-client";
import { autoTemplateSearchUrl, autoTemplateUrl } from "../utils/url-template";
import { t } from "../i18n";

// Setup wizard for one user-defined custom data source (设置页 → 自定义数据源).
// The plugin ships no endpoint URLs — the user pastes a working URL and the
// wizard templates it (autoTemplateUrl), probes it, and auto-detects the
// response format (腾讯/东方财富 presets or a guessed generic-JSON mapping).
// Manual field mapping (step 3) is the fallback when detection fails.
// Placeholders: klineUrl {code} {start} {end} {startIso} {endIso}, searchUrl
// {query}.

export const CUSTOM_FORMAT_LABELS: Record<CustomSourceDef["format"], string> = {
  tencent: "腾讯格式",
  eastmoney: "东方财富格式",
  json: "通用 JSON",
};

// Copyable prompt for the "让 AI 帮你找" block in step 1. It deliberately
// names no concrete endpoints — the user's own AI picks one, keeping the
// plugin a pure data-access framework. The EN translation lives in i18n.ts
// under this exact string as the key; keep the two in sync.
const AI_FIND_ENDPOINT_PROMPT = `请帮我找一个无需登录、可以免费访问的日 K 线行情 REST 接口（股票/指数均可），我要在一个 Obsidian 插件里把它配置为自定义数据源。请直接给我：
1. 一个完整的、可以在浏览器地址栏直接打开并返回 JSON 数据的 URL 示例，URL 中必须包含真实的证券代码（建议用上证指数）和起止日期；
2. 这个 URL 中实际使用的证券代码（我会把它填入「示例代码」一栏）；
3. 返回 JSON 中各字段的含义（日期、开盘价、收盘价、最高价、最低价、成交量、成交额）；
4. 如果接口需要申请 token 或有频率限制，请说明申请方式。
如果还有按代码或名称搜索证券的接口，也请附上一个带搜索词的完整 URL 示例。`;

type WizardStep = 1 | 2 | 3;

export class CustomSourceModal extends Modal {
  private def: CustomSourceDef;
  private isNew: boolean;
  private onSubmit: (def: CustomSourceDef) => void;
  private step: WizardStep = 1;
  // Step 1 raw inputs (what the user pasted; def carries the templated form).
  private rawKlineUrl: string;
  private rawSearchUrl: string;
  private sampleCode: string;
  // Step 2/3 probe state.
  private detecting = false;
  private detectError = "";
  private sampleJson: any;
  private sampleText = "";
  private detectedRows: OhlcvRow[] = [];
  private candidates: JsonRowCandidate[] = [];
  private searchHint = "";

  constructor(app: App, def: CustomSourceDef | undefined, onSubmit: (def: CustomSourceDef) => void) {
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
    this.rawKlineUrl = this.def.klineUrl;
    this.rawSearchUrl = this.def.searchUrl ?? "";
    // New sources default the sample code to the SSE Composite Index — the
    // most likely code a user's AI will put in the URL it suggests.
    this.sampleCode = this.def.testCode ?? (this.isNew ? "sh000001" : "");
    if (this.isNew && !this.def.testCode) this.def.testCode = this.sampleCode;
    this.onSubmit = onSubmit;
    this.setTitle(this.isNew ? t("添加自定义数据源") : t("编辑自定义数据源"));
  }

  onOpen() {
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    this.renderStepHeader(contentEl);
    if (this.step === 1) this.renderStep1(contentEl);
    else if (this.step === 2) this.renderStep2(contentEl);
    else this.renderStep3(contentEl);
  }

  private renderStepHeader(contentEl: HTMLElement) {
    const header = contentEl.createDiv("fc-wizard-steps");
    const steps: { step: WizardStep; label: string }[] = [
      { step: 1, label: t("填写地址") },
      { step: 2, label: t("自动检测") },
      { step: 3, label: t("字段映射（可选）") },
    ];
    for (const { step, label } of steps) {
      const el = header.createSpan({ cls: "fc-wizard-step", text: `${step}. ${label}` });
      if (step === this.step) el.addClass("is-active");
      else if (step < this.step) el.addClass("is-done");
    }
  }

  // Step 1: name + paste full URLs; templates are generated live.
  private renderStep1(contentEl: HTMLElement) {
    const def = this.def;

    new Setting(contentEl).setName(t("名称")).setDesc(t("显示在选择器、工具栏和卡片文件名中。")).addText((text) =>
      text.setPlaceholder(t("如：我的行情源")).setValue(def.name).onChange((value) => {
        def.name = value.trim();
      })
    );

    const klinePreview = contentEl.createDiv({ cls: "fc-field-hint fc-mono fc-template-preview fc-hidden" });

    // AI assist: a copyable prompt the user can hand to their own AI to find
    // a working endpoint. The prompt names no endpoints itself — the plugin
    // stays a pure data-access framework.
    const aiHelp = contentEl.createEl("details", { cls: "fc-settings-sub fc-ai-help" });
    aiHelp.createEl("summary", { text: t("没有现成的接口？让 AI 帮你找") });
    aiHelp.createDiv({
      cls: "fc-field-hint",
      text: t("复制这段提示词发给你的 AI（如 ChatGPT / Kimi / DeepSeek），把它返回的 URL 粘贴到下方，URL 中用到的代码填入「示例代码」。"),
    });
    const promptArea = aiHelp.createEl("textarea", { cls: "fc-mono fc-prompt-area", attr: { readonly: "true" } });
    promptArea.value = t(AI_FIND_ENDPOINT_PROMPT);
    const copyBtn = aiHelp.createEl("button", { text: t("复制提示词") });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(promptArea.value).then(
        () => new Notice(t("提示词已复制到剪贴板，去发给你的 AI 吧。")),
        () => new Notice(t("复制失败，请手动选中提示词复制。")),
      );
    });

    new Setting(contentEl)
      .setName(t("K线接口地址"))
      .setDesc(t("粘贴一个能直接访问的完整 URL（带真实代码与日期），插件会自动识别代码与日期并生成模板。"))
      .addTextArea((text) => {
        text.setPlaceholder("https://…?code=sh600519&beg=20240101&end=20241231").setValue(this.rawKlineUrl).onChange((value) => {
          this.rawKlineUrl = value.trim();
          def.klineUrl = autoTemplateUrl(this.rawKlineUrl, this.sampleCode);
          updateKlinePreview();
        });
        text.inputEl.addClass("fc-mono");
      });
    const updateKlinePreview = () => {
      const show = def.klineUrl && def.klineUrl !== this.rawKlineUrl;
      klinePreview.toggleClass("fc-hidden", !show);
      if (show) klinePreview.setText(`${t("自动生成的模板")}: ${def.klineUrl}`);
    };
    updateKlinePreview();

    new Setting(contentEl)
      .setName(t("示例代码"))
      .setDesc(t("上面 URL 中实际使用的代码，用于识别 {code} 位置并作为接口检测代码，默认 sh000001（上证指数）。"))
      .addText((text) => {
        text.setPlaceholder("sh000001").setValue(this.sampleCode).onChange((value) => {
          this.sampleCode = value.trim();
          def.testCode = this.sampleCode || undefined;
          def.klineUrl = autoTemplateUrl(this.rawKlineUrl, this.sampleCode);
          updateKlinePreview();
        });
        text.inputEl.addClass("fc-mono");
      });

    const searchPreview = contentEl.createDiv({ cls: "fc-field-hint fc-mono fc-template-preview fc-hidden" });
    new Setting(contentEl)
      .setName(t("搜索 URL（可选）"))
      .setDesc(t("粘贴一个带搜索词的完整搜索 URL，插件会自动将搜索词替换为 {query}；留空则该源使用手工录入代码。"))
      .addTextArea((text) => {
        text.setPlaceholder("https://…?q=000001").setValue(this.rawSearchUrl).onChange((value) => {
          this.rawSearchUrl = value.trim();
          def.searchUrl = autoTemplateSearchUrl(this.rawSearchUrl) || undefined;
          updateSearchPreview();
        });
        text.inputEl.addClass("fc-mono");
      });
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

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const nextBtn = footer.createEl("button", { text: t("下一步：自动检测"), cls: "mod-cta" });
    nextBtn.addEventListener("click", () => {
      if (!def.name) {
        new Notice(t("请填写数据源名称。"));
        return;
      }
      if (!def.klineUrl) {
        new Notice(t("请填写 K线 URL。"));
        return;
      }
      if (!this.sampleCode) {
        new Notice(t("请填写示例代码（URL 中实际使用的那个代码）。"));
        return;
      }
      if (!def.klineUrl.includes("{code}")) {
        new Notice(t("URL 中未找到示例代码，无法定位 {code}；请确认示例代码与 URL 一致。"));
        return;
      }
      this.step = 2;
      this.detectError = "";
      this.detectedRows = [];
      this.searchHint = "";
      this.render();
      void this.runDetection();
    });
  }

  // Step 2: probe result — detected format + a preview of the parsed rows.
  private renderStep2(contentEl: HTMLElement) {
    if (this.detecting) {
      contentEl.createDiv({ cls: "fc-field-hint", text: t("正在检测接口…") });
      return;
    }
    if (this.detectError) {
      contentEl.createDiv({ cls: "fc-field-hint fc-detect-error", text: t("检测失败：{msg}", { msg: this.detectError }) });
    } else {
      contentEl.createDiv({
        cls: "fc-field-hint",
        text: t("识别为{format}，共 {n} 条 K 线。请核对下方数据是否正确：", {
          format: t(CUSTOM_FORMAT_LABELS[this.def.format]),
          n: this.detectedRows.length,
        }),
      });
      this.renderRowsTable(contentEl, this.detectedRows);
      if (this.searchHint) {
        contentEl.createDiv({ cls: "fc-field-hint fc-hint-mt", text: this.searchHint });
      }
    }

    const footer = contentEl.createDiv("fc-modal-footer");
    const backBtn = footer.createEl("button", { text: t("上一步") });
    backBtn.addEventListener("click", () => {
      this.step = 1;
      this.render();
    });
    const retryBtn = footer.createEl("button", { text: t("重新检测") });
    retryBtn.addEventListener("click", () => void this.runDetection());
    if (this.def.format === "json") {
      const mappingBtn = footer.createEl("button", { text: t("调整字段映射") });
      mappingBtn.addEventListener("click", () => {
        this.step = 3;
        this.render();
      });
    }
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.disabled = Boolean(this.detectError);
    saveBtn.addEventListener("click", () => this.save());
  }

  private async runDetection() {
    this.detecting = true;
    this.detectError = "";
    this.render();
    try {
      const sample = await fetchKlineSample(this.def, this.sampleCode);
      this.sampleJson = sample.json;
      this.sampleText = sample.text;
      const builtin = detectBuiltinKlineFormat(sample.json, this.sampleCode);
      if (builtin) {
        this.def.format = builtin;
        this.def.jsonMap = undefined;
        this.detectedRows = builtin === "tencent" ? parseTencentKline(sample.json, this.sampleCode) : parseEastmoneyKline(sample.json);
        this.candidates = [];
      } else {
        const map = detectJsonMapping(sample.json);
        this.def.format = "json";
        this.def.jsonMap = map ?? undefined;
        this.candidates = findRowCandidates(sample.json);
        this.detectedRows = map ? parseMappedKline(sample.json, map) : [];
        if (this.detectedRows.length === 0) {
          // Nothing parsed — the user must map the fields by hand.
          this.step = 3;
          return;
        }
      }
      if (this.def.searchUrl) {
        try {
          const searchFormat = await autoDetectSearchFormat(this.def);
          if (searchFormat !== this.def.format) {
            this.searchHint = t("检测到搜索接口的响应格式与 K 线接口不同，搜索可能不可用；两者需为同一格式。");
          } else if (searchFormat === "json") {
            this.searchHint = t("搜索接口为通用 JSON，如需使用搜索请在字段映射中配置搜索映射。");
          } else {
            this.searchHint = "";
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

  // Step 3: generic-JSON mapping picked from real response values — no paths
  // or column indexes to type in the common case.
  private renderStep3(contentEl: HTMLElement) {
    const def = this.def;
    if (this.candidates.length === 0) {
      contentEl.createDiv({
        cls: "fc-field-hint",
        text: t("响应中未找到可用的数据列表，请返回上一步检查 URL 与示例代码。"),
      });
      if (this.sampleText) {
        const pre = contentEl.createEl("pre", { cls: "fc-sample-dump" });
        pre.setText(this.sampleText.slice(0, 400));
      }
    } else {
      contentEl.createDiv({
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

      new Setting(contentEl)
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
      // the first row so the user recognizes each column by its content.
      const options = this.columnOptions(selected);
      const colFields: { key: keyof JsonSourceMap["cols"]; label: string; optional?: boolean }[] = [
        { key: "date", label: t("日期") },
        { key: "open", label: t("开盘价") },
        { key: "close", label: t("收盘价") },
        { key: "high", label: t("最高价") },
        { key: "low", label: t("最低价") },
        { key: "vol", label: t("成交量") },
        { key: "amount", label: t("成交额"), optional: true },
      ];
      for (const field of colFields) {
        new Setting(contentEl).setName(field.label + (field.optional ? t("（可选）") : "")).addDropdown((dropdown) => {
          if (field.optional) dropdown.addOption("", t("（不映射）"));
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
      this.renderSearchMapping(contentEl);
    }

    const previewEl = contentEl.createDiv("fc-mapping-preview");
    this.renderMappingPreview(previewEl);

    const footer = contentEl.createDiv("fc-modal-footer");
    const backBtn = footer.createEl("button", { text: t("上一步") });
    backBtn.addEventListener("click", () => {
      this.step = 2;
      this.render();
    });
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
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
    const rows = parseMappedKline(this.sampleJson, map);
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
      if (!map?.rowsPath || !map.cols.date || !map.cols.open || !map.cols.close || !map.cols.high || !map.cols.low || !map.cols.vol) {
        new Notice(t("通用 JSON 格式需要完整的数据列表路径与日期/开/收/高/低/量列映射。"));
        if (this.step !== 3) {
          this.step = 3;
          this.render();
        }
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
    if (typeof e.klineUrl !== "string" || !e.klineUrl.trim()) throw new Error("missing klineUrl");
    if (e.format !== "tencent" && e.format !== "eastmoney" && e.format !== "json") throw new Error("invalid format");
    defs.push({
      id: `src-${Date.now().toString(36)}-${defs.length}`,
      name: e.name.trim(),
      enabled: e.enabled !== false,
      format: e.format,
      klineUrl: e.klineUrl.trim(),
      searchUrl: typeof e.searchUrl === "string" && e.searchUrl.trim() ? e.searchUrl.trim() : undefined,
      testCode: typeof e.testCode === "string" && e.testCode.trim() ? e.testCode.trim() : undefined,
      jsonMap: e.format === "json" && e.jsonMap ? e.jsonMap : undefined,
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
