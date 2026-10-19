import type { CustomSourceDef, SearchEndpoint } from "../types";

// Credentials have one storage location: Obsidian SecretStorage, referenced
// from CustomSourceDef.credentialId (see modules/credentials.ts). Request
// templates may reference the runtime secret only through {apiKey}. This
// scanner catches obvious hard-coded credentials before a source is saved or
// any request is sent. It deliberately keys on parameter/header NAMES rather
// than trying to guess whether every opaque string is secret.

const SECRET_NAMES = new Set([
  "apikey",
  "xapikey",
  "key",
  "token",
  "apitoken",
  "authtoken",
  "xauthtoken",
  "accesstoken",
  "accesskey",
  "appkey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "pwd",
  "authorization",
  "proxyauthorization",
  "auth",
  "signature",
  "sig",
  "credential",
  "cookie",
]);

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretName(name: string): boolean {
  return SECRET_NAMES.has(normalizedName(name));
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isApiKeyReference(value: string, allowAuthScheme: boolean): boolean {
  const text = decoded(value).trim();
  return allowAuthScheme
    ? /^(?:(?:bearer|token|basic)\s+)?\{apiKey\}$/i.test(text)
    : text === "{apiKey}";
}

function inspectUrl(value: string | undefined, label: string, issues: string[]): void {
  if (!value) return;
  for (const match of value.matchAll(/[?&]([^=&?#]+)=([^&#]*)/g)) {
    const name = decoded(match[1]);
    if (isSecretName(name) && !isApiKeyReference(match[2], false)) {
      issues.push(`${label} 的参数 ${name}`);
    }
  }
}

function inspectNamedValues(
  values: Record<string, string> | undefined,
  label: string,
  issues: string[],
  allowReference: boolean,
): void {
  for (const [name, value] of Object.entries(values ?? {})) {
    if (isSecretName(name) && (!allowReference || !isApiKeyReference(value, true))) {
      issues.push(`${label}.${name}`);
    }
  }
}

function inspectBody(value: string | undefined, label: string, issues: string[]): void {
  if (!value) return;
  try {
    const parsed: unknown = JSON.parse(value);
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const [name, child] of Object.entries(node as Record<string, unknown>)) {
        const childPath = `${path}.${name}`;
        if (isSecretName(name) && (typeof child !== "string" || !isApiKeyReference(child, true))) {
          issues.push(childPath);
        }
        walk(child, childPath);
      }
    };
    walk(parsed, label);
    return;
  } catch {
    // Form bodies and non-JSON templates are inspected as name=value pairs.
  }
  for (const match of value.matchAll(/(?:^|[&;,\s])([A-Za-z][\w.-]*)\s*[=:]\s*([^&;,\s}][^&;,\s]*)/g)) {
    if (isSecretName(match[1]) && !isApiKeyReference(match[2], true)) {
      issues.push(`${label}.${match[1]}`);
    }
  }
}

function inspectEndpoint(endpoint: SearchEndpoint, label: string, issues: string[]): void {
  inspectUrl(endpoint.url, `${label}.url`, issues);
  inspectBody(endpoint.bodyTemplate, `${label}.bodyTemplate`, issues);
}

export function findEmbeddedCredentialFields(def: CustomSourceDef): string[] {
  const issues: string[] = [];
  inspectUrl(def.klineUrl, "klineUrl", issues);
  inspectUrl(def.searchUrl, "searchUrl", issues);
  inspectBody(def.bodyTemplate, "bodyTemplate", issues);
  inspectBody(def.searchBodyTemplate, "searchBodyTemplate", issues);

  inspectNamedValues(def.headers, "headers", issues, true);
  inspectNamedValues(def.params, "params", issues, true);
  for (const [profile, values] of Object.entries(def.profiles ?? {})) {
    inspectNamedValues(values, `profiles.${profile}`, issues, true);
  }
  for (const [index, symbol] of (def.symbols ?? []).entries()) {
    inspectNamedValues(symbol.params, `symbols[${index}].params`, issues, true);
  }
  for (const [index, endpoint] of (def.searches ?? []).entries()) {
    inspectEndpoint(endpoint, `searches[${index}]`, issues);
  }

  const header = def.apiKeyHeader?.trim();
  if (header) {
    const colon = header.indexOf(":");
    if (colon >= 0 && !isApiKeyReference(header.slice(colon + 1), true)) {
      issues.push("apiKeyHeader");
    }
  }

  return [...new Set(issues)];
}
