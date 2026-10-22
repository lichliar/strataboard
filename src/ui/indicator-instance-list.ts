import { App, Setting, setIcon } from "obsidian";
import { setTooltip } from "./tooltip";
import type { IndicatorInstance } from "../types";
import type { IndicatorDef } from "../modules/indicators/contract";
import { indicatorRegistry } from "../modules/indicators/registry";
import { getIndicatorRuntimeError } from "../modules/indicators/compute";
import type { InputConfig } from "oakscriptjs";
import { renderIndicatorInputRow } from "./indicator-inputs";
import { IndicatorPickerModal } from "./indicator-picker-modal";
import { t } from "../i18n";

// Summary line under an indicator row: only explicitly overridden inputs are
// listed (unset keys fall back to the indicator's own defaults).
export function describeIndicatorInputs(instance: IndicatorInstance, def: IndicatorDef | undefined): string {
  if (!def) return t("未知指标 id，可能已被删除或改名");
  const parts: string[] = [];
  for (const cfg of def.inputConfig) {
    const value = instance.inputs?.[cfg.id];
    if (value === undefined) continue;
    parts.push(`${cfg.title ?? cfg.id}=${String(value)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : t("默认参数");
}

// Shared indicator-instance list editor: the 添加 button opens the searchable
// IndicatorPickerModal (new instances unshift to the top of the list and stay
// expanded) plus one collapsible row per instance (drag handle + 上移/下移/
// 隐藏/删除 + the auto-generated parameter form). Instances carrying a `group`
// label get a group header row with 隐藏整组/显示整组 and 删除整组 batch
// controls. Used by UnifiedCardEditModal (per-card list) and
// IndicatorGroupModal.
export class IndicatorListEditor {
  // Expanded state of the collapsible instances, tracked by object identity
  // so it survives the full re-render on every structural change (and follows
  // instances across unshift/splice without index bookkeeping).
  private readonly expanded = new WeakSet<IndicatorInstance>();

  // Source row of an in-progress drag, null outside a drag gesture. Lives on
  // the editor (not the row) because drop targets are other rows.
  private dragIndex: number | null = null;

  constructor(
    private readonly opts: {
      app: App;
      /** The edited list; mutated in place (add/move/hide/delete). */
      instances: IndicatorInstance[];
      /** Called after every structural change; the caller re-renders. */
      onChanged: () => void;
    }
  ) {}

  render(containerEl: HTMLElement): void {
    const { instances } = this.opts;
    const controls = containerEl.createDiv("fc-indicator-controls");
    const addBtn = controls.createEl("button", { text: t("添加") });
    addBtn.addEventListener("click", () => {
      new IndicatorPickerModal(this.opts.app, (def) => {
        const instance: IndicatorInstance = { id: def.id };
        this.expanded.add(instance);
        instances.unshift(instance);
        this.opts.onChanged();
      }).open();
    });

    const renderedGroups = new Set<string>();
    instances.forEach((instance, index) => {
      if (instance.group && !renderedGroups.has(instance.group)) {
        renderedGroups.add(instance.group);
        this.renderGroupHeader(containerEl, instance.group, instances);
      }
      this.renderInstance(containerEl, instance, index);
    });
  }

  private renderGroupHeader(containerEl: HTMLElement, group: string, instances: IndicatorInstance[]) {
    const row = containerEl.createDiv({ cls: "fc-indicator-group-header" });
    row.createSpan({ cls: "fc-indicator-group-name", text: group });
    const members = instances.filter((instance) => instance.group === group);
    const allHidden = members.length > 0 && members.every((instance) => instance.hidden === true);
    const actions = row.createDiv({ cls: "fc-indicator-group-actions" });
    const button = actions.createEl("button", {
      cls: "fc-indicator-group-toggle",
      text: allHidden ? t("显示整组") : t("隐藏整组"),
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      for (const instance of members) {
        if (allHidden) delete instance.hidden;
        else instance.hidden = true;
      }
      this.opts.onChanged();
    });
    const deleteButton = actions.createEl("button", {
      cls: "fc-indicator-group-toggle",
      text: t("删除整组"),
    });
    deleteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      for (let i = instances.length - 1; i >= 0; i--) {
        if (instances[i].group === group) instances.splice(i, 1);
      }
      this.opts.onChanged();
    });
  }

  // One collapsible indicator instance: the <summary> header row shows the
  // drag handle, the short title (失效 tag when the registry no longer
  // resolves the id), a 主图/副图 badge, a runtime-error marker when the last
  // chart render failed this indicator, the overridden-inputs summary, and
  // the 上移/下移/隐藏/删除 controls; the auto-generated parameter form lives
  // in the collapsible body. Collapsed by default; expansion state is tracked
  // in this.expanded so a structural-change re-render keeps it.
  private renderInstance(containerEl: HTMLElement, instance: IndicatorInstance, index: number) {
    const { instances } = this.opts;
    const def = indicatorRegistry.resolve(instance.id);
    const block = containerEl.createEl("details", { cls: "fc-indicator-instance" });
    block.open = this.expanded.has(instance);
    block.toggleClass("fc-indicator-hidden", instance.hidden === true);
    block.addEventListener("toggle", () => {
      if (block.open) {
        this.expanded.add(instance);
      } else {
        this.expanded.delete(instance);
      }
    });
    const summary = block.createEl("summary", { cls: "fc-indicator-instance-summary" });

    // Drag handle: the only draggable part of the row, so the rest of the
    // summary keeps its click-to-expand behavior. Dropping on the top/bottom
    // half of another row inserts before/after it.
    const handle = summary.createSpan({ cls: "fc-indicator-drag-handle" });
    setIcon(handle, "grip-vertical");
    handle.draggable = true;
    handle.setAttribute("role", "button");
    handle.setAttribute("aria-label", t("拖拽调整顺序"));
    handle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener("dragstart", (event) => {
      this.dragIndex = index;
      if (event.dataTransfer) {
        event.dataTransfer.setData("text/plain", String(index));
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setDragImage(block, 16, 16);
      }
      block.addClass("fc-indicator-dragging");
    });
    handle.addEventListener("dragend", () => {
      this.dragIndex = null;
      block.removeClass("fc-indicator-dragging");
      this.clearDropHints(containerEl);
    });
    block.addEventListener("dragover", (event) => {
      if (this.dragIndex === null || this.dragIndex === index) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const after = event.clientY > block.getBoundingClientRect().top + block.offsetHeight / 2;
      block.toggleClass("fc-indicator-drop-before", !after);
      block.toggleClass("fc-indicator-drop-after", after);
    });
    block.addEventListener("dragleave", () => {
      block.removeClass("fc-indicator-drop-before");
      block.removeClass("fc-indicator-drop-after");
    });
    block.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = this.dragIndex;
      this.dragIndex = null;
      if (from === null || from === index) return;
      const after = event.clientY > block.getBoundingClientRect().top + block.offsetHeight / 2;
      const [moved] = instances.splice(from, 1);
      let to = after ? index + 1 : index;
      if (from < to) to -= 1;
      instances.splice(to, 0, moved);
      this.opts.onChanged();
    });

    // The collapse triangle is an explicit fixed-width span (not a ::before
    // border triangle) so the header text offset is deterministic and the
    // parameter rows below can be padded to the exact same left edge.
    summary.createSpan({ cls: "fc-indicator-tri" });
    const row = new Setting(summary);
    // The header desc carries content (the current parameters), not an
    // explanation — keep it visible instead of an info-icon tooltip.
    row.settingEl.addClass("fc-keep-desc");
    const updateSummary = () => {
      const desc = describeIndicatorInputs(instance, def);
      row.setDesc(instance.hidden ? `${t("已隐藏")} · ${desc}` : desc);
    };
    row.setName(def ? t(def.metadata.shortTitle) : `${instance.id}${t("（失效）")}`);
    if (def) {
      // Full display name stays one hover away; the row shows the short title.
      row.nameEl.title = t(def.name);
      row.nameEl.createSpan({
        cls: "fc-indicator-badge",
        text: def.metadata.overlay ? t("主图") : t("副图"),
      });
      // Latest compute failure for this indicator id (recorded by the chart
      // renderer), surfaced inline so a broken instance is visible here too.
      const runtimeError = getIndicatorRuntimeError(instance.id);
      if (runtimeError) {
        const errorEl = row.nameEl.createSpan({ cls: "fc-indicator-error", text: `⚠ ${t("运行出错")}` });
        errorEl.title = t("最近一次计算失败：{msg}", { msg: runtimeError });
      }
    }
    updateSummary();
    // All header controls live inside the <summary> — their clicks must not
    // toggle the collapse.
    const onControlClick = (btn: { extraSettingsEl?: HTMLElement; buttonEl?: HTMLElement }, handler: () => void) => {
      const el = btn.extraSettingsEl ?? btn.buttonEl;
      el?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handler();
      });
    };
    row.addExtraButton((btn) => {
      btn.setIcon("arrow-up");
      setTooltip(btn.extraSettingsEl, t("上移"));
      if (index === 0) btn.setDisabled(true);
      onControlClick(btn, () => {
        if (index === 0) return;
        [instances[index - 1], instances[index]] = [instances[index], instances[index - 1]];
        this.opts.onChanged();
      });
    });
    row.addExtraButton((btn) => {
      btn.setIcon("arrow-down");
      setTooltip(btn.extraSettingsEl, t("下移"));
      if (index === instances.length - 1) btn.setDisabled(true);
      onControlClick(btn, () => {
        if (index >= instances.length - 1) return;
        [instances[index], instances[index + 1]] = [instances[index + 1], instances[index]];
        this.opts.onChanged();
      });
    });
    row.addExtraButton((btn) => {
      btn.setIcon(instance.hidden ? "eye-off" : "eye");
      setTooltip(btn.extraSettingsEl, instance.hidden ? t("显示指标") : t("隐藏指标"));
      onControlClick(btn, () => {
        if (instance.hidden) {
          delete instance.hidden;
        } else {
          instance.hidden = true;
        }
        this.opts.onChanged();
      });
    });
    row.addButton((btn) => {
      btn.setButtonText(t("删除"));
      onControlClick(btn, () => {
        instances.splice(index, 1);
        this.opts.onChanged();
      });
    });
    if (!def) return;
    const body = block.createDiv("fc-indicator-instance-body");
    for (const cfg of def.inputConfig) {
      this.renderInput(body, instance, def, cfg, updateSummary);
    }
  }

  private clearDropHints(containerEl: HTMLElement) {
    containerEl
      .querySelectorAll(".fc-indicator-drop-before, .fc-indicator-drop-after")
      .forEach((el) => el.classList.remove("fc-indicator-drop-before", "fc-indicator-drop-after"));
  }

  // Parameter control for one inputConfig entry. Values write into
  // instance.inputs keyed by cfg.id; an empty/unset control deletes the key
  // so the indicator definition's default applies.
  private renderInput(
    containerEl: HTMLElement,
    instance: IndicatorInstance,
    def: IndicatorDef,
    cfg: InputConfig,
    updateSummary: () => void
  ) {
    renderIndicatorInputRow(containerEl, cfg, {
      value: instance.inputs?.[cfg.id],
      defval: cfg.defval,
      doc: cfg.tooltip,
      onChange: (value) => {
        if (value === undefined) {
          if (instance.inputs) {
            delete instance.inputs[cfg.id];
            if (Object.keys(instance.inputs).length === 0) instance.inputs = undefined;
          }
        } else {
          instance.inputs = { ...instance.inputs, [cfg.id]: value };
        }
        updateSummary();
      },
    });
  }
}
