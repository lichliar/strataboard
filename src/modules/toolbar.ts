import { Menu, Notice, TFile, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { parseCardSpec } from "./card-spec";
import type FinancialCanvasPlugin from "../main";

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

    this.createMenuButton("database", "自有数据库", [
      { text: "插入资产数据", icon: "trending-up", onClick: () => this.insertAsset() },
    ]);
    this.createMenuButton("code", "TradingView Widgets", [
      { text: "插入TradingView Widgets", icon: "code", onClick: () => this.insertWidget() },
      { text: "TradingView 小组件文档", icon: "book-open", onClick: () => this.openWidgetDocs() },
    ]);
    this.createMenuButton("calendar-days", "插入组件", [
      { text: "日历", icon: "calendar-days", onClick: () => this.insertCalendar() },
      { text: "时间线", icon: "ruler", onClick: () => this.insertTimeline() },
    ]);
    this.createButton("refresh-cw", "全部刷新", () => this.refreshAll());

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

  private createButton(icon: string, tooltip: string, onClick: () => void) {
    const btn = this.toolbarEl!.createEl("button");
    setIcon(btn, icon);
    setTooltip(btn, tooltip);
    btn.addEventListener("click", onClick);
  }

  private createMenuButton(
    icon: string,
    tooltip: string,
    items: { text: string; icon: string; onClick: () => void }[]
  ) {
    const btn = this.toolbarEl!.createEl("button");
    setIcon(btn, icon);
    setTooltip(btn, tooltip);
    btn.addEventListener("click", (event) => {
      const menu = new Menu();
      for (const item of items) {
        menu.addItem((menuItem) => {
          menuItem.setTitle(item.text).setIcon(item.icon).onClick(item.onClick);
        });
      }
      const rect = btn.getBoundingClientRect();
      // Open away from the screen edge the toolbar sits on, so the menu never
      // covers the toolbar itself: bottom toolbar opens upward, top downward.
      if (this.plugin.pluginSettings.toolbarPosition.includes("top")) {
        menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
      } else {
        // showAtPosition anchors the menu's top-left corner; to open upward we
        // show first, then shift the freshly-created menu element above the button.
        // Obsidian renders the menu items asynchronously (setTimeout 0 inside
        // showAtPosition), so the height is only final after that tick — adjust
        // both immediately and on the next tick to catch the real height.
        const before = new Set(Array.from(document.querySelectorAll<HTMLElement>(".menu")));
        menu.showAtPosition({ x: rect.left, y: rect.top });
        const adjust = () => {
          const menuEl = Array.from(document.querySelectorAll<HTMLElement>(".menu"))
            .find((el) => !before.has(el));
          if (menuEl && menuEl.isConnected) {
            menuEl.style.top = `${Math.max(0, rect.top - menuEl.offsetHeight - 4)}px`;
          }
        };
        adjust();
        setTimeout(adjust, 0);
      }
      event.preventDefault();
    });
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

  private insertAsset() {
    this.plugin.openSymbolSearch((item) => this.plugin.insertCard(item));
  }

  private insertWidget() {
    this.plugin.openWidgetInputModal();
  }

  private openWidgetDocs() {
    window.open("https://www.tradingview.com/widget-docs/widgets/");
  }

  private insertCalendar() {
    void this.plugin.insertCalendarCard();
  }

  private insertTimeline() {
    void this.plugin.insertTimelineCard();
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

    // Cascade repeated inserts diagonally so cards don't stack exactly on
    // top of each other at the viewport center.
    const libraryPath = this.plugin.pluginSettings.cardLibraryPath;
    const cardCount = Array.from(canvas.nodes.values()).filter(
      (node: any) => node.filePath && node.filePath.startsWith(libraryPath + "/")
    ).length;
    const cascade = (cardCount % 8) * 40;

    const options = {
      file: tfile,
      pos: { x: center.x - 400 + cascade, y: center.y - 250 + cascade },
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
