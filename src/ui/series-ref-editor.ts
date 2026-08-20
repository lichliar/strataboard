import { Setting, type DropdownComponent } from "obsidian";
import { FRED_TRANSFORM_OPTIONS, MACRO_SERIES_OPTIONS, type AssetType, type FredSeriesInfo, type FredTransform, type SeriesRef, type SymbolItem } from "../types";

// Opens the unified symbol search modal; mirrors plugin.openSymbolSearch
// (including its Tushare-token guard). assetType restricts the picker to one
// 资产品类 (the row's current quote type).
export type OpenSymbolPicker = (onSelect: (item: SymbolItem) => void, assetType?: AssetType) => void;

// Opens the FRED series search modal; mirrors plugin.openFredSearch
// (including its FRED-key guard).
export type OpenFredPicker = (onSelect: (info: FredSeriesInfo) => void) => void;

// Lists existing spread cards for the 已有卡片 dropdown (path = vault-relative
// file path, name = display name).
export type ListSpreadCards = () => Promise<{ path: string; name: string }[]>;

// The 类型 dropdown values: the twelve AssetTypes map to a quote ref with
// that assetType (tx/em open the remote search picker instead of the local
// symbol index); macro/fred/card map to their own sources.
export type SeriesRowType = AssetType | "macro" | "fred" | "card";

const TYPE_OPTIONS: { value: SeriesRowType; label: string }[] = [
  { value: "stock", label: "股票" },
  { value: "fund", label: "基金" },
  { value: "index", label: "指数" },
  { value: "nhindex", label: "南华指数" },
  { value: "hk", label: "港股" },
  { value: "gbindex", label: "全球指数" },
  { value: "cb", label: "可转债" },
  { value: "fut", label: "期货" },
  { value: "fx", label: "外汇" },
  { value: "sw", label: "申万行业" },
  { value: "tx", label: "腾讯行情" },
  { value: "em", label: "东方财富" },
  { value: "macro", label: "宏观数据" },
  { value: "fred", label: "FRED" },
  { value: "card", label: "已有卡片" },
];

/**
 * One series row in the overlay/spread edit modals: 类型 dropdown + a code
 * input (FRED series id), a symbol-search picker input (quote), a macro-series
 * dropdown, or an existing-spread-card dropdown (card) + an optional 名称
 * input + an optional 删除 button. Re-renders its controls inside a stable
 * wrapper so row order is preserved when the type changes.
 *
 * allowCardRef=false removes the 已有卡片 option (used for a spread card's
 * own A/B legs, which reference raw series only).
 */
export class SeriesRefEditor {
  readonly el: HTMLElement;
  private type: SeriesRowType;
  private code: string;
  private macroId: string;
  private cardPath: string;
  private label: string;
  private units: string;
  private transform: FredTransform | "";
  private allowCardRef: boolean;
  private openSymbolPicker?: OpenSymbolPicker;
  private listSpreadCards?: ListSpreadCards;
  private openFredPicker?: OpenFredPicker;
  private onRemove?: () => void;

  constructor(
    containerEl: HTMLElement,
    initial: SeriesRef,
    onRemove?: () => void,
    allowCardRef = true,
    openSymbolPicker?: OpenSymbolPicker,
    listSpreadCards?: ListSpreadCards,
    openFredPicker?: OpenFredPicker
  ) {
    this.type = initial.source === "quote" ? initial.assetType ?? "stock" : initial.source;
    if (this.type === "card" && !allowCardRef) {
      // Hand-written YAML may still carry a card leg where the UI forbids it.
      this.type = "stock";
    }
    this.code =
      initial.source === "quote"
        ? initial.tsCode ?? ""
        : initial.source === "fred"
          ? initial.seriesId ?? ""
          : "";
    this.macroId = initial.source === "macro" ? initial.seriesId ?? MACRO_SERIES_OPTIONS[0].id : MACRO_SERIES_OPTIONS[0].id;
    this.cardPath = initial.source === "card" ? initial.cardPath ?? "" : "";
    this.label = initial.label ?? "";
    this.units = initial.source === "fred" ? initial.units ?? "" : "";
    this.transform = initial.source === "fred" ? initial.transform ?? "" : "";
    this.allowCardRef = allowCardRef;
    this.openSymbolPicker = openSymbolPicker;
    this.listSpreadCards = listSpreadCards;
    this.openFredPicker = openFredPicker;
    this.onRemove = onRemove;
    this.el = containerEl.createDiv({ cls: "fc-series-ref-editor" });
    this.renderControls();
  }

  private renderControls() {
    this.el.empty();
    const setting = new Setting(this.el).setClass("fc-series-ref-row");

    setting.addDropdown((dropdown) => {
      for (const option of TYPE_OPTIONS) {
        if (option.value === "card" && !this.allowCardRef) continue;
        dropdown.addOption(option.value, option.label);
      }
      dropdown.setValue(this.type).onChange((value) => {
        this.type = value as SeriesRowType;
        // Clear source-specific values so a stale pick can never survive a
        // type switch (e.g. a picked stock code must not survive 股票→指数).
        // macroId stays: it is a constrained dropdown, always valid.
        this.code = "";
        this.cardPath = "";
        this.units = "";
        this.transform = "";
        this.renderControls();
      });
    });

    if (this.type === "macro") {
      setting.addDropdown((dropdown) => {
        // Grouped by 类别 (货币供应 / 物价 / 景气 / GDP / 社融 / 利率) via
        // optgroups; DropdownComponent has no optgroup API, so build the
        // options on selectEl directly.
        const groups = new Map<string, typeof MACRO_SERIES_OPTIONS>();
        for (const option of MACRO_SERIES_OPTIONS) {
          const list = groups.get(option.group) ?? [];
          list.push(option);
          groups.set(option.group, list);
        }
        for (const [group, options] of groups) {
          const optgroup = dropdown.selectEl.createEl("optgroup", { attr: { label: group } });
          for (const option of options) {
            optgroup.createEl("option", { value: option.id, text: option.label });
          }
        }
        dropdown.setValue(this.macroId).onChange((value) => {
          this.macroId = value;
        });
      });
    } else if (this.type === "fred") {
      if (this.openFredPicker) {
        // Same read-only picker input as quote rows: click/Enter/Space opens
        // the FRED series search modal instead of typing a series id.
        setting.addText((text) => {
          text.setPlaceholder("点击选择 FRED 系列").setValue(this.code);
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
        dropdown.addOption("", "原始值");
        for (const option of FRED_TRANSFORM_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown.setValue(this.transform).onChange((value) => {
          this.transform = value as FredTransform | "";
        });
        dropdown.selectEl.title = "数据变换（FRED 服务端计算）";
      });
    } else if (this.type === "card") {
      setting.addDropdown((dropdown) => {
        // Loading placeholder; the async provider fills the real options in.
        dropdown.addOption("", "正在加载卡片列表…");
        dropdown.setValue("");
        dropdown.setDisabled(true);
        dropdown.onChange((value) => {
          this.cardPath = value;
        });
        void this.populateCardDropdown(dropdown);
      });
    } else if (this.openSymbolPicker) {
      // Quote rows pick an asset from the unified symbol search modal (the
      // same fuzzy picker as 插入资产数据) instead of typing a ts_code.
      setting.addText((text) => {
        text.setPlaceholder("点击选择资产").setValue(this.code);
        text.inputEl.readOnly = true;
        const openPicker = () => {
          // this.type is a quote asset type in this branch; restrict the
          // picker to it so the row can never mix categories.
          this.openSymbolPicker?.((item) => {
            this.type = item.assetType;
            this.code = item.tsCode;
            if (!this.label.trim()) {
              this.label = item.name;
            }
            this.renderControls();
          }, this.type as AssetType);
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

    setting.addText((text) =>
      text
        .setPlaceholder("名称（可选）")
        .setValue(this.label)
        .onChange((value) => {
          this.label = value;
        })
    );

    if (this.onRemove) {
      setting.addButton((btn) =>
        btn.setButtonText("删除").onClick(() => this.onRemove?.())
      );
    }
  }

  // Fills the 已有卡片 dropdown once the provider resolves. The row may have
  // been re-rendered (type switch, modal closed) while loading — bail out if
  // the dropdown is no longer in the document.
  private async populateCardDropdown(dropdown: DropdownComponent) {
    let cards: { path: string; name: string }[] = [];
    try {
      cards = (await this.listSpreadCards?.()) ?? [];
    } catch (e) {
      console.error("SeriesRefEditor: failed to list spread cards", e);
    }
    if (!dropdown.selectEl.isConnected) return;

    dropdown.selectEl.empty();
    if (cards.length === 0) {
      dropdown.addOption("", "暂无数据计算卡片");
      dropdown.setValue("");
      this.cardPath = "";
      return;
    }
    for (const card of cards) {
      dropdown.addOption(card.path, card.name);
    }
    const selected = cards.some((c) => c.path === this.cardPath) ? this.cardPath : cards[0].path;
    dropdown.setValue(selected);
    this.cardPath = selected;
    dropdown.setDisabled(false);
  }

  // Builds the SeriesRef from the current row state.
  toRef(): SeriesRef {
    let ref: SeriesRef;
    if (this.type === "card") {
      ref = { source: "card", cardPath: this.cardPath };
    } else if (this.type === "macro") {
      ref = { source: "macro", seriesId: this.macroId };
    } else if (this.type === "fred") {
      ref = { source: "fred", seriesId: this.code.trim() };
      const units = this.units.trim();
      if (units) {
        ref.units = units;
      }
      if (this.transform) {
        ref.transform = this.transform;
      }
    } else {
      ref = { source: "quote", tsCode: this.code.trim(), assetType: this.type };
    }
    const label = this.label.trim();
    if (label) {
      ref.label = label;
    }
    return ref;
  }

  // Returns a Chinese error message, or null when the row is valid.
  validate(): string | null {
    if (this.type === "card") {
      return this.cardPath ? null : "请选择一个数据计算卡片。";
    }
    if (this.type === "macro") return null;
    const code = this.code.trim();
    if (this.type === "fred") {
      return code ? null : "请填写 FRED 系列代码（如 DGS10）。";
    }
    // Global-index ts_codes are bare (HSI, XIN9) — the ".XX" suffix is not
    // required.
    return /^\w+(\.\w+)?$/.test(code) ? null : "请填写有效的证券代码（如 600519.SH、HSI）。";
  }
}
