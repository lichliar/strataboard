# AGENTS.md — StrataBoard / Financial Canvas

Guidance for AI coding agents working in this repository.

## Core principles (项目原则，必须遵守)

1. 不保留向后兼容。过时的直接删，别加兼容层、别写migration、别留fallback。

2. 选能满足当前需求的最简单实现。不要预防性抽象，不要多此一举的配置层。

3. 系统分层长。先跑通一个最小的端到端版本，再往上加东西。绝不为了未完成的复杂度拆掉能跑的东西。

4. 组件保持模块化，关注点分离。

5. 优先用成熟的、有人维护的库。没有明确理由别自己重写。

6. 先翻项目里已有的依赖能做什么，再考虑加新包或自己写。别上来就假设库里没有。

7. 架构决策往长了做。不接受"先这样以后再换"的临时方案。

8. 先看成熟产品怎么解决同一个问题，用已验证的模式，别从零发明。

9. 所有数据源都必须支持独立卡片（「插入资产数据」入口直达各自的选择器），不允许只在叠加卡/计算卡里可用。新增数据源时，独立卡、叠加卡、计算卡三条链路要同时接通。

## Project overview

Obsidian desktop plugin (id `obsidian-financial-canvas`, name "Financial Canvas") that inserts financial data cards onto Obsidian Canvas whiteboards. Desktop only (`isDesktopOnly: true`), `minAppVersion: 0.15.3`.

- Card types: K-line/line asset cards (Tushare), standalone FRED series cards, standalone Tushare China-macro series cards, multi-series overlay cards, arithmetic "spread/calc" cards (expression over lettered series, e.g. `A-B`, `(A+B)/2`), TradingView widget cards, calendar cards (linked to daily notes), timeline cards.
- Each card is a plain markdown file (default folder `金融卡片/`) containing a fenced code block (` ```tushare `, ` ```fred `, ` ```macro `, ` ```overlay `, ` ```spread `, ` ```financial-widget `, ` ```calendar `, ` ```timeline `) whose YAML body is the card spec. Specs are parsed/serialized by `src/modules/card-spec.ts` and `src/modules/series-spec.ts` (js-yaml). FRED cards/refs support an optional `transform` field (server-side `units` transformation: chg/ch1/pch/pc1/pca/cch/cca/log; absent = raw levels), cached under a `seriesId@transform` cache key.
- Data sources: Tushare Pro (A-share stocks/funds/indices OHLCV; Nanhua futures indices via `fut_index_daily` — asset type `nhindex`, symbol list hardcoded in `symbol-index.ts`; HK stocks via `hk_basic`/`hk_daily` — asset type `hk` (`hk_daily` is a separately granted permission, not a points tier); global indices via `index_global` — asset type `gbindex`, the 21 codes hardcoded in `symbol-index.ts`, ts_codes are bare with no `.XX` suffix; convertible bonds via `cb_basic`/`cb_daily` — asset type `cb`, live bonds only; futures contracts via `fut_basic`/`fut_daily` — asset type `fut`, six exchanges, non-delisted contracts only; FX pairs via `fx_obasic`/`fx_daily` — asset type `fx`, FXCM pairs, charts use the bid-side OHLC; SW industry indices via `index_classify`(src=SW2021)/`sw_daily` — asset type `sw`, published L1–L3 indices; China macro series: `cn_m` money supply, `cn_cpi`/`cn_ppi`, `cn_pmi` incl. sub-indices, `cn_gdp` incl. industry breakdown, `sf_month` social financing, `shibor_lpr` LPR, `yc_cb` ChinaBond treasury yield curve — catalog in `MACRO_SERIES_OPTIONS`, `src/types.ts`), the FRED API, and two token-free quote sources: 腾讯自选股 (asset type `tx`) and 东方财富 (asset type `em`) — thin clients in `tencent-api-client.ts` / `eastmoney-api-client.ts`, covering A-share/HK/US/index/ETF day bars plus server-side code search (`RemoteQuoteSearchModal`; there is no bulk symbol list, picked items are upserted into the symbol cache so card headers can resolve names). Tushare 美股 (`us_daily`) is NOT wired: it is a separately paid permission the current token lacks. Tokens are configured in plugin settings. Each cataloged API's minimum Tushare points are recorded on `MacroSeriesDef.points` / `ASSET_TYPE_MIN_POINTS` and surfaced in the pickers and the settings tab (`yc_cb` and `hk_daily` are separately granted permissions, not points tiers; core CPI is not available on Tushare).
- Charts are rendered with `lightweight-charts` v5. OHLCV data is cached locally in SQLite via `sql.js` (WASM); `sql-wasm.wasm` is deployed next to `main.js`.

## Technology stack

- TypeScript (strict, `strictNullChecks`, ES2022 target) → bundled by esbuild to a single CJS `main.js`.
- Runtime deps: `obsidian` API (external at build time), `lightweight-charts`, `sql.js`, `js-yaml`.
- No test framework, no linter/formatter config. `tsc -noEmit -skipLibCheck` is the only static check.

## Build, develop, deploy

- `npm run dev` — copies assets, then esbuild in watch mode (inline sourcemaps).
- `npm run build` — typecheck (`tsc -noEmit -skipLibCheck`), production esbuild, copy assets.
- `npm run version` — `version-bump.mjs` syncs `manifest.json` + `versions.json` with the npm package version (standard Obsidian release flow).
- `npm run release` — build, then `scripts/release.mjs`: refuses a dirty tree, pushes the current branch, tags `v<manifest version>`, and creates a GitHub release (via `gh`, release notes auto-generated) with `main.js` / `manifest.json` / `styles.css` / `sql-wasm.wasm` from the deploy target.
- Builds deploy **directly into an Obsidian vault's plugin directory**, not into the repo. The deploy target is defined once in `scripts/deploy-target.mjs` (currently a hard-coded absolute path under `~/Nutstore Files/`); override it with the `OBSIDIAN_PLUGIN_DIR` env var instead of editing code. esbuild writes `main.js` there; `scripts/copy-assets.mjs` copies `manifest.json`, `styles.css`, `versions.json`, and `node_modules/sql.js/dist/sql-wasm.wasm`.
- The root-level `main.js` is stale/gitignored output — the real artifact lands in the plugin dir.
- There is no automated test suite. Verification = typecheck + running the plugin in Obsidian and checking both light and dark themes.

## Code layout

- `src/main.ts` (~2k lines) — plugin entry: settings load/save, 8 commands (`insert-financial-card` opens the unified source picker — every source has its own standalone-card flow; `insert-widget-card`, `insert-calendar-card`, `insert-timeline-card`, `insert-overlay-card`, `insert-spread-card`, `insert-fred-card`, `insert-macro-card`), markdown code-block processors for each card type, canvas context menus, the md-editor「插入金融卡片」right-click entry (`insertCardIntoMd` — writes the fenced block at the cursor instead of creating a card file), refresh orchestration.
- `src/types.ts` — shared domain types: `ParsedCardSpec`, `OverlaySpec`, `SpreadSpec`, `FredCardSpec`, `SeriesRef`, `OhlcvRow`, `SymbolItem`, etc. `ASSET_TYPES` is the single source of truth for valid asset types (validators and picker dropdowns derive from it).
- `src/settings.ts` — `FinancialCanvasSettings`, defaults, and the settings tab UI.
- `src/modules/` — core logic, one concern per file:
  - `card-spec.ts` / `series-spec.ts` — YAML spec parse/serialize (single source of truth for card file format).
  - `data-adapter.ts` — quote fetch + incremental cache fill; funds, Nanhua indices, HK stocks, global indices, convertible bonds, futures, FX, SW industry indices and the tx/em sources are always cached daily and resampled to W/M at read time. `yc_cb` yields are fetched per tenor in 5-year windows (2000-row per-call cap). tx/em quotes bypass Tushare entirely (`fetchOhlcv` branches to their clients).
  - `series-adapter.ts` — resolves `SeriesRef`s (quote / macro / fred / card) to point series; `expression.ts` — arithmetic expression parsing/eval for spread cards.
  - `tushare-api-client.ts` / `fred-api-client.ts` / `tencent-api-client.ts` / `eastmoney-api-client.ts` — thin HTTP clients. The tx/em parsers are pure exported functions (`parseTencentSearch` etc.) so they can be exercised from node.
  - `sqlite-cache.ts` — primary cache backend (sql.js). `cache-store.ts` — legacy JSON cache, kept only for one-time migration into SQLite.
  - `symbol-index.ts` — lazy-loaded local symbol search index (Nanhua indices come from the hardcoded `NANHUA_INDEX_LIST`, no remote basic-info endpoint exists).
  - Renderers: `chart-renderer.ts` (also exports `CHART_PALETTE` + `buildChartOptions` — canvas colors, keep in sync with the `.fc-hermes` block in styles.css), `chart-card-base.ts` (shared card chrome + canvas display logic), `series-chart-renderer.ts`, `widget-renderer.ts`, `calendar-renderer.ts`, `timeline-renderer.ts`, `widget-parser.ts` (TradingView embed formats), `daily-notes.ts`, `canvas-locator.ts`, `toolbar.ts` (floating canvas toolbar: strata-layers logo mark toggles collapse; top-level entries — per-source ones gated by `toolbarSources`, cross-source 数据叠加/数据计算/组件 always shown — render inline Tabler SVGs from `toolbar-icons.ts` in the user-defined `toolbarOrder`; icon size `toolbarIconSize`, icon or text style via `toolbarStyle`, width draggable via `toolbarWidth`, position offset draggable), `card-service.ts` (card file create/update; chart card file names follow 资产名称-代码-数据源, e.g. 贵州茅台-sh600519-腾讯.md).
- `src/ui/` — Obsidian modals: unified card edit modal, overlay/spread/widget/timeline/calendar editors, symbol & FRED & macro & remote-quote (tx/em) search modals, folder suggester, stepper.
- `src/utils/` — `date.ts` (range presets, trading-day math), `dom.ts` (incl. `installZoomEventFix`/`toLayoutPoint` — the canvas CSS-zoom mouse-coordinate correction for lightweight-charts), `slug.ts`.
- `styles.css` — all plugin styling (deployed as-is). Card surfaces and the toolbar carry the `fc-hermes` scope class: a fixed dark palette (deep blue-gray + amber accent) applied regardless of the Obsidian theme; only a card explicitly set to 浅色主题 opts out. The plugin never renders the chart's left price axis — the library keeps its dead `<td>` in the layout table, hidden by the `td:first-child:not([colspan])` rule (the colspan guard protects the pane separator).

## Working conventions

- **Language**: code comments are in English (Chinese terms appear for UI labels and domain vocabulary); UI strings are Chinese; design docs (`IMPLEMENTATION.md`) are Chinese. Match the surrounding file.
- **Design source of truth**: `strataboard-wireframe.html` (open in a browser). Field names, copy, and control states must match the wireframe; change the wireframe first, then the code. `IMPLEMENTATION.md` holds the phased redesign plan and the "已拍板" (finalized) design decisions — do not re-litigate them.
- **Canvas interaction model** is subtle (three tiers: drag node / double-click to activate chart mode / double-click again for settings). The comments in `src/main.ts` (`TushareCodeBlockRenderer`) document why listeners sit on `document` in capture phase — read them before touching card event handling.
- Root-level `app.js` is a local copy of Obsidian's bundled app code kept for reference on internal DOM/event behavior; it is not part of the build.
- `.od-skills/` contains local agent skills used by the author (browser automation, web prototyping) — not part of the plugin.

## Security considerations

- `data.json` in the repo root is a real settings snapshot containing a live Tushare token — it is gitignored (`data.json`, `cache/`, `*.db`, `sql-wasm.wasm`, `main.js` are all ignored). Never commit tokens or cache databases.
- TradingView widget cards embed third-party HTML/JS by design; treat widget code as untrusted input that is passed through, never execute it outside the widget renderer's sandboxing approach.
