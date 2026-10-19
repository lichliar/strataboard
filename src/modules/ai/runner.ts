// AiTaskRunner — the deep-module seam (W08-H) between the AI panel and the
// client/validator. A panel only ever calls submit / revise / cancel; it
// never sees messages, retries, or parsing. Pure TS, no obsidian imports.
//
// Multi-turn: the runner keeps the full messages array. A failed validation
// is still a round — the raw assistant reply plus the Chinese validation
// error stay in the transcript so revise() sends them back as context.
//
// Cancellation: http.ts requests cannot be aborted mid-flight, so cancel()
// bumps a generation token; any late submit/revise response resolves as
// {status:"cancelled"} instead of touching the transcript.

import { chatCompletion, type AiChatMessage, type AiConnectionConfig } from "./client";
import { parseProposal, type AiProposal, type ProposalContext } from "./proposals";
import { buildPrompt, type AiTaskRequest } from "./tasks";
import { redactError, redactSecrets } from "../redact";

export type AiRunResult =
  | { status: "proposal"; proposal: AiProposal; outboundPreview: string }
  | { status: "error"; error: string; outboundPreview?: string }
  | { status: "cancelled" };

export class AiTaskRunner {
  private messages: AiChatMessage[] = [];
  private generation = 0;

  constructor(
    private cfg: AiConnectionConfig,
    private ctx: ProposalContext
  ) {}

  // Starts a fresh task: replaces the transcript with the built prompt.
  async submit(req: AiTaskRequest): Promise<AiRunResult> {
    const built = buildPrompt(req);
    this.messages = [...built.messages];
    return this.round(built.outboundPreview);
  }

  // One more turn over the existing transcript: the previous assistant reply
  // (and any validation error) is already in it; the user's feedback is
  // appended and sent.
  async revise(feedback: string): Promise<AiRunResult> {
    if (this.messages.length === 0) {
      return { status: "error", error: "没有进行中的任务，请先提交需求。" };
    }
    this.messages.push({ role: "user", content: redactSecrets(feedback.trim()) });
    return this.round(JSON.stringify(this.messages, null, 2));
  }

  // Invalidates every in-flight round; late responses resolve as cancelled.
  cancel(): void {
    this.generation++;
  }

  private async round(outboundPreview: string): Promise<AiRunResult> {
    const gen = this.generation;
    let raw: string;
    try {
      raw = await chatCompletion(this.cfg, this.messages);
    } catch (e) {
      if (gen !== this.generation) return { status: "cancelled" };
      return { status: "error", error: redactError(e), outboundPreview };
    }
    if (gen !== this.generation) return { status: "cancelled" };

    this.messages.push({ role: "assistant", content: raw });
    const validation = parseProposal(raw, this.ctx);
    if (!validation.ok) {
      // Keep the failure in the transcript so revise() can ask for a fix.
      this.messages.push({
        role: "user",
        content: `上次返回未通过校验：${validation.error}\n请修正后重新只返回 JSON 对象。`,
      });
      return { status: "error", error: validation.error, outboundPreview };
    }
    return { status: "proposal", proposal: validation.proposal, outboundPreview };
  }
}
