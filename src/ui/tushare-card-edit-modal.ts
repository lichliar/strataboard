import { App, Modal, Notice, Setting, type DropdownComponent } from "obsidian";
import type { ChartTheme, ChartType, Freq, ParsedCardSpec, RangePreset, VisibleRangePreset } from "../types";
import { isDateRangeString } from "../utils/date";
import { MIN_CARD_HEIGHT, MAX_CARD_HEIGHT, DEFAULT_CARD_HEIGHT } from "../modules/card-spec";

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

const RANGE_PRESET_VALUES = RANGE_OPTIONS.map((o) => o.value as string);

// Earliest year offered by the custom date-range pickers; matches the
// earliest data "max" resolves to in resolveDateRange().
const MIN_RANGE_YEAR = 1990;

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

/**
 * Property editor for tushare (asset data) cards, opened by double-clicking
 * the card. Edits every user-facing field of the card spec; the symbol and
 * asset type stay fixed (changing them means a different card).
 */
export class TushareCardEditModal extends Modal {
  private spec: ParsedCardSpec;
  private onSubmit: (spec: ParsedCardSpec) => void;

  // Editable state
  private freq: Freq;
  private rangePreset: RangePreset | "custom";
  private customStart: DateParts;
  private customEnd: DateParts;
  private customEndNow: boolean;
  private visibleRange: VisibleRangePreset | "";
  private height: number;
  private chartType: ChartType;
  private theme: ChartTheme;
  private riseColor: string;
  private fallColor: string;
  private logScale: boolean;
  private showHeader: boolean;
  private showMarketData: boolean;
  private paneRatios: string;

  constructor(app: App, spec: ParsedCardSpec, onSubmit: (spec: ParsedCardSpec) => void) {
    super(app);
    this.spec = spec;
    this.onSubmit = onSubmit;

    this.freq = spec.freq;
    this.rangePreset = RANGE_PRESET_VALUES.includes(spec.range) ? (spec.range as RangePreset) : "custom";
    const today = new Date();
    const todayParts: DateParts = { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };
    this.customStart = { ...todayParts, y: todayParts.y - 1 };
    this.customEnd = todayParts;
    this.customEndNow = true;
    if (this.rangePreset === "custom" && isDateRangeString(spec.range)) {
      const [start, end] = spec.range.split("~");
      this.customStart = parseDateParts(start);
      this.customEnd = parseDateParts(end);
      this.customEndNow = false;
    }
    this.visibleRange = spec.visibleRange ?? "";
    this.height = spec.height ?? DEFAULT_CARD_HEIGHT;
    this.chartType = spec.chartType ?? "candlestick";
    this.theme = spec.theme ?? "auto";
    this.riseColor = spec.riseColor ?? "#ef4444";
    this.fallColor = spec.fallColor ?? "#22c55e";
    this.logScale = spec.logScale ?? false;
    this.showHeader = spec.showHeader ?? true;
    this.showMarketData = spec.showMarketData ?? true;
    this.paneRatios = spec.paneRatios?.join(",") ?? "";

    this.setTitle(`编辑资产卡片：${spec.symbol}`);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl)
      .setName("图表类型")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("candlestick", "K 线图")
          .addOption("line", "折线图")
          .setValue(this.chartType)
          .onChange((value) => {
            this.chartType = value as ChartType;
          })
      );

    new Setting(contentEl)
      .setName("周期")
      .addDropdown((dropdown) => {
        for (const option of FREQ_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown.setValue(this.freq).onChange((value) => {
          this.freq = value as Freq;
        });
      });

    const customDropdowns: DropdownComponent[] = [];
    const customEndPartDropdowns: DropdownComponent[] = [];

    new Setting(contentEl)
      .setName("数据范围")
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

    const customSetting = new Setting(contentEl)
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

    new Setting(contentEl)
      .setName("可见范围")
      .setDesc("图表初始显示的时间窗口。")
      .addDropdown((dropdown) => {
        for (const option of VISIBLE_RANGE_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown.setValue(this.visibleRange).onChange((value) => {
          this.visibleRange = value as VisibleRangePreset | "";
        });
      });

    new Setting(contentEl)
      .setName("图表高度")
      .addSlider((slider) =>
        slider
          .setLimits(MIN_CARD_HEIGHT, MAX_CARD_HEIGHT, 50)
          .setValue(this.height)
          .setDynamicTooltip()
          .onChange((value) => {
            this.height = value;
          })
      );

    new Setting(contentEl)
      .setName("主题")
      .addDropdown((dropdown) => {
        for (const option of THEME_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown.setValue(this.theme).onChange((value) => {
          this.theme = value as ChartTheme;
        });
      });

    new Setting(contentEl)
      .setName("上涨颜色")
      .addColorPicker((picker) =>
        picker.setValue(this.riseColor).onChange((value) => {
          this.riseColor = value;
        })
      );

    new Setting(contentEl)
      .setName("下跌颜色")
      .addColorPicker((picker) =>
        picker.setValue(this.fallColor).onChange((value) => {
          this.fallColor = value;
        })
      );

    new Setting(contentEl)
      .setName("对数坐标")
      .addToggle((toggle) =>
        toggle.setValue(this.logScale).onChange((value) => {
          this.logScale = value;
        })
      );

    new Setting(contentEl)
      .setName("显示标题")
      .addToggle((toggle) =>
        toggle.setValue(this.showHeader).onChange((value) => {
          this.showHeader = value;
        })
      );

    new Setting(contentEl)
      .setName("显示市场数据")
      .setDesc("市值、市盈率、量比等一行数据；仅对股票生效。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.showMarketData)
          .setDisabled(this.spec.assetType !== "stock")
          .onChange((value) => {
            this.showMarketData = value;
          })
      );

    new Setting(contentEl)
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

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("保存")
        .setCta()
        .onClick(() => {
          const next = this.validateAndBuild();
          if (!next) return;
          this.close();
          this.onSubmit(next);
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }

  private validateAndBuild(): ParsedCardSpec | null {
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

    let paneRatios: number[] | undefined;
    if (this.paneRatios.length > 0) {
      const parsed = parsePaneRatios(this.paneRatios);
      if (!parsed) {
        new Notice("面板比例格式应为两个以上的正数，例如 3,1。");
        return null;
      }
      paneRatios = parsed;
    }

    return {
      ...this.spec,
      freq: this.freq,
      range,
      visibleRange: this.visibleRange === "" ? undefined : this.visibleRange,
      height: this.height,
      chartType: this.chartType,
      theme: this.theme,
      riseColor: this.riseColor,
      fallColor: this.fallColor,
      logScale: this.logScale,
      showHeader: this.showHeader,
      showMarketData: this.showMarketData,
      paneRatios,
    };
  }
}
