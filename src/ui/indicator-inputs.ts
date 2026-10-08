/**
 * Shared parameter control for one indicator inputConfig entry, used by both
 * the card edit modal (per-card instance overrides) and the builtin-indicator
 * edit modal (global default overrides).
 *
 * Values write back through onChange keyed by the caller; an empty/unset
 * control reports undefined so the caller deletes the key and the effective
 * default applies. Known limitation (v1): the `active` condition is ignored —
 * dependent inputs are not greyed out.
 */

import { Setting } from "obsidian";
import type { InputConfig } from "oakscriptjs";
import { t } from "../i18n";

export interface IndicatorInputRowOptions {
  /** Explicit override value; undefined = inherit the effective default. */
  value: unknown;
  /**
   * Effective default shown as placeholder/fallback. In the card edit modal
   * this is the builtin defval plus any settings-level override; in the
   * builtin-indicator edit modal it is the raw defval.
   */
  defval: unknown;
  /** Optional parameter explanation, rendered as the row description (the
   * caller's applyInfoDescs pass collapses it into a hover ⓘ icon). */
  doc?: string;
  /** New override value, or undefined to clear the override. */
  onChange: (value: unknown) => void;
}

export function renderIndicatorInputRow(
  containerEl: HTMLElement,
  cfg: InputConfig,
  opts: IndicatorInputRowOptions
): void {
  const current = opts.value;
  const defval = opts.defval ?? cfg.defval;
  const setting = new Setting(containerEl).setName(cfg.title ?? cfg.id);
  setting.settingEl.addClass("fc-indicator-input");
  if (opts.doc) setting.setDesc(t(opts.doc));

  switch (cfg.type) {
    case "int":
    case "float": {
      setting.addText((text) => {
        text.inputEl.type = "number";
        if (cfg.min !== undefined) text.inputEl.min = String(cfg.min);
        if (cfg.max !== undefined) text.inputEl.max = String(cfg.max);
        text.inputEl.step = String(cfg.step ?? (cfg.type === "int" ? 1 : "any"));
        text.setPlaceholder(String(defval ?? "")).setValue(current === undefined ? "" : String(current));
        text.onChange((raw) => {
          const trimmed = raw.trim();
          if (trimmed === "") {
            opts.onChange(undefined);
            return;
          }
          const n = Number(trimmed);
          if (!Number.isFinite(n)) return;
          opts.onChange(cfg.type === "int" ? Math.round(n) : n);
        });
        text.inputEl.addClass("fc-mono");
      });
      break;
    }
    case "bool": {
      // A toggle cannot express "unset": it tracks the effective value
      // (explicit ?? defval) and any change writes an explicit override.
      setting.addToggle((toggle) =>
        toggle.setValue(Boolean(current ?? defval)).onChange((value) => opts.onChange(value))
      );
      break;
    }
    case "source": {
      setting.addDropdown((dropdown) => {
        dropdown.addOption("", t("默认"));
        for (const source of ["open", "high", "low", "close", "volume"]) {
          dropdown.addOption(source, source);
        }
        dropdown.setValue(current === undefined ? "" : String(current)).onChange((value) => {
          opts.onChange(value === "" ? undefined : value);
        });
      });
      break;
    }
    case "string": {
      if (Array.isArray(cfg.options) && cfg.options.length > 0) {
        setting.addDropdown((dropdown) => {
          dropdown.addOption("", t("默认"));
          for (const option of cfg.options!) {
            dropdown.addOption(option, option);
          }
          dropdown.setValue(current === undefined ? "" : String(current)).onChange((value) => {
            opts.onChange(value === "" ? undefined : value);
          });
        });
      } else {
        setting.addText((text) =>
          text.setPlaceholder(String(defval ?? "")).setValue(current === undefined ? "" : String(current)).onChange((value) => {
            opts.onChange(value.trim() === "" ? undefined : value);
          })
        );
      }
      break;
    }
    case "color": {
      // The picker shows the effective value but only writes an explicit
      // override when the user actually picks a color (untouched = default).
      setting.addColorPicker((picker) =>
        picker.setValue(String(current ?? defval ?? "#f59e0b")).onChange((value) => opts.onChange(value))
      );
      break;
    }
    default: {
      // timeframe/session/time etc.: no v1 control — read-only display.
      setting.addText((text) => text.setValue(String(current ?? defval ?? "")).setDisabled(true));
      break;
    }
  }
}
