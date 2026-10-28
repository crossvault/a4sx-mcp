// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The read-only mesh calls of the "Meshes" view, their loader (probe, polling, backoff), the tree
// model, the console links and the `a4sx launch --ipc-proxy` command. No vscode import, so all of it
// is unit-tested with a fake fetch and fake timers.
//
// Only two routes are read, with the sidebar's library key: GET /meshes (my meshes) and
// GET /me/mesh/cells (my machines and their cells). Every change happens on the website.
// The answers are parsed to the pinned server contract: each kind field takes only its listed values,
// anything else shows as "unknown", so free text (a hostname, an address) never shows as a kind.
// Machine labels may hold a hostname; they are shown in this owner-only view and nowhere else (no
// logs, no messages, no commands, no links).
import { ApiError, call, Client, errorCode, fail, MESSAGES, SCOPE_MESH_READ } from "./api";

export const MESH_TEXTS = {
  notSupported: "Meshes are not available on this a4sx server.",
  needsSignin: "Viewing your meshes needs a sign-in on the a4sx website first.",
  openInBrowser: "Open in browser",
  allowMeshRead: "Allow mesh read",
  noMeshes: "You're not in a mesh yet. Create one or redeem an invite in your browser.",
  noCells: "No cells of yours in this mesh yet. Start a session in it.",
  cellsNotYet: "Cells appear here once your server supports it.",
  meshGone: "This mesh is no longer in your list. Refresh the view.",
  badMesh: "This mesh id can't be passed to the a4sx CLI.",
  archived: "This mesh is archived.",
  namePrompt: "A name for this session in the mesh (lowercase letters, digits and -).",
  nameTitle: "Start a session in the mesh",
  nameRule: "Use 1-48 lowercase letters, digits and -, starting and ending with a letter or digit.",
  tierCWindows: "On Windows (tier c) a host shows as one machine per mesh.",
  signedOut: "You were signed out of a4sx because your sign-in is no longer valid. Sign in again to see your meshes.",
  unknown: "unknown",
} as const;

/** Polling interval while the view is visible. */
export const POLL_MS = 30_000;
/** A visibility tick is skipped when the last full load is younger than this. */
export const MIN_RELOAD_MS = 5_000;
/** The longest any backoff or Retry-After waits. */
export const BACKOFF_CAP_MS = 5 * 60_000;
/** The startup probe's retries while availability is undecided: about 30 s → 5 min, 5 tries. */
export const PROBE_RETRY_MS: readonly number[] = [30_000, 60_000, 120_000, 240_000, 300_000];
/** Pages followed through `next_cursor` before stopping. */
export const MAX_PAGES = 20;

// ---- the pinned contract --------------------------------------------------------------------------

/** A mesh id, exactly as the server issues it. Anything else is dropped on parse and refused by every command. */
export const MESH_ID = /^msh_[0-9a-f]{32}$/;
/** The `--as` name: the intersection of the server's and the CLI's rules. */
export const CELL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export const PRESENCE = ["online", "idle", "busy", "away", "offline"] as const;
export const REACH = ["lan", "public", "via"] as const;
export const BINDING = ["pairing", "pinned"] as const;
/** A cell's status. Revoked cells come only under a machine with `revoked: true`. */
export const STATUS = ["active", "revoked", "pending"] as const;
/** Self-reported isolation: sandbox = tier a, uid = tier b, reduced = tier c. */
export const ISOLATION = ["sandbox", "uid", "reduced"] as const;
/** The cell's OS; absent or null from older CLIs (then nothing is shown). */
export const OS = ["linux", "wsl", "windows", "macos-reserved"] as const;
/** The mesh role; absent for non-members. */
export const ROLE = ["owner", "admin", "member"] as const;
export const MESH_STATUS = ["active", "archived"] as const;

const TIER: Record<(typeof ISOLATION)[number], string> = { sandbox: "a", uid: "b", reduced: "c" };
const OS_LABEL: Record<(typeof OS)[number], string> = { linux: "linux", wsl: "wsl", windows: "windows", "macos-reserved": "macos" };

export type Unknown = typeof MESH_TEXTS.unknown;
const UNKNOWN: Unknown = MESH_TEXTS.unknown;

/** `v` if it is one of `allowed`, else "unknown". */
export function oneOf<T extends string>(allowed: readonly T[], v: unknown): T | Unknown {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : UNKNOWN;
}

const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(?:[-+][0-9A-Za-z.-]{1,24})?$/;
const BUCKET = /^[0-9]{1,6}(?:-[0-9]{1,6}|\+)?$/;
const TEXT_MAX = 80;

/** A free-text field cut to one short line (mesh names, machine labels, cell names). */
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

function isoOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : undefined;
}

export interface Mesh {
  id: string;
  name?: string;
  role?: (typeof ROLE)[number];
  status: (typeof MESH_STATUS)[number] | Unknown;
  archived: boolean;
  memberCountBucket?: string;
}

export interface Cell {
  meshId: string;
  meshName?: string;
  instanceId?: string;
  name?: string;
  isolation: (typeof ISOLATION)[number] | Unknown;
  status: (typeof STATUS)[number] | Unknown;
  presence: (typeof PRESENCE)[number] | Unknown;
  lastSeen?: string;
  /** The reach kinds; ["unknown"] when the server sent none. An unlisted entry is "unknown". */
  reach: ((typeof REACH)[number] | Unknown)[];
  /** Undefined when the CLI sent none (older CLIs). */
  os?: (typeof OS)[number] | Unknown;
  clientVersion?: string;
}

export interface Machine {
  keyId: string;
  label?: string;
  binding: (typeof BINDING)[number] | Unknown;
  createdAt?: string;
  expiresAt?: string;
  revoked: boolean;
  cells: Cell[];
}

export function parseMesh(m: any): Mesh | undefined {
  if (typeof m?.mesh_id !== "string" || !MESH_ID.test(m.mesh_id)) {
    return undefined;
  }
  const role = oneOf(ROLE, m.role);
  return {
    id: m.mesh_id,
    name: oneLine(m.name),
    role: role === UNKNOWN ? undefined : role,
    status: oneOf(MESH_STATUS, m.status),
    archived: m.archived === true || m.status === "archived",
    memberCountBucket: typeof m.member_count_bucket === "string" && BUCKET.test(m.member_count_bucket) ? m.member_count_bucket : undefined,
  };
}

export function parseCell(c: any): Cell | undefined {
  if (typeof c?.mesh_id !== "string" || !MESH_ID.test(c.mesh_id)) {
    return undefined;
  }
  const reach = Array.isArray(c.reach) ? [...new Set(c.reach.map((r: unknown) => oneOf(REACH, r)))] as Cell["reach"] : [];
  return {
    meshId: c.mesh_id,
    meshName: oneLine(c.mesh_name),
    instanceId: oneLine(c.instance_id),
    name: oneLine(c.name),
    isolation: oneOf(ISOLATION, c.isolation),
    status: oneOf(STATUS, c.status),
    presence: oneOf(PRESENCE, c.presence),
    lastSeen: isoOrUndefined(c.last_seen),
    reach: reach.length ? reach : [UNKNOWN],
    // revoked_reason is never read: it is not shown anywhere.
    os: c.os === undefined || c.os === null ? undefined : oneOf(OS, c.os),
    clientVersion: typeof c.client_version === "string" && VERSION.test(c.client_version) ? c.client_version : undefined,
  };
}

export function parseMachine(m: any): Machine | undefined {
  if (typeof m?.key_id !== "string" || !m.key_id) {
    return undefined;
  }
  return {
    keyId: m.key_id,
    label: oneLine(m.label),
    binding: oneOf(BINDING, m.binding),
    createdAt: isoOrUndefined(m.created_at),
    expiresAt: isoOrUndefined(m.expires_at),
    revoked: m.revoked === true,
    cells: Array.isArray(m.cells) ? m.cells.map(parseCell).filter((c: Cell | undefined): c is Cell => !!c) : [],
  };
}

// ---- HTTP -----------------------------------------------------------------------------------------

/** A 429/503 answer, with the server's Retry-After (capped) when it sent one. */
export class BusyError extends ApiError {
  constructor(status: number, public readonly retryAfterMs: number | undefined) {
    super("busy", MESSAGES.busy, status);
  }
}

/** A 403 naming a scope other than mesh:read: shown as an error, never offered as a sign-in. */
export class DeniedError extends ApiError {
  constructor(status: number, scope: string) {
    super("rejected", MESSAGES.needsScope(scope), status);
  }
}

/** Retry-After as milliseconds (seconds or an HTTP date), capped; undefined when absent or unreadable. */
export function retryAfterMs(raw: string | undefined, now: number): number | undefined {
  if (!raw) {
    return undefined;
  }
  const v = raw.trim();
  let ms: number;
  if (/^[0-9]{1,9}$/.test(v)) {
    ms = Number(v) * 1000;
  } else {
    const t = Date.parse(v);
    if (Number.isNaN(t)) {
      return undefined;
    }
    ms = t - now;
  }
  return Math.min(BACKOFF_CAP_MS, Math.max(0, ms));
}

/**
 * The refusals that drive the view's feature detection:
 *   404 (or 405)                → "not-supported": meshes (or this route) are off.
 *   403 scope_denied / insufficient_scope, naming no scope or mesh:read
 *                               → "insufficient-scope" for mesh:read: the view offers "Allow mesh read".
 *   403 naming any other scope  → DeniedError: a plain error, never a sign-in.
 *   409 needs_signin            → "needs-signin": the website must be opened first.
 *   429 / 503                   → BusyError (with Retry-After).
 * Anything else is the usual fixed message (401 sign in again, HTTP n).
 */
export function meshFail(status: number, data: any, retryAfter: string | undefined, now: number): never {
  const code = errorCode(data);
  if (status === 404 || status === 405) {
    throw new ApiError("not-supported", MESH_TEXTS.notSupported, status);
  }
  if (status === 403 && (code === "scope_denied" || code === "insufficient_scope")) {
    const named = data?.error?.details?.required_scope;
    if (named === undefined || named === null || named === "" || named === SCOPE_MESH_READ) {
      throw new ApiError("insufficient-scope", MESSAGES.needsScope(SCOPE_MESH_READ), status, SCOPE_MESH_READ);
    }
    throw new DeniedError(status, typeof named === "string" ? named.slice(0, 64) : "unknown");
  }
  if (status === 409 && code === "needs_signin") {
    throw new ApiError("needs-signin", MESH_TEXTS.needsSignin, status);
  }
  if (status === 429 || status === 503) {
    throw new BusyError(status, retryAfterMs(retryAfter, now));
  }
  fail(status);
}

/** Every page of a cursor-paged list: follows `next_cursor` up to MAX_PAGES (a repeated cursor stops it). */
async function pages<T>(c: Client, token: string, path: string, key: string, parse: (row: any) => T | undefined, now: () => number): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { status, data, retryAfter } = await call(c, cursor === undefined ? path : `${path}?cursor=${encodeURIComponent(cursor)}`, { token });
    if (status !== 200) {
      meshFail(status, data, retryAfter, now());
    }
    const rows = data?.[key];
    if (!Array.isArray(rows)) {
      throw new ApiError("bad-response", MESSAGES.badResponse, status);
    }
    for (const r of rows) {
      const v = parse(r);
      if (v !== undefined) {
        out.push(v);
      }
    }
    const next = data.next_cursor;
    if (typeof next !== "string" || !next || seen.has(next)) {
      break;
    }
    seen.add(next);
    cursor = next;
  }
  return out;
}

export function listMeshes(c: Client, token: string, now: () => number = Date.now): Promise<Mesh[]> {
  return pages(c, token, "/meshes", "meshes", parseMesh, now);
}

export function listMyCells(c: Client, token: string, now: () => number = Date.now): Promise<Machine[]> {
  return pages(c, token, "/me/mesh/cells", "machines", parseMachine, now);
}

// ---- view states and the loader -------------------------------------------------------------------

export type CellsState = Machine[] | "pending" | "unsupported";

export type MeshLoad =
  | { kind: "signed-out" }
  | { kind: "ok"; meshes: Mesh[]; cells: CellsState }
  | { kind: "off" }
  | { kind: "needs-scope"; scope: string }
  | { kind: "needs-signin" }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string; unauthorized: boolean; busy: boolean; retryAfterMs?: number };

/** The feature detection: an error from the mesh routes, as a view state. */
export function detect(e: unknown): MeshLoad {
  if (e instanceof DeniedError) {
    return { kind: "denied", message: e.message };
  }
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
    const busy = e instanceof BusyError;
    const retry = busy ? (e as BusyError).retryAfterMs : undefined;
    return { kind: "error", message: e.message, unauthorized: e.code === "unauthorized", busy, ...(retry !== undefined ? { retryAfterMs: retry } : {}) };
  }
  return { kind: "error", message: MESSAGES.unreachable, unauthorized: false, busy: false };
}

/** Whether a load decides the view: true/false, or undefined when it says nothing (a transient error). */
export function decides(load: MeshLoad): boolean | undefined {
  switch (load.kind) {
    case "off":
    case "signed-out":
      return false;
    case "error":
      return load.unauthorized ? false : undefined;
    default:
      return true;
  }
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Node timers, unref'd: a pending poll or probe retry never keeps a process alive on its own. */
export const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface LoaderDeps {
  client(): Client;
  token(): Promise<string | undefined>;
  /** A 401: the caller forgets the key (as the Sessions view does). */
  unauthorized(): Promise<void>;
  /** The view's availability, after every load. */
  available(value: boolean): void;
  changed(): void;
  now?: () => number;
  timers?: Timers;
}

/**
 * Loads what the view shows and decides whether it is shown.
 *  - probe(): GET /meshes only. Runs when the window opens, after each sign-in and when the server
 *    changes. While availability is undecided (a network error, 5xx, 429), it retries on its own:
 *    PROBE_RETRY_MS, Retry-After honoured, at most 5 tries. A 404 hides the view; a 401 forgets the key.
 *  - full(): both routes, so the cells are read only when the view is shown or a mesh is expanded.
 *    A 404 on the cells alone shows the meshes with one line instead of hiding the view.
 *  - tick(): the visibility/poll tick. Skipped while backing off after a 429/503 (doubling from 30 s,
 *    at least Retry-After, at most 5 min) and when the last full load is under MIN_RELOAD_MS old.
 * Each load remembers the server it asked; an answer that arrives after a4sx.serverUrl changed is dropped.
 */
export class MeshLoader {
  load: MeshLoad | undefined;
  /** undefined while undecided. */
  availability: boolean | undefined;
  private lastFull = 0;
  private notBefore = 0;
  private busyCount = 0;
  private probeTries = 0;
  private retry: unknown;
  private inflightProbe: Promise<void> | undefined;
  private inflightFull: Promise<void> | undefined;
  private disposed = false;
  private readonly now: () => number;
  private readonly timers: Timers;

  constructor(private readonly deps: LoaderDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
  }

  /** True while a probe retry is scheduled. */
  get retrying(): boolean {
    return this.retry !== undefined;
  }

  private base(): string | undefined {
    try {
      return this.deps.client().base;
    } catch {
      return undefined;
    }
  }

  private cancelRetry(): void {
    if (this.retry !== undefined) {
      this.timers.clearTimeout(this.retry);
      this.retry = undefined;
    }
  }

  /** The startup probe (and after each sign-in or server change): resets the retry budget. */
  probe(): Promise<void> {
    this.probeTries = 0;
    this.cancelRetry();
    return this.runProbe();
  }

  private runProbe(): Promise<void> {
    if (!this.inflightProbe) {
      this.inflightProbe = this.doProbe().finally(() => {
        this.inflightProbe = undefined;
      });
    }
    return this.inflightProbe;
  }

  private async doProbe(): Promise<void> {
    const base = this.base();
    const token = await this.deps.token();
    if (!token || base === undefined) {
      this.apply({ kind: "signed-out" }, base);
      return;
    }
    let load: MeshLoad;
    try {
      const meshes = await listMeshes(this.deps.client(), token, this.now);
      // The cells are read again the next time they are shown.
      load = { kind: "ok", meshes, cells: "pending" };
    } catch (e) {
      load = detect(e);
    }
    if (!this.apply(load, base)) {
      return;
    }
    if (load.kind === "ok") {
      this.lastFull = 0;
    }
    if (this.availability === undefined && load.kind === "error") {
      this.scheduleRetry(load.retryAfterMs);
    }
  }

  private scheduleRetry(retryAfter: number | undefined): void {
    if (this.disposed || this.probeTries >= PROBE_RETRY_MS.length) {
      return;
    }
    const delay = Math.min(BACKOFF_CAP_MS, Math.max(PROBE_RETRY_MS[this.probeTries], retryAfter ?? 0));
    this.probeTries++;
    this.retry = this.timers.setTimeout(() => {
      this.retry = undefined;
      void this.runProbe();
    }, delay);
  }

  /** Both routes. `force` (Refresh) ignores the backoff. */
  full(force = false): Promise<void> {
    if (!force && this.now() < this.notBefore) {
      return Promise.resolve();
    }
    if (!this.inflightFull) {
      this.inflightFull = this.doFull().finally(() => {
        this.inflightFull = undefined;
      });
    }
    return this.inflightFull;
  }

  /** The visibility/poll tick. */
  tick(): Promise<void> {
    if (this.now() < this.notBefore || (this.lastFull && this.now() - this.lastFull < MIN_RELOAD_MS)) {
      return Promise.resolve();
    }
    return this.full();
  }

  /** The cells, read on the first show or expand. */
  async ensureCells(): Promise<void> {
    if (this.load?.kind === "ok" && this.load.cells === "pending") {
      await this.full();
    }
  }

  private async doFull(): Promise<void> {
    const base = this.base();
    const token = await this.deps.token();
    if (!token || base === undefined) {
      this.apply({ kind: "signed-out" }, base);
      return;
    }
    let load: MeshLoad;
    try {
      const client = this.deps.client();
      const meshes = await listMeshes(client, token, this.now);
      let cells: CellsState;
      try {
        cells = await listMyCells(client, token, this.now);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "not-supported")) {
          throw e;
        }
        cells = "unsupported";   // the rollout: meshes first, cells once the server has the route
      }
      load = { kind: "ok", meshes, cells };
    } catch (e) {
      load = detect(e);
    }
    if (!this.apply(load, base)) {
      return;
    }
    if (load.kind === "error" && load.busy) {
      this.busyCount++;
      const backoff = POLL_MS * 2 ** (this.busyCount - 1);
      this.notBefore = this.now() + Math.min(BACKOFF_CAP_MS, Math.max(backoff, load.retryAfterMs ?? 0));
    } else {
      this.busyCount = 0;
      this.notBefore = 0;
    }
    if (load.kind === "ok") {
      this.lastFull = this.now();
    }
  }

  /** Stores a load if the server is still the one asked; returns false when it was dropped. */
  private apply(load: MeshLoad, base: string | undefined): boolean {
    if (this.disposed || this.base() !== base) {
      return false;
    }
    if (load.kind === "error" && load.unauthorized) {
      this.load = { kind: "signed-out" };
      this.availability = false;
      this.cancelRetry();
      this.deps.available(false);
      this.deps.changed();
      void this.deps.unauthorized();
      return true;
    }
    this.load = load;
    const d = decides(load);
    if (d !== undefined) {
      this.availability = d;
      this.cancelRetry();
    }
    this.deps.available(this.availability ?? false);
    this.deps.changed();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRetry();
  }
}

// ---- tree model -----------------------------------------------------------------------------------

export interface CellGroup {
  machine: Machine;
  cells: Cell[];
}

export interface MeshNode {
  mesh: Mesh;
  /** One group per machine that has cells in this mesh; undefined while the cells aren't known. */
  groups: CellGroup[] | undefined;
  /** True when the cells come from more than one machine: the view then shows a node per machine. */
  byMachine: boolean;
  cellCount: number;
  onlineCount: number;
}

export function isOnline(c: Cell): boolean {
  return c.presence === "online" || c.presence === "busy";
}

/** A Windows host on isolation tier c (reduced): it registers once per mesh, so it shows as one machine per mesh. */
export function isTierCWindows(c: Cell): boolean {
  return c.os === "windows" && c.isolation === "reduced";
}

/** A cell's status as shown: pending is "Waiting for approval". */
export function statusText(c: Cell): string {
  return c.status === "pending" ? "Waiting for approval" : c.status;
}

/** The isolation as shown: its tier letter, marked self-reported ("tier c (reduced), self-reported"). */
export function isolationText(c: Cell): string {
  return c.isolation === UNKNOWN ? UNKNOWN : `tier ${TIER[c.isolation]} (${c.isolation}), self-reported`;
}

/** The OS as shown, or undefined when the CLI sent none. */
export function osText(c: Cell): string | undefined {
  if (c.os === undefined) {
    return undefined;
  }
  return c.os === UNKNOWN ? UNKNOWN : OS_LABEL[c.os];
}

function cellSortKey(c: Cell): string {
  return `${isOnline(c) ? 0 : 1}${(c.name ?? c.instanceId ?? "").toLowerCase()}`;
}

/**
 * My meshes (from GET /meshes, sorted by name), each with my cells in it (from GET /me/mesh/cells),
 * grouped by machine; `machines` undefined means the cells aren't known (yet). Revoked machines are
 * left out. A cell naming a mesh that isn't in the list is not shown: the list of meshes is the
 * authority on what I may see.
 */
export function meshTree(meshes: readonly Mesh[], machines: readonly Machine[] | undefined): MeshNode[] {
  const live = machines?.filter((m) => !m.revoked);
  return [...meshes]
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
    .map((mesh) => {
      if (!live) {
        return { mesh, groups: undefined, byMachine: false, cellCount: 0, onlineCount: 0 };
      }
      const groups = live
        .map((machine) => ({ machine, cells: machine.cells.filter((c) => c.meshId === mesh.id).sort((a, b) => cellSortKey(a).localeCompare(cellSortKey(b))) }))
        .filter((g) => g.cells.length > 0)
        .sort((a, b) => (a.machine.label ?? a.machine.keyId).localeCompare(b.machine.label ?? b.machine.keyId));
      const cells = groups.flatMap((g) => g.cells);
      return { mesh, groups, byMachine: groups.length > 1, cellCount: cells.length, onlineCount: cells.filter(isOnline).length };
    });
}

const FIVE_MIN = 5 * 60_000;

/** A last-seen time as "seen 10 min ago": rounded down to 5 minutes, like the server sends it. */
export function lastSeenText(iso: string | undefined, now: number): string | undefined {
  const t = iso === undefined ? NaN : Date.parse(iso);
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

export function reachText(c: Cell): string {
  return c.reach.join("+");
}

/** The short line next to a cell: status · presence · reach · last seen. Listed kinds or "unknown" only. */
export function cellDescription(c: Cell, now: number): string {
  const parts = [statusText(c), c.presence, reachText(c), isOnline(c) ? undefined : lastSeenText(c.lastSeen, now)];
  return parts.filter(Boolean).join(" · ");
}

/** The cell's tooltip lines. The machine label may be a hostname: only this owner-only view shows it. */
export function cellTooltip(c: Cell, machine: Machine, now: number): string {
  const seen = lastSeenText(c.lastSeen, now);
  return [
    `Name: ${c.name ?? "not set"}`,
    ...(c.instanceId ? [`Instance: ${c.instanceId}`] : []),
    `Status: ${statusText(c)}`,
    `Presence: ${c.presence}`,
    ...(seen ? [`Last ${seen}`] : []),
    `Reach: ${reachText(c)}`,
    `Isolation: ${isolationText(c)}`,
    ...(osText(c) ? [`OS: ${osText(c)}`] : []),
    ...(c.clientVersion ? [`Version: ${c.clientVersion}`] : []),
    `Machine: ${machine.label ?? machine.keyId}`,
    ...(isTierCWindows(c) ? [MESH_TEXTS.tierCWindows] : []),
  ].join("\n");
}

export function machineTooltip(m: Machine, cells: readonly Cell[]): string {
  return [
    `Machine: ${m.label ?? m.keyId}`,
    `Key: ${m.binding}`,
    ...(m.expiresAt ? [`Key expires: ${m.expiresAt.slice(0, 10)}`] : []),
    ...(cells.some(isTierCWindows) ? [MESH_TEXTS.tierCWindows] : []),
  ].join("\n");
}

// ---- console links --------------------------------------------------------------------------------

/** Create a mesh (the website's mesh list). */
export function meshesPageUrl(base: string): string {
  return `${base}/meshes`;
}

/** One mesh's page on the website; undefined for an id that isn't a mesh id. */
export function meshPageUrl(base: string, id: string): string | undefined {
  return MESH_ID.test(id) ? `${base}/meshes/m/${encodeURIComponent(id)}` : undefined;
}

/** Redeem an invite on the website. */
export function meshInviteUrl(base: string): string {
  return `${base}/meshes/invite`;
}

// ---- start a session in a mesh --------------------------------------------------------------------

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
 * The arguments of `a4sx launch --ipc-proxy --mesh <id> --as <name>`, or undefined when the id isn't
 * a mesh id or the name breaks the rule. The caller quotes each one for the shell (terminalCommand.ts).
 * Nothing secret goes in: the CLI and its proxy sign in on their own.
 */
export function meshLaunchArgs(meshId: string, name: string): string[] | undefined {
  const n = name.trim();
  if (!MESH_ID.test(meshId) || !CELL_NAME.test(n)) {
    return undefined;
  }
  return ["launch", "--ipc-proxy", "--mesh", meshId, "--as", n];
}

// ---- polling --------------------------------------------------------------------------------------

/**
 * Runs `tick` every `ms` while visible: once right away when the view becomes visible, then on the
 * interval; nothing while hidden. A tick still running is not started again.
 */
export class VisibilityPoller {
  private handle: unknown;
  private running = false;

  constructor(
    private readonly tick: () => Promise<unknown>,
    private readonly ms: number = POLL_MS,
    private readonly timers: Pick<Timers, "setInterval" | "clearInterval"> = realTimers,
  ) {}

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
