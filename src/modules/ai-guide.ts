// The card-authoring guide for external AI agents. Rendered copy-ready in
// 设置 → 外部 AI 接入 and served by the MCP get_card_guide tool — it is NOT
// written into the vault. renderAiGuide fills the entry-point path
// placeholders with the deployed plugin dir.
// The example blocks below are REAL card fences: if the guide is pasted into
// a vault note, the plugin renders them as live demo cards.

// Used by settings.ts (外部 AI 接入 tab) and the MCP get_card_guide tool.
export function renderAiGuide(pluginDir: string): string {
  return AI_GUIDE_MARKDOWN
    .replaceAll("{{CLI_PATH}}", `${pluginDir}/cli.js`)
    .replaceAll("{{MCP_SERVER_PATH}}", `${pluginDir}/mcp-server.js`);
}

export const AI_GUIDE_MARKDOWN = `# StrataBoard 卡片编写指南（供 AI 使用）

> 本指南由 StrataBoard 插件生成（设置 → 外部 AI 接入 / MCP get_card_guide 工具）。

这个 Obsidian vault 安装了 **StrataBoard** 插件：在任意 Markdown 笔记里写一个特定语言的围栏代码块（fenced code block），插件就会把它渲染成金融数据卡片（K 线图、折线图、宏观序列、叠加对比、计算序列、TradingView 小组件、日历）。块内容是 YAML，下方给出每种类型的完整字段和可直接使用的示例。

## 一、先查再写：CLI 工具

插件目录里有一个纯 Node 命令行工具（Node 18+，不需要启动 Obsidian）：

\`\`\`
node "{{CLI_PATH}}" <命令>
\`\`\`

所有命令向 **stdout 输出 JSON**；失败时向 stderr 输出 \`{"ok": false, "error": "..."}\` 且退出码非 0。通用参数 \`--vault <路径>\` 指定 vault 根目录；缺省时 CLI 从当前工作目录向上查找含 \`.obsidian\` 的目录。

| 命令 | 用途 | 示例 |
| --- | --- | --- |
| \`search <关键词> [--type 类型] [--limit N]\` | 搜索符号代码（本地代码库 + 自定义源静态代码表），按相关度排序 | \`node "{{CLI_PATH}}" search 茅台\` |
| \`sources\` | 列出全部自定义数据源（id/名称/格式/是否启用/是否脚本产物） | \`node "{{CLI_PATH}}" sources\` |
| \`macro [--query 关键词]\` | 列出可用的 Tushare 宏观序列（seriesId/名称/频率/所需积分） | \`node "{{CLI_PATH}}" macro --query cpi\` |
| \`validate <文件\\|->\` | 校验一个 Markdown 文件里的全部 StrataBoard 卡片块，任一失败退出码 1 | \`node "{{CLI_PATH}}" validate 笔记.md\` |
| \`probe <代码> [--type 类型] [--days N]\` | 探测某代码最近 N 天是否真有数据（真实调用数据接口） | \`node "{{CLI_PATH}}" probe 600519.SH --type stock\` |
| \`probe-fred <seriesId> [--days N]\` | 探测某 FRED 系列是否有观测值 | \`node "{{CLI_PATH}}" probe-fred SP500\` |

## 二、写作工作流（务必遵守）

1. **先 search 确认代码**：不要凭记忆猜代码。如 \`search 茅台\` 返回 \`600519.SH\`，再用它写卡片。
2. **嵌入卡片块**：把对应类型的围栏代码块写进 Markdown。
3. **validate 整篇自检**：写完后对文件跑 \`validate\`，退出码非 0 时按错误信息修正。
4. **拿不准就 probe**：search 里没有的代码，用 \`probe\` / \`probe-fred\` 确认是否真有数据；确认没有就放弃或改用公开网络数据，并在文中注明来源。

## 三、资产类型与代码格式

| 类型 | 说明 | 代码示例 |
| --- | --- | --- |
| \`stock\` | A 股 | \`600519.SH\`（后缀 .SH/.SZ/.BJ） |
| \`fund\` | 场内基金（ETF/LOF） | \`510300.SH\` |
| \`ofund\` | 场外基金（净值，永远画折线） | \`110022.OF\` |
| \`index\` | 国内指数 | \`000001.SH\` |
| \`nhindex\` | 南华期货指数 | \`NHCI\`（裸代码，无后缀） |
| \`hk\` | 港股 | \`00700.HK\` |
| \`gbindex\` | 全球指数 | \`SPX\`、\`HSI\`（裸代码，无后缀） |
| \`cb\` | 可转债（仅限存续） | \`113050.SH\` |
| \`fut\` | 期货合约 | \`CU2405.SHF\` |
| \`fx\` | 外汇（FXCM 货币对，bid 侧） | \`EURUSD.FXCM\` |
| \`sw\` | 申万行业指数 | \`801010.SI\` |
| \`custom\` | 用户自定义数据源 | 代码格式由源定义；必须另写 \`数据源\` 字段，id 用 \`sources\` 命令查看 |

## 四、卡片块类型

### 1. \`\`\`tushare — 资产行情卡（K 线 / 折线）

字段（中文键）：

- \`代码\`（必填）、\`类型\`（见上表，默认 stock）、\`数据源\`（类型为 custom 时必填）
- \`周期\`：\`D\`|\`W\`|\`M\`，默认 D；\`范围\`：\`1y\`|\`3y\`|\`5y\`|\`ytd\`|\`max\` 或 \`yyyy-mm-dd~yyyy-mm-dd\`，默认 1y
- \`高度\`：px，200–1600，默认 400；\`图表类型\`：\`candlestick\`|\`line\`（ofund 用 line）
- \`主题\`：\`auto\`|\`dark\`|\`light\`；\`涨色\`/\`跌色\`：\`#rrggbb\`
- \`显示标题\`/\`显示市场数据\`/\`显示成交量\`/\`对数坐标\`：true/false
- \`均线\`：如 \`[5, 10, 20, 60]\`（单位永远是交易日）
- \`面板比例\`：如 \`[2, 1]\`；\`宽度自适应\`/\`高度自适应\`/\`出血\`：画布布局，一般不用写
- \`可见范围\`：\`1m\`|\`3m\`|\`6m\`|\`1y\`|\`ytd\`|\`max\`；\`可见起点\`/\`可见终点\`：YYYY-MM-DD（插件在缩放后自动维护，手写时可省略）

示例（下面这个块在本笔记里就是一张真实卡片）：

\`\`\`tushare
代码: 600519.SH
类型: stock
周期: D
范围: 1y
版本: 1
高度: 400
均线: [20, 60]
\`\`\`

### 2. \`\`\`fred — FRED 数据卡（美国宏观）

字段（英文键）：\`seriesId\`（必填，如 \`SP500\`、\`DGS10\`、\`UNRATE\`）、\`label\`、\`units\`、\`frequency\`、\`transform\`（服务端变换：\`chg\`|\`ch1\`|\`pch\`|\`pc1\`|\`pca\`|\`cch\`|\`cca\`|\`log\`，不写 = 原始值）、\`range\`（默认 10y，可用 1y/3y/5y/10y/20y/ytd/max 或日期区间）、\`period\`（\`D\`|\`M\`|\`Q\`|\`Y\` 重采样粒度，默认 D）、\`height\`。

\`\`\`fred
seriesId: SP500
label: S&P 500
range: 5y
height: 360
\`\`\`

### 3. \`\`\`macro — 中国宏观数据卡（Tushare）

字段（英文键）：\`seriesId\`（必填，必须是目录里的宏观序列 id——先用 \`macro\` 命令查，如 \`cpi_yoy\`、\`m2_yoy\`、\`lpr_1y\`、\`shibor_3m\`、\`hsgt_north\`、\`cgb_10y\`、\`pmi\`）、\`range\`、\`period\`、\`height\`。

\`\`\`macro
seriesId: cpi_yoy
range: 10y
height: 360
\`\`\`

### 4. \`\`\`overlay — 资产叠加卡（多系列对比）

字段（英文键）：

- \`series\`（必填，1–10 条），每条：
  - \`source\`：\`quote\`|\`macro\`|\`fred\`|\`card\`
  - quote：\`tsCode\` + \`assetType\`（custom 时另加 \`sourceId\`）
  - macro / fred：\`seriesId\`（fred 可加 \`transform\`）
  - card：\`cardPath\`（引用卡片库中已有卡片的 vault 相对路径，仅限 tushare/fred/macro/spread 卡）
  - \`label\`：显示名覆盖（可选）；\`scale\`：视觉缩放系数（仅叠加卡可用，可选）
- \`range\`（默认 10y）、\`period\`、\`height\`、\`theme\`
- \`normalize\`：\`percent\`（默认，各线按首点归一为涨跌幅）|\`zscore\`（标准化）|\`axis\`（各自独立纵轴）|\`none\`（原始值同轴）

\`\`\`overlay
series:
  - source: quote
    tsCode: 600519.SH
    assetType: stock
  - source: quote
    tsCode: 000300.SH
    assetType: index
    label: 沪深300
range: 3y
normalize: percent
height: 400
\`\`\`

### 5. \`\`\`spread — 数据计算卡（四则运算）

对字母标记的系列做算术：series[0] 是 A，series[1] 是 B……支持 \`+\` \`-\` \`*\` \`/\` \`()\` 和数字。字段同 overlay，但**不支持** \`normalize\` 和 \`scale\`，另有 \`expression\`（必填）、\`lineWidth\`（1–4）、\`lineColor\`（\`#rrggbb\`）。

\`\`\`spread
series:
  - source: fred
    seriesId: DGS10
  - source: fred
    seriesId: DGS2
expression: A-B
range: 10y
height: 360
\`\`\`

### 6. \`\`\`financial-widget — TradingView / HTML 小组件卡

字段（中文键）：\`小组件类型\`（\`iframe\`|\`html\`）、\`iframe地址\` 或 \`小组件HTML\`（二选一必填，HTML 按原样嵌入）、\`小组件标题\`、\`高度\`。

\`\`\`financial-widget
小组件类型: iframe
iframe地址: https://www.tradingview.com/widgetembed/?symbol=NASDAQ:AAPL
小组件标题: Apple
高度: 400
\`\`\`

### 7. \`\`\`calendar — 日历卡（联动日记）

字段（中文键）：\`日历: true\`（必填标记）、\`月份\`（YYYY-MM，可选，默认当月）、\`高度\`。

\`\`\`calendar
日历: true
高度: 400
\`\`\`

## 五、图表显示覆盖（可选，不写则跟随插件全局设置）

- \`\`\`tushare 卡用中文键：\`显示图例\` / \`图例半透明\` / \`图例透明度\`（0–100）/ \`显示均线\` / \`显示网格\` / \`网格透明度\`（0–100）。
- \`\`\`overlay / \`\`\`spread / \`\`\`fred / \`\`\`macro 卡用英文键：\`showLegend\` / \`legendFrosted\` / \`legendOpacity\`（0–100）/ \`showLatestValue\` / \`showPointMarkers\` / \`showGrid\` / \`gridOpacity\`（0–100）。

## 六、MCP 接入（可选）

插件目录里还有一个 MCP stdio server：\`mcp-server.js\`（和 CLI 能力等价，二选一）。支持 MCP 的 AI 客户端（Claude Code、Hermes 等）可直接配置：

\`\`\`json
{
  "mcpServers": {
    "strataboard": {
      "command": "node",
      "args": ["{{MCP_SERVER_PATH}}"],
      "env": { "STRATABOARD_VAULT": "<vault 根目录的绝对路径>" }
    }
  }
}
\`\`\`

也可以用 \`--vault <路径>\` 参数代替环境变量。提供的工具：\`search_symbols\`、\`list_sources\`、\`list_macro_series\`、\`validate_cards\`（入参直接是 Markdown 文本）、\`probe_data\`、\`probe_fred\`、\`get_card_guide\`（返回本指南）。

## 七、合规红线

只使用本插件已配置的数据源（Tushare、FRED、用户自定义源）获取数据；**不要高频、批量抓取**，不要试图绕过积分/权限限制。数据准确性不作保证，分析结论请自行核验。
`;
