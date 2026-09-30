import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { request as httpsRequest } from "https";

// Global serial throttle for every outbound data request (设置页 → 数据源
// 设置 → 请求最小间隔). All API clients must acquire a slot before
// firing, so bursts (e.g. 全部刷新 across many cards) get spaced out instead
// of hammering the data platform and risking a rate-limit ban.

// Conservative safe floor (≈300 req/min, under typical data-platform rate
// tiers): the user-facing slider cannot go below this, and any stale stored
// value is clamped here so high-frequency bursts cannot get an IP banned.
export const MIN_REQUEST_INTERVAL_MS = 200;

let minIntervalMs = 500;
let chain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

export function setRequestInterval(ms: number): void {
  minIntervalMs = Math.max(MIN_REQUEST_INTERVAL_MS, ms);
}

function sleep(ms: number): Promise<void> {
  // globalThis (not window): this module is shared with the Node CLI build.
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

// Serial queue: each acquisition waits for the previous one to settle, then
// sleeps until minIntervalMs has elapsed since the previous slot was handed
// out. Awaiting this before ANY outbound request (requestUrl or Node https,
// see the transport option below) puts every client under the same interval.
export function acquireHttpSlot(): Promise<void> {
  const run = chain.then(async () => {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  // Keep the queue alive even when an acquisition rejects.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Throttled drop-in for Obsidian's requestUrl.
// transport "node" routes the request through Node's https module (HTTP/1.1)
// for hosts that reset Electron/Chromium's HTTP/2 stack (e.g.
// api.stlouisfed.org with net::ERR_HTTP2_PROTOCOL_ERROR). Desktop-only
// plugin, so Node builtins are available.
// Both transports go through the same serial throttle queue above, share a
// default 30s timeout (requestUrl itself has none — a black-hole endpoint
// would hang a card forever), and retry transient network/timeout failures
// `retry` times (default 1). HTTP status errors never retry: a 4xx/5xx will
// not heal by resending.
export interface HttpRequestOptions extends RequestUrlParam {
  transport?: "node";
  // Declared here because the bundled obsidian.d.ts predates it; requestUrl
  // honors it at runtime and the node transport replicates the behavior.
  throwOnHttpError?: boolean;
  timeoutMs?: number; // default 30000
  retry?: number;     // extra attempts on network/timeout errors, default 1
}

const DEFAULT_TIMEOUT_MS = 30000;

// HTTP status failure (response received, status >= 400) — distinguished
// from network/timeout failures so the retry loop can leave it alone.
export class HttpStatusError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

export async function httpRequest(params: HttpRequestOptions): Promise<RequestUrlResponse> {
  const options = withDefaultHeaders(params);
  const attempts = 1 + Math.max(0, options.retry ?? 1);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await acquireHttpSlot();
    try {
      return await sendOnce(options);
    } catch (e) {
      if (e instanceof HttpStatusError) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

// One attempt on the chosen transport. Both transports resolve the raw
// response here and share the status check, so throwOnHttpError behaves
// identically either way and status errors carry a recognizable type.
async function sendOnce(options: HttpRequestOptions): Promise<RequestUrlResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response =
    options.transport === "node"
      ? await nodeHttpsRequest(options, timeoutMs)
      : await withTimeout(requestUrl({ ...options, throwOnHttpError: false } as RequestUrlParam), timeoutMs);
  if (options.throwOnHttpError !== false && response.status >= 400) {
    throw new HttpStatusError(response.status);
  }
  return response;
}

// Rejects with a timeout error when the promise does not settle in time.
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // globalThis (not window): this module is shared with the Node CLI build.
    const timer = globalThis.setTimeout(() => reject(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// A request with a body defaults to a JSON content type (custom-source POST
// bodies are JSON); an explicit Content-Type header always wins.
function withDefaultHeaders(params: HttpRequestOptions): HttpRequestOptions {
  if (params.body === undefined) return params;
  const headers = { ...(params.headers ?? {}) };
  const hasContentType = Object.keys(headers).some((name) => name.toLowerCase() === "content-type");
  if (!hasContentType) headers["Content-Type"] = "application/json";
  return { ...params, headers };
}

// Node https (HTTP/1.1) transport returning the same {json, text, status}
// shape as requestUrl. HTTP status handling lives in sendOnce so both
// transports share it. Plaintext http:// is refused up front (Node's https
// module would throw a cryptic "Protocol not supported" otherwise) — the
// message points at the default transport for intranet/local services.
function nodeHttpsRequest(params: HttpRequestOptions, timeoutMs: number): Promise<RequestUrlResponse> {
  if (params.url.startsWith("http:")) {
    return Promise.reject(
      new Error(`transport "node" 只支持 https URL；明文 http 的自建/内网服务请改用默认传输（去掉 transport: "node"）。`),
    );
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      params.url,
      { method: params.method ?? "GET", headers: params.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString("utf8");
          let json: unknown = undefined;
          try {
            json = JSON.parse(text) as unknown;
          } catch {
            // Non-JSON body: requestUrl leaves .json undefined the same way.
          }
          const bytes = new Uint8Array(buffer.length);
          bytes.set(buffer);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            arrayBuffer: bytes.buffer,
            json,
            text,
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`)));
    req.on("error", reject);
    if (params.body !== undefined) {
      req.write(typeof params.body === "string" ? params.body : Buffer.from(params.body));
    }
    req.end();
  });
}
