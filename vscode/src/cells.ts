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
  /** CLI 0.25.0+: the cell's tags (shown since 0.7.0, only the well-formed `tag:<name>` ones: see shownTags). */
  tags?: string[];
  /**
   * a4sx #1861 (CLI 0.28.0): the cell's effective policy. undefined: the CLI doesn't send it (older CLI);
   * null: none (a standalone cell, a cell of another server, or signed out).
   */
  policy?: CellPolicy | null;
  /** CLI 0.27.0+: the launch profile's name, where it comes from, its X-Fleet-Operator and what its route serves. */
  profileName?: string;
  profileSource?: ProfileSource;
  operator?: string;
  routeModel?: string;
  routeEffort?: string;
}

/** a4sx #1861 (CLI 0.28.0): `mesh cells --json`'s `policy` of a cell, as read (see parseCellPolicy). */
export interface CellPolicy {
  /** "preset" in P1; anything else is kept only when it is a short plain word. */
  basis?: string;
  policyRev: number | null;
  canTalkTo: number | null;
  reachableFrom: number | null;
  /** The mesh's Policy tab on the website; only set when it passes policyUrl's checks. */
  url?: string;
}

/** CLI 0.27.0: where the cell's launch profile comes from. */
export const PROFILE_SOURCES = ["assigned", "default", "fallback"] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];
/** A model id as the CLI passes it to Claude Code (its _CELL_ID_RE). */
export const ROUTE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,63}$/;
export const ROUTE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** An X-Fleet-Operator value as the CLI shows it (its _CELL_HEADER_VALUE_RE). */
export const ROUTE_OPERATOR = /^[A-Za-z0-9._:/-]{1,64}$/;

export const CELL_PROFILE_TEXTS = {
  sources: { assigned: "set for this cell", default: "your default profile", fallback: "your default: its own profile was deleted" } as Record<ProfileSource, string>,
  profileLine: (name: string, source?: ProfileSource) => `Launch profile: ${name}${source ? ` (${CELL_PROFILE_TEXTS.sources[source]})` : ""}`,
  operatorLine: (op: string) => `X-Fleet-Operator: ${op}`,
  routeLine: (model: string, effort?: string) => `Route: serves ${model}${effort ? ` at ${effort} effort` : ""}`,
  description: (name: string, model?: string, effort?: string) => `profile ${name}${model ? ` → ${model}${effort ? ` (${effort})` : ""}` : ""}`,
};

/** The mesh policy's name as the summary line shows it (spec §25.11, draft for owner approval). */
export const CELL_POLICY_TEXTS = {
  labels: { open: "Open", own: "Own cells", closed: "Closed" } as Record<MeshPolicy, string>,
  summary: (label: string, canTalkTo: number | null) => (canTalkTo === null ? label : `${label} · can talk to ${canTalkTo}`),
  tagsLine: (tags: readonly string[]) => `Tags: ${tags.join(", ")}`,
  openPolicy: "Open policy in browser",
};

/** A tag as the registry stores it (spec §25.2): `tag:` and 1–32 lowercase letters, digits and dashes. */
export const TAG = /^tag:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** The tags the view shows: only well-formed `tag:<name>` values, so a tag is always plain text that looks like one. */
export function shownTags(cell: LocalCell): string[] {
  return (cell.tags ?? []).filter((t) => TAG.test(t));
}

/**
 * The cell's one summary line: "Open · can talk to 3", or "Open" alone when the count is unknown. undefined when the
 * CLI doesn't send `policy` (older CLI), sends `policy: null` (a server without access control, a standalone cell,
 * another server's cell, signed out: nothing extra is shown, never a bare preset label), or the mesh's policy is
 * unknown.
 */
export function cellPolicySummary(cell: LocalCell): string | undefined {
  if (!cell.policy || !cell.meshPolicy) {
    return undefined;
  }
  return CELL_POLICY_TEXTS.summary(CELL_POLICY_TEXTS.labels[cell.meshPolicy], cell.policy?.canTalkTo ?? null);
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * The website's Policy tab for this cell's mesh, or undefined when `v` isn't exactly that: an https URL (http only
 * on localhost or 127.0.0.1, for development) without a user, password or fragment, whose path ends in
 * `/meshes/m/<the cell's mesh id>` and whose query is exactly `?tab=policy`; on the cell's own server when the CLI
 * says which (spec §25.8: the CLI builds it from that server).
 */
export function policyUrl(v: unknown, cell: Pick<LocalCell, "meshId" | "server">): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== "string" || v.length > 2048 || !cell.meshId || !v.endsWith("?tab=policy") || /[\s\x00-\x1f\x7f\\]/.test(v)) {
    return undefined;
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return undefined;
  }
  const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if ((u.protocol !== "https:" && !local) || u.username || u.password || u.hash || u.search !== "?tab=policy") {
    return undefined;
  }
  if (!u.pathname.replace(/\/+$/, "").endsWith(`/meshes/m/${cell.meshId}`)) {
    return undefined;
  }
  // On the cell's own server when the CLI says which (a bare host is stored as https://, so a local dev server
  // may differ in the scheme only).
  if (cell.server && u.origin !== cell.server && !(local && cell.server.replace(/^https:/, "http:") === u.origin)) {
    return undefined;
  }
  return u.href;
}

/** `policy` of a `mesh cells --json` row: null for null or anything that isn't an object; the counts only when they are counts. */
export function parseCellPolicy(v: unknown, cell: Pick<LocalCell, "meshId" | "server">): CellPolicy | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return null;
  }
  const r = v as Record<string, unknown>;
  const policy: CellPolicy = { policyRev: count(r.policy_rev), canTalkTo: count(r.can_talk_to), reachableFrom: count(r.reachable_from) };
  if (typeof r.basis === "string" && /^[a-z]{1,16}$/.test(r.basis)) {
    policy.basis = r.basis;
  }
  const url = policyUrl(r.url, cell);
  if (url) {
    policy.url = url;
  }
  return policy;
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

/** CLI 0.27.0: `mesh cell profile NAME PROFILE [--mesh ID|standalone]`, or with `--clear` for undefined. */
export function cellProfileArgs(cell: LocalCell, all: readonly LocalCell[], profile: string | undefined): string[] | undefined {
  const p = pickArgs(cell, all);
  if (!p || (profile !== undefined && !PROFILE.test(profile))) {
    return undefined;
  }
  return ["mesh", "cell", "profile", p[0], ...(profile === undefined ? ["--clear"] : [profile]), ...p.slice(1)];
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

/** `launch --new-cell [flags] [--a4sx-session=ID | -- --resume ID]`: the browser approval picks the mesh. */
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
    cell.launchProfile ? CELL_PROFILE_TEXTS.description(cell.profileName ?? cell.launchProfile, cell.routeModel, cell.routeEffort) : undefined,
    cell.localState,
    cell.registryState ? `registry ${cell.registryState}` : undefined,
    cell.path ? `path ${cell.path}` : undefined,
    shownTags(cell).join(" ") || undefined,
    cellPolicySummary(cell),
    cell.needsApproval ? "waits for an admin" : undefined,
    cell.duplicate ? "stored twice" : undefined,
  ].filter(Boolean).join(" · ");
}

export function localCellTooltip(cell: LocalCell, defaultServer: string): string {
  return [
    `Cell: ${cell.name}${cell.isDefault ? " (default)" : ""}`,
    cell.meshId ? `Mesh: ${cell.meshName ? `${cell.meshName} (${cell.meshId})` : cell.meshId}` : "Standalone: add it to a mesh in the browser to start it.",
    `Server: ${(cell.server ?? defaultServer).replace(/^https:\/\//, "")}`,
    ...(cell.launchProfile ? [CELL_PROFILE_TEXTS.profileLine(cell.profileName ?? cell.launchProfile, cell.profileSource)] : []),
    ...(cell.operator ? [CELL_PROFILE_TEXTS.operatorLine(cell.operator)] : []),
    ...(cell.routeModel ? [CELL_PROFILE_TEXTS.routeLine(cell.routeModel, cell.routeEffort)] : []),
    ...(cell.localState ? [`On this computer: ${cell.localState}${cell.pid ? ` (pid ${cell.pid})` : ""}`] : []),
    ...(cell.registryState ? [`Registry: ${cell.registryState}`] : []),
    ...(cell.localState ? [`Path: ${cell.path ?? "none"}`] : []),
    ...(shownTags(cell).length ? [CELL_POLICY_TEXTS.tagsLine(shownTags(cell))] : []),
    ...(cellPolicySummary(cell) ? [cellPolicySummary(cell)!] : []),
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
