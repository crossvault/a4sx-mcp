// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Seeding a saved session into the local Claude Code history without the a4sx CLI: a TypeScript port
// of the CLI's `a4sx launch --a4sx-session=NAME --seed-only` (cli/amdx.py: _launch_fetch_meta,
// _launch_seed, _claude_projects_dir), with the project-folder name taken from Claude Code itself.
// It runs where the extension runs (on the remote host in a remote window), so it writes that host's
// ~/.claude. Pure Node, no vscode import. Nothing here logs: neither the key nor transcript content.
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { promisify } from "util";

/** Claude Code 2.1.x's limit for a project-folder name before it truncates and hashes. */
export const PROJECT_DIR_MAX = 200;

/** Claude Code's 32-bit string hash for long project-folder names: h = h*31 + code unit, per UTF-16 unit. */
export function claudeStringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Claude Code's project-folder name for a working dir (2.1.x): every non-alphanumeric UTF-16 code unit
 * becomes "-" (so a character outside the BMP gives two); a name over 200 characters is cut to 200
 * and gets "-" plus the base-36 hash of the full path.
 */
export function projectDirName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= PROJECT_DIR_MAX) {
    return name;
  }
  return `${name.slice(0, PROJECT_DIR_MAX)}-${Math.abs(claudeStringHash(cwd)).toString(36)}`;
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

const realpathNative = promisify(fs.realpath.native);

/** The folder with symlinks resolved, like the process.cwd() Claude Code and the CLI see; as given if that fails. */
export async function resolvedCwd(cwd: string): Promise<string> {
  try {
    return await realpathNative(cwd);
  } catch {
    return cwd;
  }
}

/** The CLI's rule (0.10.77+) for a transcript's own sessionId. Here it is only replaced, never used as a file name. */
export const INTERNAL_SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export type SeedErrorCode = "no-session-id" | "bad-session-id" | "cancelled";

export class SeedError extends Error {
  constructor(public readonly code: SeedErrorCode) {
    super(code);
  }
}

/** Python's truthiness, as the CLI's `if internal:` sees a JSON value. */
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) {
    return v.length > 0;
  }
  if (v && typeof v === "object") {
    return Object.keys(v).length > 0;
  }
  return !!v;
}

/**
 * One transcript line as the CLI writes it back: undefined for a blank or unparsable line (dropped),
 * else the record as JSON with a top-level `sessionId` set to `newId`. `seen` gets the record's own
 * sessionId (the first truthy one names the transcript).
 */
export function rewriteLine(line: string, newId: string, seen?: (id: unknown) => void): string | undefined {
  const t = line.trim();
  if (!t) {
    return undefined;
  }
  let r: unknown;
  try {
    r = JSON.parse(t);
  } catch {
    return undefined;
  }
  if (r && typeof r === "object" && !Array.isArray(r) && Object.prototype.hasOwnProperty.call(r, "sessionId")) {
    seen?.((r as Record<string, unknown>).sessionId);
    (r as Record<string, unknown>).sessionId = newId;
  }
  return JSON.stringify(r);
}

export interface SeedOptions {
  /** Called with the share done (0..1). */
  progress?: (done: number) => void;
  signal?: AbortSignal;
  /** Base64 characters decoded per step (rounded down to a multiple of 4); each step yields to the event loop. */
  chunk?: number;
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

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

function writeChunk(out: fs.WriteStream, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    out.once("error", onError);
    const done = () => {
      out.off("error", onError);
      resolve();
    };
    if (out.write(data, "utf8")) {
      done();
    } else {
      out.once("drain", done);
    }
  });
}

function closeStream(out: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    out.once("error", reject);
    out.end(() => resolve());
  });
}

/**
 * Writes a file atomically: a temp file next to `dest` (mode 600 where the OS has modes), filled by
 * `fill` through a write stream, then renamed. On any failure the temp file is removed and `dest` is
 * untouched.
 */
export async function writeAtomic(dest: string, fill: string | ((write: (s: string) => Promise<void>) => Promise<void>)): Promise<void> {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${randomUUID()}.tmp`);
  const out = fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 });
  try {
    await new Promise<void>((resolve, reject) => {
      out.once("open", () => resolve());
      out.once("error", reject);
    });
    if (typeof fill === "string") {
      await writeChunk(out, fill);
    } else {
      await fill((s) => writeChunk(out, s));
    }
    await closeStream(out);
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    out.destroy();
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/**
 * Seeds a NEW local Claude Code session from a saved transcript (base64, as /library/fetch sends it):
 * a fresh UUID4 on every record's sessionId, written to
 * <projects>/<projectDirName(realpath(cwd))>/<uuid>.jsonl. The transcript is decoded, rewritten and
 * written a slice at a time, so it is never held decoded in memory. Returns the new id.
 */
export async function seedTranscript(b64: string, target: SeedTarget, info: SeedInfo, opts: SeedOptions = {}): Promise<string> {
  // Base64 from the server has no whitespace; anything else is cleaned once so the slices stay aligned.
  const clean = /[^A-Za-z0-9+/=]/.test(b64) ? b64.replace(/[^A-Za-z0-9+/=]/g, "") : b64;
  const want = opts.chunk ?? 1 << 20;
  const step = Math.max(4, want - (want % 4));
  const newId = randomUUID();
  const home = target.home ?? os.homedir();
  const cwd = await resolvedCwd(target.cwd);
  const dir = path.join(claudeProjectsDir(target.env ?? process.env, home), projectDirName(cwd));
  await fs.promises.mkdir(dir, { recursive: true });
  let internal: string | undefined;
  const seen = (id: unknown) => {
    if (internal !== undefined || !truthy(id)) {
      return;
    }
    if (typeof id !== "string" || !INTERNAL_SESSION_ID.test(id)) {
      throw new SeedError("bad-session-id");
    }
    internal = id;
  };
  await writeAtomic(path.join(dir, `${newId}.jsonl`), async (write) => {
    const decoder = new StringDecoder("utf8");
    let carry = "";
    const flush = async (text: string, last: boolean) => {
      const parts = (carry + text).split("\n");
      carry = last ? "" : parts.pop()!;
      let batch = "";
      for (const line of parts) {
        const rec = rewriteLine(line, newId, seen);
        if (rec !== undefined) {
          batch += `${rec}\n`;
        }
      }
      if (batch) {
        await write(batch);
      }
    };
    for (let off = 0; off < clean.length; off += step) {
      await flush(decoder.write(Buffer.from(clean.slice(off, off + step), "base64")), false);
      opts.progress?.(Math.min(1, (off + step) / clean.length));
      await yieldNow();
      if (opts.signal?.aborted) {
        throw new SeedError("cancelled");
      }
    }
    await flush(decoder.end(), true);
    if (internal === undefined) {
      throw new SeedError("no-session-id");
    }
  });
  opts.progress?.(1);
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
