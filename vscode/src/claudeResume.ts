// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// "Resume in Claude Code": `a4sx launch --a4sx-session=NAME --seed-only` copies the saved session into
// the local Claude Code history for a folder and prints its new session id; the Claude Code extension
// then opens that id from a URI. Pure Node (no vscode import) so it is unit-testable.
import * as childProcess from "child_process";

export const CLAUDE_EXTENSION_ID = "anthropic.claude-code";
/** How long `--seed-only` may take before it is stopped. */
export const SEED_TIMEOUT_MS = 120_000;
/** stdout is one line and stderr a few notes; more than this stops the CLI and counts as a failure. */
export const SEED_MAX_BUFFER = 64 * 1024;
const MAX_DETAIL = 200;

/** The canonical 8-4-4-4-12 hex form, nothing before or after it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function seedArgs(name: string): string[] {
  return ["launch", `--a4sx-session=${name}`, "--seed-only"];
}

/** The session id from `--seed-only`'s stdout: exactly one UUID line, or undefined. */
export function parseSessionId(stdout: string): string | undefined {
  const s = stdout.trim();
  return UUID.test(s) ? s : undefined;
}

/** `<scheme>://anthropic.claude-code/open?session=<id>`: the Claude Code extension's resume link. */
export function claudeResumeUri(uriScheme: string, sessionId: string): string {
  return `${uriScheme}://${CLAUDE_EXTENSION_ID}/open?session=${encodeURIComponent(sessionId)}`;
}

/** A CLI from before `--seed-only`: argparse exits 2 with "unrecognized arguments: --seed-only". */
export function isOldCli(exitCode: number | null, stderr: string): boolean {
  return exitCode === 2 && stderr.includes("unrecognized arguments") && stderr.includes("--seed-only");
}

/**
 * The CLI's "a4sx: seeding from a saved session needs a sign-in — run `a4sx login` first" (exit 1):
 * the user has to run `a4sx login`. The legacy CLI name `amdx` is matched too.
 */
export function isNotSignedIn(exitCode: number | null, stderr: string): boolean {
  return exitCode !== null && exitCode !== 0 && /needs a sign-in\b.*\b(?:a4sx|amdx) login\b/.test(stderr);
}

/** The last non-empty stderr line, without terminal escapes or control characters, at most 200 chars. */
export function lastLine(stderr: string): string {
  const lines = stderr
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n|\r/)
    // eslint-disable-next-line no-control-regex
    .map((l) => l.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return last.length > MAX_DETAIL ? `${last.slice(0, MAX_DETAIL - 1)}…` : last;
}

export type SeedResult =
  | { kind: "ok"; sessionId: string }
  | { kind: "old-cli" }
  | { kind: "bad-output" }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "not-signed-in" }
  | { kind: "failed"; exitCode: number | null; detail: string };

export interface ExecOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
  signal?: AbortSignal;
}

/** The part of child_process.execFile this uses (swappable in tests). Never runs a shell. */
export type ExecFileLike = (
  file: string,
  args: string[],
  options: ExecOptions,
  callback: (error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: string, stderr: string) => void,
) => { stdin?: { end(): void } | null } | void;

export const defaultExecFile: ExecFileLike = (file, args, options, callback) =>
  childProcess.execFile(file, args, { ...options, encoding: "utf8", shell: false }, (error, stdout, stderr) =>
    callback(error, String(stdout), String(stderr)));

/** Runs `a4sx launch --a4sx-session=NAME --seed-only` in `cwd` and classifies the outcome. */
export function seedSession(cliPath: string, name: string, cwd: string, exec: ExecFileLike = defaultExecFile, signal?: AbortSignal): Promise<SeedResult> {
  return new Promise((resolve) => {
    const options: ExecOptions = { cwd, timeout: SEED_TIMEOUT_MS, maxBuffer: SEED_MAX_BUFFER, windowsHide: true, signal };
    const done = (error: Parameters<Parameters<ExecFileLike>[3]>[0], stdout: string, stderr: string) => {
      if (!error) {
        const sessionId = parseSessionId(stdout);
        resolve(sessionId ? { kind: "ok", sessionId } : { kind: "bad-output" });
        return;
      }
      if (error.name === "AbortError" || signal?.aborted) {
        resolve({ kind: "cancelled" });
        return;
      }
      if (error.killed) {
        resolve({ kind: "timeout" });
        return;
      }
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        resolve({ kind: "failed", exitCode: null, detail: "" });
        return;
      }
      const exitCode = typeof error.code === "number" ? error.code : null;
      if (isOldCli(exitCode, stderr)) {
        resolve({ kind: "old-cli" });
        return;
      }
      if (isNotSignedIn(exitCode, stderr)) {
        resolve({ kind: "not-signed-in" });
        return;
      }
      resolve({ kind: "failed", exitCode, detail: lastLine(stderr) });
    };
    let child: ReturnType<ExecFileLike>;
    try {
      child = exec(cliPath, seedArgs(name), options, done);
    } catch {
      // execFile throws before starting anything, e.g. for a NUL byte in an argument, or a
      // Windows .cmd file (which needs a shell). Same path as any other failure.
      resolve({ kind: "failed", exitCode: null, detail: "" });
      return;
    }
    // Nothing is typed in: a question from the CLI gets end-of-input instead of waiting for the timeout.
    child?.stdin?.end();
  });
}
