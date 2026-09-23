import { App, Modal, Notice, Setting, type TextComponent } from "obsidian";
import type { ChartTheme, CustomSourceDef, DisplayOverrides, OverlayCompareMode, OverlaySpec, SeriesPeriod, SeriesRef } from "../types";
import { SeriesRefEditor, type ListSpreadCards, type OpenFredPicker, type OpenSymbolPicker, type SeriesSourceAvailability } from "./series-ref-editor";
import { SeriesAdapter } from "../modules/series-adapter";
import { addStepper } from "./stepper";
import { renderDisplayOverrideSettings } from "./display-overrides";
import { DEFAULT_CARD_BLEED, MAX_CARD_BLEED } from "../modules/card-spec";
import { MAX_OVERLAY_SERIES } from "../modules/series-spec";
import { t } from "../i18n";

// Overlay (资产叠加) card editor (wireframe #screen-overlay). Three sub-pages
// matching the unified/calc modals: 系列编辑 (dynamic series rows), 数据设置
// (range / period / 叠加方式 compare mode + per-series 缩放系数 / height),
// 显示设置 (主题 / fixed line type + the Canvas 显示逻辑 group). No expression
// input, so no error states — invalid rows are reported via Notice at save
// time.

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

const COMPARE_MODE_OPTIONS: { value: OverlayCompareMode; label: string }[] = [
  { value: "percent", label: "百分比归一化（默认）" },
  { value: "zscore", label: "标准化（Z-score）" },
  { value: "axis", label: "独立纵轴" },
  { value: "none", label: "原始值" },
];

type SubPage = "series" | "data" | "display";

const SUB_PAGES: { id: SubPage; label: string }[] = [
  { id: "series", label: "系列编辑" },
  { id: "data", label: "数据设置" },
  { id: "display", label: "显示设置" },
];

export class OverlayEditModal extends Modal {
  private initialSeries: SeriesRef[];
  private range: string;
  private period: SeriesPeriod;
  private compareMode: OverlayCompareMode;
  // Raw text of the per-series 缩放系数 inputs (indexed like the series rows);
  // empty = 1. Parsed and validated at save time.
  private scaleInputs: string[];
  private height: string;
  private theme: ChartTheme;
  private widthAuto: boolean;
  private heightAuto: boolean;
  private bleed: number;
  // Per-card 图表显示 overrides (undefined = follow the plugin-wide 显示设置).
  private displayOverrides: DisplayOverrides;
  private editors: SeriesRefEditor[] = [];
  private rowsEl: HTMLElement | null = null;
  private addRowEl: HTMLButtonElement | null = null;
  private heightText: TextComponent | null = null;
  private scaleRowsEl: HTMLElement | null = null;
  private activeSubPage: SubPage = "series";
  private onSubmit: (spec: OverlaySpec) => void;
  private openSymbolPicker: OpenSymbolPicker;
  private listSpreadCards: ListSpreadCards;
  private openFredPicker?: OpenFredPicker;
  private customSources: CustomSourceDef[];
  private sourceAvailability: SeriesSourceAvailability;

  constructor(
    app: App,
    spec: OverlaySpec,
    onSubmit: (spec: OverlaySpec) => void,
    openSymbolPicker: OpenSymbolPicker,
    listSpreadCards: ListSpreadCards,
    openFredPicker?: OpenFredPicker,
    title?: string,
    customSources?: CustomSourceDef[],
    sourceAvailability?: SeriesSourceAvailability
  ) {
    super(app);
    this.initialSeries = spec.series;
    this.range = RANGE_OPTIONS.some((o) => o.value === spec.range) ? spec.range : "10y";
    this.period = spec.period ?? "D";
    this.compareMode = spec.normalize ?? "percent";
    this.scaleInputs = spec.series.map((ref) => (ref.scale !== undefined ? String(ref.scale) : ""));
    this.height = spec.height ? String(spec.height) : "";
    this.theme = spec.theme ?? "auto";
    this.widthAuto = spec.widthAuto ?? true;
    this.heightAuto = spec.heightAuto ?? true;
    this.bleed = spec.bleed ?? DEFAULT_CARD_BLEED;
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
    this.listSpreadCards = listSpreadCards;
    this.openFredPicker = openFredPicker;
    this.customSources = customSources ?? [];
    this.sourceAvailability = sourceAvailability ?? { hasTushare: true, hasFred: true };
    this.setTitle(title ?? t("编辑资产叠加卡"));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.editors = [];
    this.rowsEl = null;
    this.addRowEl = null;
    this.heightText = null;

    const tabBar = contentEl.createDiv("fc-subtabs");
    const pagesEl = contentEl.createDiv();
    const pages: Record<SubPage, HTMLElement> = {
      series: pagesEl.createDiv(),
      data: pagesEl.createDiv(),
      display: pagesEl.createDiv(),
    };
    const applyActive = () => {
      for (const tab of SUB_PAGES) {
        pages[tab.id].classList.toggle("fc-hidden", tab.id !== this.activeSubPage);
      }
      tabBar.querySelectorAll(".fc-subtab").forEach((el, i) => {
        el.classList.toggle("is-active", SUB_PAGES[i].id === this.activeSubPage);
      });
      // The 缩放系数 rows mirror the series list; rebuild them whenever the
      // data page becomes visible so row edits on the series page show up.
      if (this.activeSubPage === "data") {
        this.renderScaleRows();
      }
    };
    SUB_PAGES.forEach((tab) => {
      const btn = tabBar.createEl("button", { text: t(tab.label), cls: "fc-subtab" });
      btn.addEventListener("click", () => {
        this.activeSubPage = tab.id;
        applyActive();
      });
    });
    applyActive();

    this.renderSeriesPage(pages.series);
    this.renderDataPage(pages.data);
    this.renderDisplayPage(pages.display);

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
  }

  onClose() {
    this.contentEl.empty();
  }

  // ==================== 系列编辑 ====================

  private renderSeriesPage(pageEl: HTMLElement) {
    pageEl.createDiv({
      cls: "fc-field-hint fc-hint-mb",
      text: t("至少一个系列（最多 {max} 个）；行情类系列按区间首个数据点归一化为涨跌幅（%）。", { max: MAX_OVERLAY_SERIES }),
    });
    this.rowsEl = pageEl.createDiv({ cls: "fc-calc-series-rows" });
    for (const ref of this.initialSeries) {
      this.addRow(ref);
    }
    this.addRowEl = pageEl.createEl("button", { cls: "fc-add-row", text: t("+ 添加系列"), attr: { type: "button" } });
    this.addRowEl.addEventListener("click", () => this.addRow());
    this.updateAddRow();
  }

  private addRow(initial?: SeriesRef) {
    if (this.editors.length >= MAX_OVERLAY_SERIES) return;
    const editor = new SeriesRefEditor(
      this.rowsEl!,
      initial ?? { source: "macro", seriesId: "m1_yoy" },
      () => {
        if (this.editors.length <= 1) {
          new Notice(t("至少保留一个数据系列。"));
          return;
        }
        this.editors = this.editors.filter((e) => e !== editor);
        editor.el.remove();
        this.updateAddRow();
      },
      true,
      this.openSymbolPicker,
      this.listSpreadCards,
      this.openFredPicker,
      this.customSources,
      this.sourceAvailability
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

  // ==================== 数据设置 ====================

  private renderDataPage(pageEl: HTMLElement) {
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

    new Setting(pageEl)
      .setName(t("高度"))
      .setDesc(t("可选，单位 px（200–1600，默认 400）；开启「显示设置 → 高度自适应」后此字段失效。"))
      .addText((text) => {
        text
          .setPlaceholder(t("如 400"))
          .setValue(this.height)
          .setDisabled(this.heightAuto)
          .onChange((value) => {
            this.height = value.trim();
          });
        text.inputEl.addClass("fc-mono");
        this.heightText = text;
      });
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
      const name = ref.label || SeriesAdapter.defaultLabel(ref) || `${i + 1}`;
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

  // ==================== 显示设置 ====================

  private renderDisplayPage(pageEl: HTMLElement) {
    new Setting(pageEl).setName(t("主题")).addDropdown((dropdown) => {
      for (const option of THEME_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.theme).onChange((value) => {
        this.theme = value as ChartTheme;
      });
    });

    new Setting(pageEl)
      .setName(t("图表类型"))
      .setDesc(t("叠加对比固定为折线图。"))
      .addDropdown((dropdown) => {
        dropdown.addOption("line", t("折线 (Line)"));
        dropdown.setValue("line");
        dropdown.setDisabled(true);
      });

    // Canvas 显示逻辑 group (same pattern as the unified edit modal).
    const group = pageEl.createDiv("fc-canvas-logic-group");
    group.createDiv({ cls: "fc-canvas-logic-title", text: t("Canvas 显示逻辑") });

    new Setting(group)
      .setName(t("宽度自适应"))
      .setDesc(t("卡片宽度跟随 Canvas 节点宽度缩放。"))
      .addToggle((toggle) =>
        toggle.setValue(this.widthAuto).onChange((value) => {
          this.widthAuto = value;
        })
      );

    new Setting(group)
      .setName(t("高度自适应"))
      .setDesc(t("开启后跟随节点高度，「数据设置」的高度字段失效。"))
      .addToggle((toggle) =>
        toggle.setValue(this.heightAuto).onChange((value) => {
          this.heightAuto = value;
          this.heightText?.setDisabled(value);
        })
      );

    const bleedSetting = new Setting(group)
      .setName(t("出血尺寸"))
      .setDesc(t("卡片内容与 Canvas 节点边缘的留白。"));
    addStepper(bleedSetting.controlEl, {
      get: () => this.bleed,
      set: (value) => {
        this.bleed = value;
      },
      min: 0,
      max: MAX_CARD_BLEED,
      unit: "px",
    });

    // Per-card overrides of the plugin-wide 显示设置.
    renderDisplayOverrideSettings(pageEl, this.displayOverrides, { series: true });
  }

  // ==================== Save ====================

  private save() {
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
        const name = ref.label || SeriesAdapter.defaultLabel(ref) || `${i + 1}`;
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
    if (series.length === 0) {
      new Notice(t("至少保留一个数据系列。"));
      return;
    }

    let height: number | undefined;
    if (this.height) {
      const parsed = Number(this.height);
      if (!Number.isInteger(parsed) || parsed < 200 || parsed > 1600) {
        new Notice(t("高度应为 200–1600 的整数（单位 px）。"));
        return;
      }
      height = parsed;
    }

    this.close();
    this.onSubmit({
      series,
      range: this.range,
      period: this.period,
      normalize: this.compareMode,
      ...(height !== undefined ? { height } : {}),
      ...(this.theme !== "auto" ? { theme: this.theme } : {}),
      ...(this.widthAuto ? {} : { widthAuto: false }),
      ...(this.heightAuto ? {} : { heightAuto: false }),
      ...(this.bleed === DEFAULT_CARD_BLEED ? {} : { bleed: this.bleed }),
      // 图表显示 overrides: undefined fields are dropped by the serializer.
      ...this.displayOverrides,
    });
  }
}
