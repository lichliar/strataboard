// Task definitions and context assembly for the in-plugin AI assistant
// (W08): one AiTaskRequest → one BuiltPrompt (system + user messages). The
// system prompt reuses the existing contract constants (source / indicator /
// script prompts, card-authoring guide) and appends a per-kind OUTPUT FORMAT
// contract whose JSON field names mirror the parseProposal validator in
// proposals.ts exactly — the two must stay in sync.
//
// Context hygiene: callers pass already-redacted text; every external text
// block is redacted AGAIN here (redactSecrets) as a belt-and-suspenders
// fallback, and samples are truncated. outboundPreview is the full payload
// string for the panel's「查看发送内容」 affordance.

import type { AiChatMessage } from "./client";
import type { AiTaskKind } from "./proposals";
import type { CustomSourceDef } from "../../types";
import { AI_SOURCE_PROMPT } from "../source-prompt";
import { AI_INDICATOR_PROMPT } from "../indicator-prompt";
import { AI_SCRIPT_PROMPT } from "../script-prompt";
import { AI_GUIDE_MARKDOWN } from "../ai-guide";
import { redactSecrets } from "../redact";

export interface AiTaskRequest {
  kind: AiTaskKind;
  // User's description of what they want; may be empty for fix-source (the
  // error context speaks for itself).
  goal: string;
  context: AiTaskContext;
}

export interface AiTaskContext {
  // Existing sources as id/name/format summaries: the model must reference
  // these ids in card proposals and must not re-add an existing source.
  existingSources: { id: string; name: string; format: string }[];
  existingIndicators?: { id: string; name: string; overlay: boolean; description?: string }[];
  // fix-source: current config summary (never carries the resolved secret).
  sourceDraft?: Partial<CustomSourceDef>;
  // fix-source: the (already redacted) error text.
  errorText?: string;
  // fix-source: truncated sample response.
  sampleText?: string;
  // Card-editor AI assist: the current spec YAML summary.
  currentCardSpec?: string;
}

export interface BuiltPrompt {
  messages: AiChatMessage[]; // system + user
  outboundPreview: string; // full payload string for「查看发送内容」
}

const SAMPLE_TEXT_LIMIT = 2000;

// ---- Output-format contracts (mirror proposals.ts field names exactly) ----

const OUTPUT_FORMAT_HEAD = `## 输出格式（必须严格遵守）

只返回一个 JSON 对象——不要 Markdown 代码块、不要任何其他文字。所有响应都形如：
{"kind": "<任务类型>", "summary": "<一句话说明你的方案>", ...提案字段}`;

const SOURCE_DRAFT_FIELD_RULES = `draft/patch 中只允许这些字段：name、format（"tencent"|"eastmoney"|"json"|"csv"）、klineUrl、filePath（format 为 "csv" 时的库内 CSV 路径）、searchUrl、method（"GET"|"POST"）、bodyTemplate、searchBodyTemplate、headers、jsonMap、paginate、searchPaginate、searches、params、profiles、codeRules、searchProfile、deadCodes、bodyEncoding、apiKeyHeader。
禁止出现 id、credentialId、apiKey、enabled、purpose 字段；密钥一律用 {apiKey} 占位符，绝不写真实密钥。
URL 模板必须指向 https 公网地址（或用户已明确允许的本机 http 地址），不允许内嵌用户名/密码。`;

const OUTPUT_FORMATS: Record<AiTaskKind, string> = {
  "add-source": `${OUTPUT_FORMAT_HEAD}

本任务 kind 固定为 "add-source"，提案字段：
- "draft"：数据源配置草稿对象。name 必填；format 为 "csv" 时 filePath 必填，否则 klineUrl（K线 URL 模板，含 {code} {start} {end} 占位符）必填；format 为 "json"/"csv" 时给出 jsonMap（rowsPath、rowKind、cols.date、cols.close 必填）。
${SOURCE_DRAFT_FIELD_RULES}`,

  "fix-source": `${OUTPUT_FORMAT_HEAD}

本任务 kind 固定为 "fix-source"，提案字段：
- "sourceId"：要修复的既有数据源 id，必须来自上下文「已有数据源」列表；
- "patch"：只包含需要修改的字段（至少一个），字段规则同 add-source 的 draft。
${SOURCE_DRAFT_FIELD_RULES}`,

  "quote-card": `${OUTPUT_FORMAT_HEAD}

本任务 kind 固定为 "quote-card"，提案字段：
- "spec"：{"sourceId": 数据源 id（必填，必须来自上下文「已有数据源」列表）, "code": 证券代码（必填）, "name": 显示名（可选）, "title": 整体标题覆盖（可选）, "freq": "D"|"W"|"M"|"Q"|"Y"（可选，默认 D）, "range": "1y"|"3y"|"5y"|"ytd"|"max" 或 "yyyy-mm-dd~yyyy-mm-dd"（可选，默认 1y）, "chartType": "candlestick"|"line"（可选）, "theme": "auto"|"dark"|"light"（可选）}`,

  "overlay-card": `${OUTPUT_FORMAT_HEAD}

本任务 kind 固定为 "overlay-card"，提案字段：
- "spec"：{"series": 至少 2 条，每条 {"sourceId": 数据源 id（必填）, "code": 证券代码（必填）, "label": 显示名（可选）, "scale": 视觉缩放系数（可选，非零数字）}, "range": 可选（默认 10y）, "period": "D"|"M"|"Q"|"Y"（可选，默认 D）, "normalize": "percent"|"zscore"|"axis"|"none"（可选，默认 percent）, "title": 整体标题（可选）, "theme": "auto"|"dark"|"light"（可选）}
sourceId 必须来自上下文「已有数据源」列表。`,

  "spread-card": `${OUTPUT_FORMAT_HEAD}

本任务 kind 固定为 "spread-card"，提案字段：
- "spec"：{"series": 至少 2 条，每条 {"sourceId": 数据源 id（必填）, "code": 证券代码（必填）, "label": 显示名（可选）}, "expression": 计算公式（必填，series[0] 是 A、series[1] 是 B……，如 "A-B"、"(A+B)/2"）, "range": 可选（默认 10y）, "period": "D"|"M"|"Q"|"Y"（可选，默认 D）, "title": 整体标题（可选）, "theme": "auto"|"dark"|"light"（可选）}
sourceId 必须来自上下文「已有数据源」列表。`,

  indicator: `${OUTPUT_FORMAT_HEAD}

本任务 kind 固定为 "indicator"，提案字段：
- "title"：指标名（必填）；
- "code"：完整 .js 指标文件内容（必填，符合上文文件契约）。`,

  "indicator-doc": `${OUTPUT_FORMAT_HEAD}

本任务 kind 固定为 "indicator-doc"，用于为已有指标编写可读的指标说明。
- "indicatorId"：要说明的既有指标 id，必须来自上下文「已有指标」列表；
- "title"：说明标题；
- "markdown"：完整 Markdown 说明，必须图文并茂，解释指标用途、计算逻辑、参数、主图/副图位置、每个 plot/hline/fill/marker 元素的含义、如何观察以及常见误读；文中可引用 assets/<indicatorId>.png；
- "plotCode"：完整的 Python 3 + Matplotlib 绘图代码。脚本只使用示例或合成 OHLCV 数据，不能联网、读取用户文件或包含秘密；使用插件提供的 OUTPUT_PATH 保存图像，插件会在用户确认后运行并生成 assets/<indicatorId>.png。`,

  script: `${OUTPUT_FORMAT_HEAD}

本任务 kind 固定为 "script"，提案字段：
- "filename"：脚本文件名（必填，只允许字母、数字、- _ .，必须以 .py 结尾）；
- "code"：完整脚本内容（必填，符合上文产物契约）。`,
};

const BASE_PROMPTS: Record<AiTaskKind, string> = {
  "add-source": AI_SOURCE_PROMPT,
  "fix-source": AI_SOURCE_PROMPT,
  "quote-card": AI_GUIDE_MARKDOWN,
  "overlay-card": AI_GUIDE_MARKDOWN,
  "spread-card": AI_GUIDE_MARKDOWN,
  indicator: AI_INDICATOR_PROMPT,
  "indicator-doc": `你是 StrataBoard 的技术指标文档助手。请根据上下文中已有指标的名称、参数和绘图配置，编写一篇中文 Markdown 指标说明，并提供使用 Python Matplotlib 生成直观示意图的完整脚本。说明必须解释指标如何阅读，以及每个图形元素的意义；示例数据必须是合成数据，不得联网或读取用户文件。`,
  script: AI_SCRIPT_PROMPT,
};

export function buildPrompt(req: AiTaskRequest): BuiltPrompt {
  const system = `${BASE_PROMPTS[req.kind]}\n\n${OUTPUT_FORMATS[req.kind]}`;

  const blocks: string[] = [];
  if (req.goal.trim()) {
    blocks.push(`【需求】\n${req.goal.trim()}`);
  }
  const { context } = req;
  if (context.existingSources.length > 0) {
    const lines = context.existingSources.map((s) => `- ${s.id}（${s.name}，格式 ${s.format}）`);
    blocks.push(`【已有数据源】\n${lines.join("\n")}`);
  }
  if (context.existingIndicators && context.existingIndicators.length > 0) {
    const lines = context.existingIndicators.map((ind) => `- ${ind.id}（${ind.name}，${ind.overlay ? "主图" : "副图"}${ind.description ? "，已有说明" : ""}）`);
    blocks.push(`【已有指标】\n${lines.join("\n")}`);
  }
  if (context.sourceDraft) {
    blocks.push(`【当前数据源配置】\n${redactSecrets(JSON.stringify(context.sourceDraft, null, 2))}`);
  }
  if (context.errorText?.trim()) {
    blocks.push(`【报错信息】\n${redactSecrets(context.errorText.trim())}`);
  }
  if (context.sampleText?.trim()) {
    blocks.push(`【接口响应样本（截断）】\n${redactSecrets(context.sampleText.trim()).slice(0, SAMPLE_TEXT_LIMIT)}`);
  }
  if (context.currentCardSpec?.trim()) {
    blocks.push(`【当前卡片配置】\n${redactSecrets(context.currentCardSpec.trim())}`);
  }

  const messages: AiChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: blocks.join("\n\n") },
  ];
  return { messages, outboundPreview: JSON.stringify(messages, null, 2) };
}
