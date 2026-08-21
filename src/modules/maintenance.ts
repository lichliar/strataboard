import { TFile, type App } from "obsidian";
import { findMacroSeriesDef, type AssetType, type SeriesRef } from "../types";
import { parseCardSpec } from "./card-spec";
import {
  parseFredCardSpec,
  parseMacroCardSpec,
  parseOverlaySpec,
  parseSpreadSpec,
} from "./series-spec";
import type { SqliteCache } from "./sqlite-cache";

// Scan logic for the two settings-tab cleanup features (orphan card files,
// stale cache entries). Pure data collection — all UI lives in
// ui/cleanup-modal.ts and settings.ts.

const PLUGIN_BLOCK_TYPES = new Set([
  "tushare",
  "fred",
  "macro",
  "overlay",
  "spread",
  "financial-widget",
  "calendar",
]);

const FENCED_BLOCK_RE = /```(\w+)\n([\s\S]*?)```/g;

interface PluginBlock {
  type: string;
  body: string;
}

function extractPluginBlocks(content: string): PluginBlock[] {
  const blocks: PluginBlock[] = [];
  for (const match of content.matchAll(FENCED_BLOCK_RE)) {
    if (PLUGIN_BLOCK_TYPES.has(match[1])) {
      blocks.push({ type: match[1], body: match[2] });
    }
  }
  return blocks;
}

// ==================== Orphan card files ====================

// A card file under one of the card folders is orphaned when nothing links to
// it: no canvas file node, no wikilink from any note, and no SeriesRef.cardPath
// from any overlay/spread spec. Anything unparseable is treated as "still
// referenced" — better to keep a file than to delete a live one.
export async function findOrphanCardFiles(app: App, cardFolders: string[]): Promise<TFile[]> {
  const folders = cardFolders.map((f) => f.trim()).filter((f) => f.length > 0);
  if (folders.length === 0) return [];

  const referenced = new Set<string>();

  // 1. Canvas file nodes.
  for (const file of app.vault.getFiles()) {
    if (file.extension !== "canvas") continue;
    try {
      const canvas = JSON.parse(await app.vault.cachedRead(file)) as {
        nodes?: { type?: string; file?: string }[];
      };
      for (const node of canvas.nodes ?? []) {
        if (node.type === "file" && typeof node.file === "string") {
          referenced.add(node.file);
        }
      }
    } catch {
      // Unparseable canvas: skip it rather than risking a false orphan.
    }
  }

  // 2. Wikilinks/embeds from any note (Obsidian's own resolved-link index).
  for (const targets of Object.values(app.metadataCache.resolvedLinks)) {
    for (const target of Object.keys(targets)) {
      referenced.add(target);
    }
  }

  // 3. SeriesRef.cardPath from overlay/spread blocks in any note. Scanning
  // every md file (not just linked ones) keeps whole reference chains alive.
  const candidates: TFile[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const content = await app.vault.cachedRead(file);
    const blocks = extractPluginBlocks(content);
    for (const block of blocks) {
      if (block.type !== "overlay" && block.type !== "spread") continue;
      const result =
        block.type === "overlay" ? parseOverlaySpec(block.body) : parseSpreadSpec(block.body);
      for (const ref of result.spec?.series ?? []) {
        if (ref.source === "card" && ref.cardPath) referenced.add(ref.cardPath);
      }
    }
    if (isUnderFolders(file.path, folders) && isPluginCardFile(file, blocks, content)) {
      candidates.push(file);
    }
  }

  return candidates.filter((file) => !referenced.has(file.path));
}

function isUnderFolders(path: string, folders: string[]): boolean {
  return folders.some((folder) => path.startsWith(`${folder}/`));
}

// Only files that actually carry a plugin card (fenced block or fc-key
// frontmatter) are cleanup candidates — plain notes the user keeps in the
// card folders are left alone.
function isPluginCardFile(file: TFile, blocks: PluginBlock[], content: string): boolean {
  if (blocks.length > 0) return true;
  const frontmatter = content.startsWith("---") ? content.slice(0, content.indexOf("---", 3)) : "";
  return frontmatter.includes("fc-key:");
}

// ==================== Stale cache entries ====================

export interface UsedCacheKeys {
  quotes: Set<string>; // "symbol|assetType"
  macro: Set<string>; // "api|seriesId" (api = Tushare API name, the macro_series.source column)
  fred: Set<string>; // "seriesId" or "seriesId@transform"
}

// Scans every markdown file in the vault (cards may also live inline in any
// note via insertCardIntoMd) and collects the cache keys its cards use.
export async function collectUsedCacheKeys(app: App): Promise<UsedCacheKeys> {
  const keys: UsedCacheKeys = { quotes: new Set(), macro: new Set(), fred: new Set() };
  const visitedCards = new Set<string>();
  for (const file of app.vault.getMarkdownFiles()) {
    const content = await app.vault.cachedRead(file);
    for (const block of extractPluginBlocks(content)) {
      await collectBlockKeys(app, block, keys, visitedCards);
    }
  }
  return keys;
}

async function collectBlockKeys(
  app: App,
  block: PluginBlock,
  keys: UsedCacheKeys,
  visitedCards: Set<string>
): Promise<void> {
  switch (block.type) {
    case "tushare": {
      const result = parseCardSpec(block.body);
      if (!result.ok) return;
      const spec = result.spec;
      if (spec.contentType || spec.widgetType) return; // widget/calendar: no market data
      keys.quotes.add(`${spec.symbol}|${spec.assetType}`);
      return;
    }
    case "fred": {
      const result = parseFredCardSpec(block.body);
      if (!result.spec) return;
      keys.fred.add(fredCacheId(result.spec.seriesId, result.spec.transform));
      return;
    }
    case "macro": {
      const result = parseMacroCardSpec(block.body);
      if (!result.spec) return;
      addMacroKey(keys, result.spec.seriesId);
      return;
    }
    case "overlay":
    case "spread": {
      const result =
        block.type === "overlay" ? parseOverlaySpec(block.body) : parseSpreadSpec(block.body);
      if (!result.spec) return;
      for (const ref of result.spec.series) {
        await collectRefKeys(app, ref, keys, visitedCards);
      }
      return;
    }
  }
}

async function collectRefKeys(
  app: App,
  ref: SeriesRef,
  keys: UsedCacheKeys,
  visitedCards: Set<string>
): Promise<void> {
  switch (ref.source) {
    case "quote":
      keys.quotes.add(`${ref.tsCode}|${ref.assetType}`);
      return;
    case "macro":
      if (ref.seriesId) addMacroKey(keys, ref.seriesId);
      return;
    case "fred":
      if (ref.seriesId) keys.fred.add(fredCacheId(ref.seriesId, ref.transform));
      return;
    case "card": {
      // Follow the referenced spread card (cycle-safe) — its own series count
      // as used too.
      const cardPath = ref.cardPath;
      if (!cardPath || visitedCards.has(cardPath)) return;
      visitedCards.add(cardPath);
      const file = app.vault.getAbstractFileByPath(cardPath);
      if (!(file instanceof TFile)) return;
      const content = await app.vault.cachedRead(file);
      for (const block of extractPluginBlocks(content)) {
        await collectBlockKeys(app, block, keys, visitedCards);
      }
      return;
    }
  }
}

function addMacroKey(keys: UsedCacheKeys, seriesId: string): void {
  const def = findMacroSeriesDef(seriesId);
  if (def) keys.macro.add(`${def.api}|${seriesId}`);
}

function fredCacheId(seriesId: string, transform?: string): string {
  return transform ? `${seriesId}@${transform}` : seriesId;
}

// ==================== Diff against the SQLite cache ====================

export interface StaleCacheEntry {
  kind: "ohlcv" | "market" | "macro";
  label: string; // display line, e.g. "600519.SH · stock" / "cn_m · m1_yoy"
  detail: string; // type tag + row count
  rows: number;
  symbol?: string;
  assetType?: AssetType;
  source?: string;
  seriesId?: string;
}

export async function findStaleCacheEntries(
  cache: SqliteCache,
  used: UsedCacheKeys
): Promise<StaleCacheEntry[]> {
  const stale: StaleCacheEntry[] = [];

  for (const key of await cache.listOhlcvKeys()) {
    if (used.quotes.has(`${key.symbol}|${key.assetType}`)) continue;
    stale.push({
      kind: "ohlcv",
      label: `${key.symbol} · ${key.assetType}`,
      detail: `行情数据 · ${key.rows} 行`,
      rows: key.rows,
      symbol: key.symbol,
      assetType: key.assetType,
    });
  }

  // market_data shares the quote key: kept while any card uses the symbol.
  for (const key of await cache.listMarketDataKeys()) {
    if (used.quotes.has(`${key.symbol}|${key.assetType}`)) continue;
    stale.push({
      kind: "market",
      label: `${key.symbol} · ${key.assetType}`,
      detail: `市场数据 · ${key.rows} 行`,
      rows: key.rows,
      symbol: key.symbol,
      assetType: key.assetType,
    });
  }

  for (const key of await cache.listMacroSeriesKeys()) {
    const inUse =
      key.source === "fred"
        ? used.fred.has(key.seriesId)
        : used.macro.has(`${key.source}|${key.seriesId}`);
    if (inUse) continue;
    stale.push({
      kind: "macro",
      label: `${key.source} · ${key.seriesId}`,
      detail: `${key.source === "fred" ? "FRED" : "宏观"}序列 · ${key.rows} 行`,
      rows: key.rows,
      source: key.source,
      seriesId: key.seriesId,
    });
  }

  return stale.sort((a, b) => b.rows - a.rows);
}

export async function deleteStaleCacheEntry(cache: SqliteCache, entry: StaleCacheEntry): Promise<void> {
  if (entry.kind === "macro") {
    await cache.deleteMacroSeries(entry.source!, entry.seriesId!);
  } else if (entry.kind === "market") {
    await cache.deleteMarketData(entry.symbol!, entry.assetType!);
  } else {
    await cache.deleteOhlcv(entry.symbol!, entry.assetType!);
  }
}
