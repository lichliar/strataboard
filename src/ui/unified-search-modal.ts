import { App, Notice, SuggestModal } from "obsidian";
import type {
  CustomSourceDef,
  SymbolItem,
} from "../types";
import { sourceSupportsRemoteSearch } from "../types";
import { isDeadCode, matchSymbolEntry } from "../utils/symbol-list";
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
  // Sources that already raised a failure Notice this modal session — one
  // Notice per source per session, not per keystroke.
  private failedSources = new Set<string>();

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
      window.setTimeout(() => {
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

  // Match-quality tiers for merged results: exact code hit first, then name
  // prefix, code prefix, name substring, code substring.
  private relevanceRank(item: SymbolItem, query: string): number {
    const code = item.tsCode.toLowerCase();
    const symbol = item.symbol.toLowerCase();
    const name = item.name.toLowerCase();
    if (code === query || symbol === query) return 0;
    if (name.startsWith(query)) return 1;
    if (code.startsWith(query) || symbol.startsWith(query)) return 2;
    if (name.includes(query)) return 3;
    return 4;
  }

  private async collectSuggestions(query: string): Promise<UnifiedResult[]> {
    if (this.opts.customSources.length === 0) {
      this.updateEmptyState(t("请先在设置页添加并启用自定义数据源。"));
      return [];
    }
    this.updateEmptyState(t("输入关键词开始搜索。"));

    // Per-source buckets keep the merge deterministic: remote results land in
    // their own source's bucket whenever they arrive, instead of push order
    // depending on which server answered first.
    const buckets: { source: CustomSourceDef; symbols: SymbolItem[]; manual?: UnifiedResult }[] = [];
    const failedNames: string[] = [];
    const fetches: Promise<void>[] = [];
    for (const source of this.scopedSources()) {
      const bucket: { source: CustomSourceDef; symbols: SymbolItem[]; manual?: UnifiedResult } = { source, symbols: [] };
      buckets.push(bucket);
      // Static code table: local named picks without a server-side search.
      for (const entry of source.symbols ?? []) {
        if (!matchSymbolEntry(entry, query)) continue;
        bucket.symbols.push({
          tsCode: entry.code,
          symbol: entry.code,
          name: entry.name,
          exchange: source.name,
          assetType: "custom",
          sourceId: source.id,
        });
      }
      if (!sourceSupportsRemoteSearch(source)) {
        bucket.manual = { kind: "manual", sourceId: source.id, sourceName: source.name };
      } else if (query.length > 0) {
        fetches.push(
          this.opts
            .searchCustom(source.id, query)
            .then((items) => {
              bucket.symbols.push(...items);
            })
            .catch((err) => {
              console.error(`StrataBoard: custom source search failed (${source.name})`, err);
              failedNames.push(source.name);
              if (!this.failedSources.has(source.id)) {
                this.failedSources.add(source.id);
                new Notice(
                  t("数据源「{name}」搜索失败：{msg}", { name: source.name, msg: err instanceof Error ? err.message : String(err) }),
                );
              }
            }),
        );
      }
    }
    await Promise.all(fetches);

    let merged: UnifiedResult[];
    if (query.length === 0) {
      // Browsing picks with no query: keep the plain per-source grouping.
      merged = buckets.flatMap((b) => [
        ...b.symbols.map((item) => ({ kind: "symbol" as const, item })),
        ...(b.manual ? [b.manual] : []),
      ]);
    } else {
      // K-way merge by (relevance tier, round-robin across sources): the
      // best tier always wins, and within a tier sources take turns (the
      // bucket after the last-served one goes first), so one chatty source
      // cannot push another source's hits past MERGED_LIMIT.
      const queues = buckets.map((b) => [...b.symbols]);
      const symbols: SymbolItem[] = [];
      let lastServed = -1;
      for (;;) {
        let bestRank = Infinity;
        for (const q of queues) {
          const head = q[0];
          if (head) bestRank = Math.min(bestRank, this.relevanceRank(head, query));
        }
        if (bestRank === Infinity) break;
        let pick = -1;
        for (let step = 1; step <= queues.length; step++) {
          const i = (lastServed + step) % queues.length;
          const head = queues[i][0];
          if (head && this.relevanceRank(head, query) === bestRank) {
            pick = i;
            break;
          }
        }
        if (pick < 0) break;
        symbols.push(queues[pick].shift()!);
        lastServed = pick;
      }
      merged = [
        ...symbols.map((item) => ({ kind: "symbol" as const, item })),
        ...buckets.flatMap((b) => (b.manual ? [b.manual] : [])),
      ];
    }

    if (merged.length === 0 && query.length > 0) {
      this.updateEmptyState(
        failedNames.length > 0
          ? t("未找到匹配结果；{n} 个源搜索失败：{names}", { n: failedNames.length, names: failedNames.join("、") })
          : t("未找到匹配结果"),
      );
    }
    return merged.slice(0, MERGED_LIMIT);
  }

  renderSuggestion(result: UnifiedResult, el: HTMLElement): void {
    switch (result.kind) {
      case "symbol": {
        el.createDiv({ text: `${result.item.name} (${result.item.tsCode})` });
        const def = this.opts.customSources.find((s) => s.id === result.item.sourceId);
        // Declared-dead codes stay selectable but are marked — never
        // silently removed from results.
        const dead = result.item.dead || (def ? isDeadCode(def, result.item.tsCode) : false);
        const meta = [def?.name ?? t("自定义"), result.item.exchange, dead ? t("已知无行情") : ""]
          .filter(Boolean)
          .join(" · ");
        el.createEl("small", { text: meta, cls: "fc-symbol-meta" });
        break;
      }
      case "manual": {
        el.createDiv({ text: t("手工录入代码") });
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
