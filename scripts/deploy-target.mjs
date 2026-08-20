import process from "process";

/**
 * Single source of truth for where the built plugin is deployed.
 *
 * There is no default: set the OBSIDIAN_PLUGIN_DIR environment variable to
 * your vault's plugin directory before building:
 *
 *   OBSIDIAN_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/strataboard" npm run build
 */
export const pluginDir = (() => {
  const dir = process.env.OBSIDIAN_PLUGIN_DIR;
  if (!dir) {
    throw new Error(
      "OBSIDIAN_PLUGIN_DIR is not set. Point it at your vault's plugin directory, e.g.:\n" +
        '  OBSIDIAN_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/strataboard" npm run build'
    );
  }
  return dir;
})();
