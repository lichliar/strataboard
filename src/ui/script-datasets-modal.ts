import { App, Modal, Notice, Setting } from "obsidian";
import type { CustomSourceDef } from "../types";
import { t } from "../i18n";

// Naming dialog for one script-produced source (设置 → 数据源设置 → 本地脚本
// → 命名): one script can emit several datasets (a wide-table CSV carries one
// series per column, e.g. neer/reer/bis), and the auto-registered names are
// just the column names. This dialog renames the source itself and each
// dataset (symbol) individually. Codes stay fixed — they are the CSV column
// names the data-adapter selects by; only display names change.

export class ScriptDatasetsModal extends Modal {
  private name = "";
  private readonly renames = new Map<string, string>();

  constructor(
    app: App,
    private def: CustomSourceDef,
    private onSubmit: (name: string, renames: Map<string, string>) => void
  ) {
    super(app);
    this.name = def.name;
    for (const s of def.symbols ?? []) this.renames.set(s.code, s.name);
    this.setTitle(t("命名本地脚本数据集"));
  }

  onOpen() {
    const { contentEl } = this;

    const nameSetting = new Setting(contentEl).setName(t("数据源名称"));
    nameSetting.settingEl.addClass("fc-setting-stacked");
    nameSetting.addText((text) => {
      text.setValue(this.name).onChange((value) => {
        this.name = value.trim();
      });
    });

    const symbols = this.def.symbols ?? [];
    if (this.def.purpose === "signals") {
      contentEl.createDiv({
        cls: "fc-field-hint",
        text: t("信号表按 code 列区分标的，信号标注不显示名称；此处只需维护数据源名称。"),
      });
    } else if (symbols.length > 0) {
      contentEl.createDiv({
        cls: "fc-field-hint",
        text: t("一个脚本可产出多套数据（宽表每列一套）：在此为每套单独命名。代码即 CSV 列名，不可修改。"),
      });
      for (const symbol of symbols) {
        new Setting(contentEl).setName(symbol.code).addText((text) => {
          text.setValue(symbol.name).onChange((value) => {
            this.renames.set(symbol.code, value.trim() || symbol.code);
          });
        });
      }
    }

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      if (!this.name) {
        new Notice(t("请填写数据源名称。"));
        return;
      }
      this.close();
      this.onSubmit(this.name, this.renames);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
