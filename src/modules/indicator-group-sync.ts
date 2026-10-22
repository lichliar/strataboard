import type { App } from "obsidian";
import { isSeq, parseDocument, stringify } from "yaml";
import type { IndicatorGroup } from "../types";

// Settings → cards sync for indicator groups. When a group is edited (or an
// import overwrites it by name), every quote card whose instances carry the
// group's card-local `group` label is rewritten in place: the old members are
// replaced by fresh deep copies of the group's instances, keeping the group's
// position in the card's indicator list. Numbered copies ("name (2)") follow
// the same sync; a rename re-labels them (suffix kept). Inputs come from the
// group definition (the group wins), while hidden state is preserved per
// indicator id — and a fully hidden card group stays fully hidden.
//
// Cards also live inline in arbitrary notes (insertCardIntoMd), so the scan
// covers every markdown file, same scope as maintenance.ts. Only ```quote
// blocks carry indicators (overlay/spread specs have none). Rewriting the
// file re-triggers Obsidian's code block processor, so open cards re-render
// on their own.
//
// The rewrite splices only the indicators sequence's source text (never a
// whole-document re-stringify) so untouched keys keep their original source —
// a hand-written unquoted `代码: 000001` must not come back as `代码: 1`.

const QUOTE_BLOCKS_RE = /```quote\n([\s\S]*?)\n```/g;

export interface IndicatorGroupSyncResult {
  filesChanged: number;
  groupsUpdated: number; // card-local group labels replaced across all files
}

export async function syncIndicatorGroupToCards(
  app: App,
  group: IndicatorGroup,
  previousName?: string
): Promise<IndicatorGroupSyncResult> {
  const result: IndicatorGroupSyncResult = { filesChanged: 0, groupsUpdated: 0 };
  const matchBase = previousName ?? group.name;
  const renamed = previousName !== undefined && previousName !== group.name;

  for (const file of app.vault.getMarkdownFiles()) {
    try {
      const content = await app.vault.cachedRead(file);
      QUOTE_BLOCKS_RE.lastIndex = 0;
      const blocks = [...content.matchAll(QUOTE_BLOCKS_RE)];
      if (blocks.length === 0) continue;

      let newContent = content;
      let fileChanged = false;
      // Apply edits from the last block backwards so earlier match offsets
      // stay valid while the string grows/shrinks.
      for (let i = blocks.length - 1; i >= 0; i--) {
        const [full, body] = blocks[i];
        const synced = syncBlockBody(body, group, matchBase, renamed);
        if (synced === null) continue;

        const blockIndex = blocks[i].index!;
        newContent =
          newContent.slice(0, blockIndex) +
          `\`\`\`quote\n${synced.body}\n\`\`\`` +
          newContent.slice(blockIndex + full.length);
        fileChanged = true;
        result.groupsUpdated += synced.groups;
      }

      if (fileChanged) {
        await app.vault.modify(file, newContent);
        result.filesChanged++;
      }
    } catch (e) {
      console.warn(`IndicatorGroupSync: failed to process ${file.path}`, e);
    }
  }
  return result;
}

// Rewrites one block's indicators, returning the new block body and how many
// card-local group labels were replaced — or null when the block carries no
// matching group label (or its YAML is broken, which the card's own parse
// error covers).
function syncBlockBody(
  body: string,
  group: IndicatorGroup,
  matchBase: string,
  renamed: boolean
): { body: string; groups: number } | null {
  const source = body.replace(/\r\n?/g, "\n");
  const doc = parseDocument(source);
  if (doc.errors.length > 0) return null;
  const seq = doc.get("indicators");
  if (!isSeq(seq) || !seq.range) return null;
  const indicators = seq.toJSON() as Array<Record<string, unknown>>;
  if (!indicators.some((inst) => matchesLabel(inst?.group, matchBase))) return null;

  const groups = syncGroupLabels(indicators, group, matchBase, renamed);

  // Textual splice of just the indicators sequence: regenerating the whole
  // document would normalize untouched scalars (a hand-written unquoted
  // `代码: 000001` would come back as `代码: 1`).
  const fragment = stringify({ indicators }, { lineWidth: 0, aliasDuplicateObjects: false })
    .trimEnd()
    .split("\n")
    .slice(1) // drop the regenerated `indicators:` key line
    .join("\n");
  // seq.range[0] sits at the first token of the value, excluding the line's
  // indentation; range[1] may or may not include the final newline. Splice
  // whole lines.
  const lineStart = source.lastIndexOf("\n", seq.range[0] - 1) + 1;
  let lineEnd: number;
  if (source[seq.range[1] - 1] === "\n") {
    lineEnd = seq.range[1]; // trailing newline already consumed
  } else {
    const nl = source.indexOf("\n", seq.range[1]);
    lineEnd = nl === -1 ? source.length : nl + 1;
  }
  const before = source.slice(lineStart, seq.range[0]);
  const hasMore = lineEnd < source.length;
  let newBody: string;
  if (before.includes(":")) {
    // Flow style (`indicators: [...]` on the key line): rewrite the pair,
    // keeping any trailing comment after the closing bracket.
    const restOfLine = source.slice(seq.range[1], lineEnd).trim();
    const keyLine = restOfLine.startsWith("#") ? `indicators: ${restOfLine}` : "indicators:";
    newBody = source.slice(0, lineStart) + `${keyLine}\n${fragment}${hasMore ? "\n" : ""}` + source.slice(lineEnd);
  } else {
    newBody = source.slice(0, lineStart) + fragment + (hasMore ? "\n" : "") + source.slice(lineEnd);
  }
  return { body: newBody, groups };
}

// Replaces every matching card-local group label in the array (in place):
// old members out, fresh copies of the group's instances in at the position
// of the first old member.
function syncGroupLabels(
  indicators: Array<Record<string, unknown>>,
  group: IndicatorGroup,
  matchBase: string,
  renamed: boolean
): number {
  const labels = new Set<string>();
  for (const inst of indicators) {
    if (typeof inst.group === "string" && matchesLabel(inst.group, matchBase)) labels.add(inst.group);
  }

  for (const label of labels) {
    const members = indicators.filter((inst) => inst.group === label);
    // No label member precedes the first one, so this index is also the
    // insertion point in the filtered array.
    const firstIndex = indicators.findIndex((inst) => inst.group === label);
    const hiddenById = new Map<string, boolean>();
    for (const member of members) {
      if (typeof member.id === "string") hiddenById.set(member.id, member.hidden === true);
    }
    const allWereHidden = members.length > 0 && members.every((member) => member.hidden === true);

    const suffix = label.slice(matchBase.length); // "" or " (n)"
    const newLabel = renamed ? `${group.name}${suffix}` : label;
    const replacements: Array<Record<string, unknown>> = group.indicators.map((inst) => {
      const keepHidden = hiddenById.get(inst.id) === true || allWereHidden;
      return {
        id: inst.id,
        ...(inst.inputs ? { inputs: { ...inst.inputs } } : {}),
        ...(keepHidden || inst.hidden ? { hidden: true } : {}),
        group: newLabel,
      };
    });

    const remaining = indicators.filter((inst) => inst.group !== label);
    remaining.splice(firstIndex, 0, ...replacements);
    indicators.length = 0;
    indicators.push(...remaining);
  }
  return labels.size;
}

function matchesLabel(label: unknown, base: string): boolean {
  if (typeof label !== "string") return false;
  if (label === base) return true;
  // "base (2)", "base (3)", … — numbered copies made by repeated applies.
  if (!label.startsWith(`${base} (`) || !label.endsWith(")")) return false;
  const n = label.slice(base.length + 2, -1);
  return n.length > 0 && /^\d+$/.test(n);
}
