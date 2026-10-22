// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// "Resume in Claude Code": `a4sx launch --a4sx-session=NAME --seed-only` copies the saved session into
// the local Claude Code history for a folder and prints its new session id; the Claude Code extension
// then opens that id from a URI. Pure Node (no vscode import) so it is unit-testable.
import * as childProcess from "child_process";

export const CLAUDE_EXTENSION_ID = "anthropic.claude-code";
/** How long `--seed-only` may take before it is stopped. */
export const SEED_TIMEOUT_MS = 120_000;
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
  return exitCode === 2 && stderr.includes("--seed-only");
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
  | { kind: "failed"; exitCode: number | null; detail: string };

export interface ExecOptions {
  cwd: string;
  timeout: number;
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
    const child = exec(cliPath, seedArgs(name), { cwd, timeout: SEED_TIMEOUT_MS, windowsHide: true, signal }, (error, stdout, stderr) => {
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
      const exitCode = typeof error.code === "number" ? error.code : null;
      if (isOldCli(exitCode, stderr)) {
        resolve({ kind: "old-cli" });
        return;
      }
      resolve({ kind: "failed", exitCode, detail: lastLine(stderr) });
    });
    // Nothing is typed in: a question from the CLI gets end-of-input instead of waiting for the timeout.
    child?.stdin?.end();
  });
}
