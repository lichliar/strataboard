import { Setting, type DropdownComponent } from "obsidian";
import { type CustomSourceDef, type ReferenceableCard, type ReferenceableCardKind, type SeriesRef, type SymbolItem } from "../types";
import { t } from "../i18n";

// Opens the symbol picker for a custom source (remote search or manual
// entry); sourceId selects the source.
export type OpenSymbolPicker = (onSelect: (item: SymbolItem) => void, sourceId?: string) => void;

// Lists existing referenceable cards for the 已有卡片 dropdown (see
// ReferenceableCard in types.ts).
export type ListReferenceableCards = () => Promise<ReferenceableCard[]>;

// The first-column 数据源 values: each enabled custom source gets its own
// entry, plus 已有卡片.
export type SeriesRowSource = "card" | `custom:${string}`;

/**
 * One series row in the overlay/spread edit modals: 数据源 dropdown (the
 * user's enabled custom sources + 已有卡片) + a code control (symbol picker
 * or card dropdown) + an optional 名称 input + an optional 删除 button.
 * Re-renders its controls inside a stable wrapper so row order is preserved
 * when the source changes.
 *
 * allowCardRef=false removes the 已有卡片 option (used for a spread card's
 * own A/B legs, which reference raw series only).
 */
export class SeriesRefEditor {
  readonly el: HTMLElement;
  private source: SeriesRowSource;
  private code: string;
  private cardPath: string;
  private label: string;
  private allowCardRef: boolean;
  private openSymbolPicker?: OpenSymbolPicker;
  private listReferenceableCards?: ListReferenceableCards;
  private customSources: CustomSourceDef[];
  private onRemove?: () => void;

  constructor(
    containerEl: HTMLElement,
    initial: SeriesRef,
    onRemove?: () => void,
    allowCardRef = true,
    openSymbolPicker?: OpenSymbolPicker,
    listReferenceableCards?: ListReferenceableCards,
    customSources?: CustomSourceDef[]
  ) {
    this.customSources = customSources ?? [];
    this.allowCardRef = allowCardRef;
    this.openSymbolPicker = openSymbolPicker;
    this.listReferenceableCards = listReferenceableCards;
    this.onRemove = onRemove;

    // Backfill the row state from the existing ref.
    this.code = "";
    this.cardPath = "";
    if (initial.source === "quote") {
      this.source = `custom:${initial.sourceId ?? this.customSources[0]?.id ?? ""}`;
      this.code = initial.tsCode ?? "";
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
    if (this.customSources.length > 0) return `custom:${this.customSources[0].id}`;
    return "card";
  }

  // First-column options: the user's enabled custom sources + 已有卡片. A
  // source the current row references but which is no longer configured
  // (source deleted/disabled) is appended as a disabled-looking fallback so
  // the existing value is never silently dropped.
  private sourceOptions(): { value: SeriesRowSource; label: string }[] {
    const options: { value: SeriesRowSource; label: string }[] = [];
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
        // source switch.
        this.code = "";
        this.cardPath = "";
        this.renderControls();
      });
    });

    if (this.source === "card") {
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
      this.addQuotePicker(setting);
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

  // Quote rows pick an asset from the source's own remote-search /
  // manual-entry modal instead of typing a code.
  private addQuotePicker(setting: Setting) {
    if (this.openSymbolPicker) {
      setting.addText((text) => {
        text.setPlaceholder(t("点击选择资产")).setValue(this.code);
        text.inputEl.readOnly = true;
        const openPicker = () => {
          // Custom rows are bound to their fixed sourceId.
          this.openSymbolPicker?.((item) => {
            this.code = item.tsCode;
            if (!this.label.trim()) {
              this.label = item.name;
            }
            this.renderControls();
          }, this.sourceId);
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
  // selectEl directly). The row may have been re-rendered (source switch,
  // modal closed) while loading — bail out if the dropdown is no longer in
  // the document.
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
      { kind: "quote", label: "资产卡" },
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
    } else {
      ref = { source: "quote", tsCode: this.code.trim(), assetType: "custom", sourceId: this.sourceId };
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
    if (!this.sourceId) {
      return t("请选择自定义数据源（可在设置页添加）。");
    }
    // Custom-source codes are free-form (composite "URL部分@映射部分" report
    // codes like 东财 datacenter, endpoint-specific ids) — non-empty only.
    return this.code.trim() ? null : t("请填写代码。");
  }
}
