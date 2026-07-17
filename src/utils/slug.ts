export function slugifySymbol(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9\-_]/g, "-");
}

export function buildCardFileName(symbol: string, type: string, freq: string): string {
  const slug = slugifySymbol(symbol);
  return `${slug}-${type}-${freq}.md`;
}

export function normalizePath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/\/$/, "");
}
