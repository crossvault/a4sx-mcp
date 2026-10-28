// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The read-only mesh calls of the "Meshes" view, its tree model, the console links and the
// `a4sx launch --ipc-proxy` command. No vscode import, so all of it is unit-tested with a fake fetch.
//
// Only two routes are read, with the sidebar's library key: GET /meshes (my meshes) and
// GET /me/mesh/cells (my machines and their cells). Every change happens on the website.
// Presence, last seen and reach are kinds ("online", "relay", ...), never addresses: a value that
// isn't a plain kind word is not shown. Machine labels may hold a hostname; they are shown in this
// owner-only view and nowhere else (no logs, no messages, no commands).
import { ApiError, call, Client, errorCode, fail, MESSAGES, SCOPE_MESH_READ } from "./api";

export const MESH_TEXTS = {
  notSupported: "Meshes are not available on this a4sx server.",
  needsSignin: "Viewing your meshes needs a sign-in on the a4sx website first.",
  openInBrowser: "Open in browser",
  allowMeshRead: "Allow mesh read",
  noMeshes: "You're not in a mesh yet. Create one or redeem an invite in your browser.",
  noCells: "No sessions of yours in this mesh yet. Start one.",
  meshGone: "This mesh is no longer in your list. Refresh the view.",
  badMesh: "This mesh id can't be passed to the a4sx CLI.",
  namePrompt: "A name for this session in the mesh (letters, digits, - and _).",
  nameTitle: "Start a session in the mesh",
  nameRule: "Use 1-63 letters, digits, - and _, starting with a letter or digit.",
  tierCWindows: "On Windows (tier c) a host shows as one machine per mesh.",
} as const;

/** Polling interval while the view is visible. */
export const POLL_MS = 30_000;

// ---- shapes ---------------------------------------------------------------------------------------

export interface Mesh {
  id: string;
  name?: string;
  role?: string;
}

export interface Cell {
  mesh: string;
  instance?: string;
  name?: string;
  isolation?: string;
  status?: string;
  presence?: string;
  last_seen?: string | number;
  reach?: string;
  os?: string;
  version?: string;
}

export interface Machine {
  keyId: string;
  label?: string;
  /** "pairing" or "pinned". */
  binding?: string;
  created?: string;
  expires?: string;
  revoked: boolean;
  cells: Cell[];
}

/** A word that names a kind: never an address, a host, a path or free text. */
const KIND = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;
const TEXT_MAX = 80;

/** A kind as it may be shown, or undefined (anything with a dot, colon, slash or space is dropped). */
export function kind(v: unknown): string | undefined {
  return typeof v === "string" && KIND.test(v) ? v.toLowerCase() : undefined;
}

function version(v: unknown): string | undefined {
  return typeof v === "string" && VERSION.test(v) ? v : undefined;
}

/** A free-text field cut to one short line (mesh names, machine labels). */
export function oneLine(v: unknown): string | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const line = v.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!line) {
    return undefined;
  }
  return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX - 1)}…` : line;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function parseMesh(m: any): Mesh | undefined {
  const id = str(m?.id);
  if (!id) {
    return undefined;
  }
  return { id, name: oneLine(m.name ?? m.label), role: kind(m.role) };
}

function parseCell(c: any): Cell | undefined {
  const mesh = str(c?.mesh);
  if (!mesh) {
    return undefined;
  }
  const lastSeen = typeof c.last_seen === "number" || typeof c.last_seen === "string" ? c.last_seen : undefined;
  return {
    mesh,
    instance: oneLine(c.instance),
    name: oneLine(c.name),
    isolation: kind(c.isolation),
    status: kind(c.status),
    presence: kind(c.presence),
    last_seen: lastSeen,
    reach: kind(c.reach),
    os: kind(c.os),
    version: version(c.version),
  };
}

function parseMachine(m: any): Machine | undefined {
  const keyId = str(m?.key_id ?? m?.id);
  if (!keyId) {
    return undefined;
  }
  const binding = m.pinned === true ? "pinned" : m.pairing === true ? "pairing" : kind(m.binding ?? m.kind ?? m.state);
  return {
    keyId,
    label: oneLine(m.label),
    binding: binding === "pinned" || binding === "pairing" ? binding : undefined,
    created: str(m.created),
    expires: str(m.expires),
    revoked: m.revoked === true || (typeof m.revoked === "string" && m.revoked.length > 0),
    cells: Array.isArray(m.cells) ? m.cells.map(parseCell).filter((c: Cell | undefined): c is Cell => !!c) : [],
  };
}

// ---- HTTP -----------------------------------------------------------------------------------------

/**
 * The refusals that drive the view's feature detection:
 *   404 (or 405)                       → "not-supported": meshes or the console are off; the view hides.
 *   403 scope_denied / insufficient_scope naming mesh:read → "insufficient-scope" (requiredScope mesh:read).
 *   409 needs_signin                   → "needs-signin": the website must be opened first.
 * Anything else is the usual fixed message (401 sign in again, 429/503 busy, HTTP n).
 */
export function meshFail(status: number, data: any): never {
  const code = errorCode(data);
  if (status === 404 || status === 405) {
    throw new ApiError("not-supported", MESH_TEXTS.notSupported, status);
  }
  if (status === 403 && (code === "scope_denied" || code === "insufficient_scope")) {
    // Only mesh:read is ever offered, whatever scope a server names.
    const named = data?.error?.details?.required_scope;
    const scope = typeof named === "string" && named ? named : SCOPE_MESH_READ;
    throw new ApiError("insufficient-scope", MESSAGES.needsScope(scope.slice(0, 64)), status, scope.slice(0, 64));
  }
  if (status === 409 && code === "needs_signin") {
    throw new ApiError("needs-signin", MESH_TEXTS.needsSignin, status);
  }
  fail(status);
}

export async function listMeshes(c: Client, token: string): Promise<Mesh[]> {
  const { status, data } = await call(c, "/meshes", { token });
  if (status !== 200) {
    meshFail(status, data);
  }
  const rows = Array.isArray(data) ? data : data?.meshes;
  if (!Array.isArray(rows)) {
    throw new ApiError("bad-response", MESSAGES.badResponse, status);
  }
  return rows.map(parseMesh).filter((m): m is Mesh => !!m);
}

export async function listMyCells(c: Client, token: string): Promise<Machine[]> {
  const { status, data } = await call(c, "/me/mesh/cells", { token });
  if (status !== 200) {
    meshFail(status, data);
  }
  const rows = Array.isArray(data) ? data : data?.machines;
  if (!Array.isArray(rows)) {
    throw new ApiError("bad-response", MESSAGES.badResponse, status);
  }
  return rows.map(parseMachine).filter((m): m is Machine => !!m);
}

export type MeshLoad =
  | { kind: "signed-out" }
  | { kind: "ok"; meshes: Mesh[]; machines: Machine[] }
  | { kind: "off" }
  | { kind: "needs-scope"; scope: string }
  | { kind: "needs-signin" }
  | { kind: "error"; message: string; unauthorized: boolean };

/** Both reads, mapped to what the view shows. Never throws. */
export async function loadMeshes(c: () => Client, token: string | undefined): Promise<MeshLoad> {
  if (!token) {
    return { kind: "signed-out" };
  }
  try {
    const client = c();
    const meshes = await listMeshes(client, token);
    const machines = await listMyCells(client, token);
    return { kind: "ok", meshes, machines };
  } catch (e) {
    return detect(e);
  }
}

/** The feature detection: an error from the mesh routes, as a view state. */
export function detect(e: unknown): MeshLoad {
  if (e instanceof ApiError) {
    if (e.code === "not-supported") {
      return { kind: "off" };
    }
    if (e.code === "insufficient-scope" && e.requiredScope) {
      return { kind: "needs-scope", scope: e.requiredScope };
    }
    if (e.code === "needs-signin") {
      return { kind: "needs-signin" };
    }
    return { kind: "error", message: e.message, unauthorized: e.code === "unauthorized" };
  }
  return { kind: "error", message: MESSAGES.unreachable, unauthorized: false };
}

/** Whether the view is shown for a load: hidden when meshes are off or nobody is signed in. */
export function viewAvailable(load: MeshLoad, before: boolean): boolean {
  switch (load.kind) {
    case "off":
    case "signed-out":
      return false;
    case "error":
      return before;   // a dropped connection keeps whatever was shown
    default:
      return true;
  }
}

// ---- tree model -----------------------------------------------------------------------------------

export interface CellGroup {
  machine: Machine;
  cells: Cell[];
}

export interface MeshNode {
  mesh: Mesh;
  /** One group per machine that has cells in this mesh. */
  groups: CellGroup[];
  /** True when the cells come from more than one machine: the view then shows a node per machine. */
  byMachine: boolean;
  cellCount: number;
  onlineCount: number;
}

const ONLINE = new Set(["online", "active", "connected", "up"]);

export function isOnline(c: Cell): boolean {
  return c.presence !== undefined && ONLINE.has(c.presence);
}

/** A Windows host on isolation tier c: it registers once per mesh, so it shows as one machine per mesh. */
export function isTierCWindows(c: Cell): boolean {
  return c.os !== undefined && /^win/.test(c.os) && c.isolation !== undefined && /^(tier[-_]?)?c$/.test(c.isolation);
}

function cellSortKey(c: Cell): string {
  return `${isOnline(c) ? 0 : 1}${(c.name ?? c.instance ?? "").toLowerCase()}`;
}

/**
 * My meshes (from GET /meshes, sorted by name), each with my cells in it (from GET /me/mesh/cells),
 * grouped by machine. Revoked machines are left out. A cell naming a mesh that isn't in the list is
 * not shown: the list of meshes is the authority on what I may see.
 */
export function meshTree(meshes: readonly Mesh[], machines: readonly Machine[]): MeshNode[] {
  const live = machines.filter((m) => !m.revoked);
  return [...meshes]
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
    .map((mesh) => {
      const groups = live
        .map((machine) => ({ machine, cells: machine.cells.filter((c) => c.mesh === mesh.id).sort((a, b) => cellSortKey(a).localeCompare(cellSortKey(b))) }))
        .filter((g) => g.cells.length > 0)
        .sort((a, b) => (a.machine.label ?? a.machine.keyId).localeCompare(b.machine.label ?? b.machine.keyId));
      const cells = groups.flatMap((g) => g.cells);
      return { mesh, groups, byMachine: groups.length > 1, cellCount: cells.length, onlineCount: cells.filter(isOnline).length };
    });
}

const FIVE_MIN = 5 * 60_000;

/** A last-seen time as "seen 10 min ago": rounded down to 5 minutes, like the server sends it. */
export function lastSeenText(v: string | number | undefined, now: number): string | undefined {
  if (v === undefined) {
    return undefined;
  }
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  if (!Number.isFinite(t)) {
    return undefined;
  }
  const ago = Math.max(0, now - t);
  if (ago < FIVE_MIN) {
    return "seen just now";
  }
  const min = Math.floor(ago / FIVE_MIN) * 5;
  if (min < 60) {
    return `seen ${min} min ago`;
  }
  const h = Math.floor(min / 60);
  if (h < 48) {
    return `seen ${h} h ago`;
  }
  return `seen ${Math.floor(h / 24)} d ago`;
}

/** The short line next to a cell: status · presence · reach · last seen. Kinds only. */
export function cellDescription(c: Cell, now: number): string {
  const parts = [c.status, c.presence && c.presence !== c.status ? c.presence : undefined, c.reach, isOnline(c) ? undefined : lastSeenText(c.last_seen, now)];
  return parts.filter(Boolean).join(" · ");
}

/** The cell's tooltip lines. `machineLabel` may be a hostname: only this owner-only view shows it. */
export function cellTooltip(c: Cell, machine: Machine, now: number): string {
  return [
    `Name: ${c.name ?? "not set"}`,
    ...(c.instance ? [`Instance: ${c.instance}`] : []),
    `Status: ${c.status ?? "unknown"}`,
    `Presence: ${c.presence ?? "unknown"}`,
    ...(c.last_seen !== undefined && lastSeenText(c.last_seen, now) ? [`Last ${lastSeenText(c.last_seen, now)}`] : []),
    `Reach: ${c.reach ?? "unknown"}`,
    ...(c.isolation ? [`Isolation: ${c.isolation}`] : []),
    ...(c.os ? [`OS: ${c.os}`] : []),
    ...(c.version ? [`Version: ${c.version}`] : []),
    `Machine: ${machine.label ?? machine.keyId}`,
    ...(isTierCWindows(c) ? [MESH_TEXTS.tierCWindows] : []),
  ].join("\n");
}

export function machineTooltip(m: Machine, cells: readonly Cell[]): string {
  return [
    `Machine: ${m.label ?? m.keyId}`,
    ...(m.binding ? [`Key: ${m.binding}`] : []),
    ...(m.expires ? [`Key expires: ${m.expires.slice(0, 10)}`] : []),
    ...(cells.some(isTierCWindows) ? [MESH_TEXTS.tierCWindows] : []),
  ].join("\n");
}

// ---- console links --------------------------------------------------------------------------------

/** Create a mesh (the website's mesh list). */
export function meshesPageUrl(base: string): string {
  return `${base}/meshes`;
}

/** One mesh's page on the website. */
export function meshPageUrl(base: string, id: string): string {
  return `${base}/meshes/m/${encodeURIComponent(id)}`;
}

/** Redeem an invite on the website. */
export function meshInviteUrl(base: string): string {
  return `${base}/meshes/invite`;
}

// ---- start a session in a mesh --------------------------------------------------------------------

/** A mesh id the CLI may get as one argument: plain id characters only. */
export const MESH_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The `--as` name: a plain word, so no shell can read anything into it. */
export const CELL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** The input box's check: undefined when the name is fine, else the rule. */
export function validateCellName(raw: string): string | undefined {
  return CELL_NAME.test(raw.trim()) ? undefined : MESH_TEXTS.nameRule;
}

/** A default `--as` name not yet used by my cells in the mesh: "vscode", then "vscode-2", ... */
export function suggestCellName(taken: readonly (string | undefined)[]): string {
  const used = new Set(taken.filter(Boolean));
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? "vscode" : `vscode-${i}`;
    if (!used.has(name)) {
      return name;
    }
  }
  return "vscode";
}

/**
 * The arguments of `a4sx launch --ipc-proxy --mesh <id> --as <name>`, or undefined when either piece
 * isn't a plain id. The caller quotes each one for the shell (terminalCommand.ts). Nothing secret goes
 * in: the CLI and its proxy sign in on their own.
 */
export function meshLaunchArgs(meshId: string, name: string): string[] | undefined {
  const n = name.trim();
  if (!MESH_ID.test(meshId) || !CELL_NAME.test(n)) {
    return undefined;
  }
  return ["launch", "--ipc-proxy", "--mesh", meshId, "--as", n];
}

// ---- polling --------------------------------------------------------------------------------------

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * Runs `tick` every `ms` while visible: once right away when the view becomes visible, then on the
 * interval; nothing while hidden. A tick still running is not started again.
 */
export class VisibilityPoller {
  private handle: unknown;
  private running = false;

  constructor(private readonly tick: () => Promise<unknown>, private readonly ms: number = POLL_MS, private readonly timers: Timers = realTimers) {}

  get active(): boolean {
    return this.handle !== undefined;
  }

  setVisible(visible: boolean): void {
    if (visible && this.handle === undefined) {
      this.handle = this.timers.setInterval(() => void this.run(), this.ms);
      void this.run();
    } else if (!visible && this.handle !== undefined) {
      this.timers.clearInterval(this.handle);
      this.handle = undefined;
    }
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.tick();
    } catch {
      // The view shows its own error item; a failed tick never stops the poll.
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.setVisible(false);
  }
}
