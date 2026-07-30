import { App, moment, normalizePath, Notice, TFile } from "obsidian";

export interface DailyNotesConfig {
  folder: string;
  format: string;
}

const DEFAULT_FOLDER = "日记";
const DEFAULT_FORMAT = "YYYY-MM-DD";

// Settings overrides win; otherwise fall back to the core Daily notes plugin
// config so the calendar matches the vault's existing convention.
export function resolveDailyNotesConfig(
  app: App,
  folderOverride: string,
  formatOverride: string
): DailyNotesConfig {
  const core = readCoreDailyNotesOptions(app);
  return {
    folder: folderOverride.trim() || core.folder || DEFAULT_FOLDER,
    format: formatOverride.trim() || core.format || DEFAULT_FORMAT,
  };
}

function readCoreDailyNotesOptions(app: App): { folder?: string; format?: string } {
  try {
    const options = (app as any).internalPlugins?.plugins?.["daily-notes"]?.instance?.options;
    return {
      folder: typeof options?.folder === "string" ? options.folder : undefined,
      format: typeof options?.format === "string" ? options.format : undefined,
    };
  } catch {
    return {};
  }
}

export function dailyNotePath(config: DailyNotesConfig, date: Date): string {
  const fileName = moment(date).format(config.format || DEFAULT_FORMAT);
  const folder = config.folder.replace(/^\/+|\/+$/g, "");
  return normalizePath(folder ? `${folder}/${fileName}.md` : `${fileName}.md`);
}

export function getDailyNote(app: App, config: DailyNotesConfig, date: Date): TFile | null {
  const file = app.vault.getAbstractFileByPath(dailyNotePath(config, date));
  return file instanceof TFile ? file : null;
}

export async function openOrCreateDailyNote(
  app: App,
  config: DailyNotesConfig,
  date: Date
): Promise<void> {
  const path = dailyNotePath(config, date);
  const existing = app.vault.getAbstractFileByPath(path);
  let file: TFile;

  if (existing instanceof TFile) {
    file = existing;
  } else {
    try {
      await ensureFolder(app, config.folder);
      file = await app.vault.create(path, "");
      new Notice(`已创建日记：${file.basename}`);
    } catch (e) {
      new Notice(`创建日记失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("创建日记失败:", e);
      return;
    }
  }

  await app.workspace.getLeaf(false).openFile(file);
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  const trimmed = folder.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return;

  // createFolder does not create missing parents, so walk the path down.
  const segments = trimmed.split("/");
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!(await app.vault.adapter.exists(current))) {
      await app.vault.createFolder(current);
    }
  }
}
