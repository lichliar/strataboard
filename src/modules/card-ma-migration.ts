import { App } from "obsidian";
import { parse, stringify } from "yaml";
import { t } from "../i18n";

// One-click upgrade for legacy MA settings on quote cards (均线: [5,10,...] /
// 显示均线: bool) to the unified indicator system (indicators: [{id, inputs}]).
// Mirrors card-ref-migration.ts: block-level map surgery — the whole YAML map
// is re-stringified and spliced back (editing blocks back-to-front so earlier
// match offsets stay valid). stringifyCardSpec is NOT used: it would drop
// unknown keys users hand-wrote into their cards.

export interface MaMigrationFailure {
  file: string;   // md file containing the block
  reason: string;
}

export interface MaMigrationReport {
  filesChanged: number;
  cardsRewritten: number;
  failures: MaMigrationFailure[];
}

const QUOTE_BLOCK_RE = /```quote\n([\s\S]*?)\n```/g;
// Legacy keys, line-anchored so a mere mention of the word in a comment or
// value does not count.
const LEGACY_KEY_RE = /^(均线|显示均线)\s*:/m;

// Cheap startup probe: any quote block in the card library still carrying a
// legacy MA key?
export async function hasLegacyMaKeys(app: App, cardLibraryPath: string): Promise<boolean> {
  const prefix = `${cardLibraryPath}/`;
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(prefix)) continue;
    const content = await app.vault.cachedRead(file);
    QUOTE_BLOCK_RE.lastIndex = 0;
    for (const match of content.matchAll(QUOTE_BLOCK_RE)) {
      if (LEGACY_KEY_RE.test(match[1])) return true;
    }
  }
  return false;
}

export async function runMaMigration(app: App, cardLibraryPath: string): Promise<MaMigrationReport> {
  const report: MaMigrationReport = { filesChanged: 0, cardsRewritten: 0, failures: [] };
  const prefix = `${cardLibraryPath}/`;

  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(prefix)) continue;
    const content = await app.vault.cachedRead(file);
    QUOTE_BLOCK_RE.lastIndex = 0;
    const blocks = [...content.matchAll(QUOTE_BLOCK_RE)];
    if (blocks.length === 0) continue;

    let newContent = content;
    let fileChanged = false;
    // Apply edits from the last block backwards so earlier match offsets
    // stay valid while the string grows/shrinks.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const [full, body] = blocks[i];
      const blockIndex = blocks[i].index!;
      if (!LEGACY_KEY_RE.test(body)) continue;

      const map = parseYamlMap(body);
      if (!map) {
        report.failures.push({ file: file.path, reason: t("YAML 无法解析，已原样保留") });
        continue;
      }

      const rewritten = rewriteMaKeys(map);
      if (rewritten instanceof Error) {
        report.failures.push({ file: file.path, reason: rewritten.message });
        continue;
      }
      if (!rewritten) continue; // both keys absent after parse (defensive)

      const newBody = stringify(rewritten, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();
      const newBlock = `\`\`\`quote\n${newBody}\n\`\`\``;
      newContent = newContent.slice(0, blockIndex) + newBlock + newContent.slice(blockIndex + full.length);
      fileChanged = true;
      report.cardsRewritten++;
    }

    if (fileChanged) {
      await app.vault.modify(file, newContent);
      report.filesChanged++;
    }
  }

  return report;
}

// Rewrites the legacy MA keys of one parsed quote-block map, preserving the
// order of all other keys. Returns null when there is nothing to do, Error
// when the 均线 value is unusable (the block is then left untouched).
//   均线: [a,b,...]     -> indicators: [{id: ma, inputs: {length: a}}, ...]
//   显示均线: false      -> indicators: [] (overrides 均线 when both present)
//   显示均线: true       -> key dropped (the global default governs); 均线
//                          still converts when also present.
// The indicators key takes the position 均线 had, else appends at the end.
function rewriteMaKeys(map: Record<string, unknown>): Record<string, unknown> | Error | null {
  const periodsRaw = map["均线"];
  const showRaw = map["显示均线"];
  if (periodsRaw === undefined && showRaw === undefined) return null;

  let indicators: { id: string; inputs: { length: number } }[] | [] | undefined;
  if (showRaw === false) {
    indicators = [];
  } else if (periodsRaw !== undefined) {
    const periods = parsePeriodList(periodsRaw);
    if (!periods) {
      return new Error(t("均线值无法解析（应为逗号分隔的正整数列表）"));
    }
    indicators = periods.map((length) => ({ id: "ma", inputs: { length } }));
  }

  const out: Record<string, unknown> = {};
  let inserted = false;
  for (const key of Object.keys(map)) {
    if (key === "均线") {
      if (indicators !== undefined) {
        out["indicators"] = indicators;
        inserted = true;
      }
      continue;
    }
    if (key === "显示均线") continue;
    out[key] = map[key];
  }
  if (!inserted && indicators !== undefined) {
    out["indicators"] = indicators;
  }
  return out;
}

// Accepts a YAML number list ([5, 10, 20]) or a comma-separated string
// ("5,10,20" — the old editor stored periods as free text). Returns null on
// anything else or on non-positive/non-integer entries.
function parsePeriodList(raw: unknown): number[] | null {
  const parts: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,，、/\s]+/).filter((s) => s.length > 0)
      : [];
  if (parts.length === 0) return null;
  const periods = parts.map((p) => Number(p));
  if (periods.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  return [...new Set(periods)].sort((a, b) => a - b);
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
