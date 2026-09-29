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
  return new Promise((resolve) => setTimeout(resolve, ms));
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
// Both transports go through the same serial throttle queue above.
export interface HttpRequestOptions extends RequestUrlParam {
  transport?: "node";
  // Declared here because the bundled obsidian.d.ts predates it; requestUrl
  // honors it at runtime and the node transport replicates the behavior.
  throwOnHttpError?: boolean;
}

export function httpRequest(params: HttpRequestOptions): Promise<RequestUrlResponse> {
  const options = withDefaultHeaders(params);
  return acquireHttpSlot().then(() =>
    options.transport === "node" ? nodeHttpsRequest(options) : requestUrl(options),
  );
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
// shape as requestUrl, including its throw-on-HTTP-error default.
function nodeHttpsRequest(params: HttpRequestOptions): Promise<RequestUrlResponse> {
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
          let json: any = undefined;
          try {
            json = JSON.parse(text);
          } catch {
            // Non-JSON body: requestUrl leaves .json undefined the same way.
          }
          const bytes = new Uint8Array(buffer.length);
          bytes.set(buffer);
          const response: RequestUrlResponse = {
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            arrayBuffer: bytes.buffer as ArrayBuffer,
            json,
            text,
          };
          if (params.throwOnHttpError !== false && response.status >= 400) {
            reject(new Error(`HTTP ${response.status}`));
          } else {
            resolve(response);
          }
        });
      },
    );
    req.setTimeout(30000, () => req.destroy(new Error("Request timed out after 30s.")));
    req.on("error", reject);
    if (params.body !== undefined) {
      req.write(typeof params.body === "string" ? params.body : Buffer.from(params.body));
    }
    req.end();
  });
}
