<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/LOGO/logo-text-dark.svg">
    <img src="docs/LOGO/logo-text-dark.svg" width="520" alt="StrataBoard">
  </picture>
</p>

<p align="center">
 在Obsidian里插入金融数据。Agent-Native，内置MCP/CLI，建议搭配Agent使用。<br>
  
</p>


## 功能

**卡片类型**
- **金融数据卡**：单一数据，由你配置的自定义数据源驱动。支持常见数据类型。支持日/周/月/季/年周期，**本插件不支持分钟/小时级别的高频数据**。
- **数据叠加卡**：多数据序列同图对比；
- **数据计算卡**：对数据序列做简单的四则运算；
- **脚本计算**：对数据序列做更复杂的运算；支持csv数据表，通过脚本计算得出的csv数据表可直接注册为数据源；
- **TradingView 组件**：可以直接在obsidian内插入TradingView Widgets组件；
- **日历与日记功能**：与obsidian基础功能联动，支持日历/日记功能。单击数据卡某一天的K线亦可建立当天日记。

**技术指标**
- 内置 15 个常用技术指标（MA / EMA / BOLL / MACD / RSI / KDJ 等）；
- 支持自定义 .js 指标文件，可让 AI 辅助编写或移植 TradingView Pine Script。

**Agent-Native**
- 内置MCP/CLI，可让Agent辅助**设置数据源**，**增删改查**，编写脚本与指标。
- obsidian内建议搭配 [claudian](https://github.com/yishentu/claudian) 使用；
- 也可以使用自己的AI Agent;


## 演示

详见 [演示](docs/演示.md)。

![白板组合](docs/图片/白板组合.png)


## 安装

本插件已上架obsidian**社区插件市场**。

### 方式一：从obsidian社区插件市场中下载（推荐）

1. 打开设置-第三方插件-关闭安全模式
2. 社区插件市场搜索 “StrataBoard”
3. 首次启用（或更新）时插件会自动从 GitHub release 下载资源文件（`sql-wasm.wasm` / `cli.js` / `mcp-server.js`）；若下载失败可按方式二手动补齐。

### 方式二：下载 Release

1. 从 [Releases](../../releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`、`sql-wasm.wasm` 四个文件（需要 MCP/CLI 的话再下载 `cli.js`、`mcp-server.js`）。
2. 在你的库目录下新建文件夹 `.obsidian/plugins/strataboard/`，把文件放进去。
3. 重启 Obsidian，在 设置 → 第三方插件 中启用 **StrataBoard**。

**本插件不内置任何数据源，首次使用需自行配置数据接口（REST/JSON）或 vault 内的 CSV 文件——可以让 AI 辅助生成配置（无可用数据源时，「插入图表」会弹出设置引导）。**

## 使用
详见 [如何使用](docs/如何使用%20how%20to%20use.md)


## 免责声明

- 本插件仅作为数据接入框架与展示工具，**不内置任何数据源**；所有第三方接口均由用户自行配置/调用，数据版权归原平台所有，不得用于商业用途。
- 本插件仅供个人学习与研究使用，**不构成任何投资建议**。
- 除你自行配置的数据接口与 TradingView 组件外，插件不会向任何服务器发送数据；API 凭据与缓存数据仅保存在本地。

完整版见 [免责声明](docs/免责声明.md)。

## License
MIT（见 [LICENSE](LICENSE)）。第三方依赖的许可见 [THIRD-PARTY-LICENSES.md](docs/THIRD-PARTY-LICENSES.md)。

## Buy me a 奶茶吧～（赞赏 / 打赏）

如果这个插件对你有帮助，可以请我喝杯奶茶：

| 微信赞赏码 | 支付宝赞赏码 |
| :---: | :---: |
| <img src="docs/二维码/微信赞赏码.jpg" width="240" alt="微信赞赏码"> | <img src="docs/二维码/支付宝赞赏码.jpg" width="240" alt="支付宝赞赏码"> |
