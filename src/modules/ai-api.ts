import type { ApiProviderDef } from "../types";
import type { ResolvedCli, RunningCli } from "./ai-cli";
import { httpRequest } from "./http";

// Online LLM client for OpenAI-compatible chat-completions endpoints
// (DeepSeek, GPT, Kimi, 通义千问, OpenRouter, ...). The plugin ships no
// keys — baseUrl/apiKey/model are all user-configured (设置页 → AI 助手 →
// 在线 API 模型). The presets below only prefill the edit dialog.
//
// The agent loop (ai-agent.ts) drives multi-turn conversations by re-sending
// the full transcript each round, so one API round is a single user message.

export interface AiApiPreset {
  name: string;
  baseUrl: string;
  model: string; // suggested model, used as the dialog placeholder
}

// Well-known OpenAI-compatible endpoints for the edit dialog's 服务商
// dropdown; selecting one prefills baseUrl/model (both stay editable).
export const AI_API_PRESETS: AiApiPreset[] = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { name: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
];

// Adapts an API provider to the shared ResolvedCli shape so pickers and the
// agent loop treat it like any other entry; command/buildArgs are unused.
export function resolveApiProvider(def: ApiProviderDef): ResolvedCli {
  return {
    id: def.id,
    label: `${def.name} (API)`,
    command: "",
    buildArgs: () => [],
    api: def,
  };
}

// Accepts a bare base (https://host/v1) or a full endpoint URL.
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

const DEFAULT_TIMEOUT_MS = 180_000;
// argv limits don't apply to HTTP, but the transcript still has to fit the
// model's context — cap it with a clear error instead of a provider 400.
const MAX_PROMPT_CHARS = 200_000;

// One non-streaming chat-completions call. Goes through the global http
// throttle like every other outbound request. Obsidian's requestUrl cannot
// be aborted mid-flight, so cancel() rejects immediately and the late
// response is discarded; the loop's between-round isCancelled checks cover
// the rest.
export function runApiModel(
  def: ApiProviderDef,
  prompt: string,
  opts?: { timeoutMs?: number }
): RunningCli {
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      promise: Promise.reject(new Error("对话记录过长，请清空对话后重试。")),
      cancel: () => {},
    };
  }

  let cancelled = false;
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    rejectFn = reject;
    const timer = setTimeout(() => {
      if (!cancelled) reject(new Error(`${def.name} 请求超时`));
    }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    httpRequest({
      url: chatCompletionsUrl(def.baseUrl),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${def.apiKey}`,
      },
      body: JSON.stringify({
        model: def.model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
      throw: false,
    }).then(
      (res) => {
        clearTimeout(timer);
        if (cancelled) return;
        if (res.status < 200 || res.status >= 300) {
          reject(new Error(`${def.name} 请求失败（HTTP ${res.status}）：${extractErrorMessage(res)}`));
          return;
        }
        const content = (res.json as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
          ?.message?.content;
        if (typeof content === "string" && content.trim()) {
          resolve(content.trim());
          return;
        }
        reject(new Error(`${def.name} 返回格式无法识别：${res.text.slice(0, 300)}`));
      },
      (e) => {
        clearTimeout(timer);
        if (!cancelled) {
          reject(new Error(`${def.name} 请求失败：${e instanceof Error ? e.message : String(e)}`));
        }
      }
    );
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      rejectFn(new Error("cancelled"));
    },
  };
}

function extractErrorMessage(res: { json: unknown; text: string }): string {
  const msg = (res.json as { error?: { message?: unknown } })?.error?.message;
  if (typeof msg === "string" && msg.trim()) return msg.slice(0, 300);
  return res.text.slice(0, 300);
}
