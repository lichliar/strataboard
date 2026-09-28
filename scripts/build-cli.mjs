import esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";
import { pluginDir } from "./deploy-target.mjs";

// Bundles the standalone Node CLI (src/cli/main.ts) into a single cli.js next
// to the plugin's main.js. The obsidian import is aliased to a fetch-based
// shim, so the parser/client modules run without the Obsidian runtime.
// sql-wasm.wasm is deployed by copy-assets.mjs to the same directory; the CLI
// locates it via __dirname.

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await esbuild.build({
  entryPoints: [path.join(repoRoot, "src/cli/main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  alias: {
    obsidian: path.join(repoRoot, "src/cli/obsidian-shim.ts"),
  },
  banner: {
    js: "globalThis.window = globalThis;",
  },
  logLevel: "info",
  sourcemap: false,
  treeShaking: true,
  outfile: path.join(pluginDir, "cli.js"),
});

console.log(`cli.js -> ${path.join(pluginDir, "cli.js")}`);
