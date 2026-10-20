import { App, Modal, Notice, setIcon } from "obsidian";
import { setTooltip } from "./tooltip";
import type { CustomSourceDef, SymbolItem } from "../types";
import { sourceNeedsApiKey, sourceSupportsRemoteSearch } from "../types";
import { isDeadCode, matchSymbolEntry } from "../utils/symbol-list";
import { isScriptSource } from "../modules/script-sources";
import { getSourceHealth } from "../modules/source-health";
import { formatDateTime } from "../utils/date";
import { t } from "../i18n";
import { redactError } from "../modules/redact";

export type UnifiedResult =
  | { kind: "symbol"; item: SymbolItem }
  | { kind: "manual"; sourceId: string; sourceName: string };

// Search scope: every enabled source, only the pick history, one source
// group, or a single source. Switchable inside the modal via the 数据源
// scope panel; callers may pre-select one (toolbar submenu / edit modals).
export type CategoryId = "all" | "recent" | `custom:${string}` | `group:${string}`;

// One 最近使用 entry: the sensitive minimum (name/code/source id only).
export interface SearchHistoryEntry {
  name: string;
  tsCode: string;
  sourceId?: string;
}

export interface UnifiedSearchOptions {
  // ALL configured sources (the modal filters enabled ones for searching;
  // the scope panel also lists disabled ones as non-selectable rows).
  customSources: CustomSourceDef[];
  searchCustom: (sourceId: string, text: string) => Promise<SymbolItem[]>;
  // Local symbol cache search (symbols.db); items carry sourceId.
  searchCached: (query: string, limit?: number) => Promise<SymbolItem[]>;
  history: {
    list(): SearchHistoryEntry[];
    clear(): void;
  };
  // Whether a credentialId still resolves to a stored secret.
  hasCredential: (credentialId: string) => boolean;
  onSymbol: (item: SymbolItem) => void;
  onManual: (sourceId: string, sourceName: string) => void;
  scope?: CategoryId;
  // 「已加入 N 项」banner for continue-creation flows (compare/calc cards).
  prefilledCount?: number;
  prefilledLabel?: string;
}

const MERGED_LIMIT = 50;
const PER_SOURCE_LIMIT = 20;
const MAX_ONLINE_CONCURRENCY = 3;
// 「全部来源」with more enabled remote sources than this never offers the
// fan-out button — the user picks a source or group first.
const REMOTE_FANOUT_MAX = 5;
const DEBOUNCE_MS = 300;

type BucketState = "loading" | "done" | "failed" | "no-credential";

interface SourceBucket {
  def: CustomSourceDef;
  sectionEl: HTMLElement;
  rowsEl: HTMLElement;
  stateEl: HTMLElement;
  state: BucketState;
}

/**
 * Unified symbol search modal: three layers — search row (icon + input +
 * 数据源 scope button + clear button), scope row (current-scope chip +
 * searchable scope panel), result area (local results first, per-source
 * online buckets appended as they arrive, status footer at the bottom).
 *
 * Request strategy: the local pass (static code tables + symbols.db cache +
 * history) runs on every keystroke and never touches the network. Online
 * search auto-fires (debounced, sequence-guarded) only for single-source /
 * group scopes; 「全部来源」 requires the explicit 在线搜索 button (and is
 * refused entirely above REMOTE_FANOUT_MAX remote sources). Online fan-out
 * is capped at MAX_ONLINE_CONCURRENCY concurrent sources; a failed/timeout
 * source only marks its own bucket (with a 重试该来源 button) and never
 * clears other buckets. Whole-table sources ride the data-adapter's 24h
 * in-memory cache, so they are not re-downloaded per keystroke.
 */
export class UnifiedSearchModal extends Modal {
  private searchScope: CategoryId;
  private failedSources = new Set<string>(); // one Notice per source per session

  private inputEl!: HTMLInputElement;
  private clearBtn!: HTMLElement;
  private scopeBtnEl!: HTMLElement;
  private scopeChipEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private localEl!: HTMLElement;
  private onlineEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private panelEl: HTMLElement | null = null;
  private panelDocListener: ((e: MouseEvent) => void) | null = null;

  private localSeq = 0;
  private onlineSeq = 0;
  private debounceTimer: number | null = null;
  private onlineRunning = 0;
  private onlineQueue: { def: CustomSourceDef; seq: number }[] = [];
  private onlineTotals = { total: 0, done: 0, failed: 0 };
  private onlineActive = false;
  private onlineShown = 0;
  private buckets = new Map<string, SourceBucket>();

  private selectable: { result: UnifiedResult; el: HTMLElement }[] = [];
  private activeIndex = -1;

  constructor(app: App, private opts: UnifiedSearchOptions) {
    super(app);
    this.searchScope = opts.scope ?? "all";
  }

  onOpen(): void {
    this.modalEl.addClass("fc-usearch-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("fc-usearch");

    // Layer 1: search row.
    const searchRow = contentEl.createDiv("fc-usearch-search-row");
    const iconEl = searchRow.createSpan("fc-usearch-search-icon");
    setIcon(iconEl, "search");
    this.inputEl = searchRow.createEl("input", {
      cls: "fc-usearch-input",
      attr: { type: "text", placeholder: t("搜索名称或代码") },
    });
    this.scopeBtnEl = searchRow.createEl("button", { cls: "fc-usearch-scope-btn", text: t("数据源") });
    setTooltip(this.scopeBtnEl, t("数据源范围"));
    this.scopeBtnEl.addEventListener("click", () => this.toggleScopePanel());
    this.clearBtn = searchRow.createSpan("fc-usearch-clear");
    setIcon(this.clearBtn, "x");
    setTooltip(this.clearBtn, t("清空输入"));
    this.clearBtn.addEventListener("click", () => {
      this.inputEl.value = "";
      this.clearBtn.style.display = "none";
      this.onQueryChanged();
      this.inputEl.focus();
    });
    this.clearBtn.style.display = "none";

    // Layer 2: scope row (current-scope chip; click opens the scope panel).
    const scopeRow = contentEl.createDiv("fc-usearch-scope-row");
    this.scopeChipEl = scopeRow.createSpan({ cls: "fc-usearch-chip", text: this.scopeLabel() });
    this.scopeChipEl.addEventListener("click", () => this.toggleScopePanel());

    // Continue-creation banner (compare/calc flows).
    if (this.opts.prefilledCount !== undefined) {
      contentEl.createDiv({
        cls: "fc-usearch-prefilled",
        text:
          t("已加入 {n} 项", { n: this.opts.prefilledCount }) +
          (this.opts.prefilledLabel ? `：${this.opts.prefilledLabel}` : ""),
      });
    }

    // Layer 3: results + status footer.
    this.resultsEl = contentEl.createDiv("fc-usearch-results");
    this.localEl = this.resultsEl.createDiv("fc-usearch-local");
    this.onlineEl = this.resultsEl.createDiv("fc-usearch-online");
    this.footerEl = contentEl.createDiv("fc-usearch-footer");

    this.inputEl.addEventListener("input", () => {
      this.clearBtn.style.display = this.inputEl.value ? "" : "none";
      this.onQueryChanged();
    });
    // Focus selects the previous query text but never fires a search.
    this.inputEl.addEventListener("focus", () => this.inputEl.select());
    this.inputEl.addEventListener("keydown", (e) => this.onInputKeydown(e));

    this.inputEl.focus();
    void this.runLocalSearch();
  }

  onClose(): void {
    this.onlineSeq++; // invalidate in-flight online work
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.closeScopePanel();
    this.contentEl.empty();
  }

  // ==================== Scope ====================

  private scopeLabel(): string {
    if (this.searchScope === "all") return t("全部来源");
    if (this.searchScope === "recent") return t("最近使用");
    if (this.searchScope.startsWith("group:")) return this.searchScope.slice("group:".length);
    const id = this.searchScope.slice("custom:".length);
    return this.opts.customSources.find((s) => s.id === id)?.name ?? t("数据源");
  }

  // Search candidates of the current scope (enabled sources only; the
  // 「最近使用」 scope searches no source at all).
  private scopedSources(): CustomSourceDef[] {
    if (this.searchScope === "recent") return [];
    let sources = this.opts.customSources;
    if (this.searchScope.startsWith("group:")) {
      const group = this.searchScope.slice("group:".length);
      sources = sources.filter((s) => s.group === group);
    } else if (this.searchScope.startsWith("custom:")) {
      const id = this.searchScope.slice("custom:".length);
      sources = sources.filter((s) => s.id === id);
    }
    return sources.filter((s) => s.enabled);
  }

  private setScope(scope: CategoryId): void {
    if (scope === this.searchScope) return;
    this.searchScope = scope;
    this.scopeChipEl.textContent = this.scopeLabel();
    this.cancelOnline();
    void this.runLocalSearch();
    // Single-source / group scopes search online automatically.
    if (scope !== "all" && scope !== "recent" && this.inputEl.value.trim()) {
      this.scheduleOnline();
    }
    this.inputEl.focus();
  }

  private toggleScopePanel(): void {
    if (this.panelEl) {
      this.closeScopePanel();
      return;
    }
    const panel = this.contentEl.createDiv("fc-usearch-scope-panel");
    this.panelEl = panel;
    const filter = panel.createEl("input", {
      cls: "fc-usearch-scope-filter",
      attr: { type: "text", placeholder: t("搜索数据源…") },
    });
    const list = panel.createDiv("fc-usearch-scope-list");
    const renderList = () => {
      list.empty();
      const query = filter.value.trim().toLowerCase();
      this.renderScopePanelEntries(list, query);
    };
    filter.addEventListener("input", renderList);
    filter.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.closeScopePanel();
        this.inputEl.focus();
      }
    });
    renderList();
    filter.focus();
    // Clicking outside the panel closes it — except clicks on the two
    // toggles (数据源 button / scope chip), whose own click handler must be
    // the one to close it (mousedown-before-click would close + reopen).
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        this.panelEl &&
        !this.panelEl.contains(target) &&
        !this.scopeBtnEl.contains(target) &&
        !this.scopeChipEl.contains(target)
      ) {
        this.closeScopePanel();
      }
    };
    this.panelDocListener = onDocDown;
    document.addEventListener("mousedown", onDocDown, true);
  }

  private closeScopePanel(): void {
    if (this.panelDocListener) {
      document.removeEventListener("mousedown", this.panelDocListener, true);
      this.panelDocListener = null;
    }
    this.panelEl?.detach();
    this.panelEl = null;
  }

  private renderScopePanelEntries(list: HTMLElement, query: string): void {
    const match = (label: string) => !query || label.toLowerCase().includes(query);
    const addRow = (opts: {
      label: string;
      meta?: string;
      scope: CategoryId;
      disabled?: boolean;
      badges?: HTMLElement[];
    }) => {
      if (!match(opts.label)) return;
      const row = list.createDiv({
        cls:
          "fc-usearch-scope-item" +
          (this.searchScope === opts.scope ? " is-active" : "") +
          (opts.disabled ? " is-disabled" : ""),
      });
      row.createSpan({ cls: "fc-usearch-scope-item-label", text: opts.label });
      if (opts.meta) row.createSpan({ cls: "fc-usearch-scope-item-meta", text: opts.meta });
      for (const badge of opts.badges ?? []) row.appendChild(badge);
      if (opts.disabled) return;
      row.addEventListener("click", () => {
        this.closeScopePanel();
        this.setScope(opts.scope);
      });
    };

    addRow({ label: t("全部来源"), scope: "all" });
    addRow({ label: t("最近使用"), scope: "recent" });

    const sources = this.opts.customSources;
    const groups = [...new Set(sources.map((s) => s.group).filter((g): g is string => !!g))];
    for (const group of groups) {
      const count = sources.filter((s) => s.group === group).length;
      addRow({ label: group, meta: t("数据源组 · {n} 个源", { n: count }), scope: `group:${group}` });
    }
    for (const def of sources) {
      const typeLabel = isScriptSource(def) ? t("脚本") : def.format === "csv" ? t("CSV") : t("REST");
      const badges: HTMLElement[] = [];
      // Session connection badge (modules/source-health.ts), same rendering
      // as the 数据源 settings rows.
      const health = getSourceHealth(def.id);
      const badge = createSpan({
        cls: `fc-source-health fc-source-health-${health?.state ?? "unknown"}`,
        text: !health ? t("未探测") : health.state === "ok" ? t("正常") : t("失败"),
      });
      if (health?.state === "ok") {
        setTooltip(badge, t("最近成功：{time}", { time: formatDateTime(health.at) }));
      } else if (health?.state === "failed") {
        setTooltip(badge, t("最近失败：{time}\n{msg}", { time: formatDateTime(health.at), msg: health.message ?? "" }));
      }
      badges.push(badge);
      if (this.credentialMissing(def)) {
        badges.push(createSpan({ cls: "fc-usearch-tag fc-usearch-cred-missing", text: t("未配置凭据") }));
      }
      if (!def.enabled) {
        badges.push(createSpan({ cls: "fc-usearch-tag", text: t("已禁用") }));
      }
      addRow({
        label: def.name,
        meta: typeLabel,
        scope: `custom:${def.id}`,
        disabled: !def.enabled,
        badges,
      });
    }
  }

  // The endpoint expects a credential (an {apiKey} placeholder somewhere)
  // but none is configured or the referenced secret is gone.
  private credentialMissing(def: CustomSourceDef): boolean {
    return sourceNeedsApiKey(def) && (!def.credentialId || !this.opts.hasCredential(def.credentialId));
  }

  // ==================== Local search ====================

  private onQueryChanged(): void {
    this.cancelOnline();
    void this.runLocalSearch();
    if (this.searchScope !== "all" && this.searchScope !== "recent" && this.inputEl.value.trim()) {
      this.scheduleOnline();
    }
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

  private sourceName(sourceId: string | undefined): string {
    return this.opts.customSources.find((s) => s.id === sourceId)?.name ?? t("自定义");
  }

  private async runLocalSearch(): Promise<void> {
    const seq = ++this.localSeq;
    const query = this.inputEl.value.trim().toLowerCase();
    const sources = this.scopedSources();

    interface Candidate {
      item: SymbolItem;
      history: boolean;
    }
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    const push = (item: SymbolItem, history: boolean) => {
      const key = `${item.sourceId ?? ""}:${item.tsCode}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ item, history });
    };

    // 最近使用 history: matches by name/code; entries pointing at deleted
    // sources are dropped. In source/group scopes only that scope's entries.
    for (const entry of this.opts.history.list()) {
      const src = entry.sourceId ? this.opts.customSources.find((s) => s.id === entry.sourceId) : undefined;
      if (entry.sourceId && !src) continue;
      if (this.searchScope !== "all" && this.searchScope !== "recent") {
        if (!entry.sourceId || !sources.some((s) => s.id === entry.sourceId)) continue;
      }
      if (query && !entry.name.toLowerCase().includes(query) && !entry.tsCode.toLowerCase().includes(query)) continue;
      push(
        {
          tsCode: entry.tsCode,
          symbol: entry.tsCode,
          name: entry.name,
          exchange: src?.name ?? "",
          assetType: "custom",
          sourceId: entry.sourceId,
        },
        true
      );
    }

    if (this.searchScope !== "recent") {
      // Static code tables: local named picks without a server-side search.
      for (const source of sources) {
        for (const entry of source.symbols ?? []) {
          if (!matchSymbolEntry(entry, query)) continue;
          push(
            {
              tsCode: entry.code,
              symbol: entry.code,
              name: entry.name,
              exchange: source.name,
              assetType: "custom",
              sourceId: source.id,
            },
            false
          );
        }
      }
      // Symbol cache (symbols.db): codes picked or probed before.
      if (query) {
        const cached = await this.opts.searchCached(query, MERGED_LIMIT).catch(() => [] as SymbolItem[]);
        if (seq !== this.localSeq) return;
        const ids = new Set(sources.map((s) => s.id));
        for (const item of cached) {
          if (item.sourceId && !ids.has(item.sourceId)) continue;
          push({ ...item, exchange: item.exchange || this.sourceName(item.sourceId) }, false);
        }
      }
    }
    if (seq !== this.localSeq) return;

    candidates.sort((a, b) =>
      query ? this.relevanceRank(a.item, query) - this.relevanceRank(b.item, query) : 0
    );
    this.renderLocalResults(candidates.slice(0, MERGED_LIMIT), query, sources);
  }

  // ==================== Rendering ====================

  private renderLocalResults(candidates: { item: SymbolItem; history: boolean }[], query: string, sources: CustomSourceDef[]): void {
    this.localEl.empty();
    this.selectable = [];
    this.activeIndex = -1;

    if (this.opts.customSources.length === 0) {
      this.localEl.createDiv({ cls: "fc-usearch-empty", text: t("请先在设置页添加并启用自定义数据源。") });
      this.updateFooter();
      return;
    }

    const historyCands = candidates.filter((c) => c.history);
    const otherCands = candidates.filter((c) => !c.history);

    if (this.searchScope === "recent") {
      if (historyCands.length === 0) {
        this.localEl.createDiv({
          cls: "fc-usearch-empty",
          text: query ? t("未找到匹配结果") : t("暂无最近使用的代码。"),
        });
      } else {
        this.renderHistorySection(historyCands);
      }
    } else if (query) {
      // Ranked flat list: history entries take ties (pushed first, stable sort).
      for (const cand of candidates) {
        this.renderResultRow(this.localEl, { kind: "symbol", item: cand.item });
      }
      if (candidates.length === 0) {
        this.localEl.createDiv({ cls: "fc-usearch-empty", text: t("未找到匹配结果") });
      }
    } else {
      // Browse mode: history as a 最近使用 group, then the static picks.
      if (historyCands.length > 0) this.renderHistorySection(historyCands);
      for (const cand of otherCands) {
        this.renderResultRow(this.localEl, { kind: "symbol", item: cand.item });
      }
      if (candidates.length === 0) {
        this.localEl.createDiv({ cls: "fc-usearch-empty", text: t("输入关键词开始搜索。") });
      }
    }

    // Sources without remote search keep the constant manual-entry result.
    for (const source of sources) {
      if (sourceSupportsRemoteSearch(source)) continue;
      this.renderResultRow(this.localEl, { kind: "manual", sourceId: source.id, sourceName: source.name });
    }

    // 「全部来源」never searches online on its own: ≥2 chars reveal the
    // explicit fan-out action; too many remote sources refuse it entirely.
    if (this.searchScope === "all" && query.length >= 2 && !this.onlineActive) {
      const remoteCount = sources.filter((s) => sourceSupportsRemoteSearch(s)).length;
      const action = this.localEl.createDiv("fc-usearch-online-action");
      if (remoteCount > REMOTE_FANOUT_MAX) {
        action.createSpan({
          cls: "fc-usearch-hint",
          text: t("远程来源较多（{n} 个）：请先在「数据源」中选择来源或来源组。", { n: remoteCount }),
        });
        const pick = action.createEl("button", { text: t("改选数据源") });
        pick.addEventListener("click", () => this.toggleScopePanel());
      } else if (remoteCount > 0) {
        const btn = action.createEl("button", {
          cls: "fc-usearch-online-btn",
          text: t("在线搜索全部来源（可能较慢）"),
        });
        btn.addEventListener("click", () => this.startOnlineSearch());
      }
    }

    this.setActiveIndex(this.selectable.length > 0 ? 0 : -1);
    this.updateFooter();
    // Result refreshes must never move focus out of the search box.
    this.inputEl.focus({ preventScroll: true });
  }

  private renderHistorySection(cands: { item: SymbolItem; history: boolean }[]): void {
    const section = this.localEl.createDiv("fc-usearch-history");
    const header = section.createDiv("fc-usearch-section-header");
    header.createSpan({ text: t("最近使用") });
    const clear = header.createEl("button", { cls: "fc-usearch-clear-history", text: t("清空历史") });
    clear.addEventListener("click", () => {
      this.opts.history.clear();
      void this.runLocalSearch();
    });
    for (const cand of cands) {
      this.renderResultRow(section, { kind: "symbol", item: cand.item });
    }
  }

  private renderResultRow(parent: HTMLElement, result: UnifiedResult): void {
    const el = parent.createDiv({ cls: "fc-usearch-row" });
    const main = el.createDiv("fc-usearch-row-main");
    switch (result.kind) {
      case "symbol": {
        main.createDiv({ text: `${result.item.name} (${result.item.tsCode})` });
        const def = this.opts.customSources.find((s) => s.id === result.item.sourceId);
        // Declared-dead codes stay selectable but are marked — never
        // silently removed from results.
        const dead = result.item.dead || (def ? isDeadCode(def, result.item.tsCode) : false);
        const meta = [this.sourceName(result.item.sourceId), result.item.exchange, dead ? t("已知无行情") : ""]
          .filter(Boolean)
          .join(" · ");
        main.createEl("small", { text: meta, cls: "fc-symbol-meta" });
        break;
      }
      case "manual": {
        main.createDiv({ text: t("手工录入代码") });
        main.createEl("small", {
          text: `${result.sourceName} · ${t("自定义")}`,
          cls: "fc-symbol-meta",
        });
        break;
      }
    }
    const entry = { result, el };
    const index = this.selectable.length;
    this.selectable.push(entry);
    el.addEventListener("click", () => this.choose(result));
    el.addEventListener("mousemove", () => this.setActiveIndex(index));
  }

  private setActiveIndex(index: number): void {
    this.activeIndex = index;
    this.selectable.forEach((entry, i) => {
      entry.el.classList.toggle("is-active", i === index);
    });
    if (index >= 0) {
      this.selectable[index].el.scrollIntoView({ block: "nearest" });
    }
  }

  private moveActive(delta: number): void {
    if (this.selectable.length === 0) return;
    const next = this.activeIndex < 0 ? 0 : (this.activeIndex + delta + this.selectable.length) % this.selectable.length;
    this.setActiveIndex(next);
  }

  private onInputKeydown(e: KeyboardEvent): void {
    if (e.isComposing) return; // IME composition (Chinese input) owns the key
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const sel = this.selectable[this.activeIndex] ?? this.selectable[0];
      if (sel) this.choose(sel.result);
    }
    // Escape falls through to the Modal's default close.
  }

  private choose(result: UnifiedResult): void {
    this.close();
    switch (result.kind) {
      case "symbol":
        this.opts.onSymbol(result.item);
        break;
      case "manual":
        this.opts.onManual(result.sourceId, result.sourceName);
        break;
    }
  }

  private updateFooter(): void {
    this.footerEl.empty();
    this.footerEl.createSpan({ text: this.scopeLabel() });
    this.footerEl.createSpan({ text: t("{n} 条结果", { n: this.selectable.length }) });
    if (this.onlineActive) {
      const { total, done, failed } = this.onlineTotals;
      const status =
        done < total
          ? t("在线查询中（{done}/{total}）", { done, total })
          : failed > 0
            ? t("{n} 个来源搜索失败", { n: failed })
            : t("在线查询完成");
      this.footerEl.createSpan({ text: status });
    }
  }

  // ==================== Online search ====================

  private scheduleOnline(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.startOnlineSearch();
    }, DEBOUNCE_MS);
  }

  private cancelOnline(): void {
    // A new round owns the sequence; queued jobs carrying the old seq skip
    // themselves and in-flight results are dropped on arrival.
    this.onlineSeq++;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.onlineQueue = [];
    this.onlineActive = false;
    this.buckets.clear();
    this.onlineEl.empty();
    this.updateFooter();
  }

  private startOnlineSearch(): void {
    const seq = ++this.onlineSeq;
    this.onlineQueue = [];
    this.onlineEl.empty();
    this.buckets.clear();
    this.onlineActive = true;
    this.onlineShown = 0;

    const remoteSources = this.scopedSources().filter((s) => sourceSupportsRemoteSearch(s));
    this.onlineTotals = { total: remoteSources.length, done: 0, failed: 0 };
    for (const def of remoteSources) {
      const section = this.onlineEl.createDiv("fc-usearch-bucket");
      const header = section.createDiv("fc-usearch-bucket-header");
      header.createSpan({ cls: "fc-usearch-bucket-name", text: def.name });
      const stateEl = header.createSpan("fc-usearch-bucket-state");
      const rowsEl = section.createDiv("fc-usearch-bucket-rows");
      const bucket: SourceBucket = { def, sectionEl: section, rowsEl, stateEl, state: "loading" };
      this.buckets.set(def.id, bucket);
      if (this.credentialMissing(def)) {
        // Never fire a request that can only 401: mark the bucket instead.
        bucket.state = "no-credential";
        bucket.stateEl.setText(t("未配置凭据"));
        bucket.stateEl.addClass("fc-usearch-cred-missing");
        rowsEl.createDiv({
          cls: "fc-usearch-empty",
          text: t("「{name}」未配置凭据，无法在线搜索。", { name: def.name }),
        });
        this.onlineTotals.done++;
        continue;
      }
      bucket.stateEl.setText(t("搜索中…"));
      this.onlineQueue.push({ def, seq });
    }
    this.updateFooter();
    this.pumpOnlineQueue();
  }

  // Concurrency pool: at most MAX_ONLINE_CONCURRENCY source requests in
  // flight; the rest wait in FIFO order. No external library needed.
  private pumpOnlineQueue(): void {
    while (this.onlineRunning < MAX_ONLINE_CONCURRENCY && this.onlineQueue.length > 0) {
      const job = this.onlineQueue.shift()!;
      if (job.seq !== this.onlineSeq) continue;
      this.onlineRunning++;
      void this.searchOneSource(job.def, job.seq).finally(() => {
        this.onlineRunning--;
        this.pumpOnlineQueue();
      });
    }
  }

  private async searchOneSource(def: CustomSourceDef, seq: number): Promise<void> {
    const query = this.inputEl.value.trim();
    try {
      const items = await this.opts.searchCustom(def.id, query);
      if (seq !== this.onlineSeq) return;
      const bucket = this.buckets.get(def.id);
      if (!bucket) return;
      bucket.state = "done";
      bucket.stateEl.setText("");
      // Per-source candidate cap + global merged cap.
      const budget = Math.min(PER_SOURCE_LIMIT, MERGED_LIMIT - this.onlineShown);
      for (const item of items.slice(0, Math.max(0, budget))) {
        this.onlineShown++;
        this.renderResultRow(bucket.rowsEl, {
          kind: "symbol",
          item: { ...item, sourceId: item.sourceId ?? def.id },
        });
      }
      if (items.length === 0) {
        bucket.rowsEl.createDiv({ cls: "fc-usearch-empty", text: t("未找到匹配结果") });
      }
    } catch (err) {
      if (seq !== this.onlineSeq) return;
      const bucket = this.buckets.get(def.id);
      this.onlineTotals.failed++;
      console.error(`StrataBoard: custom source search failed (${def.name})`, redactError(err));
      if (!this.failedSources.has(def.id)) {
        this.failedSources.add(def.id);
        new Notice(t("数据源「{name}」搜索失败：{msg}", { name: def.name, msg: redactError(err) }));
      }
      if (bucket) this.renderFailedBucket(bucket, redactError(err));
    } finally {
      if (seq === this.onlineSeq) {
        this.onlineTotals.done++;
        this.updateFooter();
        this.inputEl.focus({ preventScroll: true });
      }
    }
  }

  // A failed source keeps every other source's results: only its own bucket
  // shows the failure, with 重试该来源 and 改选数据源 actions.
  private renderFailedBucket(bucket: SourceBucket, message: string): void {
    bucket.state = "failed";
    bucket.stateEl.setText(t("搜索失败"));
    bucket.stateEl.addClass("fc-usearch-bucket-failed");
    bucket.rowsEl.empty();
    const row = bucket.rowsEl.createDiv("fc-usearch-bucket-error");
    row.createSpan({ cls: "fc-usearch-hint", text: message });
    const retry = row.createEl("button", { text: t("重试该来源") });
    retry.addEventListener("click", () => this.retrySource(bucket.def));
    const repick = row.createEl("button", { text: t("改选数据源") });
    repick.addEventListener("click", () => this.toggleScopePanel());
  }

  private retrySource(def: CustomSourceDef): void {
    const bucket = this.buckets.get(def.id);
    if (!bucket) return;
    const seq = this.onlineSeq;
    bucket.state = "loading";
    bucket.rowsEl.empty();
    bucket.stateEl.removeClass("fc-usearch-bucket-failed");
    bucket.stateEl.setText(t("搜索中…"));
    this.onlineTotals.failed = Math.max(0, this.onlineTotals.failed - 1);
    this.onlineTotals.done--;
    this.onlineQueue.push({ def, seq });
    this.updateFooter();
    this.pumpOnlineQueue();
    this.inputEl.focus({ preventScroll: true });
  }
}
