import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pluginDir } from "./deploy-target.mjs";

const __filename = fileURLToPath(import.meta.url);
const projectDir = path.resolve(path.dirname(__filename), "..");

const files = [
  { src: "manifest.json", dest: "manifest.json" },
  { src: "styles.css", dest: "styles.css" },
  { src: "versions.json", dest: "versions.json" },
  { src: "LICENSE", dest: "LICENSE" },
  { src: "docs/THIRD-PARTY-LICENSES.md", dest: "THIRD-PARTY-LICENSES.md" },
];

fs.mkdirSync(pluginDir, { recursive: true });

for (const file of files) {
  const src = path.join(projectDir, file.src);
  const dest = path.join(pluginDir, file.dest);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file.src} -> ${dest}`);
  } else {
    console.warn(`Missing ${src}, skipping`);
  }
}

// The headless PNG renderer (cli.js/mcp-server.js render commands) needs the
// canvas native module at runtime; it is esbuild-external, so deploy it next
// to the bundles. The package is self-contained (prebuilt binary under
// build/Release) for the current platform — a cross-platform install must
// rebuild/deploy on the target machine.
const canvasSrc = path.join(projectDir, "node_modules/canvas");
const canvasDest = path.join(pluginDir, "node_modules", "canvas");
if (fs.existsSync(canvasSrc)) {
  fs.cpSync(canvasSrc, canvasDest, { recursive: true });
  console.log(`Copied canvas -> ${canvasDest}`);
} else {
  console.warn(`Missing ${canvasSrc}, render commands will be unavailable`);
}

// jsdom's default stylesheet, read at load time from jsdom-assets/ (the path
// rewritten by scripts/jsdom-bundle-fix.mjs in the CLI/MCP bundles).
const jsdomCssSrc = path.join(projectDir, "node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css");
const jsdomCssDest = path.join(pluginDir, "jsdom-assets", "default-stylesheet.css");
if (fs.existsSync(jsdomCssSrc)) {
  fs.mkdirSync(path.dirname(jsdomCssDest), { recursive: true });
  fs.copyFileSync(jsdomCssSrc, jsdomCssDest);
  console.log(`Copied jsdom default-stylesheet.css -> ${jsdomCssDest}`);
} else {
  console.warn(`Missing ${jsdomCssSrc}, render commands will be unavailable`);
}
