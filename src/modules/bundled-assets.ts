import { Notice, requestUrl, type App } from "obsidian";
import { t } from "../i18n";

// Community-store installs only fetch main.js / manifest.json / styles.css
// from the GitHub release, so the release-attached extras — the SQLite wasm
// (hard dependency of the chart cache) and the AI-facing CLI / MCP server —
// must be pulled into the plugin dir at runtime. A marker file records the
// version the extras belong to; dev builds write the same marker from
// scripts/copy-assets.mjs, so only store installs and store updates (marker
// older than manifest.version) ever trigger a fetch.
//
// These are one-time downloads of our own release assets, not data-platform
// requests — they deliberately bypass the modules/http.ts throttle.

const REPO = "lichliar/strataboard";
const ASSET_FILES = ["sql-wasm.wasm", "cli.js", "mcp-server.js"];
const MARKER_FILE = ".bundled-assets-version";

export async function ensureBundledAssets(app: App, pluginDir: string, version: string): Promise<void> {
  const adapter = app.vault.adapter;
  const markerPath = `${pluginDir}/${MARKER_FILE}`;
  const marker = (await adapter.exists(markerPath)) ? (await adapter.read(markerPath)).trim() : "";

  let toFetch: string[];
  if (marker === version) {
    toFetch = [];
    for (const file of ASSET_FILES) {
      if (!(await adapter.exists(`${pluginDir}/${file}`))) toFetch.push(file);
    }
    if (toFetch.length === 0) return;
  } else {
    // No marker (fresh store install) or a stale one (store update): fetch
    // everything so the extras match the running build.
    toFetch = [...ASSET_FILES];
  }

  new Notice(t("正在下载插件资源文件（sql-wasm.wasm / cli.js / mcp-server.js）…"));
  try {
    for (const file of toFetch) {
      const url = `https://github.com/${REPO}/releases/download/${version}/${file}`;
      const res = await requestUrl({ url, method: "GET" });
      await adapter.writeBinary(`${pluginDir}/${file}`, res.arrayBuffer);
    }
    await adapter.write(markerPath, version);
    new Notice(t("插件资源文件下载完成。"));
  } catch (err) {
    new Notice(
      t("插件资源文件下载失败：{msg}。图表缓存与 MCP/CLI 可能不可用，请从 GitHub release 手动下载后放入插件目录：{path}", {
        msg: err instanceof Error ? err.message : String(err),
        path: pluginDir,
      }),
      10000
    );
  }
}
