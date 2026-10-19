import esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";
import { pluginDir } from "./deploy-target.mjs";
import { jsdomStylesheetFix } from "./jsdom-bundle-fix.mjs";
import { legalBanner } from "./legal-banner.mjs";

// Bundles the MCP stdio server (src/mcp/server.ts) into a single
// mcp-server.js next to the plugin's main.js. Same shape as build-cli.mjs:
// obsidian aliased to the fetch-based shim, everything else (MCP SDK, zod,
// sql.js, ...) inlined; sql.js's sql-wasm.wasm is embedded into the bundle
// (binary loader).

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await esbuild.build({
  entryPoints: [path.join(repoRoot, "src/mcp/server.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  charset: "utf8",
  loader: { ".wasm": "binary" },
  alias: {
    obsidian: path.join(repoRoot, "src/cli/obsidian-shim.ts"),
  },
  // canvas is a native module — runtime require() from
  // <pluginDir>/node_modules/canvas (deployed by copy-assets.mjs).
  external: ["canvas"],
  plugins: [jsdomStylesheetFix],
  banner: {
    js: legalBanner("globalThis.window = globalThis;"),
  },
  logLevel: "info",
  sourcemap: false,
  treeShaking: true,
  outfile: path.join(pluginDir, "mcp-server.js"),
});

console.log(`mcp-server.js -> ${path.join(pluginDir, "mcp-server.js")}`);
