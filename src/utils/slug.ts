import type { AssetType } from "../types";

export function slugifySymbol(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9\-_]/g, "-");
}

// One path-component-safe fragment: strips Obsidian-forbidden characters,
// collapses whitespace/dashes, keeps CJK. Empty result means "no usable name".
export function sanitizeFileNamePart(input: string): string {
  return input
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Short source label for card file names (命名规则：资产名称-代码-数据源).
function sourceLabel(assetType: AssetType): string {
  if (assetType === "tx") return "腾讯";
  if (assetType === "em") return "东财";
  return "Tushare";
}

// Card file name: 资产名称-资产代码-数据源, e.g. 贵州茅台-sh600519-腾讯.md.
// Falls back to the bare code when the name is missing/unusable (e.g. a
// source whose symbols carry no Chinese name).
export function buildCardFileName(name: string | undefined, symbol: string, assetType: AssetType): string {
  const code = sanitizeFileNamePart(symbol);
  const display = sanitizeFileNamePart(name ?? "") || code;
  return `${display}-${code}-${sourceLabel(assetType)}.md`;
}

export function normalizePath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/\/$/, "");
}
