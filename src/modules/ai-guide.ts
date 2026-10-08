// The card-authoring guide for external AI agents. Rendered copy-ready in
// 设置 → AI 辅助 and served by the MCP get_card_guide tool — it is NOT
// written into the vault. renderAiGuide fills the CLI path placeholder: the
// MCP server passes its own deployed dir, while the settings tab passes a
// placeholder so no machine-local path is shown. The example blocks below
// are REAL card fences: if the guide is pasted into a vault note, the plugin
// renders them as live demo cards.

// Used by settings.ts (AI 辅助 tab) and the MCP get_card_guide tool.
export function renderAiGuide(pluginDir: string): string {
  return AI_GUIDE_MARKDOWN.replaceAll("{{CLI_PATH}}", `${pluginDir}/cli.js`);
}

export const AI_GUIDE_MARKDOWN = `# StrataBoard 卡片编写指南（供 AI 使用）

> 本指南由 StrataBoard 插件生成（设置 → AI 辅助 / MCP get_card_guide 工具）。

这个 vault 安装了 **StrataBoard** 插件：在 Markdown 笔记里写特定语言的围栏代码块（fenced code block），插件就把它渲染成金融数据卡片（K 线/折线、叠加对比、计算序列、TradingView 小组件、日历）。块内容是 YAML。

卡片数据全部来自用户在设置页配置的「自定义数据源」（卡片的资产类型恒为 \`custom\`）。写卡片前先用 \`sources\` 确认已有哪些源；一个都没有时，让用户先配置数据源（插件设置 → AI 辅助 →「提示词：添加数据源」），不要凭空写卡片。

## 一、先查再写：CLI 工具

插件目录里有纯 Node 命令行工具（Node 18+，无需启动 Obsidian）：

\`\`\`
node "{{CLI_PATH}}" <命令>
\`\`\`

所有命令向 **stdout 输出 JSON**；失败时向 stderr 输出 \`{"ok": false, "error": "..."}\` 且退出码非 0。通用参数 \`--vault <路径>\` 指定 vault 根目录，缺省时从当前目录向上查找含 \`.obsidian\` 的目录。

| 命令 | 用途 | 示例 |
| --- | --- | --- |
| \`sources\` | 列出全部自定义数据源（id/名称/格式/是否启用） | \`node "{{CLI_PATH}}" sources\` |
| \`search <关键词> [--type 类型] [--limit N]\` | 搜索符号代码（本地代码库 + 源的静态代码表），按相关度排序 | \`node "{{CLI_PATH}}" search 茅台\` |
| \`probe <代码> [--source 数据源id] [--days N]\` | 真实调用数据接口，确认某代码最近 N 天是否真有数据 | \`node "{{CLI_PATH}}" probe 600519.SH --source src-xxx\` |
| \`validate <文件\\|->\` | 校验一篇 Markdown 里的全部卡片块，任一失败退出码 1 | \`node "{{CLI_PATH}}" validate 笔记.md\` |

MCP 客户端用等价工具：\`list_sources\` / \`search_symbols\` / \`probe_data\` / \`validate_cards\`（入参语义相同）。

## 二、写作工作流（务必遵守）

1. **先 sources 再 search**：确认数据源 id 和真实代码，不要凭记忆猜。代码格式由数据源自己定义（如 \`600519.SH\`、\`sh600519\`、\`DGS10\`）。
2. **嵌入卡片块**：把对应类型的围栏代码块写进 Markdown。
3. **validate 自检**：写完后对文件跑 \`validate\`，退出码非 0 时按错误信息修正。
4. **拿不准就 probe**：search 里没有的代码先 probe 确认是否真有数据；确认没有就放弃，并在文中注明。

## 三、卡片块类型

### 1. \`\`\`quote — 资产行情卡（K 线 / 折线）

字段（中文键）：

- \`代码\`（必填）、\`数据源\`（必填，自定义源 id，用 \`sources\` 命令查看）
- \`周期\`：\`D\`|\`W\`|\`M\`|\`Q\`|\`Y\`，默认 D。只支持小级别向大级别聚合：插件按数据自动检测源的原始粒度（标题栏有 日频/周频/月频/季频/年频 徽标），原始粒度更粗时更小的周期无效——卡片底部对应按钮冻结，手写的更小 \`周期\` 按原始粒度展示；\`范围\`：\`1y\`|\`3y\`|\`5y\`|\`ytd\`|\`max\` 或 \`yyyy-mm-dd~yyyy-mm-dd\`，默认 1y
- \`高度\`：px，200–1600，默认 400；\`图表类型\`：\`candlestick\`|\`line\`（单值序列用 line）
- \`主题\`：\`auto\`|\`dark\`|\`light\`；\`涨色\`/\`跌色\`：\`#rrggbb\`
- \`显示标题\`/\`显示成交量\`/\`对数坐标\`：true/false
- \`indicators\`：技术指标实例列表（英文键），每项 \`{id: 指标id, inputs: {参数: 值}}\`，\`inputs\` 可省略（用默认参数）；\`hidden: true\` 可单独隐藏某个指标（保留在列表里但不绘制）。不写该键=跟随全局默认（新卡默认四条均线）；写 \`indicators: []\` = 本卡不显示任何指标。内置指标 id：\`ma\` 均线、\`ema\` 指数均线、\`boll\` 布林带、\`psar\` 抛物线转向、\`supertrend\` 超级趋势、\`ichimoku\` 一目均衡表、\`dmi\` 动向指标、\`macd\`、\`rsi\`、\`kdj\`、\`cci\`、\`willr\` 威廉指标、\`bias\` BIAS乖离率、\`obv\` 能量潮、\`atr\` 平均真实波幅；自定义指标来自指标文件夹的 .js 文件，id 即文件名 slug。均线（ma/ema）的周期永远是交易日：周线/月线等聚合周期上按日线收盘计算后贴合到每根 K 线，其余指标跟随图表周期计算。常用参数：\`ma\`/\`ema\`/\`bias\` 的 \`length\`、\`rsi\` 的 \`length\`、\`boll\` 的 \`length\`+\`mult\`。写自定义指标文件的完整契约见 MCP \`get_indicator_guide\` 工具（或插件设置 → AI 辅助 →「提示词：编写技术指标」）
- \`信号\`：信号源 id（如 \`信号: script:foo\`）或 \`{源: id, 代码: code}\`（\`代码\` 可省略，默认=本卡 \`代码\`）——把脚本产物信号表（CSV：\`date,code,side,text\`，side 为 buy/sell）中该标的的买卖点画成 K 线上的箭头标注；信号源由脚本产物自动注册（\`sources\` 命令输出里 \`purpose: "signals"\` 的条目）
- \`面板比例\`：如 \`[2, 1]\`；\`宽度自适应\`/\`高度自适应\`/\`出血\`：画布布局，一般不用写
- \`可见范围\`：\`1m\`|\`3m\`|\`6m\`|\`1y\`|\`ytd\`|\`max\`；\`可见起点\`/\`可见终点\`：YYYY-MM-DD（插件在缩放后自动维护，手写时可省略）

示例（\`数据源\` 换成 \`sources\` 命令返回的真实 id）：

\`\`\`quote
代码: 600519.SH
数据源: src-XXXX
周期: D
范围: 1y
版本: 1
高度: 400
indicators:
  - id: ma
    inputs: { length: 20 }
  - id: rsi
\`\`\`

### 2. \`\`\`overlay — 资产叠加卡（多系列对比）

字段（英文键）：

- \`series\`（必填，1–10 条），每条：
  - \`source\`：\`quote\`|\`card\`
  - quote：\`tsCode\` + \`assetType: custom\` + \`sourceId\`（自定义源 id）
  - card：\`cardId\`（引用卡片库中已有**计算卡**的稳定 id，即其 YAML 里的 \`id\` 字段；改名/移动卡片文件不影响引用。引用资产卡请直接用 quote 系列——读取该资产卡的 代码/数据源 写成 quote 条目即可）
  - \`label\`：显示名覆盖（可选）；\`scale\`：视觉缩放系数（仅叠加卡可用，可选）
- \`range\`（默认 10y）、\`period\`（\`D\`|\`M\`|\`Q\`|\`Y\` 重采样粒度，默认 D）、\`height\`、\`theme\`
- \`normalize\`：\`percent\`（默认，各线按首点归一为涨跌幅）|\`zscore\`（标准化）|\`axis\`（各自独立纵轴）|\`none\`（原始值同轴）
- 叠加卡不支持信号标注（信号只挂在 quote 卡与 spread 卡上）

\`\`\`overlay
series:
  - source: quote
    tsCode: 600519.SH
    assetType: custom
    sourceId: src-XXXX
  - source: quote
    tsCode: 000300.SH
    assetType: custom
    sourceId: src-XXXX
    label: 沪深300
range: 3y
normalize: percent
height: 400
\`\`\`

### 3. \`\`\`spread — 数据计算卡（四则运算）

对字母标记的系列做算术：series[0] 是 A，series[1] 是 B……支持 \`+\` \`-\` \`*\` \`/\` \`()\` 和数字。字段同 overlay，但**不支持** \`normalize\` 和 \`scale\`，另有 \`expression\`（必填）、\`lineWidth\`（1–4）、\`lineColor\`（\`#rrggbb\`）。\`id\` 字段是卡片的稳定身份（其他卡通过 \`cardId\` 引用它）：新建时不写（插件自动生成），编辑已有卡片时**必须原样保留**。也支持 \`signals\`：信号标注列表，每条 \`{source, code}\`（均必填），所有条目的信号合并标注在计算线上。

\`\`\`spread
series:
  - source: quote
    tsCode: DGS10
    assetType: custom
    sourceId: src-YYYY
  - source: quote
    tsCode: DGS2
    assetType: custom
    sourceId: src-YYYY
expression: A-B
range: 10y
height: 360
\`\`\`

### 4. \`\`\`financial-widget — TradingView / HTML 小组件卡

字段（中文键）：\`小组件类型\`（\`iframe\`|\`html\`）、\`iframe地址\` 或 \`小组件HTML\`（二选一必填，HTML 按原样嵌入）、\`小组件标题\`、\`高度\`。

\`\`\`financial-widget
小组件类型: iframe
iframe地址: https://www.tradingview.com/widgetembed/?symbol=NASDAQ:AAPL
小组件标题: Apple
高度: 400
\`\`\`

### 5. \`\`\`calendar — 日历卡（联动日记）

字段（中文键）：\`日历: true\`（必填标记）、\`月份\`（YYYY-MM，可选，默认当月）、\`高度\`。

\`\`\`calendar
日历: true
高度: 400
\`\`\`

## 四、信号标注（买卖点，来自脚本产物）

插件不在本地计算信号；信号一律来自「本地脚本」的产物信号表：CSV 表头 \`date,code,side,text\`（\`text\` 可省略），一行一个买卖事件，\`side\` 用 \`buy\`/\`sell\`，一个文件可含多个标的（\`code\` 列区分）。脚本放进脚本文件夹、产物写到其 \`output/\` 子目录后，插件自动把它注册为**信号源**（\`sources\` 命令输出里带 \`purpose: "signals"\`，不可作行情数据源）。quote 卡用 \`信号\` 字段（代码默认=本卡标的），spread 卡用 \`signals\` 列表（\`code\` 必填）；overlay 卡不支持信号标注。渲染规则：buy=K 线下方上箭头、sell=上方下箭头；非交易日的事件吸附到前一个 bar。

写信号脚本的完整产物契约与合规规则见 MCP \`get_script_guide\` 工具（或插件设置 → AI 辅助 →「提示词：编写数据处理脚本」）。

## 五、图表显示覆盖（可选，不写则跟随插件全局设置）

- \`\`\`quote 卡用中文键：\`显示图例\` / \`图例半透明\` / \`图例透明度\`（0–100）/ \`显示网格\` / \`网格透明度\`（0–100）。指标不再走显示覆盖，用上文的 \`indicators\` 键。
- \`\`\`overlay / \`\`\`spread 卡用英文键：\`showLegend\` / \`legendFrosted\` / \`legendOpacity\`（0–100）/ \`showLatestValue\` / \`showPointMarkers\` / \`showGrid\` / \`gridOpacity\`（0–100）。
`;
