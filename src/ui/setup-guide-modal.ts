import { App, Modal, Notice } from "obsidian";
import { t } from "../i18n";
import { openSettingsTab } from "../settings";
import { AI_SOURCE_PROMPT } from "./custom-source-modal";

// First-run guide shown when 插入图表 (or the md-note insert menu) is invoked
// with no enabled custom source: the plugin ships no data sources, so the
// modal explains that and offers the two ways forward — configure a source in
// settings, or copy the guided prompt and let the user's own AI generate the
// config. Widget/calendar entries are NOT exempted here: they have their own
// commands/menus.
export class SetupGuideModal extends Modal {
  constructor(app: App) {
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
      openSettingsTab(this.app, "data-source");
    });
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
