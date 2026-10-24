// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Seeding a saved session into the local Claude Code history without the a4sx CLI: a TypeScript port
// of the CLI's `a4sx launch --a4sx-session=NAME --seed-only` (cli/amdx.py: _launch_fetch_meta,
// _launch_seed, _claude_projects_dir, _project_dir_name). It runs where the extension runs (on the
// remote host in a remote window), so it writes that host's ~/.claude. Pure Node, no vscode import.
// Nothing here logs: neither the key nor any transcript content.
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Claude Code's project-folder name for a working dir: EVERY non-alphanumeric character becomes "-". */
export function projectDirName(cwd: string): string {
  // Per code point (the "u" flag), like Python's re.sub on a str.
  return cwd.replace(/[^A-Za-z0-9]/gu, "-");
}

/** Where Claude Code keeps transcripts: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects");
}

/** The CLI's config dir (~/.config/a4sx, or the older ~/.config/agent-mdx when only that one exists). */
export function cliConfigDir(home: string = os.homedir()): string {
  const fresh = path.join(home, ".config", "a4sx");
  const old = path.join(home, ".config", "agent-mdx");
  const isDir = (p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  return isDir(fresh) || !isDir(old) ? fresh : old;
}

/** The CLI's rule (0.10.77+) for a transcript's own sessionId. Here it is only replaced, never used as a file name. */
export const INTERNAL_SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export type SeedErrorCode = "no-session-id" | "bad-session-id" | "cancelled";

export class SeedError extends Error {
  constructor(public readonly code: SeedErrorCode) {
    super(code);
  }
}

/** The transcript's own sessionId: the first record that names one. Throws when it is missing or invalid. */
export function internalSessionId(text: string): string {
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let id: unknown;
    try {
      const r = JSON.parse(line);
      id = r && typeof r === "object" && !Array.isArray(r) ? r.sessionId : undefined;
    } catch {
      id = undefined;
    }
    if (id) {
      if (typeof id !== "string" || !INTERNAL_SESSION_ID.test(id)) {
        throw new SeedError("bad-session-id");
      }
      return id;
    }
  }
  throw new SeedError("no-session-id");
}

export interface RewriteOptions {
  /** Called with the share of lines done (0..1). */
  progress?: (done: number) => void;
  signal?: AbortSignal;
  /** Lines between yields to the event loop, so a large transcript never blocks the extension host. */
  chunk?: number;
}

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The transcript with every record's `sessionId` set to `newId`, one JSON record per line, exactly like
 * the CLI: blank and unparsable lines are dropped, every other record is written back as JSON.
 */
export async function rewriteTranscript(text: string, newId: string, opts: RewriteOptions = {}): Promise<string> {
  const lines = text.split("\n");
  const chunk = opts.chunk ?? 2000;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i % chunk === 0 && i > 0) {
      opts.progress?.(i / lines.length);
      await yieldNow();
      if (opts.signal?.aborted) {
        throw new SeedError("cancelled");
      }
    }
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r && typeof r === "object" && !Array.isArray(r) && Object.prototype.hasOwnProperty.call(r, "sessionId")) {
      (r as Record<string, unknown>).sessionId = newId;
    }
    out.push(JSON.stringify(r));
  }
  opts.progress?.(1);
  return out.length ? `${out.join("\n")}\n` : "";
}

/**
 * Writes `data` to `dest` atomically: a temp file next to it (mode 600 where the OS has modes), then a
 * rename. On failure the temp file is removed and `dest` is untouched.
 */
export async function writeAtomic(dest: string, data: string): Promise<void> {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(tmp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

export interface SeedTarget {
  /** The folder Claude Code resumes in (the working dir of the session). */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface SeedInfo {
  /** The saved session's collection id and version, for the CLI's lineage sidecar. */
  cid: string;
  version?: string;
}

/**
 * Seeds a NEW local Claude Code session from a fetched transcript: a fresh UUID4, every record's
 * sessionId rewritten, written to <projects>/<projectDirName(cwd)>/<uuid>.jsonl. Returns the new id.
 */
export async function seedTranscript(text: string, target: SeedTarget, info: SeedInfo, opts: RewriteOptions = {}): Promise<string> {
  const internal = internalSessionId(text);
  const newId = randomUUID();
  const data = await rewriteTranscript(text, newId, opts);
  if (opts.signal?.aborted) {
    throw new SeedError("cancelled");
  }
  const home = target.home ?? os.homedir();
  const dir = path.join(claudeProjectsDir(target.env ?? process.env, home), projectDirName(target.cwd));
  await fs.promises.mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, `${newId}.jsonl`), data);
  // The CLI's lineage sidecar, so a later `a4sx push` of this session records its parent. Best-effort.
  try {
    const lineage = path.join(cliConfigDir(home), "lineage");
    await fs.promises.mkdir(lineage, { recursive: true });
    await writeAtomic(path.join(lineage, `${newId}.json`),
      JSON.stringify({ parent_cid: info.cid, parent_version: info.version ?? "", base_internal: internal }));
  } catch {
    // never block a resume on the sidecar
  }
  return newId;
}
