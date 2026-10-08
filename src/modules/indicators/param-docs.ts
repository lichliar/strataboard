/**
 * Human-readable explanations for built-in indicator parameters, shown as the
 * hover ⓘ tooltip next to each parameter row (via applyInfoDescs). Chinese
 * source strings are data; display layers wrap them with t().
 *
 * Kept in the display layer on purpose: src/vendor/lci/ is vendored code and
 * must not be edited, so these docs live here keyed by indicator id → param
 * id. getIndicatorParamDoc falls back to the InputConfig's own tooltip
 * (vendored/custom indicators may carry an English one).
 */

import type { InputConfig } from "oakscriptjs";
import type { IndicatorDef } from "./contract";

// Shared wording for the vendored "Smoothing" group (ema/cci/rsi/obv all
// carry the same maType/maLength/bbMult triple).
const SMOOTHING_DOCS = {
  maType: "对指标主线再做一层平滑均线的类型；选 None 则不平滑。",
  maLength: "平滑均线的周期，仅在平滑类型不为 None 时生效。",
  bbMult: "平滑类型选 SMA + Bollinger Bands 时，上下轨相对中轨的标准差倍数。",
};

const SRC_DOC = "计算所用的价格源，默认为收盘价 close。";
const OFFSET_DOC = "把指标线整体向前（正数）或向后（负数）平移的 bar 数。";

export const BUILTIN_PARAM_DOCS: Record<string, Record<string, string>> = {
  ma: {
    length: "均线周期，单位为交易日。周线/月线等图上仍按交易日计算，再贴合到显示周期。",
  },
  ema: {
    length: "指数均线周期；越大越平滑、反应越慢。",
    src: SRC_DOC,
    offset: OFFSET_DOC,
    ...SMOOTHING_DOCS,
  },
  boll: {
    length: "中轨均线的周期，也是标准差的统计窗口。",
    maType: "中轨使用的均线类型，默认 SMA。",
    src: SRC_DOC,
    mult: "上下轨相对中轨的标准差倍数；越大通道越宽、触及轨道越少见。",
    offset: OFFSET_DOC,
  },
  psar: {
    start: "加速因子的起始值；越小转向点越稳、越少。",
    increment: "趋势每延续一根 bar，加速因子增加的步长。",
    maximum: "加速因子的上限，防止指标对趋势加速过度敏感。",
  },
  supertrend: {
    atrPeriod: "计算 ATR（平均真实波幅）的周期。",
    factor: "ATR 倍数，决定轨道宽度；越大信号越少、越不容易反复转向。",
  },
  ichimoku: {
    conversionPeriods: "转换线（快线）周期，默认 9。",
    basePeriods: "基准线（慢线）周期，默认 26。",
    laggingSpan2Periods: "先行带 B 的周期，默认 52。",
    displacement: "迟行带与先行带向前/后平移的 bar 数，默认 26。",
  },
  dmi: {
    diLength: "计算 +DI/-DI（方向线）的周期。",
    adxSmoothing: "计算 ADX（趋势强度）的平滑周期。",
  },
  macd: {
    src: SRC_DOC,
    fastLength: "快线 EMA 周期，默认 12。",
    slowLength: "慢线 EMA 周期，默认 26；DIF = 快线 − 慢线。",
    signalLength: "信号线（DEA，DIF 的均线）周期，默认 9。",
    oscMaType: "计算快线/慢线用的均线类型，默认 EMA。",
    signalMaType: "计算信号线用的均线类型，默认 EMA。",
  },
  rsi: {
    length: "RSI 周期，默认 14；常用阈值 70/30 判断超买超卖。",
    src: SRC_DOC,
    calculateDivergence: "是否计算背离（供背离提醒使用，图表上无额外绘制）。",
    ...SMOOTHING_DOCS,
  },
  cci: {
    length: "CCI 周期，默认 20；常用阈值 ±100 判断超买超卖。",
    src: "计算所用的典型价格，默认 hlc3 =（高+低+收）/3。",
    ...SMOOTHING_DOCS,
  },
  willr: {
    length: "威廉指标周期，默认 14；取值 0 ~ -100，-20 以上超买、-80 以下超卖。",
    src: SRC_DOC,
  },
  kdj: {
    length: "RSV 的统计周期，默认 9。",
    signalK: "K 值的平滑周期，默认 3。",
    signalD: "D 值（K 的均线）的平滑周期，默认 3；J = 3K − 2D。",
  },
  bias: {
    length: "乖离率周期：收盘价偏离 N 日均线的百分比。",
  },
  obv: { ...SMOOTHING_DOCS },
  atr: {
    length: "ATR 周期，默认 14；衡量真实波幅的平均水平。",
    smoothing: "真实波幅的平滑方式，默认 RMA。",
  },
};

/** Chinese doc for a parameter, else the InputConfig's own tooltip. */
export function getIndicatorParamDoc(def: IndicatorDef, cfg: InputConfig): string | undefined {
  return BUILTIN_PARAM_DOCS[def.id]?.[cfg.id] ?? cfg.tooltip;
}
