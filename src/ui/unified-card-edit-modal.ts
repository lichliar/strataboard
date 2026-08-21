import { App, Modal, Notice, Setting, type DropdownComponent, type TextComponent } from "obsidian";
import {
  ASSET_TYPE_LABELS,
  FRED_TRANSFORM_OPTIONS,
  findMacroSeriesDef,
  type AssetType,
  type ChartTheme,
  type ChartType,
  type FredCardSpec,
  type FredTransform,
  type Freq,
  type MacroCardSpec,
  type MacroSeriesDef,
  type ParsedCardSpec,
  type RangePreset,
  type SeriesPeriod,
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
import type { OpenFredPicker } from "./series-ref-editor";
import { addStepper } from "./stepper";

// Unified asset-card editor (wireframe #screen-unified): one modal for
// tushare, FRED and macro data cards. The data-source selector sits on top
// and the form below switches with it; the tushare form is split into three
// sub-pages (基础设置 / 显示设置 / 均线系统), the FRED and macro forms are
// single flat pages. Saving with a source different from the card's own
// converts the card's code block to the other type (handled by the onSubmit
// caller).

export type UnifiedCardSource = "tushare" | "fred" | "macro";

export interface UnifiedCardEditModalOptions {
  source: UnifiedCardSource;
  /** Resolved spec when source === "tushare". */
  tushareSpec?: ParsedCardSpec;
  /** Current spec when source === "fred". */
  fredSpec?: FredCardSpec;
  /** Current spec when source === "macro". */
  macroSpec?: MacroCardSpec;
  /** Whether the source is configured in settings (token / API key present). */
  tushareAvailable: boolean;
  fredAvailable: boolean;
  openFredPicker: OpenFredPicker;
  /** Macro series picker over the local catalog. */
  openMacroPicker: (onSelect: (def: MacroSeriesDef) => void) => void;
  /** Symbol picker, needed when converting a FRED card into a tushare card. */
  openSymbolPicker: (onSelect: (item: SymbolItem) => void) => void;
  onSubmit: (source: UnifiedCardSource, spec: ParsedCardSpec | FredCardSpec | MacroCardSpec) => void;
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

const FRED_RANGE_OPTIONS: { value: string; label: string }[] = [
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

type TushareSubPage = "basic" | "display" | "ma";

const SUB_PAGES: { id: TushareSubPage; label: string }[] = [
  { id: "basic", label: "基础设置" },
  { id: "display", label: "显示设置" },
  { id: "ma", label: "均线系统" },
];

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
  private source: UnifiedCardSource;

  // ---- Tushare form state ----
  private symbol: string;
  private assetType: AssetType;
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
  private showMarketData: boolean;
  private showVolume: boolean;
  private paneRatios: string;
  private maPeriods: string;
  private widthAuto: boolean;
  private heightAuto: boolean;
  private bleed: number;

  // ---- FRED form state ----
  private fredSeriesId: string;
  private fredLabel: string;
  private fredUnits: string;
  private fredFrequency: string;
  private fredTransform: FredTransform | "";
  private fredRange: string;
  private fredPeriod: SeriesPeriod;
  private fredHeight: string;

  // ---- Macro form state ----
  private macroSeriesId: string;
  private macroRange: string;
  private macroPeriod: SeriesPeriod;
  private macroHeight: string;

  // Cross-page linkage: 高度 (basic) greys out while 高度自适应 (display) is on.
  private heightText: TextComponent | null = null;
  private activeSubPage: TushareSubPage = "basic";
  private maPreviewChipsEl: HTMLElement | null = null;

  constructor(app: App, options: UnifiedCardEditModalOptions) {
    super(app);
    this.options = options;
    this.source = options.source;

    const t = options.tushareSpec;
    this.symbol = t?.symbol ?? "";
    this.assetType = t?.assetType ?? "stock";
    this.freq = t?.freq ?? "D";
    this.rangePreset =
      t && RANGE_PRESET_VALUES.includes(t.range) ? (t.range as RangePreset) : t ? "custom" : "1y";
    const today = new Date();
    const todayParts: DateParts = { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };
    this.customStart = { ...todayParts, y: todayParts.y - 1 };
    this.customEnd = todayParts;
    this.customEndNow = true;
    if (t && this.rangePreset === "custom" && isDateRangeString(t.range)) {
      const [start, end] = t.range.split("~");
      this.customStart = parseDateParts(start);
      this.customEnd = parseDateParts(end);
      this.customEndNow = false;
    }
    this.visibleRange = t?.visibleRange ?? "";
    this.height = String(t?.height ?? DEFAULT_CARD_HEIGHT);
    this.chartType = t?.chartType ?? "candlestick";
    this.theme = t?.theme ?? "auto";
    this.riseColor = t?.riseColor ?? "#ef4444";
    this.fallColor = t?.fallColor ?? "#22c55e";
    this.logScale = t?.logScale ?? false;
    this.showHeader = t?.showHeader ?? true;
    this.showMarketData = t?.showMarketData ?? true;
    this.showVolume = t?.showVolume ?? true;
    this.paneRatios = t?.paneRatios?.join(",") ?? "";
    this.maPeriods = t?.maPeriods?.join(",") ?? "";
    this.widthAuto = t?.widthAuto ?? true;
    this.heightAuto = t?.heightAuto ?? true;
    this.bleed = t?.bleed ?? DEFAULT_CARD_BLEED;

    const f = options.fredSpec;
    this.fredSeriesId = f?.seriesId ?? "";
    this.fredLabel = f?.label ?? "";
    this.fredUnits = f?.units ?? "";
    this.fredFrequency = f?.frequency ?? "";
    this.fredTransform = f?.transform ?? "";
    this.fredRange = f && FRED_RANGE_OPTIONS.some((o) => o.value === f.range) ? f.range : "10y";
    this.fredPeriod = f?.period ?? "D";
    this.fredHeight = f?.height ? String(f.height) : "";

    const mc = options.macroSpec;
    this.macroSeriesId = mc?.seriesId ?? "";
    this.macroRange = mc && FRED_RANGE_OPTIONS.some((o) => o.value === mc.range) ? mc.range : "10y";
    this.macroPeriod = mc?.period ?? "D";
    this.macroHeight = mc?.height ? String(mc.height) : "";

    this.setTitle("编辑数据卡");
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

    contentEl.createDiv({ cls: "fc-field-hint", text: "数据源" });
    this.renderSourceGrid(contentEl);

    if (this.source === "tushare") {
      this.renderTushareForm(contentEl);
    } else if (this.source === "fred") {
      this.renderFredForm(contentEl);
    } else {
      this.renderMacroForm(contentEl);
    }

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: "保存", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
  }

  // Source selector cards, generated from the sources configured in settings
  // (Tushare token / FRED key) plus the always-present extension placeholder.
  private renderSourceGrid(containerEl: HTMLElement) {
    const grid = containerEl.createDiv("fc-source-grid");
    const sources: { id: UnifiedCardSource; name: string; desc: string; available: boolean }[] = [
      {
        id: "tushare",
        name: "Tushare",
        desc: "A股股票/基金/指数/南华指数 · 日K/周K/月K",
        available: this.options.tushareAvailable,
      },
      {
        id: "macro",
        name: "Tushare 宏观",
        desc: "中国宏观经济数据 · CPI/PMI/货币供应/社融…",
        available: this.options.tushareAvailable,
      },
      {
        id: "fred",
        name: "FRED",
        desc: "美国宏观经济数据 · 利率/就业/GDP…",
        available: this.options.fredAvailable,
      },
    ];
    for (const source of sources) {
      const selected = this.source === source.id;
      // The card's own source stays clickable even if its key was removed
      // from settings — otherwise the open card could not be edited back.
      const clickable = source.available || selected;
      const card = grid.createDiv({
        cls: `fc-source-card${selected ? " selected" : ""}${clickable ? "" : " is-disabled"}`,
      });
      card.createDiv({ cls: "fc-source-card-name", text: source.name });
      card.createDiv({ cls: "fc-source-card-desc", text: source.desc });
      if (!clickable) {
        card.setAttr("title", "请先在设置中配置该数据源的密钥");
        continue;
      }
      card.addEventListener("click", () => {
        if (this.source === source.id) return;
        this.source = source.id;
        this.render();
      });
    }
    const placeholder = grid.createDiv("fc-source-card fc-source-card-placeholder");
    placeholder.createDiv({ cls: "fc-source-card-name", text: "其他数据接口" });
    placeholder.createDiv({ cls: "fc-source-card-desc", text: "预留扩展 · 自定义数据源" });
  }

  // ==================== Tushare form (three sub-pages) ====================

  private renderTushareForm(containerEl: HTMLElement) {
    const tabBar = containerEl.createDiv("fc-subtabs");
    const pagesEl = containerEl.createDiv();
    const pages: Record<TushareSubPage, HTMLElement> = {
      basic: pagesEl.createDiv(),
      display: pagesEl.createDiv(),
      ma: pagesEl.createDiv(),
    };

    const applyActive = () => {
      for (const tab of SUB_PAGES) {
        pages[tab.id].toggleClass("fc-hidden", tab.id !== this.activeSubPage);
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
    this.renderMaPage(pages.ma);
  }

  private renderBasicPage(pageEl: HTMLElement) {
    // 代码: read-only for existing tushare cards; becomes a symbol picker when
    // converting a FRED card (no symbol to show yet).
    const symbolSetting = new Setting(pageEl).setName("代码");
    const hintEl = symbolSetting.descEl;
    const updateHint = () => {
      hintEl.setText(
        this.symbol ? `资产类型：${ASSET_TYPE_LABELS[this.assetType]} · 只读` : "点击输入框选择标的"
      );
    };
    updateHint();
    symbolSetting.addText((text) => {
      text.setPlaceholder("点击选择标的").setValue(this.symbol);
      text.inputEl.readOnly = true;
      text.inputEl.addClass("fc-mono");
      if (this.symbol) return;
      const openPicker = () => {
        this.options.openSymbolPicker((item) => {
          this.symbol = item.tsCode;
          this.assetType = item.assetType;
          text.setValue(item.tsCode);
          updateHint();
        });
      };
      text.inputEl.addEventListener("click", openPicker);
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openPicker();
        }
      });
    });

    new Setting(pageEl).setName("周期").addDropdown((dropdown) => {
      for (const option of FREQ_OPTIONS) {
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.freq).onChange((value) => {
        this.freq = value as Freq;
      });
    });

    this.renderRangeSetting(pageEl);

    new Setting(pageEl)
      .setName("高度")
      .setDesc("200–1600px，默认 400。开启「显示设置 → 高度自适应」后此字段失效。")
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
      .setName("面板比例")
      .setDesc("价格窗格与成交量窗格的高度比，例如 3,1。留空使用默认值 3:1。")
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
      .setName("范围")
      .setDesc("选择预设；选「自定义」则在下方按年/月/日选择起止日期。")
      .addDropdown((dropdown) => {
        for (const option of RANGE_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown.addOption("custom", "自定义");
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
      yearOptions.push({ value: String(y), label: `${y}年` });
    }
    const monthOptions: { value: string; label: string }[] = [];
    for (let m = 1; m <= 12; m++) {
      monthOptions.push({ value: String(m), label: `${m}月` });
    }
    const dayOptions: { value: string; label: string }[] = [];
    for (let d = 1; d <= 31; d++) {
      dayOptions.push({ value: String(d), label: `${d}日` });
    }

    const customSetting = new Setting(pageEl)
      .setName("自定义范围")
      .setDesc("开始日期 ~ 结束日期；结束日期的年份选「至今」则取保存当天。");

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
      [{ value: "now", label: "至今" }, ...yearOptions],
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
    new Setting(pageEl).setName("主题").addDropdown((dropdown) => {
      for (const option of THEME_OPTIONS) {
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.theme).onChange((value) => {
        this.theme = value as ChartTheme;
      });
    });

    new Setting(pageEl).setName("图表类型").addDropdown((dropdown) => {
      for (const option of CHART_TYPE_OPTIONS) {
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.chartType).onChange((value) => {
        this.chartType = value as ChartType;
      });
    });

    new Setting(pageEl).setName("涨色 / 跌色").setDesc("红涨绿跌为 A 股惯例。").addColorPicker((picker) =>
      picker.setValue(this.riseColor).onChange((value) => {
        this.riseColor = value;
      })
    ).addColorPicker((picker) =>
      picker.setValue(this.fallColor).onChange((value) => {
        this.fallColor = value;
      })
    );

    new Setting(pageEl).setName("显示标题").addToggle((toggle) =>
      toggle.setValue(this.showHeader).onChange((value) => {
        this.showHeader = value;
      })
    );

    new Setting(pageEl)
      .setName("显示市场数据")
      .setDesc("市值、市盈率、量比等一行数据；仅对股票生效。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.showMarketData)
          .setDisabled(this.assetType !== "stock")
          .onChange((value) => {
            this.showMarketData = value;
          })
      );

    new Setting(pageEl)
      .setName("显示成交量")
      .setDesc("主图下方的成交量副图。")
      .addToggle((toggle) =>
        toggle.setValue(this.showVolume).onChange((value) => {
          this.showVolume = value;
        })
      );

    new Setting(pageEl)
      .setName("可见范围")
      .setDesc("图表初始显示的时间窗口；保存后按此预设重新定义视图。")
      .addDropdown((dropdown) => {
        for (const option of VISIBLE_RANGE_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown.setValue(this.visibleRange).onChange((value) => {
          this.visibleRange = value as VisibleRangePreset | "";
        });
      });

    new Setting(pageEl).setName("对数坐标").addToggle((toggle) =>
      toggle.setValue(this.logScale).onChange((value) => {
        this.logScale = value;
      })
    );

    // Canvas 显示逻辑 group (wireframe: dashed separator + group title).
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
      .setDesc("开启后跟随节点高度，「基础设置」的高度字段失效。")
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

  private renderMaPage(pageEl: HTMLElement) {
    new Setting(pageEl)
      .setName("均线")
      .setDesc("均线周期（逗号分隔，最多 8 条）。留空使用默认值 5,10,20,60。")
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
    preview.createDiv({ cls: "fc-ma-preview-title", text: "均线预览" });
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

  // ==================== FRED form ====================

  private renderFredForm(containerEl: HTMLElement) {
    new Setting(containerEl).setName("数据系列").addText((text) => {
      text.setPlaceholder("点击选择 FRED 系列").setValue(this.fredDisplayText());
      text.inputEl.readOnly = true;
      const openPicker = () => {
        this.options.openFredPicker((info) => {
          this.fredSeriesId = info.id;
          this.fredLabel = info.title;
          this.fredUnits = info.units;
          this.fredFrequency = info.frequency;
          text.setValue(this.fredDisplayText());
        });
      };
      text.inputEl.addEventListener("click", openPicker);
      // Keyboard access: the read-only input is focusable, Enter/Space open
      // the picker. (No focus listener — it would double-fire with click.)
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openPicker();
        }
      });
    });

    new Setting(containerEl)
      .setName("数据变换")
      .setDesc("由 FRED 服务端对原始值做变换（如同比/环比增速），默认使用原始值。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "原始值");
        for (const option of FRED_TRANSFORM_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown.setValue(this.fredTransform).onChange((value) => {
          this.fredTransform = value as FredTransform | "";
        });
      });

    new Setting(containerEl).setName("数据范围").addDropdown((dropdown) => {
      for (const option of FRED_RANGE_OPTIONS) {
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.fredRange).onChange((value) => {
        this.fredRange = value;
      });
    });

    new Setting(containerEl).setName("周期").addDropdown((dropdown) => {
      for (const option of PERIOD_OPTIONS) {
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.fredPeriod).onChange((value) => {
        this.fredPeriod = value as SeriesPeriod;
      });
    });

    new Setting(containerEl)
      .setName("高度")
      .setDesc("可选，单位 px；留空使用默认高度。")
      .addText((text) => {
        text
          .setPlaceholder("如 400")
          .setValue(this.fredHeight)
          .onChange((value) => {
            this.fredHeight = value;
          });
        text.inputEl.addClass("fc-mono");
      });
  }

  private fredDisplayText(): string {
    return this.fredLabel ? `${this.fredLabel} (${this.fredSeriesId})` : this.fredSeriesId;
  }

  // ==================== Macro form ====================

  private renderMacroForm(containerEl: HTMLElement) {
    new Setting(containerEl).setName("数据系列").addText((text) => {
      text.setPlaceholder("点击选择宏观序列").setValue(this.macroDisplayText());
      text.inputEl.readOnly = true;
      const openPicker = () => {
        this.options.openMacroPicker((def) => {
          this.macroSeriesId = def.id;
          text.setValue(this.macroDisplayText());
        });
      };
      text.inputEl.addEventListener("click", openPicker);
      // Keyboard access: the read-only input is focusable, Enter/Space open
      // the picker. (No focus listener — it would double-fire with click.)
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openPicker();
        }
      });
    });

    new Setting(containerEl).setName("数据范围").addDropdown((dropdown) => {
      for (const option of FRED_RANGE_OPTIONS) {
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.macroRange).onChange((value) => {
        this.macroRange = value;
      });
    });

    new Setting(containerEl).setName("周期").addDropdown((dropdown) => {
      for (const option of PERIOD_OPTIONS) {
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.macroPeriod).onChange((value) => {
        this.macroPeriod = value as SeriesPeriod;
      });
    });

    new Setting(containerEl)
      .setName("高度")
      .setDesc("可选，单位 px；留空使用默认高度。")
      .addText((text) => {
        text
          .setPlaceholder("如 400")
          .setValue(this.macroHeight)
          .onChange((value) => {
            this.macroHeight = value;
          });
        text.inputEl.addClass("fc-mono");
      });
  }

  private macroDisplayText(): string {
    const def = this.macroSeriesId ? findMacroSeriesDef(this.macroSeriesId) : undefined;
    return def ? `${def.label} (${def.group})` : this.macroSeriesId;
  }

  // ==================== Save ====================

  private save() {
    if (this.source === "tushare") {
      const spec = this.buildTushareSpec();
      if (!spec) return;
      this.close();
      this.options.onSubmit("tushare", spec);
    } else if (this.source === "fred") {
      const spec = this.buildFredSpec();
      if (!spec) return;
      this.close();
      this.options.onSubmit("fred", spec);
    } else {
      const spec = this.buildMacroSpec();
      if (!spec) return;
      this.close();
      this.options.onSubmit("macro", spec);
    }
  }

  private buildTushareSpec(): ParsedCardSpec | null {
    if (!this.symbol.trim()) {
      new Notice("请先选择标的（代码）。");
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
        new Notice("自定义范围包含无效日期（如 2 月 30 日）。");
        return null;
      }
      const startStr = formatDateParts(this.customStart);
      const endStr = formatDateParts(end);
      if (startStr > endStr) {
        new Notice("开始日期不能晚于结束日期。");
        return null;
      }
      range = `${startStr}~${endStr}`;
    } else {
      range = this.rangePreset;
    }

    const height = Number(this.height);
    if (!Number.isInteger(height) || height < MIN_CARD_HEIGHT || height > MAX_CARD_HEIGHT) {
      new Notice(`高度应为 ${MIN_CARD_HEIGHT}–${MAX_CARD_HEIGHT} 的整数（单位 px）。`);
      return null;
    }

    let paneRatios: number[] | undefined;
    if (this.paneRatios.length > 0) {
      const parsed = parsePaneRatios(this.paneRatios);
      if (!parsed) {
        new Notice("面板比例格式应为两个以上的正数，例如 3,1。");
        return null;
      }
      paneRatios = parsed;
    }

    let maPeriods: number[] | undefined;
    if (this.maPeriods.length > 0) {
      const parsed = parseMaPeriods(this.maPeriods);
      if (!parsed) {
        new Notice("均线格式应为逗号分隔的正整数，例如 5,10,20,60。");
        return null;
      }
      maPeriods = parsed;
    }

    const base = this.options.tushareSpec;
    return {
      ...base,
      symbol: this.symbol.trim(),
      assetType: this.assetType,
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
      showMarketData: this.showMarketData,
      showVolume: this.showVolume,
      paneRatios,
      maPeriods,
      // Canvas display fields persist only when they differ from defaults.
      widthAuto: this.widthAuto ? undefined : false,
      heightAuto: this.heightAuto ? undefined : false,
      bleed: this.bleed === DEFAULT_CARD_BLEED ? undefined : this.bleed,
    };
  }

  private buildFredSpec(): FredCardSpec | null {
    if (!this.fredSeriesId.trim()) {
      new Notice("请选择 FRED 系列。");
      return null;
    }

    let height: number | undefined;
    if (this.fredHeight.trim()) {
      const parsed = Number(this.fredHeight.trim());
      if (!Number.isFinite(parsed) || parsed <= 0) {
        new Notice("高度应为正数（单位 px）。");
        return null;
      }
      height = parsed;
    }

    return {
      seriesId: this.fredSeriesId.trim(),
      ...(this.fredLabel ? { label: this.fredLabel } : {}),
      ...(this.fredUnits ? { units: this.fredUnits } : {}),
      ...(this.fredFrequency ? { frequency: this.fredFrequency } : {}),
      ...(this.fredTransform ? { transform: this.fredTransform } : {}),
      range: this.fredRange,
      period: this.fredPeriod,
      ...(height !== undefined ? { height } : {}),
    };
  }

  private buildMacroSpec(): MacroCardSpec | null {
    const seriesId = this.macroSeriesId.trim();
    if (!seriesId || !findMacroSeriesDef(seriesId)) {
      new Notice("请选择宏观序列。");
      return null;
    }

    let height: number | undefined;
    if (this.macroHeight.trim()) {
      const parsed = Number(this.macroHeight.trim());
      if (!Number.isFinite(parsed) || parsed <= 0) {
        new Notice("高度应为正数（单位 px）。");
        return null;
      }
      height = parsed;
    }

    return {
      seriesId,
      range: this.macroRange,
      period: this.macroPeriod,
      ...(height !== undefined ? { height } : {}),
    };
  }
}
