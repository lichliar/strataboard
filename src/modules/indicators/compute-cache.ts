/**
 * Memoizes indicator calculations. The cache stores the RAW result (unix
 * second times, before adaptResultTimes): the key pins the bars (length +
 * first/last bar time + first/last close, enough to tell two symbols apart),
 * and bar identity implies the rows, so the caller re-runs the cheap time
 * adaptation on every hit.
 */

import type { Bar } from "oakscriptjs";
import type { IndicatorResultLike } from "./contract";

const MAX_ENTRIES = 200;

export class IndicatorComputeCache {
  private cache = new Map<string, IndicatorResultLike>();

  private key(id: string, inputs: Record<string, unknown> | undefined, bars: Bar[]): string {
    const first = bars[0];
    const last = bars[bars.length - 1];
    return `${id}|${JSON.stringify(inputs ?? {})}`
      + `|${bars.length}`
      + `|${first?.time ?? 0}|${last?.time ?? 0}`
      + `|${first?.close ?? 0}|${last?.close ?? 0}`;
  }

  get(id: string, inputs: Record<string, unknown> | undefined, bars: Bar[]): IndicatorResultLike | undefined {
    return this.cache.get(this.key(id, inputs, bars));
  }

  set(id: string, inputs: Record<string, unknown> | undefined, bars: Bar[], result: IndicatorResultLike): void {
    const key = this.key(id, inputs, bars);
    if (this.cache.has(key)) this.cache.delete(key); // refresh recency
    // Evict the oldest entry (Map iteration is insertion-ordered).
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, result);
  }

  invalidateByIndicator(id: string): void {
    const prefix = `${id}|`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

export const indicatorComputeCache = new IndicatorComputeCache();
