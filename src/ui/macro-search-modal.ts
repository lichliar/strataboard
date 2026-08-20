import { SuggestModal, type App } from "obsidian";
import { MACRO_SERIES_OPTIONS, type MacroSeriesDef } from "../types";

const FREQ_LABELS: Record<MacroSeriesDef["freq"], string> = {
  D: "日度",
  M: "月度",
  Q: "季度",
};

// e.g. "积分≥600"; yc_cb-class APIs are granted individually by Tushare.
function pointsLabel(def: MacroSeriesDef): string {
  return def.points === "special" ? "需单独权限" : `积分≥${def.points}`;
}

/**
 * Tushare macro-series picker over the local MACRO_SERIES_OPTIONS catalog
 * (no remote search — the catalog is fixed). Shared by the standalone-card
 * insertion flow and the macro source in the unified card edit modal.
 */
export class MacroSearchModal extends SuggestModal<MacroSeriesDef> {
  private onSelectCallback: (def: MacroSeriesDef) => void;

  constructor(app: App, onSelect: (def: MacroSeriesDef) => void) {
    super(app);
    this.onSelectCallback = onSelect;
    this.setPlaceholder("输入关键词选择宏观序列（如 CPI、PMI、社融、LPR）…");
    this.setInstructions([
      { command: "↑↓", purpose: "选择" },
      { command: "↵", purpose: "确认" },
      { command: "esc", purpose: "关闭" },
    ]);
  }

  getSuggestions(query: string): MacroSeriesDef[] {
    const text = query.trim().toLowerCase();
    if (!text) {
      return MACRO_SERIES_OPTIONS;
    }
    return MACRO_SERIES_OPTIONS.filter(
      (def) =>
        def.label.toLowerCase().includes(text) ||
        def.id.toLowerCase().includes(text) ||
        def.group.toLowerCase().includes(text)
    );
  }

  renderSuggestion(def: MacroSeriesDef, el: HTMLElement): void {
    el.createSpan({ text: def.label });
    el.createSpan({ cls: "fc-symbol-meta", text: `${def.group} · ${FREQ_LABELS[def.freq]} · ${pointsLabel(def)}` });
  }

  onChooseSuggestion(def: MacroSeriesDef, _evt: MouseEvent | KeyboardEvent): void {
    this.onSelectCallback(def);
  }
}
