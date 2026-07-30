import { App, Modal, Notice, Setting, type TextComponent } from "obsidian";
import type { TimelineUnit } from "../modules/timeline-renderer";

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

export class TimelineEditModal extends Modal {
  private startValue: string;
  private endValue: string;
  private autoEnd: boolean;
  private unitValue: TimelineUnit;
  private endText: TextComponent | null = null;
  private onSubmit: (result: TimelineEditResult) => void;

  constructor(app: App, initial: TimelineEditInitial, onSubmit: (result: TimelineEditResult) => void) {
    super(app);
    this.startValue = initial.start;
    this.endValue = initial.end ?? "";
    this.autoEnd = initial.end === null;
    this.unitValue = initial.unit;
    this.onSubmit = onSubmit;
    this.setTitle("编辑时间线");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl)
      .setName("开始日期")
      .addText((text) => {
        text.inputEl.type = "date";
        text.setValue(this.startValue).onChange((value) => {
          this.startValue = value;
        });
      });

    new Setting(contentEl)
      .setName("结束日期")
      .setDesc("开启“自动更新到今天”时省略结束日期，此输入不可用。")
      .addText((text) => {
        text.inputEl.type = "date";
        text
          .setValue(this.endValue)
          .setDisabled(this.autoEnd)
          .onChange((value) => {
            this.endValue = value;
          });
        this.endText = text;
      });

    new Setting(contentEl)
      .setName("自动更新到今天")
      .setDesc("开启后时间线随日期自动延伸，并在每天零点更新“今天”标记。")
      .addToggle((toggle) =>
        toggle.setValue(this.autoEnd).onChange((value) => {
          this.autoEnd = value;
          this.endText?.setDisabled(value);
        })
      );

    new Setting(contentEl)
      .setName("颗粒度")
      .addDropdown((dropdown) => {
        for (const option of UNIT_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown.setValue(this.unitValue).onChange((value) => {
          this.unitValue = value as TimelineUnit;
        });
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("保存")
        .setCta()
        .onClick(() => {
          if (!this.validate()) return;
          this.close();
          this.onSubmit({
            start: this.startValue,
            end: this.autoEnd ? null : this.endValue,
            unit: this.unitValue,
          });
        })
    );
  }

  onClose() {
    this.contentEl.empty();
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
