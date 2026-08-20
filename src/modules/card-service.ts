import { App, normalizePath, Notice, TFile } from "obsidian";
import type { ParsedCardSpec } from "../types";
import { buildCardFileName } from "../utils/slug";
import { buildCardFrontmatter, canonicalKey, stringifyCardSpec } from "./card-spec";

// Exported so the md-editor insertion path (main.ts) can fence a spec with
// the same block type a card file would use.
export function codeBlockTypeFor(spec: ParsedCardSpec): string {
  if (spec.contentType === "calendar") return "calendar";
  if (spec.contentType === "widget" || spec.widgetType) return "financial-widget";
  return "tushare";
}

interface CardServiceOptions {
  app: App;
  cardLibraryPath: string;
  widgetCardPath: string;
  componentCardPath: string;
}

export class CardService {
  constructor(private options: CardServiceOptions) {}

  setPaths(paths: { cardLibraryPath: string; widgetCardPath: string; componentCardPath: string }): void {
    this.options.cardLibraryPath = paths.cardLibraryPath;
    this.options.widgetCardPath = paths.widgetCardPath;
    this.options.componentCardPath = paths.componentCardPath;
  }

  // Default save folder per card kind: calendar/timeline go to the component
  // path, widgets to the widget path, everything else (tushare, overlay,
  // spread, fred) to the chart card library.
  private defaultPathForSpec(spec: ParsedCardSpec): string {
    if (spec.contentType === "calendar") return this.options.componentCardPath;
    if (spec.contentType === "widget" || spec.widgetType) return this.options.widgetCardPath;
    return this.options.cardLibraryPath;
  }

  private defaultPathForBlock(blockType: string): string {
    return blockType === "timeline" ? this.options.componentCardPath : this.options.cardLibraryPath;
  }

  async createOrReuse(spec: ParsedCardSpec, savePath?: string, displayName?: string): Promise<TFile> {
    const key = canonicalKey(spec);
    const existing = await this.findExistingCard(key);
    if (existing) {
      new Notice(`已复用现有卡片：${existing.basename}`);
      return existing;
    }

    return this.createCard(spec, savePath, displayName);
  }

  async createCard(spec: ParsedCardSpec, savePath?: string, displayName?: string): Promise<TFile> {
    const libraryPath = normalizePath(savePath || this.defaultPathForSpec(spec));
    await this.ensureFolder(libraryPath);

    const baseName =
      spec.contentType === "calendar"
        ? "日历.md"
        : spec.widgetType
          ? this.buildWidgetFileName(spec)
          : buildCardFileName(displayName, spec.symbol, spec.assetType);
    const filePath = await this.uniqueFilePath(libraryPath, baseName);

    const blockType = codeBlockTypeFor(spec);
    const content = [
      buildCardFrontmatter(spec),
      "",
      `\`\`\`${blockType}`,
      stringifyCardSpec(spec),
      "```",
      "",
    ].join("\n");

    return this.options.app.vault.create(filePath, content);
  }

  // Creates a card file from a raw code-block body, for card types whose spec
  // lives outside ParsedCardSpec (currently the timeline ruler). No fc-*
  // frontmatter and no reuse: every insert produces a fresh card.
  async createRawCard(baseName: string, blockType: string, blockBody: string, savePath?: string): Promise<TFile> {
    const libraryPath = normalizePath(savePath || this.defaultPathForBlock(blockType));
    await this.ensureFolder(libraryPath);

    const filePath = await this.uniqueFilePath(libraryPath, baseName);
    const content = [`\`\`\`${blockType}`, blockBody, "```", ""].join("\n");

    return this.options.app.vault.create(filePath, content);
  }

  async uniqueFilePath(libraryPath: string, baseName: string): Promise<string> {
    let filePath = libraryPath ? `${libraryPath}/${baseName}` : baseName;
    let counter = 1;

    while (await this.options.app.vault.adapter.exists(filePath)) {
      const dotIndex = baseName.lastIndexOf(".");
      const stem = dotIndex >= 0 ? baseName.slice(0, dotIndex) : baseName;
      const ext = dotIndex >= 0 ? baseName.slice(dotIndex) : "";
      filePath = libraryPath ? `${libraryPath}/${stem}-${counter}${ext}` : `${stem}-${counter}${ext}`;
      counter++;
    }

    return filePath;
  }

  private buildWidgetFileName(spec: ParsedCardSpec): string {
    const title = spec.widgetTitle ?? spec.symbol ?? "widget";
    const safe = title.replace(/[^a-zA-Z0-9\-_一-龥]/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    return `${safe || "widget"}.md`;
  }

  async findExistingCard(key: string): Promise<TFile | null> {
    // Reuse lookups span every card folder (chart / widget / component), so a
    // card created before its folder setting changed is still found.
    const roots = [
      ...new Set(
        [this.options.cardLibraryPath, this.options.widgetCardPath, this.options.componentCardPath].map((p) =>
          normalizePath(p)
        )
      ),
    ];
    const existingRoots: string[] = [];
    for (const root of roots) {
      if (root && (await this.options.app.vault.adapter.exists(root))) {
        existingRoots.push(root);
      }
    }
    if (existingRoots.length === 0) {
      return null;
    }

    const files = this.options.app.vault
      .getMarkdownFiles()
      .filter((f) => existingRoots.some((root) => f.path.startsWith(root + "/")));

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

    const blockType = codeBlockTypeFor(spec);
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
