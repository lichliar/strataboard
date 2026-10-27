import { MarkdownRenderChild, setIcon, type App } from "obsidian";
import { nextFrameBounded, onAttached } from "../utils/dom";
import { t } from "../i18n";

// Minimal slice of the plugin the base class needs; keeps this module free
// of the main.ts import cycle. The full plugin satisfies it structurally.
export interface ChartCardPluginHost {
  app: App;
  // Live chart card renderers; the script-output invalidation re-renders all
  // of them (registered/unregistered in onload/onunload below).
  chartRenderers: Set<ChartCardRefreshHandle>;
  // One-shot 双击进入图表交互 hint state (persisted in plugin settings): the
  // hint shows on the first hover over an inactive canvas chart card, then
  // never again.
  isChartModeHintShown(): boolean;
  markChartModeHintShown(): void;
}

// Public re-render surface of a chart card renderer (the plugin-level
// registry stores these; main.ts' quote renderer satisfies it too).
export interface ChartCardRefreshHandle {
  refreshCard(): void;
}

/**
 * Base class for chart-style code-block cards; every chart card shares the
 * canvas interaction model implemented here. Two tiers:
 *  - single click/drag on the card: selects and moves the canvas node
 *    (the node's content blocker keeps pointer events at canvas level);
 *  - double-click: enters chart mode — the fc-chart-active class on the
 *    node hides the blocker (styles.css), so hover drives the crosshair and
 *    dragging pans the chart. The mode is marked by an accent outline plus
 *    the fc-chart-mode-bar status strip (icon + text, not color alone) and
 *    exits on an outside click or Escape.
 * A second double-click does nothing: editing lives on the card footer edit
 * button and the canvas node context menu. Outside a canvas (regular md
 * pages) there is no blocker and the chart is always live, so double-click
 * is left to Obsidian there.
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
  // The initial render's promise (renderBody handles its own errors, so it
  // never rejects). whenReady() exposes it to the code-block processor.
  private initialRender: Promise<void> = Promise.resolve();
  // Chart-mode status strip (icon + text). Kept as a detached element while
  // inactive; syncChartModeBar() prepends it to containerEl when active, and
  // runRender() re-syncs after every renderBody — renderBody empties
  // containerEl, which would otherwise wipe the bar.
  private chartModeBar: HTMLElement | null = null;

  constructor(plugin: ChartCardPluginHost, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.source = source;
    this.sourcePath = sourcePath;
  }

  onload() {
    this.plugin.chartRenderers.add(this);
    // Obsidian's canvas file node enters its embedded edit mode when a click
    // lands on node content — UNLESS the target is inside an element marked
    // .interactive-child (the escape hatch its own bases embed uses; verified
    // against app.asar). Mark the card so clicks in chart mode can never
    // switch the node to source view; source is edited only in the md file.
    this.containerEl.addClass("strataboard-card");
    this.containerEl.addClass("interactive-child");
    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());

    this.initialRender = this.runRender();

    // The dblclick listener sits on DOCUMENT (capture), not on the card:
    // while inactive the card is covered by Obsidian's content blocker,
    // which is a SIBLING of the node content rather than an ancestor of the
    // card, so double-clicks on the covered card never bubble through the
    // card's container — a card-level listener would never see them and
    // Obsidian's own handler would open the node's source edit mode instead.
    // Inside a canvas, preventDefault here suppresses that native edit mode;
    // source is edited only in the underlying md file.
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
        // Outside a canvas node there is nothing to activate: leave the
        // double-click to Obsidian (editing lives on the footer edit button).
        if (!nodeEl) return;
        event.preventDefault();
        event.stopPropagation();
        // Chart mode is entered only from the inactive state; a second
        // double-click does nothing.
        if (!this.chartActive) this.setChartActive(true);
      },
      { capture: true }
    );

    // First-hover 双击进入图表交互 hint. It also listens on DOCUMENT
    // (capture) for the same reason as dblclick: while inactive the card is
    // covered by the node's content blocker, so no pointer event ever
    // reaches containerEl — the blocker (a sibling) is the hover target.
    this.registerDomEvent(
      document,
      "pointerover",
      (event) => {
        if (this.chartActive || this.plugin.isChartModeHintShown()) return;
        const target = event.target as Node | null;
        const nodeEl = this.findCanvasNodeEl();
        if (!target || !nodeEl || !nodeEl.contains(target)) return;
        this.showChartModeHint(nodeEl);
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

    // lightweight-charts' pane resize handle is a thin row-resize target.
    // Canvas also watches pointerdown to begin node dragging, so let the
    // chart own this gesture before it reaches Canvas. The chart's native
    // mousedown handler still receives the follow-up event and performs the
    // pane resize.
    this.registerDomEvent(
      window,
      "pointerdown",
      (event) => {
        const target = event.target as HTMLElement | null;
        if (!target || !this.containerEl.contains(target)) return;
        const cursor = target.style.cursor || window.getComputedStyle(target).cursor;
        if (cursor === "row-resize") {
          event.stopPropagation();
        }
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
    this.plugin.chartRenderers.delete(this);
    // No onChartModeExit hook here: writing files during unload is unsafe.
    this.setChartActive(false);
  }

  // Subclass renders the chart (or the error + retry state) into containerEl.
  protected abstract renderBody(): void | Promise<void>;

  // Re-entrancy guard: a refresh arriving while a render is still loading is
  // dropped — the in-flight render already reflects the latest spec, and
  // overlapping renders would race on containerEl. While a render runs the
  // card shows the loading skeleton (its refresh entry points are gone),
  // which doubles as the in-progress indication.
  private renderInFlight = false;

  protected runRender(): Promise<void> {
    if (this.renderInFlight) return Promise.resolve();
    this.renderInFlight = true;
    return Promise.resolve()
      .then(() => this.renderBody())
      .finally(() => {
        this.renderInFlight = false;
        // renderBody empties containerEl; re-attach the mode bar when active.
        this.syncChartModeBar();
      });
  }

  // Resolves when the INITIAL render settled and the chart canvas holds a
  // painted frame. The code-block processor returns this promise so Obsidian
  // awaits the chart before capturing the page (导出为 PDF renders the note
  // in a hidden pass and snapshots whatever the DOM holds at that point).
  // Never rejects: renderBody renders its own error state, and the trailing
  // frame wait is bounded in case rAF never fires in the hidden pass.
  whenReady(): Promise<void> {
    return this.initialRender
      .then(() => this.whenChartReady())
      .then(() => this.forcePaint())
      .then(() => nextFrameBounded());
  }

  // Extra readiness wait between the initial render and forcePaint: quote
  // cards forward to their chart renderer's own ready promise. Default
  // resolves immediately.
  protected whenChartReady(): Promise<void> {
    return Promise.resolve();
  }

  // Subclasses whose chart lives in a child renderer forward to its
  // forcePaint() (a discarded takeScreenshot: a synchronous full repaint).
  // Default no-op.
  protected forcePaint(): void {}

  private forceNextRender = false;

  // Public re-render entry for the plugin-level registry (script-output
  // invalidation and the toolbar 刷新全部卡片 refresh every chart card): same
  // render path as the footer refresh button. Explicit refreshes bypass the
  // open-time cache preference so they always request fresh source data.
  refreshCard(): void {
    this.forceNextRender = true;
    void this.runRender();
  }

  protected consumeForceRefresh(): boolean {
    const force = this.forceNextRender;
    this.forceNextRender = false;
    return force;
  }

  // Subclass opens its spec edit modal (footer edit button / canvas menu).
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
    this.syncChartModeBar();
    if (active && !wasActive) {
      this.onChartModeEnter();
    } else if (!active && wasActive && userInitiated) {
      this.onChartModeExit();
    }
  }

  protected findCanvasNodeEl(): HTMLElement | null {
    let el: HTMLElement | null = this.containerEl;
    while (el && !el.classList.contains("canvas-node")) {
      el = el.parentElement;
    }
    return el;
  }

  // Inserts/removes the chart-mode status strip (icon + text — the active
  // state is never signaled by color alone). Absolute-positioned over the
  // card top, so it never shifts the chart layout.
  private syncChartModeBar() {
    if (!this.chartActive) {
      this.chartModeBar?.remove();
      return;
    }
    if (!this.chartModeBar) {
      this.chartModeBar = createDiv({ cls: "fc-chart-mode-bar" });
      const iconEl = this.chartModeBar.createSpan("fc-chart-mode-bar-icon");
      setIcon(iconEl, "mouse-pointer-click");
      this.chartModeBar.createSpan({ text: t("图表交互中 · Esc 退出") });
    }
    this.containerEl.prepend(this.chartModeBar);
  }

  // One-shot hint overlay on the canvas node (shown on the first hover over
  // an inactive card). Marked as shown immediately so it never reappears;
  // dismisses on pointer leave or after a few seconds.
  private showChartModeHint(nodeEl: HTMLElement) {
    this.plugin.markChartModeHintShown();
    const hint = nodeEl.createDiv({
      cls: "fc-chart-mode-hint",
      text: t("双击进入图表交互，Esc 退出"),
    });
    const dismiss = () => hint.remove();
    window.setTimeout(dismiss, 4000);
    nodeEl.addEventListener("pointerleave", dismiss, { once: true });
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
