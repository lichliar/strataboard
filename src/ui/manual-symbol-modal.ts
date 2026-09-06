import { App, Modal, Notice, Setting } from "obsidian";
import type { SymbolItem } from "../types";
import { t } from "../i18n";

// Manual code entry for custom data sources without a searchUrl: 代码 + 名称
// inputs producing a SymbolItem directly (no remote search to pick from).
export class ManualSymbolModal extends Modal {
  private code = "";
  private name = "";
  private sourceId: string;
  private sourceName: string;
  private onSubmit: (item: SymbolItem) => void;

  constructor(app: App, sourceId: string, sourceName: string, onSubmit: (item: SymbolItem) => void) {
    super(app);
    this.sourceId = sourceId;
    this.sourceName = sourceName;
    this.onSubmit = onSubmit;
    this.setTitle(t("手工录入代码（{name}）", { name: sourceName }));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createDiv({
      cls: "fc-field-hint",
      text: t("该数据源未配置搜索接口，请按接口的代码格式手工录入。"),
    });

    new Setting(contentEl).setName(t("代码")).addText((text) => {
      text.setPlaceholder(t("如 sh600519")).onChange((value) => {
        this.code = value.trim();
      });
      text.inputEl.addClass("fc-mono");
    });

    new Setting(contentEl).setName(t("名称（可选）")).addText((text) =>
      text.setPlaceholder(t("如 贵州茅台")).onChange((value) => {
        this.name = value.trim();
      })
    );

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: t("确认"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      if (!this.code) {
        new Notice(t("请填写代码。"));
        return;
      }
      this.close();
      this.onSubmit({
        tsCode: this.code,
        symbol: this.code,
        name: this.name || this.code,
        exchange: this.sourceName,
        assetType: "custom",
        sourceId: this.sourceId,
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
