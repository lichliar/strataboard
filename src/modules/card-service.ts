import { App, normalizePath, Notice, TFile } from "obsidian";
import type { ParsedCardSpec } from "../types";
import { buildCardFileName } from "../utils/slug";
import { buildCardFrontmatter, canonicalKey, stringifyCardSpec } from "./card-spec";

interface CardServiceOptions {
  app: App;
  cardLibraryPath: string;
}

export class CardService {
  constructor(private options: CardServiceOptions) {}

  setLibraryPath(path: string): void {
    this.options.cardLibraryPath = path;
  }

  async createOrReuse(spec: ParsedCardSpec, savePath?: string): Promise<TFile> {
    const key = canonicalKey(spec);
    const existing = await this.findExistingCard(key);
    if (existing) {
      new Notice(`已复用现有卡片：${existing.basename}`);
      return existing;
    }

    return this.createCard(spec, savePath);
  }

  async createCard(spec: ParsedCardSpec, savePath?: string): Promise<TFile> {
    const libraryPath = normalizePath(savePath || this.options.cardLibraryPath);
    await this.ensureFolder(libraryPath);

    const baseName = spec.widgetType
      ? this.buildWidgetFileName(spec)
      : buildCardFileName(spec.symbol, spec.assetType, spec.freq);
    let filePath = `${libraryPath}/${baseName}`;
    let counter = 1;

    while (await this.options.app.vault.adapter.exists(filePath)) {
      const dotIndex = baseName.lastIndexOf(".");
      const stem = dotIndex >= 0 ? baseName.slice(0, dotIndex) : baseName;
      const ext = dotIndex >= 0 ? baseName.slice(dotIndex) : "";
      filePath = `${libraryPath}/${stem}-${counter}${ext}`;
      counter++;
    }

    const content = spec.widgetType
      ? [
          buildCardFrontmatter(spec),
          "",
          "```financial-widget",
          stringifyCardSpec(spec),
          "```",
          "",
        ].join("\n")
      : [
          buildCardFrontmatter(spec),
          "",
          "```tushare",
          stringifyCardSpec(spec),
          "```",
          "",
        ].join("\n");

    return this.options.app.vault.create(filePath, content);
  }

  private buildWidgetFileName(spec: ParsedCardSpec): string {
    const title = spec.widgetTitle ?? spec.symbol ?? "widget";
    const safe = title.replace(/[^a-zA-Z0-9\-_一-龥]/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    return `${safe || "widget"}.md`;
  }

  async findExistingCard(key: string): Promise<TFile | null> {
    const libraryPath = normalizePath(this.options.cardLibraryPath);
    if (!(await this.options.app.vault.adapter.exists(libraryPath))) {
      return null;
    }

    const files = this.options.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(libraryPath + "/"));

    for (const file of files) {
      try {
        const cache = this.options.app.metadataCache.getFileCache(file);
        const storedKey = cache?.frontmatter?.["fc-key"];
        // Legacy keys carried a `|range` suffix (dropped — see canonicalKey);
        // the prefix match keeps cards created before that fix reusable.
        if (typeof storedKey === "string" && (storedKey === key || storedKey.startsWith(`${key}|`))) {
          return file;
        }
      } catch {
        // ignore
      }
    }

    return null;
  }

  async updateCardSpec(filePath: string, spec: ParsedCardSpec): Promise<void> {
    const file = this.options.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`Card file not found: ${filePath}`);
    }

    const blockType = spec.widgetType ? "financial-widget" : "tushare";
    const content = await this.options.app.vault.cachedRead(file);

    // Replace only the generated parts — the fc-* frontmatter lines and the
    // code block — so notes the user added elsewhere in the file survive.
    let newContent = this.mergeFrontmatter(content, buildCardFrontmatter(spec));

    const blockRe = new RegExp(`\`\`\`${blockType}\\n[\\s\\S]*?\\n\`\`\``);
    const newBlock = ["```" + blockType, stringifyCardSpec(spec), "```"].join("\n");
    if (blockRe.test(newContent)) {
      newContent = newContent.replace(blockRe, newBlock);
    } else {
      newContent = `${newContent.trimEnd()}\n\n${newBlock}\n`;
    }

    if (content === newContent) return;
    await this.options.app.vault.modify(file, newContent);
  }

  // Swaps the fc-* lines of the existing frontmatter for freshly generated
  // ones, keeping any other keys the user added; prepends a frontmatter
  // block when the file has none.
  private mergeFrontmatter(content: string, frontmatter: string): string {
    const fcLines = frontmatter.split("\n").slice(1, -1);
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) {
      return `${frontmatter}\n\n${content}`;
    }
    const userLines = fmMatch[1]
      .split("\n")
      .filter((line) => !line.startsWith("fc-") && line.trim() !== "");
    const merged = ["---", ...userLines, ...fcLines, "---"].join("\n");
    return merged + content.slice(fmMatch[0].length);
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!(await this.options.app.vault.adapter.exists(path))) {
      await this.options.app.vault.createFolder(path);
    }
  }
}
