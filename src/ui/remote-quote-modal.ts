import { SuggestModal, type App } from "obsidian";
import type { SymbolItem } from "../types";

export type SearchQuotes = (text: string) => Promise<SymbolItem[]>;

/**
 * Remote quote picker for the token-free sources (腾讯行情 / 东方财富).
 * Unlike SymbolSearchModal (local fuzzy index over a bulk list), these
 * sources only offer per-keystroke server-side search — same interaction
 * model as FredSearchModal: debounced, sequence-guarded against stale
 * responses.
 */
export class RemoteQuoteSearchModal extends SuggestModal<SymbolItem> {
  private search: SearchQuotes;
  private onSelectCallback: (item: SymbolItem) => void;
  private callSeq = 0;

  constructor(app: App, sourceLabel: string, search: SearchQuotes, onSelect: (item: SymbolItem) => void) {
    super(app);
    this.search = search;
    this.onSelectCallback = onSelect;
    this.setPlaceholder(`输入代码或名称搜索（${sourceLabel}，如 茅台 / 00700 / AAPL）…`);
    this.setInstructions([
      { command: "↑↓", purpose: "选择" },
      { command: "↵", purpose: "确认" },
      { command: "esc", purpose: "关闭" },
    ]);
    // SuggestModal shows this while getSuggestions returns nothing.
    this.emptyStateText = "输入关键词开始搜索。";
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
      this.emptyStateText = "搜索失败，请稍后重试。";
      return [];
    }
  }

  renderSuggestion(item: SymbolItem, el: HTMLElement): void {
    el.createSpan({ text: `${item.name} (${item.symbol})` });
    el.createSpan({ cls: "fc-symbol-meta", text: item.exchange });
  }

  onChooseSuggestion(item: SymbolItem, _evt: MouseEvent | KeyboardEvent): void {
    this.onSelectCallback(item);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
