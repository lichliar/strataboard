import { App, Modal, Notice, Setting, setTooltip, type ColorComponent, type TextComponent } from "obsidian";
import type { ChartTheme, CustomSourceDef, DisplayOverrides, SeriesPeriod, SeriesRef, SpreadSpec } from "../types";
import { SeriesRefEditor, type OpenSymbolPicker } from "./series-ref-editor";
import { parseExpression } from "../modules/expression";
import { appendSvg } from "../utils/dom";
import { renderDisplayOverrideSettings } from "./display-overrides";
import { RANGE_OPTIONS, PERIOD_OPTIONS, THEME_OPTIONS } from "../modules/series-summary";
import { createSubTabs } from "./sub-tabs";
import { t } from "../i18n";

// Spread (calc) card editor (wireframe #screen-calc, IMPLEMENTATION.md phase 3):
// an arithmetic expression over lettered series (A/B/C… assigned by row
// order). Two sub-pages via createSubTabs (same pattern as the unified card
// modal): 数据 (expression + quick-template buttons + series list +
// range/period) and 外观 (chart style / 线型 / 线宽 / 线条颜色 / 主题 + the
// 图表设置 collapsible). The expression validates on every keystroke: red
// outline + inline warning hint + disabled save button (all three together).
// A calc card needs at least two series — enforced at save time and by the
// row-delete floor.
//
// The modal doubles as the insert flow (modal-first: only 保存 creates the
// card) and the in-card editor; the card title is derived from the
// expression, so there is no title field.

// Matches SERIES_LINE_COLORS[0] in series-chart-renderer.ts; a line color
// equal to it is treated as "default" and not persisted.
const DEFAULT_LINE_COLOR = "#2563eb";

const MAX_SERIES = 26; // single letters A–Z

// A calc card with fewer than two series has nothing to compute.
const MIN_SERIES = 2;

// Quick-expression templates under the formula box. Pure syntax shortcuts —
// they carry no signal-meaning copy by design.
const EXPRESSION_TEMPLATES = ["A-B", "A/B", "(A/B-1)×100"];

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
  private theme: ChartTheme;
  private lineWidth: string;
  private lineColor: string;
  private style: "line" | "baseline" | "area";
  private lineType: "simple" | "curved" | "steps";
  // Per-card 图表设置 overrides (undefined = follow the plugin-wide 显示设置).
  private displayOverrides: DisplayOverrides;

  private editors: SeriesRefEditor[] = [];
  private exprText: TextComponent | null = null;
  private errorEl: HTMLElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;
  private rowsEl: HTMLElement | null = null;
  private addRowEl: HTMLButtonElement | null = null;

  private onSubmit: (spec: SpreadSpec) => void;
  private openSymbolPicker: OpenSymbolPicker;
  private customSources: CustomSourceDef[];
  // The card's stable id is not edited here but must survive save()
  // rebuilding the spec object.
  private cardId?: string;

  constructor(app: App, spec: SpreadSpec, onSubmit: (spec: SpreadSpec) => void, openSymbolPicker: OpenSymbolPicker, title?: string, customSources?: CustomSourceDef[]) {
    super(app);
    this.cardId = spec.id;
    this.expression = spec.expression;
    this.refs = spec.series.map((ref) => ({ ...ref }));
    this.range = RANGE_OPTIONS.some((o) => o.value === spec.range) ? spec.range : "10y";
    this.period = spec.period ?? "D";
    this.theme = spec.theme ?? "auto";
    this.lineWidth = String(spec.lineWidth ?? 2);
    this.lineColor = spec.lineColor ?? DEFAULT_LINE_COLOR;
    this.style = spec.style ?? "line";
    this.lineType = spec.lineType ?? "simple";
    this.displayOverrides = {
      showLegend: spec.showLegend,
      legendFrosted: spec.legendFrosted,
      legendOpacity: spec.legendOpacity,
      showLatestValue: spec.showLatestValue,
      showPointMarkers: spec.showPointMarkers,
      showGrid: spec.showGrid,
      gridOpacity: spec.gridOpacity,
    };
    this.onSubmit = onSubmit;
    this.openSymbolPicker = openSymbolPicker;
    this.customSources = customSources ?? [];
    this.setTitle(title ?? t("编辑计算卡"));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.editors = [];
    this.exprText = null;
    this.errorEl = null;

    const subTabs = createSubTabs<"data" | "appearance">(
      contentEl,
      [
        { id: "data", label: "数据" },
        { id: "appearance", label: "外观" },
      ]
    );

    this.renderDataPage(subTabs.page("data"));
    this.renderAppearancePage(subTabs.page("appearance"));

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    this.saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    this.saveBtn.addEventListener("click", () => this.save());

    this.revalidateExpression();
  }

  onClose() {
    this.contentEl.empty();
  }

  // ==================== 数据 ====================

  private renderDataPage(pageEl: HTMLElement) {
    pageEl.createDiv({ cls: "fc-field-hint", text: t("表达式（使用系列代号 A/B/C...）") });

    const exprSetting = new Setting(pageEl).setName(t("公式"));
    exprSetting.addText((text) => {
      text
        .setPlaceholder(t("如 A-B、(A+B)/2"))
        .setValue(this.expression)
        .onChange((value) => {
          this.expression = value;
          this.revalidateExpression();
        });
      text.inputEl.addClass("fc-mono");
      this.exprText = text;
    });

    // Quick templates: write the expression into the formula box (setValue
    // does not fire onChange, so update + revalidate explicitly).
    const templatesEl = pageEl.createDiv({ cls: "fc-expr-templates" });
    for (const expr of EXPRESSION_TEMPLATES) {
      const btn = templatesEl.createEl("button", { cls: "fc-expr-template", text: expr, attr: { type: "button" } });
      setTooltip(btn, t("点击填入公式：{expr}", { expr }));
      btn.addEventListener("click", () => {
        this.expression = expr;
        this.exprText?.setValue(expr);
        this.revalidateExpression();
      });
    }

    // Inline error hint (warning triangle + reason), hidden while valid.
    const errorEl = pageEl.createDiv({ cls: "fc-error-hint fc-calc-expr-error" });
    appendSvg(errorEl.createSpan(), WARNING_SVG);
    errorEl.createSpan();
    errorEl.addClass("fc-hidden");
    this.errorEl = errorEl;

    pageEl.createDiv({
      cls: "fc-field-hint fc-calc-expr-help",
      text: t("输入时实时校验：括号配对、运算符位置、系列代号是否已定义。支持 + − × / 和括号，示例：A+B、A/B、(A+B)/2、A+C/B"),
    });

    pageEl.createDiv({ cls: "fc-field-hint fc-hint-mt", text: t("系列列表") });
    this.rowsEl = pageEl.createDiv("fc-calc-series-rows");
    // Fresh cards start with two empty rows bound to the first custom source.
    if (this.refs.length === 0) {
      this.refs.push(this.emptyRef(), this.emptyRef());
    }
    this.renderSeriesRows();

    this.addRowEl = pageEl.createEl("button", {
      cls: "fc-add-row",
      attr: { type: "button" },
    });
    this.addRowEl.addEventListener("click", () => {
      if (this.refs.length >= MAX_SERIES) return;
      this.refs.push(this.emptyRef());
      this.renderSeriesRows();
      this.revalidateExpression();
    });
    this.updateAddRow();

    pageEl.createDiv({
      cls: "fc-field-hint",
      text: t("系列代号按字母顺序自动分配，删除后自动重排"),
    });

    new Setting(pageEl).setName(t("数据范围")).addDropdown((dropdown) => {
      for (const option of RANGE_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.range).onChange((value) => {
        this.range = value;
      });
    });

    new Setting(pageEl).setName(t("周期")).addDropdown((dropdown) => {
      for (const option of PERIOD_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.period).onChange((value) => {
        this.period = value as SeriesPeriod;
      });
    });
  }

  private emptyRef(): SeriesRef {
    return { source: "quote", assetType: "custom", sourceId: this.customSources[0]?.id ?? "" };
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
          if (this.refs.length <= MIN_SERIES) {
            new Notice(t("计算卡至少需要两个数据序列"));
            return;
          }
          this.refs.splice(index, 1);
          this.renderSeriesRows();
          this.updateAddRow();
          this.revalidateExpression();
        },
        false,
        this.openSymbolPicker,
        undefined,
        this.customSources
      );
      this.editors.push(editor);
    });
  }

  private updateAddRow() {
    if (!this.addRowEl) return;
    const full = this.refs.length >= MAX_SERIES;
    this.addRowEl.textContent = full ? t("系列数量已达上限") : t("+ 新增系列（{letter}）", { letter: letterAt(this.refs.length) });
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
        this.errorEl.lastElementChild!.textContent = t("公式错误：{msg}", { msg: t(result.error) });
      }
    }
    if (this.saveBtn) {
      this.saveBtn.disabled = invalid || empty;
    }
  }

  // ==================== 外观 ====================

  private renderAppearancePage(pageEl: HTMLElement) {
    let colorPicker: ColorComponent | null = null;
    new Setting(pageEl)
      .setName(t("图表类型"))
      .setDesc(t("折线为默认样式；基线以 0 轴为界，上方为涨色、下方为跌色的渐变面积；面积为线条颜色向下的渐变填充。"))
      .addDropdown((dropdown) => {
        dropdown.addOption("line", t("折线 (Line)"));
        dropdown.addOption("baseline", t("基线 (Baseline)"));
        dropdown.addOption("area", t("面积 (Area)"));
        dropdown.setValue(this.style);
        dropdown.onChange((value) => {
          this.style = value === "baseline" || value === "area" ? value : "line";
          colorPicker?.setDisabled(this.style === "baseline");
        });
      });

    new Setting(pageEl)
      .setName(t("线型"))
      .setDesc(t("直线为默认；平滑曲线做平滑过渡；阶梯适合利率等离散跳变数据。"))
      .addDropdown((dropdown) => {
        dropdown.addOption("simple", t("直线（默认）"));
        dropdown.addOption("curved", t("平滑曲线"));
        dropdown.addOption("steps", t("阶梯"));
        dropdown.setValue(this.lineType);
        dropdown.onChange((value) => {
          this.lineType = value === "curved" || value === "steps" ? value : "simple";
        });
      });

    new Setting(pageEl)
      .setName(t("线宽"))
      .setDesc(t("1–4 的整数，单位 px；默认 2。"))
      .addText((text) => {
        text
          .setPlaceholder("2")
          .setValue(this.lineWidth)
          .onChange((value) => {
            this.lineWidth = value.trim();
          });
        text.inputEl.addClass("fc-mono");
      });

    new Setting(pageEl)
      .setName(t("线条颜色"))
      .setDesc(t("默认为蓝色；基线样式下不生效（固定为涨/跌色）。"))
      .addColorPicker((picker) => {
        colorPicker = picker;
        picker.setValue(this.lineColor).onChange((value) => {
          this.lineColor = value;
        });
        picker.setDisabled(this.style === "baseline");
      });

    new Setting(pageEl).setName(t("主题")).addDropdown((dropdown) => {
      for (const option of THEME_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.theme).onChange((value) => {
        this.theme = value as ChartTheme;
      });
    });

    // 图表设置 collapsible: per-card overrides of the plugin-wide 显示设置.
    const chartDetails = pageEl.createEl("details", { cls: "fc-settings-sub" });
    chartDetails.createEl("summary", { text: t("图表设置（覆盖全局）") });
    renderDisplayOverrideSettings(chartDetails, this.displayOverrides, { series: true });
  }

  // ==================== Save ====================

  private save() {
    if (this.refs.length < MIN_SERIES) {
      new Notice(t("计算卡至少需要两个数据序列"));
      return;
    }

    const parsed = parseExpression(this.expression, this.refs.length);
    if (!parsed.ok) {
      new Notice(t("公式错误：{msg}", { msg: t(parsed.error) }));
      return;
    }

    for (let i = 0; i < this.editors.length; i++) {
      const error = this.editors[i].validate();
      if (error) {
        new Notice(t("系列 {letter}：{msg}", { letter: letterAt(i), msg: error }));
        return;
      }
    }

    const lineWidth = Number(this.lineWidth);
    if (!Number.isInteger(lineWidth) || lineWidth < 1 || lineWidth > 4) {
      new Notice(t("线宽应为 1–4 的整数（单位 px）。"));
      return;
    }

    this.close();
    this.onSubmit({
      ...(this.cardId ? { id: this.cardId } : {}),
      series: this.editors.map((editor) => editor.toRef()),
      expression: this.expression.trim(),
      range: this.range,
      period: this.period,
      ...(this.theme !== "auto" ? { theme: this.theme } : {}),
      ...(lineWidth !== 2 ? { lineWidth } : {}),
      ...(this.lineColor !== DEFAULT_LINE_COLOR ? { lineColor: this.lineColor } : {}),
      ...(this.lineType !== "simple" ? { lineType: this.lineType } : {}),
      ...(this.style !== "line" ? { style: this.style } : {}),
      // 图表设置 overrides: undefined fields are dropped by the serializer.
      ...this.displayOverrides,
    });
  }
}
