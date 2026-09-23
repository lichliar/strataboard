import { App, Modal, Notice, Setting, TextComponent } from "obsidian";
import type { SymbolItem, SymbolListEntry } from "../types";
import { t } from "../i18n";

// Manual code entry for custom data sources without a searchUrl: 代码 + 名称
// inputs producing a SymbolItem directly (no remote search to pick from).
// When the source carries a static code table (symbols), a dropdown fills
// both fields from named picks.
export class ManualSymbolModal extends Modal {
  private code = "";
  private name = "";
  private sourceId: string;
  private sourceName: string;
  private symbols: SymbolListEntry[];
  private onSubmit: (item: SymbolItem) => void;

  constructor(
    app: App,
    sourceId: string,
    sourceName: string,
    onSubmit: (item: SymbolItem) => void,
    symbols?: SymbolListEntry[]
  ) {
    super(app);
    this.sourceId = sourceId;
    this.sourceName = sourceName;
    this.symbols = symbols ?? [];
    this.onSubmit = onSubmit;
    this.setTitle(t("手工录入代码（{name}）", { name: sourceName }));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    let codeText: TextComponent;
    let nameText: TextComponent;

    if (this.symbols.length > 0) {
      new Setting(contentEl).setName(t("从代码表选择")).addDropdown((dropdown) => {
        dropdown.addOption("", t("（手工输入）"));
        for (const entry of this.symbols) {
          dropdown.addOption(entry.code, `${entry.name}（${entry.code}）`);
        }
        dropdown.onChange((value) => {
          const entry = this.symbols.find((e) => e.code === value);
          if (!entry) return;
          this.code = entry.code;
          this.name = entry.name;
          codeText.setValue(entry.code);
          nameText.setValue(entry.name);
        });
      });
    } else {
      contentEl.createDiv({
        cls: "fc-field-hint",
        text: t("该数据源未配置搜索接口，请按接口的代码格式手工录入。"),
      });
    }

    new Setting(contentEl).setName(t("代码")).addText((text) => {
      codeText = text;
      text.setPlaceholder(t("如 sh600519")).onChange((value) => {
        this.code = value.trim();
      });
      text.inputEl.addClass("fc-mono");
    });

    new Setting(contentEl).setName(t("名称（可选）")).addText((text) => {
      nameText = text;
      text.setPlaceholder(t("如 贵州茅台")).onChange((value) => {
        this.name = value.trim();
      });
    });

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
