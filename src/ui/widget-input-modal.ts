import { App, Modal, Setting } from "obsidian";

export interface WidgetInputModalResult {
  title: string;
  input: string;
  savePath?: string;
}

export class WidgetInputModal extends Modal {
  private onSubmit: (result: WidgetInputModalResult) => void;
  private titleValue = "";
  private inputValue = "";
  private savePathValue = "";

  constructor(app: App, onSubmit: (result: WidgetInputModalResult) => void) {
    super(app);
    this.onSubmit = onSubmit;
    this.setTitle("插入 HTML / TradingView 小组件");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl)
      .setName("标题")
      .setDesc("卡片标题，也用于生成文件名。")
      .addText((text) =>
        text
          .setPlaceholder("例如：USINTR 利率走势")
          .setValue(this.titleValue)
          .onChange((value) => {
            this.titleValue = value;
          })
      );

    new Setting(contentEl)
      .setName("组件保存地址")
      .setDesc("留空则使用默认卡片库目录。可输入 Vault 内相对路径，如 widgets/tradingview。")
      .addText((text) =>
        text
          .setPlaceholder("默认目录")
          .setValue(this.savePathValue)
          .onChange((value) => {
            this.savePathValue = value;
          })
      );

    new Setting(contentEl)
      .setName("HTML / iframe URL")
      .setDesc("粘贴 TradingView 嵌入代码、任意 HTML 片段，或一个 iframe URL。")
      .setClass("fc-widget-input-url-setting")
      .addTextArea((area) => {
        area
          .setPlaceholder("<!-- TradingView Widget BEGIN -->\n...")
          .setValue(this.inputValue)
          .onChange((value) => {
            this.inputValue = value;
          });
        area.inputEl.rows = 12;
        area.inputEl.style.width = "100%";
        area.inputEl.style.fontFamily = "monospace";
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("插入")
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit({
            title: this.titleValue.trim(),
            input: this.inputValue.trim(),
            savePath: this.savePathValue.trim() || undefined,
          });
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
