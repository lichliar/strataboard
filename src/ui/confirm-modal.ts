import { App, Modal, Setting } from "obsidian";

// Minimal generic confirmation dialog: a message paragraph plus 取消/确认
// buttons. The confirm action carries Obsidian's warning styling — this modal
// is for irreversible operations (e.g. cache cleanup triggered from main.ts).
export class ConfirmModal extends Modal {
  private readonly message: string;
  private readonly onConfirm: () => void;

  constructor(app: App, message: string, onConfirm: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: this.message });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("确认")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
