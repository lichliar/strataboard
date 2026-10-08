import type { SignalEvent } from "../types";
import { t } from "../i18n";

export interface SignalTipEntry {
  seriesName?: string;  // multi-line cards (overlay/spread): which line the event hangs on
  seriesColor?: string;
  event: SignalEvent;
}

// Floating crosshair readout for signal events: the bar markers only carry a
// 12-char truncated text and have no hover, so hovering a bar with events
// pops this chip with the full buy/sell text(s).
export class SignalTooltip {
  private el: HTMLElement | null = null;

  constructor(private readonly containerEl: HTMLElement) {}

  show(x: number, y: number, entries: SignalTipEntry[]): void {
    if (entries.length === 0) {
      this.hide();
      return;
    }
    if (!this.el) {
      this.el = this.containerEl.createDiv({ cls: "fc-signal-tip" });
    }
    const el = this.el;
    el.empty();
    for (const entry of entries) {
      const row = el.createDiv({ cls: "fc-signal-tip-row" });
      row.createSpan({
        cls: `fc-signal-tip-side ${entry.event.side === "buy" ? "is-buy" : "is-sell"}`,
        text: entry.event.side === "buy" ? t("买入") : t("卖出"),
      });
      if (entry.seriesName) {
        const nameEl = row.createSpan({ cls: "fc-signal-tip-series", text: entry.seriesName });
        if (entry.seriesColor) nameEl.style.color = entry.seriesColor;
      }
      if (entry.event.text) {
        row.createSpan({ cls: "fc-signal-tip-text", text: entry.event.text });
      }
    }
    el.show();
    // Keep the chip inside the chart: right of the crosshair (flipping left
    // near the right edge), above the cursor (flipping below near the top).
    const maxLeft = Math.max(0, this.containerEl.clientWidth - el.offsetWidth - 4);
    const left = Math.max(0, Math.min(x + 16, maxLeft));
    const above = y - el.offsetHeight - 12;
    el.style.left = `${left}px`;
    el.style.top = `${above >= 0 ? above : y + 16}px`;
  }

  hide(): void {
    this.el?.hide();
  }
}
