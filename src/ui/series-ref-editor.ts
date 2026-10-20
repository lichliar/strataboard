import { Setting, type DropdownComponent } from "obsidian";
import {
  type CorrTransform,
  type CustomSourceDef,
  type ReferenceableCard,
  type ReferenceableCardKind,
  type SeriesRef,
  type SeriesValueKind,
  type SymbolItem,
} from "../types";
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
  private profile: string;
  // Selected entry in the 已有卡片 dropdown: `sp:<cardId>` for spread cards,
  // `q:<path>` for quote cards (the path is only a picker key — picking a
  // quote card emits a plain quote ref, never a file reference).
  private cardKey: string;
  private cards: ReferenceableCard[] = [];
  private label: string;
  // Value semantics / correlation transform (SeriesRef.kind/corr). Kept for
  // EVERY row so hand-written values round-trip through any editor; the
  // dropdowns themselves only render when allowSemantics (overlay cards —
  // the correlation badge lives there).
  private kind: SeriesValueKind | "";
  private corr: CorrTransform | "";
  private allowSemantics: boolean;
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
    customSources?: CustomSourceDef[],
    allowSemantics = false
  ) {
    this.customSources = customSources ?? [];
    this.allowCardRef = allowCardRef;
    this.allowSemantics = allowSemantics;
    this.openSymbolPicker = openSymbolPicker;
    this.listReferenceableCards = listReferenceableCards;
    this.onRemove = onRemove;
    this.kind = initial.kind ?? "";
    this.corr = initial.corr ?? "";

    // Backfill the row state from the existing ref.
    this.code = "";
    this.profile = "";
    this.cardKey = "";
    if (initial.source === "quote") {
      this.source = `custom:${initial.sourceId ?? this.customSources[0]?.id ?? ""}`;
      this.code = initial.tsCode ?? "";
      this.profile = initial.profile ?? "";
      this.normalizeLegacyProfileCode();
    } else if (allowCardRef) {
      // Hand-written YAML may still carry a card leg where the UI forbids it
      // (allowCardRef=false) — that case falls through to the default source.
      this.source = "card";
      this.cardKey = initial.cardId ? `sp:${initial.cardId}` : "";
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
        this.profile = "";
        this.cardKey = "";
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
          this.cardKey = value;
        });
        void this.populateCardDropdown(dropdown);
      });
    } else {
      // custom:<id> — the source is fixed by the first column, so the code
      // picker binds to it directly.
      this.addQuotePicker(setting);
      this.addProfilePicker(setting);
    }

    setting.addText((text) =>
      text
        .setPlaceholder(t("名称（可选）"))
        .setValue(this.label)
        .onChange((value) => {
          this.label = value;
        })
    );

    if (this.allowSemantics) {
      this.addSemanticsPickers(setting);
    }

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
            this.profile = item.profile ?? "";
            this.normalizeLegacyProfileCode();
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

  private sourceDef(): CustomSourceDef | undefined {
    return this.customSources.find((def) => def.id === this.sourceId);
  }

  // 值语义 dropdown (overlay cards only, via allowSemantics). The corr
  // override stays YAML-only — one dropdown, plain-language options. The UI
  // folds yield/spread/level into one option (all three compute identically);
  // a hand-written yield/spread value displays as the folded option but is
  // only rewritten to "level" if the user actually changes the dropdown.
  private addSemanticsPickers(setting: Setting): void {
    // What "自动" resolves to for this row: the source's declared seriesKind,
    // else the global price default — shown so the effective behavior is
    // visible without touching anything.
    const autoKind = this.sourceDef()?.seriesKind;
    const KIND_OPTION_LABELS: Record<"price" | "level" | "change", string> = {
      price: t("价格 / 指数"),
      level: t("利率 / 利差 / 其他水平值"),
      change: t("涨跌幅 / 同比（已是变化量）"),
    };
    const folded = this.kind === "yield" || this.kind === "spread" ? "level" : this.kind;
    setting.addDropdown((dropdown) => {
      const autoLabel = KIND_OPTION_LABELS[autoKind === "yield" || autoKind === "spread" ? "level" : autoKind === "change" ? "change" : "price"];
      dropdown.addOption("", autoKind ? t("值语义：自动（{kind} · 数据源默认）", { kind: autoLabel }) : t("值语义：自动（{kind}）", { kind: autoLabel }));
      dropdown.addOption("price", KIND_OPTION_LABELS.price);
      dropdown.addOption("level", KIND_OPTION_LABELS.level);
      dropdown.addOption("change", KIND_OPTION_LABELS.change);
      if (this.kind && folded !== "price" && folded !== "level" && folded !== "change") {
        dropdown.addOption(this.kind, `${this.kind}${t("（不可用）")}`);
      }
      dropdown.setValue(folded).onChange((value) => {
        this.kind = value as SeriesValueKind | "";
      });
      dropdown.selectEl.title = t("这个序列的数值是什么；决定相关徽标按收益率、差分还是原值计算");
    });
  }

  private usesMapCode(def: CustomSourceDef | undefined): boolean {
    return Object.values(def?.jsonMap?.cols ?? {}).some((value) => typeof value === "string" && value.includes("{code}"));
  }

  private profileOptions(): string[] {
    const def = this.sourceDef();
    if (!def?.profiles || this.usesMapCode(def)) return [];
    return Object.keys(def.profiles);
  }

  // Existing cards may use the legacy code@profile shorthand. Normalize it
  // into the explicit editor state when the suffix is a declared profile;
  // wide-table code@column values remain untouched.
  private normalizeLegacyProfileCode(): void {
    if (!this.code.includes("@")) return;
    const def = this.sourceDef();
    if (!def || this.usesMapCode(def)) return;
    const at = this.code.indexOf("@");
    const base = this.code.slice(0, at);
    const suffix = this.code.slice(at + 1);
    if (def.profiles?.[suffix] && (!this.profile || this.profile === suffix)) {
      this.code = base;
      this.profile = suffix;
    }
  }

  private addProfilePicker(setting: Setting): void {
    const options = this.profileOptions();
    if (options.length === 0) return;
    const current = this.profile && options.includes(this.profile) ? this.profile : this.profile;
    setting.addDropdown((dropdown) => {
      dropdown.addOption("", t("默认口径"));
      for (const profile of options) dropdown.addOption(profile, profile);
      if (current && !options.includes(current)) {
        dropdown.addOption(current, `${current}${t("（不可用）")}`);
      }
      dropdown.setValue(current).onChange((value) => {
        this.profile = value;
      });
    });
  }

  // Fills the 已有卡片 dropdown once the provider resolves, grouped by card
  // type (DropdownComponent has no optgroup API, so options are built on
  // selectEl directly). Option values are picker keys (`sp:<cardId>` /
  // `q:<path>`), never written to YAML. A referenced spread card missing from
  // the list (deleted, or moved out of the library) keeps its key as a
  // disabled 已失效 option so the existing value is never silently dropped —
  // same discipline as the unavailable-source fallback in sourceOptions().
  // The row may have been re-rendered (source switch, modal closed) while
  // loading — bail out if the dropdown is no longer in the document.
  private async populateCardDropdown(dropdown: DropdownComponent) {
    let cards: ReferenceableCard[] = [];
    try {
      cards = (await this.listReferenceableCards?.()) ?? [];
    } catch (e) {
      console.error("SeriesRefEditor: failed to list referenceable cards", e);
    }
    if (!dropdown.selectEl.isConnected) return;
    this.cards = cards;

    dropdown.selectEl.empty();
    if (cards.length === 0 && !this.cardKey) {
      dropdown.addOption("", t("暂无可引用的卡片"));
      dropdown.setValue("");
      this.cardKey = "";
      return;
    }
    const groups: { kind: ReferenceableCardKind; label: string }[] = [
      { kind: "quote", label: "数据卡" },
      { kind: "spread", label: "计算卡" },
    ];
    for (const group of groups) {
      const members = cards.filter((card) => card.kind === group.kind);
      if (members.length === 0) continue;
      const optgroup = dropdown.selectEl.createEl("optgroup", { attr: { label: t(group.label) } });
      for (const card of members) {
        optgroup.createEl("option", { value: cardKeyOf(card), text: card.name });
      }
    }
    let selected = cards.some((c) => cardKeyOf(c) === this.cardKey) ? this.cardKey : "";
    if (!selected && this.cardKey) {
      // Referenced spread card not in the list: keep the dead key visible.
      const option = dropdown.selectEl.createEl("option", {
        value: this.cardKey,
        text: `${this.cardKey.replace(/^sp:/, "")}${t("（已失效）")}`,
      });
      option.disabled = true;
      selected = this.cardKey;
    }
    if (!selected) {
      selected = cards.length > 0 ? cardKeyOf(cards[0]) : "";
    }
    dropdown.setValue(selected);
    this.cardKey = selected;
    dropdown.setDisabled(false);
  }

  // Builds the SeriesRef from the current row state. Picking a QUOTE card
  // emits a plain quote ref with the card's quote coordinates (quote cards
  // carry no identity of their own); picking a SPREAD card emits a card ref
  // by its stable id.
  toRef(): SeriesRef {
    let ref: SeriesRef;
    if (this.source === "card") {
      const card = this.cards.find((c) => cardKeyOf(c) === this.cardKey);
      if (card?.kind === "quote" && card.quoteRef) {
        ref = { source: "quote", tsCode: card.quoteRef.tsCode, assetType: card.quoteRef.assetType };
        if (card.quoteRef.sourceId) {
          ref.sourceId = card.quoteRef.sourceId;
        }
      } else if (card?.kind === "spread" && card.cardId) {
        ref = { source: "card", cardId: card.cardId };
      } else {
        // Dead key (referenced spread card missing from the list): re-emit
        // the original id so saving never silently drops the reference.
        ref = { source: "card", cardId: this.cardKey.replace(/^sp:/, "") };
      }
    } else {
      ref = { source: "quote", tsCode: this.code.trim(), assetType: "custom", sourceId: this.sourceId };
      if (this.profile) ref.profile = this.profile;
    }
    const label = this.label.trim();
    if (label) {
      ref.label = label;
    }
    if (this.kind) {
      ref.kind = this.kind;
    }
    if (this.corr) {
      ref.corr = this.corr;
    }
    return ref;
  }

  // Returns a translated error message, or null when the row is valid.
  validate(): string | null {
    if (this.source === "card") {
      return this.cardKey ? null : t("请选择要引用的卡片。");
    }
    if (!this.sourceId) {
      return t("请选择自定义数据源（可在设置页添加）。");
    }
    // Custom-source codes are free-form (composite "URL部分@映射部分" report
    // codes like 东财 datacenter, endpoint-specific ids) — non-empty only.
    return this.code.trim() ? null : t("请填写代码。");
  }
}

// Picker key for a card-list entry (never written to YAML): spread cards key
// by their stable id, quote cards by path (they have no id of their own).
function cardKeyOf(card: ReferenceableCard): string {
  return card.kind === "spread" ? `sp:${card.cardId ?? card.path}` : `q:${card.path}`;
}
