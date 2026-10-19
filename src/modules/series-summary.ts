import type { ChartTheme, OverlayCompareMode, OverlaySpec, SeriesPeriod, SpreadSpec } from "../types";
import { t } from "../i18n";

// Shared presentation text for the overlay (compare) / spread (calc) cards:
// the dropdown option lists used by both edit modals, and the card subtitle
// builders. Obsidian-free so the Obsidian renderers (main.ts) and the
// headless PNG renderer (render-headless.ts) stay 同口径.

export const RANGE_OPTIONS: { value: string; label: string }[] = [
  { value: "1y", label: "近1年" },
  { value: "3y", label: "近3年" },
  { value: "5y", label: "近5年" },
  { value: "10y", label: "近10年" },
  { value: "20y", label: "近20年" },
  { value: "max", label: "全部" },
];

export const PERIOD_OPTIONS: { value: SeriesPeriod; label: string }[] = [
  { value: "D", label: "日线" },
  { value: "M", label: "月线" },
  { value: "Q", label: "季线" },
  { value: "Y", label: "年线" },
];

export const THEME_OPTIONS: { value: ChartTheme; label: string }[] = [
  { value: "auto", label: "跟随 Obsidian 主题" },
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
];

// Short period labels for the subtitle ("月线 · 近3年 · …"); reuses the
// PERIOD_OPTIONS labels (single chars like "日" already mean Sunday elsewhere).
const PERIOD_SHORT: Record<SeriesPeriod, string> = { D: "日线", M: "月线", Q: "季线", Y: "年线" };

const COMPARE_MODE_SHORT: Record<OverlayCompareMode, string> = {
  percent: "百分比归一",
  zscore: "标准化",
  axis: "独立纵轴",
  none: "原始值",
};

function periodPart(period: SeriesPeriod | undefined): string {
  return t(PERIOD_SHORT[period ?? "D"]);
}

// Preset ranges use their Chinese label; anything else (hand-written YAML)
// is shown verbatim.
function rangePart(range: string): string {
  return t(RANGE_OPTIONS.find((o) => o.value === range)?.label ?? range);
}

// Overlay subtitle: "月线 · 近3年 · 百分比归一 · 归一基准：2024-01-02 · 缩放：2. 茅台 ×1.5".
// firstDates[i] is the first actual observation date of series i (undefined
// when the series has no points in range); only quote legs get a rebase base.
export function buildOverlaySubtitle(spec: OverlaySpec, lineNames: string[], firstDates: (string | undefined)[]): string {
  const mode = spec.normalize ?? "percent";
  const parts = [periodPart(spec.period), rangePart(spec.range), t(COMPARE_MODE_SHORT[mode])];
  if (mode === "percent") {
    const bases: { name: string; date: string }[] = [];
    spec.series.forEach((ref, i) => {
      const date = firstDates[i];
      if (ref.source === "quote" && date) {
        bases.push({ name: lineNames[i], date });
      }
    });
    if (bases.length > 0) {
      parts.push(
        bases.every((b) => b.date === bases[0].date)
          ? t("归一基准：{date}", { date: bases[0].date })
          : t("归一基准：{bases}", { bases: bases.map((b) => `${b.name} ${b.date}`).join(" · ") })
      );
    }
  } else if (mode === "zscore") {
    parts.push(t("z = (x − 区间均值) ÷ 区间标准差"));
  } else if (mode === "axis") {
    parts.push(t("各系列按各自数值范围缩放"));
  }
  // 缩放系数 badges: only non-1 factors are listed; scale = 1 stays silent.
  const scaled = spec.series
    .map((ref, i) => ({ ref, i }))
    .filter(({ ref }) => ref.scale !== undefined && ref.scale !== 1);
  if (scaled.length > 0) {
    parts.push(t("缩放：{items}", { items: scaled.map(({ ref, i }) => `${i + 1}. ${lineNames[i]} ×${ref.scale}`).join(" · ") }));
  }
  return parts.join(" · ");
}

// Spread subtitle: "= A-B · 日线 · 近10年".
export function buildSpreadSubtitle(spec: SpreadSpec): string {
  return [t("= {expr}", { expr: spec.expression }), periodPart(spec.period), rangePart(spec.range)].join(" · ");
}
