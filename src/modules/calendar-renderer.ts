import { App, MarkdownRenderChild, TFile } from "obsidian";
import type { ParsedCardSpec } from "../types";
import { formatIsoDate } from "../utils/date";
import { onAttached } from "../utils/dom";
import {
  getDailyNote,
  openOrCreateDailyNote,
  resolveDailyNotesConfig,
  type DailyNotesConfig,
} from "./daily-notes";

interface CalendarDisplaySettings {
  calendarExcerptFontSize: number;
  calendarDayFontSize: number;
  calendarExcerptLineHeight: number;
  calendarExcerptMaxLines: number;
}

interface CalendarRendererOptions {
  app: App;
  spec: ParsedCardSpec;
  getDailyNotesSettings: () => { dailyNotesFolder: string; dailyNotesFormat: string };
  getDisplaySettings: () => CalendarDisplaySettings;
  // Opens the calendar edit modal (月宫格选择器); the title click delegates
  // to it instead of editing inline.
  onOpenEditor?: () => void;
}

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

export class CalendarRenderer extends MarkdownRenderChild {
  private app: App;
  private spec: ParsedCardSpec;
  private getDailyNotesSettings: () => { dailyNotesFolder: string; dailyNotesFormat: string };
  private getDisplaySettings: () => CalendarDisplaySettings;
  private onOpenEditor?: () => void;
  private viewYear: number;
  private viewMonth: number; // 0-based
  private gridEl: HTMLElement | null = null;
  private refreshToken = 0;
  private nodeContentEl: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(containerEl: HTMLElement, options: CalendarRendererOptions) {
    super(containerEl);
    this.app = options.app;
    this.spec = options.spec;
    this.getDailyNotesSettings = options.getDailyNotesSettings;
    this.getDisplaySettings = options.getDisplaySettings;
    this.onOpenEditor = options.onOpenEditor;

    const initial = parseInitialMonth(options.spec.calendarMonth) ?? new Date();
    this.viewYear = initial.getFullYear();
    this.viewMonth = initial.getMonth();
  }

  onload() {
    this.render();
    onAttached(this.containerEl, () => this.attachFillObserver());

    // Note edits matter now that excerpts are shown, so modify is included.
    const onChange = (file: unknown) => {
      if (file instanceof TFile && file.extension === "md") {
        void this.refreshMarkers();
      }
    };
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(this.app.vault.on("rename", onChange));
    this.registerEvent(this.app.vault.on("modify", onChange));
  }

  private config(): DailyNotesConfig {
    const s = this.getDailyNotesSettings();
    return resolveDailyNotesConfig(this.app, s.dailyNotesFolder, s.dailyNotesFormat);
  }

  private render() {
    this.containerEl.empty();
    this.containerEl.addClass("financial-calendar");
    // Calendar cards always render on the hermes dark palette.
    this.containerEl.addClass("fc-hermes");
    if (this.spec.height != null) {
      this.containerEl.style.minHeight = `${this.spec.height}px`;
    }

    // Display tuning comes from plugin settings; CSS consumes these vars.
    const display = this.getDisplaySettings();
    this.containerEl.style.setProperty("--fc-excerpt-font-size", `${display.calendarExcerptFontSize}px`);
    this.containerEl.style.setProperty("--fc-day-font-size", `${display.calendarDayFontSize}px`);
    this.containerEl.style.setProperty("--fc-excerpt-line-height", String(display.calendarExcerptLineHeight));
    this.containerEl.style.setProperty("--fc-excerpt-max-lines", String(display.calendarExcerptMaxLines));

    const header = this.containerEl.createDiv({ cls: "financial-calendar-header" });
    const prevBtn = header.createEl("button", { text: "‹", cls: "financial-calendar-nav" });
    prevBtn.setAttribute("aria-label", "上个月");
    prevBtn.addEventListener("click", () => this.shiftMonth(-1));

    this.renderTitle(header);

    const todayBtn = header.createEl("button", { text: "今天", cls: "financial-calendar-today" });
    todayBtn.addEventListener("click", () => {
      const now = new Date();
      this.viewYear = now.getFullYear();
      this.viewMonth = now.getMonth();
      this.render();
    });

    const nextBtn = header.createEl("button", { text: "›", cls: "financial-calendar-nav" });
    nextBtn.setAttribute("aria-label", "下个月");
    nextBtn.addEventListener("click", () => this.shiftMonth(1));

    const weekdays = this.containerEl.createDiv({ cls: "financial-calendar-weekdays" });
    for (const label of WEEKDAY_LABELS) {
      weekdays.createDiv({ cls: "financial-calendar-weekday", text: label });
    }

    this.gridEl = this.containerEl.createDiv({ cls: "financial-calendar-grid" });
    this.renderDays();
    void this.refreshMarkers();
    this.fillNodeHeight();
  }

  // Inside a Canvas node the grid should fill the node vertically instead of
  // clustering at the top; outside Canvas (reading view) it keeps its
  // natural height.
  private attachFillObserver() {
    let el: HTMLElement | null = this.containerEl.parentElement;
    while (el && !el.classList.contains("canvas-node-content")) {
      el = el.parentElement;
    }
    if (!el) return;

    this.nodeContentEl = el;
    this.resizeObserver = new ResizeObserver(() => this.fillNodeHeight());
    this.resizeObserver.observe(el);
    this.register(() => this.resizeObserver?.disconnect());
    this.fillNodeHeight();
  }

  private fillNodeHeight() {
    if (!this.nodeContentEl || !this.gridEl) return;
    const header = this.containerEl.querySelector<HTMLElement>(".financial-calendar-header");
    const weekdays = this.containerEl.querySelector<HTMLElement>(".financial-calendar-weekdays");
    const chrome =
      (header?.offsetHeight ?? 0) +
      (weekdays?.offsetHeight ?? 0) +
      16 + // root column gaps
      16; // root vertical padding
    const available = this.nodeContentEl.clientHeight - chrome;
    this.gridEl.style.height = `${Math.max(available, 160)}px`;
  }

  // The title doubles as the editor entry: clicking it opens the calendar
  // edit modal (月宫格选择器), which persists 月份/高度 back to the card.
  private renderTitle(header: HTMLElement) {
    const title = header.createDiv({
      cls: "financial-calendar-title",
      text: `${this.viewYear}年${this.viewMonth + 1}月`,
    });
    title.title = "点击编辑日历";
    title.addEventListener("click", () => {
      this.onOpenEditor?.();
    });
  }

  private renderDays() {
    if (!this.gridEl) return;
    this.gridEl.empty();

    const todayIso = formatIsoDate(new Date());
    const firstOfMonth = new Date(this.viewYear, this.viewMonth, 1);
    // Convert JS Sunday-first weekday to Monday-first offset.
    const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;
    const daysInMonth = new Date(this.viewYear, this.viewMonth + 1, 0).getDate();
    const cellCount = Math.ceil((leadingBlanks + daysInMonth) / 7) * 7;

    for (let i = 0; i < cellCount; i++) {
      const date = new Date(this.viewYear, this.viewMonth, i - leadingBlanks + 1);
      const inMonth = date.getMonth() === this.viewMonth;
      const iso = formatIsoDate(date);

      const cell = this.gridEl.createDiv({ cls: "financial-calendar-day" });
      cell.dataset.date = iso;
      cell.createSpan({ cls: "financial-calendar-day-number", text: String(date.getDate()) });

      const dayOfWeek = date.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        cell.addClass("is-weekend");
      }

      if (!inMonth) {
        cell.addClass("is-outside");
        // Clicking a neighbouring month cell just navigates there.
        cell.addEventListener("click", () => {
          this.viewYear = date.getFullYear();
          this.viewMonth = date.getMonth();
          this.render();
        });
        continue;
      }

      if (iso === todayIso) {
        cell.addClass("is-today");
      }

      cell.addEventListener("click", () => {
        void openOrCreateDailyNote(this.app, this.config(), date);
      });
    }
  }

  // Reads each visible day's note (cachedRead) and paints the marker plus a
  // short excerpt into the cell. Async: a token guards against late results
  // landing on a grid that has since been re-rendered (month navigation).
  private async refreshMarkers() {
    const grid = this.gridEl;
    if (!grid) return;
    const token = ++this.refreshToken;
    const config = this.config();

    const cells = (Array.from(grid.children) as HTMLElement[]).filter(
      (cell) => cell.dataset.date && !cell.classList.contains("is-outside")
    );

    await Promise.all(
      cells.map(async (cell) => {
        const date = parseIsoDate(cell.dataset.date!);
        const note = getDailyNote(this.app, config, date);
        const excerpt = note ? extractExcerpt(await this.app.vault.cachedRead(note)) : "";

        if (token !== this.refreshToken || !cell.isConnected) return;

        cell.toggleClass("has-note", note !== null);
        cell.title = note ? note.path : "";

        let excerptEl = cell.querySelector<HTMLElement>(".financial-calendar-day-excerpt");
        if (excerpt) {
          if (!excerptEl) {
            excerptEl = cell.createDiv({ cls: "financial-calendar-day-excerpt" });
          }
          excerptEl.textContent = excerpt;
        } else if (excerptEl) {
          excerptEl.remove();
        }
      })
    );
  }

  private shiftMonth(delta: number) {
    const shifted = new Date(this.viewYear, this.viewMonth + delta, 1);
    this.viewYear = shifted.getFullYear();
    this.viewMonth = shifted.getMonth();
    this.render();
  }
}

function parseInitialMonth(month: string | undefined): Date | null {
  if (!month) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  return new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, 1);
}

function parseIsoDate(iso: string): Date {
  return new Date(
    parseInt(iso.slice(0, 4), 10),
    parseInt(iso.slice(5, 7), 10) - 1,
    parseInt(iso.slice(8, 10), 10)
  );
}

const EXCERPT_MAX_LENGTH = 80;

// Condenses a note into a one-line preview for the day cell: frontmatter and
// blank lines dropped, lightweight markdown markers (headings, list bullets,
// quotes) stripped.
function extractExcerpt(content: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const text = body
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/^>\s?/, "")
    )
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > EXCERPT_MAX_LENGTH ? `${text.slice(0, EXCERPT_MAX_LENGTH)}…` : text;
}
