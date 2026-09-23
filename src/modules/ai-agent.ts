import { formatDate } from "../utils/date";
import { runCli, type ResolvedCli, type RunningCli } from "./ai-cli";
import { runApiModel } from "./ai-api";
import type { AiTool, AiToolContext } from "./ai-tools";

// Agent loop over a model's one-shot mode — a local CLI's non-interactive
// invocation, or an online OpenAI-compatible API model (cli.api set, see
// ai-api.ts). Each round re-sends the whole transcript (system prompt +
// messages + tool results) as a single prompt; the model requests tools by
// emitting fenced json blocks:
//
//   ```json
//   {"tool": "search_symbols", "args": {"query": "贵州茅台"}}
//   ```
//
// A reply with no tool block is the final answer. Stateless by design — works
// with any backend that maps one prompt to one answer.

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export type AgentEvent =
  | { type: "round"; round: number }
  | { type: "tool-call"; callId: number; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; callId: number; ok: boolean; text: string }
  | { type: "done"; answer: string };

export interface AgentLoopOptions<TCtx = AiToolContext> {
  cli: ResolvedCli;
  tools: AiTool<TCtx>[];
  ctx: TCtx;
  messages: ChatMessage[]; // prior conversation, newest last
  maxRounds: number;
  // Overrides the default general-assistant system prompt (scoped agents
  // like the custom-source setup assistant pass their own).
  systemPrompt?: string;
  // Only consulted for confirm:true tools; resolve false to reject the call.
  requestConfirm: (tool: AiTool<TCtx>, args: Record<string, unknown>) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
  isCancelled: () => boolean;
  // Hands the in-flight request handle to the caller (for 停止按钮).
  registerRunning: (running: RunningCli | null) => void;
}

interface ParsedToolCall {
  tool: string;
  args: Record<string, unknown>;
}

// Extracts fenced ```json blocks and keeps the ones shaped like a tool call.
// Returns parse errors for json blocks that LOOK like tool calls but fail to
// parse, so the model gets a chance to fix its own output.
function extractToolCalls(text: string): { calls: ParsedToolCall[]; errors: string[]; rest: string } {
  const calls: ParsedToolCall[] = [];
  const errors: string[] = [];
  const re = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let rest = text;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[1].trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Only complain when it quacks like a tool call.
      if (raw.includes('"tool"')) errors.push(`无法解析的 JSON 工具调用：${raw.slice(0, 200)}`);
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ParsedToolCall).tool === "string"
    ) {
      const call = parsed as ParsedToolCall;
      call.args = typeof call.args === "object" && call.args !== null ? call.args : {};
      calls.push(call);
      rest = rest.replace(match[0], "");
    }
  }
  return { calls, errors, rest: rest.trim() };
}

export function buildSystemPrompt<TCtx>(tools: AiTool<TCtx>[]): string {
  const toolDocs = tools
    .map((tool) => `- ${tool.name}：${tool.description}\n  参数：${tool.paramsDoc}`)
    .join("\n");
  const today = formatDate(new Date());

  return `你是 Obsidian 插件 StrataBoard 的内置金融数据助手，运行在用户的 Obsidian 中。今天是 ${today}（YYYYMMDD）。

StrataBoard 能把金融数据卡片插入 Obsidian 画布：tushare K线卡（A股/基金/指数/港股/全球指数/可转债/期货/外汇/申万行业/自定义源）、FRED 卡、中国宏观卡、overlay 多系列叠加卡、spread 表达式计算卡（如 A-B）、TradingView 小组件卡、日历卡。

# 工具调用协议

你可以调用以下工具。需要调用时，在回复中输出一个独立的 json 代码块，格式：
\`\`\`json
{"tool": "工具名", "args": {...}}
\`\`\`
- 一轮可以输出多个工具调用块；工具结果会在下一轮以用户消息的形式返回给你。
- 不需要工具时直接输出纯文本回答（不再带任何代码块）。
- 不要在同一轮里既给最终结论又调用工具：先调用工具，等结果回来再总结。

# 可用工具

${toolDocs}

# 卡片 YAML 格式参考（create_card 的 body 参数）

tushare 卡（中文字段；类型见 search_symbols 返回，周期 D|W|M，范围 1y|3y|5y|10y|20y|ytd|max）：
代码: 600519.SH
类型: stock
周期: D
范围: 1y
版本: 1

overlay 卡（英文键；series 每项为 {source: quote|macro|fred, tsCode/seriesId, assetType, label?}，最多 10 项）：
series:
  - source: quote
    tsCode: 600519.SH
    assetType: stock
    label: 贵州茅台
  - source: fred
    seriesId: DGS10
range: 3y

spread 卡在 overlay 基础上加 expression 字段（字母 A/B/C 按 series 顺序指代），如 expression: A-B。
fred 卡：seriesId: DGS10，label: 10年期美债收益率，range: 10y，可加 transform（chg|ch1|pch|pc1|pca|cch|cca|log）。
macro 卡：seriesId: m1_yoy（用 list_macro_series 查全部 id），range: 10y。

# 行为准则

- 用中文回答，数据结论注明日期与单位。
- 建卡前先 search_symbols 确认代码和资产类型；创建后主动调用 place_card_on_canvas 放上画布（若用户要求）。
- 涉及写操作（建卡、上画布、保存数据源）的工具会先经用户确认，被拒时尊重用户决定并改用说明性回答。
- 不要臆造数据；查不到就如实说明。`;
}

// Runs the loop to completion and returns the final assistant text.
// Intermediate progress is reported through opts.onEvent.
export async function runAgentLoop<TCtx = AiToolContext>(opts: AgentLoopOptions<TCtx>): Promise<string> {
  const { cli, tools, ctx, maxRounds, onEvent } = opts;
  const systemPrompt = opts.systemPrompt ?? buildSystemPrompt(tools);
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

  // Working transcript; tool results are appended as user messages.
  const transcript: ChatMessage[] = [...opts.messages];
  let callId = 0;
  let parseErrorRounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (opts.isCancelled()) throw new Error("cancelled");
    onEvent({ type: "round", round });

    const prompt = [
      systemPrompt,
      "",
      "# 对话记录",
      "",
      ...transcript.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text}`),
      "",
      "助手：",
    ].join("\n");

    const running = cli.api ? runApiModel(cli.api, prompt) : runCli(cli, prompt);
    opts.registerRunning(running);
    let reply: string;
    try {
      reply = await running.promise;
    } finally {
      opts.registerRunning(null);
    }
    if (opts.isCancelled()) throw new Error("cancelled");

    const { calls, errors, rest } = extractToolCalls(reply);

    if (calls.length === 0) {
      if (errors.length > 0 && parseErrorRounds < 2) {
        parseErrorRounds++;
        transcript.push({ role: "assistant", text: reply });
        transcript.push({
          role: "user",
          text: `你的工具调用 JSON 无法解析：${errors.join("；")}。请重新输出格式正确的工具调用块，或直接用纯文本回答。`,
        });
        continue;
      }
      onEvent({ type: "done", answer: rest || reply });
      return rest || reply;
    }
    parseErrorRounds = 0;

    transcript.push({ role: "assistant", text: reply });

    for (const call of calls) {
      const id = callId++;
      onEvent({ type: "tool-call", callId: id, tool: call.tool, args: call.args });
      const tool = toolByName.get(call.tool);
      let resultText: string;
      let ok = true;
      if (!tool) {
        ok = false;
        resultText = `未知工具：${call.tool}。可用工具：${tools.map((x) => x.name).join(", ")}`;
      } else if (tool.confirm && !(await opts.requestConfirm(tool, call.args))) {
        ok = false;
        resultText = "用户拒绝了本次操作。";
      } else {
        try {
          resultText = await tool.run(call.args, ctx);
        } catch (e) {
          ok = false;
          resultText = `工具执行失败：${e instanceof Error ? e.message : String(e)}`;
        }
      }
      onEvent({ type: "tool-result", callId: id, ok, text: resultText });
      transcript.push({
        role: "user",
        text: `[工具 ${call.tool} ${ok ? "执行成功" : "执行失败"}]\n${resultText}`,
      });
    }
  }

  const fallback = "已达到单次对话的最大工具调用轮数，请换个问法或拆小任务再试。";
  onEvent({ type: "done", answer: fallback });
  return fallback;
}
