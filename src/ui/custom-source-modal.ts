import { App, Modal, Notice, Setting } from "obsidian";
import type { CustomSourceDef, JsonSourceMap } from "../types";
import { testCustomSource } from "../modules/custom-quote-client";
import { t } from "../i18n";

// Edit modal for one user-defined custom data source (设置页 → 自定义数据源).
// The plugin ships no endpoint URLs — the user pastes their own REST
// templates; `format` picks the parser preset (腾讯格式 / 东方财富格式) or the
// generic JSON field mapping, whose extra fields only render for format
// "json". Placeholders: klineUrl {code} {start} {end} {endIso}, searchUrl
// {query}.

export const CUSTOM_FORMAT_LABELS: Record<CustomSourceDef["format"], string> = {
  tencent: "腾讯格式",
  eastmoney: "东方财富格式",
  json: "通用 JSON",
};

const JSON_COL_FIELDS: { key: keyof JsonSourceMap["cols"]; label: string; optional?: boolean }[] = [
  { key: "date", label: "日期" },
  { key: "open", label: "开盘价" },
  { key: "close", label: "收盘价" },
  { key: "high", label: "最高价" },
  { key: "low", label: "最低价" },
  { key: "vol", label: "成交量" },
  { key: "amount", label: "成交额", optional: true },
];

export class CustomSourceModal extends Modal {
  private def: CustomSourceDef;
  private isNew: boolean;
  private onSubmit: (def: CustomSourceDef) => void;

  constructor(app: App, def: CustomSourceDef | undefined, onSubmit: (def: CustomSourceDef) => void) {
    super(app);
    this.isNew = !def;
    this.def = def
      ? { ...def, jsonMap: def.jsonMap ? { ...def.jsonMap, cols: { ...def.jsonMap.cols }, searchCols: def.jsonMap.searchCols ? { ...def.jsonMap.searchCols } : undefined } : undefined }
      : {
          id: `src-${Date.now().toString(36)}`,
          name: "",
          enabled: true,
          format: "tencent",
          klineUrl: "",
        };
    this.onSubmit = onSubmit;
    this.setTitle(this.isNew ? t("添加自定义数据源") : t("编辑自定义数据源"));
  }

  onOpen() {
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    const def = this.def;

    new Setting(contentEl).setName(t("名称")).setDesc(t("显示在选择器、工具栏和卡片文件名中。")).addText((text) =>
      text.setPlaceholder(t("如：我的行情源")).setValue(def.name).onChange((value) => {
        def.name = value.trim();
      })
    );

    new Setting(contentEl)
      .setName(t("响应格式"))
      .setDesc(t("接口返回体的解析方式；腾讯/东方财富格式为内置解析预设，通用 JSON 需在下方配置字段映射。"))
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(CUSTOM_FORMAT_LABELS)) {
          dropdown.addOption(value, t(label));
        }
        dropdown.setValue(def.format).onChange((value) => {
          def.format = value as CustomSourceDef["format"];
          // Re-render: the JSON mapping block only shows for format "json".
          this.render();
        });
      });

    new Setting(contentEl)
      .setName(t("K线 URL"))
      .setDesc(t("日线数据接口，支持占位符 {code} {start} {end}（YYYYMMDD）{endIso}（YYYY-MM-DD）。"))
      .addText((text) => {
        text.setPlaceholder("https://…?code={code}&beg={start}&end={end}").setValue(def.klineUrl).onChange((value) => {
          def.klineUrl = value.trim();
        });
        text.inputEl.addClass("fc-mono");
      });

    new Setting(contentEl)
      .setName(t("搜索 URL（可选）"))
      .setDesc(t("代码/名称搜索接口，支持占位符 {query}；留空则该源使用手工录入代码。"))
      .addText((text) => {
        text.setPlaceholder("https://…?q={query}").setValue(def.searchUrl ?? "").onChange((value) => {
          def.searchUrl = value.trim() || undefined;
        });
        text.inputEl.addClass("fc-mono");
      });

    new Setting(contentEl)
      .setName(t("测试代码（可选）"))
      .setDesc(t("用于「检测」按钮的 K 线连通性测试，如 sh600519。"))
      .addText((text) => {
        text.setPlaceholder("sh600519").setValue(def.testCode ?? "").onChange((value) => {
          def.testCode = value.trim() || undefined;
        });
        text.inputEl.addClass("fc-mono");
      });

    if (def.format === "json") {
      this.renderJsonMapping(contentEl);
    }

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    // 检测 probes the in-memory def, so unsaved edits can be tested first.
    const testBtn = footer.createEl("button", { text: t("检测") });
    testBtn.addEventListener("click", () => {
      testBtn.disabled = true;
      testCustomSource(this.def)
        .then((message) => new Notice(message))
        .catch((err: unknown) =>
          new Notice(t("检测失败：{msg}", { msg: err instanceof Error ? err.message : String(err) })),
        )
        .finally(() => {
          testBtn.disabled = false;
        });
    });
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
  }

  // Field-mapping block for format "json" (generic REST payloads).
  private renderJsonMapping(contentEl: HTMLElement) {
    const def = this.def;
    def.jsonMap ??= {
      rowsPath: "",
      rowKind: "array",
      cols: { date: "0", open: "1", close: "2", high: "3", low: "4", vol: "5" },
    };
    const map = def.jsonMap;

    contentEl.createDiv({ cls: "fc-field-hint fc-hint-mt", text: t("JSON 字段映射（K线）") });

    new Setting(contentEl)
      .setName(t("数据列表路径"))
      .setDesc(t("K线数组在返回 JSON 中的位置，点号分隔，如 data.klines。"))
      .addText((text) => {
        text.setPlaceholder("data.klines").setValue(map.rowsPath).onChange((value) => {
          map.rowsPath = value.trim();
        });
        text.inputEl.addClass("fc-mono");
      });

    new Setting(contentEl)
      .setName(t("数据行格式"))
      .setDesc(t("每行是数组（下方填列序号，从 0 开始）还是对象（下方填字段名）。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("array", t("数组（列序号）"))
          .addOption("object", t("对象（字段名）"))
          .setValue(map.rowKind)
          .onChange((value) => {
            map.rowKind = value as JsonSourceMap["rowKind"];
          })
      );

    const colsHint = map.rowKind === "array" ? t("列序号（从 0 开始）") : t("字段名");
    for (const field of JSON_COL_FIELDS) {
      new Setting(contentEl).setName(t("{label}（{cols}）{optional}", {
        label: t(field.label),
        cols: colsHint,
        optional: field.optional ? t(" · 可选") : "",
      })).addText((text) => {
        text.setValue(map.cols[field.key] ?? "").onChange((value) => {
          const trimmed = value.trim();
          if (field.key === "amount") {
            map.cols.amount = trimmed || undefined;
          } else {
            map.cols[field.key] = trimmed;
          }
        });
        text.inputEl.addClass("fc-mono");
      });
    }

    contentEl.createDiv({ cls: "fc-field-hint fc-hint-mt", text: t("JSON 字段映射（搜索，可选）") });

    new Setting(contentEl)
      .setName(t("搜索列表路径"))
      .setDesc(t("搜索结果数组在返回 JSON 中的位置，点号分隔。"))
      .addText((text) => {
        text.setPlaceholder("data.list").setValue(map.searchRowsPath ?? "").onChange((value) => {
          map.searchRowsPath = value.trim() || undefined;
        });
        text.inputEl.addClass("fc-mono");
      });

    const searchCols = map.searchCols ?? { code: "", name: "" };
    const searchFields: { key: "code" | "name" | "market"; label: string; optional?: boolean }[] = [
      { key: "code", label: "代码" },
      { key: "name", label: "名称" },
      { key: "market", label: "市场", optional: true },
    ];
    for (const field of searchFields) {
      new Setting(contentEl).setName(t("搜索{label}（{cols}）{optional}", {
        label: t(field.label),
        cols: colsHint,
        optional: field.optional ? t(" · 可选") : "",
      })).addText((text) => {
        text.setValue(searchCols[field.key] ?? "").onChange((value) => {
          const trimmed = value.trim();
          if (field.key === "market") {
            searchCols.market = trimmed || undefined;
          } else {
            searchCols[field.key] = trimmed;
          }
          map.searchCols = searchCols.code || searchCols.name ? searchCols : undefined;
        });
        text.inputEl.addClass("fc-mono");
      });
    }
  }

  private save() {
    const def = this.def;
    if (!def.name) {
      new Notice(t("请填写数据源名称。"));
      return;
    }
    if (!def.klineUrl) {
      new Notice(t("请填写 K线 URL。"));
      return;
    }
    if (def.format === "json") {
      const map = def.jsonMap;
      if (!map?.rowsPath || !map.cols.date || !map.cols.open || !map.cols.close || !map.cols.high || !map.cols.low || !map.cols.vol) {
        new Notice(t("通用 JSON 格式需要完整的数据列表路径与日期/开/收/高/低/量列映射。"));
        return;
      }
    }
    this.close();
    this.onSubmit(def);
  }
}
