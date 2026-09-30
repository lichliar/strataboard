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
| \`validate-config <文件>\` | 导入前验证数据源配置 JSON：逐源结构校验 + 对 testCode/全部 symbols 实测取数（默认 400 天窗口，\`--days\` 覆盖；干净 0 行自动加宽到约 10 年复核一次以区分退市与配置错误）+ 搜索模板试发（查询词取自源自己的 testCode/symbols；模板含 \`{p.*}\` 时加测一个搜索结果代码，\`via="search"\`；配了 \`codeRules\`/端点 \`profile\` 声明的源附接线审计（\`search.audit\`：未命中形态/规则重叠/声明冲突 + 按档位抽样实测）；翻页截断默认判失败（配 \`allowTruncated: true\` 豁免为警告），\`deadCodes\` 命中的代码跳过探测不判红）。密钥解析：文件内（含同组回落）→ \`--api-key\` 注入 → vault 同名/同组已配源；\`--structural-only\` 只校验不发请求 | \`node "{{CLI_PATH}}" validate-config 数据源配置.json\` |

## 二、写作工作流（务必遵守）

1. **先 sources 再 search**：先用 \`sources\` 确认可用的数据源 id，再用 \`search\` 确认代码——不要凭记忆猜代码。代码格式由数据源自己定义（如 \`600519.SH\`、\`sh600519\`、\`DGS10\`）。
2. **嵌入卡片块**：把对应类型的围栏代码块写进 Markdown。
3. **validate 整篇自检**：写完后对文件跑 \`validate\`，退出码非 0 时按错误信息修正。
4. **拿不准就 probe**：search 里没有的代码，用 \`probe\` 确认是否真有数据；确认没有就放弃，并在文中注明。

## 三、数据源：自定义源契约

卡片的资产类型恒为 \`custom\`，数据全部来自自定义源。当用户需要你帮忙配置一个新数据源时，插件支持的接入形态如下（插件**不打包任何预设**，以下仅为契约说明与配置示例）：

- \`format\`：\`tencent\` / \`eastmoney\`（常见行情格式，自动识别）/ \`json\`（通用 JSON，需字段映射）/ \`csv\`（vault 内 CSV 文件，或填 \`klineUrl\` 指向远程 CSV/TSV——两者二选一）。
- \`method\`：\`GET\`（默认，参数在 URL query）/ \`POST\`。POST 时 \`bodyTemplate\` 为请求体（自动带 \`Content-Type: application/json\`；配 \`bodyEncoding: "form"\` 则按表单编码发送，占位符值 URL 编码、自动带 \`Content-Type: application/x-www-form-urlencoded\`）。可选 \`headers\` 配任意静态请求头（值可用 \`{apiKey}\` 占位，与鉴权 Header \`apiKeyHeader\` 并存、同名时鉴权 Header 优先）。请求默认 30 秒超时，网络错误/超时自动重试一次（HTTP 状态错误不重试）。
- 占位符（URL 与 bodyTemplate 通用，字段映射 \`cols\` 的值里也可用 \`{code}\`/\`{p.*}\`）：\`{code}\` 代码、\`{start}\`/\`{end}\` YYYYMMDD 起止日期、\`{startIso}\`/\`{endIso}\` YYYY-MM-DD 起止日期、\`{startTs}\`/\`{endTs}\` 秒级 Unix 时间戳起止、\`{apiKey}\` 密钥、\`{p.<变量名>}\` 符号级参数（取值顺序：被请求代码在 symbols 代码表里的 \`params\` → 该代码 \`profile\` 指向的源级档位 \`profiles\` →（代码不在代码表时）该代码搜索来源端点声明的 \`profile\` 档位（选中搜索结果时插件会把端点声明记进本地代码库）→ 没有声明时 \`codeRules\` 第一条 \`match\` 正则命中的档位 → 源级默认 \`params\` → 都没有则本地报错，不会把 \`{p.*}\` 字面量发给服务器）、\`{offset}\` 翻页偏移（配了 \`paginate\`/\`searchPaginate\` 的端点用）。请求体里的占位符一律不做 URL 编码；请求体是 JSON 时，取值为空串的 \`{p.*}\` 会把该键整个删掉（合并源里某接口要省略可选/范围参数就靠它），非 JSON 请求体保持空串。
- \`jsonMap\`（format 为 json 时必填）：
  - \`rowsPath\`：数据行数组的点号路径（顶层即数组则空串）；
  - \`rowKind\`：\`object\`（每行是对象，cols 填字段名，支持点号路径取嵌套字段如 \`quote.close\`）/ \`array\`（每行是数组，cols 填从 0 开始的列序号）/ \`fields\`（每行是数组，cols 填**列名**，列名数组在 \`fieldsPath\`，如 \`data.fields\` + \`data.items\` 的两段式响应）/ \`map\`（rowsPath 是以日期为键的对象，cols.date 填 \`$key\` 取键名，标量值列填 \`$value\`）/ \`columns\`（rowsPath 是列式平行数组对象，cols 每个值填该列数组相对 rowsPath 的路径，标量列视为单行序列）；
  - \`cols\`：\`date\`、\`close\` 必填，\`open\`/\`high\`/\`low\`/\`vol\`/\`amount\` 没有则空串（单值序列把数值列填给 close；\`date\` 列支持 ISO 日期时间、YYYYMMDD、时间戳、YYYYMM 月频（如 202409，快照到当月最后一天）、YYYYQn 季频（如 2024Q4，快照到季末最后一天））。数值列自动清洗千分位、货币符（$€£¥）与首尾空白，尾部 \`%\` 按 \`percentScale\` 缩放（默认 1 保持字面数，100 使 "1.5%" → 0.015）；close 为 null/空串的行会被跳过——缺失值不会被当作 0（vol/amount 缺失记 0 是有意语义）；
  - \`errorPath\` / \`errorMessagePath\`（可选）：业务错误透传——\`errorPath\` 取值非 0/空/null 时报错，消息取 \`errorMessagePath\`；接口用 200、"ok" 等表示成功时，加 \`okValues\` 成功值白名单（如 \`"okValues": [200]\`）。
- \`transport\`：\`"node"\` 表示改用 Node https（HTTP/1.1）发请求——个别站点（如 api.stlouisfed.org）在 Obsidian 默认网络栈下连接失败时需要；只支持 https，明文 http 的自建/内网服务用默认传输（去掉 \`transport\`）。
- \`paginate\`（可选，源级）：K 线翻页 \`{"pageSize": 正整数, "maxPages": 可选默认 20, "totalPath": 可选，响应里声明总数的点号路径, "allowTruncated": 可选}\`——模板需含 \`{offset}\` 占位符，自动翻页直到某页返回不足 pageSize 行；触顶 maxPages 或 totalPath 声明总数大于实取数时视为截断：validate-config 探测直接判失败，确认可接受时加 \`"allowTruncated": true\` 显式豁免（降级为警告）。
- 搜索（可选）：\`searchUrl\` 模板（\`{query}\` 占位，GET）或 \`searchBodyTemplate\`（POST 搜索请求体，\`{query}\`/\`{apiKey}\` 占位，URL 取 \`searchUrl\`、未配则复用 \`klineUrl\`）；模板不含 \`{query}\` 表示接口只能整表返回，插件拉回后本地过滤（结果有缓存）。主搜索端点被服务端限制单页行数时配源级 \`searchPaginate\`（\`{"pageSize": 正整数, "maxPages": 可选默认 20, "totalPath": 可选, "allowTruncated": 可选}\`，模板需含 \`{offset}\`）；主端点返回的代码属于同一类别时配源级 \`searchProfile\` 声明其档位（选中结果时记入本地代码库，取数优先于 \`codeRules\`）。无搜索接口的源配 \`symbols\` 静态代码表（\`[{"code","name","profile","params"]}\`，\`profile\`/\`params\` 可选），插入数据时按名称选择。
- \`group\`（可选）：数据源分组名。同组的源在插入菜单/统一搜索里折叠为一个分组入口并联合搜索；同组只需任意一个启用条目填 \`apiKey\`，其余留空即自动复用（运行时生效，不随配置导出）。同一平台拆出的多个条目填同一个平台名（如 \`"Tushare"\`）。
- \`searches\`（可选）：额外搜索端点数组 \`[{"url","bodyTemplate","profile","searchRowsPath","searchCols","paginate","enabled"}]\`——url 缺省复用 \`klineUrl\`，有 bodyTemplate 即 POST；\`profile\` 可选，声明该端点返回代码的类别档位（选中结果时记入本地代码库，取数优先于 \`codeRules\`）；默认与主 \`searchUrl\`/\`searchBodyTemplate\` 共享 \`searchRowsPath\`/\`searchCols\` 映射，某接口返回结构不同（如列名不叫 name）时在该端点里单独配 \`searchRowsPath\`/\`searchCols\` 覆盖；\`paginate\`（\`{"pageSize": 正整数, "maxPages": 可选，默认 20, "totalPath": 可选, "allowTruncated": 可选}\`）配合模板里的 \`{offset}\` 占位符自动翻页（某页返回不足 pageSize 行即停；触顶 maxPages 或实取数少于 totalPath 声明总数时视为截断，validate-config 判搜索不通过，配 \`allowTruncated: true\` 豁免为警告），被服务端限制单页行数的整表接口用它；\`enabled\` 为 false 跳过该端点。所有启用的端点都发一次、结果按代码合并去重（声明了 profile 的端点优先于未声明的重复项）。一个源覆盖多个接口时用它保住搜索覆盖面（如一个 Tushare 源同时挂 stock_basic/index_basic/fut_basic 多个代码表接口）。
- 复合代码 \`urlCode@mapCode\`：固定报表宽表（一个 URL 返回整张表、每列一个序列）选列用——\`@\` 前半填进 URL/请求体模板的 \`{code}\`，\`@\` 后半只替换 \`jsonMap.cols\` 里的 \`{code}\`（如 LPR 宽表配 symbols 代码 \`"LPR_1Y@1y"\`），且仅当 cols 含 \`{code}\` 时才生效；不带 \`@\` 的普通代码同时填两处。\`@\` 只承担这一种语义——「同代码不同参数」的多个序列（如 DGS10 的 lin/pc1 两种单位）请用符号级 \`params\`/\`profile\` 表达，不要拿 \`@\` 当去重后缀。
- 符号级参数 \`params\` 与档位 \`profiles\`：symbols 代码表每条可带 \`"params": {"变量名":"值"}\`，取该代码时自动填充模板与 \`cols\` 里的 \`{p.变量名}\`——同一平台只是「接口名/指标名」或「列名」不同（如 Tushare 的 api_name、外汇的 bid_close、宏观的 month/quarter 日期列）时靠它合并成一个源，而不是按接口拆源。多个符号共用同一份参数组合时，在源级 \`profiles\` 定义档位（\`{"档位名": {"变量名":"值"}}\`），symbols 条目带 \`"profile": "档位名"\` 引用，不必逐条重复。源级还有一个默认 \`params\` 字段：档位覆盖它、符号条目的 \`params\` 再逐键覆盖档位；**模板含 \`{p.*}\` 且配了远程搜索时必须配源级默认**——搜索挑出来的代码不在代码表里，只能靠它取值。
- \`codeRules\`（可选）：代码形态规则 \`[{"match": "正则", "profile": "档位名"}]\`，只对**不在 symbols 代码表里**的代码生效（如搜索发现的指数/基金/转债——它们永远进不了静态代码表）：对代码（复合代码取 \`@\` 前半）按序匹配，第一条命中的规则把对应档位并入源级默认 \`params\` 之上。只要非默认类别的代码形态能用正则区分（如指数都以 IDX 开头），就该配它——否则这类代码拿源级默认接口取数，只会得到「成功但 0 行」。端点声明的 \`profile\` 优先于 \`codeRules\`（有声明用声明，没声明才用正则）。形态不可正则区分的混合表，仍用 symbols 逐条 \`params\` 兜底。
- 接线审计与 \`deadCodes\`（可选）：配了 \`codeRules\`/\`searchProfile\`/searches 端点 \`profile\` 的源，\`validate-config\` 会对搜索到的代码做接线审计（结果在 \`search.audit\`：未命中任何规则的形态清单 \`unmatchedTop\`、同时命中多条规则的重叠 \`overlaps\`、端点声明与规则命中不一致的冲突 \`conflicts\`），并按档位抽样 1 个代码实发请求验证——审计警告要逐条处理（补规则/修声明），不要无视。平台上已知取不到行情的代码（已退市、接口明确不覆盖的族）配源级 \`deadCodes\` 正则列表（如 \`["^395"]\`）：\`validate-config\` 跳过它们的探测、不判红，搜索结果里标注「已知无行情」但不剔除。

配置示例（**仅作文档演示**，让用户把配置 JSON 存为 .json 文件，先用 \`validate-config\` 验证通过，再在 设置 → 数据源设置 → 导入 中选择该文件导入，再自行填入密钥）：

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

也可以用 \`--vault <路径>\` 参数代替环境变量。提供的工具：\`search_symbols\`、\`list_sources\`、\`validate_cards\`（入参直接是 Markdown 文本）、\`probe_data\`、\`validate_config\`（导入前验证数据源配置 JSON 文件）、\`get_card_guide\`（返回本指南）。

## 七、合规红线

本插件不内置任何数据源，仅作为数据接入框架和展示工具：所有接口地址、参数与凭据均由用户自行配置，数据获取行为的合规性由用户自行负责。你帮用户配置数据源时，优先官方或有公开文档的 API，不使用未公开文档的抓取端点；**不要高频、批量抓取**，不要试图绕过积分/权限限制。数据准确性不作保证，分析结论请自行核验。
`;
