import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type StrataBoardPlugin from "../main";
import { ensureFolder } from "../modules/daily-notes";
import { runScript } from "../modules/script-runner";
import { AI_SCRIPT_PROMPT } from "../modules/script-sources";
import { normalizePath } from "../utils/slug";
import { t } from "../i18n";

// 脚本处理 manager (toolbar 数据处理 menu / command 打开脚本管理): lists the
// Python scripts in the script folder with an enable toggle (writes
// settings.disabledScripts), a 立即运行 button (greyed out while disabled),
// and shows each script's output CSV status. 新建脚本 writes a template
// skeleton; the log area shows stdout/stderr of manual runs verbatim. The
//「AI 辅助」section is a copyable prompt (the plugin has no built-in
// assistant) carrying the CSV contract and the compliance rules.

// Skeleton written by 新建脚本. Carries the CSV output contract, a rate-limit
// example (≥1s between requests) and an incremental-fetch example (append
// only what is newer than the CSV's last date).
const SCRIPT_TEMPLATE = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# StrataBoard 脚本模板
#
# 产物契约：把计算结果写成 CSV，放进本目录下的 output/ 子目录（建议与脚本
# 同名：脚本/foo.py → output/foo.csv）。插件会自动把它注册为数据源并刷新卡片。
#
# CSV 格式（二选一）：
#   1. 宽表（推荐，一个脚本可产出多条序列）：首列是日期（date / YYYYMMDD /
#      ISO 均可），其余每个数值列是一条序列，列名即代码；空值表示该日无数据。
#   2. 单序列 OHLCV：表头含 date,open,high,low,close（vol/amount 可选）。
#
# 使用边界：不要高频抓取、不要批量下载保存；请求间隔 ≥ 1 秒；优先增量抓取
# （先读已有 CSV 的最大日期，只补增量）。

import csv
import os
import time
from datetime import datetime, timedelta

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
OUTPUT_FILE = os.path.join(
    OUTPUT_DIR, os.path.splitext(os.path.basename(__file__))[0] + ".csv"
)


def fetch_rows(last_date):
    """增量抓取示例：只返回 last_date（含）之后的新行，[(date, value), ...]。

    实际使用时替换为真实数据请求，并保持限速：
        resp = requests.get("https://example.com/api", params={"start": last_date})
        time.sleep(1)  # 限速：请求间隔 ≥ 1 秒
    """
    start = (
        datetime.strptime(last_date, "%Y-%m-%d") + timedelta(days=1)
        if last_date
        else datetime.now() - timedelta(days=7)
    )
    rows = []
    day = start
    while day <= datetime.now():
        rows.append((day.strftime("%Y-%m-%d"), 0.0))  # TODO: 填入真实数值
        day += timedelta(days=1)
    return rows


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # 读取已有数据（宽表：date + 每条序列一列），确定增量起点。
    existing = []
    if os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE, newline="", encoding="utf-8") as f:
            existing = list(csv.DictReader(f))
    last_date = existing[-1]["date"] if existing else None

    merged = existing + [
        {"date": d, "示例序列": v} for d, v in fetch_rows(last_date)
    ]
    merged.sort(key=lambda r: r["date"])

    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["date", "示例序列"])
        writer.writeheader()
        writer.writerows(merged)
    print(f"已写入 {OUTPUT_FILE}，共 {len(merged)} 行")


if __name__ == "__main__":
    main()
`;

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

  private listScripts(): TFile[] {
    const folder = this.folder();
    return this.app.vault
      .getFiles()
      .filter((file) => file.extension === "py" && file.parent?.path === folder)
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl)
      .setName(t("脚本文件夹"))
      .setDesc(t("{folder}（在设置页「路径设置」中修改）", { folder: this.folder() }))
      .addButton((btn) => btn.setButtonText(t("打开文件夹")).onClick(() => void this.openFolder()))
      .addButton((btn) =>
        btn
          .setButtonText(t("新建脚本"))
          .setCta()
          .onClick(() => void this.createScript())
      );

    const scripts = this.listScripts();
    if (scripts.length === 0) {
      contentEl.createDiv({
        cls: "fc-field-hint",
        text: t("脚本文件夹中还没有 Python 脚本，点击「新建脚本」生成模板；脚本把结果 CSV 写入 output/ 子目录即可在卡片中使用。"),
      });
    }
    for (const file of scripts) this.renderScriptRow(contentEl, file);

    this.renderAiSection(contentEl);

    contentEl.createDiv({ cls: "fc-field-hint", text: t("运行日志") });
    this.logEl = contentEl.createEl("pre", {
      cls: "fc-script-log",
      text: this.logs.length > 0 ? this.logs.join("\n") : t("（尚无运行记录）"),
    });
  }

  private renderScriptRow(containerEl: HTMLElement, file: TFile) {
    const folder = this.folder();
    const disabled = this.plugin.pluginSettings.disabledScripts.includes(file.name);
    const hasOutput = this.app.vault.getAbstractFileByPath(`${folder}/output/${file.basename}.csv`) != null;
    const setting = new Setting(containerEl)
      .setName(file.name)
      .setDesc(
        hasOutput
          ? t("产物：output/{name}.csv", { name: file.basename })
          : t("产物：尚无（运行后写入 output/{name}.csv）", { name: file.basename })
      );
    setting.addToggle((toggle) =>
      toggle
        .setTooltip(t("启用/禁用脚本"))
        .setValue(!disabled)
        .onChange(async (value) => {
          const list = this.plugin.pluginSettings.disabledScripts.filter((name) => name !== file.name);
          if (!value) list.push(file.name);
          this.plugin.pluginSettings.disabledScripts = list;
          await this.plugin.saveSettings();
          this.render();
        })
    );
    setting.addButton((btn) => {
      btn.setButtonText(t("立即运行")).setDisabled(disabled);
      if (disabled) btn.setTooltip(t("脚本已禁用"));
      btn.onClick(() => void this.runNow(file));
    });
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
    this.appendLog(`$ python3 ${file.name}`);
    const result = await runScript(`${basePath}/${this.folder()}`, file.name);
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

  private async createScript() {
    const folder = this.folder();
    await ensureFolder(this.app, folder);
    let path = `${folder}/新脚本.py`;
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = `${folder}/新脚本${n}.py`;
      n++;
    }
    await this.app.vault.create(path, SCRIPT_TEMPLATE);
    new Notice(t("已创建脚本模板：{path}", { path }));
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
