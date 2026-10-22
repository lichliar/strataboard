## 使用

建卡入口：
- 在obsidian原生canvas画布上使用**浮动工具栏**
- 在普通的 Markdown 文档中右键「插入卡片」

### 日常使用
- 拖动卡片标题移动卡片；双击进入图表交互模式（滚轮缩放、拖动平移），再次双击打开统一的编辑弹窗——周期、时间范围、图表类型、主题按卡片独立保存；涨跌色是插件全局设置，卡片高度在 Canvas 中跟随节点大小、在笔记中为固定基准高（400px）。
- 熟悉格式后也可以直接编辑卡片文件里的 YAML，保存即生效。
- 数据缓存在本地 SQLite，只增量拉取新数据；点卡片右上角的刷新按钮强制更新，或在设置中打开「自动刷新」。
- 对比卡把多条序列（行情 / 宏观序列，甚至另一张卡片）画进同一张图；计算卡用字母引用各序列写四则表达式，如 `A-B`、`(A+B)/2`。
- 不再需要的数据可以在 设置 → 高级 → 清理维护 里扫描并清理孤儿卡片文件与过期缓存。

## 数据源
**本插件不内置任何数据源，仅作为数据接入框架与展示工具：所有数据都来自你在设置页自行配置的 REST/JSON 接口或 vault 内的 CSV 文件。本插件不支持高频数据获取，仅支持日线级别的数据，方便分析和学习使用。**

- 自定义数据源：在设置页自行配置任意 RESTful / JSON 数据接口（URL 模板 + 响应格式），或 vault 内的 CSV 文件
- 脚本产物 CSV：自己写的 Python 脚本把计算结果输出到脚本文件夹的 `output/` 子目录，插件自动注册为数据源（见下「脚本处理」）

### 自定义数据源

你可以在 设置 → 数据源 中自行添加任意返回 JSON 的 RESTful 数据接口（各类官方公开 API 一般都可按通用契约接入），添加后即可建数据卡，也可用于对比卡与计算卡。

数据源只能在设置页逐项创建和编辑，不提供配置导入/导出。AI 可以指导你填写字段，但不要把 API Key 发给 AI，也不要让 AI 直接修改插件的 `data.json`。

每个数据源需要填写：

- **名称**：显示在选择器、工具栏与卡片文件名中
- **响应格式**：内置常见行情 JSON 格式的自动识别，或通用 JSON 手动映射（见下）
- **K 线接口 URL**：支持占位符 `{code}`（代码）、`{start}` / `{end}`（YYYYMMDD）、`{startIso}` / `{endIso}`（YYYY-MM-DD）、`{apiKey}`（密钥）
- **凭据（API Key）**（可选）：只在「凭据」字段填写密钥；URL、请求体和 Header 使用 `{apiKey}` 占位符，不要写入明文。密钥保存在 Obsidian 的 SecretStorage 中，插件 `data.json` 只保存凭据引用、不含密钥本身，请使用最小权限密钥
- **请求方式**：GET（默认）或 POST；POST 时填写请求体模板（同一套占位符，自动带 `Content-Type: application/json`）
- **搜索接口**（可选）：GET 搜索填搜索 URL（占位符 `{query}`）；POST 搜索改填搜索请求体模板（`{query}` / `{apiKey}` 占位，URL 取搜索 URL、未配则复用 K 线 URL）；模板不含 `{query}` 时插件把整表拉回本地过滤（结果有缓存）。都不配则该源只能手工录入代码建卡
- **通用 JSON 映射**（仅通用 JSON 格式）：行数组路径（如 `data.klines`）、行类型（数组按列序号 / 对象按字段名 / `fields` 按列名数组寻址，如 `data.fields` + `data.items`）、日期与开高低收/成交量/成交额的列位置、可选的业务错误透传（`errorPath` / `errorMessagePath`），以及可选的搜索结果映射
- **兼容模式**（可选）：个别站点在 Obsidian 默认网络栈下连接失败时，改用 Node https 发送请求

### 脚本处理

自己写 Python 脚本做更复杂的数据处理，脚本把结果写成 CSV 放进脚本文件夹的 `output/` 子目录（建议与脚本同名：`脚本/foo.py` → `脚本/output/foo.csv`），插件自动把它注册为数据源——之后即可像其他数据源一样建数据卡、对比卡、计算卡；产物更新后相关缓存自动失效、卡片自动重绘。

- **运行独立于插件**：插件不提供定时调度，需要定时请用 cron / launchd / 任务计划自己跑；也可以在 工具栏 → 更多 → 本地脚本（或命令面板「打开本地脚本管理」）里手动「立即运行」。首次运行、文件改名或内容变化后，插件会展示脚本绝对路径、解释器和工作目录并要求再次确认。
- **CSV 契约**：UTF-8、首行表头；两种格式二选一——宽表（推荐，首列是日期，其余每个数值列是一条序列，列名即代码，空值表示该日无数据）或单序列 OHLCV（表头含 `date,open,high,low,close`）。
- **权限与合规边界**：Python 脚本以当前系统用户完整权限运行，可联网、读写文件和启动进程；确认弹窗不能替代代码审查。脚本的数据获取行为及授权关系由用户负责。脚本功能不适合高频数据、不作为批量下载工具；建议增量抓取、请求间隔 ≥ 1 秒。

### 自定义技术指标

插件不内置技术指标。把你原创、获授权或许可证允许使用的 `.js` 指标放进指标文件夹，再在数据卡中选择。指标只获得行情、参数与 `oak` 计算 API，并受执行时间和输出数量限制；不提供网络、文件、DOM、Obsidian API 或 `require`。插件不生成、审核、验证或背书指标中的买卖标记。

## 用外部 AI Agent 操作本插件（MCP / CLI）

本插件不内置 AI 助手，也不发送模型请求。首次按下面方式接入自己的外部 AI agent（Codex、Claude Code 等）后，Agent 即可查符号、列数据源、校验卡片、探测数据、获取指南和渲染图片：

`cli.js` 和 `mcp-server.js` 是可选文件，插件不会自行下载或更新。从与插件版本号完全一致的 [GitHub Release](../../releases) 手动下载后，放入 `<vault 路径>/.obsidian/plugins/strataboard/`。

- **MCP server（推荐）**：以 stdio 方式在你的 AI agent 中注册 `node <插件目录>/mcp-server.js --vault <vault 路径>`。提供 11 个工具：`search_symbols` / `list_sources` / `list_indicator_groups` / `validate_cards` / `probe_data` / `get_card_guide` / `get_script_guide` / `get_indicator_guide` / `get_source_guide` / `render_card_png` / `render_doc_images`。
- **CLI**：`node <插件目录>/cli.js <命令> [--vault <vault 路径>]`，提供 8 个命令：`guide` / `search` / `sources` / `groups` / `validate` / `probe` / `render-card` / `render-doc`，全部输出 JSON，适合脚本与 Agent 调用。

Codex 配置示例（`~/.codex/config.toml`）：

```toml
[mcp_servers.strataboard]
command = "node"
args = ["<插件目录>/mcp-server.js", "--vault", "<vault 路径>"]
```

其他 agent（JSON 配置）：

```json
{
  "mcpServers": {
    "strataboard": { "command": "node", "args": ["<插件目录>/mcp-server.js", "--vault", "<vault 路径>"] }
  }
}
```

插件目录即 `<vault 路径>/.obsidian/plugins/strataboard`；`--vault` 缺省时读环境变量 `STRATABOARD_VAULT`，再从当前目录向上查找含 `.obsidian` 的目录。

首次接入后，Agent 会按任务自动读取指南：MCP 使用 `get_source_guide` / `get_card_guide` / `get_script_guide` / `get_indicator_guide`，CLI 使用 `guide source` / `guide card` / `guide script` / `guide indicator`，无需你复制、粘贴提示词。如果 Agent 没有自动读取，先检查 MCP 是否连接成功；也可让它直接运行上述 CLI `guide` 命令作为备用入口。

数据源只能由你在设置页逐项确认并保存，外部 AI 不能导入配置或直接修改插件的 `data.json`。API Key 只由你填入数据源弹窗的「凭据」字段，不要发给 AI；密钥不会进入 AI 上下文。
