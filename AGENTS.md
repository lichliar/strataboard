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

- 卡片类型：资产卡（Tushare K线/线）、FRED 卡、中国宏观卡、叠加卡（≤ `MAX_OVERLAY_SERIES`=10 系列；normalize: percent/zscore/axis/none）、计算卡（spread，如 `A-B`）、TradingView widget 卡、日历卡。
- 每张卡是一个 md 文件（默认 `金融卡片/`），内嵌 YAML fenced block（` ```tushare/fred/macro/overlay/spread/financial-widget/calendar `）。规格解析：`src/modules/card-spec.ts`、`series-spec.ts`（js-yaml）。
- 数据源：Tushare Pro（A股/基金/指数、Nanhua 期货指数、港股、全球指数、可转债、期货、FX、SW 行业指数、场外基金、中国宏观序列，目录见 `MACRO_SERIES_OPTIONS`）、FRED、用户自定义源（URL 模板 + 响应格式 `tencent`/`eastmoney`/通用 JSON 映射/vault 本地 CSV）。合规红线：插件绝不内置免 token 或未文档化的抓取端点；内置连接器仅限需用户自备凭证的官方 API（Tushare Pro、FRED）；自定义配置只能在用户间通过设置页导入/导出流转，绝不打包预设。Tushare 美股（`us_daily`）未接入（单独付费权限）。
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
- `src/settings.ts` — 设置与设置页 UI。全局图表显示默认值在 卡片与组件 tab；每张卡可通过 YAML 覆盖（`DisplayOverrides`，合并方式 `spec.x ?? settings.x`）。脚本处理：`scriptFolderPath`、`disabledScripts`（禁用只置灰手动「立即运行」）、`seenScriptOutputs`（每个产物文件只注册一次，用户删掉的源不会重建）。「外部 AI 接入」tab 给出按本机路径填好的 MCP/CLI 配置片段供复制。
- `src/modules/` — 核心逻辑，一文件一职责：
  - `card-spec.ts` / `series-spec.ts` — YAML 规格解析/序列化（卡片文件格式的唯一事实来源）。
  - `data-adapter.ts` — 取数 + 增量缓存。非日频源一律按日缓存、读取时重采样到 W/M；重采样 bar 的 `tradeDate` 是该周期**最后**一个交易日（与 Tushare 周/月线一致，这也是日均线能贴到 W/M bar 上的原因）。窗口化宏观 API 由 `fetchMacroWindowed` 分窗增量拉取。
  - `series-adapter.ts` — 解析 `SeriesRef`（quote/macro/fred/card）。`source: "card"` 可引用 tushare/fred/macro/spread 卡；overlay 卡**不可**被引用。`visited` 集合防手写 YAML 循环引用。`expression.ts` 是 spread 表达式求值。
  - `tushare-api-client.ts` / `fred-api-client.ts` / `custom-quote-client.ts` — 薄 HTTP 客户端。`tushare-quote-api.ts` 是 asset type + freq → Tushare `api_name` 的唯一事实来源。自定义源解析器是纯函数：`quote-format-parsers.ts`、`utils/url-template.ts`、`csv-quote-client.ts`（含 `deriveCsvMapping`），均可 node 直接跑。
  - `sqlite-cache.ts` — 主缓存（sql.js）。`cache-store.ts` 仅用于一次性迁移。自定义源缓存 key 为 `custom:<sourceId>`；FRED 带 `seriesId@transform` 后缀。
  - `bundled-assets.ts` — 社区商店安装只会拉 main.js/manifest.json/styles.css，启动时按 `.bundled-assets-version` 标记（dev 构建由 copy-assets.mjs 写入）判断，缺 sql-wasm.wasm/cli.js/mcp-server.js 时从本仓库对应版本 release 自动补齐。
  - `script-sources.ts` / `script-runner.ts` — 脚本处理：`syncScriptSources` 把 `<scriptFolderPath>/output/*.csv` 自动注册为 csv 源；`runScript` 是「立即运行」（python3 走 login shell 解析，180s 超时，永不 reject）。插件只读本地 CSV，脚本行为由用户负责。`AI_SCRIPT_PROMPT`（含产物契约与合规规则的可复制提示词）也在这里，脚本管理器与「外部 AI 接入」tab 共用。
  - 渲染器：`chart-renderer.ts`（`CHART_PALETTE` + `buildChartOptions` 必须与 styles.css 的 `.fc-hermes` 块保持同步；`exportChartPng` 截图导出）、`chart-card-base.ts`（卡片骨架 + `chartRenderers` 注册表，脚本产物失效时靠它重绘）、`series-chart-renderer.ts`、`widget-renderer.ts`、`calendar-renderer.ts`、`toolbar.ts`（浮动工具栏）、`card-service.ts`（卡片文件命名：资产名称-代码-数据源）。
  - `http.ts` — 全局串行节流包装 `requestUrl`。**所有**出站数据请求必须走它，客户端里绝不直接调 `requestUrl`。
  - `maintenance.ts` — 孤儿卡/陈旧缓存 key 扫描（清理维护工具）。
- `src/ui/` — Obsidian modals：统一卡片编辑、overlay/spread/widget/calendar 编辑器、各类搜索弹窗、`custom-source-modal.ts`（自定义源向导；AI 辅助区先引导用户去「外部 AI 接入」配 MCP/CLI，再给可复制引导提示词）、`csv-source-modal.ts`（CSV 向导）、`script-manager-modal.ts`（脚本管理器 + 可复制提示词）、`display-overrides.ts`（共享的每卡显示覆盖组）。
- `src/cli/` + `src/mcp/server.ts` — 给外部 AI 用的独立 CLI（`cli.js`）和 MCP stdio server（`mcp-server.js`），命令实现都在 `cli/commands.ts`，两者共享。插件**无内置 AI 助手**：外部 AI 走 CLI/MCP + `ai-guide.ts`；UI 里的「AI 辅助」一律是一键复制提示词（提示词含契约与合规规则），由用户贴给自己的 AI。
- `src/modules/ai-guide.ts` — 外部 AI 的卡片编写指南（纯字符串模板 + `renderAiGuide` 路径填充）；展示在设置页「外部 AI 接入」tab（可复制全文），MCP 经 `get_card_guide` 工具返回；不写入 vault（main.ts 会把旧版留在卡片库里的指南文件清理掉）。
- `src/i18n.ts` — 中英双语。约定：**中文原文即字典 key**，所有用户可见字符串走 `t("中文原文")`，英文在 `EN` map。命令名是加载时注册的，切语言需重载插件。
- `styles.css` — 全部样式。卡片和工具栏用 `fc-hermes` 作用域类：固定深色配色，与 Obsidian 主题无关（除非卡片显式设浅色主题）。图例背景透明度走 `--fc-legend-opacity` CSS 变量。

## Working conventions

- **语言**：代码注释用英文（UI 标签和领域词可用中文）；UI 字符串用中文；设计文档用中文。与所在文件保持一致。
- **设计决策**：`IMPLEMENTATION.md` 里有已定稿（"已拍板"）的决策，不要重开讨论。没有独立设计稿，UI 代码本身就是参考。
- **Canvas 交互模型**很微妙（拖节点 / 双击进入图表模式 / 再双击进设置三层）。改卡片事件处理前，先读 `src/main.ts` `TushareCodeBlockRenderer` 里解释为何监听挂在 document 捕获阶段的注释。
- 根目录 `app.js` 是 Obsidian 打包代码的参考副本，不参与构建。`.od-skills/` 是作者本地技能，与插件无关。

## Security considerations

- 根目录 `data.json` 是含真实 Tushare token 的设置快照，已 gitignored（`data.json`、`cache/`、`*.db`、`sql-wasm.wasm`、`main.js` 均在忽略列表）。绝不提交 token 或缓存数据库。
- TradingView widget 卡按设计嵌入第三方 HTML/JS；widget 代码视为不可信输入，只在 widget 渲染器的沙箱方式内透传。
