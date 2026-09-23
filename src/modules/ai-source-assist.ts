import type { CustomSourceDef } from "../types";
import { formatDate } from "../utils/date";
import { httpRequest } from "./http";
import type { AiTool } from "./ai-tools";

// Scoped agent for the custom-source setup wizard (设置 → 自定义数据源 →
// 「2. AI 辅助设置」). Unlike the general AI 助手, this loop has exactly two
// capabilities: fetch_url to verify candidate endpoints against the live
// internet, and apply_source_config to write a config into the wizard FORM
// (never persisted directly — the user still reviews and clicks 保存).
// The system prompt names no concrete endpoints: the user's own AI picks
// them, keeping the plugin a pure data-access framework.

// Per-tool-result cap; the wizard's probe responses can be huge.
const RESULT_CHAR_LIMIT = 2500;

function truncate(text: string): string {
  if (text.length <= RESULT_CHAR_LIMIT) return text;
  return `${text.slice(0, RESULT_CHAR_LIMIT)}\n…（响应过长已截断，共 ${text.length} 字符）`;
}

export interface SourceAssistContext {
  // Current wizard form state, re-read on every send so the prompt carries
  // the latest edits / AI applies.
  currentDefJson: string;
  // Last probe outcome ("识别为…/检测失败：…"), empty when never probed.
  probeSummary: string;
  // Truncated raw response of the last probe (fix scenario), may be empty.
  sampleText: string;
}

export function buildSourceAssistSystemPrompt(context: SourceAssistContext): string {
  const today = formatDate(new Date());
  return `你是 StrataBoard（Obsidian 金融数据插件）设置向导里的「自定义数据源配置助手」。今天是 ${today}（YYYYMMDD）。用户正在配置一个自定义数据接口，你的任务是：根据用户想要的数据，找到可用的免费接口并验证，把配置直接写入向导表单；或者修复表单里检测失败的现有配置。

# 工具调用协议

你可以调用工具。需要调用时，在回复中输出一个独立的 json 代码块，格式：
\`\`\`json
{"tool": "工具名", "args": {...}}
\`\`\`
- 一轮可以输出多个工具调用块；工具结果会在下一轮以用户消息的形式返回给你。
- 不需要工具时直接输出纯文本回答（不再带任何代码块）。
- 不要在同一轮里既给最终结论又调用工具：先调用工具，等结果回来再总结。

# 可用工具

- fetch_url：实际请求一个 URL，返回 HTTP 状态码和响应内容（有截断）。用于验证候选接口是否真的可用、查看真实响应结构。
  参数：url: 完整 URL（必填，把代码和日期参数填成真实值）
- apply_source_config：把一份数据源配置写入向导表单。写入后表单会自动请求接口并做格式识别，工具结果会返回检测结论（识别出的格式、解析出的数据行数与起止日期，或失败原因）。解析失败时根据返回信息修正后重试。
  参数：def: 完整的数据源定义 JSON（必填，格式见下）

# 数据源定义格式（def 参数）

- name：数据源名称（显示在选择器和卡片文件名中），必填
- format："tencent"（腾讯行情响应格式）| "eastmoney"（东方财富响应格式）| "json"（通用 JSON，必须同时提供 jsonMap）
- klineUrl：K 线接口 URL 模板，必填。{code} 为证券代码占位符；{start}/{end} 为 YYYYMMDD 起止日期；{startIso}/{endIso} 为 YYYY-MM-DD 起止日期。固定报表类接口（一个 URL 返回整张表）可以不含 {code}
- searchUrl：可选，按代码或名称搜索的 URL 模板，{query} 为搜索词占位符
- testCode：可选，接口检测用的示例代码（klineUrl 含 {code} 时必填）
- jsonMap（仅 format 为 "json" 时）：
  {
    "rowsPath": "数据行数组在响应 JSON 中的点号路径，如 data.list；响应顶层就是数组时为空字符串",
    "rowKind": "object 或 array（每行数据是对象还是数组）",
    "cols": {
      "date": "日期列：object 行填字段名，array 行填从 0 开始的列序号（字符串）",
      "close": "收盘价/数值列",
      "open": "开盘价列，没有则填空字符串",
      "high": "最高价列，没有则填空字符串",
      "low": "最低价列，没有则填空字符串",
      "vol": "成交量列，没有则填空字符串",
      "amount": "成交额列，可选，没有则省略该字段"
    }
  }
  date 和 close 必填；单值序列（收益率、宏观指标等）把数值列填给 close 即可。日期可以是 ISO 日期时间、YYYYMMDD 或时间戳。
  object 行的 cols 里可以填 "{code}"：取数时按请求的代码选列——这是固定报表宽表（一个 URL 返回整张表、每列一个序列）的接法，此时 testCode 用复合代码「URL部分@映射列名」，如 REPORT_NAME@COL_NAME。
- symbols：可选，静态代码表，形如 [{"code": "CODE_10Y", "name": "十年期国债收益率"}]，配置后建卡时可按名称选择

# 工作方式

1. 先弄清用户想要什么数据（名称、市场、频率）；用户描述模糊时用最常见的理解继续，并在回答里说明你的假设。
2. 挑选候选接口：必须无需登录、免费、浏览器地址栏直接打开即可返回数据的 HTTP GET 接口；不要推荐需要注册 token 或付费的接口。
3. 写入配置前，必须先用 fetch_url 用真实参数请求候选 URL，确认返回了数据并看清响应结构，再决定 format 和 jsonMap。
4. 用 apply_source_config 写入表单；若返回的检测结论是失败或未解析出数据，根据其中的错误信息/响应内容修正配置后重试，直到成功或确认该接口不可行（不可行时如实告诉用户原因，并说明需要在表单里手动补充什么）。
5. 在 apply_source_config 返回检测成功之前，不要向用户宣称配置已完成。用户点「保存」时会以最近一次检测结果为准，检测未通过的配置保存不了——所以你必须把配置调到检测成功再收尾。
6. 全程用中文回答。成功后简要说明：数据源名称、接口提供方、数据内容，并提醒用户核对上方「1. 配置」分区后点击「保存」——你的修改在保存前不会生效。

# 当前表单状态

${context.currentDefJson || "（空白表单，用户尚未填写任何内容）"}

# 最近一次自动检测

${context.probeSummary || "（尚未检测过）"}
${context.sampleText ? `\n# 最近一次接口实际响应（有截断）\n\n${context.sampleText}\n` : ""}`;
}

export interface SourceAssistHooks {
  // Applies an AI-proposed def into the wizard form and re-probes the
  // endpoint; returns the detection outcome for the agent's next round.
  applyConfig: (def: Omit<CustomSourceDef, "id">) => Promise<string>;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    if (required) throw new Error(`缺少参数 ${key}`);
    return "";
  }
  return String(value).trim();
}

export function buildSourceAssistTools(hooks: SourceAssistHooks): AiTool<null>[] {
  return [
    {
      name: "fetch_url",
      description: "实际请求一个 URL，返回 HTTP 状态码和响应内容（有截断）。",
      paramsDoc: "url: 完整 URL（必填，把代码和日期参数填成真实值）",
      confirm: false,
      run: async (args) => {
        const url = str(args, "url");
        if (!/^https?:\/\//i.test(url)) throw new Error("url 必须是 http(s) 地址");
        const response = await httpRequest({ url, method: "GET" });
        return truncate(`HTTP ${response.status}\n${response.text}`);
      },
    },
    {
      name: "apply_source_config",
      description:
        "把一份数据源配置写入向导表单并自动检测，返回检测结论（识别格式、解析行数或失败原因）。只写入表单，用户确认保存后才生效。",
      paramsDoc: "def: 完整的数据源定义 JSON（必填，字段见系统提示）",
      confirm: false,
      run: async (args) => {
        const raw = args.def;
        if (typeof raw !== "object" || raw === null) throw new Error("def 必须是对象");
        const d = raw as Partial<CustomSourceDef>;
        const name = str(d as Record<string, unknown>, "name");
        const klineUrl = str(d as Record<string, unknown>, "klineUrl");
        if (d.format !== "tencent" && d.format !== "eastmoney" && d.format !== "json") {
          throw new Error(`无效的 format：${String(d.format)}`);
        }
        if (d.format === "json") {
          const map = d.jsonMap;
          if (!map || typeof map.rowsPath !== "string" || (map.rowKind !== "object" && map.rowKind !== "array")) {
            throw new Error('format 为 "json" 时必须提供 jsonMap（rowsPath、rowKind、cols）');
          }
          if (!map.cols?.date || !map.cols?.close) throw new Error("jsonMap.cols 至少需要 date 和 close 两列");
        }
        return hooks.applyConfig({
          name,
          enabled: true,
          format: d.format,
          klineUrl,
          searchUrl: typeof d.searchUrl === "string" && d.searchUrl.trim() ? d.searchUrl.trim() : undefined,
          testCode: typeof d.testCode === "string" && d.testCode.trim() ? d.testCode.trim() : undefined,
          jsonMap: d.format === "json" ? d.jsonMap : undefined,
          symbols: Array.isArray(d.symbols) ? d.symbols : undefined,
        });
      },
    },
  ];
}
