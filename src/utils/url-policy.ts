// Central URL policy for every outbound data request (utils, not modules:
// this must stay importable from the CLI bundle — no obsidian imports).
// Templates are filled BEFORE evaluation, so this sees the real request URL.
//
// Rules:
// - http/https only; URL userinfo (user:pass@host) is always rejected.
// - Plaintext http is allowed only for loopback targets (localhost,
//   127.0.0.0/8, [::1]) whose origin the user explicitly confirmed once;
//   everything else over http is rejected.
// - Cloud metadata endpoints are rejected over any scheme.
// - Private / link-local ranges over https pass with a high-risk warning the
//   save-time UI surfaces (request-time enforcement cannot block them —
//   self-hosted LAN services are a supported use case).
//
// Known limitation: default transport (requestUrl) and fetch follow
// redirects internally and the final URL cannot be re-validated; the node
// transport does not follow redirects at all. DNS names resolving to private
// IPs are likewise out of scope for a synchronous check.

export type UrlPolicyVerdict =
  | { kind: "ok" }
  // Plaintext http to loopback, not yet confirmed by the user. `origin` is
  // what the confirmation persists (scheme + host + port).
  | { kind: "loopback-http"; origin: string }
  // Private/link-local https target: allowed, but the UI warns once at
  // save time.
  | { kind: "warn-private"; host: string }
  | { kind: "reject"; reason: string };

// Well-known cloud metadata endpoints (SSRF targets), blocked over any
// scheme: AWS/GCP/Azure/Alibaba.
const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "100.100.100.200"]);

function ipv4ToInt(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

// Node's URL keeps the brackets on IPv6 hostnames ("[::1]").
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "[::1]" || h === "[0:0:0:0:0:0:0:1]") return true;
  const v4 = ipv4ToInt(h);
  return v4 !== null && v4 >>> 24 === 127;
}

function isPrivateOrLinkLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h.startsWith("[")) {
    // IPv6: fc00::/7 (ULA) and fe80::/10 (link-local).
    return /^\[(fc|fd)[0-9a-f]{2}:/.test(h) || /^\[fe[89ab][0-9a-f]:/.test(h);
  }
  const v4 = ipv4ToInt(h);
  if (v4 === null) return false;
  const a = v4 >>> 24;
  const b = (v4 >>> 16) & 0xff;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169;
}

export function evaluateUrl(rawUrl: string, allowedLoopbackHttpOrigins: readonly string[]): UrlPolicyVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "reject", reason: `URL 无法解析：${rawUrl.slice(0, 120)}` };
  }
  if (url.username || url.password) {
    return { kind: "reject", reason: "URL 不允许内嵌用户名/密码（user:pass@host），请改用鉴权 Header。" };
  }
  const host = url.hostname.toLowerCase();
  if (METADATA_HOSTS.has(host)) {
    return { kind: "reject", reason: `目标地址 ${host} 是云 metadata 端点，已拒绝。` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "reject", reason: `只支持 http/https URL，收到 ${url.protocol}//。` };
  }
  const loopback = isLoopbackHost(host);
  if (url.protocol === "http:") {
    if (!loopback) {
      return { kind: "reject", reason: "明文 http 仅允许本机回环地址（localhost/127.0.0.1/[::1]）；公网与内网地址请改用 https。" };
    }
    if (!allowedLoopbackHttpOrigins.includes(url.origin)) {
      return { kind: "loopback-http", origin: url.origin };
    }
    return { kind: "ok" };
  }
  if (!loopback && isPrivateOrLinkLocalHost(host)) {
    return { kind: "warn-private", host };
  }
  return { kind: "ok" };
}

// Throws for the verdicts a request must not proceed with; "ok" and
// "warn-private" pass (the warning is a save-time UI concern).
export function assertUrlAllowed(rawUrl: string, allowedLoopbackHttpOrigins: readonly string[]): void {
  const verdict = evaluateUrl(rawUrl, allowedLoopbackHttpOrigins);
  if (verdict.kind === "reject") throw new Error(verdict.reason);
  if (verdict.kind === "loopback-http") {
    throw new Error(`明文 http 目标 ${verdict.origin} 尚未确认：请在设置页重新保存该数据源并确认允许本机明文请求。`);
  }
}
