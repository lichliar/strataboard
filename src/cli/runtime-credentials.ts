// CLI/MCP credential seam: a headless process has no SecretStorage, so
// runtime secrets come only from per-source environment variables (see
// modules/credentials.ts). Every secret actually used is tracked so the
// central redactor masks it in stdout/stderr output.
import { createEnvApiKeyResolver, setRedactionSecretProvider, type ApiKeyResolver } from "../modules/credentials";

const usedSecrets: string[] = [];
setRedactionSecretProvider(() => usedSecrets);

export function cliApiKeyResolver(): ApiKeyResolver {
  return createEnvApiKeyResolver(process.env, (secret) => usedSecrets.push(secret));
}
