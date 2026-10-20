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
import { buildPrompt, sanitizeAiText, type AiTaskRequest } from "./tasks";
import { redactError, redactSecrets } from "../redact";

export type AiRunResult =
  | { status: "proposal"; proposal: AiProposal; outboundPreview: string }
  | { status: "error"; error: string; outboundPreview?: string }
  | { status: "cancelled" };

export interface AiTaskDiagnostic {
  stage: "created" | "context-built" | "context-truncated" | "sent" | "response-received" | "proposal-validated" | "validation-failed" | "cancelled" | "reset";
  at: number;
}

const DEFAULT_MAX_REVISE_ROUNDS = 2;

function extractJsonObject(raw: string): string | undefined {
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i)?.[1]?.trim();
  const source = fenced ?? raw.trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  const candidate = source.slice(start, end + 1);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

export class AiTaskRunner {
  private messages: AiChatMessage[] = [];
  private generation = 0;
  private reviseRounds = 0;
  private diagnostics: AiTaskDiagnostic[] = [];

  constructor(
    private cfg: AiConnectionConfig,
    private ctx: ProposalContext
  ) {}

  // Starts a fresh task: replaces the transcript with the built prompt.
  async submit(req: AiTaskRequest): Promise<AiRunResult> {
    this.diagnostics = [{ stage: "created", at: Date.now() }, { stage: "context-built", at: Date.now() }];
    this.reviseRounds = 0;
    const built = buildPrompt(req);
    if (built.contextTruncated) this.diagnostics.push({ stage: "context-truncated", at: Date.now() });
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
    const configuredMax = this.cfg.maxRevisionRounds;
    const maxRevisions = Number.isFinite(configuredMax)
      ? Math.min(5, Math.max(0, configuredMax as number))
      : DEFAULT_MAX_REVISE_ROUNDS;
    if (this.reviseRounds >= maxRevisions) {
      return { status: "error", error: `本任务最多修订 ${maxRevisions} 次，请新建任务或改用手动设置。` };
    }
    this.reviseRounds++;
    this.messages.push({ role: "user", content: sanitizeAiText(feedback.trim()) });
    return this.round(JSON.stringify(this.messages, null, 2));
  }

  // Starts a new task generation and drops every prior message. The panel
  // calls this on task switches, completion and close so one data-source
  // setup can never become hidden context for the next setup.
  reset(): void {
    this.generation++;
    this.messages = [];
    this.reviseRounds = 0;
    this.diagnostics = [{ stage: "reset", at: Date.now() }];
  }

  // Invalidates every in-flight round; late responses resolve as cancelled.
  cancel(): void {
    this.generation++;
    this.diagnostics.push({ stage: "cancelled", at: Date.now() });
  }

  getDiagnostics(): readonly AiTaskDiagnostic[] {
    return this.diagnostics.slice();
  }

  getQualitySnapshot(): { requests: number; validated: number; validationFailures: number; truncated: boolean; cancelled: number } {
    return {
      requests: this.diagnostics.filter((event) => event.stage === "sent").length,
      validated: this.diagnostics.filter((event) => event.stage === "proposal-validated").length,
      validationFailures: this.diagnostics.filter((event) => event.stage === "validation-failed").length,
      truncated: this.diagnostics.some((event) => event.stage === "context-truncated"),
      cancelled: this.diagnostics.filter((event) => event.stage === "cancelled").length,
    };
  }

  private async round(outboundPreview: string): Promise<AiRunResult> {
    const gen = this.generation;
    this.diagnostics.push({ stage: "sent", at: Date.now() });
    let raw: string;
    try {
      raw = await chatCompletion(this.cfg, this.messages);
    } catch (e) {
      if (gen !== this.generation) return { status: "cancelled" };
      return { status: "error", error: redactError(e), outboundPreview };
    }
    if (gen !== this.generation) return { status: "cancelled" };

    this.diagnostics.push({ stage: "response-received", at: Date.now() });
    this.messages.push({ role: "assistant", content: raw });
    let validation = parseProposal(raw, this.ctx);
    // Providers often wrap an otherwise valid object in a short explanation.
    // Repair only the JSON envelope locally; never rewrite fields or execute
    // model-provided code here.
    if (!validation.ok) {
      const repaired = extractJsonObject(raw);
      if (repaired && repaired !== raw.trim()) validation = parseProposal(repaired, this.ctx);
    }
    if (!validation.ok) {
      this.diagnostics.push({ stage: "validation-failed", at: Date.now() });
      // Keep the failure in the transcript so revise() can ask for a fix.
      this.messages.push({
        role: "user",
        content: `上次返回未通过校验：${validation.error}\n请修正后重新只返回 JSON 对象。`,
      });
      return { status: "error", error: validation.error, outboundPreview };
    }
    this.diagnostics.push({ stage: "proposal-validated", at: Date.now() });
    return { status: "proposal", proposal: validation.proposal, outboundPreview };
  }
}
