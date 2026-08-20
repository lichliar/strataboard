import { App, Modal, Notice, Setting, type TextComponent } from "obsidian";
import type { TimelineUnit } from "../modules/timeline-renderer";
import { formatIsoDate } from "../utils/date";

// Timeline card editor (wireframe #screen-timeline): range preset chips +
// start/end date inputs + a live range preview bar, plus a segmented control
// for 颗粒度 (replacing the old dropdown).

export interface TimelineEditInitial {
  start: string; // YYYY-MM-DD
  end: string | null; // null = auto (today)
  unit: TimelineUnit;
}

export interface TimelineEditResult {
  start: string;
  end: string | null;
  unit: TimelineUnit;
}

const UNIT_OPTIONS: { value: TimelineUnit; label: string }[] = [
  { value: "day", label: "日" },
  { value: "week", label: "周" },
  { value: "month", label: "月" },
  { value: "quarter", label: "季度" },
  { value: "year", label: "年" },
];

type RangePreset = "3m" | "6m" | "1y" | "3y" | "custom";

const RANGE_PRESETS: { value: Exclude<RangePreset, "custom">; label: string; months: number }[] = [
  { value: "3m", label: "近3月", months: 3 },
  { value: "6m", label: "近6月", months: 6 },
  { value: "1y", label: "近1年", months: 12 },
  { value: "3y", label: "近3年", months: 36 },
];

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function todayIso(): string {
  return formatIsoDate(new Date());
}

function monthsAgoIso(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return formatIsoDate(date);
}

export class TimelineEditModal extends Modal {
  private preset: RangePreset;
  private startValue: string;
  private endValue: string;
  private autoEnd: boolean;
  private unitValue: TimelineUnit;
  private chipsEl: HTMLElement | null = null;
  private endText: TextComponent | null = null;
  private previewStartEl: HTMLElement | null = null;
  private previewEndEl: HTMLElement | null = null;
  private onSubmit: (result: TimelineEditResult) => void;

  constructor(app: App, initial: TimelineEditInitial, onSubmit: (result: TimelineEditResult) => void) {
    super(app);
    this.startValue = initial.start;
    this.endValue = initial.end ?? "";
    this.autoEnd = initial.end === null;
    this.unitValue = initial.unit;
    this.onSubmit = onSubmit;
    // A saved card matches a preset only when it auto-ends today and its start
    // is exactly the preset's start; anything else shows 自定义 as active.
    const matched = this.autoEnd
      ? RANGE_PRESETS.find((preset) => monthsAgoIso(preset.months) === this.startValue)
      : undefined;
    this.preset = matched?.value ?? "custom";
    this.setTitle("编辑时间线");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createDiv({ cls: "fc-timeline-group-title", text: "时间范围" });
    const rangeBox = contentEl.createDiv("fc-timeline-range-box");

    // Preset chips (近3月/…/自定义).
    this.chipsEl = rangeBox.createDiv("fc-widget-chips");
    for (const preset of RANGE_PRESETS) {
      const chip = this.chipsEl.createEl("button", {
        cls: "fc-chip",
        text: preset.label,
        attr: { type: "button" },
      });
      chip.dataset.preset = preset.value;
      chip.addEventListener("click", () => {
        this.preset = preset.value;
        this.startValue = monthsAgoIso(preset.months);
        this.autoEnd = true;
        this.renderChips();
        this.onDatesChanged();
      });
    }
    const customChip = this.chipsEl.createEl("button", {
      cls: "fc-chip",
      text: "自定义",
      attr: { type: "button" },
    });
    customChip.dataset.preset = "custom";
    customChip.addEventListener("click", () => {
      this.preset = "custom";
      this.renderChips();
      this.onDatesChanged();
    });
    this.renderChips();

    // Start → end date inputs (end greys out with 自动更新到今天).
    const datesRow = rangeBox.createDiv("fc-timeline-dates");
    new Setting(datesRow).setClass("fc-timeline-date-setting").addText((text) => {
      text.inputEl.type = "date";
      text.setValue(this.startValue).onChange((value) => {
        this.startValue = value;
        this.preset = "custom";
        this.renderChips();
        this.onDatesChanged(false);
      });
    });
    datesRow.createSpan({ cls: "fc-timeline-dates-arrow", text: "→" });
    new Setting(datesRow).setClass("fc-timeline-date-setting").addText((text) => {
      text.inputEl.type = "date";
      text
        .setValue(this.endValue)
        .setDisabled(this.autoEnd)
        .onChange((value) => {
          this.endValue = value;
          this.preset = "custom";
          this.renderChips();
          this.onDatesChanged(false);
        });
      this.endText = text;
    });

    // Range preview bar: accent segment + start dot + today marker.
    const preview = rangeBox.createDiv("fc-range-preview");
    const bar = preview.createDiv("fc-range-preview-bar");
    bar.createDiv("fc-range-preview-track");
    bar.createDiv("fc-range-preview-span");
    bar.createSpan("fc-range-preview-start");
    bar.createSpan("fc-range-preview-today");
    const labels = preview.createDiv("fc-range-preview-labels");
    this.previewStartEl = labels.createSpan();
    this.previewEndEl = labels.createSpan();
    this.updatePreview();

    new Setting(contentEl)
      .setName("自动更新到今天")
      .setDesc("结束日期跟随今天，每天零点刷新标记。")
      .addToggle((toggle) =>
        toggle.setValue(this.autoEnd).onChange((value) => {
          this.autoEnd = value;
          this.onDatesChanged();
        })
      );

    const unitSetting = new Setting(contentEl).setName("颗粒度").setDesc("时间轴刻度密度：日 / 周 / 月 / 季度 / 年。");
    const segmented = unitSetting.controlEl.createDiv("fc-segmented");
    for (const option of UNIT_OPTIONS) {
      const item = segmented.createEl("button", {
        cls: `fc-segmented-item${option.value === this.unitValue ? " is-active" : ""}`,
        text: option.label,
        attr: { type: "button" },
      });
      item.addEventListener("click", () => {
        this.unitValue = option.value;
        segmented.querySelectorAll(".fc-segmented-item").forEach((el) => el.classList.remove("is-active"));
        item.classList.add("is-active");
      });
    }

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: "保存", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      if (!this.validate()) return;
      this.close();
      this.onSubmit({
        start: this.startValue,
        end: this.autoEnd ? null : this.endValue,
        unit: this.unitValue,
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }

  private renderChips() {
    this.chipsEl?.querySelectorAll(".fc-chip").forEach((el) => {
      el.classList.toggle("is-active", (el as HTMLElement).dataset.preset === this.preset);
    });
  }

  // Syncs the end-input disabled state, the date row and the preview after
  // any range change. syncInputs=false when the change CAME from an input
  // (rewriting it would fight the user's typing).
  private onDatesChanged(syncInputs = true) {
    this.endText?.setDisabled(this.autoEnd);
    if (this.autoEnd) {
      this.endText?.setValue("");
      this.endText?.setPlaceholder(`${todayIso()}（自动）`);
    } else if (!this.endValue) {
      this.endValue = todayIso();
      this.endText?.setValue(this.endValue);
    }
    this.updatePreview();
  }

  private updatePreview() {
    if (this.previewStartEl) {
      this.previewStartEl.textContent = this.startValue || "—";
    }
    if (this.previewEndEl) {
      this.previewEndEl.textContent = this.autoEnd ? `今天 · ${todayIso()}` : this.endValue || "—";
    }
  }

  private validate(): boolean {
    if (!isValidIsoDate(this.startValue)) {
      new Notice("请填写有效的开始日期（YYYY-MM-DD）。");
      return false;
    }
    if (!this.autoEnd) {
      if (!isValidIsoDate(this.endValue)) {
        new Notice("请填写有效的结束日期，或开启“自动更新到今天”。");
        return false;
      }
      // ISO dates compare lexicographically.
      if (this.endValue < this.startValue) {
        new Notice("结束日期不能早于开始日期。");
        return false;
      }
    }
    return true;
  }
}
