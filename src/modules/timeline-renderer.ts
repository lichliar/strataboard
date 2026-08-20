import * as yaml from "js-yaml";
import { App, ItemView, MarkdownRenderChild } from "obsidian";
import { formatIsoDate } from "../utils/date";
import { onAttached } from "../utils/dom";

export type TimelineUnit = "day" | "week" | "month" | "quarter" | "year";

export interface TimelineSpec {
  start: Date;
  // null means "auto": the ruler always ends at today and grows over time.
  end: Date | null;
  unit: TimelineUnit;
}

export type TimelineParseResult = { ok: true; spec: TimelineSpec } | { ok: false; error: string };

// Card files are named from their date range; the caller resolves an auto
// end to today at naming time (rollover alone never renames).
export function timelineCardFileName(start: string, resolvedEnd: string): string {
  return `时间线${start}～${resolvedEnd}.md`;
}

interface TimelineRendererOptions {
  app: App;
  spec: TimelineSpec;
  getFontSize: () => number;
}

const VALID_UNITS: TimelineUnit[] = ["day", "week", "month", "quarter", "year"];
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RESIZE_DEBOUNCE_MS = 120;
// Horizontal breathing room on both ends of the ruler. Single source of
// truth: applied as inline padding on the ruler element, so ticks, labels
// and the baseline (all absolutely positioned against the ruler's padding
// box) are inset automatically and styles.css never repeats the value.
const RULER_PADDING_PX = 24;
// The rollover check only compares two date strings, so a one-minute
// cadence is cheap and keeps the "today" marker accurate around midnight.
const ROLLOVER_CHECK_MS = 60_000;

export function parseTimelineSpec(source: string): TimelineParseResult {
  let parsed: unknown;
  try {
    parsed = yaml.load(source.replace(/\r\n?/g, "\n"));
  } catch (e) {
    return { ok: false, error: `YAML 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "代码块必须是一个 YAML 对象。" };
  }

  const map = parsed as Record<string, unknown>;

  if (map.start === undefined || map.start === null) {
    return { ok: false, error: "缺少必填字段 start（格式 YYYY-MM-DD）。" };
  }
  const start = parseDateValue(map.start);
  if (!start) {
    return { ok: false, error: `无效的 start 日期：${String(map.start)}（应为 YYYY-MM-DD）。` };
  }

  let end: Date | null = null;
  if (map.end !== undefined && map.end !== null) {
    const parsedEnd = parseDateValue(map.end);
    if (!parsedEnd) {
      return { ok: false, error: `无效的 end 日期：${String(map.end)}（应为 YYYY-MM-DD，或留空表示自动到今天）。` };
    }
    end = parsedEnd;
  }
  if (end && end.getTime() < start.getTime()) {
    return { ok: false, error: "end 不能早于 start。" };
  }

  let unit: TimelineUnit = "day";
  if (map.unit !== undefined && map.unit !== null) {
    const raw = String(map.unit).trim();
    if (!VALID_UNITS.includes(raw as TimelineUnit)) {
      return { ok: false, error: `无效的 unit：${raw}（应为 day | week | month | quarter | year）。` };
    }
    unit = raw as TimelineUnit;
  }

  return { ok: true, spec: { start, end, unit } };
}

export class TimelineRenderer extends MarkdownRenderChild {
  private app: App;
  private spec: TimelineSpec;
  private getFontSize: () => number;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private lastWidth = 0;
  private lastPxPerUnit = 0;
  private todayIso: string = formatIsoDate(new Date());

  constructor(containerEl: HTMLElement, options: TimelineRendererOptions) {
    super(containerEl);
    this.app = options.app;
    this.spec = options.spec;
    this.getFontSize = options.getFontSize;
  }

  onload() {
    this.render();

    // The scale is derived from the rendered width, so any node resize
    // re-renders the ruler (debounced — canvas drags fire continuously).
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        this.resizeTimer = null;
        const width = this.containerEl.clientWidth;
        // Re-renders never change the width themselves; skip no-op callbacks
        // (height-only changes) so render/observer can't ping-pong.
        if (Math.abs(width - this.lastWidth) < 0.5) return;
        this.render();
      }, RESIZE_DEBOUNCE_MS);
    });
    this.resizeObserver.observe(this.containerEl);
    this.register(() => {
      this.resizeObserver?.disconnect();
      if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    });

    if (this.spec.end === null) {
      this.startRolloverCheck();
    }
  }

  private render() {
    this.containerEl.empty();
    this.containerEl.addClass("financial-timeline");
    // Timeline cards always render on the hermes dark palette.
    this.containerEl.addClass("fc-hermes");

    const end = this.spec.end ?? parseIsoDate(this.todayIso);
    const count = unitCountBetween(this.spec.start, end, this.spec.unit);

    const ruler = this.containerEl.createDiv({ cls: "financial-timeline-ruler" });
    ruler.style.padding = `0 ${RULER_PADDING_PX}px`;
    // Label font size comes from plugin settings; CSS consumes this var.
    ruler.style.setProperty("--fc-timeline-font-size", `${this.getFontSize()}px`);
    ruler.createDiv({ cls: "financial-timeline-baseline" });

    // clientWidth includes the inline padding; the scale derives from the
    // usable width between the two padded edges.
    const width = ruler.clientWidth - 2 * RULER_PADDING_PX;
    this.lastWidth = this.containerEl.clientWidth;
    // Width is 0 while detached from the document; the ResizeObserver fires
    // again on attach and re-renders with the real width.
    if (width <= 0 || count <= 0) return;

    const pxPerUnit = width / count;
    this.lastPxPerUnit = pxPerUnit;
    const step = labelStep(pxPerUnit);

    for (let i = 0; i < count; i++) {
      const unitStart = addUnits(this.spec.start, i, this.spec.unit);
      const major = majorLabel(this.spec.unit, unitStart);

      const tick = ruler.createDiv({ cls: "financial-timeline-tick" });
      tick.style.left = `${i * pxPerUnit}px`;
      if (major) tick.addClass("is-major");

      if (major && (this.spec.unit !== "year" || i % step === 0)) {
        const label = ruler.createSpan({ cls: "financial-timeline-label is-major", text: major });
        this.placeLabel(label, i * pxPerUnit, width);
      } else if (!major && this.spec.unit !== "year" && i % step === 0) {
        const label = ruler.createSpan({ cls: "financial-timeline-label is-minor", text: minorLabel(this.spec.unit, unitStart) });
        this.placeLabel(label, i * pxPerUnit, width);
      }
    }

    if (this.spec.end === null) {
      const todayIndex = unitIndexOf(this.spec.start, end, this.spec.unit);
      if (todayIndex >= 0 && todayIndex <= count) {
        const marker = ruler.createDiv({ cls: "financial-timeline-today" });
        marker.style.left = `${todayIndex * pxPerUnit}px`;
      }
    }
  }

  // Centers the label on its tick (CSS translateX(-50%)), clamped so edge
  // labels stay inside the padded ruler instead of clipping.
  private placeLabel(label: HTMLElement, x: number, usableWidth: number) {
    const half = label.offsetWidth / 2;
    const clamped = Math.max(half, Math.min(usableWidth - half, x));
    label.style.left = `${clamped}px`;
  }

  // Auto-end rulers grow by one day at midnight. When the unit count grows,
  // keep the derived scale stable by widening the enclosing canvas node to
  // unitCount * lastPxPerUnit (plus the ruler padding the scale math
  // subtracts); the resulting ResizeObserver callback then re-derives the
  // same pxPerUnit. Off-canvas (reading view) or any canvas API mismatch
  // degrades to a plain re-render.
  private startRolloverCheck() {
    const timer = window.setInterval(() => {
      const nowIso = formatIsoDate(new Date());
      if (nowIso === this.todayIso) return;

      const oldCount = unitCountBetween(this.spec.start, parseIsoDate(this.todayIso), this.spec.unit);
      const newCount = unitCountBetween(this.spec.start, parseIsoDate(nowIso), this.spec.unit);
      this.todayIso = nowIso;

      if (newCount > oldCount && this.lastPxPerUnit > 0) {
        this.growCanvasNode(newCount * this.lastPxPerUnit + 2 * RULER_PADDING_PX);
      }
      this.render();
    }, ROLLOVER_CHECK_MS);
    this.register(() => window.clearInterval(timer));
  }

  private growCanvasNode(targetWidth: number) {
    onAttached(this.containerEl, () => {
      try {
        let el: HTMLElement | null = this.containerEl;
        while (el && !el.classList.contains("canvas-node")) {
          el = el.parentElement;
        }
        if (!el) return;

        const view = this.app.workspace.getActiveViewOfType(ItemView) as any;
        const canvas = view?.canvas;
        if (!canvas) return;

        const nodeId = el.getAttribute("data-id");
        const node = nodeId ? (canvas.nodes?.get?.(nodeId) as any) : null;
        if (!node) return;

        if (typeof node.moveAndResize === "function") {
          node.moveAndResize({ x: node.x, y: node.y, width: targetWidth, height: node.height });
        } else if (typeof node.resize === "function") {
          node.resize({ width: targetWidth, height: node.height });
        } else {
          node.width = targetWidth;
        }
        canvas.requestSave?.();
      } catch (e) {
        console.error("Financial Canvas: failed to grow timeline canvas node", e);
      }
    });
  }
}

function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    // js-yaml parses unquoted YYYY-MM-DD into a UTC-midnight Date; rebuild
    // it as a local-midnight date so every later computation stays local.
    return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  if (typeof value === "string") {
    const match = ISO_DATE_RE.exec(value.trim());
    if (!match) return null;
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const date = new Date(year, month - 1, day);
    // Reject rollover dates like 2024-13-40 that Date silently normalizes.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }
  return null;
}

function parseIsoDate(iso: string): Date {
  return new Date(
    parseInt(iso.slice(0, 4), 10),
    parseInt(iso.slice(5, 7), 10) - 1,
    parseInt(iso.slice(8, 10), 10)
  );
}

function diffDays(start: Date, end: Date): number {
  // Both dates sit at local midnight; rounding absorbs DST hour shifts.
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
}

function unitCountBetween(start: Date, end: Date, unit: TimelineUnit): number {
  switch (unit) {
    case "day":
      return diffDays(start, end) + 1;
    case "week":
      return Math.floor(diffDays(start, end) / 7) + 1;
    case "month":
      return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
    case "quarter":
      return quarterIndex(end) - quarterIndex(start) + 1;
    case "year":
      return end.getFullYear() - start.getFullYear() + 1;
  }
}

// Calendar-quarter ordinal (Jan/Apr/Jul/Oct aligned), so quarters line up
// across years instead of counting 3-month blocks from start.
function quarterIndex(date: Date): number {
  return date.getFullYear() * 4 + Math.floor(date.getMonth() / 3);
}

// Start date of unit i. Weeks are plain 7-day blocks from start (not
// calendar weeks); months/quarters/years snap to their calendar boundary.
function addUnits(start: Date, i: number, unit: TimelineUnit): Date {
  switch (unit) {
    case "day":
      return new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    case "week":
      return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * i);
    case "month":
      return new Date(start.getFullYear(), start.getMonth() + i, 1);
    case "quarter": {
      const q = quarterIndex(start) + i;
      return new Date(Math.floor(q / 4), (q % 4) * 3, 1);
    }
    case "year":
      return new Date(start.getFullYear() + i, 0, 1);
  }
}

function formatYearMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// Major tick at the parent granularity; returns its label or null.
function majorLabel(unit: TimelineUnit, unitStart: Date): string | null {
  switch (unit) {
    case "day":
      return unitStart.getDate() === 1 ? formatYearMonth(unitStart) : null;
    case "week": {
      // Major at the 7-day block that contains the 1st of a month.
      if (unitStart.getDate() === 1) return formatYearMonth(unitStart);
      const tail = new Date(unitStart.getFullYear(), unitStart.getMonth(), unitStart.getDate() + 6);
      if (tail.getMonth() !== unitStart.getMonth() || tail.getFullYear() !== unitStart.getFullYear()) {
        return formatYearMonth(tail);
      }
      return null;
    }
    case "month":
      return unitStart.getMonth() === 0 ? String(unitStart.getFullYear()) : null;
    case "quarter":
      // Major at Q1 (January) with the year label, same as unit=month.
      return unitStart.getMonth() === 0 ? String(unitStart.getFullYear()) : null;
    case "year":
      return String(unitStart.getFullYear());
  }
}

function minorLabel(unit: TimelineUnit, unitStart: Date): string {
  switch (unit) {
    case "day":
      return String(unitStart.getDate());
    case "week":
      return `${unitStart.getMonth() + 1}/${unitStart.getDate()}`;
    case "month":
      return String(unitStart.getMonth() + 1);
    case "quarter":
      return `Q${Math.floor(unitStart.getMonth() / 3) + 1}`;
    case "year":
      return String(unitStart.getFullYear());
  }
}

// Thin minor labels as the derived scale shrinks so they never overlap.
function labelStep(pxPerUnit: number): number {
  if (pxPerUnit >= 8) return 1;
  if (pxPerUnit >= 4) return 5;
  return 10;
}

// Fractional unit index of `date`, used to position the today marker.
function unitIndexOf(start: Date, date: Date, unit: TimelineUnit): number {
  switch (unit) {
    case "day":
      return diffDays(start, date);
    case "week":
      return diffDays(start, date) / 7;
    case "month": {
      const months = (date.getFullYear() - start.getFullYear()) * 12 + (date.getMonth() - start.getMonth());
      const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      return months + (date.getDate() - 1) / daysInMonth;
    }
    case "quarter": {
      const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      const monthInQuarter = date.getMonth() % 3;
      return (quarterIndex(date) - quarterIndex(start)) + (monthInQuarter + (date.getDate() - 1) / daysInMonth) / 3;
    }
    case "year": {
      const yearStart = new Date(date.getFullYear(), 0, 1);
      const daysInYear = diffDays(yearStart, new Date(date.getFullYear() + 1, 0, 1));
      return (date.getFullYear() - start.getFullYear()) + diffDays(yearStart, date) / daysInYear;
    }
  }
}
