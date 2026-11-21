// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
/**
 * a4sx #2301 E4: one sign-in. When the extension has no sign-in of its own and the a4sx CLI on this computer is
 * signed in, My sessions lists the library through the CLI (`a4sx whoami --json`, then `a4sx list --json`, CLI
 * 0.59.12+) and says so. Actions that need the extension's own sign-in (save, resume, publish) still ask for it.
 * Every CLI call is an argv array; only checked values are kept.
 */
import { SessionRow } from "./api";
import { showText } from "./cells";
import { CliOutput } from "./cellsView";

export const WHOAMI_ARGS = ["whoami", "--json"] as const;
export const LIST_ARGS = ["list", "--json"] as const;

export const CLI_LIBRARY_TEXTS = {
  via: "Listed with the a4sx CLI's sign-in on this computer. Sign in here too to save, resume or publish from VS Code.",
  empty: "Your library has no sessions yet (listed with the a4sx CLI's sign-in on this computer).",
};

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parse(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** `whoami --json` says the CLI is signed in and the server didn't refuse that sign-in. */
export function cliSignedIn(out: CliOutput): boolean {
  const d = out.code === 0 ? parse(out.stdout) : undefined;
  return isObject(d) && d.v === 1 && d.signed_in === true && d.valid !== false;
}

/** `list --json`'s sessions as the extension's rows, or undefined when it isn't that answer. */
export function parseCliLibrary(out: CliOutput): SessionRow[] | undefined {
  const d = out.code === 0 ? parse(out.stdout) : undefined;
  if (!isObject(d) || d.v !== 1 || d.signed_in !== true || !Array.isArray(d.sessions)) {
    return undefined;
  }
  const rows: SessionRow[] = [];
  for (const r of d.sessions) {
    if (!isObject(r) || typeof r.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.id)) {
      continue;
    }
    const tok = isObject(r.tokens) ? r.tokens : {};
    const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
    const row: SessionRow = { id: r.id };
    const label = showText(r.label, 120);
    const title = showText(r.title, 200);
    if (label) { row.label = label; }
    if (title) { row.title = title; }
    if (Array.isArray(r.tags)) { row.tags = r.tags.map((t) => showText(t, 80)).filter((t): t is string => !!t).slice(0, 32); }
    if ("folder" in r) { row.folder = typeof r.folder === "string" ? showText(r.folder, 200) ?? null : null; }
    if (typeof r.created_at === "string") { row.created_at = r.created_at; }
    if (typeof r.updated_at === "string") { row.updated_at = r.updated_at; }
    if (num(tok.current) !== undefined || num(tok.peak) !== undefined) { row.tokens = { current: num(tok.current), peak: num(tok.peak) }; }
    if (typeof r.harness === "string") { row.harness = showText(r.harness, 48); }
    if (num(r.versions) !== undefined) { row.versions = num(r.versions); }
    if (typeof r.version === "string") { row.version = showText(r.version, 64); }
    if (Array.isArray(r.sessions)) { row.sessions = r.sessions.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(x)); }
    rows.push(row);
  }
  return rows;
}

/**
 * The library through the CLI's sign-in, or undefined (no CLI, not signed in, an older CLI without these commands,
 * any failure): then My sessions asks to sign in, as before.
 */
export async function cliLibrary(cli: string | undefined, run: (cli: string, args: readonly string[], timeoutMs?: number) => Promise<CliOutput>): Promise<SessionRow[] | undefined> {
  if (!cli) {
    return undefined;
  }
  try {
    if (!cliSignedIn(await run(cli, WHOAMI_ARGS, 20_000))) {
      return undefined;
    }
    return parseCliLibrary(await run(cli, LIST_ARGS, 30_000));
  } catch {
    return undefined;
  }
}
