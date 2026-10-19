import { App, SuggestModal } from "obsidian";
import type { IndicatorDef } from "../modules/indicators/contract";
import { indicatorRegistry } from "../modules/indicators/registry";
import { t } from "../i18n";

// Searchable indicator picker: replaces the old category-grouped native
// <select> in the shared instance list editor. Filters by name / shortTitle /
// id / category, groups hits under per-category headers (drawn inside the
// first row of each group so every row stays selectable), and picking a row
// hands the def to onPick — the caller creates the instance.
export class IndicatorPickerModal extends SuggestModal<IndicatorDef> {
  // First row of each category in the current result list (def id → category
  // label), rebuilt per query.
  private categoryHeaders = new Map<string, string>();

  constructor(app: App, private readonly onPick: (def: IndicatorDef) => void) {
    super(app);
    this.setPlaceholder(t("搜索指标名称或 id…"));
    this.setInstructions([
      { command: "↑↓", purpose: t("选择") },
      { command: "↵", purpose: t("添加") },
      { command: "esc", purpose: t("关闭") },
    ]);
  }

  private updateEmptyState(text: string): void {
    this.emptyStateText = text;
    const noResults = this.resultContainerEl.querySelector(".suggestion-empty");
    if (noResults) noResults.textContent = text;
  }

  getSuggestions(query: string): IndicatorDef[] {
    const q = query.trim().toLowerCase();
    const matches = (def: IndicatorDef) =>
      q.length === 0 ||
      def.name.toLowerCase().includes(q) ||
      def.id.toLowerCase().includes(q) ||
      def.metadata.title.toLowerCase().includes(q) ||
      def.metadata.shortTitle.toLowerCase().includes(q) ||
      def.category.toLowerCase().includes(q);
    this.categoryHeaders.clear();
    const out: IndicatorDef[] = [];
    for (const [category, defs] of indicatorRegistry.listByCategory()) {
      const hits = defs.filter(matches);
      if (hits.length === 0) continue;
      this.categoryHeaders.set(hits[0].id, category);
      out.push(...hits);
    }
    this.updateEmptyState(
      indicatorRegistry.list().length === 0 ? t("指标文件夹中还没有可用的指标。") : t("没有匹配的指标")
    );
    return out;
  }

  renderSuggestion(def: IndicatorDef, el: HTMLElement): void {
    const category = this.categoryHeaders.get(def.id);
    if (category) {
      el.createDiv({ cls: "fc-indicator-picker-category", text: t(category) });
    }
    el.createDiv({ text: t(def.name) });
    el.createEl("small", {
      text: `${t(def.metadata.shortTitle)} · ${def.metadata.overlay ? t("主图") : t("副图")}${def.description ? ` · ${def.description.split("\n")[0]}` : ""}`,
      cls: "fc-symbol-meta",
    });
  }

  onChooseSuggestion(def: IndicatorDef): void {
    this.onPick(def);
  }
}
