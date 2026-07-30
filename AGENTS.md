# AGENTS.md — Financial Canvas (obsidian-financial-canvas)

## Project overview

**Financial Canvas** is an Obsidian plugin that inserts financial data cards (K-line / line charts) into Obsidian Canvas whiteboards. Chart data comes from the [Tushare Pro](https://tushare.pro) API; charts are rendered with `lightweight-charts`. It also supports embedding arbitrary HTML / TradingView widgets as cards.

- Plugin ID: `obsidian-financial-canvas` (see `manifest.json`), desktop only (`isDesktopOnly: true`).
- The card is a Markdown file containing a YAML code block (```` ```tushare ````, ```` ```financial-widget ````, ```` ```calendar ````, or ```` ```timeline ````); the plugin registers Markdown code-block processors that render these blocks into interactive charts/widgets.
- Cards support stocks, funds, and indices at daily / weekly / monthly frequency, with local SQLite (sql.js) caching and incremental updates.
- Calendar cards show a month grid that aggregates the user's daily notes: days with an existing note get a marker, and clicking a day opens (or creates) the corresponding daily note.

## Technology stack

- **Language**: TypeScript (strict mode, ES2022 target, `moduleResolution: node`).
- **Runtime**: Obsidian plugin API (`obsidian` package is external at runtime, provided by the app).
- **Bundler**: esbuild (`esbuild.config.mjs`), CommonJS output, single bundle `main.js`.
- **Key dependencies**:
  - `lightweight-charts` — chart rendering.
  - `sql.js` — in-memory SQLite compiled to WASM; used for OHLCV / market-data / symbol caches. `sql-wasm.wasm` must be shipped alongside the plugin.
  - `js-yaml` — parsing card spec code blocks.
- **No test framework is set up** — there are no unit tests, no test runner, no lint config. Verification is done via `tsc` typecheck and manual testing inside Obsidian.

## Build and development commands

```bash
npm install
npm run dev      # copy assets once, then esbuild watch mode (writes directly into the plugin dir)
npm run build    # tsc -noEmit -skipLibCheck typecheck, then production bundle, then copy assets
npm run version  # bump version (version-bump.mjs) and stage manifest.json + versions.json
```

**Deployment model is unusual and important**: the build does *not* emit into the project directory. `esbuild.config.mjs` and `scripts/copy-assets.mjs` write `main.js`, `manifest.json`, `styles.css`, `versions.json`, and `sql-wasm.wasm` **directly into an Obsidian vault's plugin directory**. The target is defined in `scripts/deploy-target.mjs` and defaults to a hard-coded absolute path on the author's machine:

```
/Users/izzy/Nutstore Files/经济与政治/.obsidian/plugins/obsidian-financial-canvas
```

Override it with the `OBSIDIAN_PLUGIN_DIR` environment variable before building on any other machine:

```bash
OBSIDIAN_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/obsidian-financial-canvas" npm run build
```

Note: the README's stated deploy path (`荔枝-知识中枢` vault) is outdated — `scripts/deploy-target.mjs` is the single source of truth.

## Repository layout

- `src/main.ts` — plugin entry point. Registers the `tushare`, `financial-widget`, `calendar`, and `timeline` code-block processors, commands (`insert-financial-card`, `insert-widget-card`, `insert-calendar-card`, `insert-timeline-card`, settings shortcut), and the floating Canvas toolbar. Cards are inserted via the toolbar/commands only — there is deliberately no Canvas right-click menu, because it conflicts with Obsidian's native canvas context menu. Also contains the `MarkdownRenderChild` renderer classes.
- `src/settings.ts` — settings interface, `DEFAULT_SETTINGS`, and the settings tab UI (all settings UI strings are in Chinese).
- `src/types.ts` — shared domain types: `OhlcvRow`, `SymbolItem`, `MarketData`, `ParsedCardSpec`, `TushareResponse`, etc.
- `src/modules/` — core logic:
  - `card-spec.ts` — parse/validate/serialize the YAML card spec (`parseCardSpec`, `stringifyCardSpec`, `canonicalKey`, `buildCardFrontmatter`).
  - `card-service.ts` — create/reuse card Markdown files in the card library folder.
  - `data-adapter.ts` — orchestrates fetch + cache for OHLCV and market data; funds are always cached daily and resampled to W/M at read time.
  - `tushare-api-client.ts` — HTTP client for Tushare Pro (`requestUrl` from Obsidian) with a concurrency-limited request queue.
  - `sqlite-cache.ts` — sql.js-backed cache (three DBs: `ohlcv.db`, `market.db`, `symbols.db`). Writes only mark DBs dirty; a debounced flush (1.5 s) persists them, and `save()` on unload flushes everything. Includes one-time migration from the legacy JSON caches.
  - `cache-store.ts` — legacy JSON cache helper, kept only for migration into SQLite.
  - `symbol-index.ts` — symbol list loading/search with staleness-based refresh (default 7 days).
  - `chart-renderer.ts` — chart card rendering via lightweight-charts (candlestick/line, theme, OHLC header, market-data row, refresh/frequency-switch controls).
  - `widget-parser.ts` / `widget-renderer.ts` — parse TradingView embed HTML / iframe URLs and render them inside a sandboxed iframe.
  - `calendar-renderer.ts` — month-grid calendar card rendered with plain DOM/CSS Grid (no calendar library); marks days that have a daily note and opens/creates the note on click. Refreshes markers on vault create/delete/rename events.
  - `timeline-renderer.ts` — horizontal date-ruler card (```timeline block, English YAML keys `start`/`end`/`unit`, parsed with js-yaml directly — not via `card-spec.ts`). Units: `day` | `week` | `month` | `quarter` | `year` (quarters are calendar-aligned to Jan/Apr/Jul/Oct). Equal pixel width per unit, two-level ticks, scale derived from the ruler's usable width (content width minus `RULER_PADDING_PX` × 2; the padding is applied inline from that constant — the single source of truth — so styles.css never repeats it) via a debounced ResizeObserver. Label font size comes from the `timelineFontSize` plugin setting, applied per-render as the `--fc-timeline-font-size` CSS var on the ruler (like the calendar's `--fc-*` display vars; applies on next render, matching the calendar settings). Auto-`end` rulers draw a today marker and grow the enclosing canvas node on day rollover to preserve scale. Insertion creates a raw-body card via `CardService.createRawCard` (no fc-* frontmatter, no reuse — every insert is a fresh card). Files are named `时间线<start>～<resolved-end>.md` (`timelineCardFileName`): at creation, and when the user saves edits via the double-click edit modal (`app.fileManager.renameFile`, so canvas node paths are updated by Obsidian's link updater); daily rollover never renames. Double-click editing is registered on the wrapper in `main.ts` with `{ capture: true }` so the modal beats the canvas node's native edit mode.
  - `daily-notes.ts` — daily-note path resolution (`resolveDailyNotesConfig`, `dailyNotePath`, `getDailyNote`, `openOrCreateDailyNote`). Settings override; otherwise falls back to the core Daily notes plugin config, then to `日记` + `YYYY-MM-DD`.
  - `toolbar.ts` — floating toolbar attached to Canvas views; places new file nodes onto the canvas.
  - `canvas-locator.ts` — DOM helper to locate the enclosing `.canvas-node`.
- `src/ui/` — Obsidian modals: `symbol-search-modal.ts` (fuzzy symbol picker), `widget-input-modal.ts`, `timeline-edit-modal.ts` (timeline card property editor: 开始日期 / 结束日期 / 自动更新到今天 / 颗粒度).
- `src/utils/` — `date.ts` (date-range parsing/resolution, trading-date stepping), `dom.ts` (theme detection/watching, `onAttached` helper), `slug.ts` (card file-name generation).
- `styles.css` — plugin styles, copied to the plugin dir on build.
- `scripts/` — build helpers: `deploy-target.mjs` (deploy path, env-overridable), `copy-assets.mjs` (copies manifest/styles/versions + `sql-wasm.wasm`).
- `version-bump.mjs`, `versions.json`, `manifest.json` — standard Obsidian plugin versioning files.
- `main.js` (repo root) — a stale build artifact; **gitignored**, regenerated on every build. Never edit it.
- `data.json` (repo root) — local plugin settings including a real Tushare token; **gitignored**, do not commit or expose.
- `cache/` (repo root) — legacy local cache data; **gitignored**.

## Code style and conventions

- Strict TypeScript; `noImplicitAny` and `strictNullChecks` are on. Run `tsc -noEmit -skipLibCheck` (part of `npm run build`) to typecheck.
- 2-space indentation, double quotes, semicolons — match the existing files.
- Classes for stateful components (`SqliteCache`, `DataAdapter`, `ChartRenderer`, ...); plain exported functions for pure helpers (`card-spec.ts`, `utils/*`).
- Renderer classes extend Obsidian's `MarkdownRenderChild`; use `onAttached()` (`src/utils/dom.ts`) before walking up the DOM to find the enclosing `.canvas-node`, because code-block processors run while the element is still detached.
- Obsidian's Canvas API is not public — code accesses it via `as any` casts (`view.canvas`). This is accepted practice in this codebase; keep casts localized.
- **Comments and documentation are written in English** (including technical explanation comments); **user-facing strings (UI labels, Notices, settings tab) are written in Chinese**. Follow this split when editing.
- Error messages shown to the user go through `new Notice(...)` in Chinese; unexpected errors are also `console.error`ed.

## Testing

There is no automated test suite. To verify changes:

1. `npm run build` must pass (includes the `tsc` typecheck).
2. Manually load the plugin in an Obsidian vault (build with `OBSIDIAN_PLUGIN_DIR` pointing at a test vault), enable it, and exercise the affected flow — insert a card via toolbar/command, edit the YAML block, refresh, switch frequency.

## Security considerations

- **Tushare token**: stored in plugin settings (`data.json` in the vault). The repo-root `data.json` contains a real token and is gitignored — never commit it, echo it, or copy it into code/docs.
- **Widget cards render arbitrary HTML** supplied by the user inside an iframe (`widget-renderer.ts`). Be careful when changing iframe attributes (sandbox, allow-scripts) or the widget parsing logic — do not widen privileges without reason.
- The Tushare API client sends the token to `api.tushare.pro` via Obsidian's `requestUrl`; do not log the token.
- `.gitignore` covers `data.json`, `cache/`, `*.db`, `sql-wasm.wasm`, `main.js`, and `node_modules/` — keep it that way.
