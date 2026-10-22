import { App, Modal } from "obsidian";
import { t } from "../i18n";
import { openSettingsTab } from "../settings";

// First-run guide shown when 插入图表 (or the md-note insert menu) is invoked
// with no enabled custom source. Widget/calendar entries have their own
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
      text: t("本插件不内置任何数据源。使用前需要先自行配置数据接口（REST/JSON）或 vault 内的 CSV 文件。"),
    });

    const footer = contentEl.createDiv("fc-modal-footer");
    const settingsBtn = footer.createEl("button", { text: t("打开数据源设置"), cls: "mod-cta" });
    settingsBtn.addEventListener("click", () => {
      this.close();
      openSettingsTab(this.app, "data-sources");
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
