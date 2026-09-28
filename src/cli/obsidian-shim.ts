// Obsidian API shim for the standalone Node CLI (src/cli/main.ts). esbuild
// aliases the "obsidian" import to this file when bundling the CLI, so the
// obsidian-free parser/client modules resolve their small obsidian surface
// (requestUrl + RequestUrlParam/RequestUrlResponse types, Notice) against
// these definitions instead of the real Electron-side API. Only add exports
// here when the CLI's module chain genuinely imports them.

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any;
  text: string;
}

// Drop-in for Obsidian's requestUrl on top of global fetch (Node 18+).
// Obsidian semantics: non-2xx throws unless `throw: false`.
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
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON body: callers that expect JSON will fail on the null below.
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
  if (param.throw !== false && (res.status < 200 || res.status >= 300)) {
    throw new Error(`Request to ${param.url} failed with status ${res.status}: ${text.slice(0, 300)}`);
  }
  return out;
}

// Notices are UI toasts in Obsidian; in the CLI they log to stderr so stdout
// stays pure JSON.
export class Notice {
  constructor(message?: string) {
    if (message) console.error(`[notice] ${message}`);
  }
}
