/**
 * Edit modal for a built-in indicator's global default parameters (设置页 →
 * 指标管理 → 内置指标 → 编辑). The working copy holds only overrides relative
 * to the indicator's own defval; an empty control deletes the key (= back to
 * the built-in default). 返回默认值 clears the whole working copy; nothing is
 * persisted until 保存.
 */

import { App, Modal, Setting } from "obsidian";
import type { IndicatorDef } from "../modules/indicators/contract";
import { getIndicatorParamDoc } from "../modules/indicators/param-docs";
import { renderIndicatorInputRow } from "./indicator-inputs";
import { applyInfoDescs } from "./info-desc";
import { t } from "../i18n";

export class BuiltinIndicatorEditModal extends Modal {
  private overrides: Record<string, unknown>;

  constructor(
    app: App,
    private readonly def: IndicatorDef,
    currentOverrides: Record<string, unknown>,
    private readonly onSave: (overrides: Record<string, unknown>) => void
  ) {
    super(app);
    this.overrides = { ...currentOverrides };
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(t("编辑指标默认参数：{name}", { name: t(this.def.name) }));
    contentEl.createDiv({
      cls: "fc-field-hint fc-hint-mb",
      text: t("修改后作为该指标的全局默认参数；留空 = 恢复内置默认值。卡片中单独设置的参数仍优先于此处。"),
    });

    for (const cfg of this.def.inputConfig) {
      renderIndicatorInputRow(contentEl, cfg, {
        value: this.overrides[cfg.id],
        defval: cfg.defval,
        doc: getIndicatorParamDoc(this.def, cfg),
        onChange: (value) => {
          if (value === undefined) {
            delete this.overrides[cfg.id];
          } else {
            this.overrides[cfg.id] = value;
          }
        },
      });
    }
    applyInfoDescs(contentEl);

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("返回默认值")).onClick(() => {
          this.overrides = {};
          this.render();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("保存"))
          .setCta()
          .onClick(() => {
            this.close();
            this.onSave({ ...this.overrides });
          })
      );
  }
}
