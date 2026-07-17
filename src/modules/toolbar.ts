import { Notice, TFile, type WorkspaceLeaf } from "obsidian";
import { parseCardSpec } from "./card-spec";
import type FinancialCanvasPlugin from "../main";
import type { AssetType } from "../types";
import { resolveDateRange, formatIsoDate, parseDateYmd } from "../utils/date";

export class CanvasToolbar {
  private plugin: FinancialCanvasPlugin;
  private toolbarEl: HTMLElement | null = null;
  private activeLeaf: WorkspaceLeaf | null = null;

  constructor(plugin: FinancialCanvasPlugin) {
    this.plugin = plugin;
  }

  attach(leaf: WorkspaceLeaf) {
    if (this.activeLeaf === leaf) return;
    this.detach();

    const view = leaf.view as any;
    if (!view?.canvas) return;

    this.activeLeaf = leaf;
    const container = view.containerEl as HTMLElement;
    this.toolbarEl = container.createEl("div", { cls: "financial-canvas-toolbar" });

    this.createButton("插入股票", () => this.insertCard("stock"));
    this.createButton("插入基金", () => this.insertCard("fund"));
    this.createButton("插入指数", () => this.insertCard("index"));
    this.createButton("插入小组件", () => this.insertWidget());
    this.createButton("全部刷新", () => this.refreshAll());

    this.applyPosition();
  }

  detach() {
    if (this.toolbarEl) {
      this.toolbarEl.remove();
      this.toolbarEl = null;
    }
    this.activeLeaf = null;
  }

  updatePosition() {
    this.applyPosition();
  }

  private createButton(text: string, onClick: () => void) {
    const btn = this.toolbarEl!.createEl("button", { text });
    btn.addEventListener("click", onClick);
  }

  private applyPosition() {
    if (!this.toolbarEl) return;

    const pos = this.plugin.pluginSettings.toolbarPosition;
    const offsetX = this.plugin.pluginSettings.toolbarOffsetX;
    const offsetY = this.plugin.pluginSettings.toolbarOffsetY;

    this.toolbarEl.style.left = "";
    this.toolbarEl.style.right = "";
    this.toolbarEl.style.top = "";
    this.toolbarEl.style.bottom = "";

    if (pos.includes("left")) {
      this.toolbarEl.style.left = `${offsetX}px`;
    } else {
      this.toolbarEl.style.right = `${offsetX}px`;
    }

    if (pos.includes("top")) {
      this.toolbarEl.style.top = `${offsetY}px`;
    } else {
      this.toolbarEl.style.bottom = `${offsetY}px`;
    }
  }

  private insertCard(assetType: AssetType) {
    this.plugin.openSymbolSearch(assetType, async (item) => {
      const { start, end } = resolveDateRange(this.plugin.pluginSettings.defaultRange.trim() || "1y");
      const range = `${formatIsoDate(parseDateYmd(start))}~${formatIsoDate(parseDateYmd(end))}`;
      const spec = {
        symbol: item.tsCode,
        assetType,
        freq: this.plugin.pluginSettings.defaultFreq,
        range,
        version: 1,
        height: this.plugin.pluginSettings.defaultChartHeight,
        headerCollapsed: true,
      };

      try {
        const file = await this.plugin.cardService.createOrReuse(spec);
        this.placeFileNode(file);
      } catch (e) {
        new Notice(`创建卡片失败：${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  private insertWidget() {
    this.plugin.openWidgetInputModal();
  }

  private async refreshAll() {
    const view = this.activeLeaf?.view as any;
    if (!view?.canvas) return;

    const libraryPath = this.plugin.pluginSettings.cardLibraryPath;
    const nodes = Array.from(view.canvas.nodes.values()) as any[];
    const cardNodes = nodes.filter((node) => node.filePath && node.filePath.startsWith(libraryPath + "/"));

    if (cardNodes.length === 0) {
      new Notice("当前画布上没有金融卡片。");
      return;
    }

    let refreshed = 0;
    let failed = 0;
    const concurrency = 5;
    let index = 0;

    const worker = async () => {
      while (index < cardNodes.length) {
        const node = cardNodes[index++];
        try {
          const file = this.plugin.app.vault.getAbstractFileByPath(node.filePath);
          if (!(file instanceof TFile)) continue;
          const content = await this.plugin.app.vault.cachedRead(file);
          const match = content.match(/```tushare\n([\s\S]*?)\n```/);
          if (!match) continue;
          const result = parseCardSpec(match[1]);
          if (!result.ok) continue;
          await this.plugin.dataAdapter.loadOhlcv(result.spec);
          refreshed++;
        } catch {
          failed++;
        }
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrency, cardNodes.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    new Notice(`已刷新 ${refreshed} 张卡片${failed > 0 ? `，${failed} 张失败` : ""}。`);
  }

  placeFileNode(file: TFile | string) {
    const view = this.activeLeaf?.view as any;
    if (!view?.canvas) {
      new Notice("当前没有激活的 Canvas 视图。");
      return;
    }

    const canvas = view.canvas;
    const center = canvas.posCenter?.() || canvas.getViewportCenter?.() || { x: 0, y: 0 };
    const tfile = typeof file === "string" ? this.plugin.app.vault.getAbstractFileByPath(file) : file;

    if (!tfile || !(tfile instanceof TFile)) {
      new Notice("找不到要放置的卡片文件。");
      console.error("placeFileNode: file not found", file);
      return;
    }

    const options = {
      file: tfile,
      pos: { x: center.x - 400, y: center.y - 250 },
      size: { width: 800, height: 500 },
    };
    console.log("placeFileNode: creating file node", { path: tfile.path, options });

    let node;
    try {
      node = canvas.createFileNode?.(options);
    } catch (e) {
      console.error("placeFileNode: createFileNode threw", e, { path: tfile.path, options });
      throw e;
    }

    if (node) {
      canvas.requestSave();
    } else {
      new Notice("在画布上放置卡片失败");
      console.error("placeFileNode: createFileNode returned undefined", { file: tfile.path, center });
    }
  }
}
