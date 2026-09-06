import { App, Modal } from "obsidian";
import { t } from "../i18n";

export interface SourcePickerEntry {
  name: string;      // e.g. "Tushare 资产"
  desc: string;      // e.g. "股票/基金/指数/南华指数 · 日K/周K/月K"
  onPick: () => void;
}

// 插入资产数据 source picker: one card per configured data source, each
// leading to that source's own standalone-card insertion flow (symbol / macro
// / FRED picker). Mirrors the source-grid visual language of the unified card
// edit modal (wireframe #screen-unified).
export class SourcePickerModal extends Modal {
  private readonly entries: SourcePickerEntry[];

  constructor(app: App, entries: SourcePickerEntry[]) {
    super(app);
    this.entries = entries;
  }

  onOpen() {
    this.setTitle(t("插入资产数据"));
    const { contentEl } = this;
    contentEl.createDiv({ cls: "fc-field-hint", text: t("数据源") });
    const grid = contentEl.createDiv("fc-source-grid");
    for (const entry of this.entries) {
      const card = grid.createDiv({ cls: "fc-source-card" });
      // name/desc arrive as Chinese i18n keys from the caller.
      card.createDiv({ cls: "fc-source-card-name", text: t(entry.name) });
      card.createDiv({ cls: "fc-source-card-desc", text: t(entry.desc) });
      card.addEventListener("click", () => {
        this.close();
        entry.onPick();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
