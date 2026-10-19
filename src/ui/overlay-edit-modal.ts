import { App, Modal, Notice, Setting } from "obsidian";
import type { ChartTheme, CustomSourceDef, DisplayOverrides, OverlayCompareMode, OverlaySpec, SeriesLineType, SeriesPeriod, SeriesRef } from "../types";
import { SeriesRefEditor, type ListReferenceableCards, type OpenSymbolPicker } from "./series-ref-editor";
import { SeriesAdapter } from "../modules/series-adapter";
import { renderDisplayOverrideSettings } from "./display-overrides";
import { MAX_OVERLAY_SERIES } from "../modules/series-spec";
import { RANGE_OPTIONS, PERIOD_OPTIONS, THEME_OPTIONS } from "../modules/series-summary";
import { createSubTabs } from "./sub-tabs";
import { t } from "../i18n";

// Overlay (compare) card editor (wireframe #screen-overlay). Two sub-pages
// via createSubTabs (same pattern as the unified card modal): 数据 (series
// rows + 周期 / 数据范围 / 叠加方式 compare mode + per-series 缩放系数
// mirror rows) and 外观 (fixed line type / 线型 / 主题 + the 图表设置
// collapsible). A compare card needs at least two series — enforced at save
// time and by the row-delete floor. No expression input, so no error states
// beyond that — invalid rows are reported via Notice at save time.

const COMPARE_MODE_OPTIONS: { value: OverlayCompareMode; label: string }[] = [
  { value: "percent", label: "百分比归一化（默认）" },
  { value: "zscore", label: "标准化（Z-score）" },
  { value: "axis", label: "独立纵轴" },
  { value: "none", label: "原始值" },
];

// A compare card with fewer than two series has nothing to compare.
const MIN_SERIES = 2;

export class OverlayEditModal extends Modal {
  private initialSeries: SeriesRef[];
  private range: string;
  private period: SeriesPeriod;
  private compareMode: OverlayCompareMode;
  private lineType: SeriesLineType;
  // Raw text of the per-series 缩放系数 inputs (indexed like the series rows);
  // empty = 1. Parsed and validated at save time.
  private scaleInputs: string[];
  private theme: ChartTheme;
  // Per-card 图表设置 overrides (undefined = follow the plugin-wide 显示设置).
  private displayOverrides: DisplayOverrides;
  private editors: SeriesRefEditor[] = [];
  private rowsEl: HTMLElement | null = null;
  private addRowEl: HTMLButtonElement | null = null;
  private scaleRowsEl: HTMLElement | null = null;
  private onSubmit: (spec: OverlaySpec) => void;
  private openSymbolPicker: OpenSymbolPicker;
  private listReferenceableCards: ListReferenceableCards;
  private customSources: CustomSourceDef[];
  // Sync display-name resolver for series refs (card refs resolve through the
  // card index's warm map). Defaults to label-or-code when not provided.
  private resolveSeriesName: (ref: SeriesRef) => string;

  constructor(
    app: App,
    spec: OverlaySpec,
    onSubmit: (spec: OverlaySpec) => void,
    openSymbolPicker: OpenSymbolPicker,
    listReferenceableCards: ListReferenceableCards,
    title?: string,
    customSources?: CustomSourceDef[],
    resolveSeriesName?: (ref: SeriesRef) => string
  ) {
    super(app);
    this.initialSeries = spec.series;
    this.range = RANGE_OPTIONS.some((o) => o.value === spec.range) ? spec.range : "10y";
    this.period = spec.period ?? "D";
    this.compareMode = spec.normalize ?? "percent";
    this.lineType = spec.lineType ?? "simple";
    this.scaleInputs = spec.series.map((ref) => (ref.scale !== undefined ? String(ref.scale) : ""));
    this.theme = spec.theme ?? "auto";
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
    this.listReferenceableCards = listReferenceableCards;
    this.customSources = customSources ?? [];
    this.resolveSeriesName = resolveSeriesName ?? ((ref) => ref.label || SeriesAdapter.defaultLabel(ref));
    this.setTitle(title ?? t("编辑对比卡"));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.editors = [];
    this.rowsEl = null;
    this.addRowEl = null;

    // The 缩放系数 rows mirror the series list; onActivate rebuilds them
    // whenever the data page becomes visible so row edits show up (the
    // initial fire lands before scaleRowsEl exists and is a no-op).
    const subTabs = createSubTabs<"data" | "appearance">(
      contentEl,
      [
        { id: "data", label: "数据" },
        { id: "appearance", label: "外观" },
      ],
      {
        onActivate: (id) => {
          if (id === "data") this.renderScaleRows();
        },
      }
    );

    this.renderDataPage(subTabs.page("data"));
    this.renderAppearancePage(subTabs.page("appearance"));

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
  }

  onClose() {
    this.contentEl.empty();
  }

  // ==================== 数据 ====================

  private renderDataPage(pageEl: HTMLElement) {
    pageEl.createDiv({
      cls: "fc-field-hint fc-hint-mb",
      text: t("至少两个系列（最多 {max} 个）；行情类系列按区间首个数据点归一化为涨跌幅（%）。", { max: MAX_OVERLAY_SERIES }),
    });
    this.rowsEl = pageEl.createDiv({ cls: "fc-calc-series-rows" });
    for (const ref of this.initialSeries) {
      this.addRow(ref);
    }
    // Fresh cards start with two empty rows bound to the first custom source.
    if (this.initialSeries.length === 0) {
      this.addRow();
      this.addRow();
    }
    this.addRowEl = pageEl.createEl("button", { cls: "fc-add-row", text: t("+ 添加系列"), attr: { type: "button" } });
    this.addRowEl.addEventListener("click", () => this.addRow());
    this.updateAddRow();

    new Setting(pageEl).setName(t("周期")).addDropdown((dropdown) => {
      for (const option of PERIOD_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.period).onChange((value) => {
        this.period = value as SeriesPeriod;
      });
    });

    new Setting(pageEl).setName(t("数据范围")).addDropdown((dropdown) => {
      for (const option of RANGE_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.range).onChange((value) => {
        this.range = value;
      });
    });

    new Setting(pageEl)
      .setName(t("叠加方式"))
      .setDesc(
        t(
          "多序列同图对比的缩放方式：百分比归一化按区间首点折算涨跌幅；标准化（Z-score）将各序列转为 z 分数做等波动率形态对比；独立纵轴让每条序列占满图高；原始值不缩放。"
        )
      )
      .addDropdown((dropdown) => {
        for (const option of COMPARE_MODE_OPTIONS) {
          dropdown.addOption(option.value, t(option.label));
        }
        dropdown.setValue(this.compareMode).onChange((value) => {
          this.compareMode = value as OverlayCompareMode;
          this.renderScaleRows();
        });
      });

    // 缩放系数 rows are (re)built by renderScaleRows — on open and whenever
    // the data tab is activated, so series-row edits are reflected.
    this.scaleRowsEl = pageEl.createDiv();
    this.renderScaleRows();
  }

  private addRow(initial?: SeriesRef) {
    if (this.editors.length >= MAX_OVERLAY_SERIES) return;
    const editor = new SeriesRefEditor(
      this.rowsEl!,
      initial ?? { source: "quote", assetType: "custom", sourceId: this.customSources[0]?.id ?? "" },
      () => {
        if (this.editors.length <= MIN_SERIES) {
          new Notice(t("对比卡至少需要两个数据序列"));
          return;
        }
        const index = this.editors.indexOf(editor);
        if (index >= 0) this.scaleInputs.splice(index, 1);
        this.editors = this.editors.filter((e) => e !== editor);
        editor.el.remove();
        this.updateAddRow();
      },
      true,
      this.openSymbolPicker,
      this.listReferenceableCards,
      this.customSources
    );
    this.editors.push(editor);
    this.updateAddRow();
  }

  private updateAddRow() {
    if (!this.addRowEl) return;
    const full = this.editors.length >= MAX_OVERLAY_SERIES;
    this.addRowEl.textContent = full ? t("系列数量已达上限") : t("+ 添加系列");
    this.addRowEl.disabled = full;
  }

  // One coefficient input per series row, labeled with the row's current
  // name. The factor is a pure visual multiplier on the plotted values; it is
  // meaningless in 独立纵轴 (own auto-fitted axis) and 标准化 (scale-invariant)
  // modes, so the inputs are disabled there.
  private renderScaleRows() {
    const el = this.scaleRowsEl;
    if (!el) return;
    el.empty();
    if (this.editors.length === 0) return;
    const enabled = this.compareMode === "percent" || this.compareMode === "none";
    const group = el.createDiv("fc-canvas-logic-group");
    group.createDiv({ cls: "fc-canvas-logic-title", text: t("缩放系数") });
    group.createDiv({
      cls: "fc-field-hint fc-hint-mb",
      text: enabled
        ? t("对每条序列的绘制值乘以系数（留空为 1），用于放大低波动序列的视觉振幅；仅为视觉对比，不改动数据。")
        : t("当前叠加方式下缩放系数不生效（仅百分比归一化 / 原始值可用）。"),
    });
    this.editors.forEach((editor, i) => {
      const ref = editor.toRef();
      const name = this.resolveSeriesName(ref) || `${i + 1}`;
      new Setting(group).setName(`${i + 1}. ${name}`).addText((text) => {
        text
          .setPlaceholder("1")
          .setValue(this.scaleInputs[i] ?? "")
          .setDisabled(!enabled)
          .onChange((value) => {
            this.scaleInputs[i] = value;
          });
        text.inputEl.addClass("fc-mono");
      });
    });
  }

  // ==================== 外观 ====================

  private renderAppearancePage(pageEl: HTMLElement) {
    new Setting(pageEl)
      .setName(t("图表类型"))
      .setDesc(t("叠加对比固定为折线图。"))
      .addDropdown((dropdown) => {
        dropdown.addOption("line", t("折线 (Line)"));
        dropdown.setValue("line");
        dropdown.setDisabled(true);
      });

    new Setting(pageEl)
      .setName(t("线型"))
      .setDesc(t("直线为默认；平滑曲线做平滑过渡；阶梯适合利率等离散跳变数据。作用于卡内所有折线。"))
      .addDropdown((dropdown) => {
        dropdown.addOption("simple", t("直线（默认）"));
        dropdown.addOption("curved", t("平滑曲线"));
        dropdown.addOption("steps", t("阶梯"));
        dropdown.setValue(this.lineType);
        dropdown.onChange((value) => {
          this.lineType = value === "curved" || value === "steps" ? value : "simple";
        });
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
    if (this.editors.length < MIN_SERIES) {
      new Notice(t("对比卡至少需要两个数据序列"));
      return;
    }
    const series: SeriesRef[] = [];
    for (let i = 0; i < this.editors.length; i++) {
      const editor = this.editors[i];
      const error = editor.validate();
      if (error) {
        new Notice(error);
        return;
      }
      const ref = editor.toRef();
      const rawScale = (this.scaleInputs[i] ?? "").trim();
      if (rawScale) {
        const name = this.resolveSeriesName(ref) || `${i + 1}`;
        const scale = Number(rawScale);
        if (!Number.isFinite(scale) || scale === 0) {
          new Notice(t("缩放系数「{name}」应为非零数字。", { name }));
          return;
        }
        if (scale !== 1) {
          ref.scale = scale;
        }
      }
      series.push(ref);
    }

    this.close();
    this.onSubmit({
      series,
      range: this.range,
      period: this.period,
      normalize: this.compareMode,
      ...(this.lineType !== "simple" ? { lineType: this.lineType } : {}),
      ...(this.theme !== "auto" ? { theme: this.theme } : {}),
      // 图表设置 overrides: undefined fields are dropped by the serializer.
      ...this.displayOverrides,
    });
  }
}
