import { Component, MarkdownRenderer } from "obsidian";
import type { App } from "obsidian";
import { t } from "../i18n";
import { runAgentLoop, type ChatMessage } from "../modules/ai-agent";
import type { RunningCli } from "../modules/ai-cli";
import type { AiTool } from "../modules/ai-tools";
import type { ResolvedCli } from "../modules/ai-cli";

// Compact chat embedded in the custom-source wizard's「2. AI 辅助设置」
// section. Runs the same stateless agent loop as the sidebar AI 助手, but
// with the source-assist tool set (fetch_url / apply_source_config) and a
// scoped system prompt rebuilt on every send so it carries the latest form
// state. The host modal owns the instance across re-renders: it detaches
// rootEl before emptying its content and re-appends it afterwards, so an
// in-flight conversation survives the detection-triggered re-renders.

export interface SourceAssistChatDeps {
  app: App;
  clis: ResolvedCli[];
  cliId: string;
  maxRounds: number;
  getSystemPrompt: () => string;
  tools: AiTool<null>[];
  // Fills the input for the "find me an endpoint" quick action.
  findPrefill: string;
  // Sent immediately by the "fix this source" quick action.
  fixRequest: string;
}

export class SourceAssistChat {
  readonly rootEl: HTMLElement;
  private deps: SourceAssistChatDeps;
  private messages: ChatMessage[] = [];
  private running = false;
  private runningCli: RunningCli | null = null;
  private cancelled = false;
  private toolRows = new Map<number, HTMLElement>();
  // Lifecycle owner for MarkdownRenderer output (the host Modal is not a
  // Component in the Obsidian typings).
  private mdComponent = new Component();

  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;

  constructor(container: HTMLElement, deps: SourceAssistChatDeps) {
    this.deps = deps;
    this.mdComponent.load();
    this.rootEl = container.createDiv({ cls: "fc-source-chat fc-hermes" });

    const quickRow = this.rootEl.createDiv({ cls: "fc-source-chat-quick" });
    const findBtn = quickRow.createEl("button", { text: t("帮我找一个数据接口") });
    findBtn.addEventListener("click", () => {
      this.inputEl.value = deps.findPrefill;
      this.inputEl.focus();
    });
    const fixBtn = quickRow.createEl("button", { text: t("帮我修当前接口") });
    fixBtn.addEventListener("click", () => void this.requestFix());

    this.messagesEl = this.rootEl.createDiv({ cls: "fc-ai-chat-messages fc-source-chat-messages" });
    this.renderEmptyState();

    const inputRow = this.rootEl.createDiv({ cls: "fc-ai-chat-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "fc-ai-chat-input",
      attr: { placeholder: t("描述你想要的数据，如：美国十年期国债收益率日线"), rows: "2" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send(this.inputEl.value);
      }
    });
    this.sendBtn = inputRow.createEl("button", { cls: "fc-ai-chat-send mod-cta", text: t("发送") });
    this.sendBtn.addEventListener("click", () => {
      if (this.running) this.stop();
      else void this.send(this.inputEl.value);
    });
  }

  // Cancels the in-flight CLI call; the host modal calls this on close.
  destroy(): void {
    this.stop();
    this.mdComponent.unload();
  }

  // Sends the "fix this source" request programmatically (quick button and
  // the wizard's save-time failure handoff). Returns false when a run is
  // already in flight.
  requestFix(): boolean {
    if (this.running) return false;
    void this.send(this.deps.fixRequest);
    return true;
  }

  private stop(): void {
    this.cancelled = true;
    this.runningCli?.cancel();
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderEmptyState(): void {
    this.messagesEl.empty();
    this.messagesEl.createDiv({
      cls: "fc-ai-chat-empty fc-field-hint",
      text: t("AI 会自己寻找并验证可用接口，把配置直接写入上方表单；确认无误后点「保存」。"),
    });
  }

  private addBubble(kind: "user" | "assistant" | "error", text: string): void {
    const cls =
      kind === "user"
        ? "fc-ai-chat-msg fc-ai-chat-msg-user"
        : kind === "error"
          ? "fc-ai-chat-msg fc-ai-chat-msg-error"
          : "fc-ai-chat-msg fc-ai-chat-msg-assistant";
    const el = this.messagesEl.createDiv({ cls });
    const bubble = el.createDiv({ cls: "fc-ai-chat-bubble" });
    if (kind === "assistant") {
      void MarkdownRenderer.render(this.deps.app, text, bubble, "", this.mdComponent);
    } else {
      bubble.setText(text);
    }
    this.scrollToBottom();
  }

  private upsertToolRow(callId: number, label: string, status: "running" | "ok" | "fail"): void {
    let row = this.toolRows.get(callId);
    if (!row) {
      row = this.messagesEl.createDiv({ cls: "fc-ai-chat-tool" });
      this.toolRows.set(callId, row);
    }
    row.empty();
    row.removeClass("fc-ai-chat-tool-ok", "fc-ai-chat-tool-fail", "fc-ai-chat-tool-running");
    row.addClass(`fc-ai-chat-tool-${status}`);
    row.createSpan({ cls: "fc-ai-chat-tool-label", text: label });
    this.scrollToBottom();
  }

  private async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text || this.running) return;

    const cli =
      this.deps.clis.find((c) => c.id === this.deps.cliId) ?? this.deps.clis[0];
    if (!cli) return;

    if (this.messages.length === 0) this.messagesEl.empty();
    this.messages.push({ role: "user", text });
    this.addBubble("user", text);
    this.inputEl.value = "";

    this.running = true;
    this.cancelled = false;
    this.sendBtn.setText(t("停止"));
    this.sendBtn.removeClass("mod-cta");
    this.toolRows.clear();

    const thinking = this.messagesEl.createDiv({ cls: "fc-ai-chat-thinking", text: t("思考中…") });

    try {
      const answer = await runAgentLoop<null>({
        cli,
        tools: this.deps.tools,
        ctx: null,
        messages: this.messages,
        maxRounds: this.deps.maxRounds,
        systemPrompt: this.deps.getSystemPrompt(),
        // The scoped tools carry no confirm:true entries.
        requestConfirm: () => Promise.resolve(true),
        onEvent: (event) => {
          if (event.type === "tool-call") {
            this.upsertToolRow(event.callId, `${event.tool}(${summarizeArgs(event.args)})`, "running");
          } else if (event.type === "tool-result") {
            const label = this.toolRows.get(event.callId)?.querySelector(".fc-ai-chat-tool-label")?.textContent ?? "";
            this.upsertToolRow(event.callId, label, event.ok ? "ok" : "fail");
          }
        },
        isCancelled: () => this.cancelled,
        registerRunning: (running) => {
          this.runningCli = running;
        },
      });
      this.messages.push({ role: "assistant", text: answer });
      this.addBubble("assistant", answer);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.addBubble("error", this.cancelled ? t("已停止。") : msg);
    } finally {
      thinking.remove();
      this.running = false;
      this.runningCli = null;
      this.sendBtn.setText(t("发送"));
      this.sendBtn.addClass("mod-cta");
      this.scrollToBottom();
    }
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  const joined = parts.join(", ");
  return joined.length > 80 ? `${joined.slice(0, 80)}…` : joined;
}
