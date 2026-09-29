import { App, Modal, Notice, Setting, SuggestModal, TFile, TextComponent } from "obsidian";
import type { CustomSourceDef } from "../types";
import { deriveCsvMapping, parseCsvKline, parseCsvTable, type CsvTable } from "../modules/csv-quote-client";
import { normalizeJsonDate } from "../modules/quote-format-parsers";
import { t } from "../i18n";

// Setup dialog for one format "csv" custom source (设置页 → 自定义数据源 →
// 添加 CSV 源): points a source at a vault-local CSV file. The user picks the
// file, the dialog parses the header live (column preview), and the column
// mapping is derived automatically (deriveCsvMapping in csv-quote-client.ts):
//   - a header containing open/high/low/close columns → OHLCV mode: one
//     series per file, def.symbols carries a single file-named entry;
//   - otherwise → wide-table mode: cols.close is fixed to "{code}" (the
//     requested code picks the column, reusing the HTTP wide-table
//     machinery) and every numeric column except the date column becomes a
//     def.symbols entry for the unified search / ManualSymbolModal dropdown.
// Saving runs a test parse (date column parseable, at least one valid row)
// and reports the concrete failure reason.

// Debounce for re-parsing after manual file-path edits.
const PARSE_DEBOUNCE_MS = 400;

class CsvFileSuggestModal extends SuggestModal<string> {
  private readonly paths: string[];

  constructor(app: App, private readonly onPick: (path: string) => void) {
    super(app);
    this.paths = app.vault
      .getFiles()
      .filter((file) => file.extension === "csv")
      .map((file) => file.path)
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
    this.setPlaceholder(t("搜索 CSV 文件…"));
  }

  getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    return q ? this.paths.filter((path) => path.toLowerCase().includes(q)) : this.paths;
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    el.createSpan({ text: path });
  }

  onChooseSuggestion(path: string): void {
    this.onPick(path);
  }
}

export class CsvSourceModal extends Modal {
  private def: CustomSourceDef;
  private isNew: boolean;
  private onSubmit: (def: CustomSourceDef) => void;
  // Once the user edits 名称 by hand, file picks stop overwriting it.
  private nameTouched = false;
  private table: CsvTable | null = null;
  // Raw text of the last successful loadFile, reused by the save-time test
  // parse so saving never re-reads the file.
  private lastText = "";
  private loadError = "";
  private parseTimer: number | undefined;
  private nameText: TextComponent | undefined;

  constructor(app: App, def: CustomSourceDef | undefined, onSubmit: (def: CustomSourceDef) => void) {
    super(app);
    this.isNew = !def;
    this.def = def
      ? { ...def, jsonMap: def.jsonMap ? { ...def.jsonMap, cols: { ...def.jsonMap.cols } } : undefined, symbols: def.symbols ? [...def.symbols] : undefined }
      : {
          id: `src-${Date.now().toString(36)}`,
          name: "",
          enabled: true,
          format: "csv",
        };
    this.nameTouched = !this.isNew;
    this.onSubmit = onSubmit;
    this.setTitle(this.isNew ? t("添加 CSV 数据源") : t("编辑 CSV 数据源"));
  }

  onOpen() {
    this.render();
    if (this.def.filePath) void this.loadFile(this.def.filePath);
  }

  onClose() {
    if (this.parseTimer !== undefined) window.clearTimeout(this.parseTimer);
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    let pathText: TextComponent;
    const fileSetting = new Setting(contentEl)
      .setName(t("CSV 文件"))
      .setDesc(t("vault 内的 .csv 文件，首行须为表头。"));
    fileSetting.settingEl.addClass("fc-setting-stacked");
    fileSetting
      .addText((text) => {
        pathText = text;
        text.setPlaceholder(t("如：数据/收益率.csv")).setValue(this.def.filePath ?? "");
        text.inputEl.addClass("fc-mono");
        text.onChange((value) => {
          this.def.filePath = value.trim();
          if (this.parseTimer !== undefined) window.clearTimeout(this.parseTimer);
          this.parseTimer = window.setTimeout(() => void this.loadFile(this.def.filePath ?? ""), PARSE_DEBOUNCE_MS);
        });
      })
      .addButton((btn) =>
        btn.setButtonText(t("选择文件…")).onClick(() => {
          new CsvFileSuggestModal(this.app, (path) => {
            this.def.filePath = path;
            pathText.setValue(path);
            void this.loadFile(path);
          }).open();
        })
      );

    const nameSetting = new Setting(contentEl).setName(t("数据源名称"));
    nameSetting.settingEl.addClass("fc-setting-stacked");
    nameSetting.addText((text) => {
      this.nameText = text;
      text.setValue(this.def.name).onChange((value) => {
        this.def.name = value.trim();
        this.nameTouched = true;
      });
    });

    const iconSetting = new Setting(contentEl)
      .setName(t("自定义图标（可选）"))
      .setDesc(t("粘贴 SVG 代码；留空则在「插入图表」菜单中用颜色圆点区分。"));
    iconSetting.settingEl.addClass("fc-setting-stacked");
    iconSetting.addTextArea((text) => {
      text.setValue(this.def.icon ?? "").onChange((value) => {
        this.def.icon = value.trim() || undefined;
      });
      text.inputEl.addClass("fc-mono");
    });

    const previewEl = contentEl.createDiv("fc-csv-preview");
    this.renderPreview(previewEl);

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
  }

  // Re-reads the file and rebuilds mapping + preview. Column detection runs
  // off the first data row, so a header-only file reports as unparsable.
  private async loadFile(path: string) {
    this.table = null;
    this.lastText = "";
    this.loadError = "";
    if (!path) {
      this.refreshPreview();
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.loadError = t("文件不存在：{path}", { path });
      this.refreshPreview();
      return;
    }
    try {
      const text = await this.app.vault.cachedRead(file);
      const table = parseCsvTable(text);
      if (table.fields.length === 0 || table.rows.length === 0) {
        this.loadError = t("未能解析出表头或数据行，请确认首行是表头。");
        this.refreshPreview();
        return;
      }
      this.table = table;
      this.lastText = text;
      if (!this.nameTouched && !this.def.name) {
        this.def.name = file.basename;
        this.nameText?.setValue(file.basename);
      }
      this.deriveMapping();
    } catch (e) {
      this.loadError = t("读取文件失败：{msg}", { msg: e instanceof Error ? e.message : String(e) });
    }
    this.refreshPreview();
  }

  // Fills jsonMap.cols (and wide-table symbols) from the parsed table. An
  // existing date-column choice survives if the column is still there.
  private deriveMapping() {
    const table = this.table;
    if (!table) return;
    const derived = deriveCsvMapping(table, {
      dateCol: this.def.jsonMap?.cols.date,
      symbols: this.def.symbols,
      fallbackCode: this.def.name || undefined,
    });
    this.def.jsonMap = derived.jsonMap;
    this.def.symbols = derived.symbols;
  }

  private refreshPreview() {
    const el = this.contentEl.querySelector(".fc-csv-preview");
    if (el instanceof HTMLElement) {
      el.empty();
      this.renderPreview(el);
    }
  }

  private renderPreview(containerEl: HTMLElement) {
    if (this.loadError) {
      containerEl.createDiv({ cls: "fc-field-hint fc-detect-error", text: this.loadError });
      return;
    }
    const table = this.table;
    if (!table) {
      containerEl.createDiv({ cls: "fc-field-hint", text: t("选择 CSV 文件后此处显示列预览。") });
      return;
    }

    const cols = this.def.jsonMap?.cols;
    const wide = cols?.close === "{code}";
    containerEl.createDiv({
      cls: "fc-field-hint",
      text: wide
        ? t("宽表模式：日期列以外的每个数值列是一个序列，代码即列名。可用序列（{n}）：{list}", {
            n: this.def.symbols?.length ?? 0,
            list: (this.def.symbols ?? []).map((s) => s.name).join("、"),
          })
        : t("检测到 OHLCV 列，按单系列 K 线解析（代码：{code}）。", { code: this.def.symbols?.[0]?.code ?? "" }),
    });

    new Setting(containerEl).setName(t("日期列")).addDropdown((dropdown) => {
      dropdown.addOption("", t("（请选择）"));
      const first = table.rows[0];
      for (const field of table.fields) {
        const sample = String(first[field] ?? "");
        dropdown.addOption(field, `${field}: ${sample.length > 20 ? `${sample.slice(0, 20)}…` : sample}`);
      }
      dropdown.setValue(cols?.date ?? "").onChange((value) => {
        if (!this.def.jsonMap) return;
        this.def.jsonMap.cols.date = value;
        // An explicit clear stays cleared (no re-guess); a real choice
        // triggers a symbols rebuild around the new date column.
        if (value) this.deriveMapping();
        this.refreshPreview();
      });
    });

    const previewFields = table.fields.slice(0, 6);
    const tableEl = containerEl.createEl("table", { cls: "fc-preview-table" });
    const head = tableEl.createEl("thead").createEl("tr");
    for (const field of previewFields) head.createEl("th", { text: field });
    const body = tableEl.createEl("tbody");
    for (const row of table.rows.slice(0, 5)) {
      const tr = body.createEl("tr");
      for (const field of previewFields) tr.createEl("td", { text: String(row[field] ?? "") });
    }
    if (table.fields.length > previewFields.length) {
      containerEl.createDiv({
        cls: "fc-field-hint",
        text: t("仅预览前 {n} 列，共 {m} 列。", { n: previewFields.length, m: table.fields.length }),
      });
    }
  }

  private save() {
    const def = this.def;
    if (!def.filePath) {
      new Notice(t("请选择 CSV 文件。"));
      return;
    }
    if (!def.name) {
      new Notice(t("请填写数据源名称。"));
      return;
    }
    const map = def.jsonMap;
    if (!this.table || !map?.cols.date) {
      new Notice(t("请选择日期列。"));
      return;
    }
    const sampleCode = map.cols.close === "{code}" ? def.symbols?.[0]?.code ?? "" : "";
    if (map.cols.close === "{code}" && !sampleCode) {
      new Notice(t("日期列以外没有数值列，无法作为宽表数据源。"));
      return;
    }
    const rows = parseCsvKline(this.lastText, map, sampleCode);
    if (rows.length === 0) {
      const sample = String(this.table.rows[0][map.cols.date] ?? "");
      new Notice(
        normalizeJsonDate(sample) === ""
          ? t("日期列「{col}」的值无法解析为日期（示例值：{sample}）。", { col: map.cols.date, sample })
          : t("没有解析出任何有效数据行，请检查数值列。")
      );
      return;
    }
    this.close();
    this.onSubmit(def);
  }
}
