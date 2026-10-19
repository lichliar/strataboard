import { App, Modal, Notice } from "obsidian";
import { t } from "../i18n";
import { openSettingsTab } from "../settings";
import { AI_SOURCE_PROMPT } from "./custom-source-modal";

// First-run guide shown when 插入图表 (or the md-note insert menu) is invoked
// with no enabled custom source: the plugin ships no data sources, so the
// modal explains that and offers the ways forward — configure a source in
// settings, hand the task to the in-plugin AI panel (when wired), or copy the
// guided prompt for the user's own AI. Widget/calendar entries are NOT
// exempted here: they have their own commands/menus.
export class SetupGuideModal extends Modal {
  // Opens the AI panel with an add-source task (main.ts wires this; absent in
  // contexts without the panel).
  constructor(app: App, private onOpenAiPanel?: () => void) {
    super(app);
    this.setTitle(t("先配置数据源"));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createDiv({
      cls: "fc-field-hint",
      text: t("本插件不内置任何数据源。使用前需要先自行配置数据接口（REST/JSON）或 vault 内的 CSV 文件；也可以复制 AI 引导提示词，让你的 AI 辅助生成配置。"),
    });

    const footer = contentEl.createDiv("fc-modal-footer");
    const settingsBtn = footer.createEl("button", { text: t("打开数据源设置"), cls: "mod-cta" });
    settingsBtn.addEventListener("click", () => {
      this.close();
      openSettingsTab(this.app, "data-sources");
    });
    if (this.onOpenAiPanel) {
      const aiBtn = footer.createEl("button", { text: t("让 AI 帮我配置") });
      aiBtn.addEventListener("click", () => {
        this.close();
        this.onOpenAiPanel?.();
      });
    }
    const copyBtn = footer.createEl("button", { text: t("复制 AI 引导提示词") });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(t(AI_SOURCE_PROMPT)).then(
        () => new Notice(t("提示词已复制到剪贴板，去发给你的 AI 吧。")),
        () => new Notice(t("复制失败，请手动选中提示词复制。")),
      );
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
