import { App, TFile } from "obsidian";

// Stable identity for spread cards (SpreadSpec.id). Other cards reference a
// spread card by this id (SeriesRef.cardId), so the card file can be renamed
// or moved inside the card library without breaking references. Format
// follows the existing timestamp-base36 idiom plus a random suffix.
export function newSpreadId(): string {
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const SPREAD_BLOCK_RE = /```spread\n([\s\S]*?)\n```/;

// Reads the spread card's id straight from the fenced block body with a regex
// — cheap enough for index building, where a full YAML parse of every library
// file would be waste. Returns null when the file has no spread block or the
// block carries no (valid) id.
export function extractSpreadId(content: string): string | null {
  const match = content.match(SPREAD_BLOCK_RE);
  if (!match) return null;
  const idMatch = match[1].match(/^id:\s*["']?([^\s"']+)/m);
  return idMatch ? idMatch[1] : null;
}

// cardId -> vault-path index with verify-on-read self-healing: no vault event
// subscription. A resolve() hit is verified against the file's actual content
// (cachedRead), so a stale map entry (file moved/renamed externally, id
// edited by hand) triggers exactly one rebuild and a retry. Cards live in the
// card library folder; a spread card moved out of it is no longer resolvable
// and surfaces as a card-level error.
export class CardIndex {
  private app: App;
  private getLibraryPath: () => string;
  private byId = new Map<string, string>();

  constructor(app: App, getLibraryPath: () => string) {
    this.app = app;
    this.getLibraryPath = getLibraryPath;
  }

  async resolve(cardId: string): Promise<string | null> {
    const cached = this.byId.get(cardId);
    if (cached && (await this.verify(cardId, cached))) return cached;
    await this.rebuild();
    const path = this.byId.get(cardId);
    if (path && (await this.verify(cardId, path))) return path;
    return null;
  }

  // Sync map lookup for contexts that cannot await (edit modals). Cold before
  // the first async resolve/rebuild — callers fall back to a generic label.
  resolveSync(cardId: string): string | null {
    return this.byId.get(cardId) ?? null;
  }

  private async verify(cardId: string, path: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const content = await this.app.vault.cachedRead(file);
    return extractSpreadId(content) === cardId;
  }

  private async rebuild(): Promise<void> {
    this.byId.clear();
    const prefix = `${this.getLibraryPath()}/`;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(prefix)) continue;
      const content = await this.app.vault.cachedRead(file);
      const id = extractSpreadId(content);
      if (!id) continue;
      const existingPath = this.byId.get(id);
      if (existingPath) {
        // Hand-copied card files duplicate the id. Keep the newer file so
        // references follow the copy the user most recently touched.
        console.warn(`CardIndex: duplicate spread card id ${id} in ${existingPath} and ${file.path}; keeping the newer`);
        const existingFile = this.app.vault.getAbstractFileByPath(existingPath);
        if (existingFile instanceof TFile && existingFile.stat.mtime > file.stat.mtime) continue;
      }
      this.byId.set(id, file.path);
    }
  }
}
