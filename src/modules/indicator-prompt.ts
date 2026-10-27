// Indicator-authoring guide for external AI agents. Carries the custom-
// indicator contract validated by validateIndicatorDef (indicators/contract.ts)
// plus the compliance rules. Shared by the MCP get_indicator_guide tool and
// the CLI guide indicator command — which is why this module must stay
// obsidian-free (the MCP bundle aliases "obsidian" to a shim without TFile).
export const AI_INDICATOR_PROMPT = `我在用一个 Obsidian 插件（StrataBoard）的「自定义指标」功能：把 .js 指标文件放进指标文件夹（<指标文件夹>），插件自动把它注册为技术指标，可以在 K 线卡片上叠加显示。请帮我写一个指标文件，并把完整文件内容给我。

这个指标要做的事情：【在这里描述你想要的指标；如果是修错，粘贴你的现有文件和设置页「指标」里显示的完整报错；只提供你原创、获授权或许可证允许改编的参考代码】

文件契约（必须遵守）：
- 纯 CommonJS 风格：module.exports = { metadata, inputConfig, defaultInputs, plotConfig, calculate }，文件名（不含 .js）slug 化后就是指标 id；
- metadata: { title: 完整名, shortTitle: 短名（图表图例用）, overlay: true/false, scale?: "price"|"none" }——overlay=true 画在主图（K 线）上，false 独占一个副图窗格；主图指标若使用 0–N 等抽象坐标，设置 scale:"none" 使用不可见独立坐标轴，否则省略或使用 scale:"price"；可选 labelParams: ["length"] 指定图表标签中显示的参数；不写时默认显示首个数值参数，MACD 默认显示前三个数值参数；
- inputConfig: 参数声明数组，每项 { id, type, title, defval, min?, max?, step?, options?, group? }；type 用 int/float/bool/string/source/color 之一，options 仅 string 类型的下拉选项；
- defaultInputs: { 参数id: 默认值 }，与 inputConfig 一一对应；
- calculate(bars, inputs) 是唯一的计算入口：bars 是 K 线数组，每根 { time（秒级 Unix 时间戳）, open, high, low, close, volume }；inputs 是用户参数（已与 defaultInputs 合并）。返回 { metadata: { title, shorttitle, overlay }（注意返回值里 shorttitle 全小写）, plots: { plot0: [{ time, value }, ...] } }；
- plots 的每个键对应 plotConfig 里同 id 的一条线（{ id: "plot0", title, color: "#2962FF", lineWidth }）；每条线的数组必须逐 bar 对齐：每个元素 { time: bars[i].time, value }，预热期（窗口未满）用 NaN 占位，不要缺元素、不要用 null、不要自己造时间；
- 可选静态水平线：hlineConfig: [{ id, price, title?, color?, linestyle?, linewidth? }]；动态水平线由 calculate 返回 hlines: [{ value, options: { title?, color?, linestyle?, linewidth? } }]，依次得到 id hline0、hline1……。静态与动态线会合并，动态同 id 覆盖静态；fillConfig 或动态 fills 可引用这些 id；
- 两条 plot 之间填充：fillConfig 或 calculate 返回 fills: [{ plot1: "plot0", plot2: "plot1", options: { color }, colors?: [...] }]；colors 可逐 bar 变色；
- 逐 bar 背景色与 K 线着色：calculate 分别返回 bgColors: [{ time, color }]、barColors: [{ time, color }]，time 必须来自对应 bar；
- markers 是指标代码自行定义的图表标记，插件不生成、审核、验证或背书其含义。aboveBar/belowBar/inBar 依附主图 K 线；副图数值标记使用 { time, position: "atPriceMiddle", price, shape: "circle", color }，price 取该副图的数值，不能用 aboveBar/belowBar 代替；
- 更多输出形态（plotCandles/plotBars/lines/boxes 等）插件已支持透传，但优先用最简单的 plots；
- 文件里注入了一个名为 oak 的全局对象（oakscriptjs 库的精选 API），直接用，不要 import：oak.Series（惰性时间序列：const closes = new oak.Series(bars, b => b.close)，.toArray() 取出数组）、oak.ta（指标函数：sma/ema/rma/rsi/macd/highest/lowest/stdev/crossover/crossunder 等，接收 Series 返回 Series）、oak.taCore、oak.math（abs/max/min/round/sqrt 等）、oak.getSourceSeries、oak.compare、oak.color、oak.na/oak.nz/oak.fixnan（缺失值工具）。API 细节可查 oakscriptjs 的文档/源码（npm: oakscriptjs）。

合规红线（必须遵守）：
- 指标文件必须是纯计算：禁止 require/import、禁止网络请求（fetch/XMLHttpRequest/requestUrl）、禁止 DOM/BOM 访问（document/window）、禁止 Obsidian API（app/vault）；唯一可用的外部能力是注入的 oak；
- 一个文件只定义一个指标；插件不内置指标，指标 id 由文件名 slug 决定；
- calculate 必须是纯函数：同样的 bars + inputs 必须返回同样的结果，不读写外部状态。
- 只改编你原创、已获授权或许可证允许改编的代码；保留许可证要求的版权与许可声明，不要规避付费、闭源或限制改编条款。

移植指南（仅适用于你有权改编的 Pine Script 或开源指标 → 本契约）：
- indicator()/study() 的 title/shorttitle/overlay → metadata；
- input.int/input.float/input.bool/input.string/input.source/input.color → inputConfig 条目（minval/maxval/step → min/max/step，options 列表 → options）+ defaultInputs；
- ta.sma/ta.ema/ta.rsi/... → oak.ta.sma/oak.ta.ema/oak.ta.rsi/...（先建 oak.Series，结果再 .toArray()）；Pine 的 close/open/high/low/volume → new oak.Series(bars, b => b.close) 等；
- plot(x, title, color, linewidth) → plotConfig 加一条 { id, title, color, lineWidth }，plots 返回同 id 的数组；hline(price) → hlineConfig；fill(plot1, plot2) → fillConfig；
- Pine 的历史引用 close[1] → 数组索引 closeArr[i-1]（注意 i-1 < 0 时输出 NaN）；na/nz/fixnan → oak.na/oak.nz/oak.fixnan；
- 使用开源实现时，先核对其许可证与具体文件的版权声明，并按许可证保留必要声明。

最小示例（副图乖离率，可整文件照抄再改）：

module.exports = {
  metadata: { title: "Bias Ratio", shortTitle: "BIAS", overlay: false },
  inputConfig: [{ id: "length", type: "int", title: "周期", defval: 20, min: 1 }],
  defaultInputs: { length: 20 },
  plotConfig: [{ id: "plot0", title: "BIAS", color: "#2962FF", lineWidth: 1 }],
  calculate(bars, inputs) {
    const length = Number(inputs.length) || 20;
    const closes = new oak.Series(bars, (b) => b.close).toArray();
    const sma = oak.ta.sma(new oak.Series(bars, (b) => b.close), length).toArray();
    const plot0 = bars.map((bar, i) => {
      const ma = sma[i];
      const value = ma != null && ma !== 0 ? ((closes[i] - ma) / ma) * 100 : NaN;
      return { time: bar.time, value };
    });
    return { metadata: { title: "Bias Ratio", shorttitle: "BIAS", overlay: false }, plots: { plot0 } };
  },
};

交付前自检清单：
1. 文件能作为 CJS 模块执行：只有 module.exports 赋值，无 import/require；
2. module.exports 含 metadata/inputConfig/defaultInputs/calculate 四个必填字段，plotConfig 的 id 与 plots 的键一一对应；
3. 返回的每条线长度 == bars.length，time 逐一对齐 bars[i].time，预热段是 NaN 不是 0 或 null；
4. 全程只用了 oak，没有网络/DOM/Obsidian 调用；
5. overlay 设置正确：叠在 K 线上的（均线、布林带类）用 true，独立数值轴的（震荡、动量类）用 false；
6. 已核对数据源成交量单位（A 股通常为股，KVO 等成交量指标数值可能很大），并按所用参考代码许可证保留版权与许可声明。`;
