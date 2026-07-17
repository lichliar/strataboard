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
  private resizeObserver: ResizeObserver | null = null;

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
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
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

    // Pin the iframe to the container's real pixel height instead of relying
    // on height: 100%. A percentage height resolves to the iframe's intrinsic
    // 150px wherever an ancestor lacks a definite height (e.g. the canvas
    // node's live-preview editor, or the first frames before the canvas CSS
    // chain applies), and TradingView's embed script measures its container
    // once at init — so it ended up stuck in a header-only compact mode.
    // Explicit pixels are always definite, in every view. A resize of the
    // iframe element also resizes its viewport, firing the widget's own
    // window-resize handling when the user drags the canvas node.
    let assigned = false;
    const assignSrc = () => {
      if (assigned || !this.iframe) return;
      assigned = true;
      this.iframe.src = src;
    };

    this.resizeObserver = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      if (height <= 0 || !this.iframe) return;
      this.iframe.style.height = `${Math.round(height)}px`;
      // Load the widget only once the iframe has a real, final size.
      requestAnimationFrame(assignSrc);
    });
    this.resizeObserver.observe(this.containerEl);

    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());
    // Fallback: if the element never gets a size, still load the widget.
    setTimeout(assignSrc, 2000);
  }

  private resolveSrc(): string | null {
    if (this.spec.iframeUrl) {
      return this.spec.iframeUrl;
    }
    if (this.spec.widgetHtml) {
      return "data:text/html;charset=utf-8," + encodeURIComponent(this.spec.widgetHtml);
    }
    return null;
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
