import { App, DropdownComponent, Modal, Notice, Setting, TextComponent, ToggleComponent } from "obsidian";
import {
  type ChartTheme,
  type ChartType,
  type CustomSourceDef,
  type DisplayOverrides,
  type Freq,
  type IndicatorInstance,
  type ParsedCardSpec,
  type RangePreset,
  type SymbolItem,
  type VisibleRangePreset,
} from "../types";
import { isDateRangeString } from "../utils/date";
import { FREQ_BADGE, freqRank } from "../utils/frequency";
import {
  DEFAULT_CARD_BLEED,
  DEFAULT_CARD_HEIGHT,
  MAX_CARD_BLEED,
  MAX_CARD_HEIGHT,
  MIN_CARD_HEIGHT,
} from "../modules/card-spec";
import type { IndicatorDef } from "../modules/indicators/contract";
import { indicatorRegistry } from "../modules/indicators/registry";
import { getIndicatorParamDoc } from "../modules/indicators/param-docs";
import type { InputConfig } from "oakscriptjs";
import { addStepper } from "./stepper";
import { renderDisplayOverrideSettings } from "./display-overrides";
import { renderIndicatorInputRow } from "./indicator-inputs";
import { applyInfoDescs } from "./info-desc";
import { t } from "../i18n";

// Unified asset-card editor (wireframe #screen-unified): one modal for quote
// cards backed by a custom data source. Top-level tabs: 基础设置 (数据源
// dropdown + 代码/周期/范围) / 显示设置 / 技术指标 (指标 + 信号标注).

export interface UnifiedCardEditModalOptions {
  /** Resolved spec of the card being edited; absent = fresh card. */
  spec?: ParsedCardSpec;
  /** Native frequency of the card's data; finer 周期 options are disabled. */
  minFreq?: Freq;
  /** Symbol picker bound to the current custom source. */
  openSymbolPicker: (onSelect: (item: SymbolItem) => void, sourceId?: string) => void;
  /** Enabled custom sources, listed in the 数据源 dropdown. */
  customSources: CustomSourceDef[];
  /** Signals-purpose sources (script signal tables) for the 信号标注 row. */
  signalSources?: CustomSourceDef[];
  /** Snapshot of the global 新卡默认指标 (settings), used to materialize the
   * per-card list when the user clicks 自定义. Absent = empty list. */
  defaultIndicators?: IndicatorInstance[];
  /** Settings-level overrides of built-in indicator default parameters
   * (指标管理 → 内置指标 → 编辑); shown as the effective placeholder/default. */
  builtinIndicatorInputs?: Record<string, Record<string, unknown>>;
  onSubmit: (spec: ParsedCardSpec) => void;
}

const FREQ_OPTIONS: { value: Freq; label: string }[] = [
  { value: "D", label: "日K" },
  { value: "W", label: "周K" },
  { value: "M", label: "月K" },
  { value: "Q", label: "季K" },
  { value: "Y", label: "年K" },
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

type TopTab = "basic" | "display" | "indicator";

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

// Summary line under an indicator row: only explicitly overridden inputs are
// listed (unset keys fall back to the indicator's own defaults).
function describeIndicatorInputs(instance: IndicatorInstance, def: IndicatorDef | undefined): string {
  if (!def) return t("未知指标 id，可能已被删除或改名");
  const parts: string[] = [];
  for (const cfg of def.inputConfig) {
    const value = instance.inputs?.[cfg.id];
    if (value === undefined) continue;
    parts.push(`${cfg.title ?? cfg.id}=${String(value)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : t("默认参数");
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
  // 指标: per-card indicator instances. inheritIndicators tracks the
  // undefined semantics of spec.indicators (true = YAML has no indicators key
  // and the card follows the global default); the list itself is only
  // meaningful while inheritIndicators is false.
  private indicatorInstances: IndicatorInstance[];
  private inheritIndicators: boolean;
  // Expanded state of the collapsible indicator instances, tracked by object
  // identity so it survives the full re-render on every form change (and
  // follows instances across unshift/splice without index bookkeeping).
  private readonly expandedIndicators = new WeakSet<IndicatorInstance>();
  private widthAuto: boolean;
  private heightAuto: boolean;
  private bleed: number;
  // 信号标注: "" = no signals; otherwise a signals-source id (+ optional code
  // override — blank defaults to the card's symbol at load time).
  private signalSourceId: string;
  private signalCode: string;

  // Per-card 图表设置 overrides (undefined = follow the plugin-wide 显示设置).
  private displayOverrides: DisplayOverrides;

  // 高度 (Canvas 设置) greys out while 高度自适应 is on.
  private heightText: TextComponent | null = null;
  private activeTab: TopTab = "basic";

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
    this.inheritIndicators = spec?.indicators === undefined;
    // Clone so editing an instance never mutates the caller's spec object.
    this.indicatorInstances = (spec?.indicators ?? []).map((inst) => ({
      id: inst.id,
      ...(inst.inputs ? { inputs: { ...inst.inputs } } : {}),
    }));
    this.widthAuto = spec?.widthAuto ?? true;
    this.heightAuto = spec?.heightAuto ?? true;
    this.bleed = spec?.bleed ?? DEFAULT_CARD_BLEED;
    this.signalSourceId = spec?.signal?.sourceId ?? "";
    this.signalCode = spec?.signal?.code ?? "";

    // Init from the spec; absent fields stay undefined (= 跟随全局).
    this.displayOverrides = {
      showLegend: spec?.showLegend,
      legendFrosted: spec?.legendFrosted,
      legendOpacity: spec?.legendOpacity,
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

    // Top-level tabs: 基础设置 / 显示设置 / 技术指标.
    const tabs: { id: TopTab; label: string }[] = [
      { id: "basic", label: "基础设置" },
      { id: "display", label: "显示设置" },
      { id: "indicator", label: "技术指标" },
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

    this.renderBasicPage(pages.get("basic")!);
    this.renderDisplayPage(pages.get("display")!);
    this.renderIndicatorPage(pages.get("indicator")!);

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
  }

  // ==================== 基础设置 ====================

  private renderBasicPage(pageEl: HTMLElement) {
    // 数据源 dropdown (was its own tab): switching sources clears the picked
    // symbol. The open card's own (disabled/deleted) source stays selectable
    // so the card can still be edited back.
    new Setting(pageEl)
      .setName(t("数据源"))
      .setDesc(t("选择此卡片的数据来源；仅列出已在设置页配置的数据源。"))
      .addDropdown((dropdown) => {
        for (const def of this.options.customSources) {
          dropdown.addOption(def.id, def.name);
        }
        if (this.customSourceId && !this.options.customSources.some((d) => d.id === this.customSourceId)) {
          dropdown.addOption(this.customSourceId, `${this.customSourceId}${t("（不可用）")}`);
        }
        if (this.customSourceId) dropdown.setValue(this.customSourceId);
        dropdown.onChange((value) => {
          if (this.customSourceId === value) return;
          this.customSourceId = value;
          this.symbol = "";
          this.render();
        });
      });

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
      const minFreq = this.options.minFreq;
      for (const option of FREQ_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
        // Freeze periods finer than the source's native granularity.
        if (minFreq && freqRank(option.value) < freqRank(minFreq)) {
          const el = dropdown.selectEl.lastElementChild as HTMLOptionElement | null;
          if (el) el.disabled = true;
        }
      }
      dropdown.setValue(this.freq).onChange((value) => {
        this.freq = value as Freq;
      });
      if (minFreq && minFreq !== "D") {
        dropdown.selectEl.title = t("数据源原始粒度为{label}，更小周期已禁用。", { label: t(FREQ_BADGE[minFreq]) });
      }
    });

    this.renderRangeSetting(pageEl);

    // 高级选项: rarely touched range options.
    const advanced = pageEl.createEl("details", { cls: "fc-settings-sub" });
    advanced.createEl("summary", { text: t("高级选项") });

    new Setting(advanced)
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

  // ==================== 显示设置 ====================

  private renderDisplayPage(pageEl: HTMLElement) {
    new Setting(pageEl).setName(t("图表类型")).addDropdown((dropdown) => {
      for (const option of CHART_TYPE_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.chartType).onChange((value) => {
        this.chartType = value as ChartType;
      });
    });

    new Setting(pageEl).setName(t("对数坐标")).addToggle((toggle) =>
      toggle.setValue(this.logScale).onChange((value) => {
        this.logScale = value;
      })
    );

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

    // Canvas 设置 collapsible (主题 + 宽高自适应 + 高度/面板比例/出血).
    const canvasDetails = pageEl.createEl("details", { cls: "fc-settings-sub" });
    canvasDetails.createEl("summary", { text: t("Canvas 设置") });

    new Setting(canvasDetails).setName(t("主题")).addDropdown((dropdown) => {
      for (const option of THEME_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.theme).onChange((value) => {
        this.theme = value as ChartTheme;
      });
    });

    new Setting(canvasDetails)
      .setName(t("宽度自适应"))
      .setDesc(t("卡片宽度跟随 Canvas 节点宽度缩放。"))
      .addToggle((toggle) =>
        toggle.setValue(this.widthAuto).onChange((value) => {
          this.widthAuto = value;
        })
      );

    new Setting(canvasDetails)
      .setName(t("高度"))
      .setDesc(t("200–1600px，默认 400。开启「高度自适应」后此字段失效。"))
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

    new Setting(canvasDetails)
      .setName(t("高度自适应"))
      .setDesc(t("开启后跟随节点高度，「高度」字段失效。"))
      .addToggle((toggle) =>
        toggle.setValue(this.heightAuto).onChange((value) => {
          this.heightAuto = value;
          this.heightText?.setDisabled(value);
        })
      );

    new Setting(canvasDetails)
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

    const bleedSetting = new Setting(canvasDetails)
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

    // 图表设置 collapsible: per-card overrides of the plugin-wide 显示设置
    // (K-line cards have no latest-value/point-marker options, hence series:
    // false; indicator selection lives in 技术指标).
    const chartDetails = pageEl.createEl("details", { cls: "fc-settings-sub" });
    chartDetails.createEl("summary", { text: t("图表设置（覆盖全局）") });
    renderDisplayOverrideSettings(chartDetails, this.displayOverrides, { series: false });
  }

  // ==================== 技术指标 ====================

  private renderIndicatorPage(pageEl: HTMLElement) {
    // ---- 指标 ----
    const indDetails = pageEl.createEl("details", { cls: "fc-settings-sub fc-indicator" });
    indDetails.open = true;
    const indSummary = indDetails.createEl("summary");
    indSummary.createSpan({ cls: "fc-indicator-title", text: t("指标") });

    if (this.inheritIndicators) {
      const defaults = this.options.defaultIndicators ?? [];
      indDetails.createDiv({
        cls: "fc-field-hint fc-hint-mb",
        text:
          defaults.length > 0
            ? t("跟随全局默认：{list}（可在设置页「卡片与组件」中修改）。", {
                list: defaults
                  .map((inst) => {
                    const def = indicatorRegistry.resolve(inst.id);
                    return def ? t(def.name) : inst.id;
                  })
                  .join("、"),
              })
            : t("跟随全局默认（设置页「卡片与组件」中的新卡默认指标）。"),
      });
      new Setting(indDetails)
        .setName(t("自定义本卡指标"))
        .setDesc(t("把当前全局默认复制到本卡，之后本卡独立维护指标列表，不再跟随全局变化。"))
        .addButton((btn) =>
          btn.setButtonText(t("自定义")).onClick(() => {
            this.inheritIndicators = false;
            this.indicatorInstances = defaults.map((inst) => ({
              id: inst.id,
              ...(inst.inputs ? { inputs: { ...inst.inputs } } : {}),
            }));
            this.render();
          })
        );
    } else {
      // 添加指标: one dropdown grouped by category (builtins + customs) and
      // an add button, kept above the list; new instances start with
      // all-default inputs, land at the top of the list, and stay expanded.
      const controls = indDetails.createDiv("fc-indicator-controls");
      const select = controls.createEl("select");
      for (const [category, defs] of indicatorRegistry.listByCategory()) {
        const group = select.createEl("optgroup", { attr: { label: t(category) } });
        for (const def of defs) {
          group.createEl("option", { text: t(def.name), attr: { value: def.id } });
        }
      }
      const addBtn = controls.createEl("button", { text: t("添加") });
      addBtn.addEventListener("click", () => {
        if (!select.value) return;
        const instance: IndicatorInstance = { id: select.value };
        this.expandedIndicators.add(instance);
        this.indicatorInstances.unshift(instance);
        this.render();
      });

      if (this.indicatorInstances.length === 0) {
        indDetails.createDiv({
          cls: "fc-field-hint fc-hint-mb",
          text: t("本卡不显示任何指标。点击上方「添加」添加指标。"),
        });
      }
      this.indicatorInstances.forEach((instance, index) => {
        this.renderIndicatorInstance(indDetails, instance, index);
      });
    }

    // ---- 信号标注 ----
    // The switch mirrors whether a signals source (script signal table) is
    // picked; the code input overrides which symbol's events to draw (blank =
    // the card's own code).
    const signalSources = this.options.signalSources ?? [];
    const sigDetails = pageEl.createEl("details", { cls: "fc-settings-sub fc-indicator" });
    const sigSummary = sigDetails.createEl("summary");
    sigSummary.createSpan({ cls: "fc-indicator-title", text: t("信号标注") });
    sigDetails.open = this.signalSourceId !== "";

    let sigDropdown: DropdownComponent | null = null;
    let codeText: TextComponent | null = null;
    const sigToggle = new ToggleComponent(sigSummary)
      .setValue(this.signalSourceId !== "")
      .onChange((value) => {
        sigDetails.open = value;
        if (value) {
          // Enabling with nothing picked: default to the first signals source.
          if (!this.signalSourceId && signalSources.length > 0) {
            this.signalSourceId = signalSources[0].id;
            sigDropdown?.setValue(this.signalSourceId);
          }
        } else {
          this.signalSourceId = "";
          sigDropdown?.setValue("");
        }
        codeText?.setDisabled(!this.signalSourceId);
      });
    sigToggle.toggleEl.addEventListener("click", (event) => event.preventDefault());

    sigDetails.createDiv({
      cls: "fc-field-hint fc-hint-mb",
      text: signalSources.length > 0
        ? t("把脚本产物信号表的买卖点标到 K 线上；代码留空则跟随本卡标的。")
        : t("暂无信号源：脚本产物信号表（date,code,side,text）会先注册为信号源。"),
    });
    const controls = sigDetails.createDiv("fc-indicator-controls");
    sigDropdown = new DropdownComponent(controls);
    sigDropdown.addOption("", t("无"));
    for (const def of signalSources) {
      sigDropdown.addOption(def.id, def.name);
    }
    // Referenced source no longer configured: keep it visible so the value is
    // never silently dropped.
    if (this.signalSourceId && !signalSources.some((def) => def.id === this.signalSourceId)) {
      sigDropdown.addOption(this.signalSourceId, `${this.signalSourceId}${t("（不可用）")}`);
    }
    sigDropdown.setValue(this.signalSourceId).onChange((value) => {
      this.signalSourceId = value;
      sigToggle.setValue(value !== "");
      codeText?.setDisabled(!value);
    });
    codeText = new TextComponent(controls)
      .setPlaceholder(t("代码（留空=本卡代码）"))
      .setValue(this.signalCode)
      .setDisabled(!this.signalSourceId)
      .onChange((value) => {
        this.signalCode = value;
      });
    codeText.inputEl.addClass("fc-mono");

    // Parameter explanations (参数说明) collapse to hover ⓘ icons; the
    // instance header rows opt out via fc-keep-desc (their desc is content).
    applyInfoDescs(pageEl);
  }

  // One collapsible indicator instance: the <summary> header row shows the
  // display name (失效 tag when the registry no longer resolves the id), the
  // overridden-inputs summary, and the 上移/下移/隐藏/删除 controls; the
  // auto-generated parameter form lives in the collapsible body. Collapsed by
  // default; expansion state is tracked in this.expandedIndicators so a
  // form-change re-render keeps it.
  private renderIndicatorInstance(containerEl: HTMLElement, instance: IndicatorInstance, index: number) {
    const def = indicatorRegistry.resolve(instance.id);
    const block = containerEl.createEl("details", { cls: "fc-indicator-instance" });
    block.open = this.expandedIndicators.has(instance);
    block.toggleClass("fc-indicator-hidden", instance.hidden === true);
    block.addEventListener("toggle", () => {
      if (block.open) {
        this.expandedIndicators.add(instance);
      } else {
        this.expandedIndicators.delete(instance);
      }
    });
    const summary = block.createEl("summary", { cls: "fc-indicator-instance-summary" });
    // The collapse triangle is an explicit fixed-width span (not a ::before
    // border triangle) so the header text offset is deterministic and the
    // parameter rows below can be padded to the exact same left edge.
    summary.createSpan({ cls: "fc-indicator-tri" });
    const row = new Setting(summary);
    // The header desc carries content (the current parameters), not an
    // explanation — keep it visible instead of an info-icon tooltip.
    row.settingEl.addClass("fc-keep-desc");
    const updateSummary = () => {
      const desc = describeIndicatorInputs(instance, def);
      row.setDesc(instance.hidden ? `${t("已隐藏")} · ${desc}` : desc);
    };
    row.setName(def ? t(def.name) : `${instance.id}${t("（失效）")}`);
    updateSummary();
    // All header controls live inside the <summary> — their clicks must not
    // toggle the collapse.
    const onControlClick = (btn: { extraSettingsEl?: HTMLElement; buttonEl?: HTMLElement }, handler: () => void) => {
      const el = btn.extraSettingsEl ?? btn.buttonEl;
      el?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handler();
      });
    };
    row.addExtraButton((btn) => {
      btn.setIcon("arrow-up").setTooltip(t("上移"));
      if (index === 0) btn.setDisabled(true);
      onControlClick(btn, () => {
        if (index === 0) return;
        [this.indicatorInstances[index - 1], this.indicatorInstances[index]] = [
          this.indicatorInstances[index],
          this.indicatorInstances[index - 1],
        ];
        this.render();
      });
    });
    row.addExtraButton((btn) => {
      btn.setIcon("arrow-down").setTooltip(t("下移"));
      if (index === this.indicatorInstances.length - 1) btn.setDisabled(true);
      onControlClick(btn, () => {
        if (index >= this.indicatorInstances.length - 1) return;
        [this.indicatorInstances[index], this.indicatorInstances[index + 1]] = [
          this.indicatorInstances[index + 1],
          this.indicatorInstances[index],
        ];
        this.render();
      });
    });
    row.addExtraButton((btn) => {
      btn.setIcon(instance.hidden ? "eye-off" : "eye").setTooltip(instance.hidden ? t("显示指标") : t("隐藏指标"));
      onControlClick(btn, () => {
        if (instance.hidden) {
          delete instance.hidden;
        } else {
          instance.hidden = true;
        }
        this.render();
      });
    });
    row.addButton((btn) => {
      btn.setButtonText(t("删除"));
      onControlClick(btn, () => {
        this.indicatorInstances.splice(index, 1);
        this.render();
      });
    });
    if (!def) return;
    const body = block.createDiv("fc-indicator-instance-body");
    for (const cfg of def.inputConfig) {
      this.renderIndicatorInput(body, instance, def, cfg, updateSummary);
    }
  }

  // Parameter control for one inputConfig entry. Values write into
  // instance.inputs keyed by cfg.id; an empty/unset control deletes the key
  // so the effective default (indicator defval + the settings-level 内置指标
  // override) applies.
  private renderIndicatorInput(
    containerEl: HTMLElement,
    instance: IndicatorInstance,
    def: IndicatorDef,
    cfg: InputConfig,
    updateSummary: () => void
  ) {
    renderIndicatorInputRow(containerEl, cfg, {
      value: instance.inputs?.[cfg.id],
      defval: this.options.builtinIndicatorInputs?.[def.id]?.[cfg.id] ?? cfg.defval,
      doc: getIndicatorParamDoc(def, cfg),
      onChange: (value) => {
        if (value === undefined) {
          if (instance.inputs) {
            delete instance.inputs[cfg.id];
            if (Object.keys(instance.inputs).length === 0) instance.inputs = undefined;
          }
        } else {
          instance.inputs = { ...instance.inputs, [cfg.id]: value };
        }
        updateSummary();
      },
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
      // undefined = follow the global default (key dropped by the
      // serializer); [] = explicitly no indicators.
      indicators: this.inheritIndicators ? undefined : this.indicatorInstances,
      signal: this.signalSourceId
        ? { sourceId: this.signalSourceId, ...(this.signalCode.trim() ? { code: this.signalCode.trim() } : {}) }
        : undefined,
      // Canvas display fields persist only when they differ from defaults.
      widthAuto: this.widthAuto ? undefined : false,
      heightAuto: this.heightAuto ? undefined : false,
      bleed: this.bleed === DEFAULT_CARD_BLEED ? undefined : this.bleed,
      // 图表设置 overrides: undefined fields are dropped by the serializer.
      ...this.displayOverrides,
    };
  }
}
