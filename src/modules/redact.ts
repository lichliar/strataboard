// Central redaction seam: every user-visible error, Notice, log line, AI
// copy payload and CLI/MCP output passes through redactSecrets so a resolved
// credential can never leak via an echoed request, response body, or error
// message. Secret values come from modules/credentials.ts (plugin: every
// stored credential; CLI: each env secret actually used). No obsidian
// imports — the CLI bundle shares this module.

import { redactionSecrets } from "./credentials";
import { API_KEY_PARAMS } from "../utils/url-template";

const MASK = "***";
// Below this length a "secret" is likelier a common word; masking it would
// shred unrelated text. Real API keys are far longer.
const MIN_SECRET_LENGTH = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskSecretValues(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), MASK);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.replace(new RegExp(escapeRegExp(encoded), "g"), MASK);
  }
  return out;
}

// Well-known credential query params inside URLs embedded in arbitrary text:
// `?api_key=abc` / `&token=abc` → value masked.
const QUERY_PARAM_RE = new RegExp(`([?&](?:${API_KEY_PARAMS.join("|")})=)[^&\\s"'\\\\)]+`, "gi");

// `Authorization: Bearer xxx` / `Cookie: ...` up to end of line, both plain
// and JSON-embedded (`"Authorization": "xxx"`) forms.
const HEADER_LINE_RE = /^\s*(authorization|cookie)\s*:\s*.+$/gim;
const HEADER_JSON_RE = /("(?:authorization|cookie)"\s*:\s*")[^"]*(")/gi;

function maskPatterns(text: string): string {
  return text
    .replace(QUERY_PARAM_RE, `$1${MASK}`)
    .replace(HEADER_LINE_RE, (_, name: string) => `${name}: ${MASK}`)
    .replace(HEADER_JSON_RE, `$1${MASK}$2`);
}

export function redactSecrets(text: string): string {
  return maskPatterns(maskSecretValues(text, redactionSecrets()));
}

// Same as redactSecrets, plus one-off values that are not (yet) in the
// registry — e.g. a credential typed into the setup dialog but not saved.
export function redactSecretsWith(text: string, extraSecrets: string[]): string {
  return maskPatterns(maskSecretValues(text, [...redactionSecrets(), ...extraSecrets]));
}

// Error → redacted single-line message, for Notices, card error bodies and
// CLI/MCP error payloads.
export function redactError(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e));
}
