import { Setting, type SliderComponent } from "obsidian";
import type { DisplayOverrides } from "../types";
import { t } from "../i18n";

// Shared 「图表显示（覆盖全局）」 group for the chart card edit modals. Every
// field is a tri-state override of the plugin-wide 显示设置: 跟随全局 keeps the
// field undefined in the card spec, 始终开启/始终关闭 (or 自定义 + slider) pins it.
export function renderDisplayOverrideSettings(
  containerEl: HTMLElement,
  state: DisplayOverrides,
  opts: { series: boolean; ma?: boolean }
): void {
  const group = containerEl.createDiv("fc-canvas-logic-group");
  group.createDiv({ cls: "fc-canvas-logic-title", text: t("图表显示（覆盖全局）") });

  const addBoolOverride = (
    name: string,
    field: "showLegend" | "legendFrosted" | "showLatestValue" | "showPointMarkers" | "showMA" | "showGrid"
  ) => {
    new Setting(group).setName(t(name)).addDropdown((dropdown) => {
      dropdown
        .addOption("", t("跟随全局"))
        .addOption("on", t("始终开启"))
        .addOption("off", t("始终关闭"))
        .setValue(state[field] === undefined ? "" : state[field] ? "on" : "off")
        .onChange((value) => {
          state[field] = value === "" ? undefined : value === "on";
        });
    });
  };

  // The slider only pre-fills with the global default placeholder when a
  // freshly enabled custom override has no value yet.
  const addOpacityOverride = (name: string, field: "legendOpacity" | "gridOpacity", placeholder: number) => {
    let slider: SliderComponent | null = null;
    const setting = new Setting(group).setName(t(name));
    setting.addDropdown((dropdown) => {
      dropdown
        .addOption("", t("跟随全局"))
        .addOption("custom", t("自定义"))
        .setValue(state[field] === undefined ? "" : "custom")
        .onChange((value) => {
          if (value === "custom") {
            state[field] ??= placeholder;
            slider?.setValue(state[field]);
          } else {
            state[field] = undefined;
          }
          slider?.sliderEl.toggle(value === "custom");
        });
    });
    setting.addSlider((s) => {
      s.setLimits(0, 100, 1)
        .setValue(state[field] ?? placeholder)
        .setDynamicTooltip()
        .onChange((value) => {
          state[field] = value;
        });
      s.sliderEl.toggle(state[field] !== undefined);
      slider = s;
    });
  };

  addBoolOverride("显示图表图例", "showLegend");
  addBoolOverride("图例半透明背景", "legendFrosted");
  addOpacityOverride("图例背景透明度", "legendOpacity", 72);
  if (opts.series) {
    addBoolOverride("系列图最新值标记", "showLatestValue");
    addBoolOverride("折线图数据点标记", "showPointMarkers");
  }
  // K-line cards only (the unified edit modal passes ma: true).
  if (opts.ma) {
    addBoolOverride("显示均线", "showMA");
  }
  addBoolOverride("显示网格线", "showGrid");
  addOpacityOverride("网格线透明度", "gridOpacity", 20);
}
