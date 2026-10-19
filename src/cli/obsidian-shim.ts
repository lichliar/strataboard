// Obsidian API shim for the standalone Node CLI (src/cli/main.ts). esbuild
// aliases the "obsidian" import to this file when bundling the CLI, so the
// obsidian-free parser/client modules resolve their small obsidian surface
// (requestUrl + RequestUrlParam/RequestUrlResponse types, Notice) against
// these definitions instead of the real Electron-side API. Only add exports
// here when the CLI's module chain genuinely imports them.

import { redactSecrets } from "../modules/redact";

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throwOnHttpError?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any;
  text: string;
}

// Drop-in for Obsidian's requestUrl on top of global fetch (Node 18+).
// Obsidian semantics: status >= 400 throws unless throwOnHttpError: false.
export async function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
  const headers: Record<string, string> = { ...(param.headers ?? {}) };
  if (param.contentType && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["Content-Type"] = param.contentType;
  }
  const res = await fetch(param.url, {
    method: param.method ?? "GET",
    headers,
    body: param.body as BodyInit | undefined,
  });
  const arrayBuffer = await res.arrayBuffer();
  const text = new TextDecoder("utf-8").decode(arrayBuffer);
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON body: match real requestUrl, which leaves .json undefined.
  }
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const out: RequestUrlResponse = {
    status: res.status,
    headers: responseHeaders,
    arrayBuffer,
    json,
    text,
  };
  if (param.throwOnHttpError !== false && res.status >= 400) {
    // Never embed the URL (it may carry a resolved credential in the query);
    // callers re-check status themselves, so this branch is a last resort.
    throw new Error(`Request failed with status ${res.status}: ${text.slice(0, 300)}`);
  }
  return out;
}

// Notices are UI toasts in Obsidian; in the CLI they log to stderr so stdout
// stays pure JSON. Redacted: upstream messages can carry request content.
export class Notice {
  constructor(message?: string) {
    if (message) console.error(`[notice] ${redactSecrets(message)}`);
  }
}

// Value-import stubs for modules whose obsidian usage the CLI never executes
// (e.g. card-index.ts's CardIndex class is tree-shaken; only the pure
// extractSpreadId/newSpreadId helpers run). Instantiating these is a bug.
export class TFile {}
export class App {}
