import { App, Modal, Setting, SuggestModal } from "obsidian";

// Folder path picker shared by the settings page and the card edit modals
// (IMPLEMENTATION.md phase 1/2): a dropdown-style button opens a searchable
// list of existing vault folders, with a pinned 「手动输入路径…」 entry at the
// bottom of the menu for paths that do not exist yet.

type FolderChoice = { kind: "folder"; path: string } | { kind: "manual" };

const MANUAL_CHOICE: FolderChoice = { kind: "manual" };

/** All vault folders at any depth, sorted for stable display. */
export function listVaultFolders(app: App): string[] {
  return app.vault
    .getAllFolders(false)
    .map((folder) => folder.path)
    .filter((path) => path.length > 0 && path !== "/")
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
}

class FolderSuggestModal extends SuggestModal<FolderChoice> {
  private readonly folders: string[];
  private readonly onPick: (path: string) => void;

  constructor(app: App, onPick: (path: string) => void) {
    super(app);
    this.folders = listVaultFolders(app);
    this.onPick = onPick;
    this.setPlaceholder("搜索文件夹…");
  }

  getSuggestions(query: string): FolderChoice[] {
    const q = query.trim().toLowerCase();
    const matches = q ? this.folders.filter((path) => path.toLowerCase().includes(q)) : this.folders;
    // The manual-entry action stays pinned to the bottom even while filtering.
    return [...matches.map((path): FolderChoice => ({ kind: "folder", path })), MANUAL_CHOICE];
  }

  renderSuggestion(choice: FolderChoice, el: HTMLElement): void {
    if (choice.kind === "manual") {
      el.createSpan({ text: "手动输入路径…", cls: "fc-folder-manual-entry" });
      return;
    }
    el.createSpan({ text: choice.path });
  }

  onChooseSuggestion(choice: FolderChoice): void {
    if (choice.kind === "manual") {
      new ManualPathModal(this.app, this.onPick).open();
      return;
    }
    this.onPick(choice.path);
  }
}

class ManualPathModal extends Modal {
  constructor(app: App, private readonly onPick: (path: string) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "手动输入路径" });

    let input = "";
    const submit = () => {
      const path = input.trim().replace(/^\/+|\/+$/g, "");
      this.close();
      if (path) this.onPick(path);
    };

    new Setting(contentEl)
      .setName("文件夹路径")
      .setDesc("Vault 内的相对路径。")
      .addText((text) => {
        text.setPlaceholder("如：金融卡片/自定义");
        text.inputEl.addClass("fc-mono");
        text.onChange((value) => {
          input = value;
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        });
        window.setTimeout(() => text.inputEl.focus(), 0);
      });

    new Setting(contentEl).addButton((button) => button.setButtonText("确定").setCta().onClick(submit));
  }
}

export interface FolderPathSelectOptions {
  app: App;
  value: string;
  /** Shown muted when the value is empty. */
  placeholder?: string;
  onChange: (path: string) => void;
}

/** Dropdown-style folder picker field (wireframe `.wf-field-value.wf-dropdown`). */
export class FolderPathSelect {
  readonly el: HTMLButtonElement;
  private readonly textEl: HTMLSpanElement;
  private value: string;
  private readonly placeholder: string;

  constructor(containerEl: HTMLElement, private readonly options: FolderPathSelectOptions) {
    this.value = options.value;
    this.placeholder = options.placeholder ?? "";
    this.el = containerEl.createEl("button", { cls: "fc-folder-select", attr: { type: "button" } });
    this.textEl = this.el.createSpan("fc-folder-select-text");
    this.el.addEventListener("click", () => {
      new FolderSuggestModal(options.app, (path) => this.setValue(path, true)).open();
    });
    this.render();
  }

  getValue(): string {
    return this.value;
  }

  setValue(value: string, emit = false): void {
    this.value = value;
    this.render();
    if (emit) this.options.onChange(value);
  }

  private render(): void {
    const empty = this.value.trim().length === 0;
    this.textEl.textContent = empty ? this.placeholder : this.value;
    this.textEl.classList.toggle("is-empty", empty);
  }
}
