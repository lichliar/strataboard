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

    // Defer assigning src until the iframe is attached and laid out at its
    // final size. Obsidian runs code block processors while the element is
    // still detached; in Canvas the iframe is resized once the canvas-node
    // CSS chain kicks in. TradingView measures its container at init and
    // does not always recover from a post-init resize, which collapsed the
    // chart area (header + "Charts by TradingView" squeezed at the top).
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
