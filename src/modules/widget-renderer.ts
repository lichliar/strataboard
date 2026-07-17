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

    // Pin the iframe to a definite pixel height instead of relying on
    // height: 100% (a percentage resolves to the intrinsic 150px wherever an
    // ancestor lacks a definite height). Which height depends on context:
    // - Canvas reading view: the container's real height, so the widget
    //   fills the card and follows node resizes (resizing the iframe element
    //   resizes its viewport, triggering the widget's own resize handling).
    // - Everywhere else (regular notes, the canvas node's live-preview
    //   editor): the fixed height from settings. The container there is
    //   content-driven, so echoing its measured height back into the iframe
    //   would form a feedback loop that grows the chart without bound.
    let assigned = false;
    const assignSrc = () => {
      if (assigned || !this.iframe) return;
      assigned = true;
      this.iframe.src = src;
    };

    this.resizeObserver = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.height ?? 0;
      if (measured <= 0 || !this.iframe) return;
      const height = this.isInCanvasReadingView() ? measured : this.height;
      this.iframe.style.height = `${Math.round(height)}px`;
      // Load the widget only once the iframe has a real, final size.
      requestAnimationFrame(assignSrc);
    });
    this.resizeObserver.observe(this.containerEl);

    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());
    // Fallback: if the element never gets a size, still load the widget.
    setTimeout(assignSrc, 2000);
  }

  private isInCanvasReadingView(): boolean {
    let el: HTMLElement | null = this.containerEl;
    while (el) {
      if (el.classList.contains("canvas-node")) {
        return !el.classList.contains("is-editing");
      }
      el = el.parentElement;
    }
    return false;
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
