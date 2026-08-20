import { App, Modal, Notice, Setting } from "obsidian";
import { addStepper } from "./stepper";

// Calendar card editor (wireframe #screen-calendar): a month-grid picker
// (year navigation + 4×3 month cells) replacing the old inline year/month
// inputs, a 跟随当前月份 toggle (omits 月份 from the spec), the card 高度,
// and the plugin-global calendar display settings as steppers.

export interface CalendarEditInitial {
  month?: string; // YYYY-MM; absent = follow the current month
  height?: number;
}

export interface CalendarDisplayValues {
  dayFontSize: number;
  excerptFontSize: number;
  maxLines: number;
}

export interface CalendarEditResult {
  month?: string;
  height?: number;
  display: CalendarDisplayValues;
}

export class CalendarEditModal extends Modal {
  private year: number;
  private month: number; // 1–12
  private followCurrent: boolean;
  private height: string;
  private display: CalendarDisplayValues;
  private onSave: (result: CalendarEditResult) => void;

  private yearLabelEl: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;

  constructor(app: App, initial: CalendarEditInitial, display: CalendarDisplayValues, onSave: (result: CalendarEditResult) => void) {
    super(app);
    const match = initial.month ? /^(\d{4})-(\d{2})$/.exec(initial.month) : null;
    const now = new Date();
    this.year = match ? parseInt(match[1], 10) : now.getFullYear();
    this.month = match ? parseInt(match[2], 10) : now.getMonth() + 1;
    this.followCurrent = !match;
    this.height = initial.height ? String(initial.height) : "";
    this.display = { ...display };
    this.onSave = onSave;
    this.setTitle("编辑日历");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createDiv({ cls: "fc-timeline-group-title", text: "显示月份" });
    const pickerBox = contentEl.createDiv("fc-timeline-range-box");

    // Year navigation row.
    const nav = pickerBox.createDiv("fc-month-nav");
    const prevBtn = nav.createEl("button", { cls: "fc-month-nav-btn", text: "‹", attr: { type: "button", "aria-label": "上一年" } });
    this.yearLabelEl = nav.createSpan("fc-month-nav-label");
    const nextBtn = nav.createEl("button", { cls: "fc-month-nav-btn", text: "›", attr: { type: "button", "aria-label": "下一年" } });
    prevBtn.addEventListener("click", () => {
      this.year--;
      this.renderPicker();
    });
    nextBtn.addEventListener("click", () => {
      this.year++;
      this.renderPicker();
    });

    this.gridEl = pickerBox.createDiv("fc-month-grid");
    this.renderPicker();

    new Setting(contentEl)
      .setName("跟随当前月份")
      .setDesc("开启后省略月份字段，日历始终显示当月。")
      .addToggle((toggle) =>
        toggle.setValue(this.followCurrent).onChange((value) => {
          this.followCurrent = value;
          this.renderPicker();
        })
      );

    new Setting(contentEl)
      .setName("高度")
      .setDesc("可选，单位 px（200–1600，默认 400）；留空使用默认高度。")
      .addText((text) => {
        text
          .setPlaceholder("如 400")
          .setValue(this.height)
          .onChange((value) => {
            this.height = value.trim();
          });
        text.inputEl.addClass("fc-mono");
      });

    // Plugin-global display settings (wireframe: dashed group with steppers).
    const group = contentEl.createDiv("fc-canvas-logic-group");
    group.createDiv({ cls: "fc-canvas-logic-title", text: "显示设置（插件全局）" });

    const daySetting = new Setting(group).setName("日号字体");
    addStepper(daySetting.controlEl, {
      get: () => this.display.dayFontSize,
      set: (value) => {
        this.display.dayFontSize = value;
      },
      min: 12,
      max: 32,
      unit: "px",
    });

    const excerptSetting = new Setting(group).setName("摘要字体");
    addStepper(excerptSetting.controlEl, {
      get: () => this.display.excerptFontSize,
      set: (value) => {
        this.display.excerptFontSize = value;
      },
      min: 10,
      max: 24,
      unit: "px",
    });

    const linesSetting = new Setting(group).setName("最大行数");
    addStepper(linesSetting.controlEl, {
      get: () => this.display.maxLines,
      set: (value) => {
        this.display.maxLines = value;
      },
      min: 1,
      max: 8,
    });

    group.createDiv({
      cls: "fc-field-hint",
      text: "每日摘要截断行数，超出显示省略号；以上设置对所有日历卡片生效",
    });

    const footer = contentEl.createDiv("fc-modal-footer");
    const cancelBtn = footer.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { text: "保存", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());
  }

  onClose() {
    this.contentEl.empty();
  }

  private renderPicker() {
    if (this.yearLabelEl) {
      this.yearLabelEl.textContent = `${this.year} 年`;
    }
    const grid = this.gridEl;
    if (!grid) return;
    grid.empty();
    grid.classList.toggle("is-disabled", this.followCurrent);
    for (let m = 1; m <= 12; m++) {
      const cell = grid.createEl("button", {
        cls: `fc-month-cell${m === this.month ? " is-selected" : ""}`,
        text: `${m}月`,
        attr: { type: "button" },
      });
      cell.addEventListener("click", () => {
        if (this.followCurrent) return;
        this.month = m;
        this.renderPicker();
      });
    }
  }

  private save() {
    let height: number | undefined;
    if (this.height) {
      const parsed = Number(this.height);
      if (!Number.isInteger(parsed) || parsed < 200 || parsed > 1600) {
        new Notice("高度应为 200–1600 的整数（单位 px）。");
        return;
      }
      height = parsed;
    }

    this.close();
    this.onSave({
      month: this.followCurrent ? undefined : `${this.year}-${String(this.month).padStart(2, "0")}`,
      height,
      display: this.display,
    });
  }
}
