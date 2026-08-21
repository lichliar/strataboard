import { App, Modal } from "obsidian";

export interface CleanupItem {
  id: string;
  label: string; // main line (file name / cache key)
  hint?: string; // secondary line (path / type + row count)
}

interface CleanupConfirmOptions {
  title: string;
  desc: string;
  confirmLabel: string; // e.g. "删除文件" / "清理缓存"
  items: CleanupItem[];
  onConfirm: (selected: CleanupItem[]) => Promise<void>;
}

// Shared two-step confirm list for the settings-tab cleanup features: all
// items checked by default, user unchecks what to keep, then confirms.
export class CleanupConfirmModal extends Modal {
  private readonly options: CleanupConfirmOptions;
  private readonly checked = new Set<string>();
  private confirmButton!: HTMLButtonElement;
  private busy = false;

  constructor(app: App, options: CleanupConfirmOptions) {
    super(app);
    this.options = options;
    for (const item of options.items) this.checked.add(item.id);
  }

  onOpen() {
    this.setTitle(this.options.title);
    const { contentEl } = this;
    contentEl.addClass("fc-cleanup-modal");
    contentEl.createDiv({ cls: "fc-field-hint", text: this.options.desc });

    const toolbar = contentEl.createDiv("fc-cleanup-toolbar");
    const selectAll = toolbar.createEl("button", { text: "全选" });
    const selectNone = toolbar.createEl("button", { text: "全不选" });

    const list = contentEl.createDiv("fc-cleanup-list");
    const checkboxes: HTMLInputElement[] = [];
    for (const item of this.options.items) {
      const row = list.createEl("label", { cls: "fc-cleanup-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.checked.add(item.id);
        else this.checked.delete(item.id);
        this.refreshConfirmButton();
      });
      checkboxes.push(checkbox);
      const text = row.createDiv("fc-cleanup-row-text");
      text.createDiv({ cls: "fc-cleanup-row-label", text: item.label });
      if (item.hint) text.createDiv({ cls: "fc-cleanup-row-hint", text: item.hint });
    }

    selectAll.addEventListener("click", () => {
      checkboxes.forEach((cb, i) => {
        cb.checked = true;
        this.checked.add(this.options.items[i].id);
      });
      this.refreshConfirmButton();
    });
    selectNone.addEventListener("click", () => {
      for (const cb of checkboxes) cb.checked = false;
      this.checked.clear();
      this.refreshConfirmButton();
    });

    const footer = contentEl.createDiv("fc-cleanup-footer");
    const cancel = footer.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    this.confirmButton = footer.createEl("button", { cls: "mod-warning" });
    this.confirmButton.addEventListener("click", () => void this.runConfirm());
    this.refreshConfirmButton();
  }

  private refreshConfirmButton(): void {
    this.confirmButton.textContent = `${this.options.confirmLabel}（${this.checked.size}）`;
    this.confirmButton.disabled = this.busy || this.checked.size === 0;
  }

  private async runConfirm(): Promise<void> {
    if (this.busy || this.checked.size === 0) return;
    this.busy = true;
    this.refreshConfirmButton();
    const selected = this.options.items.filter((item) => this.checked.has(item.id));
    try {
      await this.options.onConfirm(selected);
      this.close();
    } catch (e) {
      console.error("StrataBoard: cleanup failed", e);
      this.busy = false;
      this.refreshConfirmButton();
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
