import { App, Component, MarkdownRenderer, Modal, Notice, Setting } from "obsidian";
import { KNOWN_INDICATOR_GROUP_KEYS, type IndicatorGroup, type IndicatorInstance } from "../types";
import { indicatorRegistry } from "../modules/indicators/registry";
import { IndicatorListEditor } from "./indicator-instance-list";
import { applyInfoDescs } from "./info-desc";
import { t } from "../i18n";

// 指标组 edit modal (设置 → 指标 → 指标组 → 新建/编辑): name + Markdown
// design note (with live preview) + the shared indicator-instance list editor.
// A group is a settings-level concept only; applying it to a card expands it
// into plain IndicatorInstance[] in the card YAML.
export class IndicatorGroupModal extends Modal {
  private name: string;
  private note: string;
  private readonly instances: IndicatorInstance[];
  private readonly isNew: boolean;
  private readonly groupId: string | undefined;

  constructor(
    app: App,
    group: IndicatorGroup | null,
    private readonly onSubmit: (group: IndicatorGroup) => void
  ) {
    super(app);
    this.isNew = group === null;
    this.groupId = group?.id;
    this.name = group?.name ?? "";
    this.note = group?.note ?? "";
    // Clone so editing an instance never mutates the settings-level group.
    this.instances = (group?.indicators ?? []).map((inst) => ({
      id: inst.id,
      ...(inst.inputs ? { inputs: { ...inst.inputs } } : {}),
      ...(inst.hidden ? { hidden: true } : {}),
    }));
    this.setTitle(this.isNew ? t("新建指标组") : t("编辑指标组"));
  }

  // Component hosting the note's Markdown preview (this project's obsidian
  // typings don't have Modal extend Component, so MarkdownRenderer needs one).
  private readonly mdComponent = new Component();

  onOpen() {
    this.mdComponent.load();
    this.render();
  }

  onClose() {
    this.mdComponent.unload();
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl).setName(t("组名")).addText((text) =>
      text.setValue(this.name).onChange((value) => {
        this.name = value;
      })
    );

    new Setting(contentEl)
      .setName(t("设计说明"))
      .setDesc(t("支持 Markdown，可用 [[双链]] 引用笔记。"))
      .addTextArea((text) => {
        text.setValue(this.note).onChange((value) => {
          this.note = value;
          renderPreview();
        });
        text.inputEl.rows = 4;
      });
    const previewEl = contentEl.createDiv("fc-group-note-preview");
    const renderPreview = () => {
      previewEl.empty();
      if (!this.note.trim()) return;
      void MarkdownRenderer.render(this.app, this.note, previewEl, "", this.mdComponent);
    };
    renderPreview();

    const listEl = contentEl.createDiv();
    new IndicatorListEditor({
      app: this.app,
      instances: this.instances,
      onChanged: () => this.render(),
    }).render(listEl);
    if (this.instances.length === 0) {
      listEl.createDiv({
        cls: "fc-field-hint fc-hint-mb",
        text: t("指标组至少包含一个指标。"),
      });
    }

    // Parameter explanations (参数说明) collapse to hover ⓘ icons; the
    // instance header rows opt out via fc-keep-desc (their desc is content).
    applyInfoDescs(contentEl);

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: t("取消") });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: t("保存"), cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
  }

  private save() {
    const name = this.name.trim();
    if (!name) {
      new Notice(t("请填写组名。"));
      return;
    }
    if (this.instances.length === 0) {
      new Notice(t("指标组至少包含一个指标。"));
      return;
    }
    this.close();
    this.onSubmit({
      id: this.groupId ?? `grp-${Date.now().toString(36)}-0`,
      name,
      note: this.note.trim(),
      indicators: this.instances,
    });
  }
}

// Validates an imported indicator-group payload and returns fresh groups (new
// ids, so an imported copy never collides with an existing group) plus
// warnings for keys outside the known IndicatorGroup shape and for instances
// the registry cannot resolve (kept — the custom indicator may just not be
// imported yet). Throws on malformed input.
export function parseImportedGroups(text: string): { groups: IndicatorGroup[]; warnings: string[] } {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("not a group list");
  const groups: IndicatorGroup[] = [];
  const warnings: string[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid entry");
    const e = entry as Partial<IndicatorGroup>;
    const label = typeof e.name === "string" && e.name.trim() ? `「${e.name.trim()}」` : `#${groups.length + 1}`;
    for (const key of Object.keys(entry)) {
      if (!KNOWN_INDICATOR_GROUP_KEYS.has(key)) warnings.push(`${label}: 未知字段 "${key}"（已忽略，检查是否放错了层级）`);
    }
    if (typeof e.name !== "string" || !e.name.trim()) throw new Error("missing name");
    if (!Array.isArray(e.indicators)) throw new Error("missing indicators");
    const indicators: IndicatorInstance[] = [];
    for (const item of e.indicators) {
      if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id.trim()) {
        warnings.push(`${label}: 跳过无效的指标条目（缺少 id）`);
        continue;
      }
      if (!indicatorRegistry.resolve(item.id)) {
        warnings.push(`${label}: 指标 id "${item.id}" 当前无法识别（可能尚未导入对应自定义指标，已保留）`);
      }
      const inputs =
        item.inputs && typeof item.inputs === "object" && !Array.isArray(item.inputs)
          ? (item.inputs as Record<string, unknown>)
          : undefined;
      if (item.inputs !== undefined && !inputs) {
        warnings.push(`${label}: 指标 "${item.id}" 的 inputs 不是对象（已忽略）`);
      }
      indicators.push({
        id: item.id,
        ...(inputs && Object.keys(inputs).length > 0 ? { inputs: { ...inputs } } : {}),
        ...(item.hidden === true ? { hidden: true } : {}),
      });
    }
    groups.push({
      id: `grp-${Date.now().toString(36)}-${groups.length}`,
      name: e.name.trim(),
      note: typeof e.note === "string" ? e.note : "",
      indicators,
    });
  }
  return { groups, warnings };
}

// Merges freshly imported groups into the existing list BY NAME: an entry
// whose name matches an existing group overwrites it (keeping the existing
// id), anything else appends. Re-importing a corrected config therefore
// updates in place instead of duplicating every group.
export function mergeImportedGroups(existing: IndicatorGroup[], groups: IndicatorGroup[]): { updated: number; added: number } {
  let updated = 0;
  let added = 0;
  for (const group of groups) {
    const index = existing.findIndex((g) => g.name.trim() === group.name.trim());
    if (index >= 0) {
      existing[index] = { ...group, id: existing[index].id };
      updated++;
    } else {
      existing.push(group);
      added++;
    }
  }
  return { updated, added };
}
