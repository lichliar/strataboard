import { Setting, type DropdownComponent } from "obsidian";
import { FRED_TRANSFORM_OPTIONS, MACRO_SERIES_OPTIONS, type AssetType, type CustomSourceDef, type FredSeriesInfo, type FredTransform, type ReferenceableCard, type ReferenceableCardKind, type SeriesRef, type SymbolItem } from "../types";
import { t } from "../i18n";

// Opens the symbol search modal; mirrors plugin.openSymbolSearch (including
// its Tushare-token guard). assetType restricts the picker to one 资产品类
// (the row's current quote type); for assetType "custom", sourceId selects
// the custom source (remote search or manual entry).
export type OpenSymbolPicker = (onSelect: (item: SymbolItem) => void, assetType?: AssetType, sourceId?: string) => void;

// Opens the FRED series search modal; mirrors plugin.openFredSearch
// (including its FRED-key guard).
export type OpenFredPicker = (onSelect: (info: FredSeriesInfo) => void) => void;

// Lists existing referenceable cards for the 已有卡片 dropdown (see
// ReferenceableCard in types.ts).
export type ListReferenceableCards = () => Promise<ReferenceableCard[]>;

// Which data sources the user has actually configured — the first column
// mirrors the toolbar 插入数据 source list, so unconfigured sources stay
// hidden. Callers compute this the same way as openUnifiedSearch.
export interface SeriesSourceAvailability {
  hasTushare: boolean;
  hasFred: boolean;
}

// The first-column 数据源 values: "tushare" covers every Tushare-backed
// series (the 11 quote asset types + 宏观数据, same as the unified search's
// Tushare category); each enabled custom source gets its own entry.
export type SeriesRowSource = "tushare" | "fred" | "card" | `custom:${string}`;

// Second-column type within Tushare rows: a quote asset type, or the 宏观数据
// pseudo-type (macro series are Tushare-backed too).
type TushareRowType = Exclude<AssetType, "custom"> | "macro";

const TUSHARE_TYPE_OPTIONS: { value: TushareRowType; label: string }[] = [
  { value: "stock", label: "股票" },
  { value: "fund", label: "基金" },
  { value: "ofund", label: "场外基金" },
  { value: "index", label: "指数" },
  { value: "nhindex", label: "南华指数" },
  { value: "hk", label: "港股" },
  { value: "gbindex", label: "全球指数" },
  { value: "cb", label: "可转债" },
  { value: "fut", label: "期货" },
  { value: "fx", label: "外汇" },
  { value: "sw", label: "申万行业" },
  { value: "macro", label: "宏观数据" },
];

/**
 * One series row in the overlay/spread edit modals: 数据源 dropdown (the
 * user's configured sources, mirroring the toolbar 插入数据 entry) + for
 * Tushare a 类型 dropdown (asset type or 宏观数据) + a code control (symbol
 * picker, macro dropdown, FRED picker, or card dropdown) + an optional 名称
 * input + an optional 删除 button. Re-renders its controls inside a stable
 * wrapper so row order is preserved when the source changes.
 *
 * allowCardRef=false removes the 已有卡片 option (used for a spread card's
 * own A/B legs, which reference raw series only).
 */
export class SeriesRefEditor {
  readonly el: HTMLElement;
  private source: SeriesRowSource;
  private quoteType: TushareRowType;
  private code: string;
  private macroId: string;
  private cardPath: string;
  private label: string;
  private units: string;
  private transform: FredTransform | "";
  private allowCardRef: boolean;
  private openSymbolPicker?: OpenSymbolPicker;
  private listReferenceableCards?: ListReferenceableCards;
  private openFredPicker?: OpenFredPicker;
  private customSources: CustomSourceDef[];
  private availability: SeriesSourceAvailability;
  private onRemove?: () => void;

  constructor(
    containerEl: HTMLElement,
    initial: SeriesRef,
    onRemove?: () => void,
    allowCardRef = true,
    openSymbolPicker?: OpenSymbolPicker,
    listReferenceableCards?: ListReferenceableCards,
    openFredPicker?: OpenFredPicker,
    customSources?: CustomSourceDef[],
    availability?: SeriesSourceAvailability
  ) {
    this.customSources = customSources ?? [];
    this.availability = availability ?? { hasTushare: true, hasFred: true };
    this.allowCardRef = allowCardRef;
    this.openSymbolPicker = openSymbolPicker;
    this.listReferenceableCards = listReferenceableCards;
    this.openFredPicker = openFredPicker;
    this.onRemove = onRemove;

    // Backfill the row state from the existing ref.
    this.quoteType = "stock";
    this.code = "";
    this.macroId = MACRO_SERIES_OPTIONS[0].id;
    this.cardPath = "";
    this.units = "";
    this.transform = "";
    if (initial.source === "quote") {
      if (initial.assetType === "custom") {
        this.source = `custom:${initial.sourceId ?? this.customSources[0]?.id ?? ""}`;
      } else {
        this.source = "tushare";
        this.quoteType = initial.assetType ?? "stock";
      }
      this.code = initial.tsCode ?? "";
    } else if (initial.source === "macro") {
      this.source = "tushare";
      this.quoteType = "macro";
      this.macroId = initial.seriesId ?? this.macroId;
    } else if (initial.source === "fred") {
      this.source = "fred";
      this.code = initial.seriesId ?? "";
      this.units = initial.units ?? "";
      this.transform = initial.transform ?? "";
    } else if (allowCardRef) {
      // Hand-written YAML may still carry a card leg where the UI forbids it
      // (allowCardRef=false) — that case falls through to the default source.
      this.source = "card";
      this.cardPath = initial.cardPath ?? "";
    } else {
      this.source = this.defaultSource();
    }
    this.label = initial.label ?? "";

    this.el = containerEl.createDiv({ cls: "fc-series-ref-editor" });
    this.renderControls();
  }

  private get sourceId(): string {
    return this.source.startsWith("custom:") ? this.source.slice("custom:".length) : "";
  }

  // First available source for a fresh row (or the fallback when a forbidden
  // card leg had to be dropped).
  private defaultSource(): SeriesRowSource {
    if (this.availability.hasTushare) return "tushare";
    if (this.availability.hasFred) return "fred";
    if (this.customSources.length > 0) return `custom:${this.customSources[0].id}`;
    return "tushare";
  }

  // First-column options: the user's configured sources. A source the current
  // row references but which is no longer configured (token removed, source
  // deleted) is appended as a disabled-looking fallback so the existing value
  // is never silently dropped.
  private sourceOptions(): { value: SeriesRowSource; label: string }[] {
    const options: { value: SeriesRowSource; label: string }[] = [];
    if (this.availability.hasTushare || this.source === "tushare") {
      options.push({ value: "tushare", label: "Tushare" });
    }
    if (this.availability.hasFred || this.source === "fred") {
      options.push({ value: "fred", label: "FRED" });
    }
    for (const def of this.customSources) {
      options.push({ value: `custom:${def.id}`, label: def.name });
    }
    if (this.source.startsWith("custom:") && !this.customSources.some((def) => def.id === this.sourceId)) {
      options.push({ value: this.source, label: `${this.sourceId}${t("（不可用）")}` });
    }
    if (this.allowCardRef || this.source === "card") {
      options.push({ value: "card", label: t("已有卡片") });
    }
    return options;
  }

  private renderControls() {
    this.el.empty();
    const setting = new Setting(this.el).setClass("fc-series-ref-row");

    setting.addDropdown((dropdown) => {
      for (const option of this.sourceOptions()) {
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.source).onChange((value) => {
        this.source = value as SeriesRowSource;
        // Clear source-specific values so a stale pick can never survive a
        // source switch (e.g. a picked stock code must not survive
        // Tushare→FRED). macroId stays: it is a constrained dropdown, always
        // valid.
        this.code = "";
        this.cardPath = "";
        this.units = "";
        this.transform = "";
        this.renderControls();
      });
    });

    if (this.source === "tushare") {
      setting.addDropdown((dropdown) => {
        for (const option of TUSHARE_TYPE_OPTIONS) {
          dropdown.addOption(option.value, t(option.label));
        }
        dropdown.setValue(this.quoteType).onChange((value) => {
          this.quoteType = value as TushareRowType;
          this.code = "";
          this.renderControls();
        });
      });
      if (this.quoteType === "macro") {
        this.addMacroDropdown(setting);
      } else {
        this.addQuotePicker(setting, this.quoteType);
      }
    } else if (this.source === "fred") {
      this.addFredControls(setting);
    } else if (this.source === "card") {
      setting.addDropdown((dropdown) => {
        // Loading placeholder; the async provider fills the real options in.
        dropdown.addOption("", t("正在加载卡片列表…"));
        dropdown.setValue("");
        dropdown.setDisabled(true);
        dropdown.onChange((value) => {
          this.cardPath = value;
        });
        void this.populateCardDropdown(dropdown);
      });
    } else {
      // custom:<id> — the source is fixed by the first column, so the code
      // picker binds to it directly.
      this.addQuotePicker(setting, "custom");
    }

    setting.addText((text) =>
      text
        .setPlaceholder(t("名称（可选）"))
        .setValue(this.label)
        .onChange((value) => {
          this.label = value;
        })
    );

    if (this.onRemove) {
      setting.addButton((btn) =>
        btn.setButtonText(t("删除")).onClick(() => this.onRemove?.())
      );
    }
  }

  // 宏观数据 series picker: grouped by 类别 (货币供应 / 物价 / 景气 / GDP /
  // 社融 / 利率) via optgroups; DropdownComponent has no optgroup API, so
  // build the options on selectEl directly.
  private addMacroDropdown(setting: Setting) {
    setting.addDropdown((dropdown) => {
      const groups = new Map<string, typeof MACRO_SERIES_OPTIONS>();
      for (const option of MACRO_SERIES_OPTIONS) {
        const list = groups.get(option.group) ?? [];
        list.push(option);
        groups.set(option.group, list);
      }
      for (const [group, options] of groups) {
        const optgroup = dropdown.selectEl.createEl("optgroup", { attr: { label: t(group) } });
        for (const option of options) {
          optgroup.createEl("option", { value: option.id, text: t(option.label) });
        }
      }
      dropdown.setValue(this.macroId).onChange((value) => {
        this.macroId = value;
      });
    });
  }

  private addFredControls(setting: Setting) {
    if (this.openFredPicker) {
      // Same read-only picker input as quote rows: click/Enter/Space opens
      // the FRED series search modal instead of typing a series id.
      setting.addText((text) => {
        text.setPlaceholder(t("点击选择 FRED 系列")).setValue(this.code);
        text.inputEl.readOnly = true;
        const openPicker = () => {
          this.openFredPicker?.((info) => {
            this.code = info.id;
            this.units = info.units;
            if (!this.label.trim()) {
              this.label = info.title;
            }
            this.renderControls();
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
    } else {
      // Fallback when no FRED picker was provided: plain editable input.
      setting.addText((text) =>
        text
          .setPlaceholder("如 DGS10")
          .setValue(this.code)
          .onChange((value) => {
            this.code = value;
          })
      );
    }
    // FRED-only: server-side units transformation (同比/环比…), raw levels
    // by default.
    setting.addDropdown((dropdown) => {
      dropdown.addOption("", t("原始值"));
      for (const option of FRED_TRANSFORM_OPTIONS) {
        dropdown.addOption(option.value, t(option.label));
      }
      dropdown.setValue(this.transform).onChange((value) => {
        this.transform = value as FredTransform | "";
      });
      dropdown.selectEl.title = t("数据变换（FRED 服务端计算）");
    });
  }

  // Quote rows pick an asset from the symbol search modal (the same fuzzy
  // picker as 插入资产数据; custom sources get their own remote-search /
  // manual-entry modal) instead of typing a ts_code.
  private addQuotePicker(setting: Setting, assetType: AssetType) {
    if (this.openSymbolPicker) {
      setting.addText((text) => {
        text.setPlaceholder(t("点击选择资产")).setValue(this.code);
        text.inputEl.readOnly = true;
        const openPicker = () => {
          // Restrict the picker to the row's current type so it can never
          // mix categories; custom rows are bound to their fixed sourceId.
          this.openSymbolPicker?.((item) => {
            this.code = item.tsCode;
            if (!this.label.trim()) {
              this.label = item.name;
            }
            this.renderControls();
          }, assetType, assetType === "custom" ? this.sourceId : undefined);
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
    } else {
      // Fallback when no symbol picker was provided: plain editable input.
      setting.addText((text) =>
        text
          .setPlaceholder("如 600519.SH")
          .setValue(this.code)
          .onChange((value) => {
            this.code = value;
          })
      );
    }
  }

  // Fills the 已有卡片 dropdown once the provider resolves, grouped by card
  // type (DropdownComponent has no optgroup API, so options are built on
  // selectEl directly, same as the macro dropdown). The row may have been
  // re-rendered (source switch, modal closed) while loading — bail out if
  // the dropdown is no longer in the document.
  private async populateCardDropdown(dropdown: DropdownComponent) {
    let cards: ReferenceableCard[] = [];
    try {
      cards = (await this.listReferenceableCards?.()) ?? [];
    } catch (e) {
      console.error("SeriesRefEditor: failed to list referenceable cards", e);
    }
    if (!dropdown.selectEl.isConnected) return;

    dropdown.selectEl.empty();
    if (cards.length === 0) {
      dropdown.addOption("", t("暂无可引用的卡片"));
      dropdown.setValue("");
      this.cardPath = "";
      return;
    }
    const groups: { kind: ReferenceableCardKind; label: string }[] = [
      { kind: "tushare", label: "资产卡" },
      { kind: "fred", label: "FRED 卡" },
      { kind: "macro", label: "宏观卡" },
      { kind: "spread", label: "计算卡" },
    ];
    for (const group of groups) {
      const members = cards.filter((card) => card.kind === group.kind);
      if (members.length === 0) continue;
      const optgroup = dropdown.selectEl.createEl("optgroup", { attr: { label: t(group.label) } });
      for (const card of members) {
        optgroup.createEl("option", { value: card.path, text: card.name });
      }
    }
    const selected = cards.some((c) => c.path === this.cardPath) ? this.cardPath : cards[0].path;
    dropdown.setValue(selected);
    this.cardPath = selected;
    dropdown.setDisabled(false);
  }

  // Builds the SeriesRef from the current row state.
  toRef(): SeriesRef {
    let ref: SeriesRef;
    if (this.source === "card") {
      ref = { source: "card", cardPath: this.cardPath };
    } else if (this.source === "fred") {
      ref = { source: "fred", seriesId: this.code.trim() };
      const units = this.units.trim();
      if (units) {
        ref.units = units;
      }
      if (this.transform) {
        ref.transform = this.transform;
      }
    } else if (this.source === "tushare") {
      if (this.quoteType === "macro") {
        ref = { source: "macro", seriesId: this.macroId };
      } else {
        ref = { source: "quote", tsCode: this.code.trim(), assetType: this.quoteType };
      }
    } else {
      ref = { source: "quote", tsCode: this.code.trim(), assetType: "custom" };
      if (this.sourceId) {
        ref.sourceId = this.sourceId;
      }
    }
    const label = this.label.trim();
    if (label) {
      ref.label = label;
    }
    return ref;
  }

  // Returns a translated error message, or null when the row is valid.
  validate(): string | null {
    if (this.source === "card") {
      return this.cardPath ? null : t("请选择要引用的卡片。");
    }
    if (this.source === "fred") {
      return this.code.trim() ? null : t("请填写 FRED 系列代码（如 DGS10）。");
    }
    if (this.source === "tushare") {
      if (this.quoteType === "macro") return null;
      // Global-index ts_codes are bare (HSI, XIN9) — the ".XX" suffix is not
      // required.
      return /^\w+(\.\w+)?$/.test(this.code.trim()) ? null : t("请填写有效的证券代码（如 600519.SH、HSI）。");
    }
    if (!this.sourceId) {
      return t("请选择自定义数据源（可在设置页添加）。");
    }
    // Custom-source codes are free-form (composite "URL部分@映射部分" report
    // codes like 东财 datacenter, endpoint-specific ids) — non-empty only.
    return this.code.trim() ? null : t("请填写代码。");
  }
}
