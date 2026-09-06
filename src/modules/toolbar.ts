import { Menu, Notice, TFile, setTooltip, type WorkspaceLeaf } from "obsidian";
import { parseCardSpec } from "./card-spec";
import { TB_ICONS } from "./toolbar-icons";
import { appendSvg } from "../utils/dom";
import { t } from "../i18n";
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
// toggle; entries without one (insert-data/data-tools/components) always render.
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
      appendSvg(logo, LOGO_SVG);
    }
    setTooltip(logo, t("StrataBoard — 点击展开/折叠工具栏"));
    logo.addEventListener("click", () => this.toggleCollapsed());

    // Drag handle: drag moves the bar in 2D, offset persists.
    const drag = this.toolbarEl.createDiv("fc-tb-drag");
    setTooltip(drag, t("拖拽移动工具栏"));
    drag.addEventListener("pointerdown", (event) => this.startDrag(event));

    // Width handle: vertical strip on the canvas-facing edge; dragging it
    // resizes the bar (persists as toolbarWidth).
    const resize = this.toolbarEl.createDiv("fc-tb-resize");
    setTooltip(resize, t("拖拽调整工具栏宽度"));
    resize.addEventListener("pointerdown", (event) => this.startResize(event));

    // Source-classified entries, rendered in the user-defined order. Entries
    // tied to a source are gated by its 工具栏显示 toggle; 「插入数据」fans out
    // across every source and 「数据处理」/「组件」are cross-source tools
    // (quote legs may come from Tushare, custom sources, FRED, …), so they
    // always render. Token/key guidance lives in the plugin methods
    // themselves (openUnifiedSearch / insertMacroCard / …), so hidden-source
    // gating is the only filtering here.
    const sources = this.plugin.pluginSettings.toolbarSources;
    for (const def of this.entryDefs()) {
      if (def.source && !(sources[def.source] ?? true)) continue;
      if (def.menu) this.createMenuButton(def.icon, def.label, def.menu);
      else if (def.onClick) this.createButton(def.icon, def.label, def.onClick);
    }

    this.createButton("refresh", "全部刷新", () => void this.refreshAll());
    this.createButton("settings", "设置", () => this.openSettings());

    this.applyCollapsed();
    this.applyPosition();
  }

  // Entry metadata in one place; render order comes from settings.toolbarOrder.
  private entryDefs(): ToolbarEntryDef[] {
    const defs: Record<ToolbarEntryId, ToolbarEntryDef> = {
      "insert-data": {
        id: "insert-data",
        label: "插入数据",
        icon: "insert-data",
        onClick: () => this.plugin.openUnifiedSearch(),
      },
      "data-tools": {
        id: "data-tools",
        label: "数据处理",
        icon: "data-tools",
        menu: [
          { text: "数据叠加", icon: "layers", onClick: () => this.insertOverlay() },
          { text: "数据计算", icon: "calculator", onClick: () => this.insertSpread() },
        ],
      },
      tradingview: {
        id: "tradingview",
        label: "TradingView Widget",
        icon: "tradingview",
        source: "tradingview",
        onClick: () => this.insertWidget(),
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

  // Drag on the handle moves the bar in 2D. Each offset measures the distance
  // from the anchored corner, so the delta sign flips per axis on right- or
  // bottom-anchored bars.
  private startDrag(event: PointerEvent) {
    if (!this.toolbarEl) return;
    event.preventDefault();
    event.stopPropagation();
    const settings = this.plugin.pluginSettings;
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffsetX = settings.toolbarOffsetX;
    const startOffsetY = settings.toolbarOffsetY;
    const signX = settings.toolbarPosition.endsWith("left") ? 1 : -1;
    const signY = settings.toolbarPosition.startsWith("top") ? 1 : -1;
    const onMove = (moveEvent: PointerEvent) => {
      settings.toolbarOffsetX = Math.max(0, startOffsetX + (moveEvent.clientX - startX) * signX);
      settings.toolbarOffsetY = Math.max(0, startOffsetY + (moveEvent.clientY - startY) * signY);
      this.applyPosition();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      void this.plugin.saveSettings();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  // Horizontal drag on the edge strip: resizes the bar. The strip sits on the
  // canvas-facing edge, so dragging flips the delta sign on right-anchored
  // bars (same convention as startDrag).
  private startResize(event: PointerEvent) {
    if (!this.toolbarEl) return;
    event.preventDefault();
    event.stopPropagation();
    const settings = this.plugin.pluginSettings;
    const startX = event.clientX;
    const startWidth = this.toolbarEl.offsetWidth;
    const sign = settings.toolbarPosition.endsWith("left") ? 1 : -1;
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
  // label arrives as a Chinese i18n key and is translated here.
  private createButton(icon: keyof typeof TB_ICONS, label: string, onClick: () => void) {
    const btn = this.toolbarEl!.createEl("button");
    if (this.plugin.pluginSettings.toolbarStyle === "text") {
      btn.setText(t(label));
      btn.addClass("fc-tb-text-btn");
    } else {
      appendSvg(btn, TB_ICONS[icon]);
      setTooltip(btn, t(label));
    }
    btn.addEventListener("click", onClick);
  }

  private createMenuButton(icon: keyof typeof TB_ICONS, label: string, items: ToolbarMenuItem[]) {
    const btn = this.toolbarEl!.createEl("button");
    if (this.plugin.pluginSettings.toolbarStyle === "text") {
      btn.setText(t(label));
      btn.addClass("fc-tb-text-btn");
    } else {
      appendSvg(btn, TB_ICONS[icon]);
      setTooltip(btn, t(label));
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
        menuItem.setTitle(t(item.text)).setIcon(item.icon);
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
    const isLeft = pos.endsWith("left");
    const isTop = pos.startsWith("top");
    const offsetX = settings.toolbarOffsetX;
    const offsetY = settings.toolbarOffsetY;

    this.toolbarEl.setCssProps({ left: "", right: "", top: "", bottom: "" });

    // Corner anchor: the bar is compact (hugs its content), and each offset
    // measures out from the anchored corner.
    if (isLeft) {
      this.toolbarEl.setCssProps({ left: `${offsetX}px` });
    } else {
      this.toolbarEl.setCssProps({ right: `${offsetX}px` });
    }
    if (isTop) {
      this.toolbarEl.setCssProps({ top: `${offsetY}px` });
    } else {
      this.toolbarEl.setCssProps({ bottom: `${offsetY}px` });
    }

    // Width + icon size are user-tunable; CSS consumes these vars.
    this.toolbarEl.style.setProperty("--fc-tb-w", `${settings.toolbarWidth}px`);
    this.toolbarEl.style.setProperty("--fc-tb-icon", `${settings.toolbarIconSize}px`);
    // Resize strip hugs the canvas-facing edge (left edge when right-anchored).
    this.toolbarEl.classList.toggle("fc-tb-anchor-right", !isLeft);
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
      new Notice(t("当前画布上没有金融卡片。"));
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

    new Notice(
      failed > 0
        ? t("已刷新 {n} 张卡片，{m} 张失败。", { n: refreshed, m: failed })
        : t("已刷新 {n} 张卡片。", { n: refreshed })
    );
  }

  placeFileNode(file: TFile | string) {
    const view = this.activeLeaf?.view as any;
    if (!view?.canvas) {
      new Notice(t("当前没有激活的 Canvas 视图。"));
      return;
    }

    const canvas = view.canvas;
    const center = canvas.posCenter?.() || canvas.getViewportCenter?.() || { x: 0, y: 0 };
    const tfile = typeof file === "string" ? this.plugin.app.vault.getAbstractFileByPath(file) : file;

    if (!tfile || !(tfile instanceof TFile)) {
      new Notice(t("找不到要放置的卡片文件。"));
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

    let node;
    try {
      node = canvas.createFileNode?.(options);
    } catch (e) {
      console.error("placeFileNode: createFileNode threw", e, { path: tfile.path, options });
      throw e;
    }

    if (node) {
      canvas.requestSave();
      this.fitNodeHeightToCard(node, canvas);
    } else {
      new Notice(t("在画布上放置卡片失败"));
      console.error("placeFileNode: createFileNode returned undefined", { file: tfile.path, center });
    }
  }

  // The fixed default node size (800×500) is shorter than a fully rendered
  // card (header + fixed-height chart stack + footer ≈ 550+), which clips
  // the footer behind the node's overflow:hidden. Measure the rendered card
  // and grow the node until the content is fully visible. Data-driven header
  // rows can land after the first paint, so probe a few times and keep the
  // largest measurement (grow-only, never shrink the user's node). Uses the
  // internal node.resize() (verified against app.asar), same as canvas'
  // own drag-resize.
  private fitNodeHeightToCard(node: any, canvas: any) {
    const probe = () => {
      const cardEl = node.nodeEl?.querySelector(".strataboard-card") as HTMLElement | null;
      if (!cardEl) return;
      // height:100% + overflow:hidden clip the card to the node box, but
      // scrollHeight still reports the natural content height.
      const contentHeight = cardEl.scrollHeight;
      if (contentHeight > node.height) {
        node.resize({ width: node.width, height: contentHeight });
        canvas.requestSave();
      }
    };
    for (const delay of [80, 300, 800, 1600]) {
      window.setTimeout(probe, delay);
    }
  }
}
