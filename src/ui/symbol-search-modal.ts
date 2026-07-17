import { FuzzySuggestModal, type App } from "obsidian";
import type { AssetType, SymbolItem } from "../types";
import { SymbolIndex } from "../modules/symbol-index";

interface SymbolSearchModalOptions {
  app: App;
  symbolIndex: SymbolIndex;
  assetType: AssetType;
  onSelect: (item: SymbolItem) => void;
}

export class SymbolSearchModal extends FuzzySuggestModal<SymbolItem> {
  private symbolIndex: SymbolIndex;
  private assetType: AssetType;
  private onSelectCallback: (item: SymbolItem) => void;
  private items: SymbolItem[] = [];
  private loaded = false;

  constructor(options: SymbolSearchModalOptions) {
    super(options.app);
    this.symbolIndex = options.symbolIndex;
    this.assetType = options.assetType;
    this.onSelectCallback = options.onSelect;
    this.setPlaceholder("搜索代码或名称…");
    this.setInstructions([
      { command: "↑↓", purpose: "选择" },
      { command: "↵", purpose: "确认" },
      { command: "esc", purpose: "关闭" },
    ]);
  }

  async onOpen() {
    super.onOpen();
    this.items = await this.symbolIndex.loadAssetType(this.assetType);
    this.loaded = true;
  }

  getItems(): SymbolItem[] {
    return this.items;
  }

  getItemText(item: SymbolItem): string {
    return `${item.name} (${item.tsCode})`;
  }

  onChooseItem(item: SymbolItem, _evt: MouseEvent | KeyboardEvent): void {
    this.onSelectCallback(item);
  }
}
