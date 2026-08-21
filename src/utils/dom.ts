import type { ChartTheme } from "../types";

// "auto" = the plugin's own hermes dark theme (cards no longer follow the
// Obsidian theme); only an explicit per-card light/dark choice deviates.
export function resolveEffectiveTheme(theme: ChartTheme): "dark" | "light" {
  return theme === "light" ? "light" : "dark";
}

export function createContainer(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

/**
 * Runs cb once el is connected to the document. Obsidian runs markdown code
 * block processors while the element is still detached from the canvas node,
 * so ancestor lookups (e.g. finding the enclosing .canvas-node) done
 * synchronously in the processor silently miss. Retries for a few frames as
 * a safety net, then gives up — the CSS :has() fallbacks cover that case.
 */
export function onAttached(el: HTMLElement, cb: () => void, maxAttempts = 30): void {
  let attempts = 0;
  const tick = () => {
    if (el.isConnected) {
      cb();
      return;
    }
    attempts++;
    if (attempts < maxAttempts) {
      window.requestAnimationFrame(tick);
    }
  };
  if (el.isConnected) {
    cb();
  } else {
    window.requestAnimationFrame(tick);
  }
}

/**
 * Safely inserts a trusted static SVG string into the DOM without innerHTML.
 * Parses via DOMParser and imports the <svg> root; silently no-ops on a
 * parse failure (parsererror document or missing root element).
 */
export function appendSvg(el: HTMLElement, svg: string): void {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const node = doc.documentElement;
  if (!node || node.tagName === "parsererror") return;
  el.appendChild(document.importNode(node, true));
}

/**
 * Obsidian's canvas zoom scales node content with a CSS transform.
 * getBoundingClientRect() is transform-aware (screen px) while a chart's
 * coordinate system is layout px, and lightweight-charts computes
 * localX = clientX - rect.left with no zoom correction — so under a zoomed
 * canvas every mouse interaction (crosshair, drag-pan, axis drag) lands at
 * zoom× the right position. These helpers correct coordinates at the plugin
 * layer; the library itself is untouched.
 */

// Mouse position in el's layout-px coordinate system (zoom-corrected).
export function toLayoutPoint(el: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  const zoomX = el.clientWidth > 0 ? rect.width / el.clientWidth : 1;
  const zoomY = el.clientHeight > 0 ? rect.height / el.clientHeight : zoomX;
  return { x: (clientX - rect.left) / zoomX, y: (clientY - rect.top) / zoomY };
}

const FIXED_EVENT = "__fcZoomFixed";
const MOUSE_EVENTS = [
  "mousedown",
  "mousemove",
  "mouseup",
  "click",
  "dblclick",
  "mouseover",
  "mouseout",
  "mouseenter",
  "mouseleave",
];

// Capture-phase mouse corrector for a chart container: events whose target
// sits inside a CSS-scaled subtree are re-dispatched with zoom-corrected
// coordinates before the chart library sees them. No-op at 100% zoom.
// Returns the uninstall function.
export function installZoomEventFix(containerEl: HTMLElement): () => void {
  const handler = (event: MouseEvent) => {
    if ((event as unknown as Record<string, boolean>)[FIXED_EVENT]) return;
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.getBoundingClientRect !== "function") return;
    const rect = target.getBoundingClientRect();
    const zoomX = target.clientWidth > 0 ? rect.width / target.clientWidth : 1;
    const zoomY = target.clientHeight > 0 ? rect.height / target.clientHeight : zoomX;
    if (Math.abs(zoomX - 1) < 0.001 && Math.abs(zoomY - 1) < 0.001) return;
    event.stopImmediatePropagation();
    const fixed = new MouseEvent(event.type, {
      clientX: rect.left + (event.clientX - rect.left) / zoomX,
      clientY: rect.top + (event.clientY - rect.top) / zoomY,
      screenX: event.screenX,
      screenY: event.screenY,
      button: event.button,
      buttons: event.buttons,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      bubbles: event.bubbles,
      cancelable: true,
      view: window,
    });
    (fixed as unknown as Record<string, boolean>)[FIXED_EVENT] = true;
    target.dispatchEvent(fixed);
  };
  for (const type of MOUSE_EVENTS) {
    containerEl.addEventListener(type, handler as EventListener, true);
  }
  return () => {
    for (const type of MOUSE_EVENTS) {
      containerEl.removeEventListener(type, handler as EventListener, true);
    }
  };
}
