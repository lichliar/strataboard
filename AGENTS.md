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
- 每张卡是一个 md 文件（默认 `金融卡片/`），内嵌 YAML fenced block（` ```quote/overlay/spread/financial-widget/calendar `）。规格解析：`src/modules/card-spec.ts`、`series-spec.ts`（`yaml` 包）。
- 数据源：**插件不内置任何数据源**，仅作为数据接入框架与展示工具。数据全部来自用户自定义源（URL 模板 + 响应格式 `tencent`/`eastmoney`/通用 JSON 映射/vault 本地 CSV；支持 GET/POST + `bodyTemplate`、rowKind `fields` 两段式映射、业务错误透传 `errorPath`、`transport: "node"` 兼容模式；远程搜索支持 `searchUrl`（GET，`{query}` 占位）与 `searchBodyTemplate`（POST，URL 未配时复用 klineUrl），模板不含 `{query}` 表示整表拉回本地过滤、结果在 data-adapter 缓存 24 小时（导入后预热））。合规红线：插件绝不内置、预设或打包任何数据端点；自定义配置只能在用户间通过设置页导入/导出流转。
- 图表用 lightweight-charts v5；OHLCV 缓存在本地 SQLite（sql.js WASM，`sql-wasm.wasm` 随插件部署）。

## Technology stack

- TypeScript（strict）→ esbuild 打成单个 CJS `main.js`。
- Runtime deps：`obsidian`（external）、`lightweight-charts`、`sql.js`、`yaml`、`papaparse`；`@modelcontextprotocol/sdk` + `zod` 仅 MCP bundle。
- 无测试框架、无 linter。唯一静态检查：`tsc -noEmit -skipLibCheck`。

## Build, develop, deploy

- `npm run dev` — copy assets + esbuild watch。`npm run build` — typecheck + 生产构建 + CLI + MCP。三处构建配置（`esbuild.config.mjs` / `scripts/build-cli.mjs` / `scripts/build-mcp.mjs`）都带 `charset: "utf8"`：产物保留非 ASCII 原字符（不转义成 `\uXXXX`，可 grep）。
- `npm run release` — build 后 `scripts/release.mjs`：拒绝脏树、推分支、打 tag `<manifest version>`（**无 v 前缀**，Obsidian 插件市场要求 tag 与 manifest 版本完全一致）、`gh` 建 release。
- 构建**直接部署到 Obsidian vault 的插件目录**，不写进 repo。必须设 `OBSIDIAN_PLUGIN_DIR`（否则 build 报错）。作者的 deploy target（本 repo 默认使用）：`OBSIDIAN_PLUGIN_DIR="/Users/izzy/Nutstore Files/子九章/.obsidian/plugins/strataboard"`。
- 根目录的 `main.js` 是过时/gitignored 产物；真正的产物在插件目录。
- 无自动化测试。验证 = typecheck + 在 Obsidian 里实际运行，检查亮色/暗色两套主题。

## Code layout

- `src/main.ts` — 插件入口：settings、命令、各卡片类型的 code-block processor、canvas 右键菜单、刷新编排、脚本产物 watcher（output CSV create → `syncScriptSources` 注册；modify → 清该源缓存 key + 全量重绘图表卡）。
- `src/types.ts` — 共享领域类型。`ASSET_TYPES` 是资产类型的唯一事实来源。`SymbolListEntry.params`/`profile` 是符号级模板变量与档位引用（填充模板里的 `{p.<名>}`）；`CustomSourceDef.params` 是源级默认模板变量、`CustomSourceDef.profiles` 是共享档位（合并顺序：源级 params ←（端点声明档位 / 无声明时 codeRules 命中档位）← 条目 profile 档位 ← 符号 params）、`CustomSourceDef.codeRules` 是代码形态规则（`{match: 正则, profile: 档位名}[]`，只对不在 symbols 表里的代码生效，按序命中即把该档位并入源级 params 之上；端点声明的 profile 优先——有声明用声明，没声明才用正则）、`CustomSourceDef.searchProfile` 是主搜索端点返回代码的类别档位声明、`CustomSourceDef.deadCodes` 是已知无行情代码的正则列表（validate-config 跳过探测不判红，搜索结果标注「已知无行情」不剔除）、`CustomSourceDef.searchPaginate` 是主搜索端点（searchUrl/searchBodyTemplate 对）的翻页配置，`searches?: SearchEndpoint[]` 是额外搜索端点（字段 url/bodyTemplate/profile/searchRowsPath/searchCols/paginate/enabled——`profile` 声明该端点返回代码的类别档位（选中结果时记入 symbols.db，取数优先于 codeRules）、searchRowsPath/searchCols 端点级覆盖、`paginate` 配 `{offset}` 翻页（maxPages 默认 20，`totalPath` 声明总数路径用于截断检测，三处 paginate 均有 `allowTruncated` 显式豁免截断判红）、`enabled:false` 跳过；未覆盖字段与主搜索共享，结果合并去重（声明 profile 的条目优先于未声明的重复项））；`SymbolItem.profile`/`dead` 是搜索结果条目的端点声明档位与已知无行情标注；`searchProbeQuery`（搜索探针查询词推导，custom-quote-client 的 `autoDetectSearchFormat` 也用）也在这里。`JsonSourceMap.rowKind` 共五值：object/array/fields/map（rowsPath 是以日期为键的对象，cols.date 填 `$key`、标量值列填 `$value`）/columns（列式平行数组，cols 填各列数组相对路径，标量列=单行序列）；`percentScale` 缩放数值列尾部 %（默认 1 保持字面数，100 使 "1.5%"→0.015）。`CustomSourceDef.bodyEncoding`（"form" = POST 表单编码，占位符值 URL 编码）、源级 `paginate`（K 线翻页 {pageSize, maxPages? 默认20, totalPath?}，模板需含 `{offset}`）；format "csv" 为 filePath 本地文件 / klineUrl 远程 CSV/TSV 二选一。凭据解析 `resolveApiKeySource`（来源 self/group/vault/injected/none + donor 名——vault/injected 仅 validate-config 用，组名 trim 后比较）/`resolveGroupApiKey`/`sourceNeedsApiKey`；`KNOWN_SOURCE_DEF_KEYS`/`KNOWN_JSON_MAP_KEYS` 是 CLI 校验与设置页导入共用的字段白名单。
- `src/settings.ts` — 设置与设置页 UI。tab：通用设置（免责声明已并入其底部折叠区，不再单独成 tab）/ 数据源设置 / AI 辅助 / 路径设置 / 卡片与组件 / 工具栏设置；所有子区块（`<details class="fc-settings-sub">`）一律默认折叠。数据源支持 `group` 标签分组（同名即同组，无独立组实体）：设置页按组归类渲染、可重命名/解散/设组图标；统一搜索与插入菜单里组折叠为单个组级入口、选中即组内联合搜索（`CategoryId` 的 `group:<名称>` 分支；搜索框内不再有分类 chip，范围由打开它的入口决定）；同组 apiKey 留空自动复用组内第一个非空密钥（`resolveGroupApiKey`，运行时生效，导出仍按源剥离 apiKey）；组在设置页默认折叠（chevron 切换，会话内保持），源行显示密钥来源（本条目/复用自组内某源/未找到），重命名/新建分组按 trim 处理。数据源导入按名称覆盖合并（同名条目更新、保留原 id 与已填密钥，未知字段给警告）。全局图表显示默认值在 卡片与组件 tab；每张卡可通过 YAML 覆盖（`DisplayOverrides`，合并方式 `spec.x ?? settings.x`）。脚本处理：`scriptFolderPath`、`disabledScripts`（禁用只置灰手动「立即运行」）、`seenScriptOutputs`（被动同步对每个产物文件只自动注册一次，用户删掉的源不会被重载/create 重建；但脚本重新运行（`invalidateScriptOutput` 走 forcePaths）或产物文件删除后重建时会重新注册，文件已不存在的 seen 路径会被清理）。「AI 辅助」tab 分四块：接入 AI（「一键配置提示词」`MCP_SETUP_PROMPT` 让用户的 AI agent 自行定位 vault 并完成注册 + MCP/CLI 手动配置片段，路径一律用 `<vault路径>` 占位符，不展示本机真实路径），之后按场景各一块提示词：添加数据源（`AI_SOURCE_PROMPT`）、编写/修改卡片（`renderAiGuide` 全文）、编写数据处理脚本（`AI_SCRIPT_PROMPT`）。
- `src/modules/` — 核心逻辑，一文件一职责：
  - `card-spec.ts` / `series-spec.ts` — YAML 规格解析/序列化（卡片文件格式的唯一事实来源）。
  - `data-adapter.ts` — 取数 + 增量缓存。非日频源一律按日缓存、读取时重采样到 W/M；重采样 bar 的 `tradeDate` 是该周期**最后**一个交易日（这也是日均线能贴到 W/M bar 上的原因）。整表搜索（不含 `{query}` 的搜索模板）结果缓存 24 小时，设置页导入后预热；`resolveCustomSource` 返回的 def 已套组内密钥回落（仅运行时，不持久化）。
  - `series-adapter.ts` — 解析 `SeriesRef`（quote/card）。`source: "card"` 可引用 quote/spread 卡；overlay 卡**不可**被引用。`visited` 集合防手写 YAML 循环引用。`expression.ts` 是 spread 表达式求值。
  - `custom-quote-client.ts` / `csv-quote-client.ts` — 自定义源客户端。支持 `headers` 静态请求头（值可含 `{apiKey}` 占位，与 `apiKeyHeader` 并存、同名时 `apiKeyHeader` 优先）；模板占位符含 `{code}`/`{start}`/`{end}`/`{startIso}`/`{endIso}`/`{startTs}`/`{endTs}`（秒级 Unix 时间戳起止）/`{apiKey}`/`{p.<名>}`（符号级参数：取值链 符号 `params` → `profile` 指向的档位 →（代码不在代码表时）搜索来源端点声明的档位 →（无声明时）`codeRules` 命中档位 → 源级默认 `params` → 本地报错，字面量绝不发给服务器；body 里 `{code}`/`{p.*}`/`{apiKey}` 一律不 URL 编码；JSON body 里取值为空串的 `{p.*}` 用哨兵值把该键整个删掉，非 JSON body 保持空串）/`{offset}`（翻页偏移，配 `paginate`/`searchPaginate` 的端点用）。搜索支持多端点扇出（`searchEndpoints`/`searchOne`：主 searchUrl/searchBodyTemplate（吃源级 `searchPaginate` 与 `searchProfile`）+ `searches` 数组合并去重，单端点失败不拖垮整体；`searchOne` 给条目盖端点声明的 `profile`，合并去重时声明条目优先于未声明重复项，返回前按 `deadCodes` 给命中条目盖 `dead: true`），响应缺 code/name 的丢行计数 `console.warn`；搜索翻页触顶 maxPages 或实取数少于 `totalPath` 声明总数记 `stats.truncated`（带 `allowed` 标记是否已 `allowTruncated` 豁免）+ console.warn（未豁免时 validate-config 判 `search.ok=false`，不静默报绿）；`fetchKlineSample` 同样注入 params。源级 `paginate` 驱动 K 线翻页（循环到某页不足 pageSize 或触顶；触顶或 `totalPath` 声明总数大于实取数记 `stats.truncated` + console.warn——不静默报绿）；`fetchSourceText` 导出供 format csv 的远程 URL 复用；`bodyEncoding: "form"` 时 POST 按表单编码发送。重试已下沉 http 层，eastmoney 不再有本地重试循环。自定义源解析器是纯函数：`quote-format-parsers.ts`（含 `fields` 行映射、`extractApiError` 业务错误透传 + `okValues` 成功值白名单、`normalizeJsonDate` 支持 YYYYMM 月频/YYYYQn 季频并快照到周期末最后一天、`parseNumericCell` 数值清洗（千分位/货币符/首尾空白，null/空串=缺失**不**当作 0，尾部 % 按 `percentScale` 缩放；vol/amount 缺失记 0 是有意语义）、`KlineParseStats` 解析统计（dropped/total/emptyDate/missingClose 空 close 单元格/badClose 非空但非数值/unmappedCols/availableFields/truncated，区分「稀疏数据」与「列名拼错」）、rowKind `map`/`columns` 物化与 object 行 cols 点号嵌套路径（如 `quote.close`）、`splitCompositeCode` 复合代码 `urlCode@mapCode`——@ 前半进 URL/请求体模板的 `{code}`，@ 后半只替换 `jsonMap.cols` 里的 `{code}`、`resolveMapCode` 带 params 参数：cols 值支持 `{p.*}`，先填 `{p.*}` 再填 `{code}`、`parseMappedSearch` 第三参 `stats.skipped` 计搜索丢行（缺 code/name））、`utils/url-template.ts`、`utils/symbol-list.ts`（`resolveSymbolParams(def, code, declaredProfile?)`：按 源级 ←（端点声明档位，有声明时 codeRules 整层不生效 / 无声明时 codeRules 命中档位）← 条目档位 ← 符号 合并 params，复合代码按 @ 前半匹配；另有 `matchCodeRuleProfileName`/`matchAllCodeRules`、`compileDeadCodes`/`isDeadCode`（OR 合并单正则）、`hasCodeSpecificParams`（供 validate-config 的 0 行报错区分「无数据」与「接口不覆盖该资产类别」）、`auditSearchCoverage`（接线审计：未命中形态聚合 unmatchedTop / 多规则重叠 overlaps / 声明与规则冲突 conflicts / 按档位抽样 sampleCodes））、`csv-quote-client.ts`（含 `deriveCsvMapping`；klineUrl 远程 CSV/TSV 经 `fetchSourceText` 拉回文本复用同一解析器），均可 node 直接跑。
  - `sqlite-cache.ts` — 主缓存（sql.js）。自定义源缓存 key 为 `custom:<sourceId>`。symbols 旁表缓存搜索选中/探测过的代码（含 `profile` 列存端点声明的档位——旧库启动时 ALTER TABLE 迁移补上），取数路径（data-adapter / CLI probe）按代码查它取声明档位传给 `resolveSymbolParams`。
  - `bundled-assets.ts` — 社区商店安装只会拉 main.js/manifest.json/styles.css，启动时按 `.bundled-assets-version` 标记（dev 构建由 copy-assets.mjs 写入）判断，缺 sql-wasm.wasm/cli.js/mcp-server.js 时从本仓库对应版本 release 自动补齐。
  - `script-sources.ts` / `script-runner.ts` — 脚本处理：`syncScriptSources` 把 `<scriptFolderPath>/output/*.csv` 自动注册为 csv 源（脚本管理器里未注册的产物可用「部署为数据源」按钮走 forcePaths 手动注册；模块级 promise 链串行化防止并发同步 race 重复注册，且每次同步开头按 id 去重 `script:` 源——既有重复副本自愈）；`runScript` 是「立即运行」（python3 走 login shell 解析，180s 超时，永不 reject，脚本以文件夹相对路径为 argv）。插件只读本地 CSV，脚本行为由用户负责。`AI_SCRIPT_PROMPT`（含产物契约与合规规则的可复制提示词）也在这里，脚本管理器与「AI 辅助」tab 共用。
  - 渲染器：`chart-renderer.ts`（`CHART_PALETTE` + `buildChartOptions` 必须与 styles.css 的 `.fc-hermes` 块保持同步；`exportChartPng` 截图导出）、`chart-card-base.ts`（卡片骨架 + `chartRenderers` 注册表，脚本产物失效时靠它重绘）、`series-chart-renderer.ts`、`widget-renderer.ts`、`calendar-renderer.ts`、`toolbar.ts`（浮动工具栏：按钮图标是 `toolbar-icons.ts` 内联 SVG，菜单项图标用 lucide 名或 `addIcon` 注册的自定义 SVG/调色板色点——「插入图表」子菜单按 全部/组/源 列出，源图标 `CustomSourceDef.icon`、组图标 `settings.sourceGroupIcons`，未配置时按 id/组名 hash 取 `SERIES_LINE_COLORS` 色点）、`card-service.ts`（卡片文件命名：资产名称-代码-数据源）。
  - `http.ts` — 全局串行节流包装 `requestUrl`；统一默认 30 秒超时，网络错误/超时自动重试 1 次（HTTP 状态错误抛 `HttpStatusError`，不重试）；`transport: "node"` 时改用 Node https（HTTP/1.1，绕开个别站点在 Electron HTTP/2 下的连接失败；只支持 https——明文 http 会提前拒绝并提示改用默认传输），POST 自动带 `Content-Type: application/json`。**所有**出站数据请求必须走它，客户端里绝不直接调 `requestUrl`。
  - `maintenance.ts` — 孤儿卡/陈旧缓存 key 扫描（清理维护工具）。
- `src/ui/` — Obsidian modals：统一卡片编辑、overlay/spread/widget/calendar 编辑器、`unified-search-modal.ts` 统一搜索弹窗（结果按相关度分档：代码精确 > 名称前缀 > 代码前缀 > 名称包含 > 代码包含，同档按源轮转、远程结果进各源桶保证确定性；`deadCodes` 命中的结果带「已知无行情」标注但不剔除；源搜索失败时 Notice 提示一次（每源每弹窗会话），空结果时 emptyState 列出失败源）等搜索弹窗、`custom-source-modal.ts`（自定义源向导；AI 辅助区仅添加时显示，只保留一个跳转「AI 辅助」设置的按钮——引导提示词 `AI_SOURCE_PROMPT` 在该 tab：AI 把最终配置写成 vault 内 .json 文件；导入走文件选择而非粘贴；代码表 textarea 编辑按代码保留已有 `params`/`profile`——符号级参数仅能经 JSON 导入维护；导入解析 `parseImportedSources` 保留 `params`/`profiles`/`codeRules`/`searches`（含端点 `profile`）/`searchProfile`/`deadCodes`/`searchPaginate`/`bodyEncoding`/`paginate`（含三处 `allowTruncated`）等全部新字段）、`csv-source-modal.ts`（CSV 向导）、`setup-guide-modal.ts`（无启用数据源时的引导弹窗）、`script-manager-modal.ts`（脚本管理器：递归列出脚本文件夹、按子文件夹分组，`disabledScripts` 按文件夹相对路径记录；无「新建脚本」——脚本由用户自行/AI 编写后放入文件夹）、`display-overrides.ts`（共享的每卡显示覆盖组）。
- `src/cli/` + `src/mcp/server.ts` — 给外部 AI 用的独立 CLI（`cli.js`）和 MCP stdio server（`mcp-server.js`），命令实现都在 `cli/commands.ts`，两者共享。命令含 search / sources / validate / probe / validate-config（MCP 对应 `validate_config` 工具：导入前验证数据源配置 JSON——结构校验（未知字段警告 + rowKind 五值校验 + `searches`（含端点 `profile` 档位存在性）/`params`/`codeRules`（形态/正则合法性/档位存在性）/`searchProfile`/`deadCodes`（正则合法性）/`searchPaginate`/`bodyEncoding`/`paginate`（缺 `{offset}` 给 warning，三处 paginate 的 `allowTruncated` 布尔校验）/`percentScale` 校验 + csv 的 filePath/klineUrl 二选一，`--structural-only` 只跑这一步）+ testCode/全部 symbols 实测取数（默认 400 天窗口，`--days` 覆盖；干净 0 行自动加宽到约 10 年复核，有数据则 ok + note 提示疑似退市/停更，不算失败）+ 搜索模板试发（查询词取自源自己的 testCode/symbols，结果带 query 字段；模板含 `{p.*}` 且配搜索时加测一个搜索结果代码，via="search"；配了 `codeRules`/`searchProfile`/searches 端点 `profile` 的源再做接线审计——`search.audit` 离线统计未命中形态/规则重叠/声明冲突三条 warning，并按档位抽样 1 个代码实测，via="search" 带 profile 字段）；翻页截断（搜索或 K 线）未配 `allowTruncated` 时判红（search.ok=false / probe ok=false），豁免后降级 warning；`deadCodes` 命中的代码跳过探测（ok+note+warning，不判红））；密钥解析链：文件内（含同组回落）→ 参数注入（CLI `--api-key` 可重复，值 `密钥` 全局兜底或 `名称=密钥` 按名注入；`--api-key-file` 读 {"名称":"密钥"} JSON；MCP `validate_config` 用 `apiKeys` 对象参数；按名注入时组名 > 源名 > 全局兜底；另有 `STRATABOARD_API_KEY` 环境变量兜底）→ vault 同名/同组源，输出 apiKeySource（self/group/injected/vault/none）/apiKeyDonor 标明密钥来源，失败带 reason（列名拼错直接点名并列出响应实际字段）与 sample，搜索结果带 skippedRows（缺 code/name 丢行计数）与 truncated（翻页截断：实取/声明总数）；`emptyProbeReason` 区分全空 close 与部分缺失等分支，0 行且代码不在代码表、未命中 codeRules、也没有端点声明的 profile 时追加「可能不在默认接口覆盖范围内」的指向（引导补 codeRules/端点 profile 声明/符号级 params 而非改映射），`missingClose` 在探测成功时也升为 warning（`truncated` 未豁免则直接判红）；probe_data 输出含 dropped 丢行统计，取数经 symbols.db 旁表读取端点声明的 profile）。插件**无内置 AI 助手**：外部 AI 走 CLI/MCP + `ai-guide.ts`；UI 里的「AI 辅助」一律是一键复制提示词（提示词含契约与合规规则），由用户贴给自己的 AI。
- `src/modules/ai-guide.ts` — 外部 AI 的卡片编写指南（纯字符串模板 + `renderAiGuide` 路径填充）；展示在设置页「AI 辅助」tab（可复制全文），MCP 经 `get_card_guide` 工具返回；不写入 vault（main.ts 会把旧版留在卡片库里的指南文件清理掉）。
- `src/i18n.ts` — 中英双语。约定：**中文原文即字典 key**，所有用户可见字符串走 `t("中文原文")`，英文在 `EN` map。命令名是加载时注册的，切语言需重载插件。
- `styles.css` — 全部样式。卡片和工具栏用 `fc-hermes` 作用域类：固定深色配色，与 Obsidian 主题无关（除非卡片显式设浅色主题）。图例背景透明度走 `--fc-legend-opacity` CSS 变量。

## Working conventions

- **语言**：代码注释用英文（UI 标签和领域词可用中文）；UI 字符串用中文；设计文档用中文。与所在文件保持一致。
- **设计决策**：`IMPLEMENTATION.md` 里有已定稿（"已拍板"）的决策，不要重开讨论。没有独立设计稿，UI 代码本身就是参考。
- **Canvas 交互模型**很微妙（拖节点 / 双击进入图表模式 / 再双击进设置三层）。改卡片事件处理前，先读 `src/main.ts` `QuoteCodeBlockRenderer` 里解释为何监听挂在 document 捕获阶段的注释。
- 根目录 `app.js` 是 Obsidian 打包代码的参考副本，不参与构建。`.od-skills/` 是作者本地技能，与插件无关。
- **兼容性基准**：仓库外（用户笔记目录）有一套「兼容性基准」夹具（13 格形状矩阵，覆盖各 rowKind/编码/翻页形态），改适配器（quote-format-parsers / custom-quote-client 等）后应重跑 `python3 run.py`——路径 `<vault>/编程与人工智能/编程 Coding/我的项目/StrataBoard/兼容性基准/`。

## Security considerations

- 根目录 `data.json` 是含真实密钥的设置快照，已 gitignored（`data.json`、`cache/`、`*.db`、`sql-wasm.wasm`、`main.js` 均在忽略列表）。绝不提交密钥或缓存数据库。
- TradingView widget 卡按设计嵌入第三方 HTML/JS；widget 代码视为不可信输入，只在 widget 渲染器的沙箱方式内透传。
