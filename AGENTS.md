# AGENTS.md — StrataBoard

Guidance for AI coding agents working in this repository.

## Core principles (项目原则，必须遵守)

1. 不保留向后兼容。过时的直接删，别加兼容层、migration、fallback。
2. 选能满足当前需求的最简单实现；不要预防性抽象、多余的配置层。
3. 先跑通最小端到端版本再往上加；绝不为未完成的复杂度拆掉能跑的东西。
4. 组件模块化，关注点分离。
5. 优先用成熟、有人维护的库；先看项目已有依赖能做什么，再考虑加新包或自己写。
6. 架构决策往长了做，不接受"先这样以后再换"的临时方案。
7. 先看成熟产品怎么解决同一问题，用已验证的模式，别从零发明。
8. 所有数据源都必须支持独立卡片；新增数据源时独立卡、叠加卡、计算卡三条链路同时接通。

## Project overview

Obsidian 桌面插件（id `strataboard`，desktop only，minAppVersion 1.7.2），往 Canvas 白板插入金融数据卡片。

- 卡片类型：资产卡（自定义源 K线/线）、叠加卡（≤ `MAX_OVERLAY_SERIES`=10 系列；normalize: percent/zscore/axis/none）、计算卡（spread，如 `A-B`）、TradingView widget 卡、日历卡。
- 每张卡是一个 md 文件（默认 `金融卡片/`），内嵌 YAML fenced block（` ```quote/overlay/spread/financial-widget/calendar `）。规格解析：`src/modules/card-spec.ts`、`series-spec.ts`（js-yaml）。
- 数据源：**插件不内置任何数据源**，仅作为数据接入框架与展示工具。数据全部来自用户自定义源（URL 模板 + 响应格式 `tencent`/`eastmoney`/通用 JSON 映射/vault 本地 CSV；支持 GET/POST + `bodyTemplate`、rowKind `fields` 两段式映射、业务错误透传 `errorPath`、`transport: "node"` 兼容模式；远程搜索支持 `searchUrl`（GET，`{query}` 占位）与 `searchBodyTemplate`（POST，URL 未配时复用 klineUrl），模板不含 `{query}` 表示整表拉回本地过滤、结果在 data-adapter 缓存 10 分钟）。合规红线：插件绝不内置、预设或打包任何数据端点；自定义配置只能在用户间通过设置页导入/导出流转。
- 图表用 lightweight-charts v5；OHLCV 缓存在本地 SQLite（sql.js WASM，`sql-wasm.wasm` 随插件部署）。

## Technology stack

- TypeScript（strict）→ esbuild 打成单个 CJS `main.js`。
- Runtime deps：`obsidian`（external）、`lightweight-charts`、`sql.js`、`js-yaml`、`papaparse`；`@modelcontextprotocol/sdk` + `zod` 仅 MCP bundle。
- 无测试框架、无 linter。唯一静态检查：`tsc -noEmit -skipLibCheck`。

## Build, develop, deploy

- `npm run dev` — copy assets + esbuild watch。`npm run build` — typecheck + 生产构建 + CLI + MCP。
- `npm run release` — build 后 `scripts/release.mjs`：拒绝脏树、推分支、打 tag `<manifest version>`（**无 v 前缀**，Obsidian 插件市场要求 tag 与 manifest 版本完全一致）、`gh` 建 release。
- 构建**直接部署到 Obsidian vault 的插件目录**，不写进 repo。必须设 `OBSIDIAN_PLUGIN_DIR`（否则 build 报错）。作者的 deploy target（本 repo 默认使用）：`OBSIDIAN_PLUGIN_DIR="/Users/izzy/Nutstore Files/子九章/.obsidian/plugins/strataboard"`。
- 根目录的 `main.js` 是过时/gitignored 产物；真正的产物在插件目录。
- 无自动化测试。验证 = typecheck + 在 Obsidian 里实际运行，检查亮色/暗色两套主题。

## Code layout

- `src/main.ts` — 插件入口：settings、命令、各卡片类型的 code-block processor、canvas 右键菜单、刷新编排、脚本产物 watcher（output CSV create → `syncScriptSources` 注册；modify → 清该源缓存 key + 全量重绘图表卡）。
- `src/types.ts` — 共享领域类型。`ASSET_TYPES` 是资产类型的唯一事实来源。
- `src/settings.ts` — 设置与设置页 UI。tab：通用设置（免责声明已并入其底部折叠区，不再单独成 tab）/ 数据源设置 / AI 辅助 / 路径设置 / 卡片与组件 / 工具栏设置；所有子区块（`<details class="fc-settings-sub">`）一律默认折叠。数据源支持 `group` 标签分组（同名即同组，无独立组实体）：设置页按组归类渲染、可重命名/解散/设组图标；统一搜索与插入菜单里组折叠为单个组级入口、选中即组内联合搜索（`CategoryId` 的 `group:<名称>` 分支；搜索框内不再有分类 chip，范围由打开它的入口决定）。全局图表显示默认值在 卡片与组件 tab；每张卡可通过 YAML 覆盖（`DisplayOverrides`，合并方式 `spec.x ?? settings.x`）。脚本处理：`scriptFolderPath`、`disabledScripts`（禁用只置灰手动「立即运行」）、`seenScriptOutputs`（被动同步对每个产物文件只自动注册一次，用户删掉的源不会被重载/create 重建；但脚本重新运行（`invalidateScriptOutput` 走 forcePaths）或产物文件删除后重建时会重新注册，文件已不存在的 seen 路径会被清理）。「AI 辅助」tab 分四块：接入 AI（「一键配置提示词」`MCP_SETUP_PROMPT` 让用户的 AI agent 自行定位 vault 并完成注册 + MCP/CLI 手动配置片段，路径一律用 `<vault路径>` 占位符，不展示本机真实路径），之后按场景各一块提示词：添加数据源（`AI_SOURCE_PROMPT`）、编写/修改卡片（`renderAiGuide` 全文）、编写数据处理脚本（`AI_SCRIPT_PROMPT`）。
- `src/modules/` — 核心逻辑，一文件一职责：
  - `card-spec.ts` / `series-spec.ts` — YAML 规格解析/序列化（卡片文件格式的唯一事实来源）。
  - `data-adapter.ts` — 取数 + 增量缓存。非日频源一律按日缓存、读取时重采样到 W/M；重采样 bar 的 `tradeDate` 是该周期**最后**一个交易日（这也是日均线能贴到 W/M bar 上的原因）。
  - `series-adapter.ts` — 解析 `SeriesRef`（quote/card）。`source: "card"` 可引用 quote/spread 卡；overlay 卡**不可**被引用。`visited` 集合防手写 YAML 循环引用。`expression.ts` 是 spread 表达式求值。
  - `custom-quote-client.ts` / `csv-quote-client.ts` — 自定义源客户端。自定义源解析器是纯函数：`quote-format-parsers.ts`（含 `fields` 行映射、`extractApiError` 业务错误透传）、`utils/url-template.ts`、`csv-quote-client.ts`（含 `deriveCsvMapping`），均可 node 直接跑。
  - `sqlite-cache.ts` — 主缓存（sql.js）。自定义源缓存 key 为 `custom:<sourceId>`。
  - `bundled-assets.ts` — 社区商店安装只会拉 main.js/manifest.json/styles.css，启动时按 `.bundled-assets-version` 标记（dev 构建由 copy-assets.mjs 写入）判断，缺 sql-wasm.wasm/cli.js/mcp-server.js 时从本仓库对应版本 release 自动补齐。
  - `script-sources.ts` / `script-runner.ts` — 脚本处理：`syncScriptSources` 把 `<scriptFolderPath>/output/*.csv` 自动注册为 csv 源（脚本管理器里未注册的产物可用「部署为数据源」按钮走 forcePaths 手动注册）；`runScript` 是「立即运行」（python3 走 login shell 解析，180s 超时，永不 reject，脚本以文件夹相对路径为 argv）。插件只读本地 CSV，脚本行为由用户负责。`AI_SCRIPT_PROMPT`（含产物契约与合规规则的可复制提示词）也在这里，脚本管理器与「AI 辅助」tab 共用。
  - 渲染器：`chart-renderer.ts`（`CHART_PALETTE` + `buildChartOptions` 必须与 styles.css 的 `.fc-hermes` 块保持同步；`exportChartPng` 截图导出）、`chart-card-base.ts`（卡片骨架 + `chartRenderers` 注册表，脚本产物失效时靠它重绘）、`series-chart-renderer.ts`、`widget-renderer.ts`、`calendar-renderer.ts`、`toolbar.ts`（浮动工具栏：按钮图标是 `toolbar-icons.ts` 内联 SVG，菜单项图标用 lucide 名或 `addIcon` 注册的自定义 SVG/调色板色点——「插入图表」子菜单按 全部/组/源 列出，源图标 `CustomSourceDef.icon`、组图标 `settings.sourceGroupIcons`，未配置时按 id/组名 hash 取 `SERIES_LINE_COLORS` 色点）、`card-service.ts`（卡片文件命名：资产名称-代码-数据源）。
  - `http.ts` — 全局串行节流包装 `requestUrl`；`transport: "node"` 时改用 Node https（HTTP/1.1，绕开个别站点在 Electron HTTP/2 下的连接失败），POST 自动带 `Content-Type: application/json`。**所有**出站数据请求必须走它，客户端里绝不直接调 `requestUrl`。
  - `maintenance.ts` — 孤儿卡/陈旧缓存 key 扫描（清理维护工具）。
- `src/ui/` — Obsidian modals：统一卡片编辑、overlay/spread/widget/calendar 编辑器、各类搜索弹窗、`custom-source-modal.ts`（自定义源向导；AI 辅助区仅添加时显示，只保留一个跳转「AI 辅助」设置的按钮——引导提示词 `AI_SOURCE_PROMPT` 在该 tab：AI 把最终配置写成 vault 内 .json 文件；导入走文件选择而非粘贴）、`csv-source-modal.ts`（CSV 向导）、`setup-guide-modal.ts`（无启用数据源时的引导弹窗）、`script-manager-modal.ts`（脚本管理器：递归列出脚本文件夹、按子文件夹分组，`disabledScripts` 按文件夹相对路径记录；无「新建脚本」——脚本由用户自行/AI 编写后放入文件夹）、`display-overrides.ts`（共享的每卡显示覆盖组）。
- `src/cli/` + `src/mcp/server.ts` — 给外部 AI 用的独立 CLI（`cli.js`）和 MCP stdio server（`mcp-server.js`），命令实现都在 `cli/commands.ts`，两者共享。插件**无内置 AI 助手**：外部 AI 走 CLI/MCP + `ai-guide.ts`；UI 里的「AI 辅助」一律是一键复制提示词（提示词含契约与合规规则），由用户贴给自己的 AI。
- `src/modules/ai-guide.ts` — 外部 AI 的卡片编写指南（纯字符串模板 + `renderAiGuide` 路径填充）；展示在设置页「AI 辅助」tab（可复制全文），MCP 经 `get_card_guide` 工具返回；不写入 vault（main.ts 会把旧版留在卡片库里的指南文件清理掉）。
- `src/i18n.ts` — 中英双语。约定：**中文原文即字典 key**，所有用户可见字符串走 `t("中文原文")`，英文在 `EN` map。命令名是加载时注册的，切语言需重载插件。
- `styles.css` — 全部样式。卡片和工具栏用 `fc-hermes` 作用域类：固定深色配色，与 Obsidian 主题无关（除非卡片显式设浅色主题）。图例背景透明度走 `--fc-legend-opacity` CSS 变量。

## Working conventions

- **语言**：代码注释用英文（UI 标签和领域词可用中文）；UI 字符串用中文；设计文档用中文。与所在文件保持一致。
- **设计决策**：`IMPLEMENTATION.md` 里有已定稿（"已拍板"）的决策，不要重开讨论。没有独立设计稿，UI 代码本身就是参考。
- **Canvas 交互模型**很微妙（拖节点 / 双击进入图表模式 / 再双击进设置三层）。改卡片事件处理前，先读 `src/main.ts` `QuoteCodeBlockRenderer` 里解释为何监听挂在 document 捕获阶段的注释。
- 根目录 `app.js` 是 Obsidian 打包代码的参考副本，不参与构建。`.od-skills/` 是作者本地技能，与插件无关。

## Security considerations

- 根目录 `data.json` 是含真实密钥的设置快照，已 gitignored（`data.json`、`cache/`、`*.db`、`sql-wasm.wasm`、`main.js` 均在忽略列表）。绝不提交密钥或缓存数据库。
- TradingView widget 卡按设计嵌入第三方 HTML/JS；widget 代码视为不可信输入，只在 widget 渲染器的沙箱方式内透传。
