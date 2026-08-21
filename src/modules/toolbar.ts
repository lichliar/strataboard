import { Menu, Notice, TFile, setTooltip, type WorkspaceLeaf } from "obsidian";
import { parseCardSpec } from "./card-spec";
import { TB_ICONS } from "./toolbar-icons";
import type StrataBoardPlugin from "../main";
import type { ToolbarEntryId, ToolbarSourceId } from "../types";

// StrataBoard logo mark: rounded square + three "strata" lines, the top one
// breaking into a rising trend (strata + financial board). currentColor picks
// up the hermes amber from .fc-tb-logo.
const LOGO_SVG =
  '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.2" y="2.2" width="27.6" height="27.6" rx="7" stroke="currentColor" stroke-width="2.2"/><path d="M8 21.5h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity="0.4"/><path d="M8 17h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity="0.65"/><path d="M8 12.5l4.5-2.5 4.5 2 7-3.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

interface ToolbarMenuItem {
  text: string;
  icon: string;
  onClick?: () => void;
  submenu?: ToolbarMenuItem[];
}

// A reorderable top-level entry. `source` ties the entry to its 工具栏显示
// toggle; entries without one (overlay/spread/components) always render.
interface ToolbarEntryDef {
  id: ToolbarEntryId;
  label: string;
  icon: keyof typeof TB_ICONS;
  source?: ToolbarSourceId;
  onClick?: () => void;
  menu?: ToolbarMenuItem[];
}

export class CanvasToolbar {
  private plugin: StrataBoardPlugin;
  private toolbarEl: HTMLElement | null = null;
  private activeLeaf: WorkspaceLeaf | null = null;

  constructor(plugin: StrataBoardPlugin) {
    this.plugin = plugin;
  }

  attach(leaf: WorkspaceLeaf) {
    if (this.activeLeaf === leaf) return;
    this.detach();

    const view = leaf.view as any;
    if (!view?.canvas) return;

    this.activeLeaf = leaf;
    const container = view.containerEl as HTMLElement;
    // The toolbar always renders on the hermes dark palette.
    this.toolbarEl = container.createEl("div", { cls: "strataboard-toolbar fc-hermes" });

    // Logo: strata-layers mark (icon mode) or a horizontal "StrataBoard" word
    // mark (text mode); click to collapse/expand the toolbar (state persists
    // in settings).
    const logo = this.toolbarEl.createDiv("fc-tb-logo");
    if (this.plugin.pluginSettings.toolbarStyle === "text") {
      logo.addClass("fc-tb-logo-text");
      logo.setText("StrataBoard");
    } else {
      logo.innerHTML = LOGO_SVG;
    }
    setTooltip(logo, "StrataBoard — 点击展开/折叠工具栏");
    logo.addEventListener("click", () => this.toggleCollapsed());

    // Drag handle: horizontal drag moves the bar, offset persists.
    const drag = this.toolbarEl.createDiv("fc-tb-drag");
    setTooltip(drag, "拖拽移动工具栏");
    drag.addEventListener("pointerdown", (event) => this.startDrag(event));

    // Width handle: vertical strip on the canvas-facing edge; dragging it
    // resizes the bar (persists as toolbarWidth).
    const resize = this.toolbarEl.createDiv("fc-tb-resize");
    setTooltip(resize, "拖拽调整工具栏宽度");
    resize.addEventListener("pointerdown", (event) => this.startResize(event));

    // Source-classified entries, rendered in the user-defined order. Entries
    // tied to a source are gated by its 工具栏显示 toggle; 数据叠加/数据计算/
    // 组件 are cross-source tools (quote legs may come from Tushare, tx, em,
    // FRED, …) so they always render. Token/key guidance lives in the plugin
    // methods themselves (openSymbolSearch / insertMacroCard / …), so
    // hidden-source gating is the only filtering here.
    const sources = this.plugin.pluginSettings.toolbarSources;
    for (const def of this.entryDefs()) {
      if (def.source && !sources[def.source]) continue;
      if (def.menu) this.createMenuButton(def.icon, def.label, def.menu);
      else if (def.onClick) this.createButton(def.icon, def.label, def.onClick);
    }

    this.toolbarEl.createDiv("fc-tb-spacer");
    this.createButton("refresh", "全部刷新", () => this.refreshAll());
    this.createButton("settings", "设置", () => this.openSettings());

    this.applyCollapsed();
    this.applyPosition();
  }

  // Entry metadata in one place; render order comes from settings.toolbarOrder.
  private entryDefs(): ToolbarEntryDef[] {
    const defs: Record<ToolbarEntryId, ToolbarEntryDef> = {
      tushare: {
        id: "tushare",
        label: "Tushare",
        icon: "tushare",
        source: "tushare",
        menu: [
          {
            text: "资产数据（股票/基金/指数/可转债/期货/外汇…）",
            icon: "trending-up",
            onClick: () => this.plugin.openSymbolSearch((symbol) => this.plugin.insertCard(symbol)),
          },
          {
            text: "宏观数据（CPI/PMI/社融/国债收益率…）",
            icon: "bar-chart-3",
            onClick: () => void this.plugin.insertMacroCard(),
          },
        ],
      },
      tencent: {
        id: "tencent",
        label: "腾讯行情",
        icon: "tencent",
        source: "tencent",
        onClick: () => this.plugin.openSymbolSearch((symbol) => this.plugin.insertCard(symbol), "tx"),
      },
      eastmoney: {
        id: "eastmoney",
        label: "东方财富",
        icon: "eastmoney",
        source: "eastmoney",
        onClick: () => this.plugin.openSymbolSearch((symbol) => this.plugin.insertCard(symbol), "em"),
      },
      fred: {
        id: "fred",
        label: "FRED",
        icon: "fred",
        source: "fred",
        onClick: () => void this.plugin.insertFredCard(),
      },
      tradingview: {
        id: "tradingview",
        label: "TradingView Widget",
        icon: "tradingview",
        source: "tradingview",
        onClick: () => this.insertWidget(),
      },
      overlay: {
        id: "overlay",
        label: "数据叠加",
        icon: "overlay",
        onClick: () => this.insertOverlay(),
      },
      spread: {
        id: "spread",
        label: "数据计算",
        icon: "spread",
        onClick: () => this.insertSpread(),
      },
      components: {
        id: "components",
        label: "组件",
        icon: "components",
        menu: [
          { text: "日历", icon: "calendar-days", onClick: () => this.insertCalendar() },
        ],
      },
    };
    return this.plugin.pluginSettings.toolbarOrder.map((id) => defs[id]);
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

  // Rebuilds the bar in place (visibility toggles / icon-text style changes
  // in settings take effect immediately, without waiting for a leaf change).
  reload() {
    const leaf = this.activeLeaf;
    this.detach();
    if (leaf) this.attach(leaf);
  }

  private toggleCollapsed() {
    this.plugin.pluginSettings.toolbarCollapsed = !this.plugin.pluginSettings.toolbarCollapsed;
    void this.plugin.saveSettings();
    this.applyCollapsed();
    this.applyPosition();
  }

  private applyCollapsed() {
    this.toolbarEl?.classList.toggle("is-collapsed", this.plugin.pluginSettings.toolbarCollapsed);
  }

  // Horizontal drag on the handle: the offset measures the distance from the
  // anchored side, so dragging flips the delta sign on right-anchored bars.
  private startDrag(event: PointerEvent) {
    if (!this.toolbarEl) return;
    event.preventDefault();
    event.stopPropagation();
    const settings = this.plugin.pluginSettings;
    const startX = event.clientX;
    const startOffsetX = settings.toolbarOffsetX;
    const sign = settings.toolbarPosition === "left" ? 1 : -1;
    const onMove = (moveEvent: PointerEvent) => {
      settings.toolbarOffsetX = Math.max(0, startOffsetX + (moveEvent.clientX - startX) * sign);
      this.applyPosition();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      void this.plugin.saveSettings();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  // Vertical drag on the edge strip: resizes the bar. The strip sits on the
  // canvas-facing edge, so dragging flips the delta sign on right-anchored
  // bars (same convention as startDrag).
  private startResize(event: PointerEvent) {
    if (!this.toolbarEl) return;
    event.preventDefault();
    event.stopPropagation();
    const settings = this.plugin.pluginSettings;
    const startX = event.clientX;
    const startWidth = this.toolbarEl.offsetWidth;
    const sign = settings.toolbarPosition === "left" ? 1 : -1;
    const onMove = (moveEvent: PointerEvent) => {
      settings.toolbarWidth = Math.min(
        320,
        Math.max(36, Math.round(startWidth + (moveEvent.clientX - startX) * sign))
      );
      this.applyPosition();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      void this.plugin.saveSettings();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  // Buttons render as a bare icon (tooltip carries the name) or a text label,
  // per the 显示效果 setting. Icons are inline Tabler SVGs from TB_ICONS.
  private createButton(icon: keyof typeof TB_ICONS, label: string, onClick: () => void) {
    const btn = this.toolbarEl!.createEl("button");
    if (this.plugin.pluginSettings.toolbarStyle === "text") {
      btn.setText(label);
      btn.addClass("fc-tb-text-btn");
    } else {
      btn.innerHTML = TB_ICONS[icon];
      setTooltip(btn, label);
    }
    btn.addEventListener("click", onClick);
  }

  private createMenuButton(icon: keyof typeof TB_ICONS, label: string, items: ToolbarMenuItem[]) {
    const btn = this.toolbarEl!.createEl("button");
    if (this.plugin.pluginSettings.toolbarStyle === "text") {
      btn.setText(label);
      btn.addClass("fc-tb-text-btn");
    } else {
      btn.innerHTML = TB_ICONS[icon];
      setTooltip(btn, label);
    }
    btn.addEventListener("click", (event) => {
      // Force DOM menus: on macOS Obsidian defaults to native menus, which
      // create no .menu element and can't host hover submenus.
      const menu = new Menu().setUseNativeMenu(false);
      this.addMenuItems(menu, items);
      const rect = btn.getBoundingClientRect();
      // Menus open to the right of the vertical bar (Obsidian flips them
      // horizontally when the bar hugs the right edge).
      menu.showAtPosition({ x: rect.right + 6, y: rect.top });
      event.preventDefault();
    });
  }

  private addMenuItems(menu: Menu, items: ToolbarMenuItem[]) {
    for (const item of items) {
      menu.addItem((menuItem) => {
        menuItem.setTitle(item.text).setIcon(item.icon);
        if (item.submenu) {
          // setSubmenu() is internal (absent from obsidian.d.ts) but is how
          // Obsidian itself nests menus (e.g. table row/column). Unlike an
          // onClick item, a submenu item keeps the parent menu open.
          const submenu = (menuItem as any).setSubmenu() as Menu;
          submenu.setUseNativeMenu(false);
          this.addMenuItems(submenu, item.submenu);
        } else if (item.onClick) {
          menuItem.onClick(item.onClick);
        }
      });
    }
  }

  private applyPosition() {
    if (!this.toolbarEl) return;

    const settings = this.plugin.pluginSettings;
    const pos = settings.toolbarPosition;
    const offsetX = settings.toolbarOffsetX;
    const offsetY = settings.toolbarOffsetY;

    this.toolbarEl.style.left = "";
    this.toolbarEl.style.right = "";
    this.toolbarEl.style.top = "";
    this.toolbarEl.style.bottom = "";

    if (pos === "left") {
      this.toolbarEl.style.left = `${offsetX}px`;
    } else {
      this.toolbarEl.style.right = `${offsetX}px`;
    }

    // The vertical bar stretches the full canvas height (spacer pushes
    // refresh/settings to the bottom); collapsed it shrinks to the logo.
    this.toolbarEl.style.top = `${offsetY}px`;
    if (!settings.toolbarCollapsed) {
      this.toolbarEl.style.bottom = `${offsetY}px`;
    }

    // Width + icon size are user-tunable; CSS consumes these vars.
    this.toolbarEl.style.setProperty("--fc-tb-w", `${settings.toolbarWidth}px`);
    this.toolbarEl.style.setProperty("--fc-tb-icon", `${settings.toolbarIconSize}px`);
    // Resize strip hugs the canvas-facing edge (left edge when right-anchored).
    this.toolbarEl.classList.toggle("fc-tb-anchor-right", pos !== "left");
  }

  private insertWidget() {
    this.plugin.openWidgetInputModal();
  }

  private insertCalendar() {
    void this.plugin.insertCalendarCard();
  }

  private insertOverlay() {
    void this.plugin.insertOverlayCard();
  }

  private insertSpread() {
    void this.plugin.insertSpreadCard();
  }

  // Gear: jump straight to this plugin's settings tab.
  private openSettings() {
    const setting = (this.plugin.app as any).setting;
    setting?.open();
    setting?.openTabById(this.plugin.manifest.id);
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
