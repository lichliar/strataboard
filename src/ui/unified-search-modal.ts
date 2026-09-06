import { App, SuggestModal } from "obsidian";
import type {
  CustomSourceDef,
  FredSeriesInfo,
  MacroSeriesDef,
  SymbolItem,
} from "../types";
import { ASSET_TYPE_LABELS, MACRO_SERIES_OPTIONS } from "../types";
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

type CategoryId =
  | "all"
  | "stock"
  | "fund"
  | "index"
  | "cb"
  | "fut"
  | "fx"
  | "macro"
  | "fred"
  | "custom";

interface CategoryDef {
  id: CategoryId;
  label: string;
  assetTypes?: string[];
  remote?: boolean;
}

const CATEGORIES: CategoryDef[] = [
  { id: "all", label: "全部", remote: true },
  { id: "stock", label: "股票", assetTypes: ["stock", "hk"] },
  { id: "fund", label: "基金", assetTypes: ["fund"] },
  { id: "index", label: "指数", assetTypes: ["index", "nhindex", "gbindex", "sw"] },
  { id: "cb", label: "可转债", assetTypes: ["cb"] },
  { id: "fut", label: "期货", assetTypes: ["fut"] },
  { id: "fx", label: "外汇", assetTypes: ["fx"] },
  { id: "macro", label: "宏观" },
  { id: "fred", label: "FRED", remote: true },
  { id: "custom", label: "自定义", remote: true },
];

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
 * Unified 「插入数据」 picker: one search box with category chips that fans out
 * across the local symbol index, the Tushare macro catalog, the FRED API, and
 * every enabled custom quote source. Custom sources without a search URL
 * surface a constant manual-entry result instead.
 */
export class UnifiedSearchModal extends SuggestModal<UnifiedResult> {
  private category: CategoryId = "all";
  private chipEls = new Map<CategoryId, HTMLButtonElement>();
  private symbolsCache: SymbolItem[] | null = null;
  private callSeq = 0;

  constructor(app: App, private opts: UnifiedSearchOptions) {
    super(app);
    this.setPlaceholder(t("输入代码或名称搜索（美的集团 / 600519 / DGS10…）"));
    this.setInstructions([
      { command: "↑↓", purpose: t("选择") },
      { command: "↵", purpose: t("插入卡片") },
      { command: "esc", purpose: t("关闭") },
    ]);
  }

  onOpen(): void {
    super.onOpen();
    const chips = createDiv({ cls: "fc-cat-chips" });
    for (const cat of CATEGORIES) {
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

  private searchSymbols(query: string, assetTypes: string[] | undefined): SymbolItem[] {
    if (!this.symbolsCache) return [];
    return this.symbolsCache
      .filter(
        (item) =>
          (!assetTypes || assetTypes.includes(item.assetType)) &&
          (query.length === 0 || matchesSymbol(item, query)),
      )
      .slice(0, SYMBOL_LIMIT);
  }

  private searchMacro(query: string): MacroSeriesDef[] {
    if (!this.opts.hasTushare) return [];
    return MACRO_SERIES_OPTIONS.filter(
      (def) => query.length === 0 || matchesMacro(def, query),
    ).slice(0, MACRO_LIMIT);
  }

  private async searchRemote(query: string, category: CategoryId): Promise<UnifiedResult[]> {
    const results: UnifiedResult[] = [];
    const fetches: Promise<void>[] = [];
    if ((category === "all" || category === "fred") && this.opts.hasFred) {
      fetches.push(
        this.opts
          .searchFred(query)
          .then((infos) => {
            results.push(...infos.map((info) => ({ kind: "fred" as const, info })));
          })
          .catch((err) => console.error("StrataBoard: unified FRED search failed", err)),
      );
    }
    if (category === "all" || category === "custom") {
      for (const source of this.opts.customSources) {
        if (source.searchUrl) {
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
        } else {
          results.push({ kind: "manual", sourceId: source.id, sourceName: source.name });
        }
      }
    }
    await Promise.all(fetches);
    return results;
  }

  getSuggestions(query: string): Promise<UnifiedResult[]> {
    const cat = CATEGORIES.find((c) => c.id === this.category)!;
    const trimmed = query.trim().toLowerCase();
    if (cat.remote) {
      // Debounce remote-capable categories.
      return new Promise((resolve) => {
        const seq = ++this.callSeq;
        setTimeout(() => {
          void this.collectSuggestions(trimmed, cat).then((results) => {
            if (seq === this.callSeq) resolve(results);
            else resolve([]);
          });
        }, 300);
      });
    }
    return this.collectSuggestions(trimmed, cat);
  }

  private async collectSuggestions(query: string, cat: CategoryDef): Promise<UnifiedResult[]> {
    if (cat.id === "custom" && this.opts.customSources.length === 0) {
      this.updateEmptyState(t("尚无启用的自定义数据源，请在设置页添加。"));
      return [];
    }
    if (cat.id === "fred" && !this.opts.hasFred) {
      this.updateEmptyState(t("请先在设置页配置 FRED API Key。"));
      return [];
    }
    if (cat.id === "macro" && !this.opts.hasTushare) {
      this.updateEmptyState(t("请先在设置页配置 Tushare Token。"));
      return [];
    }
    if (cat.id === "all" && !this.opts.hasTushare && !this.opts.hasFred) {
      this.updateEmptyState(
        this.opts.customSources.length === 0
          ? t("请先在设置页配置 Tushare Token 或 FRED API Key。")
          : t("请先在设置页配置 Tushare Token 或 FRED API Key，或使用自定义数据源。"),
      );
      if (this.opts.customSources.length === 0) return [];
    } else {
      this.updateEmptyState(t("输入关键词开始搜索。"));
    }

    const results: UnifiedResult[] = [];
    const symbolCats =
      cat.id === "all"
        ? ["stock", "fund", "index", "cb", "fut", "fx"]
        : cat.assetTypes
          ? [cat.id]
          : [];
    const symbolAssetTypes = cat.id === "all" ? undefined : cat.assetTypes;

    if (symbolCats.length > 0 || (cat.id === "all" && this.opts.hasTushare)) {
      if (this.opts.hasTushare) {
        await this.loadSymbols();
        const symbols = this.searchSymbols(query, symbolAssetTypes);
        if (query.length === 0 && symbols.length === 0) {
          this.updateEmptyState(t("请先在设置页配置 Tushare Token。"));
        }
        results.push(...symbols.map((item) => ({ kind: "symbol" as const, item })));
      } else if (cat.assetTypes) {
        this.updateEmptyState(t("请先在设置页配置 Tushare Token。"));
      }
    }
    if (cat.id === "all" || cat.id === "macro") {
      results.push(...this.searchMacro(query).map((def) => ({ kind: "macro" as const, def })));
    }
    if (cat.remote && (query.length > 0 || cat.id === "custom")) {
      results.push(...(await this.searchRemote(query, cat.id)));
    }
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
