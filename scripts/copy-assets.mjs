import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pluginDir } from "./deploy-target.mjs";

const __filename = fileURLToPath(import.meta.url);
const projectDir = path.resolve(path.dirname(__filename), "..");

const files = ["manifest.json", "styles.css", "versions.json"];

fs.mkdirSync(pluginDir, { recursive: true });

for (const file of files) {
  const src = path.join(projectDir, file);
  const dest = path.join(pluginDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file} -> ${dest}`);
  } else {
    console.warn(`Missing ${src}, skipping`);
  }
}

const wasmSrc = path.join(projectDir, "node_modules/sql.js/dist/sql-wasm.wasm");
const wasmDest = path.join(pluginDir, "sql-wasm.wasm");
if (fs.existsSync(wasmSrc)) {
  fs.copyFileSync(wasmSrc, wasmDest);
  console.log(`Copied sql-wasm.wasm -> ${wasmDest}`);
} else {
  console.warn(`Missing ${wasmSrc}, skipping`);
}
