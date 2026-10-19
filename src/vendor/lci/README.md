# Vendored from lightweight-charts-indicators

Source: https://github.com/deepentropy/lightweight-charts-indicators
Pinned commit: `6d6e7ec54bbc1c20b2d40e5ae421e108fa267e5c` (main @ 2026-10-07, v0.10.0)
License: MIT (see `docs/THIRD-PARTY-LICENSES.md`)

## Layout

- `render/` — IndicatorRenderer (draws IndicatorResult onto lightweight-charts v5 panes).
- `types.ts`, `bar-time.ts` — shared output types and bar-time helpers used by the renderer.

## Rules

- **NEVER import the npm package root** (`lightweight-charts-indicators`). Its published
  bundle is a single 6.4 MB file that cannot be tree-shaken (verified); importing even one
  indicator from it pulls all 1290 indicators into main.js. Vendor individual source files
  from the repo instead.
- Runtime deps: `oakscriptjs` (~0.10.x), `lightweight-charts` (^5.2), `fancy-canvas` (^2.1).
- When upgrading: bump the pinned commit above and re-copy only the renderer and shared helpers used by the plugin.
