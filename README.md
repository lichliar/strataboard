# Financial Canvas

An Obsidian plugin that brings financial data cards to your Canvas whiteboard.

## Features

- Insert K-line and line-chart cards directly onto Obsidian Canvas.
- Data powered by [Tushare Pro](https://tushare.pro).
- Supports stocks, funds, and indices at daily / weekly / monthly frequency.
- Local JSON cache with incremental updates.
- Symbol search with lazy-loaded local index.
- Floating Canvas toolbar + command palette integration.
- Customizable chart theme and rise/fall colors.
- Per-card YAML overrides for chart type, theme, layout, and scale.

## Project layout

- Source code lives in `strataboard/` (this project folder).
- Compiled/runtime artifacts (`main.js`, `manifest.json`, `styles.css`, `versions.json`) are copied to the Obsidian plugin directory on build:
  `/Users/izzy/Nutstore Files/荔枝-知识中枢/.obsidian/plugins/obsidian-financial-canvas/`

## Installation

1. Build the plugin from the `strataboard/` project folder.
2. Ensure the compiled files are present in your vault's `.obsidian/plugins/obsidian-financial-canvas/` directory.
3. Enable the plugin in Obsidian.
4. Open plugin settings and enter your Tushare Pro token.

## Usage

### Create a card

- Click the floating toolbar button on a Canvas, or
- Use the command palette: **Insert financial card**, or
- Right-click on an empty area of a Canvas.

Search for a symbol (e.g., "平安银行" or "000001"), select it, and a card will be created in the `金融卡片/` folder and placed on the Canvas.

### Card source

Each card is a markdown file containing a `tushare` code block:

```markdown
```tushare
symbol: 000001.SZ
type: stock
freq: D
range: 2025-07-06~2026-07-06
height: 500
chartType: candlestick
theme: auto
visibleRange: 3m
logScale: false
showHeader: true
showMarketData: true
riseColor: "#ef4444"
fallColor: "#22c55e"
headerCollapsed: true
```
```

You can edit this code block directly to change the card.

| Field | Description |
|---|---|
| `symbol` | Tushare symbol, e.g. `000001.SZ`. |
| `type` | Asset type: `stock`, `fund`, or `index`. |
| `freq` | Frequency: `D` (daily), `W` (weekly), or `M` (monthly). |
| `range` | Date range to fetch in `yyyy-mm-dd~yyyy-mm-dd` format. You can also use shortcuts `1y`, `3y`, `5y`, `ytd`, or `max`. Default: roughly 1 year up to today. |
| `height` | Chart height in pixels. Default: `400`. |
| `chartType` | Per-card chart type: `candlestick` or `line`. |
| `theme` | Per-card theme: `auto`, `dark`, or `light`. |
| `riseColor` | Per-card rising candle color. |
| `fallColor` | Per-card falling candle color. |
| `showHeader` | Show the header block. Default: `true`. |
| `showMarketData` | Show the market-data row inside the header. Default: `true`. |
| `headerCollapsed` | Collapse OHLC and market-data rows by default. Default: `false`. |
| `visibleRange` | Initial viewport: `1m`, `3m`, `6m`, `1y`, `ytd`, or `max`. Omit to fit all data. |
| `logScale` | Use logarithmic price scale. Default: `false`. |

### Refresh data

- Hover over a card and click the refresh icon.
- Use the toolbar **Refresh all cards** button.
- Data refreshes automatically when you open a card or Canvas (can be disabled in settings).

### Switch frequency

Hover over a card and click the frequency switcher to create a new card at daily / weekly / monthly frequency, placed next to the original.

## Settings

| Setting | Description |
|---|---|
| Tushare Token | Your Tushare Pro API token. |
| Card Library Path | Folder where card markdown files are stored. Default: `金融卡片/`. |
| Data Cache Path | Folder where downloaded OHLCV data is cached. |
| Symbol Cache Path | Folder where symbol lists are cached. |
| Auto Refresh on Open | Automatically refresh cards when opened. |
| Default Range | Default date range for new cards. Accepts `yyyy-mm-dd~yyyy-mm-dd` or shortcuts `1y`, `3y`, `5y`, `ytd`, `max`. Default: `1y`. |
| Default Frequency | Default K-line frequency for new cards: `D`, `W`, or `M`. |
| Chart Theme | Follow Obsidian theme, or force dark/light. |
| Rise / Fall Color | Candle colors. Defaults to Chinese A-share convention (red rise, green fall). |
| Default Chart Height | Default total chart height in pixels for new cards. |
| Toolbar Position | Corner of the Canvas where the toolbar floats. |

## Development

```bash
cd strataboard
npm install
npm run build
```

`npm run build` compiles `main.js` and copies `manifest.json`, `styles.css`, and `versions.json` into the Obsidian plugin directory.

## License

MIT
