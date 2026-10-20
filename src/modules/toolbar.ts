import { Menu, Notice, TFile, addIcon, type WorkspaceLeaf } from "obsidian";
import { setTooltip } from "../ui/tooltip";
import { TB_ICONS, TB_MENU_ICONS } from "./toolbar-icons";
import { LOGO_SVG } from "./logo";
import { SERIES_LINE_COLORS } from "./overlay-lines";
import { appendSvg } from "../utils/dom";
import {
  openPluginSettings,
  type CanvasLike,
  type CanvasNodeLike,
  type CanvasViewLike,
  type MenuItemWithSubmenu,
} from "../utils/obsidian-internals";
import { t } from "../i18n";
import type StrataBoardPlugin from "../main";

interface ToolbarMenuItem {
  text: string;
  // Lucide icon name for menuItem.setIcon. Mutually exclusive with dotColor.
  icon?: string;
  // Palette color for the fallback dot icon (all sources/groups use this).
  dotColor?: string;
  onClick?: () => void;
  submenu?: ToolbarMenuItem[];
}

// Stable hash → palette color, so a given source/group always gets the same
// dot color. Shared with the settings page source rows (avatars there reuse
// the same key scheme: def.id / `group:<名称>`).
export function paletteColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return SERIES_LINE_COLORS[Math.abs(h) % SERIES_LINE_COLORS.length];
}

// A top-level entry.
interface ToolbarEntryDef {
  label: string;
  icon: keyof typeof TB_ICONS;
  onClick?: () => void;
  menu?: ToolbarMenuItem[];
}

export class CanvasToolbar {
  private plugin: StrataBoardPlugin;
  private onOpenAi: () => void;
  private toolbarEl: HTMLElement | null = null;
  private logoEl: HTMLButtonElement | null = null;
  private activeLeaf: WorkspaceLeaf | null = null;

  constructor(plugin: StrataBoardPlugin, onOpenAi: () => void) {
    this.plugin = plugin;
    this.onOpenAi = onOpenAi;
  }

  attach(leaf: WorkspaceLeaf) {
    if (this.activeLeaf === leaf) return;
    this.detach();

    const view = leaf.view as CanvasViewLike;
    if (!view?.canvas) return;

    this.activeLeaf = leaf;
    const container = view.containerEl;
    // The toolbar always renders on the hermes dark palette.
    this.toolbarEl = container.createDiv({ cls: "strataboard-toolbar fc-hermes" });

    // Menu-item icons resolve through Obsidian's global registry; register the
    // non-Lucide glyphs (overwrite-safe on re-register).
    for (const [name, svg] of Object.entries(TB_MENU_ICONS)) addIcon(name, svg);

    // Logo: brand mark from logo.ts; a real <button> so collapse/expand is
    // keyboard-reachable (state persists in settings).
    this.logoEl = this.toolbarEl.createEl("button", { cls: "fc-tb-logo" });
    appendSvg(this.logoEl, LOGO_SVG);
    this.updateLogoTooltip();
    this.logoEl.addEventListener("click", () => this.toggleCollapsed());

    // Drag handle: drag moves the bar in 2D, offset persists. Not keyboard
    // operable, so tooltip only.
    const drag = this.toolbarEl.createDiv("fc-tb-drag");
    setTooltip(drag, t("拖拽移动工具栏"));
    drag.addEventListener("pointerdown", (event) => this.startDrag(event));

    // Primary creation entries in a fixed order, then the low-frequency
    // 「更多」 menu; refresh + settings pin to the tail.
    for (const def of this.entryDefs()) {
      if (def.menu) this.createMenuButton(def.icon, def.label, def.menu);
      else if (def.onClick) this.createButton(def.icon, def.label, def.onClick);
    }

    this.createButton("refresh", "刷新全部卡片", () => void this.refreshAll());
    this.createButton("settings", "打开设置", () => this.openSettings());

    this.applyCollapsed();
    this.applyPosition();
    this.maybeShowFirstHint();
  }

  // Entry metadata in one place; render order is fixed. 「插入图表」 offers
  // every source in its submenu and 「更多」 groups the low-frequency tools,
  // so they always render. Configuration guidance lives in the plugin methods
  // themselves (openUnifiedSearch / …).
  private entryDefs(): ToolbarEntryDef[] {
    return [
      {
        label: "插入图表",
        icon: "insert-data",
        menu: this.buildInsertDataMenu(),
      },
      { label: "创建对比卡", icon: "layers", onClick: () => this.insertOverlay() },
      { label: "创建计算卡", icon: "calculator", onClick: () => this.insertSpread() },
      // AI workbench: always visible (W08 plan §3.2); the panel itself shows
      // the unconfigured state when BYOK is not set up.
      { label: "AI 创建", icon: "ai", onClick: () => this.onOpenAi() },
      {
        label: "打开更多工具",
        icon: "more",
        menu: [
          { text: "TradingView 小组件", icon: "tradingview", onClick: () => this.insertWidget() },
          { text: "本地脚本", icon: "file-code-corner", onClick: () => this.plugin.openScriptManager() },
          { text: "日历", icon: "calendar-days", onClick: () => this.insertCalendar() },
        ],
      },
    ];
  }

  // 「插入图表」 submenu: 「全部」 merged search first, then one item per
  // source group and per ungrouped source. Grouped members never appear
  // individually — picking a group searches across all its sources.
  private buildInsertDataMenu(): ToolbarMenuItem[] {
    const items: ToolbarMenuItem[] = [
      { text: "全部", icon: "database", onClick: () => this.plugin.openUnifiedSearch("all") },
    ];
    const seenGroups = new Set<string>();
    for (const def of this.plugin.enabledCustomSources()) {
      if (def.group) {
        if (seenGroups.has(def.group)) continue;
        seenGroups.add(def.group);
        const group = def.group;
        items.push({
          text: group,
          dotColor: paletteColor(`group:${group}`),
          onClick: () => this.plugin.openUnifiedSearch(`group:${group}`),
        });
      } else {
        items.push({
          text: def.name,
          dotColor: paletteColor(def.id),
          onClick: () => this.plugin.openUnifiedSearch(`custom:${def.id}`),
        });
      }
    }
    return items;
  }

  detach() {
    if (this.toolbarEl) {
      this.toolbarEl.remove();
      this.toolbarEl = null;
    }
    this.logoEl = null;
    this.activeLeaf = null;
  }

  updatePosition() {
    this.applyPosition();
  }

  // Rebuilds the bar in place (settings changes take effect immediately,
  // without waiting for a leaf change).
  reload() {
    const leaf = this.activeLeaf;
    this.detach();
    if (leaf) this.attach(leaf);
  }

  private toggleCollapsed() {
    this.plugin.pluginSettings.toolbarCollapsed = !this.plugin.pluginSettings.toolbarCollapsed;
    void this.plugin.saveSettings();
    this.applyCollapsed();
    this.updateLogoTooltip();
    this.applyPosition();
  }

  private applyCollapsed() {
    this.toolbarEl?.classList.toggle("is-collapsed", this.plugin.pluginSettings.toolbarCollapsed);
  }

  // Logo tooltip/aria follow the collapse state: a collapsed bar offers
  // 「展开工具栏」, an expanded one 「折叠工具栏」.
  private updateLogoTooltip() {
    if (!this.logoEl) return;
    const label = t(this.plugin.pluginSettings.toolbarCollapsed ? "展开工具栏" : "折叠工具栏");
    setTooltip(this.logoEl, label);
    this.logoEl.setAttribute("aria-label", label);
  }

  // One-shot hint bubble next to the bar (settings.toolbarHintShown gates
  // it): points out that every icon carries a hover tooltip.
  private maybeShowFirstHint() {
    if (!this.toolbarEl || this.plugin.pluginSettings.toolbarHintShown) return;
    this.plugin.pluginSettings.toolbarHintShown = true;
    // saveSettings() rebuilds the toolbar via applySettings → reload, so the
    // bubble is appended only after the rebuild settles.
    void this.plugin.saveSettings().then(() => this.showFirstHint());
  }

  private showFirstHint() {
    if (!this.toolbarEl) return;
    const hint = this.toolbarEl.createDiv("fc-tb-first-hint");
    // The bar may hug the right edge; flip the bubble to its inner side.
    if (this.plugin.pluginSettings.toolbarPosition.endsWith("right")) {
      hint.addClass("fc-tb-hint-left");
    }
    hint.createSpan({ text: t("工具栏图标可悬停查看说明") });
    const close = hint.createEl("button", { text: "×", attr: { "aria-label": t("关闭") } });
    close.addEventListener("click", () => hint.remove());
    window.setTimeout(() => hint.remove(), 6000);
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

  // Buttons render as a bare icon; the tooltip carries the action label and
  // doubles as the aria-label (both are verb phrases). Icons are inline
  // Lucide SVGs from TB_ICONS. label arrives as a Chinese i18n key and is
  // translated here.
  private createButton(icon: keyof typeof TB_ICONS, label: string, onClick: () => void) {
    const btn = this.toolbarEl!.createEl("button");
    appendSvg(btn, TB_ICONS[icon]);
    setTooltip(btn, t(label));
    btn.setAttribute("aria-label", t(label));
    btn.addEventListener("click", onClick);
  }

  private createMenuButton(icon: keyof typeof TB_ICONS, label: string, items: ToolbarMenuItem[]) {
    const btn = this.toolbarEl!.createEl("button");
    appendSvg(btn, TB_ICONS[icon]);
    setTooltip(btn, t(label));
    btn.setAttribute("aria-label", t(label));
    btn.setAttribute("aria-haspopup", "true");
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

  // Resolves a menu item's icon to a name usable with setIcon: palette dots
  // are registered into Obsidian's icon registry via addIcon (global,
  // overwrite-safe on re-register).
  private resolveMenuIcon(item: ToolbarMenuItem): string | undefined {
    if (item.dotColor) {
      const name = `fc-dot-${item.dotColor.slice(1)}`;
      addIcon(
        name,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${item.dotColor}"/></svg>`
      );
      return name;
    }
    return item.icon;
  }

  private addMenuItems(menu: Menu, items: ToolbarMenuItem[]) {
    items.forEach((item) => {
      menu.addItem((menuItem) => {
        menuItem.setTitle(t(item.text));
        const iconName = this.resolveMenuIcon(item);
        if (iconName) menuItem.setIcon(iconName);
        if (item.submenu) {
          // setSubmenu() is internal (absent from obsidian.d.ts) but is how
          // Obsidian itself nests menus (e.g. table row/column). Unlike an
          // onClick item, a submenu item keeps the parent menu open.
          const submenu = (menuItem as MenuItemWithSubmenu).setSubmenu();
          submenu.setUseNativeMenu(false);
          this.addMenuItems(submenu, item.submenu);
        } else if (item.onClick) {
          menuItem.onClick(item.onClick);
        }
      });
    });
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
    openPluginSettings(this.plugin.app, this.plugin.manifest.id);
  }

  // 刷新全部卡片: every live chart card re-loads and re-renders itself through
  // its refreshCard() entry (quote/overlay/spread all register in
  // plugin.chartRenderers), so all three card types are covered — no
  // quote-only cache pre-warming shortcut. Failures surface on the cards
  // themselves (shared error block with retry), the Notice is a pure summary.
  private refreshAll() {
    const renderers = [...this.plugin.chartRenderers];
    if (renderers.length === 0) {
      new Notice(t("当前画布上没有 StrataBoard 卡片。"));
      return;
    }
    for (const renderer of renderers) {
      renderer.refreshCard();
    }
    new Notice(t("已刷新 {n} 张卡片。", { n: String(renderers.length) }));
  }

  placeFileNode(file: TFile | string) {
    const view = this.activeLeaf?.view as CanvasViewLike | undefined;
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
      (node) => node.filePath && node.filePath.startsWith(libraryPath + "/")
    ).length;
    const cascade = (cardCount % 8) * 40;

    const options = {
      file: tfile,
      pos: { x: center.x - 400 + cascade, y: center.y - 250 + cascade },
      size: { width: 800, height: 500 },
    };

    let node: CanvasNodeLike | undefined;
    try {
      node = canvas.createFileNode?.(options);
    } catch (e) {
      console.error("placeFileNode: createFileNode threw", e, { path: tfile.path, options });
      throw e;
    }

    if (node) {
      canvas.requestSave?.();
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
  private fitNodeHeightToCard(node: CanvasNodeLike, canvas: CanvasLike) {
    const probe = () => {
      const cardEl = node.nodeEl?.querySelector(".strataboard-card") as HTMLElement | null;
      if (!cardEl) return;
      // height:100% + overflow:hidden clip the card to the node box, but
      // scrollHeight still reports the natural content height.
      const contentHeight = cardEl.scrollHeight;
      if (contentHeight > node.height) {
        node.resize?.({ width: node.width, height: contentHeight });
        canvas.requestSave?.();
      }
    };
    for (const delay of [80, 300, 800, 1600]) {
      window.setTimeout(probe, delay);
    }
  }
}
