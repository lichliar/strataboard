import { App, Modal, Notice, Setting, type TextAreaComponent, type TextComponent } from "obsidian";
import { parseWidgetCode, type WidgetCodeParse } from "../modules/widget-parser";
import { FolderPathSelect } from "./folder-suggester";

// TradingView Widget insert modal. Two sub-pages: 插入数据 (docs CTA + title
// + code + detected pill + save path) and 可修改参数 (interval / theme /
// side-toolbar controls extracted from the code, written back into it
// bidirectionally). The standard flow: open the TradingView widget docs via
// the CTA, configure the widget on their site, paste the generated code back
// here, then 插入. Any HTML the parser can't recognize degrades to manual
// editing with an empty params page.

export interface WidgetInputModalResult {
  title: string;
  input: string;
  savePath?: string;
}

const DOCS_URL = "https://www.tradingview.com/widget-docs/widgets/";

const INTERVAL_OPTIONS: { value: string; label: string }[] = [
  { value: "15", label: "15分" },
  { value: "60", label: "1小时" },
  { value: "D", label: "日线" },
  { value: "W", label: "周线" },
  { value: "M", label: "月线" },
];

const THEME_CHOICES = [
  { value: "auto", label: "跟随Obsidian" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] as const;

type SubPage = "insert" | "params";

export class WidgetInputModal extends Modal {
  private onSubmit: (result: WidgetInputModalResult) => void;
  private code = "";
  private parsed: WidgetCodeParse | null = null;
  private titleValue = "";
  private titleManual = false;
  private savePathValue = "";
  private defaultSavePath: string;
  private activeSubPage: SubPage = "insert";

  private codeArea: TextAreaComponent | null = null;
  private titleText: TextComponent | null = null;
  private autoBadgeEl: HTMLElement | null = null;
  private pillRowEl: HTMLElement | null = null;
  private paramsPageEl: HTMLElement | null = null;
  private reparseTimer: number | null = null;

  constructor(app: App, onSubmit: (result: WidgetInputModalResult) => void, defaultSavePath = "") {
    super(app);
    this.onSubmit = onSubmit;
    this.defaultSavePath = defaultSavePath;
    this.setTitle("插入TradingView Widget");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    const tabBar = contentEl.createDiv("fc-subtabs");
    const pagesEl = contentEl.createDiv();
    const pages: Record<SubPage, HTMLElement> = {
      insert: pagesEl.createDiv(),
      params: pagesEl.createDiv(),
    };
    const applyActive = () => {
      pages.insert.style.display = this.activeSubPage === "insert" ? "" : "none";
      pages.params.style.display = this.activeSubPage === "params" ? "" : "none";
      tabBar.querySelectorAll(".fc-subtab").forEach((el, i) => {
        el.classList.toggle("is-active", (i === 0 ? "insert" : "params") === this.activeSubPage);
      });
    };
    (["insert", "params"] as SubPage[]).forEach((id) => {
      const btn = tabBar.createEl("button", { text: id === "insert" ? "插入数据" : "可修改参数", cls: "fc-subtab" });
      btn.addEventListener("click", () => {
        this.activeSubPage = id;
        applyActive();
      });
    });
    applyActive();

    this.renderInsertPage(pages.insert);
    this.paramsPageEl = pages.params;
    this.reparse();

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    const insertBtn = footer.createEl("button", { text: "插入", cls: "mod-cta" });
    insertBtn.addEventListener("click", () => {
      if (!this.code.trim()) {
        new Notice("请粘贴组件代码或 iframe URL。");
        return;
      }
      this.close();
      this.onSubmit({
        title: this.titleValue.trim(),
        input: this.code.trim(),
        savePath: this.savePathValue.trim() || undefined,
      });
    });
  }

  onClose() {
    if (this.reparseTimer !== null) {
      window.clearTimeout(this.reparseTimer);
      this.reparseTimer = null;
    }
    this.contentEl.empty();
  }

  // ==================== 插入数据 ====================

  private renderInsertPage(pageEl: HTMLElement) {
    // Docs CTA: the standard flow is to configure the widget on tradingview.com
    // and paste the generated code back here, so the docs link is the
    // emphasized entry point at the top of the page.
    const docsBox = pageEl.createDiv("fc-widget-docs-box");
    const docsBtn = docsBox.createEl("button", {
      cls: "fc-widget-docs-cta",
      text: "打开 TradingView 组件文档 ↗",
      attr: { type: "button" },
    });
    docsBtn.addEventListener("click", () => window.open(DOCS_URL));
    docsBox.createDiv({
      cls: "fc-field-hint",
      text: "在 TradingView 网站挑选组件并完成配置，复制生成的代码粘贴到下方代码框，点击「插入」。",
    });
    docsBox.createDiv({
      cls: "fc-widget-net-notice",
      text: "⚠ 中国大陆用户注意：TradingView 组件的访问与显示需要可用的国际网络环境。",
    });

    // 标题 + 自动识别 badge
    const titleField = pageEl.createDiv("fc-widget-field");
    const titleLabelRow = titleField.createDiv("fc-widget-label-row");
    const titleLabel = titleLabelRow.createSpan("fc-widget-label");
    titleLabel.appendText("标题");
    this.autoBadgeEl = titleLabel.createSpan({ cls: "fc-pill fc-pill-sm", text: "自动识别" });
    this.autoBadgeEl.style.display = "none";
    titleField.createDiv({ cls: "fc-field-hint", text: "从代码的 symbol 字段生成，手动修改后不再被覆盖" });
    new Setting(titleField).addText((text) => {
      text.setPlaceholder("例如：USINTR 利率走势").setValue(this.titleValue).onChange((value) => {
        this.titleValue = value;
        // Clearing the field resumes auto-detection; any real text sticks.
        this.titleManual = value.trim().length > 0;
        this.updateAutoBadge();
      });
      this.titleText = text;
    });

    // 组件代码
    const codeField = pageEl.createDiv("fc-widget-field");
    const codeLabelRow = codeField.createDiv("fc-widget-label-row");
    codeLabelRow.createSpan({ cls: "fc-widget-label", text: "组件代码" });
    codeField.createDiv({ cls: "fc-field-hint", text: "粘贴后自动解析配置对象，提取的参数见「可修改参数」子页面" });
    new Setting(codeField).setClass("fc-widget-code-setting").addTextArea((area) => {
      area
        .setPlaceholder("<!-- TradingView Widget BEGIN -->\n...")
        .setValue(this.code)
        .onChange((value) => {
          this.code = value;
          this.scheduleReparse();
        });
      area.inputEl.rows = 10;
      area.inputEl.addClass("fc-mono");
      this.codeArea = area;
    });

    // 识别结果 pill（在 reparse 中原地更新）
    this.pillRowEl = pageEl.createDiv("fc-widget-pill-row");

    // 保存路径（folder suggester）
    const pathField = pageEl.createDiv("fc-widget-field");
    pathField.createDiv({ cls: "fc-widget-label-row" }).createSpan({ cls: "fc-widget-label", text: "保存路径" });
    pathField.createDiv({ cls: "fc-field-hint", text: "选择预设目录或输入 Vault 内相对路径，留空使用默认路径" });
    const pathSetting = new Setting(pathField).setClass("fc-widget-path-setting");
    new FolderPathSelect(pathSetting.controlEl, {
      app: this.app,
      value: this.savePathValue,
      placeholder: this.defaultSavePath || "默认目录",
      onChange: (path) => {
        this.savePathValue = path === this.defaultSavePath ? "" : path;
      },
    });
  }

  // ==================== 识别 / 同步 ====================

  private scheduleReparse() {
    if (this.reparseTimer !== null) {
      window.clearTimeout(this.reparseTimer);
    }
    this.reparseTimer = window.setTimeout(() => {
      this.reparseTimer = null;
      this.reparse();
    }, 300);
  }

  private reparse() {
    this.parsed = parseWidgetCode(this.code);
    this.renderPillRow();
    this.renderParamsPage();
    if (!this.titleManual && this.parsed?.title) {
      this.titleValue = this.parsed.title;
      this.titleText?.setValue(this.parsed.title);
    }
    this.updateAutoBadge();
  }

  private updateAutoBadge() {
    if (this.autoBadgeEl) {
      this.autoBadgeEl.style.display = !this.titleManual && this.parsed?.title ? "" : "none";
    }
  }

  private renderPillRow() {
    const row = this.pillRowEl;
    if (!row) return;
    row.empty();
    const parsed = this.parsed;
    if (parsed?.config) {
      const pill = row.createSpan("fc-pill");
      pill.createSpan("fc-pill-dot");
      const paramCount = this.availableParamCount(parsed.config);
      pill.appendText(`已识别：TradingView ${parsed.widgetName ?? "组件"} · 提取 ${paramCount} 项可修改参数`);
    }
    row.createSpan({
      cls: "fc-field-hint",
      text: "支持嵌入代码 / iframe URL；任意 HTML 片段降级为手动编辑",
    });
  }

  // ==================== 可修改参数 ====================

  private availableParamCount(config: Record<string, unknown>): number {
    let count = 0;
    if ("interval" in config) count++;
    if ("theme" in config) count++;
    if ("hide_side_toolbar" in config) count++;
    return count;
  }

  private renderParamsPage() {
    const pageEl = this.paramsPageEl;
    if (!pageEl) return;
    pageEl.empty();
    const config = this.parsed?.config;
    if (!config || this.availableParamCount(config) === 0) {
      pageEl.createDiv({ cls: "fc-field-hint", text: "未识别到可修改参数" });
      return;
    }

    const head = pageEl.createDiv("fc-widget-pill-row");
    const pill = head.createSpan("fc-pill");
    pill.createSpan("fc-pill-dot");
    pill.appendText(`从组件代码提取 ${this.availableParamCount(config)} 项参数`);
    head.createSpan({ cls: "fc-field-hint", text: "修改后自动写回「插入数据」子页面的组件代码" });

    if ("interval" in config) {
      const current = String(config.interval ?? "");
      const options = INTERVAL_OPTIONS.some((o) => o.value === current)
        ? INTERVAL_OPTIONS
        : [...INTERVAL_OPTIONS, { value: current, label: current }];
      const setting = new Setting(pageEl).setName("显示周期").setDesc("对应配置字段 interval。");
      this.addSegmented(setting.controlEl, options, current, (value) => {
        this.applyParam("interval", value);
      });
    }

    if ("theme" in config) {
      const current = config.theme === "light" || config.theme === "dark" ? config.theme : "auto";
      const setting = new Setting(pageEl).setName("主题").setDesc("对应配置字段 theme。");
      this.addSegmented(
        setting.controlEl,
        THEME_CHOICES.map((c) => ({ value: c.value, label: c.label })),
        current,
        (value) => {
          // 跟随Obsidian resolves to the CURRENT Obsidian theme at write time
          // (the widget HTML is static once inserted).
          const resolved =
            value === "auto" ? (document.body.classList.contains("theme-dark") ? "dark" : "light") : value;
          this.applyParam("theme", resolved);
        }
      );
    }

    if ("hide_side_toolbar" in config) {
      const shown = !(config.hide_side_toolbar === true || config.hide_side_toolbar === "true" || config.hide_side_toolbar === "1");
      new Setting(pageEl)
        .setName("侧边工具栏")
        .setDesc("显示绘图工具；对应配置字段 hide_side_toolbar。")
        .addToggle((toggle) =>
          toggle.setValue(shown).onChange((value) => {
            this.applyParam("hide_side_toolbar", !value);
          })
        );
    }
  }

  private addSegmented(
    controlEl: HTMLElement,
    options: { value: string; label: string }[],
    current: string,
    onSelect: (value: string) => void
  ) {
    const segmented = controlEl.createDiv("fc-segmented");
    for (const option of options) {
      const item = segmented.createEl("button", {
        cls: `fc-segmented-item${option.value === current ? " is-active" : ""}`,
        text: option.label,
        attr: { type: "button" },
      });
      item.addEventListener("click", () => {
        segmented.querySelectorAll(".fc-segmented-item").forEach((el) => el.classList.remove("is-active"));
        item.classList.add("is-active");
        onSelect(option.value);
      });
    }
  }

  // Writes a param change back into the code textarea (two-way sync).
  private applyParam(key: string, value: unknown) {
    if (!this.parsed?.config) return;
    const nextConfig = { ...this.parsed.config, [key]: value };
    this.code = this.parsed.withConfig(nextConfig);
    this.codeArea?.setValue(this.code);
    // Re-parse so the next edit builds on the rewritten code.
    this.parsed = parseWidgetCode(this.code);
    this.renderPillRow();
  }
}
