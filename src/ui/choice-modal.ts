import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

// Minimal generic choice modal: a message paragraph plus 2–3 option buttons;
// closing (incl. 取消) is a no-op. Used by the card edit modal's 指标组 apply
// flow (追加 / 替换 / 取消).
export interface ChoiceOption {
  label: string;
  onPick: () => void;
  cta?: boolean;
  warning?: boolean;
}

export class ChoiceModal extends Modal {
  constructor(
    app: App,
    private readonly message: string,
    private readonly options: ChoiceOption[]
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: this.message });

    const row = new Setting(contentEl);
    row.addButton((button) =>
      button.setButtonText(t("取消")).onClick(() => {
        this.close();
      })
    );
    for (const option of this.options) {
      row.addButton((button) => {
        button.setButtonText(option.label).onClick(() => {
          this.close();
          option.onPick();
        });
        if (option.cta) button.setCta();
        if (option.warning) button.setWarning();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
