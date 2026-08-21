import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { TushareResponse } from "../types";

export class TushareApiError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
    this.name = "TushareApiError";
  }
}

interface QueueEntry {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

class RequestQueue {
  private pending: QueueEntry[] = [];
  private running = 0;

  constructor(private concurrency: number) {}

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        fn,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.process();
    });
  }

  private process() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      this.running++;
      entry
        .fn()
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.running--;
          this.process();
        });
    }
  }
}

export class TushareApiClient {
  private token: string;
  private baseUrl = "https://api.tushare.pro";
  private queue = new RequestQueue(5);

  constructor(token: string) {
    this.token = token;
  }

  setToken(token: string) {
    this.token = token;
  }

  async query<T = unknown>(apiName: string, params: Record<string, unknown> = {}): Promise<TushareResponse<T>> {
    if (!this.token) {
      throw new TushareApiError("Tushare token is not configured.");
    }

    return this.queue.enqueue(async () => {
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response: RequestUrlResponse = await requestUrl({
            url: this.baseUrl,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              api_name: apiName,
              token: this.token,
              params,
              fields: "",
            }),
          });

          const json: TushareResponse<T> = response.json;

          if (json.code !== 0) {
            throw new TushareApiError(json.msg || `Tushare API error: ${json.code}`, json.code);
          }

          return json;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          if (e instanceof TushareApiError && e.code === -2000) {
            throw e;
          }
          await sleep(1000 * Math.pow(2, attempt));
        }
      }
      throw lastError ?? new TushareApiError("Unknown Tushare API error after retries.");
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
