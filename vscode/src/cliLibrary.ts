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
import type { CliOutput } from "./cellsView";

export const WHOAMI_ARGS = ["whoami", "--json"] as const;
export const LIST_ARGS = ["list", "--json"] as const;

export const CLI_LIBRARY_TEXTS = {
  via: "Listed with the a4sx CLI's sign-in on this computer. Sign in here too to save, publish or open a session in Claude Code from VS Code.",
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

/** The host of a server URL or bare host ("https://x.example/" and "x.example" are the same server). */
export function serverHost(v: string): string {
  return v.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * `whoami --json` says the CLI is signed in, the server didn't refuse that sign-in and (review) it is the server this
 * extension uses: another server's library is never listed as this one's.
 */
export function cliSignedIn(out: CliOutput, server?: string): boolean {
  const d = out.code === 0 ? parse(out.stdout) : undefined;
  return isObject(d) && d.v === 1 && d.signed_in === true && d.valid !== false
    && (server === undefined || (typeof d.server === "string" && serverHost(d.server) === serverHost(server)));
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
    const ts = (v: unknown) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT[0-9:.]{5,15}(Z|[+-]\d\d:\d\d)?$/.test(v) ? v : undefined);
    if (ts(r.created_at)) { row.created_at = ts(r.created_at); }
    if (ts(r.updated_at)) { row.updated_at = ts(r.updated_at); }
    if (num(tok.current) !== undefined || num(tok.peak) !== undefined) { row.tokens = { current: num(tok.current), peak: num(tok.peak) }; }
    // review: anything but a plain id is "other", which the extension refuses to seed (fails closed)
    if (r.harness !== undefined && r.harness !== null) {
      row.harness = typeof r.harness === "string" && /^[a-z][a-z0-9._-]{0,47}$/.test(r.harness) ? r.harness : "other";
    }
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
export async function cliLibrary(cli: string | undefined, run: (cli: string, args: readonly string[], timeoutMs?: number) => Promise<CliOutput>,
  server?: string): Promise<SessionRow[] | undefined> {
  if (!cli) {
    return undefined;
  }
  try {
    if (!cliSignedIn(await run(cli, WHOAMI_ARGS, 20_000), server)) {
      return undefined;
    }
    return parseCliLibrary(await run(cli, LIST_ARGS, 30_000));
  } catch {
    return undefined;
  }
}
