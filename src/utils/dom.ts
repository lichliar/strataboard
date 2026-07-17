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
