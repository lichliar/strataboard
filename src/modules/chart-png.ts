import {
  createTextWatermark,
  LineStyle,
  TickMarkType,
  type BusinessDay,
  type IChartApi,
  type Time,
} from "lightweight-charts";

// Obsidian-free chart rendering helpers shared by the Obsidian renderers
// (chart-renderer.ts / series-chart-renderer.ts) and the headless CLI/MCP
// PNG renderer (render-headless.ts). Nothing here may import "obsidian" or
// touch Obsidian's DOM prototype extensions — the CLI bundle loads this
// module without the Obsidian runtime.

// Fallback chart width when the container has no layout size yet (detached
// mount, or Obsidian's hidden PDF-export render pass). The ChartSizeGuard
// corrects to the real layout size on attach in normal views.
export const DETACHED_CHART_WIDTH = 640;

export interface ChartPaneLabel {
  pane: number;
  text: string;
  color?: string;
}

// Hermes chart palette. The dark values mirror the .fc-hermes scope in
// styles.css — canvas drawing can't read CSS variables, so the two must be
// kept in sync. The light variant only applies to cards explicitly set to
// 浅色主题 in the card editor.
export const CHART_PALETTE = {
  dark: {
    text: "#d7dbe0",
    muted: "#868e99",
    // Grid lines are RGB triplets: the alpha comes from the 网格线透明度
    // setting (gridOpacity) in buildChartOptions.
    grid: "140, 150, 165",
    scaleBorder: "#272e38",
    crosshairLine: "rgba(245, 158, 11, 0.45)",
    crosshairLabel: "#f59e0b",
  },
  light: {
    text: "#374151",
    muted: "#6b7280",
    grid: "60, 70, 85",
    scaleBorder: "#d1d5db",
    crosshairLine: "rgba(180, 83, 9, 0.4)",
    crosshairLabel: "#d97706",
  },
};

export function toChartTime(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// Converts a chart Time (string or BusinessDay) to YYYY-MM-DD.
export function timeToYmd(time: Time): string {
  if (typeof time === "string") return time;
  const day = time as BusinessDay;
  return `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

// Base chart options shared by every lightweight-charts card in the plugin.
// gridOpacity is the 网格线透明度 percent (0-100); it scales a 0.3 alpha cap,
// so the default 20 reproduces the old near-invisible grid.
export function buildChartOptions(isDark: boolean, showGrid: boolean, gridOpacity = 20) {
  const p = isDark ? CHART_PALETTE.dark : CHART_PALETTE.light;
  const gridColor = `rgba(${p.grid}, ${(gridOpacity / 100) * 0.3})`;
  return {
    layout: {
      background: { color: "transparent" },
      textColor: p.text,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: gridColor, style: LineStyle.Dashed, visible: showGrid },
      horzLines: { color: gridColor, style: LineStyle.Dashed, visible: showGrid },
    },
    crosshair: {
      mode: 1,
      // TradingView-style: amber crosshair lines + solid amber axis labels.
      vertLine: { color: p.crosshairLine, labelBackgroundColor: p.crosshairLabel },
      horzLine: { color: p.crosshairLine, labelBackgroundColor: p.crosshairLabel },
    },
    rightPriceScale: {
      visible: true,
      borderColor: p.scaleBorder,
      // No vertical line next to the price axis — cleaner with the fc-hermes
      // card surface.
      borderVisible: false,
      autoScale: true,
      scaleMargins: { top: 0.02, bottom: 0.02 },
    },
    leftPriceScale: {
      visible: false,
      borderColor: p.scaleBorder,
      autoScale: true,
      scaleMargins: { top: 0.02, bottom: 0.02 },
    },
    timeScale: {
      borderColor: p.scaleBorder,
      timeVisible: false,
      visible: true,
      borderVisible: true,
      rightOffset: 10,
      minBarSpacing: 4,
      // Tiered tick labels driven by the library's tick-mark grading
      // (year/month boundaries get coarser labels), replacing the uniform
      // yyyy-MM-dd localization format.
      tickMarkFormatter: formatTickMark,
    },
    localization: {
      locale: "zh-CN",
      dateFormat: "yyyy-MM-dd",
    },
    handleScale: {
      axisPressedMouseMove: true,
    },
    // autoSize is deliberately OFF: ChartSizeGuard drives chart.resize from
    // the container's layout size (clientWidth/clientHeight). The library's
    // autoSize measures the initial size via getBoundingClientRect(), which
    // Obsidian canvas' transform: scale() distorts — charts created while
    // the canvas is zoomed would freeze at the scaled size.
    autoSize: false,
  };
}

// Faint centered background text (TradingView-style symbol watermark) on the
// price pane. Long titles (overlay cards compose every series name) are
// ellipsized so the single-line watermark doesn't overflow the card.
const MAX_WATERMARK_CHARS = 24;
export function addTitleWatermark(chart: IChartApi, title: string | undefined, isDark: boolean) {
  const trimmed = (title ?? "").trim();
  if (!trimmed) return;
  const p = isDark ? CHART_PALETTE.dark : CHART_PALETTE.light;
  createTextWatermark(chart.panes()[0], {
    lines: [
      {
        text: trimmed.length > MAX_WATERMARK_CHARS ? `${trimmed.slice(0, MAX_WATERMARK_CHARS)}…` : trimmed,
        color: `rgba(${p.grid}, 0.08)`,
        fontSize: 36,
        fontFamily: "sans-serif",
        fontStyle: "bold",
      },
    ],
  });
}

// Index of the last item whose key is <= target (-1 when target precedes the
// first item). Items must be ascending by key; keys are compared
// lexicographically, which works for both ISO dates and YYYYMMDD. Used by the
// series chart's crosshair legend.
export function floorIndex<T>(items: readonly T[], target: string, key: (item: T) => string): number {
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]) <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

// Time-axis tick labels: year boundary → 2024年, month boundary → 3月,
// otherwise the day of month (5日).
function formatTickMark(time: Time, tickMarkType: TickMarkType): string {
  const ymd = timeToYmd(time);
  const year = ymd.slice(0, 4);
  const month = Number(ymd.slice(5, 7));
  const day = Number(ymd.slice(8, 10));
  if (tickMarkType === TickMarkType.Year) return `${year}年`;
  if (tickMarkType === TickMarkType.Month) return `${month}月`;
  return `${day}日`;
}

// Text header composited above the chart in PNG exports so the image
// identifies what it shows (name/code + latest quote, or the overlay/spread
// title + subtitle + per-line legend).
export interface ChartPngHeader {
  title: string;
  subtitle?: string;
  quote?: { text: string; color?: string }[];
  // Series-card legend rows: the date plus one colored label/value per line.
  // Snapshotted at the latest data by the caller — never at a hovered date.
  legend?: { date?: string; items: { label: string; color: string; value?: string }[] };
}

// Options composePng needs from the card surface. In Obsidian these are read
// off the container element (fc-hermes class + getComputedStyle); the headless
// renderer passes fixed fallbacks instead.
export interface ComposePngOptions {
  isDark: boolean;
  backgroundColor?: string;
  fontFamily?: string;
}

// Paints the chart screenshot onto an opaque card-colored canvas with a text
// header strip on top (title / subtitle / quote segments / legend rows). The
// screenshot is a bitmap at CSS-size × devicePixelRatio, so the header is
// drawn at the same ratio to keep text as crisp as the chart.
export function composePng(
  chart: IChartApi,
  shot: HTMLCanvasElement,
  opts: ComposePngOptions,
  header?: ChartPngHeader
): HTMLCanvasElement {
  const cssWidth = chart.chartElement().clientWidth;
  const dpr = cssWidth > 0 ? shot.width / cssWidth : window.devicePixelRatio || 1;
  const palette = opts.isDark ? CHART_PALETTE.dark : CHART_PALETTE.light;
  const fontFamily = opts.fontFamily || "sans-serif";
  const hasHeader = !!header && !!header.title;

  const padX = 16;
  const padTop = 12;
  const titleSize = 15;
  const subSize = 11;
  const quoteSize = 14;
  const legendSize = 11;
  const legendGap = 12;
  const lineGap = 4;
  const padBottom = 10;

  const out = document.createElement("canvas");
  out.width = shot.width;
  const ctx = out.getContext("2d");
  if (!ctx) return shot;

  // Wrap the legend items into rows first — the header height depends on the
  // row count. Measuring needs a 2d context; assigning out.height afterwards
  // resets the context state, which the draw pass re-sets anyway.
  type LegendRowItem = { label: string; labelColor: string; bold?: boolean; value?: string };
  const legendRows: LegendRowItem[][] = [];
  const maxWidth = out.width - 2 * padX * dpr;
  const legend = header?.legend;
  if (hasHeader && legend && (legend.date || legend.items.length > 0)) {
    ctx.font = `${legendSize * dpr}px ${fontFamily}`;
    const items: LegendRowItem[] = legend.date
      ? [{ label: legend.date, labelColor: palette.text, bold: true }, ...legend.items.map((it) => ({ label: it.label, labelColor: it.color, value: it.value }))]
      : legend.items.map((it) => ({ label: it.label, labelColor: it.color, value: it.value }));
    let row: LegendRowItem[] = [];
    let rowWidth = 0;
    for (const item of items) {
      const width = ctx.measureText(item.value ? `${item.label} ${item.value}` : item.label).width + legendGap * dpr;
      if (row.length > 0 && rowWidth + width > maxWidth) {
        legendRows.push(row);
        row = [];
        rowWidth = 0;
      }
      row.push(item);
      rowWidth += width;
    }
    if (row.length > 0) legendRows.push(row);
  }

  let headerHeight = 0;
  if (hasHeader) {
    headerHeight = padTop + titleSize;
    if (header.subtitle) headerHeight += lineGap + subSize;
    if (header.quote && header.quote.length > 0) headerHeight += lineGap + quoteSize;
    if (legendRows.length > 0) headerHeight += legendRows.length * (lineGap + legendSize);
    headerHeight += padBottom;
  }

  out.height = Math.round(headerHeight * dpr) + shot.height;

  // The screenshot itself is transparent (buildChartOptions sets a
  // transparent layout background), so fill the card surface color first.
  const bg = opts.backgroundColor;
  ctx.fillStyle = bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)" ? bg : opts.isDark ? "#10141a" : "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);

  if (hasHeader) {
    ctx.textBaseline = "top";
    let y = padTop * dpr;
    ctx.font = `600 ${titleSize * dpr}px ${fontFamily}`;
    ctx.fillStyle = palette.text;
    ctx.fillText(header.title, padX * dpr, y, maxWidth);
    y += (titleSize + lineGap) * dpr;
    if (header.subtitle) {
      ctx.font = `${subSize * dpr}px ${fontFamily}`;
      ctx.fillStyle = palette.muted;
      ctx.fillText(header.subtitle, padX * dpr, y, maxWidth);
      y += (subSize + lineGap) * dpr;
    }
    if (header.quote && header.quote.length > 0) {
      ctx.font = `600 ${quoteSize * dpr}px ${fontFamily}`;
      let x = padX * dpr;
      for (const seg of header.quote) {
        ctx.fillStyle = seg.color ?? palette.text;
        ctx.fillText(seg.text, x, y);
        x += ctx.measureText(seg.text).width + 12 * dpr;
      }
      y += (quoteSize + lineGap) * dpr;
    }
    for (const row of legendRows) {
      let x = padX * dpr;
      for (const item of row) {
        ctx.font = `${item.bold ? "600 " : ""}${legendSize * dpr}px ${fontFamily}`;
        ctx.fillStyle = item.labelColor;
        ctx.fillText(item.label, x, y);
        x += ctx.measureText(item.label).width;
        if (item.value) {
          ctx.font = `${legendSize * dpr}px ${fontFamily}`;
          ctx.fillStyle = palette.text;
          const valueText = ` ${item.value}`;
          ctx.fillText(valueText, x, y);
          x += ctx.measureText(valueText).width;
        }
        x += legendGap * dpr;
      }
      y += (legendSize + lineGap) * dpr;
    }
  }

  ctx.drawImage(shot, 0, Math.round(headerHeight * dpr));
  return out;
}

/** Paint pane labels onto a lightweight-charts screenshot before composing it. */
export function drawChartPaneLabels(
  chart: IChartApi,
  canvas: HTMLCanvasElement,
  labels: ChartPaneLabel[],
  opts: Pick<ComposePngOptions, "isDark" | "fontFamily">
): void {
  if (labels.length === 0) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const chartWidth = chart.chartElement().clientWidth;
  const dpr = chartWidth > 0 ? canvas.width / chartWidth : 1;
  const panes = chart.panes();
  const defaultColor = opts.isDark ? "rgba(220, 226, 235, 0.78)" : "rgba(45, 51, 61, 0.78)";
  const bg = opts.isDark ? "rgba(16, 20, 26, 0.72)" : "rgba(255, 255, 255, 0.78)";
  ctx.font = `${11 * dpr}px ${opts.fontFamily || "sans-serif"}`;
  ctx.textBaseline = "top";
  let top = 0;
  for (let pane = 0; pane < panes.length; pane++) {
    const paneLabels = labels.filter((label) => label.pane === pane && label.text.trim());
    if (paneLabels.length > 0) {
      const x = 8 * dpr;
      const y = (top + 4) * dpr;
      const text = paneLabels.map((label) => label.text).join("   ");
      const labelWidth = ctx.measureText(text).width + 12 * dpr;
      ctx.fillStyle = bg;
      ctx.fillRect(x - 4 * dpr, y - 2 * dpr, labelWidth, 16 * dpr);
      let textX = x;
      for (const label of paneLabels) {
        ctx.fillStyle = label.color ?? defaultColor;
        ctx.fillText(label.text, textX, y);
        textX += ctx.measureText(label.text).width + 12 * dpr;
      }
    }
    top += panes[pane].getHeight() + (pane < panes.length - 1 ? 1 : 0);
  }
}
