// Prompt the user copies (plus their script / error output) to their own AI.
// Carries the CSV contract validated by buildScriptSourceDef (script-sources)
// plus the compliance rules, and names no concrete endpoints. Shared by
// 设置 → AI 辅助 and the MCP get_script_guide tool — which is why this module
// must stay obsidian-free (the MCP bundle aliases "obsidian" to a shim
// without TFile).
export const AI_SCRIPT_PROMPT = `我在用一个 Obsidian 插件（StrataBoard）的「本地脚本」功能：自己写 Python 脚本做数据计算，脚本把结果写成 CSV，插件自动把 CSV 注册为数据源并画成图表卡。请帮我写一个 python3 脚本，并把完整脚本内容给我。

这个脚本要做的事情：【在这里描述你想要的数据或计算；如果是修错，粘贴你的现有脚本和完整报错】

产物契约（必须遵守）：
- 输出文件写到脚本所在目录下的 output/ 子目录，文件名与脚本同名（foo.py → output/foo.csv），UTF-8 编码，首行表头；
- 三种格式选一：(1) 宽表（多条序列）：首列是日期（YYYY-MM-DD / YYYYMMDD / 时间戳均可），其余每个数值列是一条序列，列名即代码，空值表示该日无数据；(2) 单序列 OHLCV：表头含 date,open,high,low,close（vol/amount 可选）；(3) 信号表（买卖点标注）：表头 date,code,side,text（text 可省略），一行一个事件，side 用 buy/sell，一个文件可含多个标的（code 列区分）——信号表注册为「信号源」，卡片经 YAML 的 信号/signals 字段引用后在 K 线/折线上画买卖箭头；
- 日期升序或乱序均可。

合规规则（必须遵守）：
- 不高频抓取、不批量下载保存；请求间隔 ≥ 1 秒（time.sleep(1)）；
- 优先增量抓取：先读已有 CSV 的最大日期，只补之后的数据，合并去重后重写；
- 只写 output/ 目录，不改其他文件；
- 尽量只用 python3 标准库；确实需要第三方库时在脚本顶部注释写明 pip install 命令。`;
