import { App, Component, MarkdownRenderer, Modal, Notice, Setting } from "obsidian";
import type { IndicatorDef } from "../modules/indicators/contract";
import { renderIndicatorInputRow } from "./indicator-inputs";
import { t } from "../i18n";

export interface IndicatorOverride {
  name?: string;
  description?: string;
  defaultInputs?: Record<string, unknown>;
}

/** Edit presentation and the global defaults of one loaded custom indicator. */
export class IndicatorEditModal extends Modal {
  private name: string;
  private description: string;
  private readonly defaults: Record<string, unknown>;
  private readonly component = new Component();

  constructor(
    app: App,
    private readonly def: IndicatorDef,
    current: IndicatorOverride,
    private readonly onSubmit: (value: IndicatorOverride) => Promise<void>
  ) {
    super(app);
    this.name = current.name ?? def.name;
    this.description = current.description ?? "";
    this.defaults = { ...def.defaultInputs, ...(current.defaultInputs ?? {}) };
    this.setTitle(t("编辑指标：{name}", { name: def.name }));
  }

  onOpen() {
    this.component.load();
    this.render();
  }

  onClose() {
    this.component.unload();
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName(t("指标名称"))
      .setDesc(t("可使用中文或英文；留空时使用指标文件中的名称。"))
      .addText((text) => text.setValue(this.name).onChange((value) => (this.name = value)));

    const options = contentEl.createDiv("fc-indicator-edit-options");
    options.createEl("h4", { text: t("可调节的选项") });
    if (this.def.inputConfig.length === 0) {
      options.createDiv({ cls: "fc-field-hint", text: t("该指标没有可调节选项。") });
    }
    for (const cfg of this.def.inputConfig) {
      renderIndicatorInputRow(options, cfg, {
        value: this.defaults[cfg.id],
        defval: this.def.defaultInputs[cfg.id] ?? cfg.defval,
        doc: cfg.tooltip,
        onChange: (value) => {
          if (value === undefined) delete this.defaults[cfg.id];
          else this.defaults[cfg.id] = value;
        },
      });
    }

    new Setting(contentEl)
      .setName(t("指标说明"))
      .setDesc(t("支持 Markdown 和 [[Obsidian 双链]]；可直接粘贴或链接到说明文档。"))
      .addTextArea((area) => {
        area.setValue(this.description).onChange((value) => {
          this.description = value;
          renderPreview();
        });
        area.inputEl.rows = 6;
      });
    const preview = contentEl.createDiv("fc-indicator-description-preview");
    const renderPreview = () => {
      preview.empty();
      if (this.description.trim()) void MarkdownRenderer.render(this.app, this.description, preview, "", this.component);
    };
    renderPreview();

    const footer = contentEl.createDiv("fc-modal-footer");
    footer.createEl("button", { text: t("取消") }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: t("保存"), cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private async save() {
    const name = this.name.trim();
    if (!name) {
      new Notice(t("请填写指标名称。"));
      return;
    }
    const defaultInputs = Object.fromEntries(
      this.def.inputConfig.filter((cfg) => this.defaults[cfg.id] !== undefined).map((cfg) => [cfg.id, this.defaults[cfg.id]])
    );
    this.close();
    await this.onSubmit({ name, description: this.description.trim(), defaultInputs });
  }
}
