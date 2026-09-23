import { App, SuggestModal } from "obsidian";
import type {
  CustomSourceDef,
  FredSeriesInfo,
  MacroSeriesDef,
  SymbolItem,
} from "../types";
import { ASSET_TYPE_LABELS, MACRO_SERIES_OPTIONS } from "../types";
import { matchSymbolEntry } from "../utils/symbol-list";
import { t } from "../i18n";

export type UnifiedResult =
  | { kind: "symbol"; item: SymbolItem }
  | { kind: "fred"; info: FredSeriesInfo }
  | { kind: "macro"; def: MacroSeriesDef }
  | { kind: "manual"; sourceId: string; sourceName: string };

export interface UnifiedSearchOptions {
  hasTushare: boolean;
  hasFred: boolean;
  loadSymbols: () => Promise<SymbolItem[]>;
  searchFred: (text: string) => Promise<FredSeriesInfo[]>;
  customSources: CustomSourceDef[];
  searchCustom: (sourceId: string, text: string) => Promise<SymbolItem[]>;
  onSymbol: (item: SymbolItem) => void;
  onFred: (info: FredSeriesInfo) => void;
  onMacro: (def: MacroSeriesDef) => void;
  onManual: (sourceId: string, sourceName: string) => void;
}

// Chips are per DATA SOURCE, not per asset class: Tushare / FRED / one chip
// per enabled custom source. 「全部」(merged view) is prepended when more than
// one source is configured; with no source at all the chip row is hidden.
type CategoryId = "all" | "tushare" | "fred" | `custom:${string}`;

interface CategoryDef {
  id: CategoryId;
  label: string;
  remote?: boolean;
}

const SYMBOL_LIMIT = 20;
const MACRO_LIMIT = 10;
const MERGED_LIMIT = 50;

const MACRO_FREQ_LABELS: Record<MacroSeriesDef["freq"], string> = {
  M: "月度",
  Q: "季度",
  D: "日度",
};

function matchesSymbol(item: SymbolItem, query: string): boolean {
  return (
    item.name.toLowerCase().includes(query) ||
    item.tsCode.toLowerCase().includes(query) ||
    (item.symbol ?? "").toLowerCase().includes(query)
  );
}

function matchesMacro(def: MacroSeriesDef, query: string): boolean {
  return def.label.toLowerCase().includes(query) || def.id.toLowerCase().includes(query);
}

/**
 * Unified 「插入数据」 picker: one search box that fans out across the local
 * symbol index, the Tushare macro catalog, the FRED API, and every enabled
 * custom quote source. Category chips are per data source (Tushare / FRED /
 * each custom source, plus a merged 「全部」 when several are configured);
 * with no configured source the chip row is hidden. Custom sources without a
 * search URL surface a constant manual-entry result instead.
 */
export class UnifiedSearchModal extends SuggestModal<UnifiedResult> {
  private categories: CategoryDef[];
  private category: CategoryId;
  private chipEls = new Map<CategoryId, HTMLButtonElement>();
  private symbolsCache: SymbolItem[] | null = null;
  private callSeq = 0;

  constructor(app: App, private opts: UnifiedSearchOptions) {
    super(app);
    const cats: CategoryDef[] = [];
    if (opts.hasTushare) cats.push({ id: "tushare", label: "Tushare" });
    if (opts.hasFred) cats.push({ id: "fred", label: "FRED", remote: true });
    for (const source of opts.customSources) {
      cats.push({ id: `custom:${source.id}`, label: source.name, remote: true });
    }
    if (cats.length >= 2) {
      cats.unshift({ id: "all", label: "全部", remote: cats.some((c) => c.remote) });
    }
    this.categories = cats;
    this.category = cats[0]?.id ?? "all";
    this.setPlaceholder(t("输入代码或名称搜索（美的集团 / 600519 / DGS10…）"));
    this.setInstructions([
      { command: "↑↓", purpose: t("选择") },
      { command: "↵", purpose: t("插入卡片") },
      { command: "esc", purpose: t("关闭") },
    ]);
  }

  onOpen(): void {
    super.onOpen();
    // A single configured source needs no chip row — the only chip could
    // never change anything.
    if (this.categories.length < 2) return;
    const chips = createDiv({ cls: "fc-cat-chips" });
    for (const cat of this.categories) {
      const chip = chips.createEl("button", {
        cls: `fc-cat-chip${cat.id === this.category ? " fc-cat-chip-active" : ""}`,
        text: t(cat.label),
      });
      chip.addEventListener("click", () => {
        if (this.category === cat.id) return;
        this.category = cat.id;
        for (const [id, el] of this.chipEls) {
          el.classList.toggle("fc-cat-chip-active", id === cat.id);
        }
        // Re-run the current query under the new category.
        this.inputEl.dispatchEvent(new Event("input"));
      });
      this.chipEls.set(cat.id, chip);
    }
    // Insert the chip row AFTER the whole input container, not right after
    // the <input>: the container is a flex row (input + CTA), so appending
    // inside it would lay the chips out side-by-side with the input.
    this.inputEl.parentElement?.after(chips);
  }

  private updateEmptyState(text: string): void {
    this.emptyStateText = text;
    const noResults = this.resultContainerEl.querySelector(".suggestion-empty");
    if (noResults) noResults.textContent = text;
  }

  private async loadSymbols(): Promise<SymbolItem[]> {
    if (this.symbolsCache) return this.symbolsCache;
    if (!this.opts.hasTushare) return [];
    try {
      this.symbolsCache = await this.opts.loadSymbols();
    } catch (err) {
      console.error("StrataBoard: unified search symbol load failed", err);
      this.symbolsCache = [];
    }
    return this.symbolsCache;
  }

  private searchSymbols(query: string): SymbolItem[] {
    if (!this.symbolsCache) return [];
    return this.symbolsCache
      .filter((item) => query.length === 0 || matchesSymbol(item, query))
      .slice(0, SYMBOL_LIMIT);
  }

  private searchMacro(query: string): MacroSeriesDef[] {
    if (!this.opts.hasTushare) return [];
    return MACRO_SERIES_OPTIONS.filter(
      (def) => query.length === 0 || matchesMacro(def, query),
    ).slice(0, MACRO_LIMIT);
  }

  getSuggestions(query: string): Promise<UnifiedResult[]> {
    const cat = this.categories.find((c) => c.id === this.category) ?? {
      id: "all" as CategoryId,
      label: "全部",
      remote: true,
    };
    const trimmed = query.trim().toLowerCase();
    // SuggestModal renders whatever promise resolves LAST, with no ordering
    // guard: a slow stale call resolving [] after a fast fresh one would wipe
    // the list. So only the newest call may resolve; superseded calls stay
    // pending forever and can never clobber newer results.
    return new Promise((resolve) => {
      const seq = ++this.callSeq;
      const run = () => {
        if (seq !== this.callSeq) return;
        void this.collectSuggestions(trimmed, cat).then((results) => {
          if (seq === this.callSeq) resolve(results);
        });
      };
      // Debounce remote-capable categories.
      if (cat.remote) setTimeout(run, 300);
      else run();
    });
  }

  private async collectSuggestions(query: string, cat: CategoryDef): Promise<UnifiedResult[]> {
    if (this.categories.length === 0) {
      this.updateEmptyState(t("请先在设置页配置 Tushare Token 或 FRED API Key，或使用自定义数据源。"));
      return [];
    }
    this.updateEmptyState(t("输入关键词开始搜索。"));

    const results: UnifiedResult[] = [];
    const wantsTushare = cat.id === "all" || cat.id === "tushare";
    const wantsFred = cat.id === "all" || cat.id === "fred";
    const wantedCustomSources =
      cat.id === "all"
        ? this.opts.customSources
        : this.opts.customSources.filter((s) => cat.id === `custom:${s.id}`);

    if (wantsTushare && this.opts.hasTushare) {
      await this.loadSymbols();
      results.push(...this.searchSymbols(query).map((item) => ({ kind: "symbol" as const, item })));
      results.push(...this.searchMacro(query).map((def) => ({ kind: "macro" as const, def })));
    }

    const fetches: Promise<void>[] = [];
    if (wantsFred && this.opts.hasFred && query.length > 0) {
      fetches.push(
        this.opts
          .searchFred(query)
          .then((infos) => {
            results.push(...infos.map((info) => ({ kind: "fred" as const, info })));
          })
          .catch((err) => console.error("StrataBoard: unified FRED search failed", err)),
      );
    }
    for (const source of wantedCustomSources) {
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
      if (!source.searchUrl) {
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
          result.item.assetType === "custom"
            ? (this.opts.customSources.find((s) => s.id === result.item.sourceId)?.name ??
              t("自定义"))
            : "Tushare";
        const meta = [source, t(ASSET_TYPE_LABELS[result.item.assetType]), result.item.exchange]
          .filter(Boolean)
          .join(" · ");
        el.createEl("small", { text: meta, cls: "fc-symbol-meta" });
        break;
      }
      case "fred": {
        el.createEl("div", { text: `${result.info.title} (${result.info.id})` });
        el.createEl("small", {
          text: `FRED · ${result.info.frequency}`,
          cls: "fc-symbol-meta",
        });
        break;
      }
      case "macro": {
        el.createEl("div", { text: t(result.def.label) });
        el.createEl("small", {
          text: `${t("Tushare 宏观")} · ${t(result.def.group)} · ${t(MACRO_FREQ_LABELS[result.def.freq])}`,
          cls: "fc-symbol-meta",
        });
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
      case "fred":
        this.opts.onFred(result.info);
        break;
      case "macro":
        this.opts.onMacro(result.def);
        break;
      case "manual":
        this.opts.onManual(result.sourceId, result.sourceName);
        break;
    }
  }
}
