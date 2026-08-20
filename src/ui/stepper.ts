// Shared stepper control (wireframe: − / value unit / ＋ in one bordered box,
// used for 出血尺寸 in the unified modal and the 数据计算卡 modal).

export interface StepperOptions {
  get: () => number;
  set: (value: number) => void;
  min: number;
  max: number;
  unit?: string;
}

export function addStepper(controlEl: HTMLElement, options: StepperOptions): void {
  const stepper = controlEl.createDiv("fc-stepper");
  const minus = stepper.createEl("button", { cls: "fc-stepper-btn", text: "−", attr: { type: "button" } });
  const valueEl = stepper.createSpan("fc-stepper-value");
  const plus = stepper.createEl("button", { cls: "fc-stepper-btn", text: "＋", attr: { type: "button" } });
  const render = () => {
    valueEl.empty();
    valueEl.appendText(String(options.get()));
    if (options.unit) {
      valueEl.createSpan({ cls: "fc-stepper-unit", text: options.unit });
    }
  };
  minus.addEventListener("click", () => {
    options.set(Math.max(options.min, options.get() - 1));
    render();
  });
  plus.addEventListener("click", () => {
    options.set(Math.min(options.max, options.get() + 1));
    render();
  });
  render();
}
