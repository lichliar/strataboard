import { App, Modal, Notice, Setting, type TextComponent } from "obsidian";
import type { ChartTheme, OverlaySpec, SeriesPeriod, SeriesRef } from "../types";
import { SeriesRefEditor, type ListSpreadCards, type OpenFredPicker, type OpenSymbolPicker } from "./series-ref-editor";
import { addStepper } from "./stepper";
import { DEFAULT_CARD_BLEED, MAX_CARD_BLEED } from "../modules/card-spec";

// Overlay (资产叠加) card editor (wireframe #screen-overlay). Three sub-pages
// matching the unified/calc modals: 系列编辑 (dynamic series rows), 数据设置
// (range / period / height), 显示设置 (标准化 / 主题 / fixed line type +
// the Canvas 显示逻辑 group). No expression input, so no error states —
// invalid rows are reported via Notice at save time.

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
  private normalize: boolean;
  private height: string;
  private theme: ChartTheme;
  private widthAuto: boolean;
  private heightAuto: boolean;
  private bleed: number;
  private editors: SeriesRefEditor[] = [];
  private rowsEl: HTMLElement | null = null;
  private heightText: TextComponent | null = null;
  private activeSubPage: SubPage = "series";
  private onSubmit: (spec: OverlaySpec) => void;
  private openSymbolPicker: OpenSymbolPicker;
  private listSpreadCards: ListSpreadCards;
  private openFredPicker?: OpenFredPicker;

  constructor(
    app: App,
    spec: OverlaySpec,
    onSubmit: (spec: OverlaySpec) => void,
    openSymbolPicker: OpenSymbolPicker,
    listSpreadCards: ListSpreadCards,
    openFredPicker?: OpenFredPicker,
    title?: string
  ) {
    super(app);
    this.initialSeries = spec.series;
    this.range = RANGE_OPTIONS.some((o) => o.value === spec.range) ? spec.range : "10y";
    this.period = spec.period ?? "D";
    this.normalize = spec.normalize !== false;
    this.height = spec.height ? String(spec.height) : "";
    this.theme = spec.theme ?? "auto";
    this.widthAuto = spec.widthAuto ?? true;
    this.heightAuto = spec.heightAuto ?? true;
    this.bleed = spec.bleed ?? DEFAULT_CARD_BLEED;
    this.onSubmit = onSubmit;
    this.openSymbolPicker = openSymbolPicker;
    this.listSpreadCards = listSpreadCards;
    this.openFredPicker = openFredPicker;
    this.setTitle(title ?? "编辑资产叠加卡");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.editors = [];
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
        pages[tab.id].style.display = tab.id === this.activeSubPage ? "" : "none";
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

    this.renderSeriesPage(pages.series);
    this.renderDataPage(pages.data);
    this.renderDisplayPage(pages.display);

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: "保存", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
  }

  onClose() {
    this.contentEl.empty();
  }

  // ==================== 系列编辑 ====================

  private renderSeriesPage(pageEl: HTMLElement) {
    pageEl.createDiv({
      cls: "fc-field-hint",
      text: "至少一个系列；行情类系列按区间首个数据点归一化为涨跌幅（%）。",
    }).style.marginBottom = "8px";
    this.rowsEl = pageEl.createDiv({ cls: "fc-calc-series-rows" });
    for (const ref of this.initialSeries) {
      this.addRow(ref);
    }
    const addBtn = pageEl.createEl("button", { cls: "fc-add-row", text: "+ 添加系列", attr: { type: "button" } });
    addBtn.addEventListener("click", () => this.addRow());
  }

  private addRow(initial?: SeriesRef) {
    const editor = new SeriesRefEditor(
      this.rowsEl!,
      initial ?? { source: "macro", seriesId: "m1_yoy" },
      () => {
        if (this.editors.length <= 1) {
          new Notice("至少保留一个数据系列。");
          return;
        }
        this.editors = this.editors.filter((e) => e !== editor);
        editor.el.remove();
      },
      true,
      this.openSymbolPicker,
      this.listSpreadCards,
      this.openFredPicker
    );
    this.editors.push(editor);
  }

  // ==================== 数据设置 ====================

  private renderDataPage(pageEl: HTMLElement) {
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
      .setDesc("可选，单位 px（200–1600，默认 400）；开启「显示设置 → 高度自适应」后此字段失效。")
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

  // ==================== 显示设置 ====================

  private renderDisplayPage(pageEl: HTMLElement) {
    new Setting(pageEl)
      .setName("标准化")
      .setDesc("以首条系列起点为 100% 基准，将行情类序列折算为涨跌幅（%）。")
      .addToggle((toggle) =>
        toggle.setValue(this.normalize).onChange((value) => {
          this.normalize = value;
        })
      );

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
      .setDesc("叠加对比固定为折线图。")
      .addDropdown((dropdown) => {
        dropdown.addOption("line", "折线 (Line)");
        dropdown.setValue("line");
        dropdown.setDisabled(true);
      });

    // Canvas 显示逻辑 group (same pattern as the unified edit modal).
    const group = pageEl.createDiv("fc-canvas-logic-group");
    group.createDiv({ cls: "fc-canvas-logic-title", text: "Canvas 显示逻辑" });

    new Setting(group)
      .setName("宽度自适应")
      .setDesc("卡片宽度跟随 Canvas 节点宽度缩放。")
      .addToggle((toggle) =>
        toggle.setValue(this.widthAuto).onChange((value) => {
          this.widthAuto = value;
        })
      );

    new Setting(group)
      .setName("高度自适应")
      .setDesc("开启后跟随节点高度，「数据设置」的高度字段失效。")
      .addToggle((toggle) =>
        toggle.setValue(this.heightAuto).onChange((value) => {
          this.heightAuto = value;
          this.heightText?.setDisabled(value);
        })
      );

    const bleedSetting = new Setting(group)
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
    const series: SeriesRef[] = [];
    for (const editor of this.editors) {
      const error = editor.validate();
      if (error) {
        new Notice(error);
        return;
      }
      series.push(editor.toRef());
    }
    if (series.length === 0) {
      new Notice("至少保留一个数据系列。");
      return;
    }

    let height: number | undefined;
    if (this.height) {
      const parsed = Number(this.height);
      if (!Number.isInteger(parsed) || parsed < 200 || parsed > 1600) {
        new Notice("高度应为 200–1600 的整数（单位 px）。");
        return;
      }
      height = parsed;
    }

    this.close();
    this.onSubmit({
      series,
      range: this.range,
      period: this.period,
      normalize: this.normalize,
      ...(height !== undefined ? { height } : {}),
      ...(this.theme !== "auto" ? { theme: this.theme } : {}),
      ...(this.widthAuto ? {} : { widthAuto: false }),
      ...(this.heightAuto ? {} : { heightAuto: false }),
      ...(this.bleed === DEFAULT_CARD_BLEED ? {} : { bleed: this.bleed }),
    });
  }
}
