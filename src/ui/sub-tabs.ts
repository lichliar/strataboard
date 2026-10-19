import { t } from "../i18n";

// Shared sub-tab bar for the card edit modals: a .fc-subtabs button row plus
// one page <div> per tab, with only the active page visible. Labels are
// Chinese source strings, wrapped with t() when the buttons render.
// Used by the unified / overlay / spread card edit modals.

export interface SubTabDef<T extends string = string> {
  id: T;
  /** Chinese label; wrapped with t() at render time. */
  label: string;
}

export interface SubTabsHandle<T extends string> {
  /** Page element of a tab — render that tab's content into it. */
  page(id: T): HTMLElement;
  /** Currently active tab id. */
  readonly active: T;
  /** Switch the active tab programmatically. */
  setActive(id: T): void;
}

export function createSubTabs<T extends string>(
  containerEl: HTMLElement,
  tabs: SubTabDef<T>[],
  opts?: {
    /** Tab active on first render; defaults to the first tab. */
    initial?: T;
    /** Called after the active page is applied, including the initial one. */
    onActivate?: (id: T) => void;
  }
): SubTabsHandle<T> {
  let active: T = opts?.initial && tabs.some((tab) => tab.id === opts.initial) ? opts.initial : tabs[0].id;

  const tabBar = containerEl.createDiv("fc-subtabs");
  const pagesEl = containerEl.createDiv();
  const pages = new Map<T, HTMLElement>();
  for (const tab of tabs) pages.set(tab.id, pagesEl.createDiv());

  const applyActive = () => {
    for (const tab of tabs) {
      pages.get(tab.id)!.toggleClass("fc-hidden", tab.id !== active);
    }
    tabBar.querySelectorAll(".fc-subtab").forEach((el, i) => {
      el.classList.toggle("is-active", tabs[i].id === active);
    });
    opts?.onActivate?.(active);
  };
  tabs.forEach((tab) => {
    const btn = tabBar.createEl("button", { text: t(tab.label), cls: "fc-subtab" });
    btn.addEventListener("click", () => {
      active = tab.id;
      applyActive();
    });
  });
  applyActive();

  return {
    page: (id) => pages.get(id)!,
    get active() {
      return active;
    },
    setActive(id) {
      if (!pages.has(id)) return;
      active = id;
      applyActive();
    },
  };
}
