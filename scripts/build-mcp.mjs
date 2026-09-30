import esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";
import { pluginDir } from "./deploy-target.mjs";

// Bundles the MCP stdio server (src/mcp/server.ts) into a single
// mcp-server.js next to the plugin's main.js. Same shape as build-cli.mjs:
// obsidian aliased to the fetch-based shim, everything else (MCP SDK, zod,
// sql.js, ...) inlined.

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await esbuild.build({
  entryPoints: [path.join(repoRoot, "src/mcp/server.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  charset: "utf8",
  alias: {
    obsidian: path.join(repoRoot, "src/cli/obsidian-shim.ts"),
  },
  banner: {
    js: "globalThis.window = globalThis;",
  },
  logLevel: "info",
  sourcemap: false,
  treeShaking: true,
  outfile: path.join(pluginDir, "mcp-server.js"),
});

console.log(`mcp-server.js -> ${path.join(pluginDir, "mcp-server.js")}`);
