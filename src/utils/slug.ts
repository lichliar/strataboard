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

// Card file name: 资产名称-资产代码-数据源, e.g. 贵州茅台-sh600519-我的腾讯.md.
// Falls back to the bare code when the name is missing/unusable (e.g. a
// source whose symbols carry no Chinese name).
export function buildCardFileName(name: string | undefined, symbol: string, sourceName?: string): string {
  const code = sanitizeFileNamePart(symbol);
  const display = sanitizeFileNamePart(name ?? "") || code;
  return `${display}-${code}-${sanitizeFileNamePart(sourceName ?? "") || "自定义"}.md`;
}

export function normalizePath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/\/$/, "");
}
