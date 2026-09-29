import { App, SuggestModal } from "obsidian";
import type {
  CustomSourceDef,
  SymbolItem,
} from "../types";
import { sourceSupportsRemoteSearch } from "../types";
import { matchSymbolEntry } from "../utils/symbol-list";
import { t } from "../i18n";

export type UnifiedResult =
  | { kind: "symbol"; item: SymbolItem }
  | { kind: "manual"; sourceId: string; sourceName: string };

// Search scope picked BEFORE the modal opens (toolbar submenu / source
// picker): every enabled source, one source group, or a single source.
export type CategoryId = "all" | `custom:${string}` | `group:${string}`;

export interface UnifiedSearchOptions {
  customSources: CustomSourceDef[];
  searchCustom: (sourceId: string, text: string) => Promise<SymbolItem[]>;
  onSymbol: (item: SymbolItem) => void;
  onManual: (sourceId: string, sourceName: string) => void;
  scope?: CategoryId;
}

const MERGED_LIMIT = 50;

/**
 * Unified 「插入图表」 picker: one search box that fans out across the sources
 * in its scope (all enabled sources, one group, or one source). Source
 * categorization lives in the toolbar submenu that opened this modal, so
 * there is no in-modal chip row. Custom sources without remote search (no
 * searchUrl / searchBodyTemplate) surface a constant manual-entry result
 * instead.
 */
export class UnifiedSearchModal extends SuggestModal<UnifiedResult> {
  private callSeq = 0;
  // Named searchScope: SuggestModal already has a `scope` (keybind scope).
  private searchScope: CategoryId;

  constructor(app: App, private opts: UnifiedSearchOptions) {
    super(app);
    this.searchScope = opts.scope ?? "all";
    this.setPlaceholder(t("输入代码或名称搜索（如 美的集团 / 600519）…"));
    this.setInstructions([
      { command: "↑↓", purpose: t("选择") },
      { command: "↵", purpose: t("插入卡片") },
      { command: "esc", purpose: t("关闭") },
    ]);
  }

  private updateEmptyState(text: string): void {
    this.emptyStateText = text;
    const noResults = this.resultContainerEl.querySelector(".suggestion-empty");
    if (noResults) noResults.textContent = text;
  }

  getSuggestions(query: string): Promise<UnifiedResult[]> {
    const trimmed = query.trim().toLowerCase();
    // SuggestModal renders whatever promise resolves LAST, with no ordering
    // guard: a slow stale call resolving [] after a fast fresh one would wipe
    // the list. So only the newest call may resolve; superseded calls stay
    // pending forever and can never clobber newer results.
    return new Promise((resolve) => {
      const seq = ++this.callSeq;
      // Debounce remote searches.
      setTimeout(() => {
        if (seq !== this.callSeq) return;
        void this.collectSuggestions(trimmed).then((results) => {
          if (seq === this.callSeq) resolve(results);
        });
      }, 300);
    });
  }

  private scopedSources(): CustomSourceDef[] {
    if (this.searchScope.startsWith("group:")) {
      const group = this.searchScope.slice("group:".length);
      return this.opts.customSources.filter((s) => s.group === group);
    }
    if (this.searchScope.startsWith("custom:")) {
      const id = this.searchScope.slice("custom:".length);
      return this.opts.customSources.filter((s) => s.id === id);
    }
    return this.opts.customSources;
  }

  private async collectSuggestions(query: string): Promise<UnifiedResult[]> {
    if (this.opts.customSources.length === 0) {
      this.updateEmptyState(t("请先在设置页添加并启用自定义数据源。"));
      return [];
    }
    this.updateEmptyState(t("输入关键词开始搜索。"));

    const results: UnifiedResult[] = [];
    const fetches: Promise<void>[] = [];
    for (const source of this.scopedSources()) {
      // Static code table: local named picks without a server-side search.
      for (const entry of source.symbols ?? []) {
        if (!matchSymbolEntry(entry, query)) continue;
        results.push({
          kind: "symbol" as const,
          item: {
            tsCode: entry.code,
            symbol: entry.code,
            name: entry.name,
            exchange: source.name,
            assetType: "custom",
            sourceId: source.id,
          },
        });
      }
      if (!sourceSupportsRemoteSearch(source)) {
        results.push({ kind: "manual", sourceId: source.id, sourceName: source.name });
      } else if (query.length > 0) {
        fetches.push(
          this.opts
            .searchCustom(source.id, query)
            .then((items) => {
              results.push(...items.map((item) => ({ kind: "symbol" as const, item })));
            })
            .catch((err) =>
              console.error(`StrataBoard: custom source search failed (${source.name})`, err),
            ),
        );
      }
    }
    await Promise.all(fetches);

    if (results.length === 0 && query.length > 0) {
      this.updateEmptyState(t("未找到匹配结果"));
    }
    return results.slice(0, MERGED_LIMIT);
  }

  renderSuggestion(result: UnifiedResult, el: HTMLElement): void {
    switch (result.kind) {
      case "symbol": {
        el.createEl("div", { text: `${result.item.name} (${result.item.tsCode})` });
        const source =
          this.opts.customSources.find((s) => s.id === result.item.sourceId)?.name ?? t("自定义");
        const meta = [source, result.item.exchange].filter(Boolean).join(" · ");
        el.createEl("small", { text: meta, cls: "fc-symbol-meta" });
        break;
      }
      case "manual": {
        el.createEl("div", { text: t("手工录入代码") });
        el.createEl("small", {
          text: `${result.sourceName} · ${t("自定义")}`,
          cls: "fc-symbol-meta",
        });
        break;
      }
    }
  }

  onChooseSuggestion(result: UnifiedResult): void {
    switch (result.kind) {
      case "symbol":
        this.opts.onSymbol(result.item);
        break;
      case "manual":
        this.opts.onManual(result.sourceId, result.sourceName);
        break;
    }
  }
}
