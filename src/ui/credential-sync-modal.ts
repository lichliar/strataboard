import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";

export class CredentialSyncPasswordModal extends Modal {
  private password = "";
  private confirmation = "";
  private remember = true;
  private busy = false;
  private submitButton?: ButtonComponent;

  constructor(
    app: App,
    private readonly mode: "create" | "unlock",
    private readonly onSubmit: (password: string, remember: boolean) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.mode === "create" ? t("开启凭证同步") : t("解锁凭证同步"));
    contentEl.createEl("p", {
      text: this.mode === "create"
        ? t("设置独立的凭证解锁密码。明文密钥不会写入 vault；忘记密码将无法找回同步的凭证。")
        : t("输入凭证解锁密码，以读取同步到此设备的加密凭证。"),
    });

    const addPassword = (name: string, onChange: (value: string) => void) => {
      new Setting(contentEl).setName(name).addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.addClass("fc-mono");
        text.onChange(onChange);
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void this.submit();
          }
        });
      });
    };
    addPassword(t("解锁密码"), (value) => { this.password = value; });
    if (this.mode === "create") {
      addPassword(t("再次输入解锁密码"), (value) => { this.confirmation = value; });
    }
    new Setting(contentEl)
      .setName(t("在此设备记住解锁状态"))
      .setDesc(t("仅把数据密钥保存在本机 Obsidian SecretStorage，不保存解锁密码。"))
      .addToggle((toggle) => toggle.setValue(this.remember).onChange((value) => { this.remember = value; }));

    new Setting(contentEl)
      .addButton((button) => button.setButtonText(t("取消")).onClick(() => this.close()))
      .addButton((button) => {
        this.submitButton = button;
        button
          .setButtonText(this.mode === "create" ? t("开启同步") : t("解锁"))
          .setCta()
          .onClick(() => void this.submit());
      });
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    if (!this.password) {
      new Notice(t("请输入解锁密码。"));
      return;
    }
    if (this.mode === "create" && this.password.length < 12) {
      new Notice(t("解锁密码至少需要 12 个字符。"));
      return;
    }
    if (this.mode === "create" && this.password !== this.confirmation) {
      new Notice(t("两次输入的解锁密码不一致。"));
      return;
    }
    this.busy = true;
    this.submitButton?.setDisabled(true);
    try {
      await this.onSubmit(this.password, this.remember);
      this.password = "";
      this.confirmation = "";
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("凭证同步操作失败。"), 10000);
      this.busy = false;
      this.submitButton?.setDisabled(false);
    }
  }

  onClose(): void {
    this.password = "";
    this.confirmation = "";
    this.contentEl.empty();
  }
}
