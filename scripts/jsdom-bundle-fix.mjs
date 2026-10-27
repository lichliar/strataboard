// esbuild plugin fixing jsdom's load-time default stylesheet lookup when
// bundled. jsdom's computed-style.js does
//   fs.readFileSync(path.resolve(__dirname, "../../../browser/default-stylesheet.css"))
// which after bundling resolves three levels above the OUTPUT file (e.g. the
// vault root) instead of inside the jsdom package. Rewrite it to read from
// "jsdom-assets/" next to the bundle; copy-assets.mjs deploys the file there.

import fs from "fs";

export const jsdomStylesheetFix = {
  name: "jsdom-stylesheet-fix",
  setup(build) {
    build.onLoad({ filter: /jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]css[\\/]helpers[\\/]computed-style\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, "utf8");
      const needle = /path\.resolve\(__dirname,\s*["'][^"']*browser\/default-stylesheet\.css["']\)/;
      if (!needle.test(source)) {
        throw new Error(`jsdom-stylesheet-fix: pattern not found in ${args.path} — jsdom changed, update the plugin`);
      }
      return {
        contents: source.replace(needle, `path.resolve(__dirname, "jsdom-assets/default-stylesheet.css")`),
        loader: "js",
      };
    });

    // jsdom only auto-detects the package named "canvas". Route that integration
    // point to the deployed napi backend so HTMLCanvasElement and font loading
    // use the same implementation.
    build.onLoad({ filter: /jsdom[\\/]lib[\\/]jsdom[\\/]utils\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, "utf8");
      const needle = /require\(["']canvas["']\)/;
      if (!needle.test(source)) {
        throw new Error(`jsdom-canvas-backend: pattern not found in ${args.path} — jsdom changed, update the plugin`);
      }
      return {
        contents: source.replace(needle, `require("@napi-rs/canvas")`),
        loader: "js",
      };
    });

    // napi exposes context.canvas through a getter, while jsdom replaces it
    // with the DOM wrapper. Define an own property instead of assigning through
    // the getter-only prototype accessor.
    build.onLoad({ filter: /jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]nodes[\\/]HTMLCanvasElement-impl\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, "utf8");
      const needle = /this\._context\.canvas = idlUtils\.wrapperForImpl\(this\);/;
      if (!needle.test(source)) {
        throw new Error(`jsdom-canvas-wrapper: pattern not found in ${args.path} — jsdom changed, update the plugin`);
      }
      return {
        contents: source.replace(needle, `Object.defineProperty(this._context, "canvas", { value: idlUtils.wrapperForImpl(this), configurable: true });`),
        loader: "js",
      };
    });

    // jsdom resolves its sync-XHR worker as an on-disk file at load time; the
    // bundle has no such file (and the worker's own relative requires would
    // not survive bundling either). The render path never performs sync XHR,
    // so stub the path — it is only dereferenced by getSyncWorker() on actual
    // sync-XHR use.
    build.onLoad({ filter: /jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, "utf8");
      const needle = /require\.resolve\(["']\.\/xhr-sync-worker\.js["']\)/;
      if (!needle.test(source)) {
        throw new Error(`jsdom-stylesheet-fix: pattern not found in ${args.path} — jsdom changed, update the plugin`);
      }
      return {
        contents: source.replace(needle, `null /* xhr-sync-worker unavailable in the bundle */`),
        loader: "js",
      };
    });
  },
};
