// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.5.0: is a saved session also on this computer? The server names a pushed session's entry after the
// transcript's own sessionId ("col-lib-" + its first 12 letters and digits), so the Claude Code transcript
// <projects>/<folder>/<uuid>.jsonl whose id starts the same is that session, and its `cwd` is the folder to
// resume it in. Only the file names and the first lines' `cwd` are read; no transcript content is kept or
// logged. Pure Node, no vscode import.
import * as fs from "fs";
import * as path from "path";
import { claudeProjectsDir, projectDirName } from "./nativeSeed";

const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** How much of a transcript is read to find its `cwd`. */
export const HEAD_BYTES = 256 * 1024;

/** The slug the server derived from the transcript's sessionId: from `sessions[0]` (lib-…) or the id (col-lib-…). */
export function librarySlug(row: { id: string; sessions?: unknown }): string | undefined {
  const first = Array.isArray(row.sessions) ? row.sessions[0] : undefined;
  const m = (typeof first === "string" ? /^lib-([A-Za-z0-9]{12})$/.exec(first) : null) ?? /^col-lib-([A-Za-z0-9]{12})$/.exec(row.id);
  return m ? m[1] : undefined;
}

/** True when a Claude Code session id gives this slug (its first 12 letters and digits). */
export function slugMatches(sessionId: string, slug: string): boolean {
  return sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) === slug;
}

export interface LocalSession {
  sessionId: string;
  /** The folder the session ran in (an existing directory), where `claude --resume` finds it. */
  cwd: string;
}

/** The first absolute `cwd` in a transcript's head, or undefined. */
export function transcriptCwd(head: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const p = platform === "win32" ? path.win32 : path.posix;
  for (const line of head.split(/\r?\n/).slice(0, 200)) {
    if (!line.includes("\"cwd\"")) {
      continue;
    }
    try {
      const r = JSON.parse(line);
      // eslint-disable-next-line no-control-regex
      if (r && typeof r.cwd === "string" && r.cwd.length <= 4096 && p.isAbsolute(r.cwd) && !/[\x00-\x1f\x7f]/.test(r.cwd)) {
        return r.cwd;
      }
    } catch {
      // a line cut at HEAD_BYTES, or not JSON: the next one
    }
  }
  return undefined;
}

async function readHead(file: string): Promise<string> {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The newest local transcript of the saved session, when its folder still exists and is the one Claude
 * Code files it under (else `--resume` there wouldn't find it). undefined: the session isn't on this
 * computer, so the cell fetches it with --a4sx-session.
 */
export async function findLocalSession(slug: string, projectsDir: string = claudeProjectsDir()): Promise<LocalSession | undefined> {
  let folders: fs.Dirent[];
  try {
    folders = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const hits: { file: string; folder: string; sessionId: string; mtime: number }[] = [];
  for (const d of folders) {
    if (!d.isDirectory()) {
      continue;
    }
    let files: string[];
    try {
      files = await fs.promises.readdir(path.join(projectsDir, d.name));
    } catch {
      continue;
    }
    for (const f of files) {
      const m = UUID_FILE.exec(f);
      if (m && slugMatches(m[1], slug)) {
        const file = path.join(projectsDir, d.name, f);
        try {
          hits.push({ file, folder: d.name, sessionId: m[1].toLowerCase(), mtime: (await fs.promises.stat(file)).mtimeMs });
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  for (const h of hits) {
    let cwd: string | undefined;
    try {
      cwd = transcriptCwd(await readHead(h.file));
    } catch {
      continue;
    }
    if (!cwd || !(await isDir(cwd))) {
      continue;
    }
    let real = cwd;
    try {
      real = await fs.promises.realpath(cwd);
    } catch {
      // as given
    }
    if (projectDirName(cwd) === h.folder || projectDirName(real) === h.folder) {
      return { sessionId: h.sessionId, cwd };
    }
  }
  return undefined;
}
