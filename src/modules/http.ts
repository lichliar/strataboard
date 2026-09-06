import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";

// Global serial throttle for every outbound data request (设置页 → 数据源
// API 设置 → 请求最小间隔). All API clients must acquire a slot before
// firing, so bursts (e.g. 全部刷新 across many cards) get spaced out instead
// of hammering the data platform and risking a rate-limit ban.

// Conservative safe floor (≈300 req/min, under Tushare's lowest 500/min
// tier): the user-facing slider cannot go below this, and any stale stored
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
// out. Awaiting this before ANY outbound request (requestUrl or Node https —
// FRED uses the latter, see fred-api-client.ts) puts every client under the
// same interval.
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
export function httpRequest(params: RequestUrlParam): Promise<RequestUrlResponse> {
  return acquireHttpSlot().then(() => requestUrl(params));
}
