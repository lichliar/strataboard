import { App, DropdownComponent, Modal, Notice, Setting } from "obsidian";
import {
  type ChartTheme,
  type ChartType,
  type CustomSourceDef,
  type DisplayOverrides,
  type Freq,
  type IndicatorGroup,
  type IndicatorInstance,
  type ParsedCardSpec,
  type RangePreset,
  type SymbolItem,
} from "../types";
import { isDateRangeString } from "../utils/date";
import { FREQ_BADGE, freqRank } from "../utils/frequency";
import { renderDisplayOverrideSettings } from "./display-overrides";
import { IndicatorListEditor } from "./indicator-instance-list";
import { applyInfoDescs } from "./info-desc";
import { createSubTabs } from "./sub-tabs";
import { t } from "../i18n";

// Unified asset-card editor (wireframe #screen-unified): one modal for quote
// cards backed by a custom data source. Top-level tabs: 数据 (数据源 dropdown
// + 代码/周期/范围) / 图层 (成交量 + 指标组 + 指标列表) / 外观.

export interface UnifiedCardEditModalOptions {
  /** Resolved spec of the card being edited; absent = fresh card. */
  spec?: ParsedCardSpec;
  /** Native frequency of the card's data; finer 周期 options are disabled. */
  minFreq?: Freq;
  /** Symbol picker bound to the current custom source. */
  openSymbolPicker: (onSelect: (item: SymbolItem) => void, sourceId?: string) => void;
  /** Enabled custom sources, listed in the 数据源 dropdown. */
  customSources: CustomSourceDef[];
  /** Indicator groups (设置 → 指标 → 指标组); when non-empty the 指标
   * section shows a one-click apply row. Applied groups expand into plain
   * per-card instances — the card never references the group. */
  indicatorGroups?: IndicatorGroup[];
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

type TopTab = "data" | "layers" | "appearance";

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
  private chartType: ChartType;
  private theme: ChartTheme;
  private logScale: boolean;
  private showHeader: boolean;
  private showVolume: boolean;
  // Blank = automatic Canvas height; a number = fixed chart height in px.
  private height: string;
  // Per-card instances of user-provided indicators.
  private indicatorInstances: IndicatorInstance[];

  // Per-card 图表设置 overrides (undefined = follow the plugin-wide 显示设置).
  private displayOverrides: DisplayOverrides;

  private activeTab: TopTab = "data";

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
    this.chartType = spec?.chartType ?? "candlestick";
    this.theme = spec?.theme ?? "auto";
    this.logScale = spec?.logScale ?? false;
    this.showHeader = spec?.showHeader ?? true;
    this.showVolume = spec?.showVolume ?? true;
    this.height = spec?.height == null ? "" : String(spec.height);
    // Clone so editing an instance never mutates the caller's spec object.
    this.indicatorInstances = (spec?.indicators ?? []).map((inst) => ({
      id: inst.id,
      ...(inst.inputs ? { inputs: { ...inst.inputs } } : {}),
      ...(inst.hidden ? { hidden: true } : {}),
      ...(inst.group ? { group: inst.group } : {}),
    }));

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

    // Top-level tabs: 数据 / 图层 / 外观. The active id survives the full
    // re-render after every form change via this.activeTab.
    const subTabs = createSubTabs<TopTab>(
      contentEl,
      [
        { id: "data", label: "数据" },
        { id: "layers", label: "图层" },
        { id: "appearance", label: "外观" },
      ],
      {
        initial: this.activeTab,
        onActivate: (id) => {
          this.activeTab = id;
        },
      }
    );

    this.renderDataPage(subTabs.page("data"));
    this.renderLayersPage(subTabs.page("layers"));
    this.renderAppearancePage(subTabs.page("appearance"));

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
  }

  // ==================== 数据 ====================

  private renderDataPage(pageEl: HTMLElement) {
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

  // ==================== 外观 ====================

  private renderAppearancePage(pageEl: HTMLElement) {
    new Setting(pageEl)
      .setName(t("图表高度"))
      .setDesc(t("留空时自动匹配 Canvas 卡片高度；填写 200–1600 的像素值可手动固定高度。"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "200";
        text.inputEl.max = "1600";
        text.inputEl.step = "10";
        text.inputEl.addClass("fc-card-height-input");
        text.setPlaceholder(t("自动匹配 Canvas")).setValue(this.height).onChange((value) => {
          this.height = value.trim();
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

    new Setting(pageEl).setName(t("对数坐标")).addToggle((toggle) =>
      toggle.setValue(this.logScale).onChange((value) => {
        this.logScale = value;
      })
    );

    new Setting(pageEl).setName(t("主题")).addDropdown((dropdown) => {
      for (const option of THEME_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.theme).onChange((value) => {
        this.theme = value as ChartTheme;
      });
    });

    new Setting(pageEl).setName(t("显示标题")).addToggle((toggle) =>
      toggle.setValue(this.showHeader).onChange((value) => {
        this.showHeader = value;
      })
    );

    // 图表设置 collapsible: per-card overrides of the plugin-wide 显示设置
    // (K-line cards have no latest-value/point-marker options, hence series:
    // false; indicator selection lives in 图层).
    const chartDetails = pageEl.createEl("details", { cls: "fc-settings-sub" });
    chartDetails.createEl("summary", { text: t("图表设置（覆盖全局）") });
    renderDisplayOverrideSettings(chartDetails, this.displayOverrides, { series: false });
  }

  // ==================== 图层 ====================

  private renderLayersPage(pageEl: HTMLElement) {
    new Setting(pageEl)
      .setName(t("显示成交量"))
      .setDesc(t("主图下方的成交量副图。"))
      .addToggle((toggle) =>
        toggle.setValue(this.showVolume).onChange((value) => {
          this.showVolume = value;
        })
      );

    // ---- 指标 ----
    const indDetails = pageEl.createEl("details", { cls: "fc-settings-sub fc-indicator" });
    indDetails.open = true;
    const indSummary = indDetails.createEl("summary");
    indSummary.createSpan({ cls: "fc-indicator-title", text: t("指标") });

    // 指标组 one-click apply (设置 → 指标 → 指标组), visible in both the
    // inherit and the custom-list mode; hidden entirely when no group exists.
    const groups = this.options.indicatorGroups ?? [];
    if (groups.length > 0) {
      let selectedGroupId = groups[0].id;
      new Setting(indDetails)
        .setName(t("指标组"))
        .setDesc(t("把指标组的指标一键展开到本卡指标列表；展开后与组不再关联。"))
        .addDropdown((dropdown) => {
          for (const group of groups) {
            dropdown.addOption(group.id, `${group.name}（${t("{n} 个指标", { n: group.indicators.length })}）`);
          }
          dropdown.setValue(selectedGroupId).onChange((value) => {
            selectedGroupId = value;
          });
        })
        .addButton((btn) =>
          btn.setButtonText(t("应用")).onClick(() => this.applyIndicatorGroup(selectedGroupId))
        );
    }

    new IndicatorListEditor({
      app: this.app,
      instances: this.indicatorInstances,
      onChanged: () => this.render(),
    }).render(indDetails);

    if (this.indicatorInstances.length === 0) {
      indDetails.createDiv({
        cls: "fc-field-hint fc-hint-mb",
        text: t("本卡不显示任何指标。点击上方「添加」添加指标。"),
      });
    }

    // Parameter explanations (参数说明) collapse to hover ⓘ icons; the
    // instance header rows opt out via fc-keep-desc (their desc is content).
    applyInfoDescs(pageEl);
  }

  // Apply an indicator group: expand its instances into the per-card list
  // (deep copies — the card never shares objects with the settings-level
  // group). With an empty effective list this simply becomes the card's list;
  // otherwise the user picks 追加 (append after the current list, the default
  // Always appends a fresh card-local group; existing groups remain intact.
  private applyIndicatorGroup(groupId: string) {
    const group = (this.options.indicatorGroups ?? []).find((g) => g.id === groupId);
    if (!group) return;
    const existingNames = new Set(this.indicatorInstances.map((instance) => instance.group).filter(Boolean));
    let cardGroupName = group.name;
    let copy = 1;
    while (existingNames.has(cardGroupName)) {
      copy++;
      cardGroupName = `${group.name} (${copy})`;
    }
    const clone = (inst: IndicatorInstance): IndicatorInstance => ({
      id: inst.id,
      ...(inst.inputs ? { inputs: { ...inst.inputs } } : {}),
      ...(inst.hidden ? { hidden: true } : {}),
      group: cardGroupName,
    });
    this.indicatorInstances = [...this.indicatorInstances, ...group.indicators.map(clone)];
    this.render();
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

    const base = this.options.spec;
    let height: number | undefined;
    if (this.height) {
      const parsedHeight = Number(this.height);
      if (!Number.isInteger(parsedHeight) || parsedHeight < 200 || parsedHeight > 1600) {
        new Notice(t("图表高度应为 200–1600 的整数（单位 px）。"));
        return null;
      }
      height = parsedHeight;
    }
    return {
      ...base,
      symbol: this.symbol.trim(),
      assetType: "custom",
      sourceId: this.customSourceId,
      freq: this.freq,
      range,
      version: base?.version ?? 1,
      chartType: this.chartType,
      theme: this.theme,
      logScale: this.logScale,
      showHeader: this.showHeader,
      showVolume: this.showVolume,
      height,
      indicators: this.indicatorInstances,
      // 图表设置 overrides: undefined fields are dropped by the serializer.
      ...this.displayOverrides,
    };
  }
}
