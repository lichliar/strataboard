// Guided prompt for adding a data source with AI help — shown in
// 设置 → AI 助手 (settings.ts), reused by the no-source setup guide modal
// (ui/setup-guide-modal.ts, via the re-export in ui/custom-source-modal.ts)
// and used as the system prompt of the in-plugin AI assistant's
// add-source / fix-source tasks (modules/ai/tasks.ts). It assumes the user's
// AI is already wired to the plugin through the MCP server or CLI
// (list_sources / search_symbols / probe_data / validate_cards), so instead
// of just "find me an endpoint" it walks the user through the whole setup —
// including telling them plainly when the plugin has no matching adapter and
// pointing them at the 本地脚本 CSV route instead. It deliberately names no
// concrete endpoints — the user's own AI picks one, keeping the plugin a
// pure data-access framework. The EN translation lives in i18n.ts under this
// exact string as key; keep the two in sync. Lives in modules/ (not ui/) so
// the AI task prompts stay importable without pulling in obsidian.
export const AI_SOURCE_PROMPT = `你将帮我为 Obsidian 插件 StrataBoard 配置一个「自定义数据源」。插件不内置数据源，所有接口都由用户在设置页手工配置。你已通过 MCP server 或 CLI 接入插件，可使用 list_sources、search_symbols、probe_data、validate_cards。请按以下流程协助我：

1. 先确认数据平台、标的、频率和所需字段。优先使用官方、有公开文档且用户有权访问的 REST/JSON 接口，不使用需要登录 Cookie 或未公开的抓取端点。
2. 先用 list_sources 和 search_symbols 检查现有配置；已有数据源能满足需求时不要重复添加。
3. 需要新数据源时，给出设置页各字段应填写的内容。简单 GET 接口优先给出一个包含真实示例代码和日期的完整 URL，让我粘贴到「添加数据源」弹窗，由插件生成模板并检测格式。POST、鉴权 Header、搜索接口或通用 JSON 映射则逐项说明应填写的值。
4. API 密钥不要让我发到对话中，也不要写进 URL、请求体、Header、参数、JSON 文件或脚本。密钥只由我直接填写到插件数据源弹窗的「凭据」字段（存入 Obsidian SecretStorage，不进 data.json）；其它配置需要引用密钥时只能写 {apiKey} 占位符。
5. 插件不提供数据源配置导入或导出，不要生成待导入的配置 JSON，也不要直接修改 .obsidian/plugins/strataboard/data.json。所有配置由我在设置页确认并保存。
6. 插件支持 GET/POST、JSON 响应、URL/请求体占位符、可选搜索接口和本地 CSV。接口需要登录态、Cookie、HTML/XML、多阶段请求或设置页无法表达的复杂参数时，明确告诉我不支持，并建议使用「本地脚本」输出 CSV。
7. 我保存后，用 list_sources 找到数据源 id，再用 probe_data 对示例代码做端到端验证，并根据返回的 hint 或 dropped 信息协助修正。

用我使用的语言交流；不要索取、复述或保存我的 API 密钥。`;
