import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

// Minimal generic text prompt: a title, one input (single-line by default,
// multiline textarea on demand), 取消/确认 buttons. Empty input refuses to
// confirm unless allowEmpty. Used for source-group rename / new-group naming
// and group-icon SVG editing in settings.
export class TextInputModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private readonly title: string,
    private readonly onSubmit: (value: string) => void,
    initialValue = "",
    private readonly opts: { multiline?: boolean; allowEmpty?: boolean } = {}
  ) {
    super(app);
    this.value = initialValue;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.title);

    if (this.opts.multiline) {
      new Setting(contentEl).addTextArea((text) => {
        text.setValue(this.value).onChange((v) => {
          this.value = v;
        });
        text.inputEl.addClass("fc-mono");
        window.setTimeout(() => text.inputEl.focus(), 0);
      });
    } else {
      new Setting(contentEl).addText((text) => {
        text.setValue(this.value).onChange((v) => {
          this.value = v;
        });
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.submit();
          }
        });
        window.setTimeout(() => text.inputEl.focus(), 0);
      });
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(t("取消")).onClick(() => {
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText(t("确认"))
          .setCta()
          .onClick(() => this.submit())
      );
  }

  private submit(): void {
    const trimmed = this.value.trim();
    if (!trimmed && !this.opts.allowEmpty) return;
    this.close();
    this.onSubmit(trimmed);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
