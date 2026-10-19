// Right-sidebar task panel for the in-plugin AI assistant (W08-C). One
// active task card at a time — not a chat log. State machine:
// unconfigured → idle (task picker + goal input) → running →
// proposal | error. The panel only ever talks to the AiTaskRunner seam
// (submit/revise/cancel); it never sees messages, retries, or parsing.
// Sessions are not persisted; closing the view cancels the in-flight round.
//
// Source proposals (add-source / fix-source, stage 4) render a field diff, a
//「测试并预览」probe (host.probeSourceDraft — read-only, never blocks) and
// the「打开表单完成保存」primary action, which opens the prefilled source
// form via host.applyProposal; the actual save goes through the form's own
// probe/validation/credential UI. Card / indicator / script proposals are
// wired by stages 5-6.

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import type { CustomSourceDef } from "../types";
import type { AiConnectionConfig } from "../modules/ai/client";
import type { AiProposal, AiTaskKind, ProposalContext } from "../modules/ai/proposals";
import type { AiTaskContext, AiTaskRequest } from "../modules/ai/tasks";
import { AiTaskRunner, type AiRunResult } from "../modules/ai/runner";
import { AiCopyPreviewModal } from "./ai-copy-preview-modal";

export const VIEW_TYPE_STRATABOARD_AI = "strataboard-ai-panel";

// Outcome of host.probeSourceDraft — never throws; failures come back as
// { ok: false } so the panel can show them inline without breaking the flow.
export type SourceProbeResult = { ok: true; rows: number; format: string } | { ok: false; error: string };

// Everything the panel needs from the plugin, injected by main.ts — the
// view never reaches into settings or the credential store itself.
export interface AiPanelHost {
  // Current BYOK connection. cfg fields may be blank when unconfigured; the
  // API key is resolved here from SecretStorage behind the credentialId.
  getAiConfig(): { cfg: AiConnectionConfig; configured: boolean };
  // Validator context: plaintext-loopback allowlist + existing source ids.
  getProposalContext(): ProposalContext;
  // Base task context for panel-started tasks (existing source summaries).
  getTaskContext(): Pick<AiTaskContext, "existingSources" | "existingIndicators">;
  // Opens 设置 → AI 助手 (both the unconfigured and the error state lead there).
  openAiSettings(): void;
  // Read-only probe of an add-source draft / fix-source patch (sourceId
  // resolves the existing source's credential). Saves nothing.
  probeSourceDraft(draft: Partial<CustomSourceDef>, sourceId?: string): Promise<SourceProbeResult>;
  // Per-kind proposal execution — source kinds are wired (stage 4); card /
  // indicator / script kinds arrive with stages 5-6. The panel renders no
  // apply action until a host provides this.
  applyProposal?(proposal: AiProposal, panel: AiPanelView): Promise<void>;
}

type PanelPhase =
  | { name: "idle" }
  | { name: "running" }
  | { name: "proposal"; proposal: AiProposal; outboundPreview: string }
  | { name: "error"; error: string; outboundPreview?: string };

const KIND_TITLES: Record<AiTaskKind, string> = {
  "add-source": "配置数据源",
  "fix-source": "修复数据源",
  "quote-card": "创建数据卡",
  "overlay-card": "创建对比卡",
  "spread-card": "创建计算卡",
  indicator: "创建指标",
  "indicator-doc": "创建指标说明",
  script: "创建脚本",
};

const KIND_HINTS: Record<AiTaskKind, string> = {
  "add-source": "描述接口地址与返回的数据形态，AI 会生成数据源配置草稿提案。",
  "fix-source": "已带入当前配置与报错信息，可直接发送，也可补充说明。",
  "quote-card": "基于已有数据源生成数据卡配置提案。",
  "overlay-card": "基于已有数据源生成多序列对比卡配置提案。",
  "spread-card": "基于已有数据源生成计算卡（公式）配置提案。",
  indicator: "生成自定义技术指标（.js）代码提案。",
  "indicator-doc": "为已有指标生成中文 Markdown 说明和 Matplotlib 示意图脚本。",
  script: "生成数据处理 Python 脚本提案。",
};

// Idle-state quick tasks. fix-source is excluded: it is entered with context
// (current config + error) from an external entry point, never from scratch.
const QUICK_TASKS: { kind: AiTaskKind; label: string }[] = [
  { kind: "add-source", label: "添加数据源" },
  { kind: "quote-card", label: "创建数据卡" },
  { kind: "overlay-card", label: "创建对比卡" },
  { kind: "spread-card", label: "创建计算卡" },
  { kind: "indicator", label: "创建指标" },
  { kind: "indicator-doc", label: "创建指标说明" },
  { kind: "script", label: "创建脚本" },
];

export class AiPanelView extends ItemView {
  private readonly host: AiPanelHost;
  private runner: AiTaskRunner | null = null;
  private phase: PanelPhase = { name: "idle" };
  // The active task: kind + fixed context. The goal lives in goalText (the
  // textarea mirrors it so re-renders never lose the user's input).
  private request: AiTaskRequest | null = null;
  // Panel-started tasks rebuild their base context at submit time (sources
  // may have changed since the quick button was clicked); externally
  // injected tasks keep the context they were handed.
  private panelInitiated = false;
  private goalText = "";
  private focusInputOnRender = false;
  // Source-proposal probe outcome ("pending" while in flight); reset whenever
  // the phase changes so a revised proposal never shows a stale result.
  private probeResult: SourceProbeResult | "pending" | null = null;
  // The revise textarea mirrors this so a probe-triggered re-render never
  // loses the user's half-typed feedback.
  private reviseText = "";

  constructor(leaf: WorkspaceLeaf, host: AiPanelHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return VIEW_TYPE_STRATABOARD_AI;
  }

  getDisplayText(): string {
    return t("AI 助手");
  }

  getIcon(): string {
    // Obsidian's built-in lucide set — no registration needed.
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    this.runner?.cancel();
    this.runner = null;
  }

  // main.ts entry for context-carrying tasks (fix-source now, card-editor
  // assist in later stages): replaces the active task and focuses the input.
  startTask(task: AiTaskRequest): void {
    this.runner?.cancel();
    this.runner = null;
    this.request = task;
    this.panelInitiated = false;
    this.goalText = task.goal;
    this.probeResult = null;
    this.reviseText = "";
    this.phase = { name: "idle" };
    this.focusInputOnRender = true;
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("fc-ai-panel");

    if (!this.host.getAiConfig().configured) {
      this.renderUnconfigured(contentEl);
      return;
    }

    const kind = this.request?.kind ?? null;
    if (kind) {
      const head = contentEl.createDiv("fc-ai-head");
      head.createDiv({ cls: "fc-ai-title", text: t(KIND_TITLES[kind]) });
      head.createDiv({ cls: "fc-ai-context", text: t(KIND_HINTS[kind]) });
    }

    switch (this.phase.name) {
      case "idle":
        this.renderIdle(contentEl, kind);
        break;
      case "running":
        this.renderRunning(contentEl);
        break;
      case "proposal":
        this.renderProposal(contentEl, this.phase.proposal, this.phase.outboundPreview);
        break;
      case "error":
        this.renderError(contentEl, this.phase.error, this.phase.outboundPreview);
        break;
    }
  }

  private renderUnconfigured(contentEl: HTMLElement): void {
    contentEl.createDiv({
      cls: "fc-ai-context",
      text: t("尚未配置插件内 AI：请在设置页「AI 助手」中填写服务商接口地址、模型名与凭据，再回到这里使用。"),
    });
    const actions = contentEl.createDiv("fc-ai-actions");
    const btn = actions.createEl("button", { cls: "mod-cta", text: t("打开 AI 设置") });
    btn.addEventListener("click", () => this.host.openAiSettings());
  }

  private renderIdle(contentEl: HTMLElement, activeKind: AiTaskKind | null): void {
    const quick = contentEl.createDiv("fc-ai-quick");
    for (const { kind, label } of QUICK_TASKS) {
      if (kind === "indicator") quick.createDiv({ cls: "fc-ai-task-group", text: t("指标") });
      const btn = quick.createEl("button", { cls: "fc-ai-quick-btn", text: t(label) });
      if (kind === activeKind) btn.addClass("is-active");
      btn.addEventListener("click", () => {
        this.runner?.cancel();
        this.runner = null;
        this.request = { kind, goal: this.goalText, context: this.host.getTaskContext() };
        this.panelInitiated = true;
        this.focusInputOnRender = true;
        this.render();
      });
    }

    const input = contentEl.createDiv("fc-ai-input");
    const area = input.createEl("textarea", { placeholder: t("描述你的需求…") });
    area.rows = 4;
    area.value = this.goalText;

    const actions = contentEl.createDiv("fc-ai-actions");
    const send = actions.createEl("button", { cls: "mod-cta", text: t("发送") });
    const updateSend = () => {
      send.disabled = !this.request || (!this.goalText.trim() && !this.canSendWithoutGoal());
    };
    send.addEventListener("click", () => void this.submit());

    area.addEventListener("input", () => {
      this.goalText = area.value;
      updateSend();
    });
    area.addEventListener("keydown", (event) => {
      // Enter sends, Shift+Enter is a newline; never hijack IME composition.
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!send.disabled) void this.submit();
      }
    });
    updateSend();

    if (this.focusInputOnRender) {
      this.focusInputOnRender = false;
      area.focus();
    }
  }

  private renderRunning(contentEl: HTMLElement): void {
    const status = contentEl.createDiv("fc-ai-status");
    status.createDiv("fc-ai-spinner");
    status.createSpan({ text: t("正在等待服务商响应…") });
    const cancelBtn = status.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.cancelRun());
  }

  private renderProposal(contentEl: HTMLElement, proposal: AiProposal, outboundPreview: string): void {
    const card = contentEl.createDiv("fc-ai-proposal");
    card.createDiv({ cls: "fc-ai-proposal-summary", text: proposal.summary });
    const isSourceProposal = proposal.kind === "add-source" || proposal.kind === "fix-source";
    if (isSourceProposal) this.renderSourceDiff(card, proposal);
    const row = card.createDiv("fc-ai-actions");

    let detailsEl: HTMLElement | null = null;
    const detailsBtn = row.createEl("button", { text: t("查看详情") });
    detailsBtn.addEventListener("click", () => {
      if (detailsEl) {
        detailsEl.remove();
        detailsEl = null;
        return;
      }
      detailsEl = card.createEl("pre", {
        cls: "fc-mono fc-ai-details",
        text: JSON.stringify(proposal, null, 2),
      });
    });

    const outboundBtn = row.createEl("button", { text: t("查看发送内容") });
    outboundBtn.addEventListener("click", () => {
      new AiCopyPreviewModal(this.app, outboundPreview).open();
    });

    if (isSourceProposal) {
      // Secondary action: probe the draft/patch read-only. A failed probe
      // shows inline but never blocks opening the form.
      const probeBtn = row.createEl("button", { text: t("测试并预览") });
      if (this.probeResult === "pending") probeBtn.disabled = true;
      probeBtn.addEventListener("click", () => void this.probeDraft(proposal));
      if (this.host.applyProposal) {
        const applyBtn = row.createEl("button", { cls: "mod-cta", text: t("打开表单完成保存") });
        applyBtn.addEventListener("click", () => void this.host.applyProposal?.(proposal, this));
      }
      if (this.probeResult && this.probeResult !== "pending") {
        const result = this.probeResult;
        const line = card.createDiv("fc-ai-probe-result");
        if (result.ok) {
          line.setText(t("识别为 {format}，共 {n} 行。", { format: result.format, n: result.rows }));
        } else {
          line.addClass("is-error");
          line.setText(t("探测失败：{msg}", { msg: result.error }));
        }
      }
    } else if (this.host.applyProposal) {
      const labels: Partial<Record<AiProposal["kind"], string>> = {
        "quote-card": "创建数据卡",
        "overlay-card": "创建对比卡",
        "spread-card": "创建计算卡",
        indicator: "保存指标草稿",
        "indicator-doc": "保存指标说明",
        script: "保存脚本草稿",
      };
      const applyBtn = row.createEl("button", { cls: "mod-cta", text: t(labels[proposal.kind] ?? "应用提案") });
      applyBtn.addEventListener("click", () => void this.host.applyProposal?.(proposal, this));
    }

    const input = contentEl.createDiv("fc-ai-input");
    const area = input.createEl("textarea", { placeholder: t("输入修改意见…") });
    area.rows = 3;
    area.value = this.reviseText;
    const actions = contentEl.createDiv("fc-ai-actions");
    const reviseBtn = actions.createEl("button", { cls: "mod-cta", text: t("提交修改意见") });
    reviseBtn.disabled = !this.reviseText.trim();
    area.addEventListener("input", () => {
      this.reviseText = area.value;
      reviseBtn.disabled = !area.value.trim();
    });
    reviseBtn.addEventListener("click", () => void this.revise(area.value.trim()));
  }

  // Field-level view of a source proposal: add-source shows the whole draft,
  // fix-source only the fields the patch would change. Non-string values
  // (jsonMap, headers…) render as truncated JSON.
  private renderSourceDiff(card: HTMLElement, proposal: Extract<AiProposal, { kind: "add-source" | "fix-source" }>): void {
    const fields = proposal.kind === "add-source" ? proposal.draft : proposal.patch;
    const box = card.createDiv("fc-ai-diff");
    box.createDiv({
      cls: "fc-ai-diff-title",
      text: proposal.kind === "add-source" ? t("草稿详情") : t("将修改的字段"),
    });
    for (const [key, value] of Object.entries(fields)) {
      const row = box.createDiv("fc-ai-diff-row");
      row.createSpan({ cls: "fc-ai-diff-key", text: key });
      const text = typeof value === "string" ? value : JSON.stringify(value);
      row.createSpan({ text: text.length > 120 ? `${text.slice(0, 120)}…` : text });
    }
  }

  // Read-only probe of a source proposal; the outcome renders inline on the
  // proposal card. A slow probe re-renders with the button disabled.
  private async probeDraft(proposal: Extract<AiProposal, { kind: "add-source" | "fix-source" }>): Promise<void> {
    if (this.probeResult === "pending") return;
    this.probeResult = "pending";
    this.render();
    const draft = proposal.kind === "fix-source" ? proposal.patch : proposal.draft;
    const sourceId = proposal.kind === "fix-source" ? proposal.sourceId : undefined;
    this.probeResult = await this.host.probeSourceDraft(draft, sourceId);
    // A revise/cancel during the probe moved the panel on; drop the result.
    if (this.phase.name !== "proposal") return;
    this.render();
  }

  private renderError(contentEl: HTMLElement, error: string, outboundPreview?: string): void {
    const box = contentEl.createDiv("fc-ai-error");
    box.createDiv({ text: error });
    const actions = contentEl.createDiv("fc-ai-actions");
    if (outboundPreview) {
      const outboundBtn = actions.createEl("button", { text: t("查看发送内容") });
      outboundBtn.addEventListener("click", () => {
        new AiCopyPreviewModal(this.app, outboundPreview).open();
      });
    }
    const manualBtn = actions.createEl("button", { text: t("打开手动设置") });
    manualBtn.addEventListener("click", () => this.host.openAiSettings());
    const retryBtn = actions.createEl("button", { cls: "mod-cta", text: t("重试") });
    retryBtn.addEventListener("click", () => void this.submit());
  }

  // fix-source (and later context-carrying kinds) may be sent with an empty
  // goal — the attached context speaks for itself.
  private canSendWithoutGoal(): boolean {
    const context = this.request?.context;
    return !!context && !!(context.sourceDraft || context.errorText || context.currentCardSpec);
  }

  private async submit(): Promise<void> {
    const req = this.request;
    if (!req || this.phase.name === "running") return;
    const { cfg, configured } = this.host.getAiConfig();
    if (!configured) {
      this.render();
      return;
    }
    const request: AiTaskRequest = {
      kind: req.kind,
      goal: this.goalText.trim(),
      context: this.panelInitiated ? this.host.getTaskContext() : req.context,
    };
    this.request = request;
    // A fresh runner per submission: retry restarts the task from scratch.
    this.runner = new AiTaskRunner(cfg, this.host.getProposalContext());
    this.phase = { name: "running" };
    this.render();
    this.applyResult(await this.runner.submit(request));
  }

  private async revise(feedback: string): Promise<void> {
    if (!this.runner || this.phase.name !== "proposal") return;
    this.reviseText = "";
    this.probeResult = null;
    this.phase = { name: "running" };
    this.render();
    this.applyResult(await this.runner.revise(feedback));
  }

  private applyResult(result: AiRunResult): void {
    // cancelRun() already reset the UI; a late response is dropped.
    if (result.status === "cancelled") return;
    this.probeResult = null;
    this.phase =
      result.status === "error"
        ? { name: "error", error: result.error, outboundPreview: result.outboundPreview }
        : { name: "proposal", proposal: result.proposal, outboundPreview: result.outboundPreview };
    this.render();
  }

  private cancelRun(): void {
    this.runner?.cancel();
    this.runner = null;
    this.probeResult = null;
    this.phase = { name: "idle" };
    this.focusInputOnRender = true;
    this.render();
  }
}
