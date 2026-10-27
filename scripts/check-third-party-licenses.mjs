import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { jsdomStylesheetFix } from "./jsdom-bundle-fix.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputPath = path.join(repoRoot, "docs", "THIRD-PARTY-LICENSES.md");
const shouldWrite = process.argv.includes("--write");

const PACKAGE_LICENSE_OVERRIDES = new Map([
  [
    "fancy-canvas",
    `Copyright (c) 2019 TradingView, Inc

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  ],
  [
    "saxes",
    `The ISC License

Copyright (c) Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

====

The following license is the one that governed sax, from which saxes
was forked. Isaac Schlueter is not *directly* involved with saxes so
don't go bugging him for saxes issues.

The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

====

\`String.fromCodePoint\` by Mathias Bynens is no longer used, but it can
still be found in old commits. It was once used according to terms of
MIT License, as follows:

    Copyright Mathias Bynens <https://mathiasbynens.be/>

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to
    permit persons to whom the Software is furnished to do so, subject to
    the following conditions:

    The above copyright notice and this permission notice shall be
    included in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
    NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
    LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
    OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
    WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  ],
]);

const VENDORED_LICENSE = `MIT License

Copyright (c) 2025 Odyssée

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const buildConfigs = {
  "main.js": {
    entryPoints: [path.join(repoRoot, "src", "main.ts")],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "cjs",
    target: "es2022",
    loader: { ".wasm": "binary" },
    external: [
      "obsidian",
      "electron",
      "@codemirror/autocomplete",
      "@codemirror/collab",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      ...builtinModules,
    ],
  },
  "cli.js": {
    entryPoints: [path.join(repoRoot, "src", "cli", "main.ts")],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    loader: { ".wasm": "binary" },
    alias: { obsidian: path.join(repoRoot, "src", "cli", "obsidian-shim.ts") },
    external: ["@napi-rs/canvas"],
    plugins: [jsdomStylesheetFix],
  },
  "mcp-server.js": {
    entryPoints: [path.join(repoRoot, "src", "mcp", "server.ts")],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    loader: { ".wasm": "binary" },
    alias: { obsidian: path.join(repoRoot, "src", "cli", "obsidian-shim.ts") },
    external: ["@napi-rs/canvas"],
    plugins: [jsdomStylesheetFix],
  },
};

function packageFromInput(input) {
  const marker = "node_modules/";
  const markerIndex = input.lastIndexOf(marker);
  if (markerIndex < 0) return null;

  const relative = input.slice(markerIndex + marker.length);
  const parts = relative.split("/");
  const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  const packageDir = path.resolve(repoRoot, input.slice(0, markerIndex + marker.length), ...name.split("/"));
  return { name, packageDir };
}

function findLicenseText(name, packageDir) {
  const override = PACKAGE_LICENSE_OVERRIDES.get(name);
  if (override) return override;

  const candidates = fs.readdirSync(packageDir)
    .filter((file) => /^(licen[cs]e|copying)/i.test(file))
    .sort((a, b) => a.localeCompare(b));
  if (candidates.length === 0) {
    throw new Error(`${name} has no distributable license file; add a reviewed override before release.`);
  }
  return fs.readFileSync(path.join(packageDir, candidates[0]), "utf8").replace(/\r\n/g, "\n").trim();
}

function findNoticeTexts(packageDir) {
  return fs.readdirSync(packageDir)
    .filter((file) => /^notice/i.test(file))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({
      file,
      text: fs.readFileSync(path.join(packageDir, file), "utf8").replace(/\r\n/g, "\n").trim(),
    }));
}

function repositoryUrl(pkg) {
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return repository ?? pkg.homepage ?? "";
}

async function collectPackages() {
  const packages = new Map();
  for (const [artifact, config] of Object.entries(buildConfigs)) {
    const result = await esbuild.build({ ...config, absWorkingDir: repoRoot, logLevel: "silent" });
    for (const input of Object.keys(result.metafile.inputs)) {
      const found = packageFromInput(input);
      if (!found) continue;

      const pkg = JSON.parse(fs.readFileSync(path.join(found.packageDir, "package.json"), "utf8"));
      const key = `${pkg.name}@${pkg.version}`;
      const existing = packages.get(key) ?? {
        name: pkg.name,
        version: pkg.version,
        declaredLicense: pkg.license ?? pkg.licenses ?? "UNDECLARED",
        repository: repositoryUrl(pkg),
        licenseText: findLicenseText(found.name, found.packageDir),
        noticeTexts: findNoticeTexts(found.packageDir),
        artifacts: new Set(),
      };
      existing.artifacts.add(artifact);
      packages.set(key, existing);
    }
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function renderDocument(packages) {
  const lines = [
    "# Third-Party Licenses",
    "",
    "This file is generated from the dependency graphs of the distributed `main.js`, `cli.js`, and `mcp-server.js` bundles.",
    "Run `node scripts/check-third-party-licenses.mjs --write` after changing bundled dependencies, and commit the result.",
    "Packages marked external by the build (currently `obsidian`, Electron/Node built-ins, CodeMirror/Lezer, and optional `@napi-rs/canvas`) are not included in these bundles and are not listed here. The napi canvas license and platform packages are deployed separately under `node_modules`.",
    "",
    "## Bundled package inventory",
    "",
    "| Package | Version | Declared license | Bundled in |",
    "| --- | --- | --- | --- |",
  ];

  for (const pkg of packages) {
    const license = typeof pkg.declaredLicense === "string" ? pkg.declaredLicense : JSON.stringify(pkg.declaredLicense);
    lines.push(`| \`${pkg.name}\` | \`${pkg.version}\` | \`${license}\` | ${[...pkg.artifacts].sort().map((name) => `\`${name}\``).join(", ")} |`);
  }

  lines.push(
    "",
    "## Vendored source inventory",
    "",
    "| Work | Source | License |",
    "| --- | --- | --- |",
    "| `lightweight-charts-indicators` selected sources (`render/`, `types.ts`, `bar-time.ts`) — renderer and shared helpers that draw user-provided custom indicator results onto lightweight-charts v5 panes | https://github.com/deepentropy/lightweight-charts-indicators/tree/6d6e7ec54bbc1c20b2d40e5ae421e108fa267e5c | MIT |",
    "",
    "## License texts and notices",
  );

  for (const pkg of packages) {
    const license = typeof pkg.declaredLicense === "string" ? pkg.declaredLicense : JSON.stringify(pkg.declaredLicense);
    lines.push(
      "",
      `### ${pkg.name}@${pkg.version}`,
      "",
      `Declared license: \`${license}\`.`,
      ...(pkg.repository ? [`Source: ${pkg.repository.replace(/^git\+/, "").replace(/\.git$/, "")}`] : []),
      "",
      "```text",
      pkg.licenseText,
      "```",
    );
    for (const notice of pkg.noticeTexts) {
      lines.push("", `Notice file: \`${notice.file}\`.`, "", "```text", notice.text, "```");
    }
  }

  lines.push(
    "",
    "### lightweight-charts-indicators vendored sources",
    "",
    "Selected files are vendored under `src/vendor/lci/` from commit `6d6e7ec54bbc1c20b2d40e5ae421e108fa267e5c`: the indicator renderer (`render/`) plus shared output types (`types.ts`) and bar-time helpers (`bar-time.ts`) used to draw user-provided custom indicator results.",
    "",
    "```text",
    VENDORED_LICENSE,
    "```",
  );

  return `${lines.join("\n")}\n`;
}

const generated = renderDocument(await collectPackages());
if (shouldWrite) {
  fs.writeFileSync(outputPath, generated);
  console.log(`Updated ${path.relative(repoRoot, outputPath)}`);
} else {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== generated) {
    console.error("Third-party license inventory is stale. Run: node scripts/check-third-party-licenses.mjs --write");
    process.exit(1);
  }
  console.log("Third-party license inventory matches all bundled packages.");
}
