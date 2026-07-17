import type { ChartTheme } from "../types";

export function isDocumentDark(): boolean {
  return document.body.classList.contains("theme-dark");
}

export function resolveEffectiveTheme(theme: ChartTheme): "dark" | "light" {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return isDocumentDark() ? "dark" : "light";
}

export function watchThemeChange(callback: () => void): MutationObserver {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.attributeName === "class") {
        callback();
        return;
      }
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  return observer;
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
      requestAnimationFrame(tick);
    }
  };
  if (el.isConnected) {
    cb();
  } else {
    requestAnimationFrame(tick);
  }
}
