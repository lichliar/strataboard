import { App, TFile } from "obsidian";
import { parse, stringify } from "yaml";
import { parseCardSpec } from "./card-spec";
import { extractSpreadId, newSpreadId } from "./card-index";
import { t } from "../i18n";

// One-click upgrade for legacy card references (SeriesRef.cardPath). Pass 1
// backfills SpreadSpec.id on every spread card in the card library; pass 2
// rewrites every cardPath ref found in ANY markdown file (refs can be
// hand-written into any note, same scope as maintenance.ts):
//   -> target is a quote card: the ref becomes a plain quote series ref
//      (tsCode/assetType/sourceId) — semantically identical, since the old
//      loader used nothing else from a referenced quote card;
//   -> target is a spread card: the ref becomes { source: "card", cardId }.
// Refs whose target file is already gone are left untouched (the dead path
// is the only clue to what was referenced) and listed in the report.

export interface CardRefMigrationFailure {
  file: string;   // md file containing the ref
  ref: string;    // the legacy cardPath value
  reason: string;
}

export interface CardRefMigrationReport {
  idsAssigned: number;
  refsRewritten: number;
  filesChanged: string[];
  failures: CardRefMigrationFailure[];
}

const SERIES_BLOCK_RE = /```(overlay|spread)\n([\s\S]*?)\n```/g;
const QUOTE_BLOCK_RE = /```quote\n([\s\S]*?)\n```/;
const SPREAD_BLOCK_RE = /```spread\n([\s\S]*?)\n```/;

// Cheap startup probe: any overlay/spread block in the card library still
// carrying a cardPath key? Block-scoped (not a raw content.includes) so a
// note merely mentioning the word doesn't trigger a false Notice.
export async function hasLegacyCardRefs(app: App, cardLibraryPath: string): Promise<boolean> {
  const prefix = `${cardLibraryPath}/`;
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(prefix)) continue;
    const content = await app.vault.cachedRead(file);
    SERIES_BLOCK_RE.lastIndex = 0;
    for (const match of content.matchAll(SERIES_BLOCK_RE)) {
      if (match[2].includes("cardPath")) return true;
    }
  }
  return false;
}

// Returns the spread card's id, backfilling one into the file when missing.
// null when the file has no spread block or its YAML does not parse.
export async function ensureSpreadId(app: App, file: TFile): Promise<string | null> {
  const content = await app.vault.cachedRead(file);
  const existing = extractSpreadId(content);
  if (existing) return existing;
  const match = content.match(SPREAD_BLOCK_RE);
  if (!match) return null;
  const map = parseYamlMap(match[1]);
  if (!map) return null;
  const id = newSpreadId();
  const newBody = stringify({ id, ...map }, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();
  await app.vault.modify(file, content.replace(match[0], `\`\`\`spread\n${newBody}\n\`\`\``));
  return id;
}

export async function runCardRefMigration(app: App, cardLibraryPath: string): Promise<CardRefMigrationReport> {
  const report: CardRefMigrationReport = { idsAssigned: 0, refsRewritten: 0, filesChanged: [], failures: [] };
  const changed = new Set<string>();

  // ===== Pass 1: backfill ids on library spread cards, dedupe =====
  const libraryPrefix = `${cardLibraryPath}/`;
  const idToPath = new Map<string, string>();
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(libraryPrefix)) continue;
    const before = extractSpreadId(await app.vault.cachedRead(file));
    const hadId = before !== null;
    const id = await ensureSpreadId(app, file);
    if (!id) continue; // not a spread card, or broken YAML — its own card error covers it
    if (!hadId) {
      report.idsAssigned++;
      changed.add(file.path);
    }
    const dupPath = idToPath.get(id);
    if (dupPath) {
      // Hand-copied files duplicate the id. Refs are still path-based at this
      // point, so regenerating the duplicate's id is always safe.
      console.warn(`CardRefMigration: duplicate spread card id ${id} in ${dupPath} and ${file.path}; regenerating for ${file.path}`);
      const content = await app.vault.cachedRead(file);
      const match = content.match(SPREAD_BLOCK_RE);
      const map = match ? parseYamlMap(match[1]) : null;
      if (match && map) {
        const fresh = newSpreadId();
        const newBody = stringify({ ...map, id: fresh }, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();
        await app.vault.modify(file, content.replace(match[0], `\`\`\`spread\n${newBody}\n\`\`\``));
        idToPath.set(fresh, file.path);
        changed.add(file.path);
      }
      continue;
    }
    idToPath.set(id, file.path);
  }

  // ===== Pass 2: rewrite legacy cardPath refs in every markdown file =====
  for (const file of app.vault.getMarkdownFiles()) {
    const content = await app.vault.cachedRead(file);
    SERIES_BLOCK_RE.lastIndex = 0;
    const blocks = [...content.matchAll(SERIES_BLOCK_RE)];
    if (blocks.length === 0) continue;

    let newContent = content;
    let fileChanged = false;
    // Apply edits from the last block backwards so earlier match offsets
    // stay valid while the string grows/shrinks.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const [full, blockType, body] = blocks[i];
      const blockIndex = blocks[i].index!;
      const map = parseYamlMap(body);
      if (!map) continue;

      let blockChanged = false;
      const rewriteEntry = async (raw: unknown): Promise<unknown> => {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
        const entry = raw as Record<string, unknown>;
        const cardPath = String(entry.cardPath ?? "").trim();
        if (!cardPath) return raw; // already new-format, or a quote entry
        const rewritten = await rewriteLegacyRef(app, cardPath, entry, idToPath, report, file.path);
        if (rewritten) {
          blockChanged = true;
          report.refsRewritten++;
          return rewritten;
        }
        return raw; // failure already recorded; keep the legacy entry as a clue
      };

      if (Array.isArray(map.series)) {
        for (let s = map.series.length - 1; s >= 0; s--) {
          map.series[s] = await rewriteEntry(map.series[s]);
        }
      }
      // Legacy two-leg spread cards carry refs under a:/b:.
      for (const leg of ["a", "b"] as const) {
        if (map[leg] !== undefined) {
          map[leg] = await rewriteEntry(map[leg]);
        }
      }
      if (!blockChanged) continue;

      const newBody = stringify(map, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();
      const newBlock = `\`\`\`${blockType}\n${newBody}\n\`\`\``;
      newContent = newContent.slice(0, blockIndex) + newBlock + newContent.slice(blockIndex + full.length);
      fileChanged = true;
    }

    if (fileChanged) {
      await app.vault.modify(file, newContent);
      changed.add(file.path);
    }
  }

  report.filesChanged = [...changed].sort();
  return report;
}

// Builds the replacement series entry for one legacy cardPath ref, or null
// when it cannot be rewritten (failure recorded in the report).
async function rewriteLegacyRef(
  app: App,
  cardPath: string,
  entry: Record<string, unknown>,
  idToPath: Map<string, string>,
  report: CardRefMigrationReport,
  fromFile: string
): Promise<Record<string, unknown> | null> {
  const fail = (reason: string): null => {
    report.failures.push({ file: fromFile, ref: cardPath, reason });
    return null;
  };
  const target = app.vault.getAbstractFileByPath(cardPath);
  if (!(target instanceof TFile)) {
    return fail(t("目标文件不存在"));
  }
  const content = await app.vault.cachedRead(target);

  // Carry over the optional display fields from the legacy entry.
  const extras: Record<string, unknown> = {};
  if (entry.label) extras.label = entry.label;
  if (entry.scale !== undefined) extras.scale = entry.scale;

  const quoteMatch = content.match(QUOTE_BLOCK_RE);
  if (quoteMatch) {
    const result = parseCardSpec(quoteMatch[1]);
    if (!result.ok) {
      return fail(t("目标资产卡配置无效"));
    }
    return {
      source: "quote",
      tsCode: result.spec.symbol,
      assetType: result.spec.assetType,
      ...(result.spec.sourceId ? { sourceId: result.spec.sourceId } : {}),
      ...extras,
    };
  }

  if (SPREAD_BLOCK_RE.test(content)) {
    const id = await ensureSpreadId(app, target);
    if (!id) {
      return fail(t("目标计算卡配置无效"));
    }
    idToPath.set(id, target.path);
    return { source: "card", cardId: id, ...extras };
  }

  return fail(t("目标不是资产卡或计算卡"));
}

// YAML object or null (broken YAML / non-map blocks are left to the card's
// own parse error).
function parseYamlMap(source: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = parse(source.replace(/\r\n?/g, "\n"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
