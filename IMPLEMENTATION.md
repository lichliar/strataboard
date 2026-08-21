# StrataBoard UI/UX 重设计 · 实现清单

> **唯一设计事实源**：`strataboard-wireframe.html`（仓库根目录，浏览器直接打开）。
> 所有字段名、文案、控件状态（错误 / 禁用 / 打开态 / 亮暗双主题）以线框图为准。
> **设计变更先改线框图，再改代码**，不要两边各自漂移。
>
> 本文档面向 Claude Code / Kimi CLI 等编码代理：每个阶段给出线框图锚点（section id）、
> 涉及文件、任务拆解、验收标准。建议**一次只做一个阶段**，提示词模板见文末。

---

## 阶段 0 · 样式基座（设计 token）

**线框图锚点**：文件顶部 `:root` 的 OKLch 变量与 `.wf-*` 类系统

**涉及文件**：`styles.css`

- [ ] 把线框图的六 token（`--bg / --surface / --fg / --muted / --border / --accent`，OKLch）映射到 Obsidian CSS 变量体系（`--background-primary` 等），亮 / 暗双主题都要覆盖
- [ ] 统一控件配方（线框图内联样式即规范）：chips、分段控件（segmented）、步进器（stepper）、开关（toggle）、色板（swatch）、检测标签（detected pill）、错误态（红色描边 `oklch(58% 0.2 25)` + 提示 `oklch(52% 0.19 25)`）
- [ ] 数字统一 `font-variant-numeric: tabular-nums`；代码 / 密钥 / 代码号用等宽字体

**验收**：Obsidian 亮 / 暗主题切换后，卡片与弹窗不出现未覆盖的硬编码颜色。

---

## 阶段 1 · 设置界面

**线框图锚点**：`#screen-settings`

**涉及文件**：`src/settings.ts`（界面 + `StrataBoardSettings` 字段）、`data.json`（存量数据迁移）

- [ ] **数据源设置页签 · 新增数据源**：在 Tushare / FRED 密钥行下方加「常用数据源 · 按需启用」组
  - Yahoo Finance（美股 / ETF / 全球指数）、东方财富（A股 / 港股 / 基金）：免密钥，启用开关
  - Alpha Vantage（免费额度 25 次/天）、Polygon.io（付费）：API Key 输入
  - 数据模型：每个源需要 `enabled` 标志 + 可选 `apiKey` 字段
  - ⚠️ 本阶段只落设置项与字段；各源的 adapter 另排期（见「缓做清单」）
- [ ] **数据保存路径 × 5 改为下拉**：从仓库已有文件夹中选择（folder suggester，可搜索、支持二级目录），菜单底部保留「手动输入路径…」入口；替换现有纯文本输入
- [ ] **图表设置页签 · 去重精简**（已拍板）：删除 7 个与统合编辑弹窗重复的字段 —— `defaultRange / defaultFreq / chartTheme / chartType / defaultChartHeight / riseColor / fallColor`；仅保留 `autoRefreshOnOpen`。卡片级配置随卡片保存，新卡片用代码内置默认值
  - 迁移：`data.json` 里的旧字段可直接弃读（个人项目无需迁移逻辑），但删除字段前全局搜索确认没有 renderer 在读
- [ ] 其余页签（TradingView Widgets / 组件设置 / 工具栏设置）保持不变

**验收**：设置页结构与线框图 `#screen-settings` 一致；删掉 `chartTheme` 等字段后编译无残留引用。

---

## 阶段 2 · 统合编辑弹窗（资产数据卡）

**线框图锚点**：`#screen-unified`

**涉及文件**：`src/ui/tushare-card-edit-modal.ts` + `src/ui/fred-card-edit-modal.ts`（合并为统合弹窗）、`src/modules/card-spec.ts`、`src/types.ts`、`src/modules/chart-card-base.ts`（渲染层高宽/出血）

- [ ] **两步结构**：先选数据源（Tushare / FRED，选项从设置中**已启用**的数据源动态生成），再按数据源切换表单
- [ ] **Tushare 三子页**：基础设置（代码 / 周期 / 范围 / 高度(px) / 面板比例）、显示设置（主题 / 图表类型 / 涨色跌色 / 显示标题 / 显示市场数据 / 可见范围 / 对数坐标）、均线系统
- [ ] **显示设置 · Canvas 显示逻辑组**（新增）：宽度自适应（跟随 Canvas 节点宽度）、高度自适应（开启后「基础设置」高度字段失效，UI 上置灰）、出血尺寸（步进器，默认 8px，卡片内容与节点边缘留白）
- [ ] spec 新增持久化字段：`widthAuto / heightAuto / bleed`；渲染层在 Canvas 节点 resize 时应用
- [ ] 保存路径字段同样用 folder suggester 下拉（复用阶段 1 的组件）

**验收**：新旧卡片都能打开统合弹窗；三子页切换、Canvas 显示逻辑开关联动与线框图一致；旧格式卡片 markdown 能正常读取（向后兼容）。

---

## 阶段 3 · 数据计算卡

**线框图锚点**：`#screen-calc`

**涉及文件**：`src/ui/spread-edit-modal.ts`（重写为数据计算卡弹窗）、`src/ui/series-ref-editor.ts`、`src/modules/series-spec.ts`（解析 / 序列化）、`src/modules/series-adapter.ts`（求值）

- [ ] **表达式输入**：支持 `+ − × /` 与括号，示例 `A+B`、`A/B`、`(A+B)/2`、`A+C/B`；系列可动态新增（A / B / C / D…），每个系列独立选数据源与标的
- [ ] **实时校验**（输入即触发）：括号配对、运算符位置、系列代号是否已定义
- [ ] **错误反馈**：输入框红色描边 + 行内错误提示（警告三角 SVG + 具体原因，如「公式错误：括号不匹配 —『(』缺少对应的『)』」）+ **保存按钮置灰禁用**
- [ ] 数据模型：从「两系列相减」升级为表达式 AST；旧差值卡片迁移为 `A-B`
- [ ] 三子页结构（基础 / 显示 / Canvas 逻辑）与统合弹窗保持一致

**验收**：线框图演示的 `A+(B` 错误态逐像素可复现；合法公式求值结果正确（含优先级与括号）。

---

## 阶段 4 · TradingView Widget 弹窗

**线框图锚点**：`#screen-widget`

**涉及文件**：`src/ui/widget-input-modal.ts`（重写）、`src/modules/widget-parser.ts`（扩展）

- [ ] 标题改为「**插入TradingView Widget**」（当前为「插入 HTML / TradingView 小组件」）
- [ ] **双子页面**：
  - 「插入数据」：标题（从代码 `symbol` 字段自动生成，手动修改后不再被覆盖，带「自动识别」徽标）/ 组件代码（等宽，附 TradingView 组件文档链接）/ 识别结果标签 / 常用组件模板 chips（高级图表 / 迷你走势 / 市场概览 / 股票筛选器）/ 保存路径（folder suggester）
  - 「可修改参数」：从代码提取的参数（显示周期 `interval`、主题 `theme`、侧边工具栏 `hide_side_toolbar`），修改后**双向写回**组件代码；无法解析时显示「未识别到可修改参数」
- [ ] 解析器支持三种嵌入格式：`tv.js + new TradingView.widget({...})` 配置对象、`embed-widget-*.js` 内联 JSON、iframe URL query 参数；任意 HTML 降级为手动编辑

**验收**：粘贴三种格式的真实 TradingView 代码均能识别标题与参数；改动参数后代码同步更新。

---

## 阶段 5 · Canvas 工具栏

**线框图锚点**：`#screen-toolbar`

**涉及文件**：`src/modules/toolbar.ts`、`src/main.ts`（命令注册）

- [ ] **菜单重组**（当前与线框图不一致，重点）：
  - 「插入数据」：插入资产数据 / 数据叠加 / 数据计算（当前 FRED 是独立项，需并入资产数据的统合入口）
  - 「小组件」：插入TradingView Widget（当前菜单里的「TradingView 小组件文档」链接移入 Widget 弹窗，见阶段 4）
  - 「插入组件」：日历
  - 三个菜单**互相独立**，不可混淆
- [ ] 「全部刷新」与「设置」（齿轮 SVG）**置底**；设置按钮调 `app.setting.open()` + `openTabById('strataboard')`
- [ ] 竖向、固定左侧、可拖拽（位置记忆已有 `toolbarPosition/Offset`，确认仍工作）；顶部 SVG Logo 点击展开 / 折叠，折叠态收缩到 Logo 附近
- [ ] 全部按钮纯 SVG 图标（无文字标签），图标视觉对齐线框图

**验收**：展开 / 折叠两态与线框图两列演示一致；齿轮按钮直达插件设置页。

---

## 阶段 6 · 其余界面收尾

- [ ] **卡片阅读视图**（`#screen-card`）：`src/modules/chart-renderer.ts` / `series-chart-renderer.ts` 卡片工具栏改 SVG 图标；loading / retry 状态对齐线框图
- [ ] **日历弹窗**（`#screen-calendar`）：改为月宫格选择器；文字左对齐，亮暗布局一致；`src/modules/calendar-renderer.ts` / `daily-notes.ts`
- [ ] **资产叠加卡**（`#screen-overlay`）：三子页结构与统合弹窗对齐（无公式输入，不需要错误态）

---

## 已拍板的设计决策（实现时不要重新纠结）

1. **配置去重**：周期 / 范围 / 主题 / 图表类型 / 涨跌色 / 高度只存在于卡片编辑弹窗（随卡片保存），设置页不提供全局默认
2. **高度自适应开启时**，基础设置的高度字段失效并置灰
3. **路径输入**一律 folder suggester 下拉 + 手动输入兜底
4. **公式错误** = 红描边 + 行内提示 + 保存禁用，三件套缺一不可
5. **数据源选择器**从设置中已启用的源动态生成，不写死 Tushare / FRED
6. **新数据源能力差异**（周期 / 字段限制，如 Alpha Vantage 无 A 股）：弹窗的周期 / 范围选项按数据源过滤

## 缓做 / 不做清单

- 新数据源 adapter（Yahoo Finance / 东方财富 / Alpha Vantage / Polygon）：阶段 1 只落设置项；adapter 各需处理周期与字段映射，建议单独排期、逐个接入
- FRED / 股票代码**搜索弹窗**的线框图尚未设计：现有 `fred-search-modal.ts` / `symbol-search-modal.ts` 维持现状，后续补设计再改

## 给编码代理的提示词模板

```
对照 strataboard-wireframe.html 的 #screen-xxx 区块实现 <界面名>。
涉及文件：<见 IMPLEMENTATION.md 阶段 N>。
字段名、文案、控件状态以线框图为准；设计决策见 IMPLEMENTATION.md「已拍板」一节。
完成后在 Obsidian 里实际打开验证亮 / 暗双主题。
```

**构建与部署**：`npm run build`（esbuild）；部署目标见 `scripts/deploy-target.mjs`，可用 `OBSIDIAN_PLUGIN_DIR` 环境变量覆盖。
