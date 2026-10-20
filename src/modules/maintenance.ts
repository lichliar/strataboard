import { TFile, type App } from "obsidian";
import { parseDocument } from "yaml";
import { cacheAssetKey, cacheSymbolKey, type AssetType, type CustomSourceDef, type SeriesRef } from "../types";
import { splitLegacyProfileRef } from "../utils/symbol-list";
import { parseCardSpec, findUnknownCardKeys, CALENDAR_KNOWN_KEYS, QUOTE_KNOWN_KEYS, WIDGET_KNOWN_KEYS } from "./card-spec";
import {
  parseOverlaySpec,
  parseSpreadSpec,
  OVERLAY_KNOWN_KEYS,
  SPREAD_KNOWN_KEYS,
} from "./series-spec";
import { extractSpreadId, type CardIndex } from "./card-index";
import type { SqliteCache } from "./sqlite-cache";
import { t } from "../i18n";

// Scan logic for the two settings-tab cleanup features (orphan card files,
// stale cache entries). Pure data collection — all UI lives in
// ui/cleanup-modal.ts and settings.ts.

const PLUGIN_BLOCK_TYPES = new Set([
  "quote",
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

export interface CardRepairCandidate {
  file: string;
  blockType: string;
  keys: string[];
}

export interface CardRepairReport {
  repaired: CardRepairCandidate[];
  skipped: Array<CardRepairCandidate & { reason: string }>;
  errors: Array<{ file: string; reason: string }>;
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

function unknownKeysForBlock(type: string, body: string): string[] {
  if (type === "quote") return findUnknownCardKeys(body)?.keys ?? [];
  let parsed: unknown;
  try {
    parsed = parseDocument(body).toJSON();
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const known = type === "overlay" ? OVERLAY_KNOWN_KEYS : type === "spread" ? SPREAD_KNOWN_KEYS :
    type === "financial-widget" ? WIDGET_KNOWN_KEYS : type === "calendar" ? CALENDAR_KNOWN_KEYS : null;
  if (!known) return [];
  return Object.keys(parsed as Record<string, unknown>).filter((key) => !known.has(key));
}

export async function scanCardRepairs(app: App): Promise<CardRepairCandidate[]> {
  const candidates: CardRepairCandidate[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const content = await app.vault.cachedRead(file);
    for (const block of extractPluginBlocks(content)) {
      const keys = unknownKeysForBlock(block.type, block.body);
      if (keys.length > 0) candidates.push({ file: file.path, blockType: block.type, keys });
    }
  }
  return candidates;
}

function replaceUnknownKeys(body: string, keys: string[]): string {
  const document = parseDocument(body);
  const contents = document.contents;
  if (!contents || typeof contents !== "object" || !("items" in contents)) throw new Error("YAML 顶层必须是对象");
  const keySet = new Set(keys);
  const map = contents as { items: Array<{ key?: { value?: unknown }; remove?: (key: unknown) => boolean }> };
  for (const pair of [...map.items]) {
    const key = pair.key?.value;
    if (typeof key === "string" && keySet.has(key)) {
      const index = map.items.indexOf(pair);
      if (index >= 0) map.items.splice(index, 1);
    }
  }
  return String(document).trimEnd();
}

export async function repairCards(app: App, candidates: CardRepairCandidate[]): Promise<CardRepairReport> {
  const report: CardRepairReport = { repaired: [], skipped: [], errors: [] };
  const byFile = new Map<string, CardRepairCandidate[]>();
  for (const candidate of candidates) {
    const list = byFile.get(candidate.file) ?? [];
    list.push(candidate);
    byFile.set(candidate.file, list);
  }
  for (const [path, fileCandidates] of byFile) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { report.errors.push({ file: path, reason: "文件不存在" }); continue; }
    try {
      let content = await app.vault.read(file);
      let changed = false;
      for (const candidate of fileCandidates) {
        const pattern = new RegExp("```" + candidate.blockType + "\\n([\\s\\S]*?)\\n```", "g");
        let matched = false;
        content = content.replace(pattern, (full, body: string) => {
          if (matched) return full;
          const bodyKeys = unknownKeysForBlock(candidate.blockType, body);
          if (bodyKeys.join("\u0000") !== candidate.keys.join("\u0000")) return full;
          matched = true;
          try {
            const next = replaceUnknownKeys(body, candidate.keys);
            changed = changed || next !== body.trimEnd();
            return "```" + candidate.blockType + "\n" + next + "\n```";
          } catch (e) {
            report.skipped.push({ ...candidate, reason: e instanceof Error ? e.message : String(e) });
            return full;
          }
        });
        if (matched && !report.skipped.some((item) => item.file === candidate.file && item.blockType === candidate.blockType && item.keys.join() === candidate.keys.join())) {
          report.repaired.push(candidate);
        }
      }
      if (changed) await app.vault.modify(file, content);
    } catch (e) {
      report.errors.push({ file: path, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

// ==================== Orphan card files ====================

// A card file under one of the card folders is orphaned when nothing links to
// it: no canvas file node, no wikilink from any note, and (spread cards only)
// no SeriesRef.cardId from any overlay/spread spec. Quote cards are never
// referenced by other cards (quote refs carry their own coordinates), so they
// don't get that exemption. Anything unparseable is treated as "still
// referenced" — better to keep a file than to delete a live one.
export async function findOrphanCardFiles(app: App, cardFolders: string[]): Promise<TFile[]> {
  const folders = cardFolders.map((f) => f.trim()).filter((f) => f.length > 0);
  if (folders.length === 0) return [];

  const referenced = new Set<string>();
  const referencedIds = new Set<string>();

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

  // 3. SeriesRef.cardId from overlay/spread blocks in any note. Scanning
  // every md file (not just linked ones) keeps whole reference chains alive.
  const candidates: TFile[] = [];
  const candidateSpreadIds = new Map<string, string>();
  for (const file of app.vault.getMarkdownFiles()) {
    const content = await app.vault.cachedRead(file);
    const blocks = extractPluginBlocks(content);
    for (const block of blocks) {
      if (block.type !== "overlay" && block.type !== "spread") continue;
      const result =
        block.type === "overlay" ? parseOverlaySpec(block.body) : parseSpreadSpec(block.body);
      for (const ref of result.spec?.series ?? []) {
        if (ref.source === "card" && ref.cardId) referencedIds.add(ref.cardId);
      }
    }
    if (isUnderFolders(file.path, folders) && isPluginCardFile(file, blocks, content)) {
      candidates.push(file);
      const spreadId = extractSpreadId(content);
      if (spreadId) candidateSpreadIds.set(file.path, spreadId);
    }
  }

  return candidates.filter((file) => {
    if (referenced.has(file.path)) return false;
    const spreadId = candidateSpreadIds.get(file.path);
    return !spreadId || !referencedIds.has(spreadId);
  });
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
}

// Scans every markdown file in the vault (cards may also live inline in any
// note via insertCardIntoMd) and collects the cache keys its cards use. Card
// refs are followed through the card index (cardId → file). customSources is
// needed to normalize legacy "code@profile" refs onto the same cache key the
// fetch path uses (splitLegacyProfileRef).
export async function collectUsedCacheKeys(
  app: App,
  cardIndex: CardIndex,
  customSources: CustomSourceDef[]
): Promise<UsedCacheKeys> {
  const keys: UsedCacheKeys = { quotes: new Set() };
  const visitedCards = new Set<string>();
  for (const file of app.vault.getMarkdownFiles()) {
    const content = await app.vault.cachedRead(file);
    for (const block of extractPluginBlocks(content)) {
      await collectBlockKeys(app, cardIndex, block, keys, visitedCards, customSources);
    }
  }
  return keys;
}

async function collectBlockKeys(
  app: App,
  cardIndex: CardIndex,
  block: PluginBlock,
  keys: UsedCacheKeys,
  visitedCards: Set<string>,
  customSources: CustomSourceDef[]
): Promise<void> {
  switch (block.type) {
    case "quote": {
      const result = parseCardSpec(block.body);
      if (!result.ok) return;
      const spec = result.spec;
      if (spec.contentType || spec.widgetType) return; // widget/calendar: no market data
      keys.quotes.add(`${spec.symbol}|${cacheAssetKey(spec.assetType, spec.sourceId)}`);
      return;
    }
    case "overlay":
    case "spread": {
      const result =
        block.type === "overlay" ? parseOverlaySpec(block.body) : parseSpreadSpec(block.body);
      if (!result.spec) return;
      for (const ref of result.spec.series) {
        await collectRefKeys(app, cardIndex, ref, keys, visitedCards, customSources);
      }
      return;
    }
  }
}

async function collectRefKeys(
  app: App,
  cardIndex: CardIndex,
  ref: SeriesRef,
  keys: UsedCacheKeys,
  visitedCards: Set<string>,
  customSources: CustomSourceDef[]
): Promise<void> {
  switch (ref.source) {
    case "quote": {
      const def = customSources.find((s) => s.id === ref.sourceId);
      const { symbol, profile } = def
        ? splitLegacyProfileRef(def, ref.tsCode!, ref.profile)
        : { symbol: ref.tsCode!, profile: ref.profile };
      keys.quotes.add(`${cacheSymbolKey(symbol, profile)}|${cacheAssetKey(ref.assetType!, ref.sourceId)}`);
      return;
    }
    case "card": {
      // Follow the referenced spread card (cycle-safe, keyed by cardId) — its
      // own series count as used too.
      const cardId = ref.cardId;
      if (!cardId || visitedCards.has(cardId)) return;
      visitedCards.add(cardId);
      const cardPath = await cardIndex.resolve(cardId);
      if (!cardPath) return;
      const file = app.vault.getAbstractFileByPath(cardPath);
      if (!(file instanceof TFile)) return;
      const content = await app.vault.cachedRead(file);
      for (const block of extractPluginBlocks(content)) {
        await collectBlockKeys(app, cardIndex, block, keys, visitedCards, customSources);
      }
      return;
    }
  }
}

// ==================== Diff against the SQLite cache ====================

export interface StaleCacheEntry {
  kind: "ohlcv";
  label: string; // display line, e.g. "600519.SH · custom:src1"
  detail: string; // type tag + row count
  rows: number;
  symbol?: string;
  assetType?: AssetType;
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
      detail: t("行情数据 · {rows} 行", { rows: key.rows }),
      rows: key.rows,
      symbol: key.symbol,
      assetType: key.assetType,
    });
  }

  return stale.sort((a, b) => b.rows - a.rows);
}

export async function deleteStaleCacheEntry(cache: SqliteCache, entry: StaleCacheEntry): Promise<void> {
  await cache.deleteOhlcv(entry.symbol!, entry.assetType!);
}
