// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The cells stored by the a4sx CLI on this machine (`a4sx mesh cells --json`), and the argv arrays of
// the CLI commands the "Cells" view runs on them. Pure Node, no vscode import, so it is unit-testable.
// Every value from the CLI's answer is checked here before it can reach a command line or the UI: a
// name or id that doesn't match the CLI's own rule drops the row. The answer never holds a key.
import * as os from "os";
import * as path from "path";
import type { CellPath, LocalState, MeshPolicy, RegistryState } from "./cliJson";

/** The CLI's MESH_CELL_NAME_RE. */
export const CELL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/** The CLI's MESH_ID_RE (looser than the server's msh_ + 32 hex). */
export const CLI_MESH_ID = /^msh_[A-Za-z0-9]{1,64}$/;
/** The CLI's MESH_INS_ID_RE. */
export const INSTANCE_ID = /^ins_[A-Za-z0-9]{1,64}$/;
/** A launch profile id (api.ts PROFILE_ID). */
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A server as the CLI stores it: a bare host[:port], or an https origin. */
const SERVER = /^(?:https:\/\/)?([a-z0-9.-]{1,253}(?::[0-9]{1,5})?)\/?$/;
/** `--mesh standalone`: the CLI's word for a cell in no mesh. */
export const STANDALONE = "standalone";

export interface LocalCell {
  name: string;
  instanceId: string;
  /** undefined: a standalone cell (in no mesh yet). */
  meshId?: string;
  meshName?: string;
  isDefault: boolean;
  needsApproval: boolean;
  /** Another key file on this machine names the same cell (the CLI starts neither as the default). */
  duplicate: boolean;
  created?: string;
  /** The server's https origin, when the CLI says which (newer CLIs only). */
  server?: string;
  /** The cell's launch profile id, when the CLI says which (newer CLIs only). */
  launchProfile?: string;
  /** CLI 0.25.0+: whether it runs on this computer now, and its pid then. */
  localState?: LocalState;
  pid?: number;
  /** CLI 0.25.0+: the mesh registry's state of the cell. */
  registryState?: RegistryState;
  /** CLI 0.25.0+: how this computer reaches the cell's mesh peers. */
  path?: CellPath;
  /** CLI 0.25.0+: the mesh's join policy (null: the CLI doesn't know it). */
  meshPolicy?: MeshPolicy | null;
  /** CLI 0.25.0+: the cell's tags (not shown yet). */
  tags?: string[];
}

// eslint-disable-next-line no-control-regex
const HIDDEN = /[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]/g;

/** User-chosen text (a mesh name) as it may be shown: one line, no hidden characters, at most `max` chars. */
export function showText(v: unknown, max = 64): string | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  const s = v.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  if (!s) {
    return undefined;
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The https origin of a server value from the CLI, or undefined when it isn't a plain host. */
export function serverOrigin(v: unknown): string | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  const m = SERVER.exec(v.trim().toLowerCase());
  return m ? `https://${m[1]}` : undefined;
}

/** One row of `mesh cells --json`, or undefined when anything that could reach a command is off. */
export function parseLocalCell(raw: unknown): LocalCell | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !CELL_NAME.test(r.name) || typeof r.instance_id !== "string" || !INSTANCE_ID.test(r.instance_id)) {
    return undefined;
  }
  let meshId: string | undefined;
  if (r.mesh_id !== null && r.mesh_id !== undefined) {
    if (typeof r.mesh_id !== "string" || !CLI_MESH_ID.test(r.mesh_id)) {
      return undefined;
    }
    meshId = r.mesh_id;
  }
  const profile = typeof r.launch_profile === "string" ? r.launch_profile : typeof r.launch_profile_id === "string" ? r.launch_profile_id : undefined;
  const cell: LocalCell = {
    name: r.name,
    instanceId: r.instance_id,
    isDefault: r.default === true,
    needsApproval: r.needs_approval === true,
    duplicate: r.duplicate === true,
  };
  if (meshId) {
    cell.meshId = meshId;
    const mn = showText(r.mesh_name);
    if (mn) {
      cell.meshName = mn;
    }
  }
  const created = typeof r.created === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.created) ? r.created.slice(0, 10) : undefined;
  if (created) {
    cell.created = created;
  }
  // `server` in this answer is --refresh's status word; the cell's server comes as `base`.
  const server = serverOrigin(r.base);
  if (server) {
    cell.server = server;
  }
  if (profile && PROFILE.test(profile)) {
    cell.launchProfile = profile;
  }
  return cell;
}

/** `a4sx mesh cells --json`'s stdout as cells, or undefined when it isn't that answer at all. */
export function parseCellsJson(stdout: string): LocalCell[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw.map(parseLocalCell).filter((c): c is LocalCell => c !== undefined);
}

export const CELLS_LIST_ARGS: readonly string[] = ["mesh", "cells", "--json"];
export const REDUCED_FLAG = "--mesh-reduced-isolation";
export const NEW_CELL_ARGS: readonly string[] = ["launch", "--new-cell", REDUCED_FLAG];

/** True when another stored cell has this name, so the commands need `--mesh` to pick it. */
function nameShared(cell: LocalCell, all: readonly LocalCell[]): boolean {
  return all.some((c) => c !== cell && c.name === cell.name);
}

function valid(cell: LocalCell): boolean {
  return CELL_NAME.test(cell.name) && (cell.meshId === undefined || CLI_MESH_ID.test(cell.meshId));
}

/** A standalone cell can't be started: it must be added to a mesh first (the CLI says so too). */
export function startableCell(cell: LocalCell): boolean {
  return cell.meshId !== undefined;
}

/** `launch --cell NAME [--mesh ID] --mesh-reduced-isolation`; undefined for a standalone or bad cell. */
export function cellLaunchArgs(cell: LocalCell, all: readonly LocalCell[]): string[] | undefined {
  if (!valid(cell) || !startableCell(cell)) {
    return undefined;
  }
  return ["launch", "--cell", cell.name, ...(nameShared(cell, all) ? ["--mesh", cell.meshId!] : []), REDUCED_FLAG];
}

function pickArgs(cell: LocalCell, all: readonly LocalCell[]): string[] | undefined {
  if (!valid(cell)) {
    return undefined;
  }
  return [cell.name, ...(nameShared(cell, all) ? ["--mesh", cell.meshId ?? STANDALONE] : [])];
}

/** `mesh cell default NAME [--mesh ID|standalone]`. */
export function cellDefaultArgs(cell: LocalCell, all: readonly LocalCell[]): string[] | undefined {
  const p = pickArgs(cell, all);
  return p && ["mesh", "cell", "default", ...p];
}

/** `mesh cell forget NAME [--mesh ID|standalone]`. */
export function cellForgetArgs(cell: LocalCell, all: readonly LocalCell[]): string[] | undefined {
  const p = pickArgs(cell, all);
  return p && ["mesh", "cell", "forget", ...p];
}

export const AUTO_ALLOW_FLAG = "--auto-allow-ipc-messages";
/** A saved session's id as `--a4sx-session=` takes it (terminalCommand.SESSION_ID). */
const LIBRARY_SESSION = /^[A-Za-z0-9._:-]{1,128}$/;
/** A Claude Code session id (resume.UUID). */
const CLAUDE_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The two toggles of "Run as cell in terminal". */
export interface LaunchOptions {
  /** "Keep my sign-in (reduced isolation)": --mesh-reduced-isolation. */
  reduced: boolean;
  /** "Deliver messages from mesh peers without asking": --auto-allow-ipc-messages. */
  autoAllow: boolean;
}

/** What the cell resumes: a session on this computer (`-- --resume ID`), or a saved one (`--a4sx-session=ID`). */
export type ResumeTarget = { kind: "local"; sessionId: string } | { kind: "library"; id: string };

export function launchFlags(o: LaunchOptions): string[] {
  return [...(o.reduced ? [REDUCED_FLAG] : []), ...(o.autoAllow ? [AUTO_ALLOW_FLAG] : [])];
}

/** The end of the launch command for a session; [] for none; undefined when its id isn't valid. */
export function resumeTail(t: ResumeTarget | undefined): string[] | undefined {
  if (!t) {
    return [];
  }
  if (t.kind === "local") {
    return CLAUDE_SESSION.test(t.sessionId) ? ["--", "--resume", t.sessionId] : undefined;
  }
  return LIBRARY_SESSION.test(t.id) ? [`--a4sx-session=${t.id}`] : undefined;
}

/** `launch --cell NAME [--mesh ID] [flags] [--a4sx-session=ID | -- --resume ID]`; undefined for a standalone or bad cell. */
export function runAsCellArgs(cell: LocalCell, all: readonly LocalCell[], o: LaunchOptions, target?: ResumeTarget): string[] | undefined {
  const tail = resumeTail(target);
  if (!valid(cell) || !startableCell(cell) || !tail) {
    return undefined;
  }
  return ["launch", "--cell", cell.name, ...(nameShared(cell, all) ? ["--mesh", cell.meshId!] : []), ...launchFlags(o), ...tail];
}

/** `launch --new-cell [flags] [--a4sx-session=ID | -- --resume ID]`: the browser approval picks the mesh and profile. */
export function newCellRunArgs(o: LaunchOptions, target?: ResumeTarget): string[] | undefined {
  const tail = resumeTail(target);
  return tail && ["launch", "--new-cell", ...launchFlags(o), ...tail];
}

/** `mesh cell rename OLD NEW [--mesh ID]`; undefined for a standalone cell or a name the CLI doesn't take. */
export function cellRenameArgs(cell: LocalCell, all: readonly LocalCell[], newName: string): string[] | undefined {
  const p = startableCell(cell) ? pickArgs(cell, all) : undefined;
  return p && CELL_NAME.test(newName) ? ["mesh", "cell", "rename", cell.name, newName, ...p.slice(1)] : undefined;
}

/** `mesh cell stop NAME [--mesh ID]`: only for a cell running on this computer. */
export function cellStopArgs(cell: LocalCell, all: readonly LocalCell[]): string[] | undefined {
  const p = pickArgs(cell, all);
  return p && cell.localState === "running" ? ["mesh", "cell", "stop", ...p] : undefined;
}

/** The page for a cell on the website: its mesh's page, or the meshes page for a standalone cell. */
export function cellPageUrl(base: string, cell: LocalCell): string {
  const origin = cell.server ?? base.replace(/\/+$/, "");
  return cell.meshId ? `${origin}/meshes/m/${encodeURIComponent(cell.meshId)}` : `${origin}/meshes`;
}

/** The view's description of a cell: default, mesh (or standalone; left out under its mesh group), server, profile, state. */
export function localCellDescription(cell: LocalCell, defaultServer: string, grouped = false): string {
  const host = cell.server && cell.server !== defaultServer.replace(/\/+$/, "") ? cell.server.replace(/^https:\/\//, "") : undefined;
  return [
    cell.isDefault ? "default" : undefined,
    grouped ? undefined : cell.meshId ? cell.meshName ?? cell.meshId : "standalone",
    host,
    cell.launchProfile ? `profile ${cell.launchProfile}` : undefined,
    cell.localState,
    cell.registryState ? `registry ${cell.registryState}` : undefined,
    cell.path ? `path ${cell.path}` : undefined,
    cell.needsApproval ? "waits for an admin" : undefined,
    cell.duplicate ? "stored twice" : undefined,
  ].filter(Boolean).join(" · ");
}

export function localCellTooltip(cell: LocalCell, defaultServer: string): string {
  return [
    `Cell: ${cell.name}${cell.isDefault ? " (default)" : ""}`,
    cell.meshId ? `Mesh: ${cell.meshName ? `${cell.meshName} (${cell.meshId})` : cell.meshId}` : "Standalone: add it to a mesh in the browser to start it.",
    `Server: ${(cell.server ?? defaultServer).replace(/^https:\/\//, "")}`,
    ...(cell.launchProfile ? [`Launch profile: ${cell.launchProfile}`] : []),
    ...(cell.localState ? [`On this computer: ${cell.localState}${cell.pid ? ` (pid ${cell.pid})` : ""}`] : []),
    ...(cell.registryState ? [`Registry: ${cell.registryState}`] : []),
    ...(cell.localState ? [`Path: ${cell.path ?? "none"}`] : []),
    `ID: ${cell.instanceId}`,
    ...(cell.created ? [`Stored: ${cell.created}`] : []),
    ...(cell.needsApproval ? ["Waits for a mesh admin to approve it."] : []),
    ...(cell.duplicate ? ["Two keys on this computer name this cell. Forget the one you don't use."] : []),
  ].join("\n");
}

/**
 * Where the CLI keeps its cell list (`<state home>/a4sx/cells.json`): $XDG_STATE_HOME or ~/.local/state;
 * on Windows $XDG_STATE_HOME or %LOCALAPPDATA%. Used only to notice a change; the file is never read here.
 */
export function cellsListDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string | undefined {
  const p = platform === "win32" ? path.win32 : path.posix;
  const state = env.XDG_STATE_HOME || (platform === "win32" ? env.LOCALAPPDATA : p.join(home, ".local", "state"));
  return state ? p.join(state, "a4sx") : undefined;
}
