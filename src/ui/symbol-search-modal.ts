import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import { ASSET_TYPE_LABELS, type SymbolItem } from "../types";
import { SymbolIndex } from "../modules/symbol-index";

interface SymbolSearchModalOptions {
  app: App;
  symbolIndex: SymbolIndex;
  onSelect: (item: SymbolItem) => void;
}

// Unified fuzzy picker across stocks, funds and indices. Each result shows an
// asset-type badge so same-named entries of different types stay distinguishable.
export class SymbolSearchModal extends FuzzySuggestModal<SymbolItem> {
  private symbolIndex: SymbolIndex;
  private onSelectCallback: (item: SymbolItem) => void;
  private items: SymbolItem[] = [];

  constructor(options: SymbolSearchModalOptions) {
    super(options.app);
    this.symbolIndex = options.symbolIndex;
    this.onSelectCallback = options.onSelect;
    this.setPlaceholder("搜索股票 / 基金 / 指数的代码或名称…");
    this.setInstructions([
      { command: "↑↓", purpose: "选择" },
      { command: "↵", purpose: "确认" },
      { command: "esc", purpose: "关闭" },
    ]);
    // Shown by onNoSuggestion() while getItems() is still empty.
    this.emptyStateText = "正在加载资产列表…";
  }

  async onOpen() {
    super.onOpen();
    // Re-render the empty state now that emptyStateText is set.
    this.refreshSuggestions();
    try {
      this.items = await this.symbolIndex.loadAll();
      this.emptyStateText = "没有找到匹配的资产。";
    } catch (e) {
      console.error("SymbolSearchModal: failed to load symbol lists", e);
      this.emptyStateText = `资产列表加载失败：${e instanceof Error ? e.message : String(e)}`;
    }
    this.refreshSuggestions();
  }

  getItems(): SymbolItem[] {
    return this.items;
  }

  getItemText(item: SymbolItem): string {
    return `${item.name} (${item.tsCode})`;
  }

  renderSuggestion(match: FuzzyMatch<SymbolItem>, el: HTMLElement): void {
    const item = match.item;
    el.createSpan({ text: this.getItemText(item) });
    const meta = item.exchange
      ? `${ASSET_TYPE_LABELS[item.assetType]} · ${item.exchange}`
      : ASSET_TYPE_LABELS[item.assetType];
    el.createSpan({ cls: "fc-symbol-meta", text: meta });
  }

  onChooseItem(item: SymbolItem, _evt: MouseEvent | KeyboardEvent): void {
    this.onSelectCallback(item);
  }

  // SuggestModal.updateSuggestions() is not part of the public typings.
  private refreshSuggestions() {
    (this as any).updateSuggestions?.();
  }
}
