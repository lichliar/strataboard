import { TFile, type App } from "obsidian";
import type { Freq } from "../types";
import { DEFAULT_CARD_HEIGHT } from "./card-spec";
import { redactError } from "./redact";
import { t } from "../i18n";

// Shared status UI for the three chart cards (quote/overlay/spread): loading
// skeleton, load-failure block with recovery actions, cache/stale badges and
// the empty state. One implementation replaces the three per-renderer copies
// that used to drift apart.

export interface LoadErrorActions {
  onRetry: () => void;
  // 编辑数据源 jumps to 设置 → 数据源 (the settings tab has no per-source
  // deep link, so it lands on the tab only).
  onEditSource?: () => void;
  // Script-produced sources additionally offer a rerun of the producing
  // script (the footer run button was removed; this is the script entry).
  onRunScript?: () => Promise<void>;
}

// Fixed-height shimmer placeholder while data loads (pure CSS animation,
// styles.css .fc-skeleton), replacing the old plain-text 正在加载数据 lines.
export function renderLoadingSkeleton(containerEl: HTMLElement): void {
  const el = containerEl.createDiv({ cls: "fc-skeleton" });
  el.style.height = `${DEFAULT_CARD_HEIGHT}px`;
  el.createDiv({ cls: "fc-skeleton-header" });
  el.createDiv({ cls: "fc-skeleton-chart" });
}

// Load-failure block: short reason + [重试] [编辑数据源] (+ [运行本地脚本]
// for script sources) + the full redacted error in a collapsed details.
export function renderLoadError(containerEl: HTMLElement, e: unknown, actions: LoadErrorActions): void {
  containerEl.empty();
  const errorEl = containerEl.createDiv({ cls: "strataboard-empty strataboard-load-error" });
  const full = redactError(e);
  errorEl.createDiv({ text: t("加载数据失败：{msg}", { msg: full.split("\n")[0] }) });
  const btns = errorEl.createDiv({ cls: "fc-card-status-actions" });
  const retryBtn = btns.createEl("button", { cls: "strataboard-retry-btn", text: t("重试") });
  retryBtn.addEventListener("click", actions.onRetry);
  if (actions.onEditSource) {
    const editBtn = btns.createEl("button", { cls: "strataboard-retry-btn", text: t("编辑数据源") });
    editBtn.addEventListener("click", actions.onEditSource);
  }
  if (actions.onRunScript) {
    const runBtn = btns.createEl("button", { cls: "strataboard-retry-btn", text: t("运行本地脚本") });
    runBtn.addEventListener("click", () => {
      runBtn.disabled = true;
      void actions.onRunScript!().finally(() => {
        runBtn.disabled = false;
      });
    });
  }
  const details = errorEl.createEl("details", { cls: "fc-card-status-details" });
  details.createEl("summary", { text: t("技术细节") });
  details.createEl("pre", { cls: "fc-card-status-details-body", text: full });
}

// YAML parse failure: the card cannot render at all, so the recovery entry
// is opening the card's md file for a manual fix (the edit modal needs a
// valid spec and cannot open).
export function renderParseError(containerEl: HTMLElement, message: string, onOpenCardFile: () => void): void {
  containerEl.empty();
  const el = containerEl.createDiv({ cls: "strataboard-empty strataboard-load-error" });
  el.createDiv({ cls: "strataboard-error", text: t("错误：{msg}", { msg: message }) });
  const openBtn = el.createEl("button", { cls: "strataboard-retry-btn", text: t("打开卡片文件") });
  openBtn.addEventListener("click", onOpenCardFile);
}

// Opens the card's md file in a new tab (解析失败 recovery entry).
export async function openCardFileInTab(app: App, sourcePath: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(sourcePath);
  if (file instanceof TFile) {
    await app.workspace.getLeaf("tab").openFile(file);
  }
}

// Non-blocking top-of-card badge shown when the data did NOT come from a
// fresh fetch (failure fallback / circuit-breaker): 「使用缓存 · 最后数据
// {date}」 + a refresh entry. Always visible (unlike the footer tools).
export function renderCacheBadge(containerEl: HTMLElement, lastDataAt: string | undefined, onRefresh: () => void): void {
  renderBadge(
    containerEl,
    "fc-card-badge-cache",
    lastDataAt ? t("使用缓存 · 最后数据 {date}", { date: lastDataAt }) : t("使用缓存"),
    onRefresh
  );
}

// 数据已过期 heuristic by card period: the latest bar is older than 5 days
// (daily), 14 days (weekly) or 45 days (monthly and above).
const STALE_THRESHOLD_DAYS: Record<Freq, number> = { D: 5, W: 14, M: 45, Q: 45, Y: 45 };

export function isDataStale(lastBarYmd: string, freq: Freq, now: Date = new Date()): boolean {
  const last = Date.parse(lastBarYmd);
  if (Number.isNaN(last)) return false;
  return (now.getTime() - last) / 86400000 > STALE_THRESHOLD_DAYS[freq];
}

export function renderStaleBadge(containerEl: HTMLElement, lastBarYmd: string, onRefresh: () => void): void {
  renderBadge(containerEl, "fc-card-badge-stale", t("数据已过期 · 最后数据 {date}", { date: lastBarYmd }), onRefresh);
}

function renderBadge(containerEl: HTMLElement, cls: string, text: string, onRefresh: () => void): void {
  const badge = containerEl.createDiv({ cls: `fc-card-badge ${cls}` });
  badge.createSpan({ text });
  const btn = badge.createEl("button", { cls: "fc-card-badge-btn", text: t("刷新") });
  btn.addEventListener("click", onRefresh);
  // Badges sit at the very top of the card, above the header.
  containerEl.prepend(badge);
}

// Empty state. Two copies: the source returned nothing at all (cold cache,
// empty response) vs the cache holds rows but none fall inside the selected
// range (a range problem, not a source problem).
export type EmptyKind = "source-empty" | "range-empty";

export function renderEmptyState(containerEl: HTMLElement, kind: EmptyKind): void {
  containerEl.createDiv({
    cls: "strataboard-empty",
    text: kind === "source-empty" ? t("数据源没有返回数据。") : t("所选时间范围内没有数据。"),
  });
}
