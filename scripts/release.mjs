import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { pluginDir } from "./deploy-target.mjs";

/**
 * One-command release, run after `npm run version` bumped the version:
 *
 *   npm run release
 *
 * Steps: refuse a dirty working tree (the tag must point at a commit that
 * contains exactly what was built) → push the current branch → tag vX.Y.Z
 * from manifest.json → push the tag → `gh release create` with the built
 * plugin files from the deploy target (main.js / manifest.json / styles.css /
 * sql-wasm.wasm — the wasm is required by the SQLite cache).
 *
 * Requires the GitHub CLI (`gh`) to be authenticated.
 */

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const out = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

const { version } = JSON.parse(readFileSync("manifest.json", "utf8"));
const tag = `v${version}`;

if (out("git status --porcelain")) {
  console.error("✗ Working tree is dirty — commit or stash before releasing.");
  process.exit(1);
}
if (out(`git tag -l ${tag}`)) {
  console.error(`✗ Tag ${tag} already exists. Run \`npm run version\` to bump first.`);
  process.exit(1);
}

const branch = out("git rev-parse --abbrev-ref HEAD");
console.log(`→ Pushing ${branch} and tagging ${tag}`);
run(`git push origin ${branch}`);
run(`git tag ${tag}`);
run(`git push origin ${tag}`);

const files = ["main.js", "manifest.json", "styles.css", "sql-wasm.wasm"].map((f) =>
  JSON.stringify(join(pluginDir, f))
);
console.log(`→ Creating GitHub release ${tag} from ${pluginDir}`);
run(`gh release create ${tag} ${files.join(" ")} --title ${JSON.stringify(tag)} --generate-notes`);
