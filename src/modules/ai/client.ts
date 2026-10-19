// BYOK client for the in-plugin AI assistant (设置 → AI 助手 → 插件内 AI).
// One OpenAI-compatible Chat Completions call per request through the central
// http seam (modules/http.ts) — non-streaming (both http transports buffer
// whole responses), retry 0 so a failed attempt never silently re-bills the
// user's account. The API key lives in SecretStorage behind a credentialId
// (modules/credentials.ts) and reaches only the configured endpoint as an
// Authorization header; the central redactor masks every stored credential.

import { httpRequest, HttpStatusError } from "../http";
import { t } from "../../i18n";

export interface AiConnectionConfig {
  // OpenAI-compatible API root, e.g. https://api.example.com/v1 — the request
  // goes to {baseUrl}/chat/completions.
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// 未配置 = undefined or blank fields; the AI panel/settings gate on this.
export function isAiConfigured(s?: { baseUrl: string; model: string } | undefined): boolean {
  return !!s && !!s.baseUrl.trim() && !!s.model.trim();
}

// One chat completion; returns the first choice's message content. HTTP
// status failures map to stable Chinese causes (surfaced via redactError by
// callers); network/timeout errors propagate as thrown by http.ts.
export async function chatCompletion(cfg: AiConnectionConfig, messages: AiChatMessage[]): Promise<string> {
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  let response;
  try {
    response = await httpRequest({
      url: `${cfg.baseUrl.trim().replace(/\/+$/, "")}/chat/completions`,
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model.trim(), messages, response_format: { type: "json_object" } }),
      timeoutMs: 90_000,
      retry: 0,
    });
  } catch (e) {
    if (e instanceof HttpStatusError) {
      if (e.status === 401 || e.status === 403) throw new Error(t("凭据无效或被拒绝"));
      if (e.status === 404) throw new Error(t("端点地址或模型不存在"));
      if (e.status === 429) throw new Error(t("服务商限流，请稍后重试"));
      if (e.status >= 500) throw new Error(t("服务商异常（{status}）", { status: e.status }));
    }
    throw e;
  }
  const content = (response.json as { choices?: { message?: { content?: unknown } }[] } | undefined)?.choices?.[0]
    ?.message?.content;
  if (typeof content !== "string" || !content) throw new Error(t("服务商返回了无法识别的响应"));
  return content;
}
