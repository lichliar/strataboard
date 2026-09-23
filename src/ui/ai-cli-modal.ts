import { App, Modal, Notice, Setting } from "obsidian";
import type { CustomCliDef } from "../types";
import { t } from "../i18n";
import { resolveCustomCli, runCli } from "../modules/ai-cli";

// Editor for one user-defined AI CLI entry (设置页 → AI 助手 → 自定义 AI 命令).
// The command must accept one prompt and print the answer to stdout; the args
// template carries a {prompt} placeholder, e.g. -p {prompt} or exec {prompt}.
export class AiCliEditModal extends Modal {
  private def: CustomCliDef;
  private onSave: (def: CustomCliDef) => void;

  constructor(app: App, def: CustomCliDef | undefined, onSave: (def: CustomCliDef) => void) {
    super(app);
    this.def = def
      ? { ...def, argsTemplate: [...def.argsTemplate] }
      : { id: `cli-${Date.now().toString(36)}`, name: "", command: "", argsTemplate: ["{prompt}"] };
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("自定义 AI 命令") });

    new Setting(contentEl).setName(t("名称")).addText((text) =>
      text.setPlaceholder("DeepSeek CLI").setValue(this.def.name).onChange((v) => (this.def.name = v.trim()))
    );

    new Setting(contentEl)
      .setName(t("命令"))
      .setDesc(t("可执行文件名或绝对路径。"))
      .addText((text) => {
        text.setPlaceholder("deepseek").setValue(this.def.command).onChange((v) => (this.def.command = v.trim()));
        text.inputEl.addClass("fc-mono");
      });

    new Setting(contentEl)
      .setName(t("参数模板"))
      .setDesc(t("用 {prompt} 表示提示词位置，空格分隔，例如：-p {prompt} 或 exec {prompt}"))
      .addText((text) => {
        text
          .setPlaceholder("-p {prompt}")
          .setValue(this.def.argsTemplate.join(" "))
          .onChange((v) => {
            this.def.argsTemplate = v.trim().split(/\s+/).filter(Boolean);
          });
        text.inputEl.addClass("fc-mono");
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("测试")).onClick(async () => {
          if (!this.def.command) {
            new Notice(t("请先填写命令。"));
            return;
          }
          if (!this.def.argsTemplate.some((a) => a.includes("{prompt}"))) {
            new Notice(t("参数模板必须包含 {prompt} 占位符。"));
            return;
          }
          btn.setDisabled(true);
          btn.setButtonText(t("测试中…"));
          try {
            const out = await runCli(resolveCustomCli(this.def), "ping", { timeoutMs: 60_000 }).promise;
            new Notice(t("调用成功，返回 {n} 字符。", { n: out.length }));
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          } finally {
            btn.setDisabled(false);
            btn.setButtonText(t("测试"));
          }
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("保存"))
          .setCta()
          .onClick(() => {
            if (!this.def.name || !this.def.command) {
              new Notice(t("请填写名称和命令。"));
              return;
            }
            if (!this.def.argsTemplate.some((a) => a.includes("{prompt}"))) {
              new Notice(t("参数模板必须包含 {prompt} 占位符。"));
              return;
            }
            this.onSave(this.def);
            this.close();
          })
      );
  }
}
