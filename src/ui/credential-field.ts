import { Setting } from "obsidian";
import { t } from "../i18n";
import type { CredentialStore } from "../modules/credentials";
import { applyInfoDescs } from "./info-desc";

// Shared credential picker (凭据): dropdown (不配置凭据 / 新建凭据… / stored
// ids / stale-reference fallback) plus a password input shown whenever the
// selection is not 不配置凭据 — for 新建凭据… it collects the new secret, for
// an existing id a filled value ROTATES the stored secret. An optional name
// input sits above the password box: credentials can carry a user-given
// label (stored by the caller in pluginSettings.credentialNames, not a
// secret) so several credentials stay distinguishable in the dropdown; the
// label is shown in place of / ahead of the describeId fallback. The
// component owns no persistence: every edit is reported through onChange and
// the caller decides when to store via the credential seam
// (custom-source-modal saves on 保存). pendingSecret is unsaved input —
// callers must include it in redactSecretsWith extras while unsaved.

// Dropdown sentinel for "create a new credential" — real ids always carry the
// strataboard-cred- prefix (credentials.ts), so this can never collide. An
// undefined selection id means 不配置凭据.
export const CREDENTIAL_NEW = "__new__";

export interface CredentialSelection {
  id?: string;
  pendingSecret?: string;
  // Unsaved name input (create = name for the new credential, existing id =
  // rename); empty string means "no label".
  pendingName?: string;
}

export interface CredentialFieldOptions {
  credentials: CredentialStore;
  // Initial selection: undefined / CREDENTIAL_NEW / a stored credential id.
  selectedId?: string;
  // Unsaved secret text to prefill the password box with.
  pendingSecret?: string;
  // Unsaved name text to prefill the name box with; defaults to the stored
  // name of selectedId.
  pendingName?: string;
  // Stored user-given labels keyed by credential id (read-only here).
  names?: Record<string, string>;
  // Label for a stored id (e.g. sources referencing it); defaults to 已保存凭据.
  describeId?: (id: string) => string;
  // Setting description, recomputed whenever the selection changes.
  desc?: (sel: CredentialSelection) => string;
  // Called on dropdown change and on every secret edit.
  onChange?: (sel: CredentialSelection) => void;
}

export interface CredentialFieldHandle {
  /** Current selection (dropdown value + unsaved secret text). */
  selection(): CredentialSelection;
  // Seed the new-credential secret (e.g. a credential extracted from a pasted
  // URL): switches the selection to 新建凭据… unless an existing credential
  // is selected, then reports the change through onChange.
  seedNewSecret(secret: string): void;
}

export function renderCredentialField(container: HTMLElement, opts: CredentialFieldOptions): CredentialFieldHandle {
  const storedName = (id?: string) => (id && id !== CREDENTIAL_NEW ? opts.names?.[id] ?? "" : "");
  let selection: CredentialSelection = {
    id: opts.selectedId,
    pendingSecret: opts.pendingSecret ?? "",
    pendingName: opts.pendingName ?? storedName(opts.selectedId),
  };

  const setting = new Setting(container).setName(t("凭据（API Key）"));
  setting.settingEl.addClass("fc-setting-stacked");

  const notify = () => opts.onChange?.({ ...selection });

  const render = () => {
    // Undo a previous info-desc collapse before setting fresh text: the old
    // icon holds a stale tooltip copy and setDesc would leave the row hidden.
    setting.settingEl.querySelector(".fc-info-icon")?.remove();
    setting.descEl.removeClass("fc-hidden");
    setting.setDesc(opts.desc?.(selection) ?? "");
    setting.controlEl.empty();
    setting.addDropdown((dropdown) => {
      dropdown.addOption("", t("不配置凭据"));
      dropdown.addOption(CREDENTIAL_NEW, t("新建凭据…"));
      for (const id of opts.credentials.list()) {
        const desc = opts.describeId?.(id) ?? t("已保存凭据");
        const name = opts.names?.[id];
        dropdown.addOption(id, name ? t("{name}（{desc}）", { name, desc }) : desc);
      }
      // Keep unavailable references selectable, distinguishing locked sync
      // ciphertext from a credential that is genuinely absent.
      if (selection.id && selection.id !== CREDENTIAL_NEW && !opts.credentials.list().includes(selection.id)) {
        dropdown.addOption(selection.id, opts.credentials.isSyncLocked()
          ? t("当前凭据（待解锁）")
          : t("当前凭据（已失效，请重新选择）"));
      }
      dropdown.setValue(selection.id ?? "").onChange((value) => {
        selection = { id: value || undefined, pendingSecret: "", pendingName: storedName(value || undefined) };
        render();
        notify();
      });
    });
    if (selection.id) {
      setting.addText((text) => {
        text
          .setPlaceholder(t("凭据名称（可选），便于区分多个凭据"))
          .setValue(selection.pendingName ?? "")
          .onChange((value) => {
            selection.pendingName = value;
            notify();
          });
      });
      setting.addText((text) => {
        text
          .setPlaceholder(
            selection.id === CREDENTIAL_NEW
              ? t("输入新密钥（保存时安全存储）")
              : t("留空保持不变；填写则更新该凭据的密钥")
          )
          .setValue(selection.pendingSecret ?? "")
          .onChange((value) => {
            selection.pendingSecret = value;
            notify();
          });
        text.inputEl.type = "password";
        text.inputEl.addClass("fc-mono");
      });
    }
    // Re-collapse descriptions to hover icons (info-desc.ts) — a dropdown
    // change re-renders this row after the caller's initial pass already ran.
    applyInfoDescs(container);
  };
  render();

  return {
    selection: () => ({ ...selection }),
    seedNewSecret(secret) {
      // An existing credential stays the explicit choice — never hijack it.
      if (selection.id && selection.id !== CREDENTIAL_NEW) return;
      selection = { id: CREDENTIAL_NEW, pendingSecret: secret, pendingName: "" };
      render();
      notify();
    },
  };
}
