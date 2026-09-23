import { App, Modal, Notice, Setting } from "obsidian";
import type { ApiProviderDef } from "../types";
import { t } from "../i18n";
import { AI_API_PRESETS, runApiModel } from "../modules/ai-api";

// Editor for one online API model entry (设置页 → AI 助手 → 在线 API 模型):
// any OpenAI-compatible chat-completions endpoint. The 服务商 dropdown only
// prefills baseUrl/model — every field stays editable, and the plugin never
// ships keys.
export class AiApiEditModal extends Modal {
  private def: ApiProviderDef;
  private onSave: (def: ApiProviderDef) => void;

  constructor(app: App, def: ApiProviderDef | undefined, onSave: (def: ApiProviderDef) => void) {
    super(app);
    this.def = def
      ? { ...def }
      : { id: `api-${Date.now().toString(36)}`, name: "", baseUrl: "", apiKey: "", model: "" };
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("在线 API 模型") });

    let nameText: { setValue(v: string): void } | null = null;
    let urlText: { setValue(v: string): void } | null = null;
    let modelText: { setPlaceholder(v: string): void } | null = null;

    new Setting(contentEl)
      .setName(t("服务商"))
      .setDesc(t("选择常见服务商可自动填写 API 地址与模型示例，均可再修改。"))
      .addDropdown((dropdown) => {
        dropdown.addOption("", t("自定义"));
        AI_API_PRESETS.forEach((preset, index) => dropdown.addOption(String(index), preset.name));
        dropdown.onChange((value) => {
          const preset = AI_API_PRESETS[Number(value)];
          if (!preset) return;
          if (!this.def.name) {
            this.def.name = preset.name;
            nameText?.setValue(preset.name);
          }
          this.def.baseUrl = preset.baseUrl;
          urlText?.setValue(preset.baseUrl);
          modelText?.setPlaceholder(preset.model);
        });
      });

    new Setting(contentEl).setName(t("名称")).addText((text) => {
      text.setPlaceholder("DeepSeek").setValue(this.def.name).onChange((v) => (this.def.name = v.trim()));
      nameText = text;
    });

    new Setting(contentEl)
      .setName(t("API 地址"))
      .setDesc(t("服务商提供的 OpenAI 兼容接口地址（/v1 或完整的 /chat/completions 地址均可）。"))
      .addText((text) => {
        text
          .setPlaceholder("https://api.deepseek.com/v1")
          .setValue(this.def.baseUrl)
          .onChange((v) => (this.def.baseUrl = v.trim()));
        text.inputEl.addClass("fc-mono");
        urlText = text;
      });

    new Setting(contentEl).setName(t("API Key")).addText((text) => {
      text.setPlaceholder("sk-...").setValue(this.def.apiKey).onChange((v) => (this.def.apiKey = v.trim()));
      text.inputEl.type = "password";
      text.inputEl.addClass("fc-mono");
    });

    new Setting(contentEl).setName(t("模型")).addText((text) => {
      text.setPlaceholder("deepseek-chat").setValue(this.def.model).onChange((v) => (this.def.model = v.trim()));
      text.inputEl.addClass("fc-mono");
      modelText = text;
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("测试")).onClick(async () => {
          if (!this.def.baseUrl || !this.def.apiKey || !this.def.model) {
            new Notice(t("请先填写 API 地址、API Key 和模型。"));
            return;
          }
          btn.setDisabled(true);
          btn.setButtonText(t("测试中…"));
          try {
            const out = await runApiModel(this.def, "ping", { timeoutMs: 60_000 }).promise;
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
            if (!this.def.name || !this.def.baseUrl || !this.def.apiKey || !this.def.model) {
              new Notice(t("请填写名称、API 地址、API Key 和模型。"));
              return;
            }
            this.onSave(this.def);
            this.close();
          })
      );
  }
}
