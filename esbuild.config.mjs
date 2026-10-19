import esbuild from "esbuild";
import process from "process";
import path from "path";
import { builtinModules } from "node:module";
import { pluginDir } from "./scripts/deploy-target.mjs";
import { legalBanner } from "./scripts/legal-banner.mjs";

const banner = legalBanner();

const prod = (process.argv[2] === "production");

const context = await esbuild.context({
	banner: {
		js: banner,
	},
	entryPoints: ["src/main.ts"],
	bundle: true,
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
		...builtinModules],
	format: "cjs",
	target: "es2022",
	charset: "utf8",
	loader: { ".wasm": "binary" },
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: path.join(pluginDir, "main.js"),
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
