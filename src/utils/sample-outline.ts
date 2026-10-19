// Response-sample minimization for AI copy actions (utils: no obsidian
// imports). "复制给 AI" attaches only the structure needed to debug a mapping
// — not the full payload: JSON is outlined (depth/field/string caps, arrays
// show 2 items + count), plain text is truncated. The caller still runs the
// result through modules/redact.ts.

const MAX_DEPTH = 4;
const MAX_FIELDS = 20;
const MAX_STRING = 80;
const MAX_ARRAY_ITEMS = 2;
const MAX_TOTAL = 2000;
const MAX_TEXT = 800;

function outline(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length} chars)` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[… ${value.length} items]` : "{…}";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => outline(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`… (${value.length} items total)`);
    return items;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, v] of entries.slice(0, MAX_FIELDS)) {
    out[key] = outline(v, depth + 1);
  }
  if (entries.length > MAX_FIELDS) out["…"] = `${entries.length - MAX_FIELDS} more fields`;
  return out;
}

// Minimized rendering of a response sample: outlined JSON, or truncated text
// when the payload is not JSON.
export function outlineSample(text: string): string {
  let out: string;
  try {
    out = JSON.stringify(outline(JSON.parse(text), 0), null, 2);
  } catch {
    out = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…（已截断，共 ${text.length} 字符）` : text;
  }
  return out.length > MAX_TOTAL ? `${out.slice(0, MAX_TOTAL)}…（已截断）` : out;
}
