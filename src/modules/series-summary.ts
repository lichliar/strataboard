import type { ChartTheme, CorrTransform, OverlayCompareMode, OverlaySpec, SeriesPeriod, SpreadSpec } from "../types";
import { MIN_CORR_SAMPLES, type CorrelationReport } from "./overlay-lines";
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
  { value: "W", label: "周线" },
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
const PERIOD_SHORT: Record<SeriesPeriod, string> = { D: "日线", W: "周线", M: "月线", Q: "季线", Y: "年线" };

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
// showCorrelation is the plugin-wide 指标 tab switch; off suppresses every
// correlation segment (the badge and the corr: none exclusion note alike).
export function buildOverlaySubtitle(
  spec: OverlaySpec,
  lineNames: string[],
  firstDates: (string | undefined)[],
  correlation?: CorrelationReport | null,
  showCorrelation = true
): string {
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
  // An explicit 名称 hides the "code · profile" label form, so echo the
  // effective fetch profile here — the correlation badge is meaningless
  // without knowing which 口径 produced the series.
  const profileEchoes = spec.series
    .map((ref, i) => ({ ref, i }))
    .filter(({ ref }) => ref.source === "quote" && ref.label && ref.profile)
    .map(({ ref, i }) => `${lineNames[i]}＝${ref.profile}`);
  if (profileEchoes.length > 0) {
    parts.push(t("口径：{items}", { items: profileEchoes.join(" · ") }));
  }
  if (showCorrelation && spec.series.length === 2 && spec.correlation !== false) {
    const corrPart = correlationPart(spec, lineNames, correlation);
    if (corrPart) {
      parts.push(corrPart);
      // A negative 缩放系数 flips the plotted line but never the statistic:
      // the badge always describes the RAW series. Say so when a flip is
      // visible on the chart.
      if (spec.series.some((ref) => (ref.scale ?? 1) < 0)) {
        parts.push(t("相关按原始序列计算（不含缩放）"));
      }
    }
  }
  return parts.join(" · ");
}

// Transform names as shown in the correlation badge definition.
const CORR_TRANSFORM_LABELS: Record<CorrTransform, string> = {
  return: "收益率",
  diff: "一阶差分",
  bond: "债券收益方向（−Δ）",
  raw: "原值",
  none: "不参与",
};

// The correlation segment of the overlay subtitle, number first so the
// statistic is scannable and the definition trails in parentheses. Every
// state is explicit: 样本不足 / 序列无波动 / 不参与 instead of a silently
// missing badge, and a 5%-significance flag on weak |r|.
function correlationPart(spec: OverlaySpec, lineNames: string[], correlation?: CorrelationReport | null): string | null {
  const excluded = spec.series
    .map((ref, i) => ({ ref, i }))
    .filter(({ ref }) => ref.corr === "none")
    .map(({ i }) => lineNames[i]);
  if (excluded.length > 0) {
    return t("相关：{names} 设为不参与", { names: excluded.join("、") });
  }
  if (!correlation) return null;
  if (correlation.reason === "insufficient") {
    return t("相关：样本不足（n={count}<{min}）", { count: correlation.sampleCount, min: MIN_CORR_SAMPLES });
  }
  if (correlation.reason === "constant" || correlation.coefficient === undefined) {
    return t("相关：序列无波动");
  }
  const labelA = t(CORR_TRANSFORM_LABELS[correlation.transformA]);
  const labelB = t(CORR_TRANSFORM_LABELS[correlation.transformB]);
  // Leg order matches the title's "对比（A+B）", so the definition doesn't
  // repeat the names.
  const definition = correlation.transformA === correlation.transformB ? labelA : `${labelA} × ${labelB}`;
  const r = correlation.coefficient;
  // |r| < 0.1 gets a third decimal so "0.02" doesn't read as "roughly zero".
  const coefficient = `${r >= 0 ? "+" : ""}${r.toFixed(Math.abs(r) < 0.1 ? 3 : 2)}`;
  const detail = `${definition} · n=${correlation.sampleCount}${correlation.significant === false ? ` · ${t("5% 水平不显著")}` : ""}`;
  return t("相关 {coefficient}（{detail}）", { coefficient, detail });
}

// Hover explanation for the subtitle (series-chart-renderer): what the badge
// actually measures. Static text — the per-card transforms are already named
// in the subtitle itself.
export const CORRELATION_TOOLTIP = "相关系数说明：两条序列在共同交易日上的逐期相关（Pearson）。收益率＝当日/前一日−1；一阶差分＝当日−前一日；债券收益方向＝−（当日−前一日）；原值＝序列直接参与。n 为有效样本对数；「5% 水平不显著」表示该系数与零无统计差异（|t|≤1.96）。统计按全部载入区间的原始序列计算，与图表归一化、可视窗口和缩放系数无关；图上画的是水平线形状，与逐期相关回答的是两个问题。";

// Spread subtitle: "= A-B · 日线 · 近10年".
export function buildSpreadSubtitle(spec: SpreadSpec): string {
  return [t("= {expr}", { expr: spec.expression }), periodPart(spec.period), rangePart(spec.range)].join(" · ");
}
