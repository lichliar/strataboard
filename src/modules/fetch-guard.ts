import { HttpStatusError } from "./http";

// Rate-limit guard for outbound data fetches: classifies rate-limit-style
// failures and holds a per-source circuit breaker. Pure TS (no obsidian
// imports) so the CLI/Node builds can share it. State is in-memory — a
// plugin reload resets every breaker.

// Errors that may heal by waiting and resending: HTTP 429/5xx, or a business
// error whose message reads like rate limiting (custom sources pass their
// platform's error text through extractApiError verbatim).
export function isRateLimitError(e: unknown): boolean {
  if (e instanceof HttpStatusError) return e.status === 429 || e.status >= 500;
  const message = e instanceof Error ? e.message : String(e);
  return /频率|限流|频繁|过快|请求次数|超出.*限制|rate.?limit|too many|throttl|429/i.test(message);
}

// Consecutive failures before a source is paused, and how long the pause
// lasts. Rate-limit windows on data platforms are typically per-minute, so
// five minutes gives ample headroom without feeling stuck.
export const MAX_CONSECUTIVE_FAILURES = 3;
export const TRIP_COOLDOWN_MS = 5 * 60 * 1000;

interface BreakerState {
  failures: number;
  trippedUntil: number;
}

const breakers = new Map<string, BreakerState>();

// Whether the source may fire another request right now. An expired cooldown
// clears the record, so the next attempt starts from a clean slate.
export function canAttempt(key: string): boolean {
  const state = breakers.get(key);
  if (!state) return true;
  if (state.trippedUntil > Date.now()) return false;
  breakers.delete(key);
  return true;
}

export function recordSuccess(key: string): void {
  breakers.delete(key);
}

// Counts a failed attempt. Returns true exactly once per trip — the moment
// the failure count reaches the cap — so callers can fire a single Notice
// instead of one per failing card.
export function recordFailure(key: string): boolean {
  const state = breakers.get(key) ?? { failures: 0, trippedUntil: 0 };
  state.failures += 1;
  if (state.failures >= MAX_CONSECUTIVE_FAILURES && state.trippedUntil <= Date.now()) {
    state.trippedUntil = Date.now() + TRIP_COOLDOWN_MS;
    breakers.set(key, state);
    return true;
  }
  breakers.set(key, state);
  return false;
}

export function sleep(ms: number): Promise<void> {
  // globalThis (not window): shared with the Node CLI build.
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
