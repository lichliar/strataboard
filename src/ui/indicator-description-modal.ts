import { App, Component, MarkdownRenderer, Modal } from "obsidian";

export class IndicatorDescriptionModal extends Modal {
  private readonly component = new Component();

  constructor(app: App, private readonly title: string, private readonly markdown: string) {
    super(app);
    this.setTitle(title);
  }

  onOpen() {
    this.component.load();
    this.contentEl.empty();
    void MarkdownRenderer.render(this.app, this.markdown, this.contentEl, "", this.component);
  }

  onClose() {
    this.component.unload();
    this.contentEl.empty();
  }
}
