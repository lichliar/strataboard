// Filesystem host adapters for the headless renderer (src/modules/
// render-headless.ts): the CLI/MCP have no Obsidian runtime, so SqliteCache's
// vault surface, DataAdapter's vault file reader and SeriesAdapter's card
// host are implemented on node:fs here. Paths crossing the vault boundary are
// vault-relative POSIX strings, same as the plugin side.

import * as fs from "fs";
import * as path from "path";
import type { Vault } from "obsidian";
import { SqliteCache } from "../modules/sqlite-cache";
import { DataAdapter } from "../modules/data-adapter";
import { SeriesAdapter, type SeriesCardHost } from "../modules/series-adapter";
import { extractSpreadId } from "../modules/card-index";
import { cacheAssetKey } from "../types";
import type { HeadlessRenderDeps } from "../modules/render-headless";
import type { CliSettings } from "./commands";
import { cliApiKeyResolver } from "./runtime-credentials";
import { normalizePath } from "../utils/slug";
import {
  getIndicatorLoadErrors,
  getUnapprovedIndicators,
  syncIndicatorFiles,
} from "../modules/indicators";

// Minimal Vault implementation over node:fs — only the adapter methods
// SqliteCache touches (readBinary/writeBinary/exists/mkdir). Absolute paths
// (the wasm lookup uses pluginDir) pass through untouched.
function createFsVault(vaultRoot: string): Vault {
  const resolve = (p: string) => (path.isAbsolute(p) ? p : path.join(vaultRoot, p));
  return {
    adapter: {
      readBinary: async (p: string) => {
        const buf = await fs.promises.readFile(resolve(p));
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
      writeBinary: async (p: string, data: ArrayBuffer) => {
        const target = resolve(p);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, Buffer.from(data));
      },
      exists: async (p: string) => fs.existsSync(resolve(p)),
      mkdir: async (p: string) => {
        await fs.promises.mkdir(resolve(p), { recursive: true });
      },
    },
  } as unknown as Vault;
}

// cardId -> vault-relative path index over the card library folder, the fs
// counterpart of CardIndex (card-index.ts). A CLI process is one-shot, so a
// single scan replaces CardIndex's verify-on-read self-healing. Duplicate ids
// (hand-copied card files) keep the newer mtime, same as the plugin.
export async function buildFsCardIndex(vaultRoot: string, libraryPath: string): Promise<Map<string, string>> {
  const byId = new Map<string, { path: string; mtime: number }>();
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Library folder does not exist — no cards are resolvable.
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      let content: string;
      try {
        content = await fs.promises.readFile(full, "utf8");
      } catch {
        continue;
      }
      const id = extractSpreadId(content);
      if (!id) continue;
      const rel = path.relative(vaultRoot, full).split(path.sep).join("/");
      const mtime = (await fs.promises.stat(full)).mtimeMs;
      const existing = byId.get(id);
      if (existing) {
        console.warn(`CardIndex: duplicate spread card id ${id} in ${existing.path} and ${rel}; keeping the newer`);
        if (existing.mtime > mtime) continue;
      }
      byId.set(id, { path: rel, mtime });
    }
  };
  await walk(path.join(vaultRoot, libraryPath));
  return new Map([...byId].map(([id, v]) => [id, v.path]));
}

// Cache stand-in used when the real SqliteCache cannot initialize (e.g. a
// corrupted db): every read misses, writes are dropped, and DataAdapter
// fetches everything live.
function createNullCache(): SqliteCache {
  return {
    loadOhlcvRange: async () => [],
    getOhlcvExtent: async () => null,
    mergeOhlcvRows: async () => {},
    lookupSymbol: async () => null,
    save: async () => {},
  } as unknown as SqliteCache;
}

export interface RenderRuntime {
  deps: HeadlessRenderDeps;
  // Persists the SQLite cache (fetched rows) — call once before process exit.
  save: () => Promise<void>;
}

interface FsIndicatorFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
}

interface FsIndicatorVault {
  getFiles(): FsIndicatorFile[];
  cachedRead(file: FsIndicatorFile): Promise<string>;
}

interface FsIndicatorHost {
  app: { vault: FsIndicatorVault };
  pluginSettings: CliSettings;
}

// The CLI has no Obsidian vault object. Build the small structural surface
// consumed by syncIndicatorFiles without importing the real Electron API.
async function listIndicatorFiles(vaultRoot: string, folder: string): Promise<FsIndicatorFile[]> {
  const files: FsIndicatorFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(vaultRoot, full).split(path.sep).join("/");
      const extension = path.extname(entry.name).replace(/^\./, "");
      files.push({
        path: relative,
        name: entry.name,
        basename: path.basename(entry.name, path.extname(entry.name)),
        extension,
      });
    }
  };
  await walk(path.join(vaultRoot, folder));
  return files;
}

// The registry is process-global, so only the most recently rendered vault
// can own it. Reuse the promise for repeated renders of that vault; a
// different vault waits for the previous sync and then replaces the registry.
let indicatorSyncState: { vault: string; promise: Promise<void> } | null = null;

async function syncCliIndicators(vaultRoot: string, settings: CliSettings): Promise<void> {
  if (indicatorSyncState?.vault === vaultRoot) {
    await indicatorSyncState.promise;
    return;
  }

  const previous = indicatorSyncState?.promise;
  const run = (async () => {
    await previous?.catch(() => {});
    const indicatorFolder = normalizePath(settings.indicatorFolderPath ?? "指标");
    const files = await listIndicatorFiles(vaultRoot, indicatorFolder);
    const vault: FsIndicatorVault = {
      getFiles: () => files,
      cachedRead: (file) => fs.promises.readFile(path.join(vaultRoot, file.path), "utf8"),
    };
    const host: FsIndicatorHost = { app: { vault }, pluginSettings: settings };
    await syncIndicatorFiles(host);

    const { errors, conflicts } = getIndicatorLoadErrors();
    for (const item of [...errors, ...conflicts]) {
      console.warn(`[strataboard] 指标未加载 ${item.path}: ${item.error}`);
    }
    for (const item of getUnapprovedIndicators()) {
      console.warn(`[strataboard] 指标未审批，已跳过 ${item.path}`);
    }
  })();
  indicatorSyncState = { vault: vaultRoot, promise: run };
  await run;
}

// Wires DataAdapter + SeriesAdapter (+ SQLite cache when available) for one
// CLI/MCP process. The card index scan happens here so card references
// (source: card) resolve exactly like the plugin resolves them.
export async function createRenderRuntime(vault: string, settings: CliSettings): Promise<RenderRuntime> {
  await syncCliIndicators(vault, settings);
  const fsVault = createFsVault(vault);
  let cache: SqliteCache;
  try {
    cache = new SqliteCache({ vault: fsVault });
    await cache.init({
      ohlcvDbPath: `${settings.dataCachePath ?? "金融卡片/数据缓存"}/ohlcv.db`,
      symbolsDbPath: `${settings.symbolCachePath ?? "金融卡片/股票代码缓存"}/symbols.db`,
    });
  } catch (e) {
    console.error(`[strataboard] 数据缓存不可用，本次渲染直取数据：${e instanceof Error ? e.message : String(e)}`);
    cache = createNullCache();
  }

  const dataAdapter = new DataAdapter({
    cache,
    customSources: settings.customSources ?? [],
    readVaultFile: async (p) => fs.promises.readFile(path.join(vault, p), "utf8"),
    // Headless processes resolve credentials from per-source env vars
    // (commands.ts registers the redaction list for the same process).
    resolveApiKey: cliApiKeyResolver(),
  });

  const cardIndex = await buildFsCardIndex(vault, settings.cardLibraryPath ?? "金融卡片");
  const host: SeriesCardHost = {
    resolveCardId: async (id) => cardIndex.get(id) ?? null,
    resolveCardIdSync: (id) => cardIndex.get(id) ?? null,
    readCardFile: async (p) => {
      try {
        return await fs.promises.readFile(path.join(vault, p), "utf8");
      } catch {
        return null;
      }
    },
  };
  const seriesAdapter = new SeriesAdapter({ dataAdapter, host });

  return {
    deps: {
      dataAdapter,
      seriesAdapter,
      customSources: settings.customSources ?? [],
      lookupSymbol: (symbol, assetType, sourceId) =>
        cache
          .lookupSymbol(symbol, cacheAssetKey(assetType, sourceId))
          .then((item) => item ?? null)
          .catch(() => null),
      settings: {
        showSeriesLatestValue: settings.showSeriesLatestValue,
        showSeriesPointMarkers: settings.showSeriesPointMarkers,
        showChartGrid: settings.showChartGrid,
        gridOpacity: settings.gridOpacity,
        showOverlayCorrelation: settings.showOverlayCorrelation,
        riseColor: settings.riseColor,
        fallColor: settings.fallColor,
      },
    },
    save: () => cache.save(),
  };
}
