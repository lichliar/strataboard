import { MarkdownRenderChild } from "obsidian";
import type { ParsedCardSpec } from "../types";
import type FinancialCanvasPlugin from "../main";
import { onAttached } from "../utils/dom";

export interface WidgetRendererOptions {
  height?: number;
  plugin: FinancialCanvasPlugin;
  sourcePath: string;
}

export class WidgetRenderer extends MarkdownRenderChild {
  private spec: ParsedCardSpec;
  private options: WidgetRendererOptions;
  private height: number;
  private iframe: HTMLIFrameElement | null = null;

  constructor(containerEl: HTMLElement, spec: ParsedCardSpec, options: WidgetRendererOptions) {
    super(containerEl);
    this.spec = spec;
    this.options = options;
    this.height = options.height ?? spec.height ?? 400;
  }

  onload() {
    this.render();
  }

  onunload() {
    this.iframe?.remove();
    this.iframe = null;
  }

  private render() {
    this.containerEl.empty();
    this.containerEl.addClass("financial-canvas-card", "financial-canvas-widget");
    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());
    this.renderIframe();
  }

  private renderIframe() {
    const src = this.resolveSrc();
    if (!src) {
      this.containerEl.createEl("div", {
        cls: "financial-canvas-empty",
        text: "未配置 iframe URL 或 HTML 内容。",
      });
      return;
    }

    this.iframe = this.containerEl.createEl("iframe", {
      cls: "financial-canvas-widget-iframe",
      attr: {
        sandbox: "allow-scripts allow-same-origin allow-popups",
        allow: "fullscreen",
        title: this.spec.widgetTitle ?? this.spec.symbol ?? "Widget",
        style: `height: ${this.height}px; width: 100%; border: none;`,
      },
    });

    // The iframe keeps the fixed height from settings in every context
    // (canvas reading view, the node's edit view, regular notes) so the
    // widget looks identical everywhere. Defer assigning src until the
    // element is attached and laid out: Obsidian runs code block processors
    // while the element is detached, and TradingView measures its container
    // at init — loading too early initialized it at a transient size.
    let assigned = false;
    const assignSrc = () => {
      if (assigned || !this.iframe) return;
      assigned = true;
      this.iframe.src = src;
    };
    onAttached(this.containerEl, () => {
      this.tagParentPreviewAsCard();
      requestAnimationFrame(() => requestAnimationFrame(assignSrc));
    });
    // Fallback: if the element never gets connected, still load the widget.
    setTimeout(assignSrc, 2000);
  }

  private resolveSrc(): string | null {
    if (this.spec.iframeUrl) {
      return this.spec.iframeUrl;
    }
    if (this.spec.widgetHtml) {
      return "data:text/html;charset=utf-8," + encodeURIComponent(this.withDefensiveStyles(this.spec.widgetHtml));
    }
    return null;
  }

  // TradingView's embed script sizes its internal chart (itself a
  // lightweight-charts instance) to the .tradingview-widget-container__widget
  // element, but copied widget HTML often gives that element no height — the
  // chart container becomes content-driven and its own ResizeObserver grows
  // it without bound (observed: internal canvas at 938x16506 and climbing).
  // Force a definite height chain inside the iframe document: the widget
  // area flexes to fill the container, the copyright row keeps its natural
  // height.
  private withDefensiveStyles(html: string): string {
    if (!html.includes("tradingview-widget-container")) return html;
    const style = `<style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
.tradingview-widget-container { height: 100% !important; display: flex !important; flex-direction: column !important; }
.tradingview-widget-container__widget { flex: 1 1 auto !important; min-height: 0 !important; height: auto !important; }
.tradingview-widget-copyright { flex: 0 0 auto !important; }
</style>`;
    if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${style}</head>`);
    if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (match) => `${match}${style}`);
    return style + html;
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
      canvasNode.classList.add("financial-canvas-card-note");
      if (markdownPreview) {
        markdownPreview.classList.add("financial-canvas-card-note");
      }
    }
  }
}
