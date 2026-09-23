import type { SymbolListEntry } from "../types";

// Static code tables for custom sources (CustomSourceDef.symbols): a paste-in
// "代码 名称" list, so sources without a server-side search (fixed reports,
// wide tables) still offer named picks at card time. No obsidian imports —
// node-exercisable.

// Parses pasted lines, one "代码 名称" per line. The separator is the first
// run of whitespace/commas; the name itself may contain spaces. Lines without
// a name use the code as the name. Blank lines and duplicate codes drop out.
export function parseSymbolList(text: string): SymbolListEntry[] {
  const seen = new Set<string>();
  const entries: SymbolListEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([^\s,]+)[\s,]+(.*)$/);
    const code = match ? match[1] : trimmed;
    const name = match && match[2].trim() ? match[2].trim() : code;
    if (seen.has(code)) continue;
    seen.add(code);
    entries.push({ code, name });
  }
  return entries;
}

export function stringifySymbolList(entries: SymbolListEntry[]): string {
  return entries.map((e) => `${e.code} ${e.name}`).join("\n");
}

// Case-insensitive substring match on name or code; an empty query matches
// everything (the full table shows as picks).
export function matchSymbolEntry(entry: SymbolListEntry, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return entry.name.toLowerCase().includes(q) || entry.code.toLowerCase().includes(q);
}
