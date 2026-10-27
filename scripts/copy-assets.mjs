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

// The headless PNG renderer needs the napi native backend at runtime. Copy
// every installed platform package, but never remove other platforms already
// deployed: building once on each target leaves a shared vault usable on both.
fs.rmSync(path.join(pluginDir, "node_modules", "canvas"), { recursive: true, force: true });
const canvasScopeSrc = path.join(projectDir, "node_modules", "@napi-rs");
const canvasScopeDest = path.join(pluginDir, "node_modules", "@napi-rs");
const canvasPackages = fs.existsSync(canvasScopeSrc)
  ? fs.readdirSync(canvasScopeSrc).filter((name) => name === "canvas" || name.startsWith("canvas-"))
  : [];
if (canvasPackages.length === 0) {
  console.warn(`Missing ${canvasScopeSrc}/canvas, render commands will be unavailable`);
}
for (const name of canvasPackages) {
  const src = path.join(canvasScopeSrc, name);
  const dest = path.join(canvasScopeDest, name);
  fs.cpSync(src, dest, { recursive: true });
  console.log(`Copied @napi-rs/${name} -> ${dest}`);
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
