/**
 * Built-in indicator registry content: thin wrappers around the vendored lci
 * standard files plus the self-written builtins (ma/kdj/bias). Chinese names
 * and categories are data; display layers wrap them with t().
 */

import { EMA } from "../../vendor/lci/standard/ema";
import { BollingerBands } from "../../vendor/lci/standard/bb";
import { ParabolicSAR } from "../../vendor/lci/standard/parabolic-sar";
import { Supertrend } from "../../vendor/lci/standard/supertrend";
import { IchimokuCloud } from "../../vendor/lci/standard/ichimoku";
import { MACD } from "../../vendor/lci/standard/macd";
import { RSI } from "../../vendor/lci/standard/rsi";
import { CCI } from "../../vendor/lci/standard/cci";
import { WilliamsPercentRange } from "../../vendor/lci/standard/williams-r";
import { DMI } from "../../vendor/lci/standard/dmi";
import { OBV } from "../../vendor/lci/standard/obv";
import { ATR } from "../../vendor/lci/standard/atr";
import { MA } from "./builtin/ma";
import { KDJ } from "./builtin/kdj";
import { BIAS } from "./builtin/bias";
import type { IndicatorDef } from "./contract";

// A vendored lci module (or one of the self-written builtins sharing the
// shape) viewed through the unified contract. The vendored `calculate` takes
// a precisely-typed Partial<…Inputs>; through the contract it receives
// Record<string, unknown>, so each module is cast here once.
type VendoredModule = {
  metadata: IndicatorDef["metadata"];
  defaultInputs: Record<string, unknown>;
  inputConfig: IndicatorDef["inputConfig"];
  plotConfig?: IndicatorDef["plotConfig"];
  hlineConfig?: IndicatorDef["hlineConfig"];
  fillConfig?: IndicatorDef["fillConfig"];
  calculate: IndicatorDef["calculate"];
};

function wrap(mod: unknown, id: string, name: string, category: string): IndicatorDef {
  const v = mod as VendoredModule;
  return {
    id,
    name,
    category,
    origin: "builtin",
    metadata: v.metadata,
    inputConfig: v.inputConfig,
    defaultInputs: v.defaultInputs,
    plotConfig: v.plotConfig,
    hlineConfig: v.hlineConfig,
    fillConfig: v.fillConfig,
    calculate: (bars, inputs, ctx) => v.calculate(bars, inputs, ctx),
  };
}

export const BUILTIN_INDICATORS: IndicatorDef[] = [
  wrap(EMA, "ema", "指数均线", "均线"),
  wrap(MA, "ma", "均线", "均线"),
  wrap(BollingerBands, "boll", "布林带", "通道"),
  wrap(ParabolicSAR, "psar", "抛物线转向", "趋势"),
  wrap(Supertrend, "supertrend", "超级趋势", "趋势"),
  wrap(IchimokuCloud, "ichimoku", "一目均衡表", "趋势"),
  wrap(DMI, "dmi", "动向指标", "趋势"),
  wrap(MACD, "macd", "MACD", "动量"),
  wrap(RSI, "rsi", "RSI", "震荡"),
  wrap(CCI, "cci", "CCI", "震荡"),
  wrap(WilliamsPercentRange, "willr", "威廉指标", "震荡"),
  wrap(KDJ, "kdj", "KDJ", "震荡"),
  wrap(BIAS, "bias", "BIAS乖离率", "震荡"),
  wrap(OBV, "obv", "能量潮", "成交量"),
  wrap(ATR, "atr", "平均真实波幅", "波动"),
];
