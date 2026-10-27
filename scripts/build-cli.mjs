import esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";
import { pluginDir } from "./deploy-target.mjs";
import { jsdomStylesheetFix } from "./jsdom-bundle-fix.mjs";
import { legalBanner } from "./legal-banner.mjs";

// Bundles the standalone Node CLI (src/cli/main.ts) into a single cli.js next
// to the plugin's main.js. The obsidian import is aliased to a fetch-based
// shim, so the parser/client modules run without the Obsidian runtime.
// sql.js's sql-wasm.wasm is embedded into the bundle (binary loader).

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await esbuild.build({
  entryPoints: [path.join(repoRoot, "src/cli/bootstrap.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  charset: "utf8",
  loader: { ".wasm": "binary" },
  alias: {
    obsidian: path.join(repoRoot, "src/cli/obsidian-shim.ts"),
  },
  // The napi canvas backend is native — it must stay a runtime require()
  // resolved from <pluginDir>/node_modules (deployed by copy-assets.mjs).
  external: ["@napi-rs/canvas"],
  plugins: [jsdomStylesheetFix],
  banner: {
    js: legalBanner("globalThis.window = globalThis;"),
  },
  logLevel: "info",
  sourcemap: false,
  treeShaking: true,
  outfile: path.join(pluginDir, "cli.js"),
});

console.log(`cli.js -> ${path.join(pluginDir, "cli.js")}`);
