import { spawn } from "child_process";
import * as nodePath from "path";

// 「立即运行」 implementation for the script manager: runs one user Python
// script, capturing stdout/stderr for the modal's log area. The interpreter
// is a configured ABSOLUTE path and the process is spawned directly (never
// through a login/interactive shell), so killing the child kills Python
// itself and no shell profile can inject config. The child gets a minimal
// allowlisted environment — data-source/AI secrets in the plugin process
// env never reach scripts. 180s timeout with SIGTERM→SIGKILL escalation,
// bounded output retention. Node-only on purpose (no obsidian imports) so it
// stays exercisable outside the plugin.

export interface ScriptRunResult {
  code: number;     // process exit code (0 = success; 127 = interpreter not found)
  stdout: string;   // tail-capped
  stderr: string;   // tail-capped; carries the spawn error text when the process never started
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean; // either stream exceeded the retained cap (log shows a hint)
}

export const SCRIPT_TIMEOUT_MS = 180_000;
// Per-stream tail kept for the log area.
export const MAX_OUTPUT_CHARS = 8000;

// True when `child` (a resolved real path) lies inside `root` (also a resolved
// real path). The caller realpaths both sides first, so a symlinked script
// pointing outside the script folder fails this check.
export function isPathInside(root: string, child: string): boolean {
  const rel = nodePath.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !nodePath.isAbsolute(rel);
}

// Minimal environment for the child process. Python needs a PATH for its own
// subprocesses, HOME/TMPDIR for its cache/temp dirs, and locale variables for
// stdout encoding. Everything else — especially credentials — is dropped.
export function buildScriptEnv(): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    const env: NodeJS.ProcessEnv = {
      SystemRoot: root,
      PATH: [root + "\\System32", root, root + "\\System32\\Wbem"].join(";"),
    };
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
    if (process.env.TEMP) env.TEMP = process.env.TEMP;
    if (process.env.TMP) env.TMP = process.env.TMP;
    return env;
  }
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    // GUI launches often lack LANG; without it older Pythons encode stdout
    // as ASCII and crash on non-ASCII output.
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
  return env;
}

export interface ScriptRunOptions {
  interpreter: string;  // resolved absolute real path of the Python interpreter
  scriptPath: string;   // resolved absolute real path of the script (symlink-checked by the caller)
  cwd: string;          // resolved real path of the script folder
  timeoutMs?: number;   // tests override; production uses SCRIPT_TIMEOUT_MS
}

// Keeps only the tail of a growing stream so a runaway print() cannot exhaust
// memory; the caller surfaces `truncated` in the log area.
function makeTailSink(): { push: (chunk: Buffer) => void; text: () => string; truncated: () => boolean } {
  let buf = "";
  let truncated = false;
  return {
    push(chunk: Buffer) {
      buf += chunk.toString("utf8");
      if (buf.length > MAX_OUTPUT_CHARS) {
        truncated = true;
        buf = buf.slice(-MAX_OUTPUT_CHARS);
      }
    },
    text: () => buf,
    truncated: () => truncated,
  };
}

// Runs `<interpreter> <scriptPath>` with cwd as the working directory. Never
// rejects: failures (non-zero exit, missing interpreter, timeout) come back
// as a result the modal renders verbatim.
export function runScript(options: ScriptRunOptions): Promise<ScriptRunResult> {
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const stdout = makeTailSink();
    const stderr = makeTailSink();
    let timedOut = false;
    let settled = false;

    const finish = (result: ScriptRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(options.interpreter, [options.scriptPath], {
        cwd: options.cwd,
        env: buildScriptEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      finish({
        code: 1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        timedOut: false,
        cancelled: false,
        truncated: false,
      });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    // Timeout: the spawned process IS the Python interpreter (no shell
    // wrapper), so SIGTERM reaches it directly; SIGKILL follows if it
    // ignores the graceful signal.
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      forceTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 2000);
      if (typeof forceTimer === "object" && forceTimer && "unref" in forceTimer) forceTimer.unref();
    }, timeoutMs);

    // Spawn failure (ENOENT: interpreter path wrong/deleted) — surface its
    // message so the log area is never empty.
    child.on("error", (err) => {
      finish({
        code: 127,
        stdout: "",
        stderr: err.message,
        timedOut,
        cancelled: false,
        truncated: stdout.truncated() || stderr.truncated(),
      });
    });

    child.on("close", (code) => {
      finish({
        code: typeof code === "number" ? code : 1,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        cancelled: false,
        truncated: stdout.truncated() || stderr.truncated(),
      });
    });
  });
}
