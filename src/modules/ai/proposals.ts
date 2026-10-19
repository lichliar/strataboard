// Structured AI proposals (W08-A): the assistant is asked to answer every
// task with one JSON object ({kind, summary, ...fields}); this module parses
// and validates that JSON before anything touches settings, cards, or files.
// Pure functions only — no zod (zod is MCP-bundle-only), no obsidian, no I/O.
//
// Trust model: the model's output is untrusted input. Validation is
// lenient about extra unknown fields (they are dropped) but strict about
// anything security-relevant: credential/enabled fields in a source draft
// are rejected outright, every URL template passes the central URL policy
// (utils/url-policy.ts), card specs are validated by round-tripping through
// the real YAML parsers (parse = validation), and referenced source ids must
// exist. Chinese error strings double as user-facing text and as the
// feedback the runner feeds back to the model on revise.

import type { CustomSourceDef, OverlaySpec, ParsedCardSpec, SpreadSpec, SeriesRef } from "../../types";
import { evaluateUrl } from "../../utils/url-policy";
import { parseCardSpec, stringifyCardSpec } from "../card-spec";
import { parseOverlaySpec, parseSpreadSpec, stringifyOverlaySpec, stringifySpreadSpec } from "../series-spec";
import type { ChartTheme, ChartType, Freq, OverlayCompareMode, SeriesPeriod } from "../../types";

export type AiTaskKind =
  | "add-source"
  | "fix-source"
  | "quote-card"
  | "overlay-card"
  | "spread-card"
  | "indicator"
  | "indicator-doc"
  | "script";

export type AiProposal =
  | { kind: "add-source"; summary: string; draft: Partial<CustomSourceDef> }
  | { kind: "fix-source"; summary: string; sourceId: string; patch: Partial<CustomSourceDef> }
  | { kind: "quote-card"; summary: string; spec: ParsedCardSpec }
  | { kind: "overlay-card"; summary: string; spec: OverlaySpec }
  | { kind: "spread-card"; summary: string; spec: SpreadSpec }
  | { kind: "indicator"; summary: string; title: string; code: string }
  | { kind: "indicator-doc"; summary: string; indicatorId: string; title: string; markdown: string; plotCode: string }
  | { kind: "script"; summary: string; filename: string; code: string };

export type ProposalValidation = { ok: true; proposal: AiProposal } | { ok: false; error: string };

// Everything the validator needs from plugin state; assembled by the caller.
export interface ProposalContext {
  allowedLoopbackHttpOrigins: readonly string[];
  existingSourceIds: readonly string[];
  existingIndicatorIds?: readonly string[];
}

const VALID_KINDS: readonly AiTaskKind[] = [
  "add-source",
  "fix-source",
  "quote-card",
  "overlay-card",
  "spread-card",
  "indicator",
  "indicator-doc",
  "script",
];

// CustomSourceDef fields an AI proposal may carry (draft and patch alike).
// Everything else is dropped — except FORBIDDEN_SOURCE_KEYS, which abort.
const SOURCE_WHITELIST_KEYS: ReadonlySet<string> = new Set([
  "name",
  "format",
  "klineUrl",
  "filePath",
  "searchUrl",
  "method",
  "bodyTemplate",
  "searchBodyTemplate",
  "headers",
  "jsonMap",
  "paginate",
  "searchPaginate",
  "searches",
  "params",
  "profiles",
  "codeRules",
  "searchProfile",
  "deadCodes",
  "bodyEncoding",
  "apiKeyHeader",
]);

// Never settable by the AI: identity, credentials, and the enable switch
// stay under the user's control in the source form. `purpose` is not a
// CustomSourceDef field but is blocked too so a chatty model cannot smuggle
// annotations into settings.
const FORBIDDEN_SOURCE_KEYS: ReadonlySet<string> = new Set(["id", "credentialId", "apiKey", "enabled", "purpose"]);

const VALID_FORMATS: readonly CustomSourceDef["format"][] = ["tencent", "eastmoney", "json", "csv"];
const MAX_CODE_LENGTH = 100_000;
// Safe script filenames: no path separators, no leading dot, .py only.
const SCRIPT_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.py$/;

function fail(error: string): ProposalValidation {
  return { ok: false, error };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Tolerates a Markdown ```json fence around the payload.
function parseJsonLoose(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to the fence strip */
  }
  const fence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

export function parseProposal(raw: string, ctx: ProposalContext): ProposalValidation {
  const parsed = parseJsonLoose(raw);
  const map = parsed !== undefined ? asRecord(parsed) : undefined;
  if (!map) return fail("返回内容不是可解析的 JSON 对象。");

  const kind = asNonEmptyString(map.kind) as AiTaskKind | undefined;
  if (!kind || !VALID_KINDS.includes(kind)) {
    return fail(`未知的任务类型 kind：${String(map.kind)}（应为 ${VALID_KINDS.join(" | ")}）。`);
  }
  const summary = asNonEmptyString(map.summary);
  if (!summary) return fail("缺少必填字段 summary（一句话说明）。");

  switch (kind) {
    case "add-source":
      return validateAddSource(map, summary, ctx);
    case "fix-source":
      return validateFixSource(map, summary, ctx);
    case "quote-card":
      return validateQuoteCard(map, summary, ctx);
    case "overlay-card":
      return validateSeriesCard(map, summary, ctx, "overlay-card");
    case "spread-card":
      return validateSeriesCard(map, summary, ctx, "spread-card");
    case "indicator":
      return validateIndicator(map, summary);
    case "indicator-doc":
      return validateIndicatorDoc(map, summary, ctx);
    case "script":
      return validateScript(map, summary);
  }
}

// ===== data sources =====

// Filters a model-supplied draft/patch down to the whitelisted
// CustomSourceDef subset and runs the URL policy over every URL template.
function sanitizeSourceDraft(
  raw: unknown,
  ctx: ProposalContext,
  fieldLabel: string
): { draft?: Partial<CustomSourceDef>; error?: string } {
  const map = asRecord(raw);
  if (!map) return { error: `${fieldLabel} 必须是一个对象。` };

  const forbidden = Object.keys(map).filter((key) => FORBIDDEN_SOURCE_KEYS.has(key));
  if (forbidden.length > 0) {
    return {
      error: `${fieldLabel} 不允许包含字段：${forbidden.join("、")}（凭据、启用开关与数据源 id 只能由用户在设置表单中操作；密钥一律用 {apiKey} 占位符）。`,
    };
  }

  const draft: Record<string, unknown> = {};
  for (const key of Object.keys(map)) {
    if (SOURCE_WHITELIST_KEYS.has(key)) draft[key] = map[key];
  }

  if (draft.format !== undefined && !VALID_FORMATS.includes(draft.format as CustomSourceDef["format"])) {
    return { error: `${fieldLabel}.format 无效：${String(draft.format)}（应为 ${VALID_FORMATS.join(" | ")}）。` };
  }
  if (draft.method !== undefined && draft.method !== "GET" && draft.method !== "POST") {
    return { error: `${fieldLabel}.method 无效：${String(draft.method)}（应为 GET | POST）。` };
  }

  // URL policy over every URL template the proposal carries. Templates keep
  // their {code}/{query} placeholders — evaluateUrl already runs on the same
  // templated strings in the source form's save path.
  const templates: { label: string; value: unknown }[] = [
    { label: "klineUrl", value: draft.klineUrl },
    { label: "searchUrl", value: draft.searchUrl },
  ];
  if (Array.isArray(draft.searches)) {
    draft.searches.forEach((entry, i) => {
      templates.push({ label: `searches[${i}].url`, value: asRecord(entry)?.url });
    });
  }
  for (const { label, value } of templates) {
    if (typeof value !== "string" || !value.trim()) continue;
    const verdict = evaluateUrl(value.trim(), ctx.allowedLoopbackHttpOrigins);
    if (verdict.kind === "reject") {
      return { error: `${fieldLabel}.${label} 未通过 URL 安全检查：${verdict.reason}` };
    }
    if (verdict.kind === "loopback-http") {
      return {
        error: `${fieldLabel}.${label} 指向明文 http 本机地址 ${verdict.origin}：请先在设置页允许该 origin，或改用 https。`,
      };
    }
    // warn-private: allowed; the source form surfaces the high-risk notice at
    // save time.
  }
  return { draft: draft as Partial<CustomSourceDef> };
}

function validateAddSource(map: Record<string, unknown>, summary: string, ctx: ProposalContext): ProposalValidation {
  const { draft, error } = sanitizeSourceDraft(map.draft, ctx, "draft");
  if (!draft) return fail(error!);
  if (!asNonEmptyString(draft.name)) return fail("draft.name（数据源名称）不能为空。");
  if (draft.format === "csv") {
    if (!asNonEmptyString(draft.filePath)) return fail("format 为 csv 时 draft.filePath（库内 CSV 路径）不能为空。");
  } else if (!asNonEmptyString(draft.klineUrl)) {
    return fail("draft.klineUrl（K线 URL 模板）不能为空。");
  }
  // format "json" is unusable without a column mapping — the source form's
  // save path enforces the same (cols.date + cols.close required).
  if (draft.format === "json") {
    const cols = asRecord(asRecord(draft.jsonMap)?.cols);
    if (!cols || !asNonEmptyString(cols.date) || !asNonEmptyString(cols.close)) {
      return fail("format 为 json 时 draft.jsonMap 必须给出 cols.date 与 cols.close 两列映射。");
    }
  }
  return { ok: true, proposal: { kind: "add-source", summary, draft } };
}

function validateFixSource(map: Record<string, unknown>, summary: string, ctx: ProposalContext): ProposalValidation {
  const sourceId = asNonEmptyString(map.sourceId);
  if (!sourceId) return fail("缺少必填字段 sourceId（要修复的数据源 id）。");
  if (!ctx.existingSourceIds.includes(sourceId)) {
    return fail(`sourceId「${sourceId}」不存在；只能修复已有数据源（可选：${ctx.existingSourceIds.join("、")}）。`);
  }
  const { draft, error } = sanitizeSourceDraft(map.patch, ctx, "patch");
  if (!draft) return fail(error!);
  if (Object.keys(draft).length === 0) return fail("patch 为空：至少给出一个需要修改的字段。");
  return { ok: true, proposal: { kind: "fix-source", summary, sourceId, patch: draft } };
}

// ===== cards =====

function checkSourceId(raw: unknown, ctx: ProposalContext, label: string): { sourceId?: string; error?: string } {
  const sourceId = asNonEmptyString(raw);
  if (!sourceId) return { error: `${label} 缺少有效的 sourceId（自定义数据源 id）。` };
  if (!ctx.existingSourceIds.includes(sourceId)) {
    return { error: `${label} 引用的数据源「${sourceId}」不存在（已有：${ctx.existingSourceIds.join("、")}）。` };
  }
  return { sourceId };
}

// The model supplies structured fields; we assemble a ParsedCardSpec,
// stringify to YAML and re-parse — the real parser is the validator.
function validateQuoteCard(map: Record<string, unknown>, summary: string, ctx: ProposalContext): ProposalValidation {
  const specRaw = asRecord(map.spec);
  if (!specRaw) return fail("quote-card 提案缺少 spec 对象。");

  const code = asNonEmptyString(specRaw.code);
  if (!code) return fail("spec.code（证券代码）不能为空。");
  const { sourceId, error } = checkSourceId(specRaw.sourceId, ctx, "spec");
  if (!sourceId) return fail(error!);

  const chartType = asNonEmptyString(specRaw.chartType);
  const theme = asNonEmptyString(specRaw.theme);
  const spec: ParsedCardSpec = {
    symbol: code,
    assetType: "custom",
    sourceId,
    freq: (asNonEmptyString(specRaw.freq) ?? "D") as Freq,
    range: asNonEmptyString(specRaw.range) ?? "1y",
    version: 1,
  };
  const title = asNonEmptyString(specRaw.title) ?? asNonEmptyString(specRaw.name);
  if (title) spec.title = title;
  if (chartType === "candlestick" || chartType === "line") spec.chartType = chartType as ChartType;
  if (theme === "auto" || theme === "dark" || theme === "light") spec.theme = theme as ChartTheme;

  const parsed = parseCardSpec(stringifyCardSpec(spec));
  if (!parsed.ok) return fail(`卡片配置校验失败：${parsed.error.message}`);
  return { ok: true, proposal: { kind: "quote-card", summary, spec: parsed.spec } };
}

// Shared by overlay-card and spread-card: the proposal's spec.series entries
// are simplified quote refs ({sourceId, code, label?, scale?}); they are
// expanded to full SeriesRefs and validated by the real spec parsers.
function validateSeriesCard(
  map: Record<string, unknown>,
  summary: string,
  ctx: ProposalContext,
  kind: "overlay-card" | "spread-card"
): ProposalValidation {
  const specRaw = asRecord(map.spec);
  if (!specRaw) return fail(`${kind} 提案缺少 spec 对象。`);

  const seriesRaw = specRaw.series;
  if (!Array.isArray(seriesRaw) || seriesRaw.length < 2) {
    return fail("spec.series 至少需要 2 个数据系列。");
  }
  const series: SeriesRef[] = [];
  for (let i = 0; i < seriesRaw.length; i++) {
    const entry = asRecord(seriesRaw[i]);
    const label = `spec.series[${i}]`;
    if (!entry) return fail(`${label} 必须是一个对象（{sourceId, code, label?}）。`);
    const code = asNonEmptyString(entry.code);
    if (!code) return fail(`${label}.code（证券代码）不能为空。`);
    const { sourceId, error } = checkSourceId(entry.sourceId, ctx, label);
    if (!sourceId) return fail(error!);
    const ref: SeriesRef = { source: "quote", tsCode: code, assetType: "custom", sourceId };
    const labelText = asNonEmptyString(entry.label);
    if (labelText) ref.label = labelText;
    // scale is an overlay-only visual multiplier; dropped silently for spread.
    if (kind === "overlay-card" && typeof entry.scale === "number" && Number.isFinite(entry.scale) && entry.scale !== 0) {
      ref.scale = entry.scale;
    }
    series.push(ref);
  }

  const title = asNonEmptyString(specRaw.title);
  const range = asNonEmptyString(specRaw.range) ?? "10y";
  const period = asNonEmptyString(specRaw.period) as SeriesPeriod | undefined;
  const theme = asNonEmptyString(specRaw.theme) as ChartTheme | undefined;

  if (kind === "overlay-card") {
    const spec: OverlaySpec = { series, range };
    if (title) spec.title = title;
    if (period) spec.period = period;
    if (theme) spec.theme = theme;
    const normalize = asNonEmptyString(specRaw.normalize) as OverlayCompareMode | undefined;
    if (normalize) spec.normalize = normalize;
    const parsed = parseOverlaySpec(stringifyOverlaySpec(spec));
    if (!parsed.spec) return fail(`对比卡配置校验失败：${parsed.error}`);
    return { ok: true, proposal: { kind, summary, spec: parsed.spec } };
  }

  const expression = asNonEmptyString(specRaw.expression);
  if (!expression) return fail("spec.expression（计算公式，如 A-B、(A+B)/2）不能为空。");
  const spec: SpreadSpec = { series, expression, range };
  if (title) spec.title = title;
  if (period) spec.period = period;
  if (theme) spec.theme = theme;
  const parsed = parseSpreadSpec(stringifySpreadSpec(spec));
  if (!parsed.spec) return fail(`计算卡配置校验失败：${parsed.error}`);
  return { ok: true, proposal: { kind, summary, spec: parsed.spec } };
}

// ===== indicator / script =====

function validateIndicator(map: Record<string, unknown>, summary: string): ProposalValidation {
  const title = asNonEmptyString(map.title);
  if (!title) return fail("indicator 提案缺少非空的 title（指标名）。");
  const code = checkCode(map.code);
  if (typeof code !== "string") return code;
  return { ok: true, proposal: { kind: "indicator", summary, title, code } };
}

function validateIndicatorDoc(map: Record<string, unknown>, summary: string, ctx: ProposalContext): ProposalValidation {
  const indicatorId = asNonEmptyString(map.indicatorId);
  if (!indicatorId) return fail("indicator-doc 提案缺少 indicatorId（要说明的既有指标 id）。");
  if (!ctx.existingIndicatorIds?.includes(indicatorId)) {
    return fail(`indicatorId「${indicatorId}」不存在；请先选择已加载的指标。`);
  }
  const title = asNonEmptyString(map.title);
  if (!title) return fail("indicator-doc 提案缺少非空的 title（说明标题）。");
  const markdown = checkLongText(map.markdown, "markdown", 120_000);
  if (typeof markdown !== "string") return markdown;
  const plotCode = checkLongText(map.plotCode, "plotCode", 60_000);
  if (typeof plotCode !== "string") return plotCode;
  if (!/matplotlib|pyplot/i.test(plotCode)) return fail("plotCode 必须使用 Matplotlib（包含 matplotlib 或 pyplot）。");
  return { ok: true, proposal: { kind: "indicator-doc", summary, indicatorId, title, markdown, plotCode } };
}

function validateScript(map: Record<string, unknown>, summary: string): ProposalValidation {
  const filename = asNonEmptyString(map.filename);
  if (!filename) return fail("script 提案缺少非空的 filename。");
  if (!SCRIPT_FILENAME_RE.test(filename)) {
    return fail(`filename「${filename}」不安全：只允许字母、数字、- _ .，且必须以 .py 结尾。`);
  }
  const code = checkCode(map.code);
  if (typeof code !== "string") return code;
  return { ok: true, proposal: { kind: "script", summary, filename, code } };
}

// No sandboxing here — execution never happens in the assistant path; the
// code is shown in full and written through the existing approval flows.
function checkCode(raw: unknown): string | ProposalValidation {
  if (typeof raw !== "string" || !raw.trim()) return fail("code（完整文件内容）不能为空。");
  if (raw.length > MAX_CODE_LENGTH) return fail(`code 超长（>${MAX_CODE_LENGTH} 字符）。`);
  return raw;
}

function checkLongText(raw: unknown, label: string, max: number): string | ProposalValidation {
  if (typeof raw !== "string" || !raw.trim()) return fail(`${label}（完整内容）不能为空。`);
  if (raw.length > max) return fail(`${label} 超长（>${max} 字符）。`);
  return raw;
}
