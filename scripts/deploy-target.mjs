import process from "process";

/**
 * Single source of truth for where the built plugin is deployed.
 *
 * Defaults to the "子九章" vault. Set the OBSIDIAN_PLUGIN_DIR environment
 * variable to deploy elsewhere (e.g. a test vault) without editing code:
 *
 *   OBSIDIAN_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/obsidian-financial-canvas" npm run build
 */
export const pluginDir =
  process.env.OBSIDIAN_PLUGIN_DIR ??
  "/Users/izzy/Nutstore Files/子九章/.obsidian/plugins/obsidian-financial-canvas";
