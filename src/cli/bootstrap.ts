import { assertSupportedNodeVersion } from "./node-version";

let supported = true;
try {
  assertSupportedNodeVersion();
} catch (error) {
  supported = false;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
  process.exitCode = 1;
}

// Load jsdom and the other command dependencies only after the runtime check.
if (supported) require("./main");
