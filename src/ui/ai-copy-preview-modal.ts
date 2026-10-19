import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";
import { redactSecrets } from "../modules/redact";

// Gate for every "copy to AI" action: shows the (already redacted and
// minimized) payload in an editable box so the user can review, trim or
// cancel before anything reaches the clipboard. The warning names the risk —
// external AI services have their own privacy policies.
export class AiCopyPreviewModal extends Modal {
  private readonly content: string;

  constructor(app: App, content: string) {
    super(app);
    this.content = redactSecrets(content);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("复制给 AI 前请检查内容") });
    const area = contentEl.createEl("textarea", {
      cls: "strataboard-ai-copy-preview",
      text: this.content,
    });
    area.rows = 14;
    area.style.width = "100%";
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t("外部 AI 服务有自己的隐私政策。请勿发送密钥、Cookie、账户信息或未获授权的数据；以下内容已经过脱敏，仍请确认后再复制。"),
    });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(t("取消")).onClick(() => {
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText(t("复制"))
          .setCta()
          .onClick(async () => {
            await navigator.clipboard.writeText(area.value);
            new Notice(t("已复制到剪贴板。"));
            this.close();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
