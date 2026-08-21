import { MarkdownRenderChild, type App } from "obsidian";
import { onAttached } from "../utils/dom";

// Minimal slice of the plugin the base class needs; keeps this module free
// of the main.ts import cycle. The full plugin satisfies it structurally.
export interface ChartCardPluginHost {
  app: App;
}

/** The card spec's Canvas 显示逻辑 fields, resolved against defaults. */
export interface CanvasDisplayOptions {
  widthAuto: boolean;
  heightAuto: boolean;
  bleed: number;
}

/**
 * Applies the Canvas 显示逻辑 spec fields (统合编辑弹窗) to a rendered card.
 * Canvas-only: outside a canvas node the card keeps its regular note styling.
 * Both rules are CSS-level — the bleed goes through a --fc-bleed custom
 * property and the .fc-canvas-bleed / .fc-canvas-height-auto classes carry
 * the !important rules in styles.css (the plugin review forbids inline
 * !important styles), so they keep holding across node resizes without a
 * listener. widthAuto === false needs no CSS here — the chart renderer
 * freezes its stack width after the first layout instead.
 */
export function applyCanvasDisplayOptions(cardEl: HTMLElement, opts: CanvasDisplayOptions): void {
  let el: HTMLElement | null = cardEl;
  let inCanvas = false;
  while (el) {
    if (el.classList.contains("canvas-node")) {
      inCanvas = true;
      break;
    }
    el = el.parentElement;
  }
  if (!inCanvas) return;
  cardEl.setCssProps({ "--fc-bleed": `${opts.bleed}px` });
  cardEl.addClass("fc-canvas-bleed");
  if (!opts.heightAuto) {
    // Let the fixed 高度 drive the card height instead of the node height.
    cardEl.addClass("fc-canvas-height-auto");
  }
}

/**
 * Base class for chart-style code-block cards, extracting the canvas
 * interaction model from TushareCodeBlockRenderer so every chart card shares
 * it. Three tiers:
 *  - single click/drag on the card: selects and moves the canvas node
 *    (the node's content blocker keeps pointer events at canvas level);
 *  - double-click: activates chart mode — the fc-chart-active class on
 *    the node hides the blocker (styles.css), so hover drives the
 *    crosshair and dragging pans the chart;
 *  - double-click while active: opens the settings modal.
 * Outside a canvas (regular md pages) there is no blocker and the chart
 * is always live, so double-click opens the modal directly.
 *
 * Subclasses implement renderBody() (chart / error+retry) and
 * openEditModal().
 */
export abstract class ChartCardCodeBlockRenderer extends MarkdownRenderChild {
  protected plugin: ChartCardPluginHost;
  protected source: string;
  protected sourcePath: string;
  // Protected so subclasses can tell user-driven chart interactions (which
  // only happen in chart mode) from programmatic ones.
  protected chartActive = false;

  constructor(plugin: ChartCardPluginHost, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.source = source;
    this.sourcePath = sourcePath;
  }

  onload() {
    // Obsidian's canvas file node enters its embedded edit mode when a click
    // lands on node content — UNLESS the target is inside an element marked
    // .interactive-child (the escape hatch its own bases embed uses; verified
    // against app.asar). Mark the card so clicks in chart mode can never
    // switch the node to source view; source is edited only in the md file.
    this.containerEl.addClass("strataboard-card");
    this.containerEl.addClass("interactive-child");
    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());

    void this.renderBody();

    // The dblclick listener sits on DOCUMENT (capture), not on the card:
    // while inactive the card is covered by Obsidian's content blocker,
    // which is a SIBLING of the node content rather than an ancestor of the
    // card, so double-clicks on the covered card never bubble through the
    // card's container — a card-level listener would never see them and
    // Obsidian's own handler would open the node's source edit mode instead.
    // preventDefault here also suppresses that native edit mode; source is
    // edited only in the underlying md file.
    this.registerDomEvent(
      document,
      "dblclick",
      (event) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        const inCard = this.containerEl.contains(target);
        const nodeEl = this.findCanvasNodeEl();
        const onOwnBlocker =
          nodeEl != null &&
          nodeEl.contains(target) &&
          target.classList.contains("canvas-node-content-blocker");
        if (!inCard && !onOwnBlocker) return;
        // Let header buttons keep their own behavior.
        if (inCard && target.closest("button")) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.chartActive || !nodeEl) {
          this.openEditModal();
        } else {
          this.setChartActive(true);
        }
      },
      { capture: true }
    );

    // In chart mode keep the canvas' node-drag handler from starting a drag:
    // Obsidian initiates node selection/dragging from POINTERDOWN listeners
    // on ancestor elements (verified against app.asar), so stop pointerdown
    // from bubbling past the card. Do NOT stop/preventDefault mousedown —
    // lightweight-charts pans via mousedown on its own (descendant) elements,
    // and canceling pointerdown would also suppress the compatibility mouse
    // events the chart needs. (While inactive the blocker intercepts events
    // before they reach the card at all.)
    this.registerDomEvent(
      this.containerEl,
      "pointerdown",
      (event) => {
        if (this.chartActive) event.stopPropagation();
      },
      { capture: true }
    );

    // In chart mode, drive the time-axis wheel zoom OURSELVES from a
    // window-capture listener: Obsidian's canvas intercepts wheel at window
    // level (same pattern as pointerdown, see below), so neither the chart's
    // own wheel handler nor a card-level listener would ever see the event.
    // stopPropagation + preventDefault keep BOTH the canvas zoom and the
    // library's wheel handler from acting — no double zoom. Outside chart
    // mode the event flows untouched (canvas wheel-zoom works as before).
    this.registerDomEvent(
      window,
      "wheel",
      (event) => {
        if (!this.chartActive || !this.containerEl.contains(event.target as Node)) return;
        event.stopPropagation();
        event.preventDefault();
        this.onChartWheel(event);
      },
      { capture: true, passive: false }
    );

    // Leave chart mode on outside click or Escape.
    //
    // The outside-click listener sits on WINDOW (capture), not on document:
    // Obsidian's canvas initiates drag/pan from window-level capture
    // pointerdown listeners and stops propagation there, so a document-level
    // listener never sees the event and chart mode never exited (activation
    // via dblclick was unaffected because that event flows to document).
    this.registerDomEvent(
      window,
      "pointerdown",
      (event) => {
        if (this.containerEl.contains(event.target as Node)) return;
        if (this.chartActive) {
          this.setChartActive(false, true);
        } else {
          // Sweep a stale fc-chart-active left on the node by a destroyed
          // instance (a re-render replaces the renderer but the canvas node
          // keeps its classes).
          this.containerEl.removeClass("fc-chart-active");
          this.findCanvasNodeEl()?.removeClass("fc-chart-active");
        }
      },
      { capture: true }
    );
    this.registerDomEvent(document, "keydown", (event) => {
      if (this.chartActive && event.key === "Escape") {
        this.setChartActive(false, true);
      }
    });
  }

  onunload() {
    // No onChartModeExit hook here: writing files during unload is unsafe.
    this.setChartActive(false);
  }

  // Subclass renders the chart (or the error + retry state) into containerEl.
  protected abstract renderBody(): void | Promise<void>;

  // Subclass opens its spec edit modal.
  protected abstract openEditModal(): void;

  // Called on chart-mode ENTRY (first transition to active). Default no-op.
  protected onChartModeEnter(): void {}

  // Called on user-initiated chart-mode EXIT (outside click or Escape) — NOT
  // on unload. Default no-op.
  protected onChartModeExit(): void {}

  // Called on a wheel event inside the card while in chart mode (already
  // stopped/prevented at window capture). Subclasses forward to their
  // chart's applyTimeAxisWheelZoom. Default no-op.
  protected onChartWheel(_event: WheelEvent): void {}

  private setChartActive(active: boolean, userInitiated = false) {
    const wasActive = this.chartActive;
    this.chartActive = active;
    this.containerEl.toggleClass("fc-chart-active", active);
    this.findCanvasNodeEl()?.toggleClass("fc-chart-active", active);
    if (active && !wasActive) {
      this.onChartModeEnter();
    } else if (!active && wasActive && userInitiated) {
      this.onChartModeExit();
    }
  }

  private findCanvasNodeEl(): HTMLElement | null {
    let el: HTMLElement | null = this.containerEl;
    while (el && !el.classList.contains("canvas-node")) {
      el = el.parentElement;
    }
    return el;
  }

  private tagParentPreviewAsCard() {
    let el: HTMLElement | null = this.containerEl;
    let canvasNode: HTMLElement | null = null;
    let markdownPreview: HTMLElement | null = null;

    while (el) {
      if (el.classList.contains("canvas-node")) {
        canvasNode = el;
      }
      if (el.classList.contains("markdown-preview-view")) {
        markdownPreview = el;
      }
      el = el.parentElement;
    }

    if (canvasNode) {
      canvasNode.classList.add("strataboard-card-note");
      if (markdownPreview) {
        markdownPreview.classList.add("strataboard-card-note");
      }
    }
  }
}
