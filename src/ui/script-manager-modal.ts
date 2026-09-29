import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type StrataBoardPlugin from "../main";
import { ensureFolder } from "../modules/daily-notes";
import { runScript } from "../modules/script-runner";
import { AI_SCRIPT_PROMPT, syncScriptSources } from "../modules/script-sources";
import { normalizePath } from "../utils/slug";
import { t } from "../i18n";

// 脚本处理 manager (toolbar 数据处理 menu / command 打开脚本管理): lists the
// Python scripts in the script folder RECURSIVELY, grouped by subfolder so
// users can organize large script collections with folders. Each row has an
// enable toggle (writes settings.disabledScripts, keyed by folder-relative
// path), a 立即运行 button (greyed out while disabled), and the output CSV
// status; an output that exists but is not registered as a source gets a
// 部署为数据源 button (force-registers it via syncScriptSources). Scripts are
// created outside the plugin (by the user or their AI) — there is no 新建
// 脚本 button. The log area shows stdout/stderr of manual runs verbatim. The
//「AI 辅助」section is a copyable prompt (the plugin has no built-in
// assistant) carrying the CSV contract and the compliance rules.

export class ScriptManagerModal extends Modal {
  private logEl: HTMLElement | null = null;
  // Survives re-renders so a run's output stays visible when the list
  // refreshes (output marker changes after a successful run).
  private logs: string[] = [];

  constructor(app: App, private plugin: StrataBoardPlugin) {
    super(app);
  }

  onOpen() {
    this.setTitle(t("脚本处理"));
    this.render();
  }

  onClose() {
    this.contentEl.empty();
    this.logEl = null;
  }

  private folder(): string {
    return normalizePath(this.plugin.pluginSettings.scriptFolderPath);
  }

  // Script identity everywhere (disable list, run argv) is the path relative
  // to the script folder, e.g. "macro/cpi.py".
  private relPath(file: TFile): string {
    return file.path.slice(this.folder().length + 1);
  }

  private listScripts(): TFile[] {
    const prefix = `${this.folder()}/`;
    return this.app.vault
      .getFiles()
      .filter((file) => file.extension === "py" && file.path.startsWith(prefix))
      .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl)
      .setName(t("脚本文件夹"))
      .setDesc(t("{folder}（在设置页「路径设置」中修改）", { folder: this.folder() }))
      .addButton((btn) => btn.setButtonText(t("打开文件夹")).onClick(() => void this.openFolder()));

    const scripts = this.listScripts();
    if (scripts.length === 0) {
      contentEl.createDiv({
        cls: "fc-field-hint",
        text: t("脚本文件夹中还没有 Python 脚本：自行编写或用 AI 编写（下方有提示词）后放入该文件夹即可，支持用子文件夹归类；脚本把结果 CSV 写入 output/ 子目录即可在卡片中使用。"),
      });
    }
    // Group by subfolder: root scripts first, then one section per subfolder.
    const byFolder = new Map<string, TFile[]>();
    for (const file of scripts) {
      const rel = this.relPath(file);
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const list = byFolder.get(dir) ?? [];
      list.push(file);
      byFolder.set(dir, list);
    }
    for (const file of byFolder.get("") ?? []) this.renderScriptRow(contentEl, file);
    for (const [dir, files] of [...byFolder.entries()].filter(([d]) => d !== "")) {
      contentEl.createDiv({ cls: "fc-script-folder-header", text: dir });
      for (const file of files) this.renderScriptRow(contentEl, file);
    }

    this.renderAiSection(contentEl);

    contentEl.createDiv({ cls: "fc-field-hint", text: t("运行日志") });
    this.logEl = contentEl.createEl("pre", {
      cls: "fc-script-log",
      text: this.logs.length > 0 ? this.logs.join("\n") : t("（尚无运行记录）"),
    });
  }

  private renderScriptRow(containerEl: HTMLElement, file: TFile) {
    const folder = this.folder();
    const rel = this.relPath(file);
    const disabled = this.plugin.pluginSettings.disabledScripts.includes(rel);
    const outputPath = `${folder}/output/${file.basename}.csv`;
    const hasOutput = this.app.vault.getAbstractFileByPath(outputPath) != null;
    const outputRegistered = this.plugin.pluginSettings.customSources.some(
      (s) => s.format === "csv" && s.filePath === outputPath
    );
    const setting = new Setting(containerEl)
      .setName(file.name)
      .setDesc(
        hasOutput
          ? outputRegistered
            ? t("产物：output/{name}.csv", { name: file.basename })
            : t("产物：output/{name}.csv（未注册为数据源）", { name: file.basename })
          : t("产物：尚无（运行后写入 output/{name}.csv）", { name: file.basename })
      );
    setting.addToggle((toggle) =>
      toggle
        .setTooltip(t("启用/禁用脚本"))
        .setValue(!disabled)
        .onChange(async (value) => {
          const list = this.plugin.pluginSettings.disabledScripts.filter((p) => p !== rel);
          if (!value) list.push(rel);
          this.plugin.pluginSettings.disabledScripts = list;
          await this.plugin.saveSettings();
          this.render();
        })
    );
    if (hasOutput && !outputRegistered) {
      setting.addButton((btn) =>
        btn.setButtonText(t("部署为数据源")).onClick(() => void this.deployOutput(outputPath))
      );
    }
    setting.addButton((btn) => {
      btn.setButtonText(t("立即运行")).setDisabled(disabled);
      if (disabled) btn.setTooltip(t("脚本已禁用"));
      btn.onClick(() => void this.runNow(file));
    });
  }

  // Force-registers an output CSV the passive sync skipped (e.g. its source
  // was deleted once): same force-path channel as a manual script run.
  private async deployOutput(outputPath: string) {
    const registered = await syncScriptSources(this.plugin, new Set([outputPath]));
    new Notice(
      registered.length > 0
        ? t("已注册为数据源：{path}", { path: outputPath })
        : t("注册失败：产物文件暂无法解析。")
    );
    this.render();
  }

  // ===== AI 辅助 (copyable prompt; the plugin has no built-in assistant) =====

  private renderAiSection(containerEl: HTMLElement) {
    const details = containerEl.createEl("details", { cls: "fc-settings-sub" });
    details.createEl("summary", { text: t("AI 辅助") });
    details.createDiv({
      cls: "fc-field-hint",
      text: t("复制下方提示词（已附产物契约与合规规则），连同你的脚本或报错一起发给你自己的 AI（如 Codex / Claude Code / Kimi）。"),
    });
    const promptArea = details.createEl("textarea", { cls: "fc-mono fc-prompt-area", attr: { readonly: "true" } });
    promptArea.value = t(AI_SCRIPT_PROMPT);
    const copyBtn = details.createEl("button", { text: t("复制提示词") });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(promptArea.value).then(
        () => new Notice(t("提示词已复制到剪贴板，去发给你的 AI 吧。")),
        () => new Notice(t("复制失败，请手动选中提示词复制。")),
      );
    });
  }

  private appendLog(text: string) {
    this.logs.push(text);
    if (this.logEl) this.logEl.setText(this.logs.join("\n"));
    this.logEl?.scrollIntoView({ block: "end" });
  }

  private async runNow(file: TFile) {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const basePath = adapter.getBasePath?.() ?? "";
    const rel = this.relPath(file);
    this.appendLog(`$ python3 ${rel}`);
    const result = await runScript(`${basePath}/${this.folder()}`, rel);
    if (result.stdout.trim()) this.appendLog(result.stdout.trimEnd());
    if (result.stderr.trim()) this.appendLog(result.stderr.trimEnd());
    this.appendLog(
      result.timedOut
        ? t("运行超时（{s} 秒），进程已终止", { s: 180 })
        : result.code === 0
          ? t("运行完成（退出码 0）")
          : t("运行失败（退出码 {code}）", { code: result.code })
    );
    if (result.code === 0 && !result.timedOut) {
      // A successful manual run takes the same invalidation path as the
      // watcher, without waiting for it: register the output if it is new,
      // clear its source's cache keys, re-render every chart card.
      await this.plugin.invalidateScriptOutput(`${this.folder()}/output/${file.basename}.csv`);
    }
    this.render();
  }

  // Reveals the script folder in the OS file manager. Desktop-only plugin,
  // so electron is reachable via window.require; no static import (the build
  // keeps electron external).
  private async openFolder() {
    const folder = this.folder();
    await ensureFolder(this.app, folder);
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const abs = `${adapter.getBasePath?.() ?? ""}/${folder}`;
    const electron = (window as unknown as { require?: (mod: string) => { shell?: { openPath?: (path: string) => Promise<string> } } }).require?.("electron");
    if (electron?.shell?.openPath) {
      void electron.shell.openPath(abs);
    } else {
      new Notice(t("无法打开文件夹：当前环境不支持。"));
    }
  }
}
