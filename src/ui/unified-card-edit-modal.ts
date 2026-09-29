import { App, Modal, Notice, Setting, type DropdownComponent, type TextComponent } from "obsidian";
import {
  type ChartTheme,
  type ChartType,
  type CustomSourceDef,
  type DisplayOverrides,
  type Freq,
  type ParsedCardSpec,
  type RangePreset,
  type SymbolItem,
  type VisibleRangePreset,
} from "../types";
import { isDateRangeString } from "../utils/date";
import {
  DEFAULT_CARD_BLEED,
  DEFAULT_CARD_HEIGHT,
  MAX_CARD_BLEED,
  MAX_CARD_HEIGHT,
  MIN_CARD_HEIGHT,
} from "../modules/card-spec";
import { MA_COLORS } from "../modules/chart-renderer";
import { addStepper } from "./stepper";
import { renderDisplayOverrideSettings } from "./display-overrides";
import { t } from "../i18n";

// Unified asset-card editor (wireframe #screen-unified): one modal for quote
// cards backed by a custom data source. Top-level tabs: 数据源 (custom-source
// selector) + 基础设置 / 显示设置 / 均线系统.

export interface UnifiedCardEditModalOptions {
  /** Resolved spec of the card being edited; absent = fresh card. */
  spec?: ParsedCardSpec;
  /** Symbol picker bound to the current custom source. */
  openSymbolPicker: (onSelect: (item: SymbolItem) => void, sourceId?: string) => void;
  /** Enabled custom sources, listed in the source grid. */
  customSources: CustomSourceDef[];
  onSubmit: (spec: ParsedCardSpec) => void;
}

const FREQ_OPTIONS: { value: Freq; label: string }[] = [
  { value: "D", label: "日K" },
  { value: "W", label: "周K" },
  { value: "M", label: "月K" },
];

const RANGE_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: "1y", label: "近1年" },
  { value: "3y", label: "近3年" },
  { value: "5y", label: "近5年" },
  { value: "ytd", label: "年初至今" },
  { value: "max", label: "全部" },
];

const VISIBLE_RANGE_OPTIONS: { value: VisibleRangePreset | ""; label: string }[] = [
  { value: "", label: "默认（全部数据）" },
  { value: "1m", label: "近1月" },
  { value: "3m", label: "近3月" },
  { value: "6m", label: "近6月" },
  { value: "1y", label: "近1年" },
  { value: "ytd", label: "年初至今" },
  { value: "max", label: "全部" },
];

const THEME_OPTIONS: { value: ChartTheme; label: string }[] = [
  { value: "auto", label: "跟随 Obsidian 主题" },
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
];

const CHART_TYPE_OPTIONS: { value: ChartType; label: string }[] = [
  { value: "candlestick", label: "K线 (Candlestick)" },
  { value: "line", label: "折线 (Line)" },
];

const RANGE_PRESET_VALUES = RANGE_OPTIONS.map((o) => o.value as string);

// Earliest year offered by the custom date-range pickers; matches the
// earliest data "max" resolves to in resolveDateRange().
const MIN_RANGE_YEAR = 1990;

type TopTab = "source" | "basic" | "display" | "ma";

interface DateParts {
  y: number;
  m: number;
  d: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateParts(parts: DateParts): string {
  return `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`;
}

function isValidDateParts(parts: DateParts): boolean {
  const date = new Date(parts.y, parts.m - 1, parts.d);
  return date.getFullYear() === parts.y && date.getMonth() === parts.m - 1 && date.getDate() === parts.d;
}

function parseDateParts(iso: string): DateParts {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

function parsePaneRatios(raw: string): number[] | null {
  const parts = raw
    .split(/[,，/]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
  if (parts.length < 2) return null;
  if (parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return parts;
}

const MAX_MA_PERIODS = 8;

// MA periods must be positive integers; dedupe, sort ascending, cap the count.
function parseMaPeriods(raw: string): number[] | null {
  const parts = raw
    .split(/[,，、/\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
  if (parts.length === 0) return null;
  if (parts.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  return [...new Set(parts)].sort((a, b) => a - b).slice(0, MAX_MA_PERIODS);
}

export class UnifiedCardEditModal extends Modal {
  private readonly options: UnifiedCardEditModalOptions;

  // ---- Form state ----
  private symbol: string;
  private customSourceId: string | undefined;
  private freq: Freq;
  private rangePreset: RangePreset | "custom";
  private customStart: DateParts;
  private customEnd: DateParts;
  private customEndNow: boolean;
  private visibleRange: VisibleRangePreset | "";
  private height: string;
  private chartType: ChartType;
  private theme: ChartTheme;
  private riseColor: string;
  private fallColor: string;
  private logScale: boolean;
  private showHeader: boolean;
  private showVolume: boolean;
  private paneRatios: string;
  private maPeriods: string;
  private widthAuto: boolean;
  private heightAuto: boolean;
  private bleed: number;

  // Per-card 图表显示 overrides (undefined = follow the plugin-wide 显示设置).
  private displayOverrides: DisplayOverrides;

  // Cross-page linkage: 高度 (basic) greys out while 高度自适应 (display) is on.
  private heightText: TextComponent | null = null;
  private activeTab: TopTab = "basic";
  private maPreviewChipsEl: HTMLElement | null = null;

  constructor(app: App, options: UnifiedCardEditModalOptions) {
    super(app);
    this.options = options;

    const spec = options.spec;
    this.symbol = spec?.symbol ?? "";
    this.customSourceId = spec?.sourceId ?? options.customSources[0]?.id;
    this.freq = spec?.freq ?? "D";
    this.rangePreset =
      spec && RANGE_PRESET_VALUES.includes(spec.range) ? (spec.range as RangePreset) : spec ? "custom" : "1y";
    const today = new Date();
    const todayParts: DateParts = { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };
    this.customStart = { ...todayParts, y: todayParts.y - 1 };
    this.customEnd = todayParts;
    this.customEndNow = true;
    if (spec && this.rangePreset === "custom" && isDateRangeString(spec.range)) {
      const [start, end] = spec.range.split("~");
      this.customStart = parseDateParts(start);
      this.customEnd = parseDateParts(end);
      this.customEndNow = false;
    }
    this.visibleRange = spec?.visibleRange ?? "";
    this.height = String(spec?.height ?? DEFAULT_CARD_HEIGHT);
    this.chartType = spec?.chartType ?? "candlestick";
    this.theme = spec?.theme ?? "auto";
    this.riseColor = spec?.riseColor ?? "#ef4444";
    this.fallColor = spec?.fallColor ?? "#22c55e";
    this.logScale = spec?.logScale ?? false;
    this.showHeader = spec?.showHeader ?? true;
    this.showVolume = spec?.showVolume ?? true;
    this.paneRatios = spec?.paneRatios?.join(",") ?? "";
    this.maPeriods = spec?.maPeriods?.join(",") ?? "";
    this.widthAuto = spec?.widthAuto ?? true;
    this.heightAuto = spec?.heightAuto ?? true;
    this.bleed = spec?.bleed ?? DEFAULT_CARD_BLEED;

    // Init from the spec; absent fields stay undefined (= 跟随全局).
    this.displayOverrides = {
      showLegend: spec?.showLegend,
      legendFrosted: spec?.legendFrosted,
      legendOpacity: spec?.legendOpacity,
      showMA: spec?.showMA,
      showGrid: spec?.showGrid,
      gridOpacity: spec?.gridOpacity,
    };

    this.setTitle(t("编辑数据卡"));
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
    this.heightText = null;
    this.maPreviewChipsEl = null;

    // Top-level tabs: 数据源 (custom-source selector) + 基础设置 / 显示设置 /
    // 均线系统.
    const tabs: { id: TopTab; label: string }[] = [
      { id: "source", label: "数据源" },
      { id: "basic", label: "基础设置" },
      { id: "display", label: "显示设置" },
      { id: "ma", label: "均线系统" },
    ];
    if (!tabs.some((tab) => tab.id === this.activeTab)) this.activeTab = "basic";

    const tabBar = contentEl.createDiv("fc-subtabs");
    const pagesEl = contentEl.createDiv();
    const pages = new Map<TopTab, HTMLElement>();
    for (const tab of tabs) pages.set(tab.id, pagesEl.createDiv());

    const applyActive = () => {
      for (const tab of tabs) {
        pages.get(tab.id)!.toggleClass("fc-hidden", tab.id !== this.activeTab);
      }
      tabBar.querySelectorAll(".fc-subtab").forEach((el, i) => {
        el.classList.toggle("is-active", tabs[i].id === this.activeTab);
      });
    };
    tabs.forEach((tab) => {
      const btn = tabBar.createEl("button", { text: t(tab.label), cls: "fc-subtab" });
      btn.addEventListener("click", () => {
        this.activeTab = tab.id;
        applyActive();
      });
    });
    applyActive();

    this.renderSourceGrid(pages.get("source")!);
    this.renderBasicPage(pages.get("basic")!);
    this.renderDisplayPage(pages.get("display")!);
    this.renderMaPage(pages.get("ma")!);

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
  }

  // Source selector page: one entry per enabled custom source. The open
  // card's own (disabled/deleted) source stays selectable so the card can
  // still be edited back.
  private renderSourceGrid(containerEl: HTMLElement) {
    containerEl.createDiv({
      cls: "fc-field-hint",
      text: t("选择此卡片的数据来源；仅列出已在设置页配置的数据源。"),
    });
    const grid = containerEl.createDiv("fc-source-grid");
    const customDefs = [...this.options.customSources];
    if (this.customSourceId && !customDefs.some((d) => d.id === this.customSourceId)) {
      customDefs.push({ id: this.customSourceId, name: this.customSourceId, enabled: false, format: "json", klineUrl: "" });
    }
    for (const def of customDefs) {
      const selected = this.customSourceId === def.id;
      const card = grid.createDiv({ cls: `fc-source-card${selected ? " selected" : ""}` });
      card.createDiv({ cls: "fc-source-card-name", text: def.name });
      card.createDiv({ cls: "fc-source-card-desc", text: t("自定义数据源 · 用户配置") });
      card.addEventListener("click", () => {
        if (selected) return;
        if (this.customSourceId !== def.id) {
          this.symbol = "";
          this.customSourceId = def.id;
        }
        this.activeTab = "basic";
        this.render();
      });
    }
  }

  // ==================== 基础设置 ====================

  private renderBasicPage(pageEl: HTMLElement) {
    // 代码: read-only; click opens the current source's symbol picker.
    const symbolSetting = new Setting(pageEl).setName(t("代码"));
    const hintEl = symbolSetting.descEl;
    const updateHint = () => {
      const sourceName = this.options.customSources.find((d) => d.id === this.customSourceId)?.name ?? this.customSourceId ?? "";
      hintEl.setText(this.symbol ? t("数据源：{name} · 只读", { name: sourceName }) : t("点击输入框选择标的"));
    };
    updateHint();
    symbolSetting.addText((text) => {
      text.setPlaceholder(t("点击选择标的")).setValue(this.symbol);
      text.inputEl.readOnly = true;
      text.inputEl.addClass("fc-mono");
      if (this.symbol) return;
      const openPicker = () => {
        // Custom-source cards pick from their own source's search /
        // manual-entry modal.
        this.options.openSymbolPicker((item) => {
          this.symbol = item.tsCode;
          this.customSourceId = item.sourceId ?? this.customSourceId;
          text.setValue(item.tsCode);
          updateHint();
        }, this.customSourceId);
      };
      text.inputEl.addEventListener("click", openPicker);
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openPicker();
        }
      });
    });

    new Setting(pageEl).setName(t("周期")).addDropdown((dropdown) => {
      for (const option of FREQ_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.freq).onChange((value) => {
        this.freq = value as Freq;
      });
    });

    this.renderRangeSetting(pageEl);

    new Setting(pageEl)
      .setName(t("高度"))
      .setDesc(t("200–1600px，默认 400。开启「显示设置 → 高度自适应」后此字段失效。"))
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_CARD_HEIGHT))
          .setValue(this.height)
          .setDisabled(this.heightAuto)
          .onChange((value) => {
            this.height = value.trim();
          });
        text.inputEl.addClass("fc-mono");
        this.heightText = text;
      });

    new Setting(pageEl)
      .setName(t("面板比例"))
      .setDesc(t("价格窗格与成交量窗格的高度比，例如 3,1。留空使用默认值 3:1。"))
      .addText((text) =>
        text
          .setPlaceholder("3,1")
          .setValue(this.paneRatios)
          .onChange((value) => {
            this.paneRatios = value.trim();
          })
      );
  }

  private renderRangeSetting(pageEl: HTMLElement) {
    const customDropdowns: DropdownComponent[] = [];
    const customEndPartDropdowns: DropdownComponent[] = [];

    new Setting(pageEl)
      .setName(t("范围"))
      .setDesc(t("选择预设；选「自定义」则在下方按年/月/日选择起止日期。"))
      .addDropdown((dropdown) => {
        for (const option of RANGE_OPTIONS) {
          dropdown.addOption(option.value, t(option.label));
        }
        dropdown.addOption("custom", t("自定义"));
        dropdown.setValue(this.rangePreset).onChange((value) => {
          this.rangePreset = value as RangePreset | "custom";
          const disabled = value !== "custom";
          for (const d of customDropdowns) d.setDisabled(disabled);
          if (!disabled && this.customEndNow) {
            for (const d of customEndPartDropdowns) d.setDisabled(true);
          }
        });
      });

    const currentYear = new Date().getFullYear();
    const yearOptions: { value: string; label: string }[] = [];
    for (let y = currentYear; y >= MIN_RANGE_YEAR; y--) {
      yearOptions.push({ value: String(y), label: t("{y}年", { y }) });
    }
    const monthOptions: { value: string; label: string }[] = [];
    for (let m = 1; m <= 12; m++) {
      monthOptions.push({ value: String(m), label: t("{m}月", { m }) });
    }
    const dayOptions: { value: string; label: string }[] = [];
    for (let d = 1; d <= 31; d++) {
      dayOptions.push({ value: String(d), label: t("{d}日", { d }) });
    }

    // Six part-dropdowns in one control row would squeeze the name/desc
    // column into a narrow strip — stack info above the controls instead
    // (see .fc-setting-stacked in styles.css).
    const customSetting = new Setting(pageEl)
      .setName(t("自定义范围"))
      .setDesc(t("开始日期 ~ 结束日期；结束日期的年份选「至今」则取保存当天。"));
    customSetting.settingEl.addClass("fc-setting-stacked");

    const addPartDropdown = (
      options: { value: string; label: string }[],
      initial: string,
      onChange: (value: string) => void,
      extraBucket?: DropdownComponent[]
    ) => {
      customSetting.addDropdown((dropdown) => {
        for (const option of options) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown
          .setValue(initial)
          .setDisabled(this.rangePreset !== "custom")
          .onChange(onChange);
        customDropdowns.push(dropdown);
        extraBucket?.push(dropdown);
      });
    };

    addPartDropdown(yearOptions, String(this.customStart.y), (value) => {
      this.customStart.y = Number(value);
    });
    addPartDropdown(monthOptions, String(this.customStart.m), (value) => {
      this.customStart.m = Number(value);
    });
    addPartDropdown(dayOptions, String(this.customStart.d), (value) => {
      this.customStart.d = Number(value);
    });

    addPartDropdown(
      [{ value: "now", label: t("至今") }, ...yearOptions],
      this.customEndNow ? "now" : String(this.customEnd.y),
      (value) => {
        this.customEndNow = value === "now";
        if (!this.customEndNow) {
          this.customEnd.y = Number(value);
        }
        for (const d of customEndPartDropdowns) d.setDisabled(this.customEndNow);
      }
    );
    addPartDropdown(
      monthOptions,
      String(this.customEnd.m),
      (value) => {
        this.customEnd.m = Number(value);
      },
      customEndPartDropdowns
    );
    addPartDropdown(
      dayOptions,
      String(this.customEnd.d),
      (value) => {
        this.customEnd.d = Number(value);
      },
      customEndPartDropdowns
    );
    if (this.customEndNow) {
      for (const d of customEndPartDropdowns) d.setDisabled(true);
    }
  }

  private renderDisplayPage(pageEl: HTMLElement) {
    new Setting(pageEl).setName(t("主题")).addDropdown((dropdown) => {
      for (const option of THEME_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.theme).onChange((value) => {
        this.theme = value as ChartTheme;
      });
    });

    new Setting(pageEl).setName(t("图表类型")).addDropdown((dropdown) => {
      for (const option of CHART_TYPE_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.chartType).onChange((value) => {
        this.chartType = value as ChartType;
      });
    });

    new Setting(pageEl).setName(t("涨色 / 跌色")).setDesc(t("红涨绿跌为 A 股惯例。")).addColorPicker((picker) =>
      picker.setValue(this.riseColor).onChange((value) => {
        this.riseColor = value;
      })
    ).addColorPicker((picker) =>
      picker.setValue(this.fallColor).onChange((value) => {
        this.fallColor = value;
      })
    );

    new Setting(pageEl).setName(t("显示标题")).addToggle((toggle) =>
      toggle.setValue(this.showHeader).onChange((value) => {
        this.showHeader = value;
      })
    );

    new Setting(pageEl)
      .setName(t("显示成交量"))
      .setDesc(t("主图下方的成交量副图。"))
      .addToggle((toggle) =>
        toggle.setValue(this.showVolume).onChange((value) => {
          this.showVolume = value;
        })
      );

    new Setting(pageEl)
      .setName(t("可见范围"))
      .setDesc(t("图表初始显示的时间窗口；保存后按此预设重新定义视图。"))
      .addDropdown((dropdown) => {
        for (const option of VISIBLE_RANGE_OPTIONS) {
          dropdown.addOption(option.value, t(option.label));
        }
        dropdown.setValue(this.visibleRange).onChange((value) => {
          this.visibleRange = value as VisibleRangePreset | "";
        });
      });

    new Setting(pageEl).setName(t("对数坐标")).addToggle((toggle) =>
      toggle.setValue(this.logScale).onChange((value) => {
        this.logScale = value;
      })
    );

    // Canvas 显示逻辑 group (wireframe: dashed separator + group title).
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
      .setDesc(t("开启后跟随节点高度，「基础设置」的高度字段失效。"))
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

    // Per-card overrides of the plugin-wide 显示设置 (K-line cards have no
    // latest-value/point-marker options, hence series: false; they are the
    // only cards with moving averages, hence ma: true).
    renderDisplayOverrideSettings(pageEl, this.displayOverrides, { series: false, ma: true });
  }

  private renderMaPage(pageEl: HTMLElement) {
    new Setting(pageEl)
      .setName(t("均线"))
      .setDesc(t("均线周期以交易日为单位（逗号分隔，最多 8 条）；周线/月线上自动按日线收盘计算并贴合到每根 K 线。留空使用默认值 5,10,20,60。"))
      .addText((text) =>
        text
          .setPlaceholder("5,10,20,60")
          .setValue(this.maPeriods)
          .onChange((value) => {
            this.maPeriods = value.trim();
            this.renderMaPreview();
          })
      );

    const preview = pageEl.createDiv("fc-ma-preview");
    preview.createDiv({ cls: "fc-ma-preview-title", text: t("均线预览") });
    this.maPreviewChipsEl = preview.createDiv("fc-ma-preview-chips");
    this.renderMaPreview();
  }

  // Chips colored with the chart's own MA palette; falls back to the default
  // periods when the input is empty, hides on invalid input.
  private renderMaPreview() {
    const container = this.maPreviewChipsEl;
    if (!container) return;
    container.empty();
    const periods =
      this.maPeriods.length === 0 ? [5, 10, 20, 60] : parseMaPeriods(this.maPeriods) ?? [];
    periods.forEach((period, i) => {
      const chip = container.createSpan({ cls: "fc-ma-chip", text: `MA${period}` });
      chip.style.borderColor = MA_COLORS[i % MA_COLORS.length];
    });
  }

  // ==================== Save ====================

  private save() {
    const spec = this.buildSpec();
    if (!spec) return;
    this.close();
    this.options.onSubmit(spec);
  }

  private buildSpec(): ParsedCardSpec | null {
    if (!this.customSourceId) {
      new Notice(t("请选择自定义数据源（可在设置页添加）。"));
      return null;
    }
    if (!this.symbol.trim()) {
      new Notice(t("请先选择标的（代码）。"));
      return null;
    }

    let range: string;
    if (this.rangePreset === "custom") {
      const end = this.customEndNow
        ? (() => {
            const today = new Date();
            return { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };
          })()
        : this.customEnd;
      if (!isValidDateParts(this.customStart) || !isValidDateParts(end)) {
        new Notice(t("自定义范围包含无效日期（如 2 月 30 日）。"));
        return null;
      }
      const startStr = formatDateParts(this.customStart);
      const endStr = formatDateParts(end);
      if (startStr > endStr) {
        new Notice(t("开始日期不能晚于结束日期。"));
        return null;
      }
      range = `${startStr}~${endStr}`;
    } else {
      range = this.rangePreset;
    }

    const height = Number(this.height);
    if (!Number.isInteger(height) || height < MIN_CARD_HEIGHT || height > MAX_CARD_HEIGHT) {
      new Notice(t("高度应为 {min}–{max} 的整数（单位 px）。", { min: MIN_CARD_HEIGHT, max: MAX_CARD_HEIGHT }));
      return null;
    }

    let paneRatios: number[] | undefined;
    if (this.paneRatios.length > 0) {
      const parsed = parsePaneRatios(this.paneRatios);
      if (!parsed) {
        new Notice(t("面板比例格式应为两个以上的正数，例如 3,1。"));
        return null;
      }
      paneRatios = parsed;
    }

    let maPeriods: number[] | undefined;
    if (this.maPeriods.length > 0) {
      const parsed = parseMaPeriods(this.maPeriods);
      if (!parsed) {
        new Notice(t("均线格式应为逗号分隔的正整数，例如 5,10,20,60。"));
        return null;
      }
      maPeriods = parsed;
    }

    const base = this.options.spec;
    return {
      ...base,
      symbol: this.symbol.trim(),
      assetType: "custom",
      sourceId: this.customSourceId,
      freq: this.freq,
      range,
      version: base?.version ?? 1,
      visibleRange: this.visibleRange === "" ? undefined : this.visibleRange,
      // Saving from the editor redefines the view via the 可见范围 preset;
      // drop any persisted custom zoom range so it can't override the preset.
      visibleStart: undefined,
      visibleEnd: undefined,
      height,
      chartType: this.chartType,
      theme: this.theme,
      riseColor: this.riseColor,
      fallColor: this.fallColor,
      logScale: this.logScale,
      showHeader: this.showHeader,
      showVolume: this.showVolume,
      paneRatios,
      maPeriods,
      // Canvas display fields persist only when they differ from defaults.
      widthAuto: this.widthAuto ? undefined : false,
      heightAuto: this.heightAuto ? undefined : false,
      bleed: this.bleed === DEFAULT_CARD_BLEED ? undefined : this.bleed,
      // 图表显示 overrides: undefined fields are dropped by the serializer.
      ...this.displayOverrides,
    };
  }
}
