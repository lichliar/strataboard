// Extracts the body of the first ```<type> fenced block in a markdown
// document (body only, without the fences); null when the block is absent.
export function extractCardBlock(content: string, type: string): string | null {
  const match = new RegExp("```" + type + "\\n([\\s\\S]*?)\\n```").exec(content);
  return match ? match[1] : null;
}
