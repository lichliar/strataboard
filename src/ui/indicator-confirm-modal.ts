import { App, Modal, Setting } from "obsidian";
import type { IndicatorApprovalDecision, PendingIndicatorApproval } from "../modules/indicators/loader";
import { t } from "../i18n";

// Batch approval for custom indicator files that are new or whose content
// changed since their last approval (W02-B). One modal per sync lists every
// pending file with its content hash; the user checks the ones they trust.
// Closing or cancelling rejects ALL pending files (they stay unloaded), and
// the loader remembers the rejection for the rest of the session so the
// modal cannot nag on every sync.
export class IndicatorConfirmModal extends Modal {
  private settled = false;
  private checked = new Set<string>();

  constructor(
    app: App,
    private readonly pending: PendingIndicatorApproval[],
    private readonly resolve: (decision: IndicatorApprovalDecision) => void
  ) {
    super(app);
    for (const entry of pending) this.checked.add(entry.path);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("确认运行自定义指标") });
    contentEl.createEl("p", {
      text: t("以下指标文件是新增的，或内容自上次确认后已变化。指标代码在插件内的受限 JavaScript 环境中运行，该环境只用于降低误操作风险，不能抵御恶意代码。仅启用你理解且信任的代码。"),
    });

    for (const entry of this.pending) {
      const row = contentEl.createDiv("fc-script-permission-row");
      const label = row.createEl("label");
      const box = label.createEl("input", { attr: { type: "checkbox" } });
      box.checked = this.checked.has(entry.path);
      box.addEventListener("change", () => {
        if (box.checked) {
          this.checked.add(entry.path);
        } else {
          this.checked.delete(entry.path);
        }
      });
      label.createSpan({ text: ` ${entry.relativePath}` });
      if (entry.changed) {
        label.createSpan({ cls: "fc-pill fc-pill-sm", text: t("内容已变化") });
      }
      row.createEl("code", { text: entry.hash.slice(0, 12) });
    }

    contentEl.createDiv({
      cls: "fc-field-hint",
      text: t("未勾选的指标不会加载或计算；内容再次变化或重载插件后会重新询问。"),
    });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText(t("取消")).onClick(() => this.finish(new Set())))
      .addButton((button) =>
        button.setButtonText(t("启用所选指标")).setWarning().onClick(() => this.finish(new Set(this.checked)))
      );
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve({ approved: [], rejected: this.pending });
    }
    this.contentEl.empty();
  }

  private finish(approvedPaths: Set<string>): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve({
      approved: this.pending.filter((entry) => approvedPaths.has(entry.path)),
      rejected: this.pending.filter((entry) => !approvedPaths.has(entry.path)),
    });
    this.close();
  }
}
