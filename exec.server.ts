import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ALLOWED_BINARIES, type CommandResult, type EnvironmentId } from "./contracts";
import { loadConfigState, requireEnvironment } from "./config.server";
import { expandHome, loadConnection } from "./kubeconfig.server";

const OUTPUT_LIMIT = 400_000;

/** Directories searched for the allowlisted binaries, ahead of inherited PATH. */
function searchPath(): string[] {
  const home = os.homedir();
  const inherited = (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry !== "");
  return [path.join(home, ".local", "bin"), path.join(home, "bin"), "/usr/local/bin", "/usr/bin", ...inherited];
}

export function resolveBinary(name: string): string | null {
  if (name.includes("/")) return existsSync(expandHome(name)) ? expandHome(name) : null;
  for (const dir of searchPath()) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Split a command line into argv the way a shell would for the simple cases:
 * whitespace separates, single and double quotes group, backslash escapes.
 * Anything a real shell would interpret further (pipes, redirects, `$(...)`)
 * is rejected by `shellMetacharacter` before we get here.
 */
export function tokenize(input: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote === null && (char === " " || char === "\t")) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    if (char === "\\" && quote !== "'" && i + 1 < input.length) {
      current += input[++i];
      started = true;
      continue;
    }
    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      started = true;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    current += char;
    started = true;
  }
  if (quote !== null) throw new Error("Unbalanced quote in command.");
  if (started) argv.push(current);
  return argv;
}

const SHELL_METACHARACTERS = /[|&;<>()$`]|\{\}|\*|\?|\[|\]/;

export function shellMetacharacter(input: string): string | null {
  const match = SHELL_METACHARACTERS.exec(input);
  return match ? match[0] : null;
}

export interface RunOptions {
  environmentId: EnvironmentId;
  command: string;
  namespace: string | null;
  /** Defaults to the configured mode; callers can pin it (Flux actions do). */
  mode?: "allowlist" | "bash";
  allowedBinaries?: readonly string[];
}

function clamp(text: string): { text: string; truncated: boolean } {
  return text.length > OUTPUT_LIMIT
    ? { text: `${text.slice(0, OUTPUT_LIMIT)}\n… output truncated`, truncated: true }
    : { text, truncated: false };
}

/**
 * Run one command with KUBECONFIG pointed at the selected environment.
 *
 * Two modes:
 *  - argv (default): the first word must be an allowlisted binary and the line
 *    is split without shell interpretation, so there is nothing to inject into.
 *  - shell: the whole line goes to `bash -lc`, which is what you want for pipes
 *    and redirects, and is only reachable by explicitly turning it on.
 */
export async function runShellCommand(options: RunOptions): Promise<CommandResult> {
  const { environmentId, command, namespace } = options;
  const settings = loadConfigState().settings;
  const mode = options.mode ?? settings.commandMode;
  const allowed =
    options.allowedBinaries ??
    (settings.commandAllowlist.length > 0 ? settings.commandAllowlist : DEFAULT_ALLOWED_BINARIES);
  const timeoutMs = Math.max(5, settings.commandTimeoutSeconds) * 1000;
  const trimmed = command.trim();

  const environment = requireEnvironment(environmentId);
  const kubeconfig = expandHome(environment.kubeconfig);
  let contextName: string | null = null;
  try {
    contextName = loadConnection(environment.kubeconfig, environment.context).contextName;
  } catch {
    // A kubeconfig we cannot parse may still be one kubectl understands.
  }

  const base: Omit<CommandResult, "exitCode" | "signal" | "stdout" | "stderr" | "truncated" | "refused"> = {
    display: trimmed,
    environmentId,
    kubeconfig,
    contextName,
    namespace,
    mode,
    durationMs: 0,
  };
  const refuse = (reason: string): CommandResult => ({
    ...base,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    refused: reason,
  });

  if (trimmed === "") return refuse("Type a command first.");

  let file: string;
  let argv: string[];

  if (mode === "bash") {
    const bash = resolveBinary("bash");
    if (!bash) return refuse("bash was not found on this machine.");
    file = bash;
    argv = ["-lc", trimmed];
  } else {
    const metacharacter = shellMetacharacter(trimmed);
    if (metacharacter) {
      return refuse(
        `"${metacharacter}" needs a shell. Switch the command bar to Full bash in Settings to use pipes, ` +
          "globs and redirects.",
      );
    }
    let tokens: string[];
    try {
      tokens = tokenize(trimmed);
    } catch (error) {
      return refuse((error as Error).message);
    }
    if (tokens.length === 0) return refuse("Type a command first.");

    const [name, ...rest] = tokens;
    if (!allowed.includes(name)) {
      return refuse(
        `"${name}" is not allowed. The command bar is in Allowlist mode, which permits: ${allowed.join(", ")}. ` +
          "Add it in Settings → Command bar, or switch to Full bash.",
      );
    }
    const binary = resolveBinary(name);
    if (!binary) return refuse(`${name} was not found in PATH, ~/.local/bin or ~/bin.`);
    file = binary;
    argv = rest;
  }

  const started = Date.now();
  return await new Promise<CommandResult>((resolve) => {
    execFile(
      file,
      argv,
      {
        cwd: os.homedir(),
        timeout: timeoutMs,
        maxBuffer: OUTPUT_LIMIT * 2,
        env: {
          ...process.env,
          KUBECONFIG: kubeconfig,
          // Keep kubectl's own output plain; the panel renders it as text.
          NO_COLOR: "1",
          TERM: "dumb",
          PATH: searchPath().join(path.delimiter),
          ...(namespace ? { KUBECTL_NAMESPACE: namespace } : {}),
        },
      },
      (error, stdout, stderr) => {
        const out = clamp(stdout ?? "");
        const err = clamp(stderr ?? "");
        const failure = error as (Error & { code?: number | string; signal?: string; killed?: boolean }) | null;
        const timedOut = failure?.killed === true && failure.signal === "SIGTERM";
        resolve({
          ...base,
          durationMs: Date.now() - started,
          exitCode: typeof failure?.code === "number" ? failure.code : failure ? null : 0,
          signal: failure?.signal ?? null,
          stdout: out.text,
          stderr: timedOut
            ? `${err.text}\nTimed out after ${timeoutMs / 1000}s.`.trim()
            : err.text || (failure && !failure.code ? failure.message : ""),
          truncated: out.truncated || err.truncated,
          refused: null,
        });
      },
    );
  });
}

export async function toolingStatus(allowedBinaries?: readonly string[]) {
  const configured = loadConfigState().settings.commandAllowlist;
  const list = allowedBinaries ?? (configured.length > 0 ? configured : DEFAULT_ALLOWED_BINARIES);
  const allowed = await Promise.all(
    list.map(async (name) => {
      const binaryPath = resolveBinary(name);
      if (!binaryPath) return { name, path: null, version: null };
      const version = await new Promise<string | null>((resolve) => {
        execFile(binaryPath, ["version", "--client"], { timeout: 5_000 }, (error, stdout) => {
          if (error && !stdout) {
            execFile(binaryPath, ["version"], { timeout: 5_000 }, (fallbackError, fallbackOut) => {
              resolve(fallbackError && !fallbackOut ? null : firstLine(fallbackOut));
            });
            return;
          }
          resolve(firstLine(stdout));
        });
      });
      return { name, path: binaryPath, version };
    }),
  );
  return { allowed, shellPath: resolveBinary("bash") };
}

function firstLine(text: string): string | null {
  const line = text.split("\n").find((entry) => entry.trim() !== "");
  return line ? line.trim().slice(0, 120) : null;
}
