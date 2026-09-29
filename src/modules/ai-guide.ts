// The card-authoring guide for external AI agents. Rendered copy-ready in
// 设置 → AI 辅助 and served by the MCP get_card_guide tool — it is NOT
// written into the vault. renderAiGuide fills the entry-point path
// placeholders: the MCP server passes its own deployed dir, while the
// settings tab passes a placeholder so no machine-local path is shown.
// The example blocks below are REAL card fences: if the guide is pasted into
// a vault note, the plugin renders them as live demo cards.

// Used by settings.ts (AI 辅助 tab) and the MCP get_card_guide tool.
export function renderAiGuide(pluginDir: string): string {
  return AI_GUIDE_MARKDOWN
    .replaceAll("{{CLI_PATH}}", `${pluginDir}/cli.js`)
    .replaceAll("{{MCP_SERVER_PATH}}", `${pluginDir}/mcp-server.js`);
}

export const AI_GUIDE_MARKDOWN = `# StrataBoard 卡片编写指南（供 AI 使用）

> 本指南由 StrataBoard 插件生成（设置 → AI 辅助 / MCP get_card_guide 工具）。

这个 Obsidian vault 安装了 **StrataBoard** 插件：在任意 Markdown 笔记里写一个特定语言的围栏代码块（fenced code block），插件就会把它渲染成金融数据卡片（K 线/折线图、叠加对比、计算序列、TradingView 小组件、日历）。块内容是 YAML，下方给出每种类型的完整字段和可直接使用的示例。

**重要：插件不内置任何数据源。** 所有数据都来自用户在设置页配置的「自定义数据源」（REST/JSON 接口或 vault 内的 CSV 文件）。写卡片前先用 \`sources\` 命令（或 MCP 的 \`list_sources\` 工具）确认 vault 里已配置哪些源；一个都没有时，先引导用户配置数据源，不要凭空写卡片。

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
| \`validate <文件\\|->\` | 校验一个 Markdown 文件里的全部 StrataBoard 卡片块，任一失败退出码 1 | \`node "{{CLI_PATH}}" validate 笔记.md\` |
| \`probe <代码> [--source 数据源id] [--days N]\` | 探测某代码最近 N 天是否真有数据（真实调用数据接口） | \`node "{{CLI_PATH}}" probe 600519.SH --source src-xxx\` |

## 二、写作工作流（务必遵守）

1. **先 sources 再 search**：先用 \`sources\` 确认可用的数据源 id，再用 \`search\` 确认代码——不要凭记忆猜代码。代码格式由数据源自己定义（如 \`600519.SH\`、\`sh600519\`、\`DGS10\`）。
2. **嵌入卡片块**：把对应类型的围栏代码块写进 Markdown。
3. **validate 整篇自检**：写完后对文件跑 \`validate\`，退出码非 0 时按错误信息修正。
4. **拿不准就 probe**：search 里没有的代码，用 \`probe\` 确认是否真有数据；确认没有就放弃，并在文中注明。

## 三、数据源：自定义源契约

卡片的资产类型恒为 \`custom\`，数据全部来自自定义源。当用户需要你帮忙配置一个新数据源时，插件支持的接入形态如下（插件**不打包任何预设**，以下仅为契约说明与配置示例）：

- \`format\`：\`tencent\` / \`eastmoney\`（常见行情格式，自动识别）/ \`json\`（通用 JSON，需字段映射）/ \`csv\`（vault 内 CSV 文件）。
- \`method\`：\`GET\`（默认，参数在 URL query）/ \`POST\`。POST 时 \`bodyTemplate\` 为请求体（自动带 \`Content-Type: application/json\`）。
- 占位符（URL 与 bodyTemplate 通用）：\`{code}\` 代码、\`{start}\`/\`{end}\` YYYYMMDD 起止日期、\`{startIso}\`/\`{endIso}\` YYYY-MM-DD 起止日期、\`{apiKey}\` 密钥。
- \`jsonMap\`（format 为 json 时必填）：
  - \`rowsPath\`：数据行数组的点号路径（顶层即数组则空串）；
  - \`rowKind\`：\`object\`（每行是对象，cols 填字段名）/ \`array\`（每行是数组，cols 填从 0 开始的列序号）/ \`fields\`（每行是数组，cols 填**列名**，列名数组在 \`fieldsPath\`，如 \`data.fields\` + \`data.items\` 的两段式响应）；
  - \`cols\`：\`date\`、\`close\` 必填，\`open\`/\`high\`/\`low\`/\`vol\`/\`amount\` 没有则空串（单值序列把数值列填给 close）；
  - \`errorPath\` / \`errorMessagePath\`（可选）：业务错误透传——\`errorPath\` 取值非 0/空/null 时报错，消息取 \`errorMessagePath\`。
- \`transport\`：\`"node"\` 表示改用 Node https（HTTP/1.1）发请求——个别站点（如 api.stlouisfed.org）在 Obsidian 默认网络栈下连接失败时需要。
- 搜索（可选）：\`searchUrl\` 模板（\`{query}\` 占位，GET）或 \`searchBodyTemplate\`（POST 搜索请求体，\`{query}\`/\`{apiKey}\` 占位，URL 取 \`searchUrl\`、未配则复用 \`klineUrl\`）；模板不含 \`{query}\` 表示接口只能整表返回，插件拉回后本地过滤（结果有缓存）。无搜索接口的源配 \`symbols\` 静态代码表（\`[{"code","name"}]\`），插入数据时按名称选择。

配置示例（**仅作文档演示**，让用户把配置 JSON 存为 .json 文件，在 设置 → 数据源设置 → 导入 中选择该文件导入，再自行填入密钥）：

Tushare Pro 日线（POST + fields 映射）：

\`\`\`json
[{
  "name": "Tushare 日线",
  "format": "json",
  "method": "POST",
  "klineUrl": "https://api.tushare.pro",
  "bodyTemplate": "{\\"api_name\\":\\"daily\\",\\"token\\":\\"{apiKey}\\",\\"params\\":{\\"ts_code\\":\\"{code}\\",\\"start_date\\":\\"{start}\\",\\"end_date\\":\\"{end}\\"},\\"fields\\":\\"trade_date,open,high,low,close,vol,amount\\"}",
  "testCode": "600519.SH",
  "jsonMap": {
    "rowsPath": "data.items",
    "rowKind": "fields",
    "fieldsPath": "data.fields",
    "cols": { "date": "trade_date", "open": "open", "high": "high", "low": "low", "close": "close", "vol": "vol", "amount": "amount" },
    "errorPath": "code",
    "errorMessagePath": "msg"
  }
}]
\`\`\`

FRED 序列（GET + node 传输）：

\`\`\`json
[{
  "name": "FRED",
  "format": "json",
  "transport": "node",
  "klineUrl": "https://api.stlouisfed.org/fred/series/observations?series_id={code}&api_key={apiKey}&file_type=json&observation_start={startIso}",
  "testCode": "DGS10",
  "jsonMap": { "rowsPath": "observations", "rowKind": "object", "cols": { "date": "date", "close": "value" } }
}]
\`\`\`

## 四、卡片块类型

### 1. \`\`\`quote — 资产行情卡（K 线 / 折线）

字段（中文键）：

- \`代码\`（必填）、\`数据源\`（必填，自定义源 id，用 \`sources\` 命令查看）
- \`周期\`：\`D\`|\`W\`|\`M\`，默认 D；\`范围\`：\`1y\`|\`3y\`|\`5y\`|\`ytd\`|\`max\` 或 \`yyyy-mm-dd~yyyy-mm-dd\`，默认 1y
- \`高度\`：px，200–1600，默认 400；\`图表类型\`：\`candlestick\`|\`line\`（单值序列用 line）
- \`主题\`：\`auto\`|\`dark\`|\`light\`；\`涨色\`/\`跌色\`：\`#rrggbb\`
- \`显示标题\`/\`显示成交量\`/\`对数坐标\`：true/false
- \`均线\`：如 \`[5, 10, 20, 60]\`（单位永远是交易日）
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
均线: [20, 60]
\`\`\`

### 2. \`\`\`overlay — 资产叠加卡（多系列对比）

字段（英文键）：

- \`series\`（必填，1–10 条），每条：
  - \`source\`：\`quote\`|\`card\`
  - quote：\`tsCode\` + \`assetType: custom\` + \`sourceId\`（自定义源 id）
  - card：\`cardPath\`（引用卡片库中已有卡片的 vault 相对路径，仅限 quote/spread 卡）
  - \`label\`：显示名覆盖（可选）；\`scale\`：视觉缩放系数（仅叠加卡可用，可选）
- \`range\`（默认 10y）、\`period\`（\`D\`|\`M\`|\`Q\`|\`Y\` 重采样粒度，默认 D）、\`height\`、\`theme\`
- \`normalize\`：\`percent\`（默认，各线按首点归一为涨跌幅）|\`zscore\`（标准化）|\`axis\`（各自独立纵轴）|\`none\`（原始值同轴）

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

对字母标记的系列做算术：series[0] 是 A，series[1] 是 B……支持 \`+\` \`-\` \`*\` \`/\` \`()\` 和数字。字段同 overlay，但**不支持** \`normalize\` 和 \`scale\`，另有 \`expression\`（必填）、\`lineWidth\`（1–4）、\`lineColor\`（\`#rrggbb\`）。

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

## 五、图表显示覆盖（可选，不写则跟随插件全局设置）

- \`\`\`quote 卡用中文键：\`显示图例\` / \`图例半透明\` / \`图例透明度\`（0–100）/ \`显示均线\` / \`显示网格\` / \`网格透明度\`（0–100）。
- \`\`\`overlay / \`\`\`spread 卡用英文键：\`showLegend\` / \`legendFrosted\` / \`legendOpacity\`（0–100）/ \`showLatestValue\` / \`showPointMarkers\` / \`showGrid\` / \`gridOpacity\`（0–100）。

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

也可以用 \`--vault <路径>\` 参数代替环境变量。提供的工具：\`search_symbols\`、\`list_sources\`、\`validate_cards\`（入参直接是 Markdown 文本）、\`probe_data\`、\`get_card_guide\`（返回本指南）。

## 七、合规红线

本插件不内置任何数据源，仅作为数据接入框架和展示工具：所有接口地址、参数与凭据均由用户自行配置，数据获取行为的合规性由用户自行负责。你帮用户配置数据源时，优先官方或有公开文档的 API，不使用未公开文档的抓取端点；**不要高频、批量抓取**，不要试图绕过积分/权限限制。数据准确性不作保证，分析结论请自行核验。
`;
