// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.5.0: the a4sx CLI's JSON contract (CLI 0.25.0) for cells, peers and launch profiles, the version gate
// for older CLIs, and the in-session guard. Pure Node, no vscode import, so it is unit-testable.
// Every value from the CLI is checked before it can reach a command line or the UI; a profile's header
// values never arrive here (the CLI sends header NAMES and env KEYS only), except the router operator.
import { CELL_NAME, CLI_MESH_ID, INSTANCE_ID, LocalCell, parseLocalCell, PROFILE_SOURCES, ROUTE_EFFORTS, ROUTE_MODEL, ROUTE_OPERATOR, showText } from "./cells";

// --- the in-session guard ---------------------------------------------------------------------------

/** The env the a4sx CLI sets for the programs it starts in a harness or mesh session. */
export const IN_SESSION_ENV = ["A4SX_HARNESS", "A4SX_MESH_SESSION"] as const;

/**
 * True when this VS Code (or its extension host) was started inside an a4sx session: there, the a4sx CLI
 * would act with the session's identity, not the user's, so the extension never runs it.
 */
export function insideMeshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return IN_SESSION_ENV.some((k) => env[k] === "1");
}

export const IN_SESSION_MESSAGE =
  "This VS Code runs inside an a4sx session, so the a4sx extension won't run the a4sx CLI here: it would act as that " +
  "session, not as you. Use a4sx from a VS Code window or terminal that you started yourself.";

// --- the version gate ---------------------------------------------------------------------------------

/** The first CLI with the JSON answers below (`mesh cells --json` v1, `mesh peers --json`, `profiles --json`). */
export const MIN_JSON_CLI = "0.25.0";
export const VERSION_ARGS: readonly string[] = ["--version"];

/** `a4sx --version`'s "a4sx 0.25.0  (server …)" as "0.25.0", or undefined. */
export function parseCliVersion(stdout: string): string | undefined {
  const m = /^\s*(?:a4sx|amdx|agent-mdx)\s+v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?![\d.])/m.exec(stdout);
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : undefined;
}

/** True when version `v` (x.y.z) is `min` or newer. */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) > (b[i] ?? 0);
    }
  }
  return true;
}

/** "ok": 0.25.0 or newer; "too-old": older; "unknown": no version line (offline, a wrapper): the answers' shape decides. */
export type CliGate = "ok" | "too-old" | "unknown";

export function cliGate(version: string | undefined): CliGate {
  if (!version) {
    return "unknown";
  }
  return versionAtLeast(version, MIN_JSON_CLI) ? "ok" : "too-old";
}

// --- errors -------------------------------------------------------------------------------------------

export interface CliJsonError {
  code: string;
  message: string;
}

/** `{"v":1,"error":{"code","message"}}` (with a non-zero exit), or undefined when stdout isn't that. */
export function parseCliError(stdout: string): CliJsonError | undefined {
  const raw = parseJson(stdout);
  if (!isObject(raw) || !isObject(raw.error)) {
    return undefined;
  }
  const code = typeof raw.error.code === "string" && /^[a-z0-9_.-]{1,64}$/i.test(raw.error.code) ? raw.error.code : "error";
  const message = showText(raw.error.message, 300);
  return message ? { code, message } : undefined;
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// --- `a4sx mesh cells --json` -------------------------------------------------------------------------

export const LOCAL_STATES = ["stored", "running"] as const;
export const REGISTRY_STATES = ["reserved", "active", "revoked", "unknown"] as const;
export const PATHS = ["same-host", "lan", "direct", "relay"] as const;
export const MESH_POLICIES = ["open", "own", "closed"] as const;
export type LocalState = (typeof LOCAL_STATES)[number];
export type RegistryState = (typeof REGISTRY_STATES)[number];
export type CellPath = (typeof PATHS)[number];
export type MeshPolicy = (typeof MESH_POLICIES)[number];

function oneOf<T extends string>(list: readonly T[], v: unknown): T | undefined {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** Tags as shown later (not yet in the UI): short one-line strings; anything else is dropped. */
export function parseTags(v: unknown): string[] {
  return Array.isArray(v) ? v.map((t) => showText(t, 40)).filter((t): t is string => !!t).slice(0, 32) : [];
}

export interface CellsAnswer {
  cells: LocalCell[];
  /** true: an older CLI's bare list (no running state, registry, path or peers). */
  legacy: boolean;
}

/**
 * `mesh cells --json`: CLI 0.25.0's `{"v":1,"default","cells":[…]}`, or an older CLI's bare list (legacy).
 * undefined when it is neither (or an error object).
 */
export function parseCellsAnswer(stdout: string): CellsAnswer | undefined {
  const raw = parseJson(stdout);
  if (Array.isArray(raw)) {
    return { cells: raw.map(parseLocalCell).filter((c): c is LocalCell => c !== undefined), legacy: true };
  }
  if (!isObject(raw) || raw.v !== 1 || !Array.isArray(raw.cells)) {
    return undefined;
  }
  const def = typeof raw.default === "string" && CELL_NAME.test(raw.default) ? raw.default : undefined;
  const cells: LocalCell[] = [];
  for (const row of raw.cells) {
    if (!isObject(row)) {
      continue;
    }
    // The v1 row is the legacy row plus the fields below; `profile` is the launch profile.
    const cell = parseLocalCell({ ...row, launch_profile: row.profile ?? row.launch_profile });
    if (!cell) {
      continue;
    }
    const local = isObject(row.local) ? row.local : {};
    const registry = isObject(row.registry) ? row.registry : {};
    cell.localState = oneOf(LOCAL_STATES, local.state) ?? "stored";
    if (cell.localState === "running" && typeof local.pid === "number" && Number.isInteger(local.pid) && local.pid > 0) {
      cell.pid = local.pid;
    }
    cell.registryState = oneOf(REGISTRY_STATES, registry.state) ?? "unknown";
    const p = oneOf(PATHS, row.path);
    if (p) {
      cell.path = p;
    }
    cell.meshPolicy = oneOf(MESH_POLICIES, row.mesh_policy) ?? null;
    cell.tags = parseTags(row.tags);
    // CLI 0.27.0 (additive): the profile's name and source, its X-Fleet-Operator and what the route serves
    const pname = showText(row.launch_profile);
    if (pname && cell.launchProfile) {
      cell.profileName = pname;
    }
    const src = oneOf(PROFILE_SOURCES, row.profile_source);
    if (src) {
      cell.profileSource = src;
    }
    if (typeof row.operator === "string" && ROUTE_OPERATOR.test(row.operator)) {
      cell.operator = row.operator;
    }
    if (typeof row.route_model === "string" && ROUTE_MODEL.test(row.route_model)) {
      cell.routeModel = row.route_model;
      const eff = oneOf(ROUTE_EFFORTS, row.route_effort);
      if (eff) {
        cell.routeEffort = eff;
      }
    }
    cells.push(cell);
  }
  // The default: the row's own flag, else the answer's name (only when one stored cell has it).
  if (def && !cells.some((c) => c.isDefault)) {
    const named = cells.filter((c) => c.name === def);
    if (named.length === 1) {
      named[0].isDefault = true;
    }
  }
  return { cells, legacy: false };
}

// --- `a4sx mesh peers <mesh> --json` ------------------------------------------------------------------

export interface RemoteCell {
  instanceId: string;
  name: string;
  /** In your own account (`own` means the caller's account, not this computer). */
  own: boolean;
  aid?: string;
  tier?: string;
  state?: string;
  tags: string[];
}

export function peersArgs(meshId: string): string[] | undefined {
  return CLI_MESH_ID.test(meshId) ? ["mesh", "peers", meshId, "--json"] : undefined;
}

/**
 * The mesh's cells in the answer, yours (`own: true`, the caller's account) and other people's, or undefined when
 * it isn't the v1 answer. The view drops those stored on this computer (by instance id); the rest run elsewhere.
 */
export function parsePeersAnswer(stdout: string, meshId: string): RemoteCell[] | undefined {
  const raw = parseJson(stdout);
  if (!isObject(raw) || raw.v !== 1 || !Array.isArray(raw.peers) || (raw.mesh_id !== undefined && raw.mesh_id !== meshId)) {
    return undefined;
  }
  const out: RemoteCell[] = [];
  for (const p of raw.peers) {
    if (!isObject(p) || typeof p.instance_id !== "string" || !INSTANCE_ID.test(p.instance_id)) {
      continue;
    }
    const name = showText(p.name, 48);
    if (!name) {
      continue;
    }
    const peer: RemoteCell = { instanceId: p.instance_id, name, own: p.own === true, tags: parseTags(p.tags) };
    const aid = showText(p.aid, 96);
    const tier = showText(p.tier, 24);
    const state = showText(p.state, 24);
    if (aid) {
      peer.aid = aid;
    }
    if (tier) {
      peer.tier = tier;
    }
    if (state) {
      peer.state = state;
    }
    out.push(peer);
  }
  return out;
}

// --- `a4sx profiles --json` ---------------------------------------------------------------------------

export const PROFILES_ARGS: readonly string[] = ["profiles", "--json"];
/** A launch profile id (api.ts PROFILE_ID). */
export const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** An X-Fleet-Operator value (the CLI's _HENV_FLEET_OP_RE). */
export const OPERATOR = /^[A-Za-z0-9][A-Za-z0-9._~+-]{0,127}$/;
export const OPERATOR_HEADER = "X-Fleet-Operator";
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface CliProfile {
  id: string;
  /** CLI 0.27.0+: the profile's display name (absent: show the id). */
  name?: string;
  harness?: string;
  model?: string;
  base_url?: string;
  operator?: string;
  headerNames: string[];
  /** As the CLI sent them; shown only through profilesView.shownFlags (credential values masked). */
  flags: string[];
  envKeys: string[];
  /** How many of your cells use it; undefined when the CLI doesn't know (null), never taken as 0. */
  usedByCells?: number;
}

export interface ProfilesAnswer {
  default?: string;
  profiles: CliProfile[];
}

export function parseProfilesAnswer(stdout: string): ProfilesAnswer | undefined {
  const raw = parseJson(stdout);
  if (!isObject(raw) || raw.v !== 1 || !Array.isArray(raw.profiles)) {
    return undefined;
  }
  const profiles: CliProfile[] = [];
  for (const p of raw.profiles) {
    if (!isObject(p) || typeof p.id !== "string" || !PROFILE_ID.test(p.id)) {
      continue;
    }
    const strings = (v: unknown, re: RegExp) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && re.test(x)) : []);
    const prof: CliProfile = {
      id: p.id,
      headerNames: strings(p.header_names, HEADER_NAME),
      flags: Array.isArray(p.flags) ? p.flags.filter((f): f is string => typeof f === "string" && f.length <= 512) : [],
      envKeys: strings(p.env_keys, ENV_KEY),
    };
    if (typeof p.used_by_cells === "number" && Number.isInteger(p.used_by_cells) && p.used_by_cells >= 0) {
      prof.usedByCells = p.used_by_cells;
    }
    for (const k of ["harness", "model", "base_url"] as const) {
      const v = showText(p[k], 200);
      if (v) {
        prof[k] = v;
      }
    }
    if (typeof p.operator === "string" && OPERATOR.test(p.operator)) {
      prof.operator = p.operator;
    }
    const name = showText(p.name);
    if (name) {
      prof.name = name;
    }
    profiles.push(prof);
  }
  const def = typeof raw.default === "string" && profiles.some((p) => p.id === raw.default) ? raw.default : undefined;
  return { ...(def ? { default: def } : {}), profiles };
}

/** `profile --copy SRC --name DST [--header X-Fleet-Operator=OP] [--force]`; undefined for a bad id or operator. */
export function profileCopyArgs(src: string, dst: string, operator?: string, force = false): string[] | undefined {
  if (!PROFILE_ID.test(src) || !PROFILE_ID.test(dst) || (operator !== undefined && !OPERATOR.test(operator))) {
    return undefined;
  }
  return ["profile", "--copy", src, "--name", dst, ...(operator ? ["--header", `${OPERATOR_HEADER}=${operator}`] : []), ...(force ? ["--force"] : [])];
}

export function profileSetDefaultArgs(id: string): string[] | undefined {
  return PROFILE_ID.test(id) ? ["profile", "--set-default", id] : undefined;
}

export function profileDeleteArgs(id: string): string[] | undefined {
  return PROFILE_ID.test(id) ? ["profile", "--delete", id] : undefined;
}

// --- `a4sx config show` -------------------------------------------------------------------------------

export const CONFIG_SHOW_ARGS: readonly string[] = ["config", "show"];

/** Whether the CLI's config turns on `ipc.auto_allow_messages`; undefined when the answer isn't the config. */
export function configAutoAllow(stdout: string): boolean | undefined {
  const raw = parseJson(stdout);
  if (!isObject(raw)) {
    return undefined;
  }
  return isObject(raw.ipc) && raw.ipc.auto_allow_messages === true;
}
