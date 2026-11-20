// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.9.2: where a stored cell's last conversation is, so Start in terminal continues it in its own folder.
// The a4sx CLI (0.31.10+) keeps each cell's last Claude Code session per agent name in
// `<state home>/a4sx/agents/<name>/state/cell-last-session.json`: {"v": 1, "cells": {<instance id>: {"sid", "cwd",
// "at"}}}. `mesh cells --json` doesn't say it, so it is read here. That file holds a session id and a folder, no
// key; only those two values are used, after the CLI's own checks. The transcript is then looked for where the
// cell's Claude Code keeps it: the cell's overlay (`<state home>/a4sx/harness/<name>/claude/projects`, which
// links to your own `.claude/projects`), else your own Claude Code folder. Pure Node, no vscode import.
import * as fs from "fs";
import * as path from "path";
import { CELL_NAME, INSTANCE_ID } from "./cells";
import { projectDirName } from "./nativeSeed";

export const CELL_LAST_SESSION_FILE = "cell-last-session.json";
/** The CLI's _CELL_SID_RE: the shape of an id it records. */
const CLI_SID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** A Claude Code session id as it goes into `-- --resume <id>` (resume.UUID). */
export const RESUME_SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The record is a few hundred bytes; anything larger isn't the CLI's. */
const MAX_RECORD_BYTES = 1 << 20;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

export interface CellLastSession {
  sessionId: string;
  /** The folder the conversation ran in (the CLI's realpath of it). */
  cwd: string;
}

/** What Start in terminal does with a stored cell (cellStartPlan). */
export type CellStartPlan =
  /** Continue the last conversation: `-- --resume <sessionId>` (when it is a UUID) in `cwd`, the folder it ran in. */
  | { kind: "resume"; cwd: string; sessionId: string; transcript: string }
  /** The record names a conversation whose transcript is gone: a new one, in the folder it ran in. */
  | { kind: "gone"; cwd: string; sessionId: string }
  /** The folder the last conversation ran in isn't there any more: the user picks one; a new conversation. */
  | { kind: "moved"; lastCwd: string; sessionId: string }
  /** No conversation recorded for this cell (a new cell, or only run under a CLI before 0.31.10). */
  | { kind: "none" };

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** `<state dir>/agents/<name>/state/cell-last-session.json`, or undefined for a name the CLI doesn't take. */
export function cellLastSessionFile(stateDir: string, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  return CELL_NAME.test(name) ? pathFor(platform).join(stateDir, "agents", name, "state", CELL_LAST_SESSION_FILE) : undefined;
}

function readRegular(file: string): string | undefined {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_RECORD_BYTES) {
      return undefined;
    }
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The record's entry for this cell (`instance id`), checked as the CLI checks it (_cell_last_get), or undefined. */
export function parseCellLastSession(text: string | undefined, instanceId: string, platform: NodeJS.Platform = process.platform): CellLastSession | undefined {
  if (text === undefined || !INSTANCE_ID.test(instanceId)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const cells = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).cells : undefined;
  if (!cells || typeof cells !== "object" || Array.isArray(cells) || !Object.prototype.hasOwnProperty.call(cells, instanceId)) {
    return undefined;
  }
  const e = (cells as Record<string, unknown>)[instanceId];
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    return undefined;
  }
  const { sid, cwd } = e as Record<string, unknown>;
  if (typeof sid !== "string" || !CLI_SID.test(sid) || typeof cwd !== "string" || cwd.length > 4096 || CONTROL.test(cwd) || !pathFor(platform).isAbsolute(cwd)) {
    return undefined;
  }
  return { sessionId: sid, cwd };
}

/** The cell's last conversation as the CLI recorded it on this computer, or undefined. */
export function readCellLastSession(stateDir: string, cell: { name: string; instanceId: string }, platform: NodeJS.Platform = process.platform): CellLastSession | undefined {
  const file = cellLastSessionFile(stateDir, cell.name, platform);
  return file ? parseCellLastSession(readRegular(file), cell.instanceId, platform) : undefined;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `<sid>.jsonl` in a projects folder: under the folder for `cwd`, else under any project folder (Claude Code
 * shortens very long folder names; a session id is unique), as the CLI's _cell_transcript looks for it.
 */
export function findTranscript(projectsDirs: readonly string[], sessionId: string, cwd: string): string | undefined {
  if (!CLI_SID.test(sessionId)) {
    return undefined;
  }
  for (const root of projectsDirs) {
    const direct = path.join(root, projectDirName(cwd), `${sessionId}.jsonl`);
    if (isFile(direct)) {
      return direct;
    }
  }
  for (const root of projectsDirs) {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = path.join(root, n, `${sessionId}.jsonl`);
      if (isFile(p)) {
        return p;
      }
    }
  }
  return undefined;
}

/** The projects folders a cell's transcript can be in: its overlay's (linked to yours), then your own. */
export function cellProjectsDirs(stateDir: string, name: string, ownProjects: string, platform: NodeJS.Platform = process.platform): string[] {
  const p = pathFor(platform);
  return CELL_NAME.test(name) ? [p.join(stateDir, "harness", name, "claude", "projects"), ownProjects] : [ownProjects];
}

/**
 * How Start in terminal starts a stored cell: in the folder its last conversation ran in, continuing it while its
 * transcript is there. `stateDir` is `<state home>/a4sx` (cells.cellsListDir), `ownProjects` your Claude Code projects
 * folder (nativeSeed.claudeProjectsDir).
 */
export function cellStartPlan(
  stateDir: string | undefined, ownProjects: string, cell: { name: string; instanceId: string }, platform: NodeJS.Platform = process.platform,
  dirExists: (p: string) => boolean = isDirectory,
): CellStartPlan {
  const last = stateDir ? readCellLastSession(stateDir, cell, platform) : undefined;
  if (!last) {
    return { kind: "none" };
  }
  if (!dirExists(last.cwd)) {
    return { kind: "moved", lastCwd: last.cwd, sessionId: last.sessionId };
  }
  const transcript = findTranscript(cellProjectsDirs(stateDir!, cell.name, ownProjects, platform), last.sessionId, last.cwd);
  return transcript ? { kind: "resume", cwd: last.cwd, sessionId: last.sessionId, transcript } : { kind: "gone", cwd: last.cwd, sessionId: last.sessionId };
}

/** How much of the end of the cell's history.jsonl lastPromptFolder reads. */
const HISTORY_TAIL_BYTES = 1 << 20;

/**
 * The folder of the last prompt typed in a cell of this name (its overlay's own `history.jsonl`, `project` of its
 * newest row), when that folder is still there: only the folder picker's default when the CLI recorded no
 * conversation (a cell that ran only under a CLI before 0.31.10). Only `project` is read from a row.
 */
export function lastPromptFolder(stateDir: string | undefined, name: string, platform: NodeJS.Platform = process.platform, dirExists: (p: string) => boolean = isDirectory): string | undefined {
  if (!stateDir || !CELL_NAME.test(name)) {
    return undefined;
  }
  const file = pathFor(platform).join(stateDir, "harness", name, "claude", "history.jsonl");
  let text: string;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) {
      return undefined;
    }
    const fd = fs.openSync(file, "r");
    try {
      const length = Math.min(st.size, HISTORY_TAIL_BYTES);
      const buf = Buffer.alloc(length);
      const n = fs.readSync(fd, buf, 0, length, st.size - length);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("\"project\"")) {
      continue;
    }
    try {
      const r = JSON.parse(lines[i]);
      const p = r && typeof r === "object" ? (r as Record<string, unknown>).project : undefined;
      if (typeof p === "string" && p.length <= 4096 && !CONTROL.test(p) && pathFor(platform).isAbsolute(p)) {
        return dirExists(p) ? p : undefined;
      }
    } catch {
      // a line cut at the start of the tail, or not JSON: the one before
    }
  }
  return undefined;
}
