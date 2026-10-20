// Custom tooltip replacing Obsidian's native setTooltip. The native manager
// computes the position once on show and never repositions, so any anchor
// movement leaves the tooltip behind (dragging the canvas toolbar while its
// 「拖拽移动工具栏」 tip is up, panning/zooming the canvas under a hovered
// card button, rebuilding a view with a tip open). It also defaults to a
// ~1000ms delay, only clamps (never flips) at viewport edges, and never
// appears on keyboard focus.
//
// Here one shared element lives under the anchor's own document's <html>
// with fixed positioning (outside any transformed body subtree — same
// reasoning as info-desc.ts) and is re-anchored every animation frame while
// visible: it tracks the anchor through toolbar drags and canvas pan/zoom,
// and disappears the moment the anchor disconnects (view rebuilds).
// Everything goes through the anchor's ownerDocument/defaultView — plugin
// code runs in the main window's JS realm, but anchors (settings tab,
// canvas) can live in a popout OS window with its own document, viewport
// and event stream; the global document/window would paint the tooltip in
// the wrong window. Listeners are attached per window on first use.
// Interaction follows the W05–W09 UI spec: 400ms hover delay (instant
// re-show when hopping between elements), 160ms fade + 3px rise on entry
// (styles.css; suppressed under prefers-reduced-motion), immediate hide on
// leave / pointerdown / Escape, edge flip when the preferred side has no
// room, and focusin support for keyboard users.
//
// Like Obsidian's setTooltip, ours writes aria-label — which the native
// manager also reacts to (it delegates pointerover on body, bubble phase).
// The capture-phase pointerover/pointerout filter keeps events for managed
// elements from ever reaching it, so the two never double-render.

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface FcTooltipOptions {
  placement?: TooltipPlacement;
  delay?: number;
}

const TOOLTIP_ATTR = "data-fc-tooltip";
const PLACEMENT_ATTR = "data-fc-tooltip-placement";
const DELAY_ATTR = "data-fc-tooltip-delay";
// Reload handoff: a previous copy of this module (plugin reload) stores its
// detach on every window it attached to; the new copy invokes and replaces it.
const HANDOFF_KEY = "__fcTooltipDetach";

const DEFAULT_DELAY_MS = 400;
// Moving onto another anchor right after a hide re-shows instantly (same
// convention as the native manager).
const REOPEN_WINDOW_MS = 100;
const GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 6;

let tipEl: HTMLElement | null = null;
let anchorEl: HTMLElement | null = null;
let pendingEl: HTMLElement | null = null;
let showTimer: number | undefined;
let lastHideAt = 0;
// rAF handle + the window it was scheduled on (a popout's rAF stops when the
// window closes; the next show re-schedules on the new anchor's window).
let rafView: Window | null = null;
let rafId: number | undefined;
let lastRect: { top: number; left: number; width: number; height: number } | null = null;
const attachedWindows = new Set<Window>();

// Drop-in replacement for Obsidian's setTooltip: the anchor carries the text
// in an attribute, so re-calling with new text updates even a live tooltip.
export function setTooltip(el: HTMLElement, text: string | null | undefined, options?: FcTooltipOptions): void {
  if (!text) {
    el.removeAttribute(TOOLTIP_ATTR);
    el.removeAttribute(PLACEMENT_ATTR);
    el.removeAttribute(DELAY_ATTR);
    if (anchorEl === el || pendingEl === el) hide();
    return;
  }
  const view = el.ownerDocument.defaultView;
  if (view) ensureWindowListeners(view);
  el.setAttribute(TOOLTIP_ATTR, text);
  // Same contract as the native setTooltip: the label doubles as the
  // accessible name (the capture filter keeps the native manager away).
  el.setAttribute("aria-label", text);
  if (options?.placement) el.setAttribute(PLACEMENT_ATTR, options.placement);
  if (options?.delay !== undefined) el.setAttribute(DELAY_ATTR, String(options.delay));
  // Text updated while the tooltip is already showing (e.g. the toolbar logo
  // toggling 展开/折叠) refreshes in place.
  if (anchorEl === el && tipEl) {
    tipEl.textContent = text;
    position();
  }
}

// Tears down the shared tooltip and every window's listeners (plugin unload).
export function detachTooltipManager(): void {
  hide();
  detachAllWindows();
}

function ensureWindowListeners(view: Window): void {
  if (attachedWindows.has(view)) return;
  attachedWindows.add(view);
  (view as unknown as Record<string, (() => void) | undefined>)[HANDOFF_KEY]?.();
  // Drop any tooltip element a previous (reloaded) copy left behind.
  for (const orphan of Array.from(view.document.querySelectorAll(".fc-tooltip"))) orphan.remove();

  view.addEventListener("pointerover", onPointerOver, true);
  view.addEventListener("pointerout", onPointerOut, true);
  view.addEventListener("pointerdown", onPointerDown, true);
  view.addEventListener("focusin", onFocusIn, true);
  view.addEventListener("focusout", onFocusOut, true);
  view.addEventListener("keydown", onKeyDown, true);
  (view as unknown as Record<string, (() => void) | undefined>)[HANDOFF_KEY] = detachAllWindows;
}

function detachAllWindows(): void {
  for (const view of attachedWindows) {
    view.removeEventListener("pointerover", onPointerOver, true);
    view.removeEventListener("pointerout", onPointerOut, true);
    view.removeEventListener("pointerdown", onPointerDown, true);
    view.removeEventListener("focusin", onFocusIn, true);
    view.removeEventListener("focusout", onFocusOut, true);
    view.removeEventListener("keydown", onKeyDown, true);
  }
  attachedWindows.clear();
}

// Anchor lookup without instanceof: popout-window elements belong to a
// different realm and fail the main window's HTMLElement/Node checks.
function findAnchor(target: EventTarget | null): HTMLElement | null {
  if (!target || typeof (target as HTMLElement).closest !== "function") return null;
  const el = target as HTMLElement;
  // ⓘ field-description icons run their own pinned tip (info-desc.ts); the
  // surrounding row may carry a tooltip of its own (settings.ts 对比卡相关系数),
  // so never let the icon resolve to an outer anchor.
  if (el.closest(".fc-info-icon")) return null;
  return el.closest(`[${TOOLTIP_ATTR}]`);
}

function containsNode(el: HTMLElement, node: EventTarget | null): boolean {
  return !!node && typeof (node as Node).nodeType === "number" && el.contains(node as Node);
}

function onPointerOver(event: PointerEvent): void {
  const next = findAnchor(event.target);
  if (!next) return;
  // Shield the native tooltip manager (body, bubble phase) from anchors we
  // manage — their aria-label would otherwise summon a second tooltip.
  event.stopPropagation();
  if (next === anchorEl || next === pendingEl) return;
  if (containsNode(next, event.relatedTarget)) return;
  scheduleShow(next);
}

function onPointerOut(event: PointerEvent): void {
  const from = findAnchor(event.target);
  if (!from) return;
  event.stopPropagation();
  if (containsNode(from, event.relatedTarget)) return;
  if (from === anchorEl || from === pendingEl) hide();
}

// Any press dismisses: covers clicks (native hides on pointerup; earlier is
// safer) and, critically, the toolbar drag handle — without this the tip
// stays pinned at the pre-drag position for the whole gesture.
function onPointerDown(): void {
  if (anchorEl || pendingEl) hide();
}

function onFocusIn(event: FocusEvent): void {
  const next = findAnchor(event.target);
  if (!next) return;
  // Focus following a click: the pointer is already over the element and
  // pointerdown just hid the tip — re-showing now would fight the click.
  // Keyboard focus (no hover) still gets the tooltip.
  if (next.matches(":hover")) return;
  scheduleShow(next);
}

function onFocusOut(event: FocusEvent): void {
  if (findAnchor(event.target)) hide();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape" && (anchorEl || pendingEl)) hide();
}

function scheduleShow(next: HTMLElement): void {
  cancelShowTimer();
  pendingEl = next;
  const custom = Number(next.getAttribute(DELAY_ATTR));
  const base = Number.isFinite(custom) && custom > 0 ? custom : DEFAULT_DELAY_MS;
  const delay = Date.now() - lastHideAt < REOPEN_WINDOW_MS ? 0 : base;
  showTimer = window.setTimeout(() => show(next), delay);
}

function show(next: HTMLElement): void {
  hide();
  if (!next.isConnected) return;
  const doc = next.ownerDocument;
  const view = doc.defaultView ?? window;
  anchorEl = next;
  tipEl = doc.createElement("div");
  tipEl.className = "fc-tooltip";
  tipEl.setAttribute("role", "tooltip");
  tipEl.textContent = next.getAttribute(TOOLTIP_ATTR);
  // The tip lives under <html>, outside body, so theme variables scoped to
  // body (Obsidian's --background-*, our --fc-*) would not reach it; copy
  // them over on every show (theme can switch between hovers).
  const bodyStyle = view.getComputedStyle(doc.body);
  for (let i = 0; i < bodyStyle.length; i += 1) {
    const property = bodyStyle.item(i);
    if (property.startsWith("--")) {
      tipEl.style.setProperty(property, bodyStyle.getPropertyValue(property));
    }
  }
  doc.documentElement.appendChild(tipEl);
  lastRect = null;
  position();
  // Enter transition: start hidden, promote on the next frame.
  tipEl.classList.remove("is-visible");
  view.requestAnimationFrame(() => tipEl?.classList.add("is-visible"));
  rafView = view;
  rafId = view.requestAnimationFrame(track);
}

// Re-anchor every frame while visible. This is what kills the drift the
// native manager had: toolbar drags, canvas pan/zoom and layout shifts all
// move the anchor rect, and an anchor removed by a re-render hides the tip
// instead of leaving it stranded.
function track(): void {
  if (!anchorEl || !tipEl) return;
  if (!anchorEl.isConnected) {
    hide();
    return;
  }
  const rect = anchorEl.getBoundingClientRect();
  if (
    !lastRect ||
    rect.top !== lastRect.top ||
    rect.left !== lastRect.left ||
    rect.width !== lastRect.width ||
    rect.height !== lastRect.height
  ) {
    position();
  }
  const view = rafView ?? anchorEl.ownerDocument.defaultView ?? window;
  rafView = view;
  rafId = view.requestAnimationFrame(track);
}

function position(): void {
  if (!tipEl || !anchorEl) return;
  const view = anchorEl.ownerDocument.defaultView ?? window;
  const rect = anchorEl.getBoundingClientRect();
  lastRect = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };

  const preferred = (anchorEl.getAttribute(PLACEMENT_ATTR) as TooltipPlacement | null) ?? "bottom";
  const vw = view.innerWidth;
  const vh = view.innerHeight;
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;

  const opposite: Record<TooltipPlacement, TooltipPlacement> = {
    top: "bottom",
    bottom: "top",
    left: "right",
    right: "left",
  };
  const candidates: TooltipPlacement[] = [
    preferred,
    opposite[preferred],
    ...(["top", "bottom", "right", "left"] as TooltipPlacement[]).filter(
      (p) => p !== preferred && p !== opposite[preferred]
    ),
  ];

  const compute = (p: TooltipPlacement): { x: number; y: number } => {
    switch (p) {
      case "top":
        return { x: rect.left + rect.width / 2 - w / 2, y: rect.top - h - GAP_PX };
      case "bottom":
        return { x: rect.left + rect.width / 2 - w / 2, y: rect.bottom + GAP_PX };
      case "left":
        return { x: rect.left - w - GAP_PX, y: rect.top + rect.height / 2 - h / 2 };
      case "right":
        return { x: rect.right + GAP_PX, y: rect.top + rect.height / 2 - h / 2 };
    }
  };
  // Only the axis the placement hangs on decides acceptance; the cross axis
  // is always clamped afterwards (a long centered tip must not force a flip).
  const fits = (p: TooltipPlacement, x: number, y: number): boolean => {
    if (p === "top") return y >= VIEWPORT_MARGIN_PX;
    if (p === "bottom") return y + h <= vh - VIEWPORT_MARGIN_PX;
    if (p === "left") return x >= VIEWPORT_MARGIN_PX;
    return x + w <= vw - VIEWPORT_MARGIN_PX;
  };
  const clamp = (x: number, y: number): { x: number; y: number } => ({
    x: Math.max(VIEWPORT_MARGIN_PX, Math.min(x, vw - VIEWPORT_MARGIN_PX - w)),
    y: Math.max(VIEWPORT_MARGIN_PX, Math.min(y, vh - VIEWPORT_MARGIN_PX - h)),
  });

  let chosen = preferred;
  let pos = compute(preferred);
  for (const candidate of candidates) {
    const candidatePos = compute(candidate);
    if (fits(candidate, candidatePos.x, candidatePos.y)) {
      chosen = candidate;
      pos = candidatePos;
      break;
    }
  }
  const { x, y } = clamp(pos.x, pos.y);
  tipEl.style.left = `${x}px`;
  tipEl.style.top = `${y}px`;
  tipEl.setAttribute("data-fc-placement", chosen);
}

function hide(): void {
  cancelShowTimer();
  pendingEl = null;
  if (rafId !== undefined && rafView) {
    rafView.cancelAnimationFrame(rafId);
  }
  rafId = undefined;
  rafView = null;
  if (tipEl) tipEl.remove();
  if (anchorEl) lastHideAt = Date.now();
  anchorEl = null;
  lastRect = null;
}

function cancelShowTimer(): void {
  if (showTimer !== undefined) {
    window.clearTimeout(showTimer);
    showTimer = undefined;
  }
}
