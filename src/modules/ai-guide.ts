// The card-authoring guide for external AI agents. Rendered copy-ready in
// 设置 → AI 助手 and served by the MCP get_card_guide tool — it is NOT
// written into the vault. renderAiGuide fills the CLI path placeholder: the
// MCP server passes its own deployed dir, while the settings tab passes a
// placeholder so no machine-local path is shown. The example blocks below
// are REAL card fences: if the guide is pasted into a vault note, the plugin
// renders them as live demo cards.

// Used by settings.ts (AI 助手 tab) and the MCP get_card_guide tool.
export function renderAiGuide(pluginDir: string): string {
  return AI_GUIDE_MARKDOWN.replaceAll("{{CLI_PATH}}", `${pluginDir}/cli.js`);
}

export const AI_GUIDE_MARKDOWN = `# StrataBoard 卡片编写指南（供 AI 使用）

> 本指南由 StrataBoard 插件生成（设置 → AI 助手 / MCP get_card_guide 工具）。

这个 vault 安装了 **StrataBoard** 插件：在 Markdown 笔记里写特定语言的围栏代码块（fenced code block），插件就把它渲染成数据卡片（K 线/折线、叠加对比、计算序列、TradingView 小组件、日历）。块内容是 YAML。

卡片数据全部来自用户在设置页配置的「自定义数据源」（卡片的资产类型恒为 \`custom\`）。写卡片前先用 \`sources\` 确认已有哪些源；一个都没有时，让用户先配置数据源（插件设置 → AI 助手 →「提示词：添加数据源」），不要凭空写卡片。

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
| \`render-card <文件\\|-> [--out png路径] [--width N] [--height N]\` | 把第一个卡片块（quote/overlay/spread）渲染成 PNG 图片 | \`node "{{CLI_PATH}}" render-card 卡片.md --out 图.png\` |
| \`render-doc <文章.md> [--out-dir 目录] [--out-md 路径]\` | 把文章里全部卡片渲染成 PNG（默认输出到 \`<文章名>.assets/\`），并生成图片链接版 Markdown（默认 \`<文章名>.images.md\`）——发布到飞书等不支持本插件的平台时用这条 | \`node "{{CLI_PATH}}" render-doc 文章.md\` |

MCP 客户端用等价工具：\`list_sources\` / \`search_symbols\` / \`probe_data\` / \`validate_cards\` / \`render_card_png\`（直接返回图片内容）/ \`render_doc_images\`（入参语义相同）。

渲染只支持 quote/overlay/spread 卡片（financial-widget/calendar 不支持，render-doc 会保留原文并注明原因）；渲染的是当前真实数据，与 Obsidian 里看到的图表一致。

## 二、写作工作流（务必遵守）

1. **先 sources 再 search**：确认数据源 id 和真实代码，不要凭记忆猜。代码格式由数据源自己定义（如 \`600519.SH\`、\`sh600519\`、\`DGS10\`）。
2. **嵌入卡片块**：把对应类型的围栏代码块写进 Markdown。
3. **validate 自检**：写完后对文件跑 \`validate\`，退出码非 0 时按错误信息修正。
4. **拿不准就 probe**：search 里没有的代码先 probe 确认是否真有数据；确认没有就放弃，并在文中注明。

## 三、卡片块类型

### 1. \`\`\`quote — 数据卡（K 线 / 折线）

字段（中文键，**白名单严格校验**：写任何此处未列出的键都会报解析错误）：

- \`代码\`（必填）、\`数据源\`（必填，自定义源 id，用 \`sources\` 命令查看）
- \`周期\`：\`D\`|\`W\`|\`M\`|\`Q\`|\`Y\`，默认 D。只支持小级别向大级别聚合：插件按数据自动检测源的原始粒度（标题栏有 日频/周频/月频/季频/年频 徽标），原始粒度更粗时更小的周期无效——卡片底部对应按钮冻结，手写的更小 \`周期\` 按原始粒度展示；\`范围\`：\`1y\`|\`3y\`|\`5y\`|\`ytd\`|\`max\` 或 \`yyyy-mm-dd~yyyy-mm-dd\`，默认 1y
- \`图表类型\`：\`candlestick\`|\`line\`（单值序列用 line）；图表高度固定 400px，涨/跌色由插件全局设置决定，均不是卡片字段
- \`主题\`：\`auto\`|\`dark\`|\`light\`
- \`显示标题\`/\`显示成交量\`/\`对数坐标\`：true/false
- \`title\`（英文键，可选）：整体标题覆盖——写了即替代默认的「名称 ?? 代码」，作用于图表标题栏、水印、导出 PNG 的文件名与图内标题（导出副标题只留周期徽标）
- \`indicators\`：用户自定义技术指标实例列表（英文键），每项 \`{id: 指标id, inputs: {参数: 值}}\`，\`inputs\` 可省略（使用指标文件声明的默认参数）；\`hidden: true\` 可隐藏某个指标。插件不内置指标；可用 id 来自指标文件夹中的 .js 文件，id 即文件名 slug。不写或写 \`indicators: []\` 均表示本卡不显示指标。完整契约见 MCP \`get_indicator_guide\`（或插件设置 → AI 助手 →「提示词：编写技术指标」）。用户可能在设置页定义了「指标组」：用 CLI \`groups\` 或 MCP \`list_indicator_groups\` 查看，写卡时把组展开为 \`indicators\` 实例列表即可。
- \`可见起点\`/\`可见终点\`：YYYY-MM-DD（插件在用户缩放后自动维护，手写时可省略）

示例（\`数据源\` 换成 \`sources\` 命令返回的真实 id）：

\`\`\`quote
代码: 600519.SH
数据源: src-XXXX
周期: D
范围: 1y
版本: 1
indicators:
  - id: my-overlay-indicator
    inputs: { length: 20 }
  - id: my-pane-indicator
\`\`\`

### 2. \`\`\`overlay — 对比卡（多系列对比）

字段（英文键，**白名单严格校验**：未列出的键会报解析错误；图表高度固定 400px，不可配置）：

- \`series\`（必填，1–10 条），每条：
  - \`source\`：\`quote\`|\`card\`
  - quote：\`tsCode\` + \`assetType: custom\` + \`sourceId\`（自定义源 id）+ 可选 \`profile\`（数据源已定义的口径名；优先于符号表和源默认口径）
  - card：\`cardId\`（引用卡片库中已有**计算卡**的稳定 id，即其 YAML 里的 \`id\` 字段；改名/移动卡片文件不影响引用。引用数据卡请直接用 quote 系列——读取该数据卡的 代码/数据源 写成 quote 条目即可）
  - \`label\`：显示名覆盖（可选）；\`scale\`：视觉缩放系数（仅对比卡可用，可选）
  - \`kind\`：值语义（可选）：\`price\`（默认，价格/指数）|\`yield\`（收益率/利率）|\`spread\`（价差/利差）|\`level\`（可跨零的一般水平值）|\`change\`（已是环比/同比/百分比变化）。**收益率、利差、同比等非价格序列必须声明**，否则两系列卡片的相关系数会按价格误算收益率。缺省顺序：series \`kind\` > 数据源 \`seriesKind\` > \`price\`；不要从口径名或代码猜测
  - \`corr\`：相关变换覆盖（可选）：\`return\`（简单收益率）|\`diff\`（一阶差分）|\`bond\`（债券收益方向 −Δ）|\`raw\`（原值参与）|\`none\`（该系列不参与相关）。默认按 kind 推导：price→return，yield/spread/level→diff，change→raw
- \`range\`（默认 10y）、\`period\`（\`D\`|\`M\`|\`Q\`|\`Y\` 重采样粒度，默认 D）、\`theme\`
- \`normalize\`：\`percent\`（默认，各线按首点归一为涨跌幅）|\`zscore\`（标准化）|\`axis\`（各自独立纵轴）|\`none\`（原始值同轴）
- \`correlation\`：\`false\` 可关闭副标题的两系列相关系数徽标（默认显示；统计的是逐期变动的相关，与图上水平线形状不同）
- \`title\`（可选）：整体标题覆盖——写了即替代默认的「对比（名1+名2）」（及归一化等模式后缀），作用于图表标题栏、水印、导出 PNG 的文件名与图内标题

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
\`\`\`

### 3. \`\`\`spread — 计算卡（四则运算）

对字母标记的系列做算术：series[0] 是 A，series[1] 是 B……支持 \`+\` \`-\` \`*\` \`/\` \`()\` 和数字。字段同 overlay（含 \`title\` 整体标题覆盖，默认是表达式展开标题），但**不支持** \`normalize\` 和 \`scale\`，另有 \`expression\`（必填）、\`lineWidth\`（1–4）、\`lineColor\`（\`#rrggbb\`）。\`id\` 字段是卡片的稳定身份（其他卡通过 \`cardId\` 引用它）：新建时不写（插件自动生成），编辑已有卡片时**必须原样保留**。

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
\`\`\`

### 4. \`\`\`financial-widget — TradingView 小组件卡

仅允许 TradingView 官方 HTTPS URL 或官方生成的组件代码，不接受其他域名或任意 HTML。字段（中文键，白名单严格校验）：\`小组件类型\`（\`iframe\`|\`html\`）、\`iframe地址\` 或 \`小组件HTML\`（二选一必填）、\`小组件标题\`、\`高度\`（小组件卡专用，px）。

\`\`\`financial-widget
小组件类型: iframe
iframe地址: https://www.tradingview.com/widgetembed/?symbol=NASDAQ:AAPL
小组件标题: Apple
高度: 400
\`\`\`

### 5. \`\`\`calendar — 日历卡（联动日记）

字段（中文键，白名单严格校验）：\`日历: true\`（必填标记）、\`月份\`（YYYY-MM，可选，默认当月）、\`高度\`（日历卡专用，px）。

\`\`\`calendar
日历: true
高度: 400
\`\`\`

## 四、图表显示覆盖（可选，不写则跟随插件全局设置）

- \`\`\`quote 卡用中文键：\`显示图例\` / \`图例半透明\` / \`图例透明度\`（0–100）/ \`显示网格\` / \`网格透明度\`（0–100）。指标不再走显示覆盖，用上文的 \`indicators\` 键。
- \`\`\`overlay / \`\`\`spread 卡用英文键：\`showLegend\` / \`legendFrosted\` / \`legendOpacity\`（0–100）/ \`showLatestValue\` / \`showPointMarkers\` / \`showGrid\` / \`gridOpacity\`（0–100）。
`;
