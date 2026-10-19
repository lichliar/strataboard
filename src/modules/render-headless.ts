// Headless (Node.js) renderer: turns a StrataBoard card block into a PNG
// bitmap without Obsidian. Used only by the CLI (src/cli) and MCP server
// (src/mcp) bundles — the Obsidian plugin bundle (main.js) must never import
// this module. The DOM comes from jsdom; canvas 2d contexts come from the
// "canvas" native package, which jsdom picks up automatically when it is
// resolvable (deployed next to cli.js by scripts/copy-assets.mjs). Both are
// loaded lazily so every non-render CLI command works without them.
//
// The rendering sequence mirrors the Obsidian renderers (chart-renderer.ts /
// series-chart-renderer.ts) minus everything interactive: no DOM legend, no
// tooltips, no footer, no size guard. Shared pure helpers live in
// chart-png.ts / overlay-lines.ts / indicators/compute.ts.

import {
  createChart,
  AreaSeries,
  BaselineSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  PriceScaleMode,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPaneApi,
  type ISeriesApi,
  type LineData,
  type LineWidth,
  type Time,
} from "lightweight-charts";
import type { Bar, IndicatorResult } from "oakscriptjs";
import { JSDOM } from "jsdom";
import type { AssetType, OhlcvRow, OverlaySpec, SeriesPoint, SpreadSpec, SymbolItem } from "../types";
import { DEFAULT_RISE_COLOR, DEFAULT_FALL_COLOR } from "../types";
import { parseCardSpec, DEFAULT_CARD_HEIGHT } from "./card-spec";
import { parseOverlaySpec, parseSpreadSpec } from "./series-spec";
import { buildOverlaySubtitle, buildSpreadSubtitle } from "./series-summary";
import { detectNativeFreq, maxFreq, FREQ_BADGE } from "../utils/frequency";
import { resolveEffectiveTheme } from "../utils/dom";
import { t } from "../i18n";
import { DataAdapter } from "./data-adapter";
import { SeriesAdapter } from "./series-adapter";
import { formatExpressionTitle } from "./expression";
import { CHART_PALETTE, addTitleWatermark, buildChartOptions, composePng, drawChartPaneLabels, floorIndex, toChartTime, timeToYmd, type ChartPaneLabel, type ChartPngHeader } from "./chart-png";
import { SERIES_LINE_COLORS, buildOverlayLine, toZScore, type SeriesChartLine } from "./overlay-lines";
import { IndicatorRenderer } from "../vendor/lci/render";
import { ohlcvToBars } from "./indicators/bars";
import { computeIndicatorForInstance } from "./indicators/compute";
import { formatIndicatorLabel } from "./indicators/contract";

// ---------------------------------------------------------------------------
// Headless DOM environment
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 960;

let headlessReady = false;
// Family name the registered CJK font is bound to (see registerCjkFont).
let cjkFontFamily: string | null = null;

// First existing candidate wins. node-canvas only renders glyphs from fonts
// registered with it (there is no system font fallback), and chart/axis
// labels include CJK (年/月/日 tick marks, Chinese titles).
const CJK_FONT_CANDIDATES = [
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/STHeiti Light.ttc",
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "C:/Windows/Fonts/msyh.ttc",
];

function registerCjkFont(createRequireFromHere: NodeRequire): void {
  let registerFont: ((path: string, options: { family: string }) => void) | null = null;
  try {
    registerFont = createRequireFromHere("canvas").registerFont;
  } catch {
    throw new Error("渲染图片需要 canvas 原生模块：请用 npm run build 重新构建部署（构建会把 canvas 拷到插件目录的 node_modules）。");
  }
  const fs = createRequireFromHere("fs") as typeof import("fs");
  for (const candidate of CJK_FONT_CANDIDATES) {
    try {
      if (!fs.existsSync(candidate)) continue;
      registerFont!(candidate, { family: "StrataBoardCJK" });
      cjkFontFamily = "StrataBoardCJK";
      return;
    } catch {
      // Unparseable font file — try the next candidate.
    }
  }
  console.error("[strataboard] 未找到可注册的 CJK 字体，图中的中文可能显示为方框。");
}

// Sets up the jsdom-backed globals lightweight-charts needs, exactly once per
// process. The chart always renders at an explicit size, so the stubbed
// ResizeObserver never has to fire.
function ensureHeadlessDom(): void {
  if (headlessReady) return;
  // canvas is loaded via runtime require: it is a native module, external in
  // the bundle, and a missing copy must fail only the render commands.
  // (jsdom is a plain static import — it is bundled.)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const req: NodeRequire = eval("require");
  registerCjkFont(req);
  const dom = new JSDOM("", { pretendToBeVisual: true });
  const w = dom.window as unknown as Record<string, unknown>;
  Object.defineProperty(w, "devicePixelRatio", { value: 2, configurable: true });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  w.ResizeObserver = ResizeObserverStub;

  const g = globalThis as Record<string, unknown>;
  g.window = w;
  g.document = w.document;
  g.ResizeObserver = ResizeObserverStub;
  g.requestAnimationFrame = (w.requestAnimationFrame as typeof requestAnimationFrame).bind(w);
  g.cancelAnimationFrame = (w.cancelAnimationFrame as typeof cancelAnimationFrame).bind(w);
  g.getComputedStyle = (w.getComputedStyle as typeof getComputedStyle).bind(w);
  g.HTMLCanvasElement = w.HTMLCanvasElement;
  g.HTMLElement = w.HTMLElement;
  try {
    Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable: true });
  } catch {
    // Node >= 21 exposes a read-only navigator; lightweight-charts can live
    // without it.
  }
  headlessReady = true;
}

// Font stack used for chart text and the PNG header: the registered CJK font
// first (it carries Latin glyphs too), sans-serif as the last resort.
function chartFontFamily(): string {
  return cjkFontFamily ? `"${cjkFontFamily}", sans-serif` : "sans-serif";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HeadlessRenderDeps {
  dataAdapter: DataAdapter;
  seriesAdapter: SeriesAdapter;
  // Symbol-cache lookup for the quote header's display name/code (optional:
  // falls back to the raw symbol).
  lookupSymbol?: (symbol: string, assetType: AssetType, sourceId?: string) => Promise<SymbolItem | null>;
  settings: {
    showSeriesLatestValue?: boolean;
    showSeriesPointMarkers?: boolean;
    showChartGrid?: boolean;
    gridOpacity?: number;
    // Global 涨色/跌色 from the plugin settings (data.json); absent = the
    // DEFAULT_RISE_COLOR/DEFAULT_FALL_COLOR defaults.
    riseColor?: string;
    fallColor?: string;
  };
}

export interface RenderedCardPng {
  png: Buffer;
  title: string;
  width: number;
  height: number;
}

export interface RenderOptions {
  width?: number;
  height?: number;
}

// Renders one card block (lang = quote/overlay/spread, body = fenced YAML) to
// a PNG. financial-widget/calendar blocks throw — they embed third-party
// HTML / DOM UI that has no static image form.
export async function renderCardBlockPng(
  lang: string,
  body: string,
  deps: HeadlessRenderDeps,
  opts: RenderOptions = {}
): Promise<RenderedCardPng> {
  ensureHeadlessDom();
  const width = opts.width ?? DEFAULT_WIDTH;
  switch (lang) {
    case "quote":
      return renderQuotePng(body, deps, width, opts.height);
    case "overlay":
      return renderOverlayPng(body, deps, width, opts.height);
    case "spread":
      return renderSpreadPng(body, deps, width, opts.height);
    default:
      throw new Error(`「${lang}」类型的卡片不支持渲染为图片（仅支持 quote/overlay/spread）。`);
  }
}

// ---------------------------------------------------------------------------
// Shared chart helpers (headless equivalents of the renderers' private parts)
// ---------------------------------------------------------------------------

function makeChart(width: number, height: number, isDark: boolean, showGrid: boolean, gridOpacity?: number, hideRightScale = false): IChartApi {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const options = {
    ...buildChartOptions(isDark, showGrid, gridOpacity),
    width,
    height,
  };
  (options.layout as { fontFamily?: string }).fontFamily = chartFontFamily();
  if (hideRightScale) {
    // 独立纵轴 mode: every line gets its own invisible overlay price scale;
    // the shared right axis must be hidden at CREATION time — hiding it later
    // crashes the layout ("Value is null", see configureAuxPane's comment).
    options.rightPriceScale = { ...options.rightPriceScale, visible: false };
  }
  return createChart(container, options);
}

// Composite + encode; always removes the chart so one process can render
// many cards without leaking jsdom subtrees.
function screenshotPng(chart: IChartApi, isDark: boolean, header: ChartPngHeader, width: number, height: number, paneLabels: ChartPaneLabel[] = []): RenderedCardPng {
  try {
    const shot = chart.takeScreenshot();
    drawChartPaneLabels(chart, shot, paneLabels, { isDark, fontFamily: chartFontFamily() });
    const composed = composePng(
      chart,
      shot,
      { isDark, backgroundColor: isDark ? "#10141a" : "#ffffff", fontFamily: chartFontFamily() },
      header
    );
    const dataUrl = composed.toDataURL("image/png");
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return { png: Buffer.from(base64, "base64"), title: header.title, width, height };
  } finally {
    chart.remove();
  }
}

function formatNumber(n: number | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "--";
  return n.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatPercent(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return "--";
  return `${n.toFixed(2)}%`;
}

function formatSeriesValue(n: number | undefined, suffix: string): string {
  if (n == null || Number.isNaN(n)) return "--";
  return `${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${suffix}`;
}

// Applies a visible time range, then extends the logical range by the
// configured rightOffset when the range reaches the latest bar — same fix as
// the renderers' applyTimeRange (setVisibleRange pins `to` at the right edge,
// half-clipping the last bar under the price axis).
function applyTimeRange(chart: IChartApi, from: Time, to: Time, lastTime: string, lastLogicalIndex: number): void {
  const ts = chart.timeScale();
  ts.setVisibleRange({ from, to });
  if (timeToYmd(to) < lastTime) return;
  const logical = ts.getVisibleLogicalRange();
  if (!logical) return;
  const rightOffset = ts.options().rightOffset;
  ts.setVisibleLogicalRange({ from: logical.from, to: lastLogicalIndex + rightOffset });
}

function configureAuxPane(pane: IPaneApi<Time>): void {
  pane.priceScale("left").applyOptions({ visible: false });
  // The right scale must stay visible on EVERY pane: the chart-level
  // rightPriceScale.visible=true makes the layout call ensureNotNull on each
  // pane's right axis widget; a hidden right scale throws "Value is null".
  pane.priceScale("right").applyOptions({ visible: true, borderVisible: false, scaleMargins: { top: 0.1, bottom: 0 } });
}

// ---------------------------------------------------------------------------
// quote card
// ---------------------------------------------------------------------------

async function renderQuotePng(body: string, deps: HeadlessRenderDeps, width: number, heightOpt?: number): Promise<RenderedCardPng> {
  const parsed = parseCardSpec(body);
  if (!parsed.ok) throw parsed.error;
  const spec = parsed.spec;

  // Same data assembly as the Obsidian card: raw rows first (cache stores the
  // source's native granularity), detect the native frequency, then clamp
  // spec.freq to it (upsampling only) and load the effective frequency.
  const raw = (await deps.dataAdapter.loadOhlcv({ ...spec, freq: "D" })).rows;
  const nativeFreq = detectNativeFreq(raw);
  const effFreq = maxFreq(spec.freq, nativeFreq);
  const data = effFreq === "D" ? raw : (await deps.dataAdapter.loadOhlcv({ ...spec, freq: effFreq })).rows;
  if (data.length === 0) {
    throw new Error(t("暂无数据：{symbol} 在所选时间范围内没有数据。", { symbol: spec.symbol }));
  }

  const symbolInfo = (await deps.lookupSymbol?.(spec.symbol, spec.assetType, spec.sourceId).catch(() => null)) ?? undefined;

  const theme = spec.theme ?? "auto";
  const isDark = resolveEffectiveTheme(theme) === "dark";
  const riseColor = deps.settings.riseColor ?? DEFAULT_RISE_COLOR;
  const fallColor = deps.settings.fallColor ?? DEFAULT_FALL_COLOR;
  const chartType = spec.chartType ?? "candlestick";
  const indicators = spec.indicators ?? [];
  const height = heightOpt ?? DEFAULT_CARD_HEIGHT;

  const chart = makeChart(width, height, isDark, spec.showGrid ?? deps.settings.showChartGrid ?? true, spec.gridOpacity ?? deps.settings.gridOpacity);
  addTitleWatermark(chart, spec.title ?? symbolInfo?.name ?? spec.symbol, isDark);

  // Price series (candlestick or close-line).
  let priceSeries: ISeriesApi<"Candlestick"> | ISeriesApi<"Line">;
  if (chartType === "line") {
    const lineData: LineData[] = data.map((row) => ({ time: toChartTime(row.tradeDate), value: row.close }));
    priceSeries = chart.addSeries(
      LineSeries,
      { color: isDark ? "#60a5fa" : "#2563eb", lineWidth: 2, priceFormat: { type: "price", precision: 2, minMove: 0.01 } },
      0
    );
    priceSeries.setData(lineData);
  } else {
    const candleData: CandlestickData[] = data.map((row) => ({
      time: toChartTime(row.tradeDate),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    }));
    priceSeries = chart.addSeries(
      CandlestickSeries,
      {
        upColor: riseColor,
        downColor: fallColor,
        borderUpColor: riseColor,
        borderDownColor: fallColor,
        wickUpColor: riseColor,
        wickDownColor: fallColor,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      },
      0
    );
    priceSeries.setData(candleData);
  }


  // Indicators: unix-second bars for calculate(), string chart times for the
  // vendored renderer. Overlay indicators draw on the price pane (before the
  // volume pane exists); the rest get panes after it.
  const bars = ohlcvToBars(data);
  const renderBars = bars.map((bar, i) => ({ ...bar, time: toChartTime(data[i].tradeDate) as unknown as number }));
  const overlayLegend: { label: string; color: string; value?: string }[] = [];
  for (const instance of indicators) {
    if (instance.hidden) continue;
    const computed = computeIndicatorForInstance(instance, bars, data);
    if (!computed || !computed.def.metadata.overlay) continue;
    const { def, inputs, adapted } = computed;
    new IndicatorRenderer(chart, { paneIndex: 0, mainSeries: priceSeries }).render(
      { overlay: true, plotConfig: def.plotConfig ?? [], hlineConfig: def.hlineConfig, fillConfig: def.fillConfig },
      adapted as unknown as IndicatorResult,
      renderBars,
      { inputs }
    );
    const visiblePlots = (def.plotConfig ?? []).filter((plot) => plot.display !== "none");
    for (const [plotIndex, plot] of visiblePlots.entries()) {
      const points = adapted.plots?.[plot.id];
      if (!points?.length) continue;
      const point = points[points.length - 1];
      const value = point?.value;
      overlayLegend.push({
        label: visiblePlots.length === 1 && plotIndex === 0 ? formatIndicatorLabel(def, inputs) : plotIndex === 0 ? formatIndicatorLabel(def, inputs) : plot.title ?? plot.id,
        color: plot.color ?? "#2962FF",
        value: typeof value === "number" && Number.isFinite(value) ? formatNumber(value, 2) : undefined,
      });
    }
  }

  const showVolume = spec.showVolume !== false;
  if (showVolume) {
    const volumeData: HistogramData[] = data.map((row, i) => ({
      time: toChartTime(row.tradeDate),
      value: row.vol,
      color: (i > 0 ? row.close >= data[i - 1].close : row.close >= row.open) ? riseColor : fallColor,
    }));
    const series = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 1);
    series.setData(volumeData);
  }

  // Pane 0 scale config (logScale lives on the right scale).
  const borderColor = isDark ? CHART_PALETTE.dark.scaleBorder : CHART_PALETTE.light.scaleBorder;
  chart.panes()[0].priceScale("left").applyOptions({ visible: false, borderColor, autoScale: true, scaleMargins: { top: 0.02, bottom: 0.02 } });
  chart.panes()[0].priceScale("right").applyOptions({
    visible: true,
    borderColor,
    autoScale: true,
    scaleMargins: { top: 0.02, bottom: 0.02 },
    mode: spec.logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
  });
  const volumePane = chart.panes()[1];
  if (showVolume && volumePane) configureAuxPane(volumePane);

  // Non-overlay indicators, one pane each after the volume pane.
  let pane = showVolume ? 2 : 1;
  const paneLabels: ChartPaneLabel[] = showVolume ? [{ pane: 1, text: t("成交量") }] : [];
  for (const instance of indicators) {
    if (instance.hidden) continue;
    const computed = computeIndicatorForInstance(instance, bars, data);
    if (!computed || computed.def.metadata.overlay) continue;
    const { def, inputs, adapted } = computed;
    new IndicatorRenderer(chart, { paneIndex: pane, mainSeries: priceSeries }).render(
      { overlay: false, plotConfig: def.plotConfig ?? [], hlineConfig: def.hlineConfig, fillConfig: def.fillConfig },
      adapted as unknown as IndicatorResult,
      renderBars,
      { inputs, lastValueVisible: true }
    );
    const paneApi = chart.panes()[pane];
    if (paneApi) configureAuxPane(paneApi);
    paneLabels.push({ pane, text: formatIndicatorLabel(def, inputs) });
    pane++;
  }

  // Fixed pane stretch: main pane 3, every aux pane 1.
  chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1));

  // Latest-price dashed line + user 价位线.
  const latest = data[data.length - 1];
  const prev = data.length > 1 ? data[data.length - 2] : latest;
  priceSeries.createPriceLine({
    price: latest.close,
    color: latest.close >= prev.close ? riseColor : fallColor,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: "",
  });
  const palette = isDark ? CHART_PALETTE.dark : CHART_PALETTE.light;
  for (const line of spec.priceLines ?? []) {
    priceSeries.createPriceLine({
      price: line.price,
      color: line.color ?? palette.muted,
      lineWidth: 1,
      lineStyle: LineStyle.SparseDotted,
      axisLabelVisible: true,
      title: line.title ?? "",
    });
  }

  // Visible range: persisted visibleStart/End > fitContent.
  applyQuoteVisibleRange(chart, spec, data);

  // PNG header mirrors the card's DOM header (name + code/freq + latest quote).
  const change = latest.close - prev.close;
  const changePct = prev.close !== 0 ? (change / prev.close) * 100 : 0;
  const quoteColor = change >= 0 ? riseColor : fallColor;
  const header: ChartPngHeader = {
    title: spec.title ?? symbolInfo?.name ?? spec.symbol,
    subtitle: spec.title ? t(FREQ_BADGE[nativeFreq]) : `${symbolInfo?.tsCode ?? spec.symbol} · ${t(FREQ_BADGE[nativeFreq])}`,
    quote: [
      { text: formatNumber(latest.close, 2), color: quoteColor },
      { text: `${change >= 0 ? "+" : ""}${formatNumber(change, 2)}`, color: quoteColor },
      { text: `${change >= 0 ? "+" : ""}${formatPercent(changePct)}`, color: quoteColor },
    ],
    legend: overlayLegend.length > 0 ? { items: overlayLegend } : undefined,
  };
  return screenshotPng(chart, isDark, header, width, height, paneLabels);
}

function applyQuoteVisibleRange(chart: IChartApi, spec: { visibleStart?: string; visibleEnd?: string }, data: OhlcvRow[]): void {
  const lastTime = toChartTime(data[data.length - 1].tradeDate);
  const lastIndex = data.length - 1;
  if (spec.visibleStart && spec.visibleEnd) {
    try {
      applyTimeRange(chart, spec.visibleStart as Time, spec.visibleEnd as Time, lastTime, lastIndex);
      return;
    } catch {
      // Persisted range can fall outside the loaded data — fall through.
    }
  }
  chart.timeScale().fitContent();
}

// ---------------------------------------------------------------------------
// series cards (overlay / spread)
// ---------------------------------------------------------------------------

const LINE_TYPE_MAP: Record<string, LineType> = {
  simple: LineType.Simple,
  curved: LineType.Curved,
  steps: LineType.WithSteps,
};

// Alpha-blended variant of a #rrggbb line color for the area-style gradient.
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(color);
  if (!m) return alpha >= 0.5 ? color : "transparent";
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

interface SeriesChartSpec {
  title: string;
  subtitle?: string;
  lines: SeriesChartLine[];
  valueSuffix?: string;
  theme?: OverlaySpec["theme"];
  independentScales?: boolean;
  viewStart?: string;
  viewEnd?: string;
  showLatestValue?: boolean;
  showPointMarkers?: boolean;
  showGrid?: boolean;
  gridOpacity?: number;
}

function renderSeriesPng(card: SeriesChartSpec, width: number, heightOpt: number | undefined, settings: HeadlessRenderDeps["settings"]): RenderedCardPng {
  const lines = card.lines.filter((line) => line.points.length > 0);
  if (lines.length === 0) {
    throw new Error(t("暂无数据：所选系列在该时间范围内没有数据。"));
  }
  const isDark = resolveEffectiveTheme(card.theme ?? "auto") === "dark";
  const height = heightOpt ?? DEFAULT_CARD_HEIGHT;
  const riseColor = settings.riseColor ?? DEFAULT_RISE_COLOR;
  const fallColor = settings.fallColor ?? DEFAULT_FALL_COLOR;
  const independentScales = card.independentScales ?? false;
  const chart = makeChart(width, height, isDark, card.showGrid ?? settings.showChartGrid ?? true, card.gridOpacity ?? settings.gridOpacity, independentScales);
  addTitleWatermark(chart, card.title, isDark);

  const showLatestValue = card.showLatestValue ?? settings.showSeriesLatestValue ?? true;
  const showPointMarkers = card.showPointMarkers ?? settings.showSeriesPointMarkers ?? false;
  const scaleIds = independentScales ? lines.map((_, i) => `s${i}`) : ["right"];

  lines.forEach((line, i) => {
    const data: LineData[] = line.points.map((p) => ({ time: p.date, value: p.value }));
    const color =
      line.style === "baseline"
        ? line.points[line.points.length - 1].value >= 0
          ? riseColor
          : fallColor
        : line.color ?? SERIES_LINE_COLORS[i % SERIES_LINE_COLORS.length];
    const suffix = card.valueSuffix ?? "";
    const sharedOptions = {
      lineWidth: (line.lineWidth ?? 2) as LineWidth,
      lineType: LINE_TYPE_MAP[line.lineType ?? "simple"],
      priceLineVisible: false,
      ...(independentScales ? { priceScaleId: scaleIds[i] } : {}),
      lastValueVisible: showLatestValue,
      pointMarkersVisible: showPointMarkers,
      priceFormat: suffix
        ? { type: "custom" as const, formatter: (price: number) => `${price.toFixed(2)}${suffix}`, minMove: 0.01 }
        : { type: "price" as const, precision: 2, minMove: 0.01 },
    };
    const series =
      line.style === "baseline"
        ? chart.addSeries(
            BaselineSeries,
            {
              ...sharedOptions,
              baseValue: { type: "price", price: 0 },
              topLineColor: riseColor,
              topFillColor1: withAlpha(riseColor, 0.28),
              topFillColor2: withAlpha(riseColor, 0.04),
              bottomLineColor: fallColor,
              bottomFillColor1: withAlpha(fallColor, 0.28),
              bottomFillColor2: withAlpha(fallColor, 0.04),
            },
            0
          )
        : line.style === "area"
          ? chart.addSeries(AreaSeries, { ...sharedOptions, lineColor: color, topColor: withAlpha(color, 0.35), bottomColor: withAlpha(color, 0.02) }, 0)
          : chart.addSeries(LineSeries, { ...sharedOptions, color }, 0);
    series.setData(data);

    line.color = color;
    // Single-line cards (spread, or a one-line overlay) also get a dashed
    // guide line at the latest value.
    if (showLatestValue && lines.length === 1) {
      series.createPriceLine({
        price: line.points[line.points.length - 1].value,
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: "",
      });
    }
  });

  // Visible range: persisted viewStart/viewEnd > fitContent.
  const lastTime = lines.reduce((max, line) => (line.points[line.points.length - 1].date > max ? line.points[line.points.length - 1].date : max), "");
  if (card.viewStart && card.viewEnd) {
    try {
      applyTimeRange(chart, card.viewStart as Time, card.viewEnd as Time, lastTime, Number.MAX_SAFE_INTEGER);
    } catch {
      chart.timeScale().fitContent();
    }
  } else {
    chart.timeScale().fitContent();
  }

  // PNG header: title + subtitle + a legend snapshotted at the latest date
  // (never at a hovered date — there is no crosshair here).
  const suffix = card.valueSuffix ?? "";
  const header: ChartPngHeader = {
    title: card.title,
    subtitle: card.subtitle,
    legend: {
      date: lastTime,
      items: lines.map((line) => {
        const index = floorIndex(line.points, lastTime, (p) => p.date);
        return { label: line.name, color: line.color ?? "#868e99", value: formatSeriesValue(index >= 0 ? line.points[index].value : undefined, suffix) };
      }),
    },
  };
  return screenshotPng(chart, isDark, header, width, height);
}

// ---------------------------------------------------------------------------
// overlay card
// ---------------------------------------------------------------------------

async function renderOverlayPng(body: string, deps: HeadlessRenderDeps, width: number, heightOpt?: number): Promise<RenderedCardPng> {
  const parsed = parseOverlaySpec(body);
  if (!parsed.spec) throw new Error(parsed.error ?? t("无效的卡片配置。"));
  const spec: OverlaySpec = parsed.spec;

  const period = spec.period ?? "D";
  const compareMode = spec.normalize ?? "percent";
  const lineNames = await Promise.all(spec.series.map((ref) => deps.seriesAdapter.resolveLabel(ref)));
  const allPoints = await Promise.all(spec.series.map((ref) => deps.seriesAdapter.loadSeries(ref, spec.range, period)));

  const overlayLines = spec.series.map((ref, i) => {
    const built = buildOverlayLine(ref, allPoints[i], compareMode, lineNames[i]);
    // Per-series 缩放系数: pure visual multiplier, applied before the z-score
    // pass (which is scale-invariant).
    const scale = ref.scale ?? 1;
    if (scale !== 1) {
      built.line.points = built.line.points.map((p: SeriesPoint) => ({ date: p.date, value: p.value * scale }));
    }
    return built;
  });
  // z-score standardizes EVERY line post-hoc; the result is dimensionless.
  if (compareMode === "zscore") {
    for (const line of overlayLines) {
      line.line.points = toZScore(line.line.points);
      line.percentish = false;
    }
  }
  const displayed = overlayLines.filter((l) => l.line.points.length > 0);
  const valueSuffix = displayed.length > 0 && displayed.every((l) => l.percentish) ? "%" : undefined;

  let title: string;
  if (spec.title) {
    title = spec.title;
  } else {
    title = t("对比（{names}）", { names: lineNames.join("+") });
    if (compareMode === "percent") title += t("（归一化）");
    else if (compareMode === "zscore") title += t("（标准化）");
    else if (compareMode === "axis") title += t("（独立纵轴）");
  }

  // Subtitle: period · range · mode + explanation + 缩放系数 badges
  // (series-summary.ts, same composition as the Obsidian renderer).
  const subtitle = buildOverlaySubtitle(
    spec,
    lineNames,
    allPoints.map((points) => points[0]?.date)
  );

  return renderSeriesPng(
    {
      title,
      subtitle,
      lines: overlayLines.map((l) => (spec.lineType ? { ...l.line, lineType: spec.lineType } : l.line)),
      valueSuffix,
      theme: spec.theme,
      independentScales: compareMode === "axis",
      viewStart: spec.viewStart,
      viewEnd: spec.viewEnd,
      showLatestValue: spec.showLatestValue,
      showPointMarkers: spec.showPointMarkers,
      showGrid: spec.showGrid,
      gridOpacity: spec.gridOpacity,
    },
    width,
    heightOpt,
    deps.settings
  );
}

// ---------------------------------------------------------------------------
// spread card
// ---------------------------------------------------------------------------

async function renderSpreadPng(body: string, deps: HeadlessRenderDeps, width: number, heightOpt?: number): Promise<RenderedCardPng> {
  const parsed = parseSpreadSpec(body);
  if (!parsed.spec) throw new Error(parsed.error ?? t("无效的卡片配置。"));
  const spec: SpreadSpec = parsed.spec;

  const labels = await Promise.all(spec.series.map((ref) => deps.seriesAdapter.resolveLabel(ref)));
  const points = await deps.seriesAdapter.loadSpread(spec, spec.range, spec.period ?? "D");
  const title = spec.title ?? formatExpressionTitle(spec.expression, labels);

  return renderSeriesPng(
    {
      title,
      subtitle: buildSpreadSubtitle(spec),
      lines: [{ name: title, points, color: spec.lineColor, lineWidth: spec.lineWidth, lineType: spec.lineType, style: spec.style }],
      theme: spec.theme,
      viewStart: spec.viewStart,
      viewEnd: spec.viewEnd,
      showLatestValue: spec.showLatestValue,
      showPointMarkers: spec.showPointMarkers,
      showGrid: spec.showGrid,
      gridOpacity: spec.gridOpacity,
    },
    width,
    heightOpt,
    deps.settings
  );
}
