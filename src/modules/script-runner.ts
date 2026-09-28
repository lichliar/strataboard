import { execFile } from "child_process";

// 「立即运行」 implementation for the script manager: runs a user Python
// script once, capturing stdout/stderr for the modal's log area. A bare
// `python3` resolves through the user's login shell (GUI apps get a stripped
// PATH), the script path is a single quoted argv element (never
// shell-interpolated), 180s timeout, bounded buffers.
// Node-only on purpose (no obsidian imports) so it stays exercisable outside
// the plugin.

export interface ScriptRunResult {
  code: number;     // process exit code (0 = success; 127 = python3 not found)
  stdout: string;   // tail-capped
  stderr: string;   // tail-capped; carries the spawn error text when the process never started
  timedOut: boolean;
}

const SCRIPT_TIMEOUT_MS = 180_000;
// Per-stream tail kept for the log area.
const MAX_OUTPUT_CHARS = 8000;

function tail(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `…\n${text.slice(-MAX_OUTPUT_CHARS)}` : text;
}

// Minimal POSIX single-quote escaping for the login-shell invocation path.
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

// Runs `python3 <filename>` with absDir as the working directory. Never
// rejects: failures (non-zero exit, missing python3, timeout) come back as a
// result the modal renders verbatim.
export function runScript(absDir: string, filename: string): Promise<ScriptRunResult> {
  const isWindows = process.platform === "win32";
  const file = isWindows ? "python" : process.env.SHELL || "/bin/zsh";
  const args = isWindows ? [filename] : ["-lc", `python3 ${shellQuote(filename)}`];
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: absDir, timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        // A spawn failure (ENOENT) has a string code and no stderr; surface
        // its message so the log area is never empty.
        const errText = stderr || (error && typeof error.code === "string" ? error.message : "");
        resolve({
          code,
          stdout: tail(stdout ?? ""),
          stderr: tail(errText),
          timedOut: !!error && error.killed === true,
        });
      }
    );
  });
}
