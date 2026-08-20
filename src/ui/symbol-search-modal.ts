import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import { ASSET_TYPE_LABELS, ASSET_TYPE_MIN_POINTS, type AssetType, type SymbolItem } from "../types";
import { SymbolIndex } from "../modules/symbol-index";

interface SymbolSearchModalOptions {
  app: App;
  symbolIndex: SymbolIndex;
  onSelect: (item: SymbolItem) => void;
  // When set, only items of this asset type are listed/searched (used by the
  // series-row editor so a row's 资产品类 constrains the picker).
  assetType?: AssetType;
}

// Unified fuzzy picker across stocks, funds and indices. Each result shows an
// asset-type badge so same-named entries of different types stay distinguishable.
export class SymbolSearchModal extends FuzzySuggestModal<SymbolItem> {
  private symbolIndex: SymbolIndex;
  private onSelectCallback: (item: SymbolItem) => void;
  private assetType?: AssetType;
  private items: SymbolItem[] = [];

  constructor(options: SymbolSearchModalOptions) {
    super(options.app);
    this.symbolIndex = options.symbolIndex;
    this.onSelectCallback = options.onSelect;
    this.assetType = options.assetType;
    this.setPlaceholder(
      this.assetType
        ? `搜索${ASSET_TYPE_LABELS[this.assetType]}的代码或名称…`
        : "搜索股票 / 基金 / 指数的代码或名称…"
    );
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
      const all = await this.symbolIndex.loadAll();
      this.items = this.assetType ? all.filter((item) => item.assetType === this.assetType) : all;
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
    const parts = [
      ASSET_TYPE_LABELS[item.assetType],
      item.exchange,
      `积分≥${ASSET_TYPE_MIN_POINTS[item.assetType]}`,
    ].filter(Boolean);
    el.createSpan({ cls: "fc-symbol-meta", text: parts.join(" · ") });
  }

  onChooseItem(item: SymbolItem, _evt: MouseEvent | KeyboardEvent): void {
    this.onSelectCallback(item);
  }

  // SuggestModal.updateSuggestions() is not part of the public typings.
  private refreshSuggestions() {
    (this as any).updateSuggestions?.();
  }
}
