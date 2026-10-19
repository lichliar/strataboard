import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

// Python scripts execute as the current OS user, outside the custom-indicator
// environment. Approval is deliberately explicit and tied to the script's
// real path + current content hash by the caller (main.ts runScriptFile).
export class ScriptRunConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly details: {
      interpreterPath: string; // resolved real path of the Python interpreter
      scriptPath: string;      // resolved real path of the script
      cwd: string;             // resolved real path of the script folder
      hashShort: string;       // first 12 hex chars of the content SHA-256
      changed: boolean;        // a previous approval for this path exists
    },
    private readonly resolve: (approved: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", {
      text: this.details.changed ? t("脚本内容已变化，请重新确认") : t("确认运行本地脚本"),
    });
    contentEl.createEl("p", {
      text: t("Python 脚本将以当前系统用户的完整权限运行，可访问网络、读写文件并启动其他进程。StrataBoard 无法保证脚本安全；仅运行你理解且信任的代码。"),
    });
    this.addDetail(t("脚本"), this.details.scriptPath);
    this.addDetail(t("解释器"), this.details.interpreterPath);
    this.addDetail(t("工作目录"), this.details.cwd);
    this.addDetail(t("内容哈希（SHA-256 前 12 位）"), this.details.hashShort);
    contentEl.createDiv({
      cls: "fc-field-hint",
      text: t("确认仅对当前脚本真实路径和当前文件内容有效；文件改名、移动或内容变化后会再次询问。"),
    });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText(t("取消")).onClick(() => this.finish(false)))
      .addButton((button) =>
        button.setButtonText(t("我已理解，运行脚本")).setWarning().onClick(() => this.finish(true))
      );
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
    this.contentEl.empty();
  }

  private addDetail(label: string, value: string): void {
    const row = this.contentEl.createDiv("fc-script-permission-row");
    row.createSpan({ text: `${label}：` });
    row.createEl("code", { text: value });
  }

  private finish(approved: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(approved);
    this.close();
  }
}
