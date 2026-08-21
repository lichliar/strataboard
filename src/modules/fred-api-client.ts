import { get } from "https";
import type { FredSeriesInfo, SeriesPoint } from "../types";

export class FredApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "FredApiError";
  }
}

interface FredObservationsResponse {
  observations?: { date: string; value: string }[];
  error_message?: string;
}

interface FredSearchResponse {
  seriess?: {
    id: string;
    title: string;
    frequency: string;
    units: string;
    popularity: number;
    seasonal_adjustment?: string;
  }[];
  error_message?: string;
}

interface HttpJsonResult {
  status: number;
  json: unknown;
}

// Uses Node's https module (HTTP/1.1) instead of Obsidian's requestUrl:
// api.stlouisfed.org resets Electron/Chromium's HTTP/2 stack with
// net::ERR_HTTP2_PROTOCOL_ERROR, so every FRED call fails through
// requestUrl while plain HTTP/1.1 works. Desktop-only plugin, so Node
// builtins are available.
function httpGetJson(url: string, timeoutMs = 15000): Promise<HttpJsonResult> {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`FRED request timed out after ${timeoutMs / 1000}s.`));
    });
    req.on("error", reject);
  });
}

export class FredApiClient {
  private apiKey: string;
  private baseUrl = "https://api.stlouisfed.org/fred";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  private requireApiKey(): void {
    if (!this.apiKey) {
      throw new FredApiError("FRED API key is not configured.");
    }
  }

  // Interactive series search (by English title keywords), ordered by
  // popularity. No retry: the search modal surfaces failures directly.
  async searchSeries(text: string, limit = 20): Promise<FredSeriesInfo[]> {
    this.requireApiKey();

    const params = new URLSearchParams({
      search_text: text,
      api_key: this.apiKey,
      file_type: "json",
      order_by: "popularity",
      sort_order: "desc",
      limit: String(limit),
    });

    const { status, json: rawJson } = await httpGetJson(`${this.baseUrl}/series/search?${params.toString()}`);
    const json = rawJson as FredSearchResponse;

    if (status >= 400) {
      throw new FredApiError(json.error_message || `FRED API error: HTTP ${status}`, status);
    }
    if (json.error_message) {
      throw new FredApiError(json.error_message);
    }

    return (json.seriess ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      frequency: s.frequency,
      units: s.units,
      popularity: s.popularity,
      seasonalAdjustment: s.seasonal_adjustment,
    }));
  }

  // transform maps to the API's `units` parameter (chg/pch/pc1/...), asking
  // FRED to transform the values server-side; absent = raw levels (lin).
  async fetchSeries(seriesId: string, startDate?: string, transform?: string): Promise<SeriesPoint[]> {
    this.requireApiKey();

    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: this.apiKey,
      file_type: "json",
    });
    if (startDate) {
      params.set("observation_start", startDate);
    }
    if (transform) {
      params.set("units", transform);
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { status, json: rawJson } = await httpGetJson(`${this.baseUrl}/series/observations?${params.toString()}`);
        const json = rawJson as FredObservationsResponse;

        if (status >= 400) {
          throw new FredApiError(json.error_message || `FRED API error: HTTP ${status}`, status);
        }
        if (json.error_message) {
          throw new FredApiError(json.error_message);
        }

        const points: SeriesPoint[] = [];
        for (const obs of json.observations ?? []) {
          // FRED uses "." for missing values; skip those.
          if (obs.value === ".") continue;
          const value = Number(obs.value);
          if (!Number.isFinite(value)) continue;
          points.push({ date: obs.date, value });
        }
        return points.sort((a, b) => a.date.localeCompare(b.date));
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
    throw lastError ?? new FredApiError("Unknown FRED API error after retries.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
