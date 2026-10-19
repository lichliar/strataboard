import type { CustomSourceDef, SymbolListEntry } from "../types";
import { splitCompositeCode } from "../modules/quote-format-parsers";

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

// Effective {p.*} variables for fetching one code: source-level defaults
// (def.params) ← the endpoint-declared profile (a code picked from a search
// endpoint carrying `profile` keeps that declaration in the symbol cache) ←
// codeRules (the first shape rule matching the code contributes its profile —
// the guess, used only when nothing was declared) ← the symbols entry's
// profile ← the entry's own params. Codes found in the static table decide
// fully: neither declarations nor rules weaken an explicit entry.
export function resolveSymbolParams(
  def: CustomSourceDef,
  code: string,
  declaredProfile?: string
): Record<string, string> | undefined {
  const symbols = def.symbols;
  const entry = symbols?.find((s) => s.code === code)
    ?? symbols?.find((s) => s.code === splitCompositeCode(code).urlCode);
  const entryProfile = entry?.profile ? def.profiles?.[entry.profile] : undefined;
  // An entry found in the table decides fully; declarations and rules only
  // cover unknown codes — and a declaration decides fully too: codeRules is
  // the fallback guess, applied only when nothing was declared (declared
  // wins on conflict; the validator warns when they disagree).
  const declared = entry ? undefined : declaredProfile ? def.profiles?.[declaredProfile] : undefined;
  const ruleProfile = entry || declared ? undefined : matchCodeRuleProfile(def, splitCompositeCode(code).urlCode);
  if (!def.params && !declared && !entryProfile && !ruleProfile && !entry?.params) return undefined;
  return { ...def.params, ...declared, ...ruleProfile, ...entryProfile, ...entry?.params };
}

// The profile the first matching codeRules row points at for this code, or
// undefined when no rule matches (or the rule's profile name is unknown).
// Invalid regexes are skipped here; the settings UI prevents saving them.
export function matchCodeRuleProfile(def: CustomSourceDef, code: string): Record<string, string> | undefined {
  const name = matchCodeRuleProfileName(def, code);
  return name ? def.profiles?.[name] : undefined;
}

// The profile NAME of the first matching codeRules row (undefined when none
// matches) — the audit needs the name, not just the params.
export function matchCodeRuleProfileName(def: CustomSourceDef, code: string): string | undefined {
  for (const rule of def.codeRules ?? []) {
    try {
      if (new RegExp(rule.match).test(code)) return rule.profile;
    } catch { /* invalid regex — skip */ }
  }
  return undefined;
}

// Whether a code is declared known-unplottable by the source's deadCodes
// regex list (matched on the urlCode half of composite codes).
export function isDeadCode(def: CustomSourceDef, code: string): boolean {
  const urlCode = splitCompositeCode(code).urlCode;
  for (const pattern of def.deadCodes ?? []) {
    try {
      if (new RegExp(pattern).test(urlCode)) return true;
    } catch { /* invalid regex — skip */ }
  }
  return false;
}

// All deadCodes patterns OR'd into one regex (undefined when none are
// valid). Hot paths (search result stamping) test once per item instead of
// walking the pattern list.
export function compileDeadCodes(def: CustomSourceDef): RegExp | undefined {
  const parts: string[] = [];
  for (const pattern of def.deadCodes ?? []) {
    try {
      new RegExp(pattern);
      parts.push(`(?:${pattern})`);
    } catch { /* invalid regex — skip */ }
  }
  return parts.length > 0 ? new RegExp(parts.join("|")) : undefined;
}

// Whether a code gets params beyond the source-level defaults: listed in the
// static symbols table, declared by a search endpoint, or matched by a
// codeRules shape rule. Used by the probe's empty-result hint to tell
// "no data in window" apart from "fetched with the wrong interface's default
// params".
export function hasCodeSpecificParams(def: CustomSourceDef, code: string, declaredProfile?: string): boolean {
  const urlCode = splitCompositeCode(code).urlCode;
  if (def.symbols?.some((s) => s.code === code || s.code === urlCode)) return true;
  if (declaredProfile && def.profiles?.[declaredProfile]) return true;
  return matchCodeRuleProfile(def, urlCode) !== undefined;
}
