import type { CustomSourceDef, SymbolItem, SymbolListEntry } from "../types";
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
// Invalid regexes are skipped here — validate-config flags them.
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

// Profile names of ALL matching codeRules rows, in order — >1 means the code
// is order-sensitive (the audit reports this as an overlap).
export function matchAllCodeRules(def: CustomSourceDef, code: string): string[] {
  const hits: string[] = [];
  for (const rule of def.codeRules ?? []) {
    try {
      if (new RegExp(rule.match).test(code)) hits.push(rule.profile);
    } catch { /* invalid regex — skip */ }
  }
  return hits;
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
    } catch { /* invalid regex — validate-config flags it */ }
  }
  return parts.length > 0 ? new RegExp(parts.join("|")) : undefined;
}

// Whether a code gets params beyond the source-level defaults: listed in the
// static symbols table, declared by a search endpoint, or matched by a
// codeRules shape rule. Used by the validator's empty-probe hint to tell
// "no data in window" apart from "fetched with the wrong interface's default
// params".
export function hasCodeSpecificParams(def: CustomSourceDef, code: string, declaredProfile?: string): boolean {
  const urlCode = splitCompositeCode(code).urlCode;
  if (def.symbols?.some((s) => s.code === code || s.code === urlCode)) return true;
  if (declaredProfile && def.profiles?.[declaredProfile]) return true;
  return matchCodeRuleProfile(def, urlCode) !== undefined;
}

// Offline audit of the codeRules/endpoint-profile wiring against one full
// search result set (validate-config already holds it — zero extra requests).
// Answers "how many searchable codes would fetch with the RIGHT interface":
// codes are classified by endpoint declaration first, codeRules second, the
// static symbols table settles its own entries, deadCodes are declared-dead;
// everything else is UNMATCHED and will fetch with the source-level defaults.
export interface SearchCoverageAudit {
  total: number;
  dead: number;
  unmatched: number;
  unmatchedTop: { shape: string; count: number; samples: string[] }[];
  profileCounts: Record<string, number>; // effective profile per code (declaration wins over rule)
  overlapCount: number;
  overlaps: { code: string; profiles: string[] }[];
  conflictCount: number;
  conflicts: { code: string; declared: string; rule: string }[];
  // One candidate code per effective profile for the optional live sampling
  // probe (not in the symbols table, not dead).
  sampleCodes: { profile: string; code: string; declared: boolean }[];
}

const AUDIT_LIST_CAP = 5;
const AUDIT_TOP_SHAPES = 10;

export function auditSearchCoverage(def: CustomSourceDef, items: SymbolItem[]): SearchCoverageAudit {
  const inTable = new Set((def.symbols ?? []).flatMap((s) => [s.code, s.code.split("@")[0]]));
  const audit: SearchCoverageAudit = {
    total: items.length,
    dead: 0,
    unmatched: 0,
    unmatchedTop: [],
    profileCounts: {},
    overlapCount: 0,
    overlaps: [],
    conflictCount: 0,
    conflicts: [],
    sampleCodes: [],
  };
  const shapes = new Map<string, { count: number; samples: string[] }>();
  const sampled = new Set<string>();
  for (const item of items) {
    const code = splitCompositeCode(item.tsCode).urlCode;
    if (isDeadCode(def, item.tsCode)) {
      audit.dead++;
      continue;
    }
    if (inTable.has(item.tsCode) || inTable.has(code)) continue; // the table decides for its own entries
    const declared = item.profile && def.profiles?.[item.profile] ? item.profile : undefined;
    const ruleHits = matchAllCodeRules(def, code);
    const rule = ruleHits[0];
    if (ruleHits.length > 1) {
      audit.overlapCount++;
      if (audit.overlaps.length < AUDIT_LIST_CAP) audit.overlaps.push({ code: item.tsCode, profiles: ruleHits });
    }
    if (declared && rule && declared !== rule) {
      audit.conflictCount++;
      if (audit.conflicts.length < AUDIT_LIST_CAP) {
        audit.conflicts.push({ code: item.tsCode, declared, rule });
      }
    }
    const effective = declared ?? rule;
    if (!effective) {
      audit.unmatched++;
      const shape = item.tsCode.toUpperCase().replace(/\d/g, "#");
      const bucket = shapes.get(shape) ?? { count: 0, samples: [] };
      bucket.count++;
      if (bucket.samples.length < 3) bucket.samples.push(item.tsCode);
      shapes.set(shape, bucket);
      continue;
    }
    audit.profileCounts[effective] = (audit.profileCounts[effective] ?? 0) + 1;
    if (!sampled.has(effective)) {
      sampled.add(effective);
      audit.sampleCodes.push({ profile: effective, code: item.tsCode, declared: declared === effective });
    }
  }
  audit.unmatchedTop = [...shapes.entries()]
    .map(([shape, v]) => ({ shape, count: v.count, samples: v.samples }))
    .sort((a, b) => b.count - a.count)
    .slice(0, AUDIT_TOP_SHAPES);
  return audit;
}
