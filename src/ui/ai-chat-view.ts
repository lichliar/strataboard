import { ItemView, MarkdownRenderer, WorkspaceLeaf, setIcon } from "obsidian";
import type { App } from "obsidian";
import { t } from "../i18n";
import type { ResolvedCli, RunningCli } from "../modules/ai-cli";
import { runAgentLoop, type ChatMessage } from "../modules/ai-agent";
import { buildAiTools, type AiTool, type AiToolContext } from "../modules/ai-tools";

export const AI_CHAT_VIEW_TYPE = "strataboard-ai-chat";

// Everything the chat view needs from the plugin, injected by main.ts — the
// view itself never touches the Plugin instance (same DI convention as the
// modals under ui/).
export interface AiChatViewDeps {
  app: App;
  // Online API providers + detected preset/custom CLIs, ready to run.
  listClis: () => Promise<ResolvedCli[]>;
  getSelectedCliId: () => string;
  setSelectedCliId: (id: string) => Promise<void>;
  getConfirmWrites: () => boolean;
  getMaxRounds: () => number;
  toolContext: () => AiToolContext;
  openAiSettings: () => void;
}

export class AiChatView extends ItemView {
  private deps: AiChatViewDeps;
  private messages: ChatMessage[] = [];
  private clis: ResolvedCli[] = [];
  private running = false;
  private runningCli: RunningCli | null = null;
  private cancelled = false;

  private cliSelect!: HTMLSelectElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private toolRows = new Map<number, HTMLElement>();

  constructor(leaf: WorkspaceLeaf, deps: AiChatViewDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string {
    return AI_CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("AI 助手");
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl.createDiv({ cls: "fc-ai-chat fc-hermes" });

    const header = root.createDiv({ cls: "fc-ai-chat-header" });
    this.cliSelect = header.createEl("select", { cls: "fc-ai-chat-cli dropdown" });
    this.cliSelect.addEventListener("change", () => {
      void this.deps.setSelectedCliId(this.cliSelect.value);
    });
    const clearBtn = header.createEl("button", { cls: "fc-ai-chat-icon-btn", attr: { "aria-label": t("清空对话") } });
    setIcon(clearBtn, "trash-2");
    clearBtn.addEventListener("click", () => this.clearChat());
    const settingsBtn = header.createEl("button", { cls: "fc-ai-chat-icon-btn", attr: { "aria-label": t("AI 设置") } });
    setIcon(settingsBtn, "settings");
    settingsBtn.addEventListener("click", () => this.deps.openAiSettings());

    this.messagesEl = root.createDiv({ cls: "fc-ai-chat-messages" });

    const inputRow = root.createDiv({ cls: "fc-ai-chat-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "fc-ai-chat-input",
      attr: { placeholder: t("问点什么，例如：帮我查一下贵州茅台最近的走势"), rows: "3" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    this.sendBtn = inputRow.createEl("button", { cls: "fc-ai-chat-send mod-cta", text: t("发送") });
    this.sendBtn.addEventListener("click", () => {
      if (this.running) this.stop();
      else void this.send();
    });

    await this.refreshClis();
  }

  async onClose(): Promise<void> {
    this.stop();
  }

  // Rebuilds the CLI dropdown (called on open and after settings changes).
  async refreshClis(): Promise<void> {
    this.clis = await this.deps.listClis();
    this.cliSelect.empty();
    for (const cli of this.clis) {
      this.cliSelect.createEl("option", { text: cli.label, value: cli.id });
    }
    const selected = this.deps.getSelectedCliId();
    this.cliSelect.value = this.clis.some((c) => c.id === selected) ? selected : (this.clis[0]?.id ?? "");
    if (this.messages.length === 0) this.renderEmptyState();
  }

  private clearChat(): void {
    if (this.running) return;
    this.messages = [];
    this.toolRows.clear();
    this.renderEmptyState();
  }

  private renderEmptyState(): void {
    this.messagesEl.empty();
    if (this.clis.length === 0) {
      const empty = this.messagesEl.createDiv({ cls: "fc-ai-chat-empty" });
      empty.createDiv({ text: t("还没有配置可用的 AI 模型。") });
      empty.createDiv({
        cls: "fc-field-hint",
        text: t("可在设置中添加在线 API 模型（DeepSeek、GPT 等），或使用本机 CLI（claude / kimi / codex / gemini 等）。"),
      });
      const btn = empty.createEl("button", { cls: "mod-cta", text: t("打开 AI 设置") });
      btn.addEventListener("click", () => this.deps.openAiSettings());
    } else {
      this.messagesEl.createDiv({
        cls: "fc-ai-chat-empty fc-field-hint",
        text: t("可以问我：查行情、搜数据序列、创建数据卡片、配置数据源。"),
      });
    }
  }

  private stop(): void {
    this.cancelled = true;
    this.runningCli?.cancel();
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private addUserBubble(text: string): void {
    const el = this.messagesEl.createDiv({ cls: "fc-ai-chat-msg fc-ai-chat-msg-user" });
    el.createDiv({ cls: "fc-ai-chat-bubble", text });
    this.scrollToBottom();
  }

  private addAssistantBubble(text: string): void {
    const el = this.messagesEl.createDiv({ cls: "fc-ai-chat-msg fc-ai-chat-msg-assistant" });
    const bubble = el.createDiv({ cls: "fc-ai-chat-bubble" });
    void MarkdownRenderer.render(this.deps.app, text, bubble, "", this);
    this.scrollToBottom();
  }

  private addErrorBubble(text: string): void {
    const el = this.messagesEl.createDiv({ cls: "fc-ai-chat-msg fc-ai-chat-msg-error" });
    el.createDiv({ cls: "fc-ai-chat-bubble", text });
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

  // Inline confirm card for write-capable tools; resolves the loop's promise.
  private askConfirm(tool: AiTool, args: Record<string, unknown>): Promise<boolean> {
    return new Promise((resolve) => {
      const row = this.messagesEl.createDiv({ cls: "fc-ai-chat-confirm" });
      row.createDiv({ cls: "fc-ai-chat-confirm-title", text: t("AI 请求执行：{name}", { name: tool.name }) });
      const preview = row.createEl("pre", { cls: "fc-ai-chat-confirm-args fc-mono" });
      preview.setText(JSON.stringify(args, null, 2).slice(0, 1200));
      const buttons = row.createDiv({ cls: "fc-ai-chat-confirm-btns" });
      const allow = buttons.createEl("button", { cls: "mod-cta", text: t("允许") });
      const deny = buttons.createEl("button", { text: t("拒绝") });
      allow.addEventListener("click", () => {
        row.addClass("fc-ai-chat-confirm-done");
        buttons.remove();
        row.createDiv({ cls: "fc-field-hint", text: t("已允许") });
        resolve(true);
      });
      deny.addEventListener("click", () => {
        row.addClass("fc-ai-chat-confirm-done");
        buttons.remove();
        row.createDiv({ cls: "fc-field-hint", text: t("已拒绝") });
        resolve(false);
      });
      this.scrollToBottom();
    });
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.running) return;

    const cliId = this.cliSelect.value;
    const cli = this.clis.find((c) => c.id === cliId) ?? this.clis[0];
    if (!cli) {
      this.renderEmptyState();
      return;
    }

    if (this.messages.length === 0) this.messagesEl.empty();
    this.messages.push({ role: "user", text });
    this.addUserBubble(text);
    this.inputEl.value = "";

    this.running = true;
    this.cancelled = false;
    this.sendBtn.setText(t("停止"));
    this.sendBtn.removeClass("mod-cta");
    this.toolRows.clear();

    const thinking = this.messagesEl.createDiv({ cls: "fc-ai-chat-thinking", text: t("思考中…") });

    try {
      const answer = await runAgentLoop({
        cli,
        tools: buildAiTools(),
        ctx: this.deps.toolContext(),
        messages: this.messages,
        maxRounds: this.deps.getMaxRounds(),
        requestConfirm: (tool, args) =>
          this.deps.getConfirmWrites() ? this.askConfirm(tool, args) : Promise.resolve(true),
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
      this.addAssistantBubble(answer);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.addErrorBubble(this.cancelled ? t("已停止。") : msg);
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
