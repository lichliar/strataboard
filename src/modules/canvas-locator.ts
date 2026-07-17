export interface CanvasNodeInfo {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  filePath?: string;
}

export class CanvasLocator {
  static findCanvasNode(element: HTMLElement): CanvasNodeInfo | null {
    // Traverse up to find .canvas-node container
    let el: HTMLElement | null = element;
    while (el && !el.classList.contains("canvas-node")) {
      el = el.parentElement;
    }

    if (!el) return null;

    const id = el.getAttribute("data-id") || "";
    const filePath = el.querySelector(".canvas-node-container")?.getAttribute("data-path") || undefined;

    // Try to read position from inline style or data attributes
    const style = el.getAttribute("style") || "";
    const x = this.extractStyleValue(style, "left") || this.extractStyleValue(style, "translate-x") || 0;
    const y = this.extractStyleValue(style, "top") || this.extractStyleValue(style, "translate-y") || 0;
    const width = el.offsetWidth || this.extractStyleValue(style, "width") || 0;
    const height = el.offsetHeight || this.extractStyleValue(style, "height") || 0;

    return { id, x, y, width, height, filePath };
  }

  private static extractStyleValue(style: string, prop: string): number {
    const regex = new RegExp(`${prop}\\s*:\\s*([\\d.-]+)px?`);
    const match = style.match(regex);
    return match ? parseFloat(match[1]) : 0;
  }
}
