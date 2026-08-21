import { App, Modal, Notice, Setting, type TextComponent } from "obsidian";
import type { ChartTheme, SeriesPeriod, SeriesRef, SpreadSpec } from "../types";
import { SeriesRefEditor, type OpenFredPicker, type OpenSymbolPicker } from "./series-ref-editor";
import { parseExpression } from "../modules/expression";
import { appendSvg } from "../utils/dom";
import { addStepper } from "./stepper";
import { DEFAULT_CARD_BLEED, MAX_CARD_BLEED } from "../modules/card-spec";

// 数据计算卡 editor (wireframe #screen-calc, IMPLEMENTATION.md phase 3):
// an arithmetic expression over lettered series (A/B/C… assigned by row
// order). Three sub-pages aligned with the unified card modal — 基础设置
// (expression + series list + range/period/height), 显示设置 (theme, fixed
// line type, width, color), Canvas 逻辑 (宽度/高度自适应, 出血). The
// expression validates on every keystroke: red outline + inline warning hint
// + disabled save button (all three together).
//
// The modal doubles as the insert flow (modal-first: only 保存 creates the
// card) and the in-card editor; the card title is derived from the
// expression, so there is no title field.

const RANGE_OPTIONS: { value: string; label: string }[] = [
  { value: "1y", label: "近1年" },
  { value: "3y", label: "近3年" },
  { value: "5y", label: "近5年" },
  { value: "10y", label: "近10年" },
  { value: "20y", label: "近20年" },
  { value: "max", label: "全部" },
];

const PERIOD_OPTIONS: { value: SeriesPeriod; label: string }[] = [
  { value: "D", label: "日线" },
  { value: "M", label: "月线" },
  { value: "Q", label: "季线" },
  { value: "Y", label: "年线" },
];

const THEME_OPTIONS: { value: ChartTheme; label: string }[] = [
  { value: "auto", label: "跟随 Obsidian 主题" },
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
];

// Matches SERIES_LINE_COLORS[0] in series-chart-renderer.ts; a line color
// equal to it is treated as "default" and not persisted.
const DEFAULT_LINE_COLOR = "#2563eb";

const MAX_SERIES = 26; // single letters A–Z

type SubPage = "basic" | "display" | "canvas";

const SUB_PAGES: { id: SubPage; label: string }[] = [
  { id: "basic", label: "基础设置" },
  { id: "display", label: "显示设置" },
  { id: "canvas", label: "Canvas 逻辑" },
];

// Warning triangle from the wireframe's error hint.
const WARNING_SVG =
  '<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

function letterAt(index: number): string {
  return String.fromCharCode(65 + index);
}

export class SpreadEditModal extends Modal {
  private expression: string;
  private refs: SeriesRef[];
  private range: string;
  private period: SeriesPeriod;
  private height: string;
  private theme: ChartTheme;
  private lineWidth: string;
  private lineColor: string;
  private widthAuto: boolean;
  private heightAuto: boolean;
  private bleed: number;

  private editors: SeriesRefEditor[] = [];
  private activeSubPage: SubPage = "basic";
  private exprText: TextComponent | null = null;
  private errorEl: HTMLElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;
  private heightText: TextComponent | null = null;
  private rowsEl: HTMLElement | null = null;
  private addRowEl: HTMLButtonElement | null = null;

  private onSubmit: (spec: SpreadSpec) => void;
  private openSymbolPicker: OpenSymbolPicker;
  private openFredPicker?: OpenFredPicker;

  constructor(app: App, spec: SpreadSpec, onSubmit: (spec: SpreadSpec) => void, openSymbolPicker: OpenSymbolPicker, openFredPicker?: OpenFredPicker, title?: string) {
    super(app);
    this.expression = spec.expression;
    this.refs = spec.series.map((ref) => ({ ...ref }));
    this.range = RANGE_OPTIONS.some((o) => o.value === spec.range) ? spec.range : "10y";
    this.period = spec.period ?? "D";
    this.height = spec.height ? String(spec.height) : "";
    this.theme = spec.theme ?? "auto";
    this.lineWidth = String(spec.lineWidth ?? 2);
    this.lineColor = spec.lineColor ?? DEFAULT_LINE_COLOR;
    this.widthAuto = spec.widthAuto ?? true;
    this.heightAuto = spec.heightAuto ?? true;
    this.bleed = spec.bleed ?? DEFAULT_CARD_BLEED;
    this.onSubmit = onSubmit;
    this.openSymbolPicker = openSymbolPicker;
    this.openFredPicker = openFredPicker;
    this.setTitle(title ?? "编辑数据计算卡");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.editors = [];
    this.exprText = null;
    this.errorEl = null;
    this.heightText = null;

    const tabBar = contentEl.createDiv("fc-subtabs");
    const pagesEl = contentEl.createDiv();
    const pages: Record<SubPage, HTMLElement> = {
      basic: pagesEl.createDiv(),
      display: pagesEl.createDiv(),
      canvas: pagesEl.createDiv(),
    };
    const applyActive = () => {
      for (const tab of SUB_PAGES) {
        pages[tab.id].classList.toggle("fc-hidden", tab.id !== this.activeSubPage);
      }
      tabBar.querySelectorAll(".fc-subtab").forEach((el, i) => {
        el.classList.toggle("is-active", SUB_PAGES[i].id === this.activeSubPage);
      });
    };
    SUB_PAGES.forEach((tab) => {
      const btn = tabBar.createEl("button", { text: tab.label, cls: "fc-subtab" });
      btn.addEventListener("click", () => {
        this.activeSubPage = tab.id;
        applyActive();
      });
    });
    applyActive();

    this.renderBasicPage(pages.basic);
    this.renderDisplayPage(pages.display);
    this.renderCanvasPage(pages.canvas);

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    this.saveBtn = footer.createEl("button", { text: "保存", cls: "mod-cta" });
    this.saveBtn.addEventListener("click", () => this.save());

    this.revalidateExpression();
  }

  onClose() {
    this.contentEl.empty();
  }

  // ==================== 基础设置 ====================

  private renderBasicPage(pageEl: HTMLElement) {
    pageEl.createDiv({ cls: "fc-field-hint", text: "表达式（使用系列代号 A/B/C...）" });

    const exprSetting = new Setting(pageEl).setName("公式");
    exprSetting.addText((text) => {
      text
        .setPlaceholder("如 A-B、(A+B)/2")
        .setValue(this.expression)
        .onChange((value) => {
          this.expression = value;
          this.revalidateExpression();
        });
      text.inputEl.addClass("fc-mono");
      this.exprText = text;
    });

    // Inline error hint (warning triangle + reason), hidden while valid.
    const errorEl = pageEl.createDiv({ cls: "fc-error-hint fc-calc-expr-error" });
    appendSvg(errorEl.createSpan(), WARNING_SVG);
    errorEl.createSpan();
    errorEl.addClass("fc-hidden");
    this.errorEl = errorEl;

    pageEl.createDiv({
      cls: "fc-field-hint fc-calc-expr-help",
      text: "输入时实时校验：括号配对、运算符位置、系列代号是否已定义。支持 + − × / 和括号，示例：A+B、A/B、(A+B)/2、A+C/B",
    });

    pageEl.createDiv({ cls: "fc-field-hint fc-hint-mt", text: "系列列表" });
    this.rowsEl = pageEl.createDiv("fc-calc-series-rows");
    this.renderSeriesRows();

    this.addRowEl = pageEl.createEl("button", {
      cls: "fc-add-row",
      attr: { type: "button" },
    });
    this.addRowEl.addEventListener("click", () => {
      if (this.refs.length >= MAX_SERIES) return;
      this.refs.push({ source: "macro", seriesId: "m1_yoy" });
      this.renderSeriesRows();
      this.revalidateExpression();
    });
    this.updateAddRow();

    pageEl.createDiv({
      cls: "fc-field-hint",
      text: "系列代号按字母顺序自动分配，删除后自动重排",
    });

    new Setting(pageEl).setName("数据范围").addDropdown((dropdown) => {
      for (const option of RANGE_OPTIONS) {
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.range).onChange((value) => {
        this.range = value;
      });
    });

    new Setting(pageEl).setName("周期").addDropdown((dropdown) => {
      for (const option of PERIOD_OPTIONS) {
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.period).onChange((value) => {
        this.period = value as SeriesPeriod;
      });
    });

    new Setting(pageEl)
      .setName("高度")
      .setDesc("可选，单位 px（200–1600，默认 400）；开启「Canvas 逻辑 → 高度自适应」后此字段失效。")
      .addText((text) => {
        text
          .setPlaceholder("如 400")
          .setValue(this.height)
          .setDisabled(this.heightAuto)
          .onChange((value) => {
            this.height = value.trim();
          });
        text.inputEl.addClass("fc-mono");
        this.heightText = text;
      });
  }

  // Rebuilds the series rows; letters follow row order (A/B/C…).
  private renderSeriesRows() {
    const rowsEl = this.rowsEl;
    if (!rowsEl) return;
    rowsEl.empty();
    this.editors = [];
    this.refs.forEach((ref, index) => {
      const row = rowsEl.createDiv("fc-calc-series-row");
      row.createSpan({ cls: "fc-calc-letter", text: letterAt(index) });
      const editor = new SeriesRefEditor(
        row,
        ref,
        () => {
          this.refs.splice(index, 1);
          this.renderSeriesRows();
          this.updateAddRow();
          this.revalidateExpression();
        },
        false,
        this.openSymbolPicker,
        undefined,
        this.openFredPicker
      );
      this.editors.push(editor);
    });
  }

  private updateAddRow() {
    if (!this.addRowEl) return;
    const full = this.refs.length >= MAX_SERIES;
    this.addRowEl.textContent = full ? "系列数量已达上限" : `+ 新增系列（${letterAt(this.refs.length)}）`;
    this.addRowEl.disabled = full;
  }

  // Live validation: red outline + inline hint + disabled save (三件套).
  private revalidateExpression() {
    const result = parseExpression(this.expression, this.refs.length);
    const invalid = !result.ok && this.expression.trim().length > 0;
    const empty = this.expression.trim().length === 0;
    this.exprText?.inputEl.classList.toggle("fc-input-error", invalid);
    if (this.errorEl) {
      if (invalid) {
        this.errorEl.removeClass("fc-hidden");
      } else {
        this.errorEl.addClass("fc-hidden");
      }
      if (invalid && !result.ok) {
        this.errorEl.lastElementChild!.textContent = `公式错误：${result.error}`;
      }
    }
    if (this.saveBtn) {
      this.saveBtn.disabled = invalid || empty;
    }
  }

  // ==================== 显示设置 ====================

  private renderDisplayPage(pageEl: HTMLElement) {
    new Setting(pageEl).setName("主题").addDropdown((dropdown) => {
      for (const option of THEME_OPTIONS) {
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.theme).onChange((value) => {
        this.theme = value as ChartTheme;
      });
    });

    new Setting(pageEl)
      .setName("图表类型")
      .setDesc("计算结果固定为折线图。")
      .addDropdown((dropdown) => {
        dropdown.addOption("line", "折线 (Line)");
        dropdown.setValue("line");
        dropdown.setDisabled(true);
      });

    new Setting(pageEl)
      .setName("线宽")
      .setDesc("1–4 的整数，单位 px；默认 2。")
      .addText((text) => {
        text
          .setPlaceholder("2")
          .setValue(this.lineWidth)
          .onChange((value) => {
            this.lineWidth = value.trim();
          });
        text.inputEl.addClass("fc-mono");
      });

    new Setting(pageEl).setName("线条颜色").setDesc("默认为蓝色。").addColorPicker((picker) =>
      picker.setValue(this.lineColor).onChange((value) => {
        this.lineColor = value;
      })
    );
  }

  // ==================== Canvas 逻辑 ====================

  private renderCanvasPage(pageEl: HTMLElement) {
    new Setting(pageEl)
      .setName("宽度自适应")
      .setDesc("卡片宽度跟随 Canvas 节点宽度缩放。")
      .addToggle((toggle) =>
        toggle.setValue(this.widthAuto).onChange((value) => {
          this.widthAuto = value;
        })
      );

    new Setting(pageEl)
      .setName("高度自适应")
      .setDesc("开启后跟随节点高度，「基础设置」的高度字段失效。")
      .addToggle((toggle) =>
        toggle.setValue(this.heightAuto).onChange((value) => {
          this.heightAuto = value;
          this.heightText?.setDisabled(value);
        })
      );

    const bleedSetting = new Setting(pageEl)
      .setName("出血尺寸")
      .setDesc("卡片内容与 Canvas 节点边缘的留白。");
    addStepper(bleedSetting.controlEl, {
      get: () => this.bleed,
      set: (value) => {
        this.bleed = value;
      },
      min: 0,
      max: MAX_CARD_BLEED,
      unit: "px",
    });
  }

  // ==================== Save ====================

  private save() {
    const parsed = parseExpression(this.expression, this.refs.length);
    if (!parsed.ok) {
      new Notice(`公式错误：${parsed.error}`);
      return;
    }

    for (let i = 0; i < this.editors.length; i++) {
      const error = this.editors[i].validate();
      if (error) {
        new Notice(`系列 ${letterAt(i)}：${error}`);
        return;
      }
    }

    let height: number | undefined;
    if (this.height) {
      const parsedHeight = Number(this.height);
      if (!Number.isInteger(parsedHeight) || parsedHeight < 200 || parsedHeight > 1600) {
        new Notice("高度应为 200–1600 的整数（单位 px）。");
        return;
      }
      height = parsedHeight;
    }

    const lineWidth = Number(this.lineWidth);
    if (!Number.isInteger(lineWidth) || lineWidth < 1 || lineWidth > 4) {
      new Notice("线宽应为 1–4 的整数（单位 px）。");
      return;
    }

    this.close();
    this.onSubmit({
      series: this.editors.map((editor) => editor.toRef()),
      expression: this.expression.trim(),
      range: this.range,
      period: this.period,
      ...(height !== undefined ? { height } : {}),
      ...(this.theme !== "auto" ? { theme: this.theme } : {}),
      ...(lineWidth !== 2 ? { lineWidth } : {}),
      ...(this.lineColor !== DEFAULT_LINE_COLOR ? { lineColor: this.lineColor } : {}),
      ...(this.widthAuto ? {} : { widthAuto: false }),
      ...(this.heightAuto ? {} : { heightAuto: false }),
      ...(this.bleed === DEFAULT_CARD_BLEED ? {} : { bleed: this.bleed }),
    });
  }
}
