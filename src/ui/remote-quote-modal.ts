import { SuggestModal, type App } from "obsidian";
import type { SymbolItem } from "../types";
import { t } from "../i18n";

export type SearchQuotes = (text: string) => Promise<SymbolItem[]>;

/**
 * Remote quote picker for custom data sources with remote search (searchUrl
 * or searchBodyTemplate): these sources offer per-keystroke server-side
 * search — debounced, sequence-guarded against stale responses.
 */
export class RemoteQuoteSearchModal extends SuggestModal<SymbolItem> {
  private search: SearchQuotes;
  private onSelectCallback: (item: SymbolItem) => void;
  private callSeq = 0;

  constructor(app: App, sourceLabel: string, search: SearchQuotes, onSelect: (item: SymbolItem) => void) {
    super(app);
    this.search = search;
    this.onSelectCallback = onSelect;
    this.setPlaceholder(t("输入代码或名称搜索（{source}，如 茅台 / 00700 / AAPL）…", { source: sourceLabel }));
    this.setInstructions([
      { command: "↑↓", purpose: t("选择") },
      { command: "↵", purpose: t("确认") },
      { command: "esc", purpose: t("关闭") },
    ]);
    // SuggestModal shows this while getSuggestions returns nothing.
    this.emptyStateText = t("输入关键词开始搜索。");
  }

  async getSuggestions(query: string): Promise<SymbolItem[]> {
    const text = query.trim();
    if (!text) return [];

    const seq = ++this.callSeq;
    await sleep(300);
    if (seq !== this.callSeq) {
      // A newer keystroke owns the suggestion list now.
      return [];
    }

    try {
      return await this.search(text);
    } catch (e) {
      console.error("RemoteQuoteSearchModal: search failed", e);
      this.emptyStateText = t("搜索失败，请稍后重试。");
      return [];
    }
  }

  renderSuggestion(item: SymbolItem, el: HTMLElement): void {
    el.createSpan({ text: `${item.name} (${item.symbol})` });
    // Declared-dead codes stay selectable but are marked — never silently
    // removed from results.
    el.createSpan({ cls: "fc-symbol-meta", text: [item.exchange, item.dead ? t("已知无行情") : ""].filter(Boolean).join(" · ") });
  }

  onChooseSuggestion(item: SymbolItem, _evt: MouseEvent | KeyboardEvent): void {
    this.onSelectCallback(item);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
