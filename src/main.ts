import {
  ItemView,
  MarkdownRenderChild,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  TFile,
  moment,
  type App,
  type Editor,
  type EventRef,
  type WorkspaceLeaf,
} from "obsidian";
import { createHash } from "crypto";
import * as nodePath from "path";
import { readFile, realpath } from "fs/promises";
import { DEFAULT_SETTINGS, StrataBoardSettingTab, openSettingsTab, openPrefilledSourceModal, type StrataBoardSettings } from "./settings";
import { DEFAULT_CARD_HEIGHT, parseCardSpec, stringifyCardSpec, type ParseResult } from "./modules/card-spec";
import { DataAdapter, type OhlcvLoadResult } from "./modules/data-adapter";
import {
  createPluginApiKeyResolver,
  createPluginCredentialStore,
  registerStoreForRedaction,
  type ApiKeyResolver,
  type CredentialStore,
} from "./modules/credentials";
import { SqliteCache } from "./modules/sqlite-cache";
import { CardService, codeBlockTypeFor } from "./modules/card-service";
import { ChartRenderer } from "./modules/chart-renderer";
import { CalendarRenderer } from "./modules/calendar-renderer";
import { WidgetRenderer } from "./modules/widget-renderer";
import { parseWidgetInput } from "./modules/widget-parser";
import { CanvasToolbar } from "./modules/toolbar";
import { ChartCardCodeBlockRenderer, type ChartCardRefreshHandle } from "./modules/chart-card-base";
import { SeriesAdapter, type SeriesLoadMeta } from "./modules/series-adapter";
import {
  openCardFileInTab,
  renderLoadError,
  renderLoadingSkeleton,
  renderParseError,
  type EmptyKind,
} from "./modules/card-status";
import { CardIndex, newSpreadId } from "./modules/card-index";
import { ensureSpreadId, hasLegacyCardRefs } from "./modules/card-ref-migration";
import { formatExpressionTitle } from "./modules/expression";
import { setRequestInterval, setAllowedLoopbackHttpOrigins } from "./modules/http";
import { redactSecrets, redactError } from "./modules/redact";
import { SeriesChartRenderer } from "./modules/series-chart-renderer";
import { buildOverlayLine, computeSeriesCorrelation, normalizeToPctChange, resolveCorrTransform, toZScore } from "./modules/overlay-lines";
import {
  DEFAULT_OVERLAY_SPEC,
  DEFAULT_SPREAD_SPEC,
  MAX_OVERLAY_SERIES,
  parseOverlaySpec,
  parseSpreadSpec,
  stringifyOverlaySpec,
  stringifySpreadSpec,
  type SeriesSpecParseResult,
} from "./modules/series-spec";
import { buildOverlaySubtitle, buildSpreadSubtitle, CORRELATION_TOOLTIP } from "./modules/series-summary";
import { ManualSymbolModal } from "./ui/manual-symbol-modal";
import { UnifiedSearchModal, type CategoryId, type SearchHistoryEntry } from "./ui/unified-search-modal";
import { SourcePickerModal, type SourcePickerEntry } from "./ui/source-picker-modal";
import { WidgetInputModal } from "./ui/widget-input-modal";
import { UnifiedCardEditModal } from "./ui/unified-card-edit-modal";
import { CalendarEditModal } from "./ui/calendar-edit-modal";
import { OverlayEditModal } from "./ui/overlay-edit-modal";
import { SpreadEditModal } from "./ui/spread-edit-modal";
import { cacheAssetKey } from "./types";
import type { AssetType, CustomSourceDef, Freq, OverlaySpec, ParsedCardSpec, ReferenceableCard, ResolvedCustomSourceDef, SeriesRef, SpreadSpec, SymbolItem } from "./types";
import { resolveDateRange, formatIsoDate, parseDateYmd, formatDateTime } from "./utils/date";
import { detectNativeFreq, maxFreq } from "./utils/frequency";
import { normalizePath, sanitizeFileNamePart } from "./utils/slug";
import { onAttached } from "./utils/dom";
import { getCanvasView, openPluginSettings, type CanvasLike } from "./utils/obsidian-internals";
import { extractCardBlock } from "./utils/card-block";
import { t, setLanguage } from "./i18n";
import { getScriptProvenance, syncScriptSources, type ScriptProvenance } from "./modules/script-sources";
import { indicatorComputeCache, syncIndicatorFiles, type IndicatorApprovalDecision, type PendingIndicatorApproval } from "./modules/indicators";
import { indicatorRegistry } from "./modules/indicators/registry";
import { runScript, isPathInside, SCRIPT_TIMEOUT_MS, type ScriptRunResult } from "./modules/script-runner";
import { parseCsvKline } from "./modules/csv-quote-client";
import { ScriptManagerModal } from "./ui/script-manager-modal";
import { SetupGuideModal } from "./ui/setup-guide-modal";
import { detachTooltipManager } from "./ui/tooltip";
import { ConfirmModal } from "./ui/confirm-modal";
import { ScriptRunConfirmModal } from "./ui/script-run-confirm-modal";
import { IndicatorConfirmModal } from "./ui/indicator-confirm-modal";
import { IndicatorDescriptionModal } from "./ui/indicator-description-modal";
import { AiPanelView, VIEW_TYPE_STRATABOARD_AI, type AiPanelHost } from "./ui/ai-panel-view";
import { isAiConfigured, type AiConnectionConfig } from "./modules/ai/client";
import type { AiTaskRequest } from "./modules/ai/tasks";
import type { AiProposal } from "./modules/ai/proposals";
import { fetchKlineSample } from "./modules/custom-quote-client";
import {
  detectBuiltinKlineFormat,
  detectJsonMapping,
  parseEastmoneyKline,
  parseMappedKline,
  parseTencentKline,
} from "./modules/quote-format-parsers";
import { CUSTOM_FORMAT_LABELS } from "./ui/custom-source-modal";
import { ensureFolder } from "./modules/daily-notes";

// The canvas interaction model (double-click → chart mode, Esc/outside
// click to exit, wheel zoom, node tagging) lives in ChartCardCodeBlockRenderer;
// this class only renders the quote chart body and the quote-specific hooks.
class QuoteCodeBlockRenderer extends ChartCardCodeBlockRenderer {
  private fcPlugin: StrataBoardPlugin;
  private result: ParseResult;
  private chartRenderer: ChartRenderer | null = null;
  // Native frequency of the source's raw rows, detected on each render; gates
  // the footer's period buttons and the edit modal's 周期 dropdown.
  private nativeFreq: Freq = "D";
  // Baseline visible range captured on first chart-mode entry; used to tell
  // whether the user actually zoomed/panned during the session.
  private appliedRange: { from: string; to: string } | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(plugin, containerEl, source, sourcePath);
    this.fcPlugin = plugin;
    this.result = parseCardSpec(source);
    this.containerEl.setAttribute("data-strataboard-block", "quote");
  }

  protected async renderBody() {
    if (this.chartRenderer) {
      this.removeChild(this.chartRenderer);
      this.chartRenderer = null;
    }
    this.appliedRange = null;
    this.containerEl.empty();

    if (!this.result.ok) {
      // 解析失败: the edit modal needs a valid spec and cannot open, so the
      // recovery entry is the card file itself (shared card-status UI).
      renderParseError(this.containerEl, this.result.error.message, () =>
        void openCardFileInTab(this.fcPlugin.app, this.sourcePath)
      );
      return;
    }

    const spec = this.result.spec;

    // 本地脚本 provenance: script-produced sources get a header line
    // (script · data-through · last run · staleness); the script rerun entry
    // lives in the load-error block below. Non-script sources leave both
    // undefined.
    const prov = spec.assetType === "custom" && spec.sourceId ? getScriptProvenance(this.fcPlugin, spec.sourceId) : null;

    // Skeleton while OHLCV data is fetched; ChartRenderer (or the error path
    // below) empties the container when done.
    renderLoadingSkeleton(this.containerEl);

    try {
      // 始终先取原始行（缓存按源的原始粒度存储），据此检测数据源的原生
      // 周期，再决定实际显示周期：只支持小级别向大级别聚合，spec.freq 比
      // 原始级别小时按原始级别钳制展示（不回写卡片文件）。
      const rawResult = await this.loadData({ ...spec, freq: "D" });
      const raw = rawResult.rows;
      this.nativeFreq = detectNativeFreq(raw);
      const effFreq = maxFreq(spec.freq, this.nativeFreq);
      let fromCache = rawResult.fromCache;
      let lastDataAt = rawResult.lastDataAt;
      let data = raw;
      if (effFreq !== "D") {
        const effResult = await this.loadData({ ...spec, freq: effFreq });
        data = effResult.rows;
        fromCache = fromCache || effResult.fromCache;
        lastDataAt = effResult.lastDataAt ?? lastDataAt;
      }
      const cachedSymbol = await this.fcPlugin.sqliteCache.lookupSymbol(
        spec.symbol,
        cacheAssetKey(spec.assetType, spec.sourceId)
      );
      const symbolInfo = cachedSymbol ? { ...cachedSymbol, assetType: "custom" as const, sourceId: spec.sourceId } : undefined;
      // Empty-state copy: cache non-empty but nothing in range → the range is
      // the problem; a cold cache with an empty response → the source is.
      const emptyKind: EmptyKind | undefined =
        data.length === 0
          ? (await this.fcPlugin.dataAdapter.hasCachedData(spec))
            ? "range-empty"
            : "source-empty"
          : undefined;
      this.chartRenderer = new ChartRenderer(this.containerEl, {
        spec,
        data,
        nativeFreq: this.nativeFreq,
        theme: spec.theme ?? "auto",
        chartType: spec.chartType ?? "candlestick",
        riseColor: this.fcPlugin.pluginSettings.riseColor,
        fallColor: this.fcPlugin.pluginSettings.fallColor,
        symbolInfo,
        // In Canvas, an omitted 高度 lets the flex card fill the node and
        // therefore follows the user's Canvas resize. Outside Canvas keep a
        // readable standalone-note baseline. A YAML 高度 is the manual mode.
        height: spec.height ?? (this.findCanvasNodeEl() ? undefined : DEFAULT_CARD_HEIGHT),
        onIndicatorLabelClick: (indicatorId) => void this.fcPlugin.openIndicatorDescription(indicatorId),
        indicators: spec.indicators ?? [],
        showLegend: spec.showLegend ?? this.fcPlugin.pluginSettings.showChartLegend,
        legendFrosted: spec.legendFrosted ?? this.fcPlugin.pluginSettings.legendFrostedBackground,
        legendOpacity: spec.legendOpacity ?? this.fcPlugin.pluginSettings.legendBackgroundOpacity,
        showGrid: spec.showGrid ?? this.fcPlugin.pluginSettings.showChartGrid,
        gridOpacity: spec.gridOpacity ?? this.fcPlugin.pluginSettings.gridOpacity,
        scriptInfo: prov
          ? {
              scriptName: prov.scriptFile?.basename ?? prov.def.name,
              lastRun: prov.outputFile?.stat.mtime ?? null,
              // Edited after the output was last written → the data no
              // longer reflects the script.
              scriptStale:
                !!prov.scriptFile && !!prov.outputFile && prov.scriptFile.stat.mtime > prov.outputFile.stat.mtime,
            }
          : undefined,
        cacheBadge: fromCache ? { lastDataAt } : undefined,
        emptyKind,
        // Canvas view mode swallows clicks for node select/drag — only chart
        // mode (or plain reading mode, where there is no canvas node) turns a
        // bar click into a daily-note jump.
        onDateClick: (ymd) => {
          if (!this.chartActive && this.findCanvasNodeEl()) return;
          void openDailyNote(this.fcPlugin.app, ymd);
        },
        onRefresh: () => this.refreshCard(),
        onSwitchFreq: (freq) => void this.switchFrequency(freq),
        onEdit: () => this.openEditModal(),
      });
      this.addChild(this.chartRenderer);
    } catch (e) {
      renderLoadError(this.containerEl, e, {
        onRetry: () => this.refreshCard(),
        onEditSource: () => openSettingsTab(this.fcPlugin.app, "data-sources"),
        onRunScript: prov ? () => this.fcPlugin.runScriptForSource(prov.def.id) : undefined,
      });
    }
  }

  protected whenChartReady(): Promise<void> {
    return this.chartRenderer?.whenReady() ?? Promise.resolve();
  }

  protected onChartModeEnter() {
    // Capture the settled baseline lazily on first entry: by then the chart
    // has laid out and applied its initial range (persisted custom dates,
    // preset, or fitContent).
    this.appliedRange ??= this.chartRenderer?.getVisibleRangeYmd() ?? null;
  }

  // Persists a user-changed visible range into the card spec when chart mode
  // exits — exactly one write, only when the range actually changed during
  // the session. The write re-renders the block; the fresh instance is
  // inactive, so no further writes happen (no loop).
  protected onChartModeExit() {
    if (!this.result.ok || !this.chartRenderer) return;
    const current = this.chartRenderer.getVisibleRangeYmd();
    if (!current) return;
    const baseline = this.appliedRange ?? this.chartRenderer.getInitialVisibleRangeYmd();
    if (!baseline) return;
    if (current.from === baseline.from && current.to === baseline.to) return;
    const spec = this.result.spec;
    if (current.from === spec.visibleStart && current.to === spec.visibleEnd) return;
    void this.saveSpec({ ...spec, visibleStart: current.from, visibleEnd: current.to });
  }

  protected onChartWheel(event: WheelEvent) {
    this.chartRenderer?.applyTimeAxisWheelZoom(event.deltaY, event.clientX);
  }

  protected forcePaint() {
    this.chartRenderer?.forcePaint();
  }

  private async loadData(spec: ParsedCardSpec): Promise<OhlcvLoadResult> {
    if (this.fcPlugin.pluginSettings.autoRefreshOnOpen) {
      return this.fcPlugin.dataAdapter.loadOhlcv(spec);
    }
    const cached = await this.fcPlugin.dataAdapter.loadCachedOhlcv(spec);
    if (cached.length > 0) {
      // A deliberate cache read (auto-refresh off) is not a failure fallback.
      return { rows: cached, fromCache: false };
    }
    // First use (or cache miss): fetch once even when auto-refresh is off,
    // otherwise a card with an empty cache shows 无数据 forever.
    return this.fcPlugin.dataAdapter.loadOhlcv(spec);
  }

  private async switchFrequency(freq: Freq) {
    if (!this.result.ok) return;
    await this.saveSpec({ ...this.result.spec, freq });
  }

  protected openEditModal() {
    if (!this.result.ok) return;
    const spec = this.result.spec;
    // Resolve the defaulted display fields so the modal shows the values the
    // card is actually rendered with.
    const resolved: ParsedCardSpec = {
      ...spec,
      chartType: spec.chartType ?? "candlestick",
      theme: spec.theme ?? "auto",
    };
    new UnifiedCardEditModal(this.fcPlugin.app, {
      spec: resolved,
      minFreq: this.nativeFreq,
      openSymbolPicker: (onSelect, sourceId) => this.fcPlugin.openSymbolSearch(onSelect, sourceId),
      customSources: this.fcPlugin.enabledCustomSources(),
      indicatorGroups: this.fcPlugin.pluginSettings.indicatorGroups,
      onSubmit: (newSpec) => {
        void this.saveSpec(newSpec);
      },
    }).open();
  }

  private async saveSpec(newSpec: ParsedCardSpec) {
    try {
      await this.fcPlugin.cardService.updateCardSpec(this.sourcePath, newSpec);
      this.result = { ok: true, spec: newSpec };
      await this.runRender();
    } catch (e) {
      new Notice(t("保存卡片设置失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
    }
  }
}

class WidgetCodeBlockRenderer extends MarkdownRenderChild {
  private plugin: StrataBoardPlugin;
  private source: string;
  private sourcePath: string;
  private result: ParseResult;
  private widgetRenderer: WidgetRenderer | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.source = source;
    this.sourcePath = sourcePath;
    this.result = parseCardSpec(source, { height: DEFAULT_CARD_HEIGHT });
  }

  onload() {
    this.render();
  }

  private render() {
    this.containerEl.empty();
    this.containerEl.addClass("strataboard-card");
    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());

    if (!this.result.ok) {
      this.containerEl.createDiv({
        text: t("错误：{msg}", { msg: this.result.error.message }),
        cls: "strataboard-error",
      });
      return;
    }

    const spec = this.result.spec;
    this.widgetRenderer = new WidgetRenderer(this.containerEl, spec, {
      height: this.plugin.pluginSettings.widgetIframeHeight,
      plugin: this.plugin,
      sourcePath: this.sourcePath,
    });
    this.addChild(this.widgetRenderer);
  }

  private tagParentPreviewAsCard() {
    let el: HTMLElement | null = this.containerEl;
    let canvasNode: HTMLElement | null = null;
    let markdownPreview: HTMLElement | null = null;

    while (el) {
      if (el.classList.contains("canvas-node")) {
        canvasNode = el;
      }
      if (el.classList.contains("markdown-preview-view")) {
        markdownPreview = el;
      }
      el = el.parentElement;
    }

    if (canvasNode) {
      canvasNode.classList.add("strataboard-card-note");
      if (markdownPreview) {
        markdownPreview.classList.add("strataboard-card-note");
      }
    }
  }
}

class CalendarCodeBlockRenderer extends MarkdownRenderChild {
  private plugin: StrataBoardPlugin;
  private sourcePath: string;
  private result: ParseResult;
  private calendarRenderer: CalendarRenderer | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.result = parseCardSpec(source, { height: DEFAULT_CARD_HEIGHT });
  }

  onload() {
    this.render();
  }

  private render() {
    this.containerEl.empty();
    this.containerEl.addClass("strataboard-card");
    onAttached(this.containerEl, () => this.tagParentPreviewAsCard());

    if (!this.result.ok) {
      this.containerEl.createDiv({
        text: t("错误：{msg}", { msg: this.result.error.message }),
        cls: "strataboard-error",
      });
      return;
    }

    this.calendarRenderer = new CalendarRenderer(this.containerEl, {
      app: this.plugin.app,
      spec: this.result.spec,
      getDailyNotesSettings: () => ({
        dailyNotesFolder: this.plugin.pluginSettings.dailyNotesFolder,
        dailyNotesFormat: this.plugin.pluginSettings.dailyNotesFormat,
      }),
      getDisplaySettings: () => ({
        calendarExcerptFontSize: this.plugin.pluginSettings.calendarExcerptFontSize,
        calendarDayFontSize: this.plugin.pluginSettings.calendarDayFontSize,
        calendarExcerptLineHeight: this.plugin.pluginSettings.calendarExcerptLineHeight,
        calendarExcerptMaxLines: this.plugin.pluginSettings.calendarExcerptMaxLines,
      }),
      onOpenEditor: () => this.openEditModal(),
    });
    this.addChild(this.calendarRenderer);
  }

  private openEditModal() {
    if (!this.result.ok) return;
    const spec = this.result.spec;
    const settings = this.plugin.pluginSettings;
    new CalendarEditModal(
      this.plugin.app,
      { month: spec.calendarMonth, height: spec.height },
      {
        dayFontSize: settings.calendarDayFontSize,
        excerptFontSize: settings.calendarExcerptFontSize,
        maxLines: settings.calendarExcerptMaxLines,
      },
      (result) => {
        // The display steppers edit PLUGIN-GLOBAL settings; 月份/高度 persist
        // into the card spec (the file modify re-renders the card).
        settings.calendarDayFontSize = result.display.dayFontSize;
        settings.calendarExcerptFontSize = result.display.excerptFontSize;
        settings.calendarExcerptMaxLines = result.display.maxLines;
        void this.plugin.saveSettings();
        void this.plugin.cardService.updateCardSpec(this.sourcePath, {
          ...spec,
          calendarMonth: result.month,
          height: result.height ?? DEFAULT_CARD_HEIGHT,
        });
      }
    ).open();
  }

  private tagParentPreviewAsCard() {
    let el: HTMLElement | null = this.containerEl;
    let canvasNode: HTMLElement | null = null;
    let markdownPreview: HTMLElement | null = null;

    while (el) {
      if (el.classList.contains("canvas-node")) {
        canvasNode = el;
      }
      if (el.classList.contains("markdown-preview-view")) {
        markdownPreview = el;
      }
      el = el.parentElement;
    }

    if (canvasNode) {
      canvasNode.classList.add("strataboard-card-note");
      if (markdownPreview) {
        markdownPreview.classList.add("strataboard-card-note");
      }
    }
  }
}
// Opens (creating if missing) the daily note for a clicked chart bar. The
// core 日记 plugin supplies the filename format/folder; the note opens in a
// new tab so the canvas keeps its place.
async function openDailyNote(app: App, ymd: string): Promise<void> {
  const dailyNotes = (
    app as unknown as {
      internalPlugins?: {
        getPluginById?: (id: string) => {
          enabled?: boolean;
          instance?: { options?: { format?: string; folder?: string } };
        } | null;
      };
    }
  ).internalPlugins?.getPluginById?.("daily-notes");
  if (!dailyNotes?.enabled) {
    new Notice(t("点击 K 线打开日记需要先启用核心插件「日记」。"));
    return;
  }
  const format = dailyNotes.instance?.options?.format?.trim() || "YYYY-MM-DD";
  const folder = (dailyNotes.instance?.options?.folder ?? "").replace(/^\/+|\/+$/g, "");
  const path = `${folder ? `${folder}/` : ""}${moment(ymd, "YYYY-MM-DD").format(format)}.md`;
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) {
    try {
      file = await app.vault.create(path, "");
    } catch (e) {
      new Notice(t("无法创建日记 {path}：{msg}", { path, msg: e instanceof Error ? e.message : String(e) }));
      return;
    }
  }
  if (file instanceof TFile) {
    await app.workspace.getLeaf("tab").openFile(file);
  }
}

// Collects the distinct script-produced sources behind a card's series
// (quote legs only — a card leg's provenance shows on its own card), feeding
// the header 本地脚本 note and the run button.
function collectScriptProvenances(plugin: StrataBoardPlugin, series: SeriesRef[]): ScriptProvenance[] {
  const provs = new Map<string, ScriptProvenance>();
  for (const ref of series) {
    if (ref.source !== "quote" || !ref.sourceId) continue;
    const prov = getScriptProvenance(plugin, ref.sourceId);
    if (prov) provs.set(prov.def.id, prov);
  }
  return [...provs.values()];
}

// "含本地脚本：foo（2026-10-05 08:00）· bar（从未）" — one entry per
// script-produced source, with its last-run stamp.
function formatScriptNote(provs: ScriptProvenance[]): string {
  return t("含本地脚本：{scripts}", {
    scripts: provs
      .map((p) => {
        const name = p.scriptFile?.basename ?? p.def.name;
        const time = p.outputFile ? formatDateTime(p.outputFile.stat.mtime) : t("从未");
        return `${name}（${time}）`;
      })
      .join(" · "),
  });
}

class OverlayCodeBlockRenderer extends ChartCardCodeBlockRenderer {
  private fcPlugin: StrataBoardPlugin;
  private result: SeriesSpecParseResult<OverlaySpec>;
  private chartRenderer: SeriesChartRenderer | null = null;
  // Baseline visible range captured on first chart-mode entry; used to tell
  // whether the user actually zoomed/panned during the session.
  private appliedRange: { from: string; to: string } | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(plugin, containerEl, source, sourcePath);
    this.fcPlugin = plugin;
    this.result = parseOverlaySpec(source);
    this.containerEl.setAttribute("data-strataboard-block", "overlay");
  }

  protected async renderBody() {
    if (this.chartRenderer) {
      this.removeChild(this.chartRenderer);
      this.chartRenderer = null;
    }
    this.appliedRange = null;
    this.containerEl.empty();

    if (!this.result.spec) {
      // 解析失败: the edit modal needs a valid spec and cannot open, so the
      // recovery entry is the card file itself (shared card-status UI).
      renderParseError(this.containerEl, this.result.error ?? t("无效的卡片配置。"), () =>
        void openCardFileInTab(this.fcPlugin.app, this.sourcePath)
      );
      return;
    }
    const spec = this.result.spec;

    // 本地脚本 provenance for the header note (quote legs only); the script
    // rerun entry lives in the load-error block below.
    const scriptProvs = collectScriptProvenances(this.fcPlugin, spec.series);

    // Skeleton while series data is fetched; SeriesChartRenderer (or the
    // error path below) empties the container when done.
    renderLoadingSkeleton(this.containerEl);

    try {
      const period = spec.period ?? "D";
      const compareMode = spec.normalize ?? "percent";
      // Cache-serve signals from the quote legs (any leg on a failure
      // fallback → the card shows the shared cache badge).
      const meta: SeriesLoadMeta = { fromCache: false };
      const lineNames = await Promise.all(
        spec.series.map((ref) => this.fcPlugin.seriesAdapter.resolveLabel(ref))
      );
      const allPoints = await Promise.all(
        spec.series.map((ref) => this.fcPlugin.seriesAdapter.loadSeries(ref, spec.range, period, false, new Set(), meta))
      );
      // Correlation badge: each leg's transform comes from its DECLARED value
      // semantics (series kind/corr > source seriesKind > price), never from
      // the raw values — a yield level gets Δ, not a ratio return. A leg with
      // corr: none opts out; the subtitle reports the exclusion instead. The
      // 指标 tab global switch gates the badge for every card.
      const showCorrelation = this.fcPlugin.pluginSettings.showOverlayCorrelation;
      const sourceDefOf = (ref: SeriesRef): CustomSourceDef | undefined =>
        ref.source === "quote" ? this.fcPlugin.pluginSettings.customSources.find((s) => s.id === ref.sourceId) : undefined;
      const correlation =
        showCorrelation &&
        spec.correlation !== false &&
        spec.series.length === 2 &&
        spec.series.every((ref) => resolveCorrTransform(ref, sourceDefOf(ref)) !== "none")
          ? computeSeriesCorrelation(
              allPoints[0],
              allPoints[1],
              resolveCorrTransform(spec.series[0], sourceDefOf(spec.series[0])),
              resolveCorrTransform(spec.series[1], sourceDefOf(spec.series[1]))
            )
          : undefined;
      const overlayLines = spec.series.map((ref, i) => {
        const built = buildOverlayLine(ref, allPoints[i], compareMode, lineNames[i]);
        // Per-series 缩放系数: a pure visual multiplier on the plotted values
        // (e.g. ×10 on a low-vol FX line so its swings stay visible next to a
        // stock). Applied before the z-score pass, which is scale-invariant.
        const scale = ref.scale ?? 1;
        if (scale !== 1) {
          built.line.points = built.line.points.map((p) => ({ date: p.date, value: p.value * scale }));
        }
        return built;
      });
      // z-score mode standardizes EVERY line post-hoc (including card-ref
      // legs); the result is dimensionless, so no line is percent-ish.
      if (compareMode === "zscore") {
        for (const line of overlayLines) {
          line.line.points = toZScore(line.line.points);
          line.percentish = false;
        }
      }
      // A "%" legend suffix only makes sense when every displayed line is a
      // percent-ish series.
      const displayed = overlayLines.filter((l) => l.line.points.length > 0);
      const valueSuffix =
        displayed.length > 0 && displayed.every((l) => l.percentish) ? "%" : undefined;

      // Title composes the line names plus the compare-mode marker; a YAML
      // 标题 overrides the whole composition (mode marker included).
      let title: string;
      if (spec.title) {
        title = spec.title;
      } else {
        title = t("对比（{names}）", { names: lineNames.join("+") });
        if (compareMode === "percent") title += t("（归一化）");
        else if (compareMode === "zscore") title += t("（标准化）");
        else if (compareMode === "axis") title += t("（独立纵轴）");
      }

      // Subtitle: period · range · compare mode in short form, plus the mode
      // explanation (rebase dates for percent) and 缩放系数 badges for any
      // non-1 scales (series-summary.ts, shared with the headless renderer).
      const subtitle = buildOverlaySubtitle(
        spec,
        lineNames,
        allPoints.map((points) => points[0]?.date),
        correlation,
        showCorrelation
      );

      this.containerEl.empty();
      // Empty-state copy: any leg with cached rows outside the range (or a
      // referenced card, conservatively) → the range is the problem; all
      // quote legs on a cold cache → the source is.
      const emptyKind: EmptyKind | undefined =
        displayed.length === 0 ? await this.resolveEmptyKind(spec) : undefined;
      this.chartRenderer = new SeriesChartRenderer(this.containerEl, {
        title,
        subtitle,
        // The badge's hover explanation only makes sense when the card can
        // show a correlation (two series, not switched off globally or per card).
        subtitleTooltip:
          showCorrelation && spec.series.length === 2 && spec.correlation !== false ? t(CORRELATION_TOOLTIP) : undefined,
        scriptNote: scriptProvs.length > 0 ? formatScriptNote(scriptProvs) : undefined,
        lines: overlayLines.map((l) => (spec.lineType ? { ...l.line, lineType: spec.lineType } : l.line)),
        valueSuffix,
        theme: spec.theme ?? "auto",
        riseColor: this.fcPlugin.pluginSettings.riseColor,
        fallColor: this.fcPlugin.pluginSettings.fallColor,
        independentScales: compareMode === "axis",
        initialVisibleRange: spec.viewStart && spec.viewEnd ? { from: spec.viewStart, to: spec.viewEnd } : undefined,
        onEdit: () => this.openEditModal(),
        onRefresh: () => this.refreshCard(),
        freq: period,
        cacheBadge: meta.fromCache ? { lastDataAt: meta.lastDataAt } : undefined,
        emptyKind,
        showLegend: spec.showLegend ?? this.fcPlugin.pluginSettings.showChartLegend,
        legendFrosted: spec.legendFrosted ?? this.fcPlugin.pluginSettings.legendFrostedBackground,
        legendOpacity: spec.legendOpacity ?? this.fcPlugin.pluginSettings.legendBackgroundOpacity,
        showLatestValue: spec.showLatestValue ?? this.fcPlugin.pluginSettings.showSeriesLatestValue,
        showPointMarkers: spec.showPointMarkers ?? this.fcPlugin.pluginSettings.showSeriesPointMarkers,
        showGrid: spec.showGrid ?? this.fcPlugin.pluginSettings.showChartGrid,
        gridOpacity: spec.gridOpacity ?? this.fcPlugin.pluginSettings.gridOpacity,
      });
      this.addChild(this.chartRenderer);
    } catch (e) {
      renderLoadError(this.containerEl, e, {
        onRetry: () => this.refreshCard(),
        onEditSource: () => openSettingsTab(this.fcPlugin.app, "data-sources"),
        onRunScript:
          scriptProvs.length > 0
            ? async () => {
                for (const p of scriptProvs) await this.fcPlugin.runScriptForSource(p.def.id);
              }
            : undefined,
      });
    }
  }

  // source-empty vs range-empty for the shared empty state (see card-status):
  // a quote leg with ANY cached rows, or a referenced spread card
  // (conservatively assumed to hold data outside the range), makes it a range
  // problem; only all-cold quote legs mean the source returned nothing.
  private async resolveEmptyKind(spec: OverlaySpec): Promise<EmptyKind> {
    const flags = await Promise.all(
      spec.series.map(async (ref) => {
        if (ref.source === "card") return true;
        return this.fcPlugin.dataAdapter.hasCachedData({
          symbol: ref.tsCode!,
          assetType: ref.assetType!,
          sourceId: ref.sourceId,
          profile: ref.profile,
          freq: "D",
          range: spec.range,
          version: 1,
        });
      })
    );
    return flags.some(Boolean) ? "range-empty" : "source-empty";
  }

  protected openEditModal() {
    if (!this.result.spec) return;
    new OverlayEditModal(
      this.fcPlugin.app,
      this.result.spec,
      (newSpec) => {
        void this.fcPlugin.updateOverlayCard(this.sourcePath, newSpec);
      },
      (onSelect, sourceId) => this.fcPlugin.openSymbolSearch(onSelect, sourceId),
      () => this.fcPlugin.listReferenceableCards(),
      undefined,
      this.fcPlugin.enabledCustomSources(),
      (ref) => this.fcPlugin.seriesAdapter.resolveLabelSync(ref)
    ).open();
  }

  protected onChartModeEnter() {
    // Capture the settled baseline lazily on first entry: by then the chart
    // has laid out and applied the persisted range (or fitContent).
    this.appliedRange ??= this.chartRenderer?.getVisibleRangeYmd() ?? null;
  }

  // Persists a user-changed visible range into the card YAML on chart-mode
  // exit — exactly one write, only when the range actually changed during
  // the session. The write re-renders the block; the fresh instance is
  // inactive, so no further writes happen (no loop).
  protected onChartModeExit() {
    const current = this.chartRenderer?.getVisibleRangeYmd();
    const spec = this.result.spec;
    if (!current || !spec) return;
    const baseline = this.appliedRange;
    if (baseline && current.from === baseline.from && current.to === baseline.to) return;
    if (current.from === spec.viewStart && current.to === spec.viewEnd) return;
    const newSpec: OverlaySpec = { ...spec, viewStart: current.from, viewEnd: current.to };
    this.result = { spec: newSpec };
    void this.fcPlugin.updateOverlayCard(this.sourcePath, newSpec);
  }

  protected onChartWheel(event: WheelEvent) {
    // The changed logical range is picked up by onChartModeExit's persist.
    this.chartRenderer?.applyTimeAxisWheelZoom(event.deltaY, event.clientX);
  }

  protected forcePaint() {
    this.chartRenderer?.forcePaint();
  }
}

class SpreadCodeBlockRenderer extends ChartCardCodeBlockRenderer {
  private fcPlugin: StrataBoardPlugin;
  private result: SeriesSpecParseResult<SpreadSpec>;
  private chartRenderer: SeriesChartRenderer | null = null;
  private appliedRange: { from: string; to: string } | null = null;

  constructor(plugin: StrataBoardPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(plugin, containerEl, source, sourcePath);
    this.fcPlugin = plugin;
    this.result = parseSpreadSpec(source);
    this.containerEl.setAttribute("data-strataboard-block", "spread");
  }

  protected async renderBody() {
    if (this.chartRenderer) {
      this.removeChild(this.chartRenderer);
      this.chartRenderer = null;
    }
    this.appliedRange = null;
    this.containerEl.empty();

    if (!this.result.spec) {
      // 解析失败: the edit modal needs a valid spec and cannot open, so the
      // recovery entry is the card file itself (shared card-status UI).
      renderParseError(this.containerEl, this.result.error ?? t("无效的卡片配置。"), () =>
        void openCardFileInTab(this.fcPlugin.app, this.sourcePath)
      );
      return;
    }
    let spec = this.result.spec;

    // Older spread cards predate the id field: write one back on first
    // render (silent — no "已保存" popup for an automatic write) so other
    // cards can reference this card by id. The modify re-renders the block,
    // but the fresh instance already has an id, so no loop.
    if (!spec.id) {
      spec = { ...spec, id: newSpreadId() };
      this.result = { spec };
      void this.fcPlugin.updateSpreadCard(this.sourcePath, spec, true);
    }

    // 本地脚本 provenance for the header note (quote legs only); the script
    // rerun entry lives in the load-error block below.
    const scriptProvs = collectScriptProvenances(this.fcPlugin, spec.series);

    renderLoadingSkeleton(this.containerEl);

    try {
      const labels = await Promise.all(
        spec.series.map((ref) => this.fcPlugin.seriesAdapter.resolveLabel(ref))
      );
      const meta: SeriesLoadMeta = { fromCache: false };
      const points = await this.fcPlugin.seriesAdapter.loadSpread(spec, spec.range, spec.period ?? "D", new Set(), meta);
      const title = spec.title ?? formatExpressionTitle(spec.expression, labels);

      this.containerEl.empty();
      const emptyKind: EmptyKind | undefined =
        points.length === 0 ? await this.resolveEmptyKind(spec) : undefined;
      this.chartRenderer = new SeriesChartRenderer(this.containerEl, {
        title,
        // "= A-B · 日线 · 近10年" (series-summary.ts, shared with headless).
        subtitle: buildSpreadSubtitle(spec),
        scriptNote: scriptProvs.length > 0 ? formatScriptNote(scriptProvs) : undefined,
        lines: [{ name: title, points, color: spec.lineColor, lineWidth: spec.lineWidth, lineType: spec.lineType, style: spec.style }],
        theme: spec.theme ?? "auto",
        riseColor: this.fcPlugin.pluginSettings.riseColor,
        fallColor: this.fcPlugin.pluginSettings.fallColor,
        initialVisibleRange: spec.viewStart && spec.viewEnd ? { from: spec.viewStart, to: spec.viewEnd } : undefined,
        onEdit: () => this.openEditModal(),
        onRefresh: () => this.refreshCard(),
        freq: spec.period ?? "D",
        cacheBadge: meta.fromCache ? { lastDataAt: meta.lastDataAt } : undefined,
        emptyKind,
        showLegend: spec.showLegend ?? this.fcPlugin.pluginSettings.showChartLegend,
        legendFrosted: spec.legendFrosted ?? this.fcPlugin.pluginSettings.legendFrostedBackground,
        legendOpacity: spec.legendOpacity ?? this.fcPlugin.pluginSettings.legendBackgroundOpacity,
        showLatestValue: spec.showLatestValue ?? this.fcPlugin.pluginSettings.showSeriesLatestValue,
        showPointMarkers: spec.showPointMarkers ?? this.fcPlugin.pluginSettings.showSeriesPointMarkers,
        showGrid: spec.showGrid ?? this.fcPlugin.pluginSettings.showChartGrid,
        gridOpacity: spec.gridOpacity ?? this.fcPlugin.pluginSettings.gridOpacity,
      });
      this.addChild(this.chartRenderer);
    } catch (e) {
      renderLoadError(this.containerEl, e, {
        onRetry: () => this.refreshCard(),
        onEditSource: () => openSettingsTab(this.fcPlugin.app, "data-sources"),
        onRunScript:
          scriptProvs.length > 0
            ? async () => {
                for (const p of scriptProvs) await this.fcPlugin.runScriptForSource(p.def.id);
              }
            : undefined,
      });
    }
  }

  // Same source-empty vs range-empty distinction as the overlay wrapper.
  private async resolveEmptyKind(spec: SpreadSpec): Promise<EmptyKind> {
    const flags = await Promise.all(
      spec.series.map(async (ref) => {
        if (ref.source === "card") return true;
        return this.fcPlugin.dataAdapter.hasCachedData({
          symbol: ref.tsCode!,
          assetType: ref.assetType!,
          sourceId: ref.sourceId,
          profile: ref.profile,
          freq: "D",
          range: spec.range,
          version: 1,
        });
      })
    );
    return flags.some(Boolean) ? "range-empty" : "source-empty";
  }

  protected openEditModal() {
    if (!this.result.spec) return;
    new SpreadEditModal(
      this.fcPlugin.app,
      this.result.spec,
      (newSpec) => {
        void this.fcPlugin.updateSpreadCard(this.sourcePath, newSpec);
      },
      (onSelect, sourceId) => this.fcPlugin.openSymbolSearch(onSelect, sourceId),
      undefined,
      this.fcPlugin.enabledCustomSources()
    ).open();
  }

  protected onChartModeEnter() {
    this.appliedRange ??= this.chartRenderer?.getVisibleRangeYmd() ?? null;
  }

  // Same persist-on-exit discipline as the overlay wrapper (see there).
  protected onChartModeExit() {
    const current = this.chartRenderer?.getVisibleRangeYmd();
    const spec = this.result.spec;
    if (!current || !spec) return;
    const baseline = this.appliedRange;
    if (baseline && current.from === baseline.from && current.to === baseline.to) return;
    if (current.from === spec.viewStart && current.to === spec.viewEnd) return;
    const newSpec: SpreadSpec = { ...spec, viewStart: current.from, viewEnd: current.to };
    this.result = { spec: newSpec };
    void this.fcPlugin.updateSpreadCard(this.sourcePath, newSpec);
  }

  protected onChartWheel(event: WheelEvent) {
    this.chartRenderer?.applyTimeAxisWheelZoom(event.deltaY, event.clientX);
  }

  protected forcePaint() {
    this.chartRenderer?.forcePaint();
  }
}

export default class StrataBoardPlugin extends Plugin {
  pluginSettings!: StrataBoardSettings;
  sqliteCache!: SqliteCache;
  dataAdapter!: DataAdapter;
  // Central credential seam (modules/credentials.ts): the only way UI, probe
  // and data requests reach a runtime secret.
  credentials!: CredentialStore;
  resolveApiKey!: ApiKeyResolver;
  seriesAdapter!: SeriesAdapter;
  cardIndex!: CardIndex;
  cardService!: CardService;
  toolbar!: CanvasToolbar;
  // Live chart card renderers; the script-output invalidation re-renders all
  // of them (renderers register/unregister themselves in onload/onunload).
  readonly chartRenderers = new Set<ChartCardRefreshHandle>();
  // Per-path debounce timers for the script-output watcher (scripts may
  // write their CSV in several IO bursts).
  private scriptOutputTimers = new Map<string, number>();
  // Per-path debounce timers for the custom-indicator watcher (editors may
  // write the .js in bursts).
  private indicatorTimers = new Map<string, number>();

  async onload() {
    await this.loadSettings();

    const dataCachePath = this.pluginSettings.dataCachePath;
    const symbolCachePath = this.pluginSettings.symbolCachePath;

    this.sqliteCache = new SqliteCache({ vault: this.app.vault });
    await this.sqliteCache.init({
      ohlcvDbPath: `${dataCachePath}/ohlcv.db`,
      symbolsDbPath: `${symbolCachePath}/symbols.db`,
    });

    this.credentials = createPluginCredentialStore(this.app);
    this.resolveApiKey = createPluginApiKeyResolver(this.credentials);
    registerStoreForRedaction(this.credentials);

    this.dataAdapter = new DataAdapter({
      cache: this.sqliteCache,
      customSources: this.pluginSettings.customSources,
      resolveApiKey: this.resolveApiKey,
      readVaultFile: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          throw new Error(t("文件不存在：{path}", { path }));
        }
        return this.app.vault.cachedRead(file);
      },
    });

    this.cardIndex = new CardIndex(this.app, () => this.pluginSettings.cardLibraryPath);
    this.seriesAdapter = new SeriesAdapter({
      dataAdapter: this.dataAdapter,
      autoRefreshOnOpen: () => this.pluginSettings.autoRefreshOnOpen,
      host: {
        resolveCardId: (id) => this.cardIndex.resolve(id),
        resolveCardIdSync: (id) => this.cardIndex.resolveSync(id),
        readCardFile: async (path) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) return null;
          return this.app.vault.cachedRead(file);
        },
      },
    });

    this.cardService = new CardService({
      app: this.app,
      cardLibraryPath: this.pluginSettings.cardLibraryPath,
      widgetCardPath: this.pluginSettings.widgetCardPath,
      componentCardPath: this.pluginSettings.componentCardPath,
      resolveSourceName: (sourceId) => this.pluginSettings.customSources.find((s) => s.id === sourceId)?.name,
    });

    this.toolbar = new CanvasToolbar(this, () => void this.openAiPanel());

    this.addSettingTab(new StrataBoardSettingTab(this.app, this));

    // AI task panel (right sidebar). First registerView/ItemView in the
    // plugin; the host seam keeps the view out of settings/credentials.
    this.registerView(VIEW_TYPE_STRATABOARD_AI, (leaf) => new AiPanelView(leaf, this.buildAiPanelHost()));

    this.addCommand({
      id: "open-settings",
      name: t("打开 StrataBoard 设置"),
      callback: () => {
        openPluginSettings(this.app, this.manifest.id);
      },
    });

    this.addCommand({
      id: "insert-financial-card",
      name: t("插入数据卡"),
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            this.insertAssetDataCard();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "insert-widget-card",
      name: t("插入 HTML / TradingView 小组件"),
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            this.openWidgetInputModal();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "insert-calendar-card",
      name: t("插入日历卡片"),
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            void this.insertCalendarCard();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "insert-overlay-card",
      name: t("创建对比卡"),
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            void this.insertOverlayCard();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "insert-spread-card",
      name: t("创建计算卡"),
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (view?.getViewType() === "canvas") {
          if (!checking) {
            void this.insertSpreadCard();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "open-script-manager",
      name: t("打开本地脚本管理"),
      callback: () => this.openScriptManager(),
    });

    this.addCommand({
      id: "open-ai-panel",
      name: t("打开 AI 助手面板"),
      callback: () => void this.openAiPanel(),
    });

    // The chart-card processors RETURN the initial-render promise: Obsidian
    // collects post-processor promises and awaits them before capturing the
    // page, which is what makes 导出为 PDF wait for the chart instead of
    // snapshotting the loading skeleton.
    this.registerMarkdownCodeBlockProcessor("quote", (source, el, ctx) => {
      const renderer = new QuoteCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
      return renderer.whenReady();
    });

    this.registerMarkdownCodeBlockProcessor("financial-widget", (source, el, ctx) => {
      const renderer = new WidgetCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerMarkdownCodeBlockProcessor("calendar", (source, el, ctx) => {
      const renderer = new CalendarCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
    });

    this.registerMarkdownCodeBlockProcessor("overlay", (source, el, ctx) => {
      const renderer = new OverlayCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
      return renderer.whenReady();
    });

    this.registerMarkdownCodeBlockProcessor("spread", (source, el, ctx) => {
      const renderer = new SpreadCodeBlockRenderer(this, el, source, ctx.sourcePath);
      ctx.addChild(renderer);
      return renderer.whenReady();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
        this.attachToolbarToCanvas(leaf);
      })
    );

    // Md-note insertion: same card flows as the canvas, but the finished spec
    // is written as a fenced code block at the cursor instead of creating a
    // card file + canvas node. The editor captured here stays valid while its
    // leaf lives; the modals below run long after the menu closes.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        menu.addItem((item) => {
          item
            .setTitle(t("插入卡片"))
            .setIcon("line-chart")
            .onClick(() => this.insertCardIntoMd(editor));
        });
      })
    );

    // Canvas node context menu: 「编辑…卡」opens the same edit modal the
    // double-click flow uses. The item must be added SYNCHRONOUSLY (Obsidian's
    // Menu.addItem is a no-op once the menu is shown), so the card type is
    // read from the rendered node's data-strataboard-block attribute instead
    // of an async file read; the click handler then parses the file.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source) => {
        if (source !== "canvas-menu") return;
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const type = this.detectCanvasCardType(file);
        if (!type) return;
        const titles: Record<string, string> = {
          quote: t("编辑数据卡"),
          overlay: t("编辑对比卡"),
          spread: t("编辑计算卡"),
        };
        menu.addItem((item) => {
          item
            .setTitle(titles[type])
            .setIcon("pencil")
            .onClick(() => void this.openCardEditorFromMenu(file, type));
        });
        // Quote and spread cards can seed a compare/calc card; overlay cards
        // are excluded for the same reason listReferenceableCards skips them
        // (a normalized line has no single referable series).
        if (type === "quote" || type === "spread") {
          menu.addItem((item) => {
            item
              .setTitle(t("加入序列进行对比"))
              .setIcon("layers")
              .onClick(() => void this.openDerivedSeriesCard(file, type, "overlay"));
          });
          menu.addItem((item) => {
            item
              .setTitle(type === "spread" ? t("以此计算卡创建计算") : t("以此序列创建计算"))
              .setIcon("calculator")
              .onClick(() => void this.openDerivedSeriesCard(file, type, "spread"));
          });
        }
      })
    );

    // Canvas MULTI-selection context menu: right-clicking 2+ selected nodes
    // does not go through "file-menu" — the canvas triggers the internal
    // "canvas:selection-menu" workspace event (event name verified against
    // the bundled app.js reference copy). Items must be added synchronously
    // (Menu.addItem is a no-op once the menu is shown), so card types are
    // read from node DOM attributes and the files are parsed on click.
    this.registerEvent(
      (this.app.workspace.on as unknown as (
        name: string,
        callback: (menu: Menu, canvas: CanvasLike) => void
      ) => EventRef).call(this.app.workspace, "canvas:selection-menu", (menu, canvas) => {
        this.addSelectionSeriesItems(menu, canvas);
      })
    );

    // Script-output watcher (本地脚本): a script rewriting its CSV is
    // invisible to the incremental cache (the cached extent already covers
    // the rewritten history), so a modify clears the matching source's cache
    // keys and re-renders every chart card; a create registers the new file
    // as a source. Deletes are left to manual source management (settings
    // 自定义数据源 list). Debounced per file — scripts may write in bursts.
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.isScriptOutputFile(file)) {
          this.debounceScriptOutput(file.path, () => void syncScriptSources(this));
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.isScriptOutputFile(file)) {
          this.debounceScriptOutput(file.path, () => void this.invalidateScriptOutput(file.path));
        }
      })
    );

    // Register script outputs that already exist (first run / plugin reload).
    void syncScriptSources(this);

    // Custom-indicator watcher (本地指标 folder): any .js change re-syncs the
    // in-memory registry; a modify/delete additionally clears the compute
    // cache and re-renders every chart card (a changed indicator must redraw
    // its lines). Debounced per file — editors may write in bursts.
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.isIndicatorFile(file)) {
          this.debounceIndicator(file.path, () => void syncIndicatorFiles(this));
        }
      })
    );
    const onIndicatorFileChanged = (file: unknown) => {
      if (!this.isIndicatorFile(file)) return;
      this.debounceIndicator(file.path, () => {
        void (async () => {
          await syncIndicatorFiles(this);
          indicatorComputeCache.clear();
          for (const renderer of this.chartRenderers) renderer.refreshCard();
        })();
      });
    };
    this.registerEvent(this.app.vault.on("modify", onIndicatorFileChanged));
    this.registerEvent(this.app.vault.on("delete", onIndicatorFileChanged));

    // Register custom indicators that already exist (first run / reload).
    void syncIndicatorFiles(this);

    // Legacy cleanup: the AI card-authoring guide used to be written into
    // the card library on every load; it now lives in 设置 → AI 助手.
    void this.removeLegacyAiGuide();

    // One-time legacy card-ref detection: cardPath refs predate the cardId
    // format. Clean vaults are flagged off silently; affected vaults get a
    // Notice pointing at the one-click upgrade (设置 → 高级 →
    // 清理维护). Deferred until the vault index is ready.
    this.app.workspace.onLayoutReady(() => void this.detectLegacyCardRefs());

    this.attachToolbarToCanvas(this.app.workspace.getActiveViewOfType(ItemView)?.leaf ?? null);
  }

  // Runs the legacy cardPath scan once per vault (settings.cardRefsUpgraded
  // gates it). Never auto-migrates: the upgrade rewrites user files, so it
  // stays an explicit click in settings. The Notice is transient — the
  // settings page already carries a persistent banner for this.
  private async detectLegacyCardRefs() {
    if (this.pluginSettings.cardRefsUpgraded) return;
    if (await hasLegacyCardRefs(this.app, this.pluginSettings.cardLibraryPath)) {
      new Notice(t("检测到旧格式（cardPath）的卡片引用，请到 设置 → 高级 → 清理维护 运行「扫描并升级卡片引用」。"));
      return;
    }
    this.pluginSettings.cardRefsUpgraded = true;
    await this.saveSettings();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_STRATABOARD_AI);
    this.toolbar.detach();
    detachTooltipManager();
    this.sqliteCache?.save().then(() => this.sqliteCache?.close()).catch((e) => {
      console.error("StrataBoard: failed to save SQLite cache on unload", e);
      this.sqliteCache?.close();
    });
  }

  async loadSettings() {
    const stored = (await this.loadData()) as Partial<StrataBoardSettings> | null;
    // Drop leftover keys from the removed built-in data sources (Tushare/FRED
    // connectors, per-source toggles) and the symbol-index refresh setting.
    if (stored) {
      const legacy = stored as Record<string, unknown>;
      delete legacy.tushareToken;
      delete legacy.fredApiKey;
      delete legacy.dataSources;
      delete legacy.symbolListRefreshIntervalDays;
      delete legacy.builtinIndicatorInputs;
      delete legacy.defaultIndicators;
      delete legacy.maMigrationDone;
      delete legacy.showChartMA;
      // Per-source toolbar visibility toggles were removed; drop the leftover.
      delete legacy.toolbarSources;
      // Custom source/group icons were removed; drop the persisted leftovers.
      delete legacy.sourceGroupIcons;
      if (Array.isArray(stored.customSources)) {
        stored.customSources = stored.customSources.filter(
          (source) => (source as CustomSourceDef & { purpose?: string }).purpose !== "signals"
        );
        // Credentials moved to SecretStorage (credentialId reference only);
        // the old plaintext apiKey field is dropped, not migrated — the user
        // re-selects the credential in the source editor.
        for (const source of stored.customSources) {
          delete (source as CustomSourceDef & { apiKey?: string }).apiKey;
          delete (source as CustomSourceDef & { icon?: string }).icon;
        }
      }
    }
    this.pluginSettings = Object.assign({}, DEFAULT_SETTINGS, stored);
    setRequestInterval(this.pluginSettings.requestIntervalMs);
    setAllowedLoopbackHttpOrigins(this.pluginSettings.allowedLoopbackHttpOrigins ?? []);
    setLanguage(this.pluginSettings.language);
    // Fresh object so a stale data.json gets the default and the live
    // settings never share a reference with DEFAULT_SETTINGS.
    this.pluginSettings.approvedScriptHashes = { ...(stored?.approvedScriptHashes ?? {}) };
    this.pluginSettings.approvedIndicatorHashes = { ...(stored?.approvedIndicatorHashes ?? {}) };
    this.pluginSettings.credentialNames = { ...(stored?.credentialNames ?? {}) };
    this.pluginSettings.indicatorOverrides = Object.fromEntries(
      Object.entries(stored?.indicatorOverrides ?? {}).map(([id, value]) => [id, {
        ...(typeof value?.name === "string" ? { name: value.name } : {}),
        ...(typeof value?.description === "string" ? { description: value.description } : {}),
        ...(value?.defaultInputs && typeof value.defaultInputs === "object" && !Array.isArray(value.defaultInputs)
          ? { defaultInputs: { ...value.defaultInputs } } : {}),
      }])
    );
    // Fresh array: never share a reference with DEFAULT_SETTINGS.
    this.pluginSettings.indicatorGroups = [...(stored?.indicatorGroups ?? [])];
    this.pluginSettings.searchHistory = [...(stored?.searchHistory ?? [])];
    this.pluginSettings.allowedLoopbackHttpOrigins = [...(stored?.allowedLoopbackHttpOrigins ?? [])];
    // Fresh object (BYOK 插件内 AI config): never share a reference with the
    // loaded snapshot.
    if (stored?.aiAssistant) this.pluginSettings.aiAssistant = { ...stored.aiAssistant };
    // Corner anchors; old "left" | "right" values (and anything unknown) map
    // to the bottom corner on the same side. Idempotent for valid values.
    const pos = this.pluginSettings.toolbarPosition as string;
    this.pluginSettings.toolbarPosition = `${pos.startsWith("top") ? "top" : "bottom"}-${
      pos.endsWith("left") ? "left" : "right"
    }`;
  }

  async saveSettings() {
    await this.saveData(this.pluginSettings);
    this.applySettings();
  }

  // Side effects shared by saveSettings (after a local write) and
  // onExternalSettingsChange (after an external one): every consumer
  // re-reads the live pluginSettings object.
  private applySettings() {
    setRequestInterval(this.pluginSettings.requestIntervalMs);
    setAllowedLoopbackHttpOrigins(this.pluginSettings.allowedLoopbackHttpOrigins);
    this.dataAdapter?.setCustomSources(this.pluginSettings.customSources);
    this.cardService?.setPaths({
      cardLibraryPath: this.pluginSettings.cardLibraryPath,
      widgetCardPath: this.pluginSettings.widgetCardPath,
      componentCardPath: this.pluginSettings.componentCardPath,
    });
    // Re-sync custom indicators on every settings write: the 指标 folder path
    // or the disabled list may have changed. Cheap and chain-serialized.
    void syncIndicatorFiles(this);
    this.toolbar?.reload();
  }

  // data.json changed on disk (sync service or external edit; the plugin's
  // own saveData writes don't fire this): reload and rewire. Settings-tab
  // edits all save immediately, so there is no unsaved state to protect; an
  // open source modal holds its own working copy and submits it whole.
  async onExternalSettingsChange() {
    await this.loadSettings();
    this.applySettings();
  }

  // Enabled custom sources, for the pickers and edit modals.
  enabledCustomSources(): CustomSourceDef[] {
    return this.pluginSettings.customSources.filter((s) => s.enabled);
  }

  // ChartCardPluginHost hooks (modules/chart-card-base.ts): the one-shot
  // 双击进入图表交互 hint shows once per vault, then stays off.
  isChartModeHintShown(): boolean {
    return this.pluginSettings.chartModeHintShown;
  }

  markChartModeHintShown(): void {
    this.pluginSettings.chartModeHintShown = true;
    void this.saveSettings();
  }

  // Trashes the pre-refactor copy of the AI guide in the card library (the
  // guide moved into 设置 → AI 助手). No-op once the file is gone.
  private async removeLegacyAiGuide() {
    try {
      const file = this.app.vault.getAbstractFileByPath(
        `${normalizePath(this.pluginSettings.cardLibraryPath)}/StrataBoard卡片编写指南.md`
      );
      if (file instanceof TFile) await this.app.fileManager.trashFile(file);
    } catch (e) {
      console.error("StrataBoard: failed to remove legacy AI guide", e);
    }
  }

  // ==================== 插件内 AI（BYOK 任务面板） ====================

  // Reveals the right-sidebar AI task panel (creating its leaf on first
  // use). With a task argument the panel starts it immediately — fix-source
  // entries carry their current-config/error context inside the request.
  async openAiPanel(task?: AiTaskRequest): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_STRATABOARD_AI)[0];
    if (!leaf) {
      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) return;
      leaf = rightLeaf;
      await leaf.setViewState({ type: VIEW_TYPE_STRATABOARD_AI, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (task) (leaf.view as AiPanelView).startTask(task);
  }

  // Host seam for the panel: BYOK config + credential resolution, the
  // proposal-validator context (same enabled-source filter as the pickers),
  // and the settings shortcut — the view never touches pluginSettings or
  // the credential store directly. Source proposals (stage 4): applyProposal
  // opens the prefilled source form (the AI never writes settings; saving
  // runs through the form's own probe/validation/credential UI), and
  // probeSourceDraft re-runs the form's detection chain read-only. Card /
  // indicator / script proposals are wired by stages 5-6.
  private buildAiPanelHost(): AiPanelHost {
    return {
      getAiConfig: () => {
        const settings = this.pluginSettings.aiAssistant;
        const cfg: AiConnectionConfig = {
          baseUrl: settings?.baseUrl ?? "",
          model: settings?.model ?? "",
          timeoutMs: settings?.timeoutMs,
          maxResponseChars: settings?.maxResponseChars,
          maxRevisionRounds: settings?.maxRevisionRounds,
          apiKey: settings?.credentialId
            ? this.credentials.get(settings.credentialId) ?? undefined
            : undefined,
        };
        return { cfg, configured: isAiConfigured(settings) };
      },
      getProposalContext: () => ({
        allowedLoopbackHttpOrigins: this.pluginSettings.allowedLoopbackHttpOrigins,
        existingSourceIds: this.enabledCustomSources().map((s) => s.id),
        sourceAliases: Object.fromEntries(this.enabledCustomSources().map((s, i) => [`源${String.fromCharCode(65 + i)}`, s.id])),
        existingIndicatorIds: indicatorRegistry.list().map((def) => def.id),
        indicatorAliases: Object.fromEntries(indicatorRegistry.list().map((def, i) => [`指标${i + 1}`, def.id])),
      }),
      getTaskContext: () => ({
        existingSources: this.enabledCustomSources().map((s, i) => ({ id: s.id, alias: `源${String.fromCharCode(65 + i)}`, name: s.name, format: s.format })),
        existingIndicators: indicatorRegistry.list().map((def, i) => ({
          id: def.id,
          alias: `指标${i + 1}`,
          name: def.name,
          overlay: def.metadata.overlay,
          ...(def.description ? { description: def.description } : {}),
        })),
      }),
      openAiSettings: () => openSettingsTab(this.app, "external-ai"),
      applyProposal: (proposal) => this.applyAiProposal(proposal),
      probeSourceDraft: (draft, sourceId) => this.probeSourceDraft(draft, sourceId),
    };
  }

  // Stage-4 proposal execution: source kinds open the source form prefilled
  // with the AI's draft / patch and count as applied the moment the form
  // opens — the user still confirms and saves inside the form. fix-source
  // merges the patch over the existing def so untouched fields survive.
  private async applyAiProposal(proposal: AiProposal): Promise<void> {
    if (proposal.kind === "add-source") {
      openPrefilledSourceModal(this.app, this, proposal.draft);
      new Notice(t("草稿已填入表单，请在表单中确认并保存。"));
      return;
    }
    if (proposal.kind === "fix-source") {
      const existing = this.pluginSettings.customSources.find((s) => s.id === proposal.sourceId);
      if (!existing) {
        new Notice(t("数据源「{id}」不存在或已删除，无法应用修复。", { id: proposal.sourceId }));
        return;
      }
      openPrefilledSourceModal(this.app, this, { ...existing, ...proposal.patch, id: existing.id });
      new Notice(t("草稿已填入表单，请在表单中确认并保存。"));
    }
    if (proposal.kind === "quote-card") {
      new ConfirmModal(this.app, t("创建数据卡「{name}」？", { name: proposal.spec.title ?? proposal.spec.symbol }), () => {
        void this.cardService.createOrReuse(proposal.spec, undefined, proposal.spec.title ?? proposal.spec.symbol)
          .then((file) => { this.toolbar.placeFileNode(file); new Notice(t("数据卡已创建：{name}", { name: file.basename })); })
          .catch((e) => new Notice(t("创建数据卡失败：{msg}", { msg: e instanceof Error ? e.message : String(e) })));
      }).open();
      return;
    }
    if (proposal.kind === "overlay-card") {
      new ConfirmModal(this.app, t("创建对比卡？"), () => void this.createOverlayCard(proposal.spec)).open();
      return;
    }
    if (proposal.kind === "spread-card") {
      new ConfirmModal(this.app, t("创建计算卡？"), () => void this.createSpreadCard(proposal.spec)).open();
      return;
    }
    if (proposal.kind === "indicator") {
      const folder = normalizePath(this.pluginSettings.indicatorFolderPath);
      const filename = `${proposal.title.replace(/[^a-zA-Z0-9一-龥_-]/g, "-").replace(/^-+|-+$/g, "") || "indicator"}.js`;
      await ensureFolder(this.app, folder);
      const path = `${folder}/${filename}`;
      const existing = this.app.vault.getAbstractFileByPath(path);
      new ConfirmModal(this.app, t("保存指标文件「{name}」？保存后仍需通过指标审批才会运行。", { name: filename }), () => {
        void (async () => {
          if (existing instanceof TFile) await this.app.vault.modify(existing, proposal.code);
          else await this.app.vault.create(path, proposal.code);
          await syncIndicatorFiles(this);
          new Notice(t("指标草稿已保存：{name}", { name: filename }));
        })().catch((e) => new Notice(t("保存指标失败：{msg}", { msg: e instanceof Error ? e.message : String(e) })));
      }).open();
      return;
    }
    if (proposal.kind === "indicator-doc") {
      const indicator = indicatorRegistry.resolve(proposal.indicatorId);
      if (!indicator) {
        new Notice(t("指标「{id}」不存在或尚未通过审批。", { id: proposal.indicatorId }));
        return;
      }
      const folder = `${normalizePath(this.pluginSettings.indicatorFolderPath)}/说明`;
      const assets = `${folder}/assets`;
      await ensureFolder(this.app, assets);
      const plotScriptFolder = `${normalizePath(this.pluginSettings.scriptFolderPath)}/ai-indicator-docs`;
      await ensureFolder(this.app, plotScriptFolder);
      const slug = sanitizeFileNamePart(proposal.indicatorId) || "indicator";
      const mdPath = `${folder}/${slug}.md`;
      const plotPath = `${assets}/${slug}.py`;
      const runnerPlotPath = `${plotScriptFolder}/${slug}.py`;
      const imageRef = `assets/${slug}.png`;
      const markdown = proposal.markdown.includes(imageRef)
        ? proposal.markdown
        : `${proposal.markdown.trim()}\n\n## Matplotlib 示意图\n\n![${proposal.title}](${imageRef})\n`;
      new ConfirmModal(this.app, t("保存指标说明「{name}」？将同时保存 Matplotlib 绘图脚本。", { name: proposal.title }), () => {
        void (async () => {
          const md = this.app.vault.getAbstractFileByPath(mdPath);
          const py = this.app.vault.getAbstractFileByPath(plotPath);
          const runner = this.app.vault.getAbstractFileByPath(runnerPlotPath);
          if (md instanceof TFile) await this.app.vault.modify(md, markdown);
          else await this.app.vault.create(mdPath, markdown);
          if (py instanceof TFile) await this.app.vault.modify(py, proposal.plotCode);
          else await this.app.vault.create(plotPath, proposal.plotCode);
          const basePath = (this.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.() ?? "";
          const absolutePng = `${basePath}/${folder}/assets/${slug}.png`;
          const runnerCode = [
            "from pathlib import Path",
            `OUTPUT_PATH = ${JSON.stringify(absolutePng)}`,
            proposal.plotCode,
            "",
            "# Best-effort final save for scripts that expose fig or pyplot.",
            "Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)",
            "if 'fig' in globals(): fig.savefig(OUTPUT_PATH, dpi=160, bbox_inches='tight')",
            "elif 'plt' in globals(): plt.savefig(OUTPUT_PATH, dpi=160, bbox_inches='tight')",
            "",
          ].join("\n");
          if (runner instanceof TFile) await this.app.vault.modify(runner, runnerCode);
          else await this.app.vault.create(runnerPlotPath, runnerCode);
          this.pluginSettings.indicatorOverrides[proposal.indicatorId] = {
            ...(this.pluginSettings.indicatorOverrides[proposal.indicatorId] ?? {}),
            description: `[[${mdPath.slice(0, -3)}]]`,
          };
          await this.saveSettings();
          new Notice(t("指标说明已保存：{name}", { name: mdPath }));
          if (runner instanceof TFile || this.app.vault.getAbstractFileByPath(runnerPlotPath) instanceof TFile) {
            const plotFile = this.app.vault.getAbstractFileByPath(runnerPlotPath);
            if (plotFile instanceof TFile) {
              const result = await this.runScriptFile(plotFile);
              if (result.code === 0 && !result.cancelled) new Notice(t("Matplotlib 示意图已生成。"));
            }
          }
        })().catch((e) => new Notice(t("保存指标说明失败：{msg}", { msg: e instanceof Error ? e.message : String(e) })));
      }).open();
      return;
    }
    if (proposal.kind === "script") {
      const folder = normalizePath(this.pluginSettings.scriptFolderPath);
      await ensureFolder(this.app, folder);
      const path = `${folder}/${proposal.filename}`;
      const existing = this.app.vault.getAbstractFileByPath(path);
      new ConfirmModal(this.app, t("保存脚本「{name}」？运行脚本时仍需单独确认。", { name: proposal.filename }), () => {
        void (async () => {
          if (existing instanceof TFile) await this.app.vault.modify(existing, proposal.code);
          else await this.app.vault.create(path, proposal.code);
          new Notice(t("脚本草稿已保存：{name}", { name: proposal.filename }));
        })().catch((e) => new Notice(t("保存脚本失败：{msg}", { msg: e instanceof Error ? e.message : String(e) })));
      }).open();
    }
  }

  // Read-only probe behind the panel's「测试并预览」: mirrors the source
  // form's detection chain (fetchKlineSample → builtin format → stored /
  // guessed JSON mapping → parse). fix-source merges the patch onto the
  // existing source and resolves its stored credential; add-source probes a
  // synthetic def with no credential. Never throws, never saves.
  private async probeSourceDraft(
    draft: Partial<CustomSourceDef>,
    sourceId?: string
  ): Promise<{ ok: true; rows: number; format: string } | { ok: false; error: string }> {
    const existing = sourceId ? this.pluginSettings.customSources.find((s) => s.id === sourceId) : undefined;
    const merged: CustomSourceDef = existing
      ? { ...existing, ...draft, id: existing.id }
      : ({
          id: "ai-draft-probe",
          name: "",
          enabled: true,
          format: "tencent",
          klineUrl: "",
          ...draft,
        } as CustomSourceDef);
    if (merged.format === "csv" || !merged.klineUrl) {
      return { ok: false, error: t("该草稿没有 K线 URL（CSV 文件源请在表单中验证）。") };
    }
    const resolved: ResolvedCustomSourceDef = {
      ...merged,
      apiKey: merged.credentialId ? this.credentials.get(merged.credentialId) ?? undefined : undefined,
    };
    try {
      const code = merged.testCode ?? "sh000001";
      const sample = await fetchKlineSample(resolved, code);
      const builtin = detectBuiltinKlineFormat(sample.json, code);
      let format: CustomSourceDef["format"];
      let rows;
      if (builtin) {
        format = builtin;
        rows = builtin === "tencent" ? parseTencentKline(sample.json, code) : parseEastmoneyKline(sample.json);
      } else {
        format = "json";
        const map = merged.jsonMap ?? detectJsonMapping(sample.json);
        rows = map ? parseMappedKline(sample.json, map) : [];
      }
      if (rows.length === 0) {
        return { ok: false, error: t("已识别为{format}，但未解析出 K 线数据。", { format: t(CUSTOM_FORMAT_LABELS[format]) }) };
      }
      return { ok: true, rows: rows.length, format: t(CUSTOM_FORMAT_LABELS[format]) };
    } catch (e) {
      return { ok: false, error: redactError(e) };
    }
  }

  // First-run guide (no enabled sources); the「让 AI 帮我配置」button hands
  // straight into the panel's add-source task.
  private openSetupGuide(): void {
    new SetupGuideModal(this.app, () => void this.openAiPanel({ kind: "add-source", goal: "", context: { existingSources: [] } })).open();
  }

  // ==================== 本地脚本 (user Python scripts → CSV sources) ====================

  // Opens the script manager modal (toolbar 更多 menu + command).
  openScriptManager() {
    new ScriptManagerModal(this.app, this).open();
  }

  // Runs one script file through the shared runner and, on success, takes
  // the invalidation path immediately (register output / clear cache /
  // re-render all chart cards) without waiting for the vault watcher.
  // Shared by the script manager's 立即运行 and the chart cards' run button.
  //
  // Execution model (W02-A): the configured interpreter must be an absolute
  // path; the script/folder/interpreter are resolved to REAL paths and the
  // script must stay inside the script folder (symlink escape rejected); the
  // approval binds the script's real path + content SHA-256; after the user
  // confirms, the file is re-read and re-hashed right before spawn — a
  // mismatch aborts and the next run asks again.
  async runScriptFile(file: TFile): Promise<ScriptRunResult> {
    const cancelledResult = (): ScriptRunResult => ({
      code: 126, stdout: "", stderr: "", timedOut: false, cancelled: true, truncated: false,
    });
    const folder = normalizePath(this.pluginSettings.scriptFolderPath);
    const interpreter = this.pluginSettings.pythonInterpreterPath.trim();
    if (!interpreter) {
      new Notice(t("运行本地脚本前，请先在设置页「高级」中配置 Python 解释器的绝对路径。"));
      return cancelledResult();
    }
    if (!nodePath.isAbsolute(interpreter)) {
      new Notice(t("Python 解释器必须配置为绝对路径（当前：{path}）。", { path: interpreter }));
      return cancelledResult();
    }
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const basePath = adapter.getBasePath?.() ?? "";

    let folderReal: string, scriptReal: string, interpreterReal: string;
    try {
      [folderReal, scriptReal, interpreterReal] = await Promise.all([
        realpath(`${basePath}/${folder}`),
        realpath(`${basePath}/${file.path}`),
        realpath(interpreter),
      ]);
    } catch (e) {
      new Notice(t("无法解析脚本、脚本文件夹或解释器的真实路径：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
      return cancelledResult();
    }
    if (!isPathInside(folderReal, scriptReal)) {
      new Notice(t("脚本的真实路径不在脚本文件夹内（符号链接指向外部），已拒绝运行。"));
      return cancelledResult();
    }

    // Hash the on-disk bytes — exactly what the interpreter will execute.
    const hash = createHash("sha256").update(await readFile(scriptReal)).digest("hex");
    const previousHash = this.pluginSettings.approvedScriptHashes[scriptReal];
    if (previousHash !== hash) {
      const approved = await new Promise<boolean>((resolve) => {
        new ScriptRunConfirmModal(this.app, {
          interpreterPath: interpreterReal,
          scriptPath: scriptReal,
          cwd: folderReal,
          hashShort: hash.slice(0, 12),
          changed: previousHash !== undefined,
        }, resolve).open();
      });
      if (!approved) {
        return cancelledResult();
      }
      // Re-read + re-hash right before spawning: the file may have been
      // swapped while the confirmation modal was open.
      const currentHash = createHash("sha256").update(await readFile(scriptReal)).digest("hex");
      if (currentHash !== hash) {
        new Notice(t("脚本内容在确认后发生变化，已取消运行；请重新运行并再次确认。"));
        return cancelledResult();
      }
      this.pluginSettings.approvedScriptHashes[scriptReal] = hash;
      await this.saveSettings();
    }
    const result = await runScript({ interpreter: interpreterReal, scriptPath: scriptReal, cwd: folderReal });
    if (result.code === 0 && !result.timedOut) {
      await this.invalidateScriptOutput(`${folder}/output/${file.basename}.csv`);
    }
    return result;
  }

  // Chart-card / settings 运行 button for a script-produced source: finds
  // the producing script, runs it, then reports whether the run actually
  // produced newer data (max trade date before vs after).
  async runScriptForSource(sourceId: string): Promise<void> {
    const prov = getScriptProvenance(this, sourceId);
    if (!prov) return;
    if (!prov.scriptFile) {
      new Notice(t("未找到与产物同名的脚本（{name}.py），无法运行。", { name: prov.def.name }));
      return;
    }
    const folder = normalizePath(this.pluginSettings.scriptFolderPath);
    const rel = prov.scriptFile.path.slice(folder.length + 1);
    if (this.pluginSettings.disabledScripts.includes(rel)) {
      new Notice(t("脚本「{name}」已禁用，请在本地脚本管理中启用后再运行。", { name: prov.scriptFile.basename }));
      return;
    }
    const before = await this.readScriptOutputMaxDate(prov.def);
    new Notice(t("正在运行本地脚本：{name}…", { name: prov.scriptFile.basename }));
    const result = await this.runScriptFile(prov.scriptFile);
    if (result.cancelled) return;
    if (result.timedOut) {
      new Notice(t("本地脚本运行超时（{s} 秒），进程已终止。", { s: SCRIPT_TIMEOUT_MS / 1000 }));
      return;
    }
    if (result.code !== 0) {
      const err = redactSecrets(result.stderr.trim().split("\n").pop() ?? "");
      new Notice(t("本地脚本运行失败（退出码 {code}）：{err}", { code: result.code, err }), 8000);
      return;
    }
    const after = await this.readScriptOutputMaxDate(prov.def);
    new Notice(
      after && after !== before
        ? t("本地脚本运行完成，数据已更新至 {date}。", { date: after })
        : t("本地脚本运行完成，数据无新增。",)
    );
  }

  // Max trade date across the source's series, read straight from the
  // output CSV (no cache) — the before/after yardstick for "did the run
  // produce new data".
  private async readScriptOutputMaxDate(def: CustomSourceDef): Promise<string> {
    if (!def.filePath || !def.jsonMap) return "";
    const file = this.app.vault.getAbstractFileByPath(def.filePath);
    if (!(file instanceof TFile)) return "";
    try {
      const text = await this.app.vault.cachedRead(file);
      const codes = def.symbols && def.symbols.length > 0 ? def.symbols.map((s) => s.code) : [""];
      let max = "";
      for (const code of codes) {
        for (const row of parseCsvKline(text, def.jsonMap, code)) {
          if (row.tradeDate > max) max = row.tradeDate;
        }
      }
      return max;
    } catch {
      return "";
    }
  }

  private isScriptOutputFile(file: unknown): file is TFile {
    if (!(file instanceof TFile) || file.extension !== "csv") return false;
    const outputDir = `${normalizePath(this.pluginSettings.scriptFolderPath)}/output`;
    return file.parent?.path === outputDir;
  }

  private debounceScriptOutput(path: string, fn: () => void) {
    const existing = this.scriptOutputTimers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    this.scriptOutputTimers.set(
      path,
      window.setTimeout(() => {
        this.scriptOutputTimers.delete(path);
        fn();
      }, 2000)
    );
  }

  // IndicatorLoaderHost hook (W02-B): batch approval UI for indicator files
  // whose path+hash have no stored approval. Approved entries are persisted
  // (path → hash); the loader loads them immediately and skips the rejected
  // ones for the rest of the session.
  async confirmIndicatorApprovals(pending: PendingIndicatorApproval[]): Promise<IndicatorApprovalDecision> {
    const decision = await new Promise<IndicatorApprovalDecision>((resolve) => {
      new IndicatorConfirmModal(this.app, pending, resolve).open();
    });
    if (decision.approved.length > 0) {
      for (const entry of decision.approved) {
        this.pluginSettings.approvedIndicatorHashes[entry.path] = entry.hash;
      }
      await this.saveSettings();
    }
    return decision;
  }

  async openIndicatorDescription(indicatorId: string): Promise<void> {
    const def = indicatorRegistry.resolve(indicatorId);
    if (!def) return;
    const overrides = this.pluginSettings.indicatorOverrides[indicatorId] ?? {};
    const description = overrides.description?.trim();
    if (description) {
      const linkedNote = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(description);
      if (linkedNote) {
        await this.app.workspace.openLinkText(linkedNote[1], "", true);
        return;
      }
      new IndicatorDescriptionModal(this.app, def.name, description).open();
      return;
    }

    const folder = `${normalizePath(this.pluginSettings.indicatorFolderPath)}/说明`;
    await ensureFolder(this.app, folder);
    const slug = sanitizeFileNamePart(indicatorId) || "indicator";
    const path = `${folder}/${slug}.md`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!(existing instanceof TFile)) {
      await this.app.vault.create(path, `# ${def.name}\n\n请在这里填写指标说明。\n`);
    }
    const link = `[[${path.slice(0, -3)}]]`;
    this.pluginSettings.indicatorOverrides[indicatorId] = {
      ...overrides,
      description: link,
    };
    await this.saveSettings();
    await this.app.workspace.openLinkText(path.slice(0, -3), "", true);
  }

  // Any .js under the indicator folder (recursive — matches the loader's
  // prefix scan).
  private isIndicatorFile(file: unknown): file is TFile {
    if (!(file instanceof TFile) || file.extension !== "js") return false;
    return file.path.startsWith(`${normalizePath(this.pluginSettings.indicatorFolderPath)}/`);
  }

  private debounceIndicator(path: string, fn: () => void) {
    const existing = this.indicatorTimers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    this.indicatorTimers.set(
      path,
      window.setTimeout(() => {
        this.indicatorTimers.delete(path);
        fn();
      }, 2000)
    );
  }

  // Clears every cache key of the custom source fed by a script-output CSV
  // (registering the file first when it is new), then re-renders ALL chart
  // cards — no precise reference tracking: local CSV reads are cheap and the
  // cache merge is idempotent. Called by the vault watcher (debounced) and
  // directly by 立即运行 in the script manager.
  async invalidateScriptOutput(path: string) {
    let source = this.pluginSettings.customSources.find((s) => s.format === "csv" && s.filePath === path);
    if (!source) {
      // Force-register past the seen-stickiness: the script ran again (立即运行
      // or an output rewrite), so the data is wanted even if the source was
      // deleted before.
      await syncScriptSources(this, new Set([path]));
      source = this.pluginSettings.customSources.find((s) => s.format === "csv" && s.filePath === path);
    }
    if (source) {
      const assetKey = cacheAssetKey("custom", source.id) as AssetType;
      for (const key of await this.sqliteCache.listOhlcvKeys()) {
        if (key.assetType === assetKey) {
          await this.sqliteCache.deleteOhlcv(key.symbol, key.assetType);
        }
      }
    }
    for (const renderer of this.chartRenderers) renderer.refreshCard();
  }

  // Unified 「插入图表」 entry (canvas toolbar submenu / command palette): one
  // search modal fanning out across the sources in scope. Picked items are
  // recorded in the search history and upserted into the symbol cache first
  // (keyed custom:<sourceId>) so chart headers resolve names later.
  openUnifiedSearch(scope: CategoryId = "all") {
    if (this.enabledCustomSources().length === 0) {
      this.openSetupGuide();
      return;
    }
    new UnifiedSearchModal(this.app, {
      ...this.unifiedSearchBase(),
      onSymbol: (item) => this.insertSymbolCard(item),
      onManual: (sourceId, sourceName) =>
        new ManualSymbolModal(
          this.app,
          sourceId,
          sourceName,
          (item) => this.insertSymbolCard(item),
          this.pluginSettings.customSources.find((s) => s.id === sourceId)?.symbols
        ).open(),
      scope,
    }).open();
  }

  // Modal-independent options shared by every UnifiedSearchModal open: all
  // configured sources (the modal filters enabled ones itself), the remote /
  // symbol-cache search backends, the 最近使用 history store, and the
  // credential-presence probe for the 未配置凭据 marks.
  private unifiedSearchBase() {
    return {
      customSources: this.pluginSettings.customSources,
      searchCustom: (sourceId: string, text: string) => this.dataAdapter.searchRemoteQuotes(sourceId, text),
      searchCached: (query: string, limit?: number) => this.sqliteCache.searchSymbols(query, limit),
      history: {
        list: (): SearchHistoryEntry[] => this.pluginSettings.searchHistory,
        clear: (): void => {
          this.pluginSettings.searchHistory = [];
          void this.saveSettings();
        },
      },
      hasCredential: (credentialId: string) => this.credentials.get(credentialId) !== null,
    };
  }

  // Records a picked symbol in the unified-search history (name/code/source
  // id only), deduped by sourceId+tsCode, newest first, capped at 20.
  private recordSearchHistory(item: SymbolItem) {
    const entry: SearchHistoryEntry = {
      name: item.name,
      tsCode: item.tsCode,
      ...(item.sourceId ? { sourceId: item.sourceId } : {}),
    };
    const keyOf = (e: SearchHistoryEntry) => `${e.sourceId ?? ""}:${e.tsCode}`;
    this.pluginSettings.searchHistory = [
      entry,
      ...this.pluginSettings.searchHistory.filter((e) => keyOf(e) !== keyOf(entry)),
    ].slice(0, 20);
    void this.saveSettings();
  }

  private insertSymbolCard(item: SymbolItem) {
    this.recordSearchHistory(item);
    void this.sqliteCache.upsertSymbols([item]);
    void this.insertCard(item);
  }

  // Series/symbol pick path (card edit modals, overlay/spread legs): the
  // unified search modal pre-scoped to the given source. Picks are recorded
  // in the search history and upserted into the symbol cache (keyed
  // custom:<sourceId>) so chart headers can resolve names later; sources
  // without remote search fall back to ManualSymbolModal via onManual.
  openSymbolSearch(onSelect: (item: SymbolItem) => void, sourceId?: string) {
    const def = this.pluginSettings.customSources.find((s) => s.id === sourceId && s.enabled);
    if (!def) {
      new Notice(t("自定义数据源「{id}」不存在或已停用，请在设置页检查。", { id: sourceId ?? "" }));
      return;
    }
    const onPick = (item: SymbolItem) => {
      const picked: SymbolItem = { ...item, assetType: "custom", sourceId: def.id };
      this.recordSearchHistory(picked);
      void this.sqliteCache.upsertSymbols([picked]);
      onSelect(picked);
    };
    new UnifiedSearchModal(this.app, {
      ...this.unifiedSearchBase(),
      onSymbol: onPick,
      onManual: (sid, sname) =>
        new ManualSymbolModal(
          this.app,
          sid,
          sname,
          onPick,
          this.pluginSettings.customSources.find((s) => s.id === sid)?.symbols
        ).open(),
      scope: `custom:${def.id}`,
    }).open();
  }

  // Data-card insertion unified entry (command palette counterpart of the
  // toolbar): the unified search modal covers every enabled source, with
  // in-modal source/group scoping.
  insertAssetDataCard() {
    this.openUnifiedSearch("all");
  }

  // Source-picker entries with grouped sources collapsed into one card per
  // group: picking a group opens the unified search scoped to that group;
  // ungrouped sources keep their single-source flow via onUngrouped.
  private buildSourcePickerEntries(
    onUngrouped: (def: CustomSourceDef) => void
  ): SourcePickerEntry[] {
    const entries: SourcePickerEntry[] = [];
    const seenGroups = new Set<string>();
    for (const def of this.pluginSettings.customSources) {
      if (!def.enabled) continue;
      if (def.group) {
        if (seenGroups.has(def.group)) continue;
        seenGroups.add(def.group);
        const group = def.group;
        const count = this.pluginSettings.customSources.filter(
          (s) => s.enabled && s.group === group
        ).length;
        entries.push({
          name: group,
          desc: t("数据源组 · {n} 个源", { n: count }),
          onPick: () => this.openUnifiedSearch(`group:${group}`),
        });
      } else {
        entries.push({
          name: def.name,
          desc: t("自定义数据源 · 用户配置"),
          onPick: () => onUngrouped(def),
        });
      }
    }
    return entries;
  }

  // Md-note counterpart of the canvas toolbar: one picker covering every
  // card type (project rule: every source reachable from every entry point).
  // Widget/calendar need no data source.
  // Each flow receives the editor and writes its fenced block at the cursor
  // instead of creating a card file.
  insertCardIntoMd(editor: Editor) {
    // No enabled source: the plugin ships no data sources, so guide the user
    // to configure one first. Widget/calendar stay reachable through their
    // own commands/menus — no exceptions in this guide.
    if (this.enabledCustomSources().length === 0) {
      this.openSetupGuide();
      return;
    }
    const entries: SourcePickerEntry[] = [
      ...this.buildSourcePickerEntries((def) =>
        this.openSymbolSearch((item) => void this.insertCard(item, editor), def.id)
      ),
      {
        name: "TradingView 小组件",
        desc: t("嵌入 TradingView 脚本或 iframe 小组件"),
        onPick: () => this.openWidgetInputModal(editor),
      },
      {
        name: t("日历"),
        desc: t("联动日记的月历卡片"),
        onPick: () => void this.insertCalendarCard(editor),
      },
    ];

    new SourcePickerModal(this.app, entries).open();
  }

  // Writes a fenced card block at the cursor. A mid-line cursor pushes the
  // block to the next line so it never lands inside prose.
  private insertBlockIntoEditor(editor: Editor, blockType: string, body: string) {
    const cursor = editor.getCursor("from");
    const prefix = cursor.ch > 0 && editor.getLine(cursor.line).trim().length > 0 ? "\n" : "";
    editor.replaceSelection(`${prefix}\`\`\`${blockType}\n${body}\n\`\`\`\n`);
  }

  async insertCard(item: SymbolItem, editor?: Editor) {
    const spec: ParsedCardSpec = {
      symbol: item.tsCode,
      assetType: item.assetType,
      ...(item.sourceId ? { sourceId: item.sourceId } : {}),
      freq: "D",
      range: this.resolveDefaultRange(),
      version: 1,
      ...(this.pluginSettings.chartThemeDefault !== "obsidian"
        ? { theme: this.pluginSettings.chartThemeDefault }
        : {}),
    };

    if (editor) {
      this.insertBlockIntoEditor(editor, codeBlockTypeFor(spec), stringifyCardSpec(spec));
      return;
    }

    try {
      const file = await this.cardService.createOrReuse(spec, undefined, item.name);
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(t("创建卡片失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
      console.error("创建卡片失败:", e);
    }
  }

  openWidgetInputModal(editor?: Editor) {
    new WidgetInputModal(
      this.app,
      ({ title, input, savePath }) => {
        void this.insertWidgetCard(title, input, savePath, editor);
      },
      this.pluginSettings.widgetCardPath
    ).open();
  }

  async insertWidgetCard(title: string, input: string, savePath?: string, editor?: Editor) {
    const parsed = parseWidgetInput(input, title || undefined);
    if (!parsed) {
      new Notice(t("仅支持 TradingView 官方 HTTPS URL 或组件代码。"));
      return;
    }

    const symbol = sanitizeSymbol(title) || parsed.title || "widget";
    const spec: ParsedCardSpec = {
      contentType: "widget",
      symbol,
      assetType: "custom",
      freq: "D",
      range: "1y",
      version: 1,
      height: DEFAULT_CARD_HEIGHT,
      widgetType: parsed.widgetType,
      iframeUrl: parsed.iframeUrl,
      widgetHtml: parsed.widgetHtml,
      widgetTitle: title || parsed.title || symbol,
    };

    if (editor) {
      this.insertBlockIntoEditor(editor, codeBlockTypeFor(spec), stringifyCardSpec(spec));
      return;
    }

    try {
      const file = await this.cardService.createOrReuse(spec, savePath);
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(t("创建小组件卡片失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
      console.error("创建小组件卡片失败:", e);
    }
  }

  async insertCalendarCard(editor?: Editor) {
    const spec: ParsedCardSpec = {
      contentType: "calendar",
      symbol: "calendar",
      assetType: "custom",
      freq: "D",
      range: "1y",
      version: 1,
      height: DEFAULT_CARD_HEIGHT,
    };

    if (editor) {
      this.insertBlockIntoEditor(editor, codeBlockTypeFor(spec), stringifyCardSpec(spec));
      return;
    }

    try {
      const file = await this.cardService.createOrReuse(spec);
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(t("创建日历卡片失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
      console.error("创建日历卡片失败:", e);
    }
  }

  // Modal-first insertion: the edit modal opens pre-filled with the default
  // spec; the card is only created when the user clicks 保存. Cancelling
  // inserts nothing.
  async insertOverlayCard(editor?: Editor) {
    const sources = this.enabledCustomSources();
    if (sources.length === 0) {
      new Notice(t("请先在设置页添加并启用自定义数据源。"));
      return;
    }

    new OverlayEditModal(
      this.app,
      {
        ...DEFAULT_OVERLAY_SPEC,
        ...(this.pluginSettings.chartThemeDefault !== "obsidian"
          ? { theme: this.pluginSettings.chartThemeDefault }
          : {}),
      },
      (spec) => void this.createOverlayCard(spec, editor),
      (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
      () => this.listReferenceableCards(),
      t("新建对比卡"),
      sources,
      (ref) => this.seriesAdapter.resolveLabelSync(ref)
    ).open();
  }

  async insertSpreadCard(editor?: Editor) {
    const sources = this.enabledCustomSources();
    if (sources.length === 0) {
      new Notice(t("请先在设置页添加并启用自定义数据源。"));
      return;
    }

    new SpreadEditModal(
      this.app,
      {
        ...DEFAULT_SPREAD_SPEC,
        ...(this.pluginSettings.chartThemeDefault !== "obsidian"
          ? { theme: this.pluginSettings.chartThemeDefault }
          : {}),
      },
      (spec) => void this.createSpreadCard(spec, editor),
      (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
      t("新建计算卡"),
      sources
    ).open();
  }

  private async createOverlayCard(spec: OverlaySpec, editor?: Editor) {
    if (editor) {
      this.insertBlockIntoEditor(editor, "overlay", stringifyOverlaySpec(spec));
      return;
    }

    try {
      const file = await this.cardService.createRawCard("对比.md", "overlay", stringifyOverlaySpec(spec));
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(t("创建对比卡失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
      console.error("创建对比卡失败:", e);
    }
  }

  // Lists existing card files the series picker can offer (md files under
  // the card library with a ```quote / ```spread block). Overlay cards are
  // not listed (which of the normalized lines would it resolve to?). Quote
  // cards carry their spec's quote coordinates (picking one emits a plain
  // quote ref); spread cards carry their stable id, backfilled into the file
  // on the spot when missing. Cards with broken YAML are skipped. Display
  // name is the file basename, sorted by name.
  async listReferenceableCards(): Promise<ReferenceableCard[]> {
    const libraryPath = this.pluginSettings.cardLibraryPath;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(libraryPath + "/"));

    const cards: ReferenceableCard[] = [];
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const quoteBody = extractCardBlock(content, "quote");
      if (quoteBody !== null) {
        const result = parseCardSpec(quoteBody);
        if (!result.ok) continue;
        cards.push({
          path: file.path,
          name: file.basename,
          kind: "quote",
          quoteRef: {
            tsCode: result.spec.symbol,
            assetType: result.spec.assetType,
            ...(result.spec.sourceId ? { sourceId: result.spec.sourceId } : {}),
          },
        });
        continue;
      }
      if (extractCardBlock(content, "spread") === null) continue;
      const cardId = await ensureSpreadId(this.app, file);
      if (!cardId) continue;
      cards.push({ path: file.path, name: file.basename, kind: "spread", cardId });
    }
    return cards.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  private async createSpreadCard(spec: SpreadSpec, editor?: Editor) {
    // Every spread card gets its stable id at creation (other cards reference
    // it by id; the file can then be renamed/moved freely).
    const withId: SpreadSpec = spec.id ? spec : { ...spec, id: newSpreadId() };
    if (editor) {
      this.insertBlockIntoEditor(editor, "spread", stringifySpreadSpec(withId));
      return;
    }

    try {
      const file = await this.cardService.createRawCard("计算.md", "spread", stringifySpreadSpec(withId));
      this.toolbar.placeFileNode(file);
    } catch (e) {
      new Notice(t("创建计算卡失败：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
      console.error("创建计算卡失败:", e);
    }
  }

  // Saves an edited overlay spec back into the card file. Called from the
  // edit modal; the canvas preview re-renders on the modify event.
  async updateOverlayCard(sourcePath: string, spec: OverlaySpec) {
    await this.replaceCardBlock(sourcePath, "overlay", stringifyOverlaySpec(spec), "对比卡");
  }

  async updateSpreadCard(sourcePath: string, spec: SpreadSpec, silent = false) {
    await this.replaceCardBlock(sourcePath, "spread", stringifySpreadSpec(spec), "计算卡", silent);
  }

  // Replaces only the fenced code block of the given type inside the card
  // file, so notes elsewhere in the file survive. No file rename. `silent`
  // suppresses the saved-Notice for automatic writes (id backfill) where a
  // "已保存" popup would be misleading.
  private async replaceCardBlock(
    sourcePath: string,
    blockType: "quote" | "overlay" | "spread",
    body: string,
    cardLabel: string,
    silent = false
  ) {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) {
      new Notice(t("找不到{label}文件。", { label: t(cardLabel) }));
      return;
    }

    try {
      const content = await this.app.vault.cachedRead(file);
      const blockRe = new RegExp("```" + blockType + "\\n[\\s\\S]*?\\n```");
      const newBlock = ["```" + blockType, body, "```"].join("\n");
      const newContent = blockRe.test(content)
        ? content.replace(blockRe, newBlock)
        : `${content.trimEnd()}\n\n${newBlock}\n`;
      if (newContent !== content) {
        await this.app.vault.modify(file, newContent);
      }
      if (!silent) {
        new Notice(t("{label}已保存。", { label: t(cardLabel) }));
      }
    } catch (e) {
      new Notice(t("保存{label}失败：{msg}", { label: t(cardLabel), msg: e instanceof Error ? e.message : String(e) }));
      console.error(`保存${cardLabel}失败:`, e);
    }
  }

  private resolveDefaultRange(): string {
    // New cards always start from the built-in default range (1y).
    const { start, end } = resolveDateRange("1y");
    return `${formatIsoDate(parseDateYmd(start))}~${formatIsoDate(parseDateYmd(end))}`;
  }

  async placeDerivedCard(file: TFile, sourcePath: string): Promise<boolean> {
    const sourceNode = this.findCanvasNodeForPath(sourcePath);
    if (!sourceNode) return false;

    const canvas = getCanvasView(this.app)?.canvas;
    if (!canvas) return false;

    const newNode = canvas.createFileNode?.({
      file,
      pos: { x: sourceNode.x + sourceNode.width + 50, y: sourceNode.y },
      size: { width: sourceNode.width, height: sourceNode.height },
    });

    if (newNode) {
      canvas.requestSave?.();
      return true;
    }
    return false;
  }

  private findCanvasNodeForPath(sourcePath: string): { x: number; y: number; width: number; height: number } | null {
    const canvas = getCanvasView(this.app)?.canvas;
    if (!canvas) return null;

    for (const node of canvas.nodes.values()) {
      if (node.filePath === sourcePath) {
        return {
          x: node.x ?? 0,
          y: node.y ?? 0,
          width: node.width ?? 600,
          height: node.height ?? 400,
        };
      }
    }

    return null;
  }

  // Canvas context-menu support: which StrataBoard card type (if any) the
  // node for this file renders. Read from the data-strataboard-block
  // attribute each chart-card renderer stamps on its container — synchronous,
  // because Menu.addItem is a no-op once the menu is shown.
  private detectCanvasCardType(file: TFile): string | null {
    const canvas = getCanvasView(this.app)?.canvas;
    if (!canvas?.nodes) return null;
    for (const node of canvas.nodes.values()) {
      if (node.filePath !== file.path) continue;
      const el = node.nodeEl ?? node.el;
      return el?.querySelector("[data-strataboard-block]")?.getAttribute("data-strataboard-block") ?? null;
    }
    return null;
  }

  // 「编辑…卡」menu action: parse the card file and open the same edit modal
  // the double-click flow uses. Saves go through the regular update/convert
  // paths, so the canvas preview re-renders on the modify event.
  private async openCardEditorFromMenu(file: TFile, type: string) {
    const content = await this.app.vault.cachedRead(file);
    const body = extractCardBlock(content, type);
    if (body === null) {
      new Notice(t("无法解析卡片配置。"));
      return;
    }
    const path = file.path;

    if (type === "quote") {
      const result = parseCardSpec(body);
      if (!result.ok) {
        new Notice(t("无法解析卡片配置。"));
        return;
      }
      const spec = result.spec;
      // Same default resolution as QuoteCodeBlockRenderer.openEditModal.
      const resolved: ParsedCardSpec = {
        ...spec,
        chartType: spec.chartType ?? "candlestick",
        theme: spec.theme ?? "auto",
      };
      new UnifiedCardEditModal(this.app, {
        spec: resolved,
        openSymbolPicker: (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
        customSources: this.enabledCustomSources(),
        indicatorGroups: this.pluginSettings.indicatorGroups,
        onSubmit: (newSpec) => {
          void this.cardService.updateCardSpec(path, newSpec);
        },
      }).open();
      return;
    }

    if (type === "overlay") {
      const result = parseOverlaySpec(body);
      if (!result.spec) {
        new Notice(t("无法解析卡片配置。"));
        return;
      }
      new OverlayEditModal(
        this.app,
        result.spec,
        (newSpec) => void this.updateOverlayCard(path, newSpec),
        (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
        () => this.listReferenceableCards(),
        undefined,
        this.enabledCustomSources(),
        (ref) => this.seriesAdapter.resolveLabelSync(ref)
      ).open();
      return;
    }

    if (type === "spread") {
      const result = parseSpreadSpec(body);
      if (!result.spec) {
        new Notice(t("无法解析卡片配置。"));
        return;
      }
      new SpreadEditModal(
        this.app,
        result.spec,
        (newSpec) => void this.updateSpreadCard(path, newSpec),
        (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
        undefined,
        this.enabledCustomSources()
      ).open();
    }
  }

  // Builds the series ref a card contributes to a compare/calc card: quote
  // cards contribute their quote coordinates; spread cards contribute a card
  // ref by their stable id (backfilling it into the file when missing).
  // Returns the ref, or an error message string.
  private async resolveCardSeriesRef(file: TFile, type: string): Promise<SeriesRef | string> {
    const content = await this.app.vault.cachedRead(file);
    const body = extractCardBlock(content, type);
    if (body === null) return t("无法解析卡片配置。");
    if (type === "quote") {
      const result = parseCardSpec(body);
      if (!result.ok) return result.error.message;
      return {
        source: "quote",
        tsCode: result.spec.symbol,
        assetType: result.spec.assetType,
        ...(result.spec.sourceId ? { sourceId: result.spec.sourceId } : {}),
      };
    }
    const result = parseSpreadSpec(body);
    if (!result.spec) return result.error ?? t("无法解析卡片配置。");
    const cardId = await ensureSpreadId(this.app, file);
    if (!cardId) return t("无法解析卡片配置。");
    return { source: "card", cardId };
  }

  // Opens the compare/calc editor pre-filled with the given series; 保存
  // creates a new card on the canvas (same creation path as 创建对比卡 /
  // 创建计算卡). The picker/label callbacks mirror insertOverlayCard /
  // insertSpreadCard.
  private openSeriesCardEditor(series: SeriesRef[], target: "overlay" | "spread") {
    const sources = this.enabledCustomSources();
    if (sources.length === 0) {
      new Notice(t("请先在设置页添加并启用自定义数据源。"));
      return;
    }
    const themeOverride =
      this.pluginSettings.chartThemeDefault !== "obsidian" ? { theme: this.pluginSettings.chartThemeDefault } : {};
    if (target === "overlay") {
      new OverlayEditModal(
        this.app,
        { ...DEFAULT_OVERLAY_SPEC, ...themeOverride, series },
        (spec) => void this.createOverlayCard(spec),
        (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
        () => this.listReferenceableCards(),
        t("新建对比卡"),
        sources,
        (ref) => this.seriesAdapter.resolveLabelSync(ref)
      ).open();
      return;
    }
    // A single seeded series leaves the default A-B formula unsatisfiable
    // until the user adds a second series — the editor's live formula
    // validation and its ≥2-series save floor carry that prompt naturally.
    new SpreadEditModal(
      this.app,
      { ...DEFAULT_SPREAD_SPEC, ...themeOverride, series },
      (spec) => void this.createSpreadCard(spec),
      (onSelect, sourceId) => this.openSymbolSearch(onSelect, sourceId),
      t("新建计算卡"),
      sources
    ).open();
  }

  // 「加入序列进行对比」/「以此序列创建计算」 (canvas single-card menu).
  private async openDerivedSeriesCard(file: TFile, type: string, target: "overlay" | "spread") {
    const ref = await this.resolveCardSeriesRef(file, type);
    if (typeof ref === "string") {
      new Notice(t("无法从该卡片提取序列：{msg}", { msg: ref }));
      return;
    }
    this.openSeriesCardEditor([ref], target);
  }

  // Compare/calc entries on the canvas multi-selection menu. Only quote and
  // spread cards count (same rule as listReferenceableCards); other node
  // types are ignored. Synchronous — the parsing happens on click.
  private addSelectionSeriesItems(menu: Menu, canvas: CanvasLike) {
    const selection = canvas.selection;
    if (!selection) return;
    const seen = new Set<string>();
    const candidates: { filePath: string; type: "quote" | "spread" }[] = [];
    for (const node of selection) {
      if (!node.filePath || seen.has(node.filePath)) continue;
      const el = node.nodeEl ?? node.el;
      const type = el?.querySelector("[data-strataboard-block]")?.getAttribute("data-strataboard-block");
      if (type !== "quote" && type !== "spread") continue;
      seen.add(node.filePath);
      candidates.push({ filePath: node.filePath, type });
    }
    if (candidates.length < 2) return;
    menu.addItem((item) => {
      item
        .setTitle(t("用选中的 {n} 张卡创建对比", { n: candidates.length }))
        .setIcon("layers")
        .onClick(() => void this.openSelectionSeriesEditor(candidates, "overlay"));
    });
    menu.addItem((item) => {
      item
        .setTitle(t("用选中的 {n} 张卡创建计算", { n: candidates.length }))
        .setIcon("calculator")
        .onClick(() => void this.openSelectionSeriesEditor(candidates, "spread"));
    });
  }

  // Parses every selected card file (async — the menu has closed by now),
  // skips the ones that fail, and opens the editor pre-filled with the
  // surviving series.
  private async openSelectionSeriesEditor(
    candidates: { filePath: string; type: "quote" | "spread" }[],
    target: "overlay" | "spread"
  ) {
    let pool = candidates;
    if (pool.length > MAX_OVERLAY_SERIES) {
      pool = pool.slice(0, MAX_OVERLAY_SERIES);
      new Notice(t("最多使用 {max} 张卡片，超出的已忽略。", { max: MAX_OVERLAY_SERIES }));
    }
    const series: SeriesRef[] = [];
    const failures: string[] = [];
    for (const candidate of pool) {
      const name = candidate.filePath.split("/").pop()!.replace(/\.md$/i, "");
      const file = this.app.vault.getAbstractFileByPath(candidate.filePath);
      if (!(file instanceof TFile)) {
        failures.push(`${name}（${t("文件不存在：{path}", { path: candidate.filePath })}）`);
        continue;
      }
      const ref = await this.resolveCardSeriesRef(file, candidate.type);
      if (typeof ref === "string") {
        failures.push(`${name}（${ref}）`);
        continue;
      }
      series.push(ref);
    }
    if (failures.length > 0) {
      new Notice(t("{n} 张卡片无法解析，已跳过：{details}", { n: failures.length, details: failures.join("；") }), 8000);
    }
    if (series.length < 2) {
      new Notice(t("可解析的卡片不足两张，未创建卡片。"));
      return;
    }
    this.openSeriesCardEditor(series, target);
  }

  private attachToolbarToCanvas(leaf: WorkspaceLeaf | null) {
    if (leaf?.view?.getViewType?.() === "canvas") {
      this.toolbar.attach(leaf);
    } else {
      this.toolbar.detach();
    }
  }
}

function sanitizeSymbol(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
