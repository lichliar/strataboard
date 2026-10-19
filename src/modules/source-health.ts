// Session-scoped per-source connection health: the last data-request or
// wizard-probe outcome per source id, kept in memory only (never persisted).
// Recording only — nothing here changes fetch, retry or circuit-breaker
// behavior. Instrumented at three points: sendSourceRequest in
// custom-quote-client.ts (every remote request — kline / search / wizard
// probe / remote CSV text), the vault-CSV branch of DataAdapter.fetchOhlcv
// (local file reads), and the setup wizard's inline probe
// (custom-source-modal.ts). The 数据源 settings rows read it for their
// 正常/失败/未探测 badge. Pure module (no Obsidian imports): the CLI/MCP
// bundles load it too, where the map simply dies with the process.

export interface SourceHealth {
  state: "ok" | "failed";
  // Date.now() of the outcome.
  at: number;
  // Failure reason; reporters pass already-redacted messages.
  message?: string;
}

const health = new Map<string, SourceHealth>();

export function reportSourceHealth(sourceId: string, ok: boolean, message?: string): void {
  health.set(sourceId, { state: ok ? "ok" : "failed", at: Date.now(), ...(message ? { message } : {}) });
}

// Undefined means the source was never probed this session (未探测).
export function getSourceHealth(sourceId: string): SourceHealth | undefined {
  return health.get(sourceId);
}

export function clearSourceHealth(sourceId: string): void {
  health.delete(sourceId);
}
