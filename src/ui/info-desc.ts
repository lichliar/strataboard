import { setIcon } from "obsidian";

// Hover delay before the tooltip pops up (ms); clicks show it immediately.
const HOVER_DELAY_MS = 100;
// Grace period before hiding after the pointer leaves the icon, so the user
// can move onto the tooltip text itself without losing it.
const HIDE_DELAY_MS = 150;

// Collapses a rendered settings container's always-visible field
// descriptions (.setting-item-description) into an info icon at the right of
// the field name, keeping settings pages and setup modals compact. The
// explanation pops up as the same floating tooltip on hover (after a short
// delay) and on click (pinned until another click or an outside click).
//
// The tooltip element lives on document.body with fixed positioning — being
// a child of the icon proved fragile inside scrolling/transformed modal
// containers (clipped by overflow, or never painted). The tradeoff is
// explicit cleanup: each pass first drops tooltips whose owner icon is gone
// (the container re-rendered while a tip was open), and the outside-click
// listener removes itself once its icon disconnects.
//
// Rows whose description carries content rather than explanation (插件版本,
// data-source rows, indicator-instance headers) opt out via the
// .fc-keep-desc class; source-group headers (.fc-source-group-header) are
// skipped as well. Called after render by the settings tab, the source setup
// modals and the card edit modal's 图层 page. Descriptions here are plain
// text everywhere, so a textContent
// tooltip loses nothing.
export function applyInfoDescs(root: HTMLElement): void {
  // The root may live in a popout OS window (settings opened in its own
  // window): all DOM work goes through root.ownerDocument — the global
  // document is the main window and would paint tips in the wrong place.
  const doc = root.ownerDocument;
  for (const orphan of Array.from(doc.querySelectorAll<HTMLElement>(".fc-info-tip"))) {
    const owner = (orphan as unknown as { fcOwner?: HTMLElement }).fcOwner;
    if (!owner || !owner.isConnected) orphan.remove();
  }

  for (const item of Array.from(root.querySelectorAll<HTMLElement>(".setting-item"))) {
    if (item.classList.contains("fc-keep-desc") || item.classList.contains("fc-source-group-header")) continue;
    const nameEl = item.querySelector<HTMLElement>(".setting-item-name");
    const descEl = item.querySelector<HTMLElement>(".setting-item-description");
    const text = descEl?.textContent?.trim();
    if (!nameEl || !descEl || !text) continue;

    const icon = nameEl.createSpan({ cls: "fc-info-icon" });
    setIcon(icon, "info");
    descEl.empty();
    descEl.addClass("fc-hidden");

    let tipEl: HTMLElement | null = null;
    let showTimer: number | undefined;
    let hideTimer: number | undefined;
    let pinned = false;

    const clearTimers = () => {
      if (showTimer !== undefined) {
        window.clearTimeout(showTimer);
        showTimer = undefined;
      }
      if (hideTimer !== undefined) {
        window.clearTimeout(hideTimer);
        hideTimer = undefined;
      }
    };
    const onDocClick = (e: MouseEvent) => {
      if (!icon.isConnected) {
        doc.removeEventListener("click", onDocClick, true);
        return;
      }
      if (e.target instanceof Node && !icon.contains(e.target) && !(tipEl && tipEl.contains(e.target))) hide();
    };
    const onScroll = () => {
      if (!pinned) hide();
    };
    const show = () => {
      clearTimers();
      // One tooltip at a time: any other tip (pinned elsewhere, or orphaned
      // by a re-render) goes away when a new one shows.
      for (const other of Array.from(doc.querySelectorAll<HTMLElement>(".fc-info-tip"))) {
        if (other !== tipEl) other.remove();
      }
      if (!tipEl) {
        // Obsidian can transform the body while a settings window/modal is
        // open. A fixed descendant of that transformed tree no longer uses
        // viewport coordinates, so keep the tip under <html>, outside the
        // transformed body subtree — and in the icon's own document, since a
        // popout settings window is a different document/viewport entirely.
        tipEl = doc.createElement("div");
        tipEl.className = "fc-info-tip";
        tipEl.textContent = text;
        // Theme variables are commonly scoped to `body.theme-*`; copy the
        // computed custom properties onto the portal so moving it outside
        // body does not lose Obsidian's colors, fonts, or layer tokens.
        const view = doc.defaultView ?? window;
        const bodyStyle = view.getComputedStyle(doc.body);
        for (let i = 0; i < bodyStyle.length; i += 1) {
          const property = bodyStyle.item(i);
          if (property.startsWith("--")) {
            tipEl.style.setProperty(property, bodyStyle.getPropertyValue(property));
          }
        }
        doc.documentElement.appendChild(tipEl);
        (tipEl as unknown as { fcOwner: HTMLElement }).fcOwner = icon;
        // Moving onto the tooltip keeps it open (text selection, reading).
        tipEl.addEventListener("mouseenter", clearTimers);
        tipEl.addEventListener("mouseleave", () => {
          if (!pinned) scheduleHide();
        });
      }
      const rect = icon.getBoundingClientRect();
      tipEl.style.top = `${rect.bottom + 6}px`;
      // Clamp against the right viewport edge (max-width is 300px).
      const viewWidth = (doc.defaultView ?? window).innerWidth;
      tipEl.style.left = `${Math.max(8, Math.min(rect.left, viewWidth - 316))}px`;
      doc.addEventListener("scroll", onScroll, true);
    };
    const hide = () => {
      clearTimers();
      tipEl?.remove();
      tipEl = null;
      pinned = false;
      doc.removeEventListener("click", onDocClick, true);
      doc.removeEventListener("scroll", onScroll, true);
    };
    const scheduleHide = () => {
      hideTimer = window.setTimeout(hide, HIDE_DELAY_MS);
    };

    icon.addEventListener("mouseenter", () => {
      clearTimers();
      showTimer = window.setTimeout(show, HOVER_DELAY_MS);
    });
    icon.addEventListener("mouseleave", () => {
      clearTimers();
      if (!pinned && tipEl) scheduleHide();
    });
    icon.addEventListener("click", (e) => {
      // Never let the icon click bubble into a collapsible <summary> or any
      // container-level handler.
      e.preventDefault();
      e.stopPropagation();
      // Clicks on the tooltip text itself keep it open (text selection).
      if (tipEl && pinned) {
        hide();
        return;
      }
      show();
      pinned = true;
      doc.addEventListener("click", onDocClick, true);
    });
  }
}
