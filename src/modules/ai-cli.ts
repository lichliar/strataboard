import { execFile, type ChildProcess } from "child_process";
import type { ApiProviderDef, CustomCliDef } from "../types";

// Local AI CLI detection + invocation. Node-only on purpose (no obsidian
// imports) so the heuristics stay exercisable outside the plugin.
//
// Every CLI here takes one prompt and prints the assistant's answer to
// stdout in its non-interactive mode; the agent loop (ai-agent.ts) drives
// multi-turn conversations by re-sending the full transcript each round.

export interface AiCliPreset {
  id: string; // "claude" | "kimi" | "codex" | "gemini"
  label: string;
  command: string; // bare executable name resolved via the login shell's PATH
  buildArgs: (prompt: string) => string[];
  // Optional stdout post-processor (e.g. kimi's stream-json transcript).
  parseOutput?: (stdout: string) => string;
}

// Kimi's plain text mode prefixes assistant lines with "• " (and indents
// wraps), which would corrupt the tool-call json fences — use its
// stream-json mode instead and keep only assistant message content.
function parseKimiStreamJson(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.role === "assistant" && typeof obj.content === "string") {
        parts.push(obj.content);
      }
    } catch {
      // Non-JSON lines (shouldn't happen in stream-json mode) are ignored.
    }
  }
  return parts.join("\n").trim();
}

// Verified non-interactive invocations:
//   claude -p "<prompt>"   (print mode)
//   kimi   -p "<prompt>" --output-format stream-json
//   codex  exec "<prompt>"
//   gemini -p "<prompt>"
export const AI_CLI_PRESETS: AiCliPreset[] = [
  { id: "claude", label: "Claude Code", command: "claude", buildArgs: (prompt) => ["-p", prompt] },
  {
    id: "kimi",
    label: "Kimi Code",
    command: "kimi",
    buildArgs: (prompt) => ["-p", prompt, "--output-format", "stream-json"],
    parseOutput: parseKimiStreamJson,
  },
  { id: "codex", label: "Codex CLI", command: "codex", buildArgs: (prompt) => ["exec", prompt] },
  { id: "gemini", label: "Gemini CLI", command: "gemini", buildArgs: (prompt) => ["-p", prompt] },
];

// A runnable model entry: either a detected preset (bare command) or a
// custom def whose argsTemplate expands the {prompt} placeholder — or, when
// `api` is set, an online OpenAI-compatible API model that the agent loop
// routes through runApiModel (ai-api.ts) instead of spawning a process.
export interface ResolvedCli {
  id: string;
  label: string;
  command: string; // bare name or absolute path (manual override); "" for API models
  buildArgs: (prompt: string) => string[];
  parseOutput?: (stdout: string) => string;
  api?: ApiProviderDef;
}

export function resolveCustomCli(def: CustomCliDef): ResolvedCli {
  return {
    id: def.id,
    label: def.name,
    command: def.command,
    buildArgs: (prompt) => def.argsTemplate.map((arg) => arg.replaceAll("{prompt}", prompt)),
  };
}

export interface RunningCli {
  promise: Promise<string>;
  cancel: () => void;
}

const DEFAULT_TIMEOUT_MS = 180_000;
// argv carries the whole transcript; keep a safety margin under the exec
// family arg limit (~256 KB on macOS/Linux).
const MAX_ARGV_CHARS = 200_000;

function isWindows(): boolean {
  return process.platform === "win32";
}

// GUI-launched apps on macOS/Linux inherit a stripped-down PATH (no
// /usr/local/bin, ~/.npm-global, ...), so detection goes through the user's
// login shell. Returns the resolved absolute path, or null when missing.
export async function detectCliPath(command: string): Promise<string | null> {
  // Absolute paths skip PATH resolution entirely.
  if (command.includes("/") || command.includes("\\")) {
    return new Promise((resolve) => {
      execFile(command, ["--version"], { timeout: 15_000 }, (error) => {
        resolve(error && (error as NodeJS.ErrnoException).code === "ENOENT" ? null : command);
      });
    });
  }
  if (isWindows()) {
    return new Promise((resolve) => {
      execFile("where", [command], { timeout: 15_000 }, (error, stdout) => {
        if (error) return resolve(null);
        const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        resolve(first ?? null);
      });
    });
  }
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(shell, ["-lc", `command -v ${command}`], { timeout: 15_000 }, (error, stdout) => {
      if (error) return resolve(null);
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      resolve(first ?? null);
    });
  });
}

// Runs the CLI once with the full prompt as a single argv element (never
// shell-interpolated). Bare commands execute through the login shell so the
// user's PATH applies; absolute paths run directly. The returned handle
// supports cancellation (kills the process; the promise rejects).
export function runCli(
  cli: ResolvedCli,
  prompt: string,
  opts?: { timeoutMs?: number }
): RunningCli {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = cli.buildArgs(prompt);
  const totalChars = args.reduce((sum, a) => sum + a.length, 0);
  if (totalChars > MAX_ARGV_CHARS) {
    return {
      promise: Promise.reject(new Error("prompt too long for a single CLI invocation")),
      cancel: () => {},
    };
  }

  const isBare = !cli.command.includes("/") && !cli.command.includes("\\");
  let file: string;
  let fileArgs: string[];
  if (isBare && !isWindows()) {
    const shell = process.env.SHELL || "/bin/zsh";
    file = shell;
    // argv-safe: the prompt is one quoted argv element here. We pass the
    // command + args as a single -c string only after JSON-quoting each arg.
    fileArgs = ["-lc", [cli.command, ...args].map(shellQuote).join(" ")];
  } else {
    file = cli.command;
    fileArgs = args;
  }

  let child: ChildProcess | null = null;
  let cancelled = false;
  const promise = new Promise<string>((resolve, reject) => {
    child = execFile(
      file,
      fileArgs,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (cancelled) {
          reject(new Error("cancelled"));
          return;
        }
        if (error) {
          const detail = stderr.trim().slice(0, 500);
          reject(new Error(detail ? `${cli.label} 调用失败：${detail}` : `${cli.label} 调用失败：${error.message}`));
          return;
        }
        const out = cli.parseOutput ? cli.parseOutput(stdout) : stdout.trim();
        if (!out) {
          reject(new Error(`${cli.label} 没有返回内容${stderr.trim() ? `（${stderr.trim().slice(0, 300)}）` : ""}`));
          return;
        }
        resolve(out);
      }
    );
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      child?.kill("SIGTERM");
    },
  };
}

// Minimal POSIX single-quote escaping for the login-shell invocation path.
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}
