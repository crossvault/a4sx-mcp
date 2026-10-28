// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.3.0: session folders and the filter, the Launch profiles view, the profile pick on resume, and the
// step-up sign-in. The server is faked; old-server answers are faked too (no `folder` key, 400
// bad_scopes at sign-in, 401/403/404 on the profile routes).
import * as assert from "assert";
import { calls, fakeMemento, fakeSecrets, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import * as api from "../../api";
import { deviceLogin, LoginCancelled, LoginRequest, SECRET_KEY, STEP_UP_TITLE } from "../../auth";
import {
  buildFolderTree, FILTER_MESSAGE, FolderItem, matchesFilter, NO_MATCH, normalizeFolder, SessionItem,
} from "../../sessionsView";
import { FOLDER_TEXTS } from "../../folderCommands";
import { ALLOW_SCOPE_ITEM, displayAddress, HIDDEN_FIELDS, NO_PROFILES, ProfileItem } from "../../profilesView";
import { fieldBody, PROFILE_TEXTS, validateField, validateProfileId } from "../../profileCommands";
import { offerStepUp, STEP_UP, STEP_UP_SCOPES } from "../../stepUp";
import type { CliLookup } from "../../cli";

const TOKEN = "lib_tok_OLD_secret_111";
const NEW_TOKEN = "lib_tok_NEW_secret_222";
const BASE = "https://session-exchange.com";
const ALL = ["library:read", "profiles:read", "library:organize"];

interface Req { url: string; method: string; headers: Record<string, string>; body?: any }
type Answer = { status: number; body?: unknown } | Error;

function fakeFetch(routes: Record<string, Answer[]>) {
  const seen: Req[] = [];
  const fetch: api.FetchLike = async (url, init) => {
    const u = new URL(url);
    seen.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined });
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    const queue = routes[key];
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected request ${key}`);
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
const stored = (scopes: string[], token = TOKEN) => JSON.stringify({ token, server: BASE, id: "tok_1", scopes });
const scopeRefusal = (need: string | null) => ({ status: 403, body: { error: { code: "insufficient_scope", message: "x", details: { token_valid: true, required_scope: need } } } });

const savedRuntime = { ...ext.runtime };
afterEach(() => Object.assign(ext.runtime, savedRuntime));

/** Activates with a fake network and a stored key holding `scopes`; `logins` records step-up requests. */
async function activateWith(routes: Record<string, Answer[]>, scopes: string[] | null = ALL) {
  const net = fakeFetch(routes);
  ext.runtime.fetch = net.fetch;
  const logins: LoginRequest[] = [];
  ext.runtime.login = async (_c, req) => {
    logins.push(req);
    return { token: NEW_TOKEN, server: BASE, id: "tok_2", scopes: [...req.scopes] };
  };
  const ctx = { subscriptions: [] as { dispose(): unknown }[], secrets: fakeSecrets(), globalState: fakeMemento() };
  ext.activate(ctx as any);
  if (scopes) {
    await ctx.secrets.store(SECRET_KEY, stored(scopes));
  }
  return { ctx, net, logins, sb: ext.sidebar! };
}

const storedKey = (ctx: { secrets: { store_: Map<string, string> } }) => JSON.parse(ctx.secrets.store_.get(SECRET_KEY) ?? "null");
const bearer = (r: Req) => r.headers.Authorization;
const isMeta = (r: Req) => r.method === "POST" && new URL(r.url).pathname.endsWith("/meta");
const isRevoke = (r: Req) => r.method === "POST" && new URL(r.url).pathname === "/library/keys/self/revoke";
const REVOKED = { status: 200, body: { id: "tok_1", status: "revoked" } };

function noTokenAnywhere(): void {
  const shown = [...calls.errors.map((e) => e.message), ...calls.infos, ...calls.warnings, ...calls.modals.map((m) => m.message),
    ...calls.progress.flatMap((p) => p.messages), ...[...calls.treeViews.values()].map((v) => v.message ?? "")];
  for (const m of shown) {
    assert.ok(!m.includes(TOKEN) && !m.includes(NEW_TOKEN), `token leaked into a message: ${m}`);
  }
}

const rows = [
  { id: "c-1", title: "Fix login", updated_at: "2026-10-20T10:00:00Z", folder: "work/a4sx", tags: ["auth"] },
  { id: "c-2", title: "Refactor router", updated_at: "2026-10-21T10:00:00Z", folder: "work/a4sx" },
  { id: "c-3", title: "Taxes", label: "tax-2026", updated_at: "2026-10-01T10:00:00Z", folder: "home" },
  { id: "c-4", title: "Old notes", updated_at: "2026-09-01T10:00:00Z", folder: "work" },
  { id: "c-5", title: "Unfiled one", updated_at: "2026-10-22T10:00:00Z", folder: null },
  { id: "c-6", title: "Unfiled two", updated_at: "2026-10-02T10:00:00Z", folder: null, tags: ["Deploy"] },
];

describe("folder tree", () => {
  beforeEach(resetCalls);

  it("nests folders by segment (sorted), sessions newest first, unfiled ones at the top level", () => {
    const root = buildFolderTree(rows);
    assert.deepStrictEqual(root.folders.map((f) => f.name), ["home", "work"]);
    assert.deepStrictEqual(root.sessions.map((r) => r.id), ["c-5", "c-6"]);
    const work = root.folders[1];
    assert.deepStrictEqual(work.sessions.map((r) => r.id), ["c-4"]);
    assert.deepStrictEqual(work.folders.map((f) => [f.name, f.path]), [["a4sx", "work/a4sx"]]);
    assert.deepStrictEqual(work.folders[0].sessions.map((r) => r.id), ["c-2", "c-1"]);
  });

  it("folder paths compare case-sensitively; odd values are unfiled", () => {
    const root = buildFolderTree([
      { id: "a", folder: "Work" }, { id: "b", folder: "work" }, { id: "c", folder: 7 as any }, { id: "d", folder: " / " }, { id: "e" },
    ]);
    assert.deepStrictEqual(root.folders.map((f) => f.name), ["Work", "work"]);
    assert.deepStrictEqual(root.sessions.map((r) => r.id).sort(), ["c", "d", "e"]);
  });

  it("the view shows folders first (collapsed, with a count), then unfiled sessions; a folder expands to its contents", async () => {
    const { sb } = await activateWith({ "GET /library/sessions": [{ status: 200, body: { sessions: rows } }] });
    const top = await sb.sessions.getChildren();
    assert.deepStrictEqual(top.map((i) => i.label), ["home", "work", "Unfiled one", "Unfiled two"]);
    const work = top[1] as FolderItem;
    assert.strictEqual(work.collapsibleState, 1);
    assert.strictEqual(work.description, "3");
    assert.strictEqual(work.contextValue, "a4sx.folder");
    const inside = await sb.sessions.getChildren(work);
    assert.deepStrictEqual(inside.map((i) => i.label), ["a4sx", "Old notes"]);
    const deeper = (await sb.sessions.getChildren(inside[0])) as SessionItem[];
    assert.deepStrictEqual(deeper.map((i) => [i.label, i.contextValue]), [["Refactor router", "a4sx.session.filed"], ["Fix login", "a4sx.session.filed"]]);
    assert.ok(!String(deeper[0].description).includes("work/a4sx"), "in the tree, the folder is not repeated in the description");
    assert.strictEqual((top[2] as SessionItem).contextValue, "a4sx.session");
    assert.strictEqual(calls.context["a4sx.foldersSupported"], true);
  });

  it("an older server (no `folder` key on rows): everything is unfiled and the folder actions are hidden", async () => {
    const old = rows.map(({ folder: _f, ...r }) => r);
    const { sb, net } = await activateWith({ "GET /library/sessions": [{ status: 200, body: { sessions: old } }] });
    const top = await sb.sessions.getChildren();
    assert.ok(top.every((i) => i instanceof SessionItem && i.contextValue === "a4sx.session"));
    assert.strictEqual(top.length, rows.length);
    assert.strictEqual(calls.context["a4sx.foldersSupported"], false);
    await calls.commands.get(ext.CMD_MOVE_TO_FOLDER)!(top[0]);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [api.MESSAGES.foldersNotSupported]);
    assert.strictEqual(net.seen.filter(isMeta).length, 0);
  });

  it("folder names follow the server's rule", () => {
    assert.strictEqual(normalizeFolder(" work / a4sx "), "work/a4sx");
    assert.strictEqual(normalizeFolder("a/b/c/d"), "a/b/c/d");
    for (const bad of ["", "/work", "work/", "a/b/c/d/e", "a//b", "..", "a/./b", "x".repeat(41), "naïve", "a:b", `${"x".repeat(40)}/${"y".repeat(40)}/${"z".repeat(40)}`]) {
      assert.strictEqual(normalizeFolder(bad), undefined, bad);
    }
  });
});

describe("session filter", () => {
  beforeEach(resetCalls);

  it("matches title, label, id, tags and folder, case-insensitively", () => {
    const [c1, , c3, , , c6] = rows;
    assert.ok(matchesFilter(c1, "FIX"));
    assert.ok(matchesFilter(c3, "Tax-2026"));
    assert.ok(matchesFilter(c3, "C-3"));
    assert.ok(matchesFilter(c6, "deploy"));
    assert.ok(matchesFilter(c1, "WORK/A4"));
    assert.ok(!matchesFilter(c6, "work"));
    assert.ok(matchesFilter(c6, "  "));
  });

  it("shows matches flat (newest first) with the folder in the description, and the filter in the view message", async () => {
    const { sb, net } = await activateWith({ "GET /library/sessions": [{ status: 200, body: { sessions: rows } }] });
    await sb.sessions.getChildren();
    calls.nextInput = "WORK";
    await calls.commands.get(ext.CMD_FILTER)!();
    assert.strictEqual(calls.inputs[0].title, FOLDER_TEXTS.filterTitle);
    assert.strictEqual(calls.context["a4sx.sessionsFiltered"], true);
    const items = (await sb.sessions.getChildren()) as SessionItem[];
    assert.deepStrictEqual(items.map((i) => i.label), ["Refactor router", "Fix login", "Old notes"]);
    assert.ok(items.every((i) => i instanceof SessionItem));
    assert.ok(String(items[0].description).startsWith("work/a4sx · 2026-10-21"));
    assert.ok(String(items[2].description).startsWith("work · "));
    assert.strictEqual(calls.treeViews.get(ext.VIEW_SESSIONS)!.message, FILTER_MESSAGE("WORK", 3, 6));
    assert.strictEqual(net.seen.length, 1, "a filter change reuses the list");
  });

  it("no match is one item that clears the filter; Clear filter brings the tree back; Esc keeps the filter", async () => {
    const { sb } = await activateWith({ "GET /library/sessions": [{ status: 200, body: { sessions: rows } }] });
    sb.sessions.setFilter("zzz");
    const none = await sb.sessions.getChildren();
    assert.deepStrictEqual(none.map((i) => i.label), [NO_MATCH("zzz")]);
    assert.strictEqual(none[0].command!.command, ext.CMD_CLEAR_FILTER);
    calls.nextInput = undefined;
    await calls.commands.get(ext.CMD_FILTER)!();
    assert.strictEqual(sb.sessions.filter, "zzz");
    await calls.commands.get(ext.CMD_CLEAR_FILTER)!();
    assert.strictEqual(sb.sessions.filter, undefined);
    assert.strictEqual(calls.context["a4sx.sessionsFiltered"], false);
    assert.strictEqual(calls.treeViews.get(ext.VIEW_SESSIONS)!.message, undefined);
    assert.deepStrictEqual((await sb.sessions.getChildren()).map((i) => i.label), ["home", "work", "Unfiled one", "Unfiled two"]);
    calls.nextInput = "";
    sb.sessions.setFilter("x");
    await calls.commands.get(ext.CMD_FILTER)!();
    assert.strictEqual(sb.sessions.filter, undefined, "an empty filter clears it");
  });
});

describe("Move to folder / Remove from folder", () => {
  beforeEach(resetCalls);

  const sessionsRoute = { "GET /library/sessions": [{ status: 200, body: { sessions: rows } }] as Answer[] };

  it("picks an existing folder, posts it with the current key, refreshes", async () => {
    const { sb, net } = await activateWith({ ...sessionsRoute, "POST /library/session/c-5/meta": [{ status: 200, body: { id: "c-5" } }] });
    const top = await sb.sessions.getChildren();
    calls.nextPick = 1;   // ["home", "work", "work/a4sx", "New folder…"]
    await calls.commands.get(ext.CMD_MOVE_TO_FOLDER)!(top[2]);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.label), ["home", "work", "work/a4sx", FOLDER_TEXTS.newFolder]);
    const post = net.seen.find(isMeta)!;
    assert.deepStrictEqual(post.body, { folder: "work" });
    assert.strictEqual(bearer(post), `Bearer ${TOKEN}`);
    assert.strictEqual(sb.sessions.rows, undefined, "the list is fetched again");
    assert.strictEqual(calls.modals.length, 0, "the key already holds library:organize");
  });

  it("a new folder is typed and validated; Remove from folder posts folder: null", async () => {
    const { sb, net } = await activateWith({ ...sessionsRoute, "POST /library/session/c-1/meta": [{ status: 200, body: {} }] });
    await sb.sessions.getChildren();
    const filed = new SessionItem(rows[0]);
    calls.nextPick = 2;   // "New folder…" (work/a4sx is the current folder, so it isn't offered)
    calls.nextInput = " clients / acme ";
    await calls.commands.get(ext.CMD_MOVE_TO_FOLDER)!(filed);
    assert.strictEqual(calls.inputs[0].value, "work/a4sx");
    assert.strictEqual(calls.inputs[0].validateInput("a//b"), FOLDER_TEXTS.folderInvalid);
    assert.strictEqual(calls.inputs[0].validateInput("ok/fine"), null);
    await sb.sessions.getChildren();
    await calls.commands.get(ext.CMD_REMOVE_FROM_FOLDER)!(filed);
    assert.deepStrictEqual(net.seen.filter(isMeta).map((r) => r.body), [{ folder: "clients/acme" }, { folder: null }]);
  });

  it("without library:organize: a modal names the permission, the new sign-in asks for it, the new key replaces the old", async () => {
    const { sb, net, ctx, logins } = await activateWith({ ...sessionsRoute, "POST /library/session/c-5/meta": [{ status: 200, body: {} }] }, ["library:read", "profiles:read"]);
    const top = await sb.sessions.getChildren();
    assert.strictEqual(bearer(net.seen[0]), `Bearer ${TOKEN}`, "the old key works until the new one arrives");
    calls.modalChoices.push(STEP_UP.signIn);
    calls.nextPick = 0;
    await calls.commands.get(ext.CMD_MOVE_TO_FOLDER)!(top[2]);
    assert.deepStrictEqual(calls.modals.map((m) => [m.message, m.items]), [[STEP_UP.prompt("library:organize"), [STEP_UP.signIn]]]);
    assert.ok(calls.modals[0].message.includes("library:organize"));
    assert.deepStrictEqual(logins, [{ scopes: ["library:read", "profiles:read", "library:organize"], fallback: false, adding: "library:organize" }]);
    assert.strictEqual(storedKey(ctx).token, NEW_TOKEN);
    const post = net.seen.find(isMeta)!;
    assert.strictEqual(bearer(post), `Bearer ${NEW_TOKEN}`);
    noTokenAnywhere();
  });

  it("declining the new sign-in changes nothing and keeps the old key", async () => {
    const { sb, net, ctx, logins } = await activateWith(sessionsRoute, ["library:read"]);
    const top = await sb.sessions.getChildren();
    calls.modalChoices.push(undefined);
    await calls.commands.get(ext.CMD_MOVE_TO_FOLDER)!(top[2]);
    assert.strictEqual(logins.length, 0);
    assert.strictEqual(storedKey(ctx).token, TOKEN);
    assert.strictEqual(net.seen.filter(isMeta).length, 0);
    assert.strictEqual(calls.quickPicks.length, 0);
  });

  it("a 403 naming required_scope offers the new sign-in, then the move is sent once more with the new key", async () => {
    const { sb, net } = await activateWith({ ...sessionsRoute, "POST /library/session/c-5/meta": [scopeRefusal("library:organize"), { status: 200, body: {} }] });
    const top = await sb.sessions.getChildren();
    calls.nextPick = 0;
    calls.modalChoices.push(STEP_UP.signIn);
    await calls.commands.get(ext.CMD_MOVE_TO_FOLDER)!(top[2]);
    const posts = net.seen.filter(isMeta);
    assert.deepStrictEqual(posts.map(bearer), [`Bearer ${TOKEN}`, `Bearer ${NEW_TOKEN}`]);
    assert.strictEqual(calls.errors.length, 0);
  });

  it("a server without the scope (400 bad_scopes on the new sign-in) says folders need a newer server; the old key stays", async () => {
    const { sb, ctx } = await activateWith(sessionsRoute, ["library:read"]);
    ext.runtime.login = async () => { throw new api.ApiError("bad-scopes", api.MESSAGES.badResponse, 400); };
    const top = await sb.sessions.getChildren();
    calls.modalChoices.push(STEP_UP.signIn);
    await calls.commands.get(ext.CMD_MOVE_TO_FOLDER)!(top[2]);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [api.MESSAGES.foldersNotSupported]);
    assert.strictEqual(storedKey(ctx).token, TOKEN);
  });

  it("a server that refuses the meta route for keys says folders need a newer server; a bad name is a short error", async () => {
    const { sb } = await activateWith({ ...sessionsRoute, "POST /library/session/c-5/meta": [scopeRefusal(null), { status: 400, body: { error: { code: "bad_folder" } } }] });
    const top = await sb.sessions.getChildren();
    calls.nextPick = 0;
    await calls.commands.get(ext.CMD_MOVE_TO_FOLDER)!(top[2]);
    await sb.sessions.getChildren();
    calls.nextPick = 0;
    await calls.commands.get(ext.CMD_MOVE_TO_FOLDER)!(top[2]);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [api.MESSAGES.foldersNotSupported, api.MESSAGES.folderRejected]);
  });
});

describe("sign-in scopes and older servers", () => {
  beforeEach(resetCalls);

  const start = { status: 200, body: { code: "PAIR", user_code: "ABCD-EFGH", login_url: `${BASE}/auth/cli/choose?code=PAIR`, expires_in: 600 } };
  const hooks = () => {
    let t = 0;
    return { open: async () => undefined, report: () => undefined, cancelled: () => false, sleep: async (ms: number) => { t += ms; }, now: () => t };
  };

  it("a server that rejects the newer scopes (400 bad_scopes) gets a sign-in for library:read only", async () => {
    const net = fakeFetch({
      "POST /auth/cli/start": [{ status: 400, body: { error: { code: "bad_scopes", details: { allowed: ["library:read"] } } } }, start],
      "GET /auth/cli/poll": [{ status: 200, body: { status: "ok", token: TOKEN, token_id: "t" } }],
    });
    const got = await deviceLogin(clientWith(net.fetch), hooks());
    assert.deepStrictEqual(net.seen.filter((r) => r.method === "POST").map((r) => r.body.scopes), [ALL, ["library:read"]]);
    assert.deepStrictEqual(got.scopes, ["library:read"], "no scopes in the answer: the ones asked for");
  });

  it("a step-up sign-in never falls back; its progress title names the permission", async () => {
    const net = fakeFetch({ "POST /auth/cli/start": [{ status: 400, body: { error: { code: "bad_scopes" } } }] });
    await assert.rejects(deviceLogin(clientWith(net.fetch), hooks(), { scopes: [...ALL, "profiles:write"], fallback: false, adding: "profiles:write" }),
      (e: any) => e.code === "bad-scopes");
    assert.strictEqual(net.seen.length, 1);
    const ok = fakeFetch({ "POST /auth/cli/start": [start], "GET /auth/cli/poll": [{ status: 200, body: { status: "ok", token: NEW_TOKEN, scopes: [...ALL, "profiles:write"] } }] });
    const { vscodeLogin, timing } = await import("../../auth");
    const saved = timing.pollMs;
    timing.pollMs = 1;
    const got = await vscodeLogin(clientWith(ok.fetch), { scopes: [...ALL, "profiles:write"], fallback: false, adding: "profiles:write" }).finally(() => { timing.pollMs = saved; });
    assert.strictEqual(calls.progress[0].title, STEP_UP_TITLE("profiles:write"));
    assert.deepStrictEqual(got.scopes, [...ALL, "profiles:write"]);
  });

  it("with a library:read-only key on an older server, Launch profiles shows one short note and no actions", async () => {
    for (const answer of [scopeRefusal(null), { status: 401, body: { error: { code: "not_logged_in" } } }, { status: 404, body: { error: { code: "not_found" } } }]) {
      resetCalls();
      const { sb } = await activateWith({ "GET /library/profiles": [answer] }, ["library:read"]);
      const items = await sb.profiles.getChildren();
      assert.deepStrictEqual(items.map((i) => i.label), [api.MESSAGES.profilesNotSupported]);
      assert.strictEqual(items[0].command, undefined);
      assert.strictEqual(sb.profiles.state, "unsupported");
      assert.strictEqual(calls.context["a4sx.profilesAvailable"], false);
    }
  });

  it("a 0.2.x key (library:read) on a newer server: the 403 names profiles:read, and the item asks for it", async () => {
    const { sb, ctx, logins } = await activateWith({
      "GET /library/profiles": [scopeRefusal("profiles:read"), { status: 200, body: { profiles: {}, default: null } }],
    }, ["library:read"]);
    const items = await sb.profiles.getChildren();
    assert.deepStrictEqual(items.map((i) => i.label), [ALLOW_SCOPE_ITEM("profiles:read")]);
    await calls.commands.get(items[0].command!.command)!(...items[0].command!.arguments!);
    assert.strictEqual(calls.modals.length, 0, "the item already names the permission");
    assert.deepStrictEqual(logins.map((l) => l.adding), ["profiles:read"]);
    assert.strictEqual(storedKey(ctx).token, NEW_TOKEN);
    assert.deepStrictEqual((await sb.profiles.getChildren()).map((i) => i.label), [NO_PROFILES]);
    assert.strictEqual(calls.context["a4sx.profilesAvailable"], true);
  });

  it("sign-out still removes the key after a step-up", async () => {
    const { ctx, sb } = await activateWith({ "GET /library/profiles": [scopeRefusal("profiles:read")] }, ["library:read"]);
    await sb.auth.stepUp("profiles:read");
    assert.strictEqual(storedKey(ctx).token, NEW_TOKEN);
    await calls.commands.get(ext.CMD_SIGN_OUT)!();
    assert.strictEqual(ctx.secrets.store_.size, 0);
    assert.deepStrictEqual(calls.infos, [ext.SIGNED_OUT_INFO]);
    assert.deepStrictEqual(await sb.profiles.getChildren(), []);
    assert.strictEqual(sb.profiles.state, "signed-out");
  });
});

const profiles = {
  profiles: {
    work: { name: "Work", model: "model-a", base_url: "https://proxy.example.com", harness: "claude-code", flags: ["--verbose"], headers: { "X-Team": "blue" } },
    home: { model: "model-b" },
    lab: { name: "Lab", base_url: "http://localhost:8080" },
  },
  default: "home",
};

describe("Launch profiles view", () => {
  beforeEach(resetCalls);

  it("lists the default first, marked; never shows headers; signed out shows nothing and asks nothing", async () => {
    const { sb, net } = await activateWith({ "GET /library/profiles": [{ status: 200, body: profiles }] });
    const items = (await sb.profiles.getChildren()) as ProfileItem[];
    assert.deepStrictEqual(items.map((i) => [i.label, i.description, i.contextValue]), [
      ["home", "default · model-b", "a4sx.profile.default"],
      ["Lab", "http://localhost:8080", "a4sx.profile.locked"],
      ["Work", "model-a · https://proxy.example.com", "a4sx.profile.locked"],
    ]);
    assert.ok(!JSON.stringify(items.map((i) => [i.label, i.description, i.tooltip])).includes("blue"), "header values are not shown");
    assert.strictEqual(bearer(net.seen[0]), `Bearer ${TOKEN}`);
    assert.strictEqual(calls.context["a4sx.profilesAvailable"], true);
    const out = await activateWith({}, null);
    assert.deepStrictEqual(await out.sb.profiles.getChildren(), []);
    assert.strictEqual(out.net.seen.length, 0);
  });

  it("addresses are shown without user name, password or query", () => {
    assert.strictEqual(displayAddress("https://u:p@proxy.example.com/v1?key=1#x"), "https://proxy.example.com");
    assert.strictEqual(displayAddress("http://localhost:8080/anthropic"), "http://localhost:8080", "scheme://host[:port] only");
    assert.strictEqual(displayAddress("https://proxy.example.com/"), "https://proxy.example.com");
    assert.strictEqual(displayAddress(""), undefined);
  });
});

describe("Launch profile actions", () => {
  beforeEach(resetCalls);

  const listed = { "GET /library/profiles": [{ status: 200, body: profiles }] as Answer[] };
  const after = (over: object) => ({ status: 200, body: { ...profiles, ...over } });

  async function itemsOf(sb: ext.Sidebar) {
    const items = (await sb.profiles.getChildren()) as ProfileItem[];
    return Object.fromEntries(items.map((i) => [i.id, i]));
  }

  it("the first edit asks for profiles:write with a new sign-in naming it, then sends only the changed field with the new key", async () => {
    const { sb, net, logins, ctx } = await activateWith({ ...listed, "PUT /library/profiles/work": [after({})] });
    const work = (await itemsOf(sb)).work;
    calls.modalChoices.push(STEP_UP.signIn);
    calls.nextPick = 1;          // Model
    calls.nextInput = "model-c";
    await calls.commands.get(ext.CMD_EDIT_PROFILE)!(work);
    assert.deepStrictEqual(calls.modals.map((m) => m.message), [STEP_UP.prompt("profiles:write")]);
    assert.deepStrictEqual(logins, [{ scopes: [...ALL, "profiles:write"], fallback: false, adding: "profiles:write" }]);
    assert.strictEqual(storedKey(ctx).token, NEW_TOKEN);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => [i.label, i.description]), [
      ["Name", "Work"], ["Model", "model-a"], ["Flags", "--verbose"],
      ["Server address", "https://proxy.example.com"], ["Harness", "claude-code"], ["Router", "not set"], ["Headers", "1 header"],
    ]);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.detail),
      [undefined, undefined, ...Array(5).fill(PROFILE_TEXTS.readOnlyHere)], "only name and model are editable");
    assert.ok(!JSON.stringify(calls.quickPicks[0].items).includes("blue"), "header values are never shown");
    const put = net.seen.find((r) => r.method === "PUT")!;
    assert.strictEqual(bearer(put), `Bearer ${NEW_TOKEN}`);
    assert.deepStrictEqual(put.body, { model: "model-c" }, "only the changed field: the server keeps the rest as it is");
    assert.ok(!JSON.stringify(put.body).match(/api[-_]?key|authorization/i));
    noTokenAnywhere();
  });

  it("ids, names and models follow the server's rules; an empty name shows the id, an empty model is the CLI's default", () => {
    assert.strictEqual(validateProfileId("work-2"), undefined);
    assert.strictEqual(validateProfileId("Work"), PROFILE_TEXTS.idInvalid);
    assert.strictEqual(validateProfileId("-x"), PROFILE_TEXTS.idInvalid);
    assert.strictEqual(validateProfileId("home", ["home"]), PROFILE_TEXTS.idTaken);
    for (const ok of ["Work (EU)", "a.b_c-d", "x".repeat(64), ""]) {
      assert.strictEqual(validateField("name", ok), undefined, ok);
    }
    for (const bad of ["x".repeat(65), "naïve", "a/b", "a:b"]) {
      assert.strictEqual(validateField("name", bad), PROFILE_TEXTS.nameInvalid, bad);
    }
    for (const ok of ["claude-opus-4", "gpt-5.1", "org/model:tag", "m[1m]", ""]) {
      assert.strictEqual(validateField("model", ok), undefined, ok);
    }
    for (const bad of ["-m", "a b", "x".repeat(65), "sk ant"]) {
      assert.strictEqual(validateField("model", bad), PROFILE_TEXTS.modelInvalid, bad);
    }
    assert.deepStrictEqual(fieldBody("name", "  "), {}, "an empty name is left out, never sent as the id");
    assert.deepStrictEqual(fieldBody("name", " Work "), { name: "Work" });
    assert.deepStrictEqual(fieldBody("model", ""), { model: "" });
  });

  it("the default is changed only elsewhere: the button offers the CLI or the website, and nothing is sent", async () => {
    const { sb, net } = await activateWith(listed, [...ALL, "profiles:write"]);
    const { work, home } = await itemsOf(sb);
    const fake = require("vscode");
    const savedInfo = fake.window.showInformationMessage;
    const asked: string[] = [];
    fake.window.showInformationMessage = async (message: string, ...items: string[]) => { asked.push(`${message}|${items.join(",")}`); return undefined; };
    try {
      await calls.commands.get(ext.CMD_CHANGE_DEFAULT)!(work);
      await calls.commands.get(ext.CMD_CHANGE_DEFAULT)!(home);
    } finally {
      fake.window.showInformationMessage = savedInfo;
    }
    assert.deepStrictEqual(asked, Array(2).fill(`${PROFILE_TEXTS.readOnly}|${PROFILE_TEXTS.runCli},${PROFILE_TEXTS.openWebsite}`));
    assert.strictEqual(home.description!.toString().startsWith("default"), true, "the default mark stays, read-only");
    assert.strictEqual(net.seen.filter((r) => r.method !== "GET").length, 0);
    assert.strictEqual(calls.modals.length, 0);
    const pkg = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "..", "..", "package.json"), "utf8"));
    assert.ok(!pkg.contributes.commands.some((c: any) => c.command === "a4sx.setDefaultProfile"), "no Set as default");
    assert.strictEqual(pkg.contributes.commands.find((c: any) => c.command === ext.CMD_CHANGE_DEFAULT).title, "Change default with the a4sx CLI or on the website");
  });

  it("Delete is offered only for a profile with nothing but a name and/or a model; anything else is deleted only elsewhere", async () => {
    const lockedBody = { profiles: {
      ...profiles.profiles,
      secret: { name: "Secret", hidden_fields: 2 },
      plain: { name: "Plain", model: "m", flags: [], hidden_fields: 0 },
      bare: {},
      router: { name: "R", use_router: false },
      hdr: { name: "H", headers: { "X-A": "1" } },
    }, default: "home" };
    const { sb, net } = await activateWith({
      "GET /library/profiles": [{ status: 200, body: lockedBody }],
      "DELETE /library/profiles/plain": [after({})],
    }, [...ALL, "profiles:write"]);
    const items = (await sb.profiles.getChildren()) as ProfileItem[];
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    const ctx = (id: string) => by[id].contextValue;
    assert.deepStrictEqual(["home", "secret", "lab", "work", "router", "hdr", "plain", "bare"].map(ctx), [
      "a4sx.profile.default", "a4sx.profile.locked", "a4sx.profile.locked", "a4sx.profile.locked", "a4sx.profile.locked", "a4sx.profile.locked",
      "a4sx.profile", "a4sx.profile",
    ], "the default, hidden settings, an address, flags, a router setting or headers: no Delete");
    for (const id of ["home", "secret", "lab", "work", "router", "hdr"]) {
      assert.ok(String(by[id].tooltip).endsWith(PROFILE_TEXTS.deleteElsewhere), id);
    }
    assert.ok(!String(by.plain.tooltip).includes(PROFILE_TEXTS.deleteElsewhere));
    assert.strictEqual(PROFILE_TEXTS.deleteElsewhere, "Delete it with the a4sx CLI or on the website.");
    const fake = require("vscode");
    const savedInfo = fake.window.showInformationMessage;
    const asked: string[] = [];
    fake.window.showInformationMessage = async (message: string, ...buttons: string[]) => { asked.push(`${message}|${buttons.join(",")}`); return undefined; };
    try {
      calls.modalChoices.push(undefined, PROFILE_TEXTS.delete);
      await calls.commands.get(ext.CMD_DELETE_PROFILE)!(by.plain);
      await calls.commands.get(ext.CMD_DELETE_PROFILE)!(by.plain);
      await calls.commands.get(ext.CMD_DELETE_PROFILE)!(by.home);
      await calls.commands.get(ext.CMD_DELETE_PROFILE)!(by.secret);
      await calls.commands.get(ext.CMD_DELETE_PROFILE)!(by.lab);
    } finally {
      fake.window.showInformationMessage = savedInfo;
    }
    assert.deepStrictEqual(calls.modals.map((m) => m.message), [PROFILE_TEXTS.confirmDelete("Plain"), PROFILE_TEXTS.confirmDelete("Plain")]);
    assert.deepStrictEqual(asked, Array(3).fill(`${PROFILE_TEXTS.deleteElsewhere}|${PROFILE_TEXTS.runCli},${PROFILE_TEXTS.openWebsite}`));
    assert.deepStrictEqual(net.seen.filter((r) => r.method === "DELETE").map((r) => new URL(r.url).pathname), ["/library/profiles/plain"]);
    const pkg = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "..", "..", "package.json"), "utf8"));
    const del = pkg.contributes.menus["view/item/context"].filter((m: any) => m.command === ext.CMD_DELETE_PROFILE);
    assert.deepStrictEqual(del.map((m: any) => m.when), ["view == a4sx.profiles && viewItem == a4sx.profile"], "the menu hides Delete for the default and locked profiles");
  });
  it("Create asks for id, name and model only, with no default modal (there is no set-default for keys)", async () => {
    const { sb, net } = await activateWith({
      "GET /library/profiles": [{ status: 200, body: { profiles: {}, default: null } }],
      "PUT /library/profiles/work": [{ status: 200, body: { profiles: { work: { model: "m" } }, default: "work" } }],
    }, [...ALL, "profiles:write"]);
    await sb.profiles.getChildren();
    calls.inputQueue.push("work", "", "m");
    await calls.commands.get(ext.CMD_CREATE_PROFILE)!();
    assert.strictEqual(calls.inputs.length, 3, "id, name, model: no address or flags box");
    assert.strictEqual(calls.inputs[0].validateInput("Bad Id"), PROFILE_TEXTS.idInvalid);
    assert.strictEqual(calls.modals.length, 0, "no default modal, even for the first profile");
    assert.ok(!("makeDefault" in PROFILE_TEXTS) && !("confirmDefault" in PROFILE_TEXTS));
    assert.deepStrictEqual(net.seen.find((r) => r.method === "PUT")!.body, { model: "m" }, "an empty name is left out: the list shows the id");
  });

  it("Create past the key's profile cap (429 profile_limit) shows the server's line", async () => {
    const { sb, net } = await activateWith({
      "GET /library/profiles": [{ status: 200, body: { profiles: { home: {} }, default: "home" } }],
      "PUT /library/profiles/eleven": [{ status: 429, body: { error: { code: "profile_limit", message: "Create more profiles with the a4sx CLI or on the website." } } }],
    }, [...ALL, "profiles:write"]);
    await sb.profiles.getChildren();
    calls.inputQueue.push("eleven", "", "m");
    await calls.commands.get(ext.CMD_CREATE_PROFILE)!();
    assert.strictEqual(net.seen.filter((r) => r.method === "PUT").length, 1);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), ["Create more profiles with the a4sx CLI or on the website."]);
    const noLine = fakeFetch({ "PUT /library/profiles/x": [{ status: 429, body: { error: { code: "profile_limit" } } }] });
    await assert.rejects(api.putProfile(clientWith(noLine.fetch), TOKEN, "x", { name: "x" }), (e: any) => e.code === "profile-limit" && e.message === api.MESSAGES.profileLimit);
  });

  it("an older server answers writes with a refusal: one short message, no crash", async () => {
    const { sb } = await activateWith({ ...listed, "PUT /library/profiles/work": [scopeRefusal(null)] }, [...ALL, "profiles:write"]);
    const work = (await itemsOf(sb)).work;
    calls.nextPick = 1;
    calls.nextInput = "model-z";
    await calls.commands.get(ext.CMD_EDIT_PROFILE)!(work);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [api.MESSAGES.profilesNotSupported]);
  });

  it("api: profile refusals map to fixed messages", async () => {
    const c = (a: Answer) => clientWith(fakeFetch({ "PUT /library/profiles/x": [a], "DELETE /library/profiles/x": [a] }).fetch);
    await assert.rejects(api.putProfile(c(scopeRefusal("profiles:write")), TOKEN, "x", {}), (e: any) => e.code === "insufficient-scope" && e.requiredScope === "profiles:write");
    await assert.rejects(api.putProfile(c({ status: 429, body: { error: { code: "profile_limit" } } }), TOKEN, "x", {}), (e: any) => e.code === "profile-limit");
    await assert.rejects(api.putProfile(c({ status: 400, body: { error: { code: "bad_profile" } } }), TOKEN, "x", {}), (e: any) => e.code === "rejected" && e.message === api.MESSAGES.profileRejected);
    await assert.rejects(api.putProfile(c({ status: 400, body: { error: { code: "whatever", message: "Server says no." } } }), TOKEN, "x", {}), (e: any) => e.code === "rejected" && e.message === "Server says no.");
    await assert.rejects(api.deleteProfile(c({ status: 409, body: { error: { code: "something_new", message: "Not with a key.\nmore" } } }), TOKEN, "x"), (e: any) => e.code === "conflict" && e.message === "Not with a key.");
    await assert.rejects(api.deleteProfile(c({ status: 409, body: { error: { code: "something_new" } } }), TOKEN, "x"), (e: any) => e.message === api.MESSAGES.needsSignin);
    await assert.rejects(api.deleteProfile(c({ status: 404, body: { error: { code: "no_such_profile" } } }), TOKEN, "x"), (e: any) => e.code === "not-found");
    await assert.rejects(api.putProfile(c({ status: 200, body: {} }), TOKEN, "Bad/Id", {}), (e: any) => e.code === "rejected");
  });
});

describe("Resume in terminal: profile pick", () => {
  beforeEach(resetCalls);
  const savedPath = process.env.PATH;
  before(() => { process.env.PATH = "/usr/bin"; });
  after(() => { process.env.PATH = savedPath; });
  const item = new SessionItem({ id: "c-123", label: "my-base" });
  const found = (): CliLookup => ({ found: true, path: "/usr/local/bin/a4sx" });

  it("with more than one profile, a pick (default first) passes --profile=ID as one argv element, no shell", async () => {
    await activateWith({ "GET /library/profiles": [{ status: 200, body: profiles }] });
    calls.nextPick = 2;
    await ext.resumeSession(item, found);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => [i.label, i.description, i.detail]), [
      ["home", "default · model-b", PROFILE_TEXTS.cliDefaultAddress],
      ["Lab", "lab", "http://localhost:8080"],
      ["Work", "work · model-a", "https://proxy.example.com"],
    ]);
    assert.deepStrictEqual(calls.terminals[0].options, { name: ext.RESUME_TERMINAL_NAME });
    assert.deepStrictEqual(calls.terminals[0].sent, ["'/usr/local/bin/a4sx' 'launch' '--a4sx-session=c-123' '--profile=work'\n"]);
  });

  it("Esc in the pick starts nothing; one profile, no profiles:read, or an error: no pick and no --profile", async () => {
    await activateWith({ "GET /library/profiles": [{ status: 200, body: profiles }] });
    calls.nextPick = undefined;
    await ext.resumeSession(item, found);
    assert.strictEqual(calls.terminals.length, 0);
    for (const [routes, scopes] of [
      [{ "GET /library/profiles": [{ status: 200, body: { profiles: { home: {} }, default: "home" } }] }, ALL],
      [{}, ["library:read"]],
      [{ "GET /library/profiles": [new Error("offline")] }, ALL],
      [{ "GET /library/profiles": [scopeRefusal(null)] }, ALL],
    ] as [Record<string, Answer[]>, string[]][]) {
      resetCalls();
      const { net } = await activateWith(routes, scopes);
      await ext.resumeSession(item, found);
      assert.strictEqual(calls.quickPicks.length, 0);
      assert.deepStrictEqual(calls.terminals[0].sent, ["'/usr/local/bin/a4sx' 'launch' '--a4sx-session=c-123'\n"]);
      if (scopes.length === 1) {
        assert.strictEqual(net.seen.length, 0, "no request without profiles:read");
      }
    }
  });

  it("Resume in Claude Code offers no profile pick", async () => {
    const { net } = await activateWith({ "GET /library/profiles": [{ status: 200, body: profiles }] });
    calls.extensions.add("anthropic.claude-code");
    calls.workspaceFolders = [{ name: "p", uri: { scheme: "file", fsPath: "/p" } }];
    await ext.resumeInClaude(item);   // the fetch has no fake route here: it fails before anything is written
    assert.strictEqual(calls.quickPicks.length, 0);
    assert.ok(!net.seen.some((r) => r.url.includes("/library/profiles")), "no profile list, no pick");
  });
});

describe("revoking the key: sign-out and step-up", () => {
  beforeEach(resetCalls);

  it("sign-out revokes the stored key on the server, then deletes it here", async () => {
    const { ctx, net } = await activateWith({ "POST /library/keys/self/revoke": [REVOKED] });
    const order: string[] = [];
    const del = ctx.secrets.delete.bind(ctx.secrets);
    ctx.secrets.delete = async (k: string) => { order.push(net.seen.some(isRevoke) ? "delete-after-revoke" : "delete-first"); return del(k); };
    await calls.commands.get(ext.CMD_SIGN_OUT)!();
    const rev = net.seen.filter(isRevoke);
    assert.strictEqual(rev.length, 1);
    assert.strictEqual(bearer(rev[0]), `Bearer ${TOKEN}`);
    assert.strictEqual(rev[0].body, undefined, "no body");
    assert.deepStrictEqual(order, ["delete-after-revoke"]);
    assert.strictEqual(ctx.secrets.store_.size, 0);
    assert.deepStrictEqual(calls.infos, [ext.SIGNED_OUT_REVOKED_INFO]);
    noTokenAnywhere();
  });

  it("a network failure, an error answer, or an older server (404/405) still deletes the key here", async () => {
    for (const answer of [new Error("offline"), { status: 500 }, { status: 404, body: { error: { code: "not_found" } } }, { status: 405 }] as Answer[]) {
      resetCalls();
      const { ctx, net } = await activateWith({ "POST /library/keys/self/revoke": [answer] });
      await calls.commands.get(ext.CMD_SIGN_OUT)!();
      assert.strictEqual(net.seen.filter(isRevoke).length, 1);
      assert.strictEqual(ctx.secrets.store_.size, 0);
      assert.deepStrictEqual(calls.infos, [ext.SIGNED_OUT_INFO]);
      assert.strictEqual(calls.errors.length, 0);
    }
  });

  it("the revoke call uses a short timeout", async () => {
    const seenSignals: AbortSignal[] = [];
    const c: api.Client = { base: BASE, userAgent: "t", fetch: async (_u, init) => { seenSignals.push(init!.signal!); return { status: 200, json: async () => ({ status: "revoked" }) }; } };
    assert.strictEqual(await api.revokeKey(c, TOKEN), "revoked");
    assert.ok(api.REVOKE_TIMEOUT_MS <= 5000);
    assert.strictEqual(seenSignals.length, 1);
  });

  it("a step-up revokes only the OLD key, and only after the new one is stored", async () => {
    const { ctx, net, sb } = await activateWith({ "POST /library/keys/self/revoke": [REVOKED] }, ["library:read"]);
    let storedAtRevoke: string | undefined;
    const fetch = ext.runtime.fetch;
    ext.runtime.fetch = async (url, init) => {
      if (url.endsWith("/library/keys/self/revoke")) {
        storedAtRevoke = storedKey(ctx).token;
      }
      return fetch(url, init);
    };
    const token = await sb.auth.stepUp("profiles:read");
    assert.strictEqual(token, NEW_TOKEN);
    const rev = net.seen.filter(isRevoke);
    assert.deepStrictEqual(rev.map(bearer), [`Bearer ${TOKEN}`]);
    assert.strictEqual(storedAtRevoke, NEW_TOKEN, "the new key was already stored");
    assert.strictEqual(storedKey(ctx).token, NEW_TOKEN);
    noTokenAnywhere();
  });

  it("a failed revoke after a step-up keeps the new key; a cancelled or failed step-up revokes nothing", async () => {
    const { ctx, net, sb } = await activateWith({ "POST /library/keys/self/revoke": [new Error("offline")] }, ["library:read"]);
    assert.strictEqual(await sb.auth.stepUp("profiles:read"), NEW_TOKEN);
    assert.strictEqual(storedKey(ctx).token, NEW_TOKEN);
    for (const failure of [new LoginCancelled(), new api.ApiError("bad-scopes", api.MESSAGES.badResponse, 400)]) {
      resetCalls();
      const run = await activateWith({ "POST /library/keys/self/revoke": [REVOKED] }, ["library:read"]);
      ext.runtime.login = async () => { throw failure; };
      calls.modalChoices.push(STEP_UP.signIn);
      assert.strictEqual(await offerStepUp(run.sb.auth, "library:organize"), undefined);
      assert.strictEqual(run.net.seen.filter(isRevoke).length, 0);
      assert.strictEqual(storedKey(run.ctx).token, TOKEN, "the old key stays");
    }
    assert.ok(net.seen.filter(isRevoke).length === 1);
  });
});

describe("review follow-ups", () => {
  beforeEach(resetCalls);

  const SECRETS = ["abc123def", "t0k3n", "sk-ant-xyz"];
  const secretProfile = { profiles: { work: { name: "Work", flags: ["--verbose", "--api-key", "abc123def", "--token=t0k3n", "sk-ant-xyz"] } }, default: "work" };
  const noSecret = (text: string) => SECRETS.forEach((v) => assert.ok(!text.includes(v), `shown: ${text}`));

  it("flags are read-only: masked in the tooltip and the edit pick, they offer the CLI or the website, and nothing is sent", async () => {
    const { sb, net } = await activateWith({ "GET /library/profiles": [{ status: 200, body: secretProfile }] }, [...ALL, "profiles:write"]);
    const [work] = (await sb.profiles.getChildren()) as ProfileItem[];
    assert.ok(String(work.tooltip).includes("Flags: --verbose --api-key •••• --token=•••• ••••"));
    noSecret(String(work.tooltip));
    const fake = require("vscode");
    const savedInfo = fake.window.showInformationMessage;
    const asked: string[] = [];
    fake.window.showInformationMessage = async (message: string, ...items: string[]) => { asked.push(`${message}|${items.join(",")}`); return undefined; };
    try {
      calls.nextPick = 2;   // Flags
      await calls.commands.get(ext.CMD_EDIT_PROFILE)!(work);
    } finally {
      fake.window.showInformationMessage = savedInfo;
    }
    const flagsItem = calls.quickPicks[0].items[2];
    assert.deepStrictEqual([flagsItem.label, flagsItem.description, flagsItem.detail], ["Flags", "--verbose --api-key •••• --token=•••• ••••", PROFILE_TEXTS.readOnlyHere]);
    noSecret(JSON.stringify(calls.quickPicks[0].items));
    assert.deepStrictEqual(asked, [`${PROFILE_TEXTS.readOnly}|${PROFILE_TEXTS.runCli},${PROFILE_TEXTS.openWebsite}`]);
    assert.strictEqual(calls.inputs.length, 0, "no flags box");
    assert.strictEqual(net.seen.filter((r) => r.method === "PUT").length, 0);
  });

  it("step-up only ever asks for profiles:read, profiles:write, library:organize or mesh:read (never mesh:join or mesh:admin)", async () => {
    const { sb, logins } = await activateWith({
      "GET /library/profiles": [{ status: 200, body: profiles }],
      "PUT /library/profiles/home": [scopeRefusal("admin:all")],
    }, [...ALL, "profiles:write"]);
    const home = ((await sb.profiles.getChildren()) as ProfileItem[])[0];
    calls.nextPick = 1;
    calls.nextInput = "model-q";
    calls.modalChoices.push(STEP_UP.signIn);
    await calls.commands.get(ext.CMD_EDIT_PROFILE)!(home);
    assert.strictEqual(calls.modals.length, 0);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [api.MESSAGES.needsScope("admin:all")]);
    await calls.commands.get(ext.CMD_ALLOW_SCOPE)!("library:publish");
    assert.strictEqual(await offerStepUp(sb.auth, "library:acquire"), undefined);
    await assert.rejects(sb.auth.stepUp("library:publish"), (e: any) => e.code === "bad-scopes");
    assert.strictEqual(logins.length, 0);
    for (const never of ["mesh:join", "mesh:admin"]) {
      assert.strictEqual(await offerStepUp(sb.auth, never), undefined);
      await assert.rejects(sb.auth.stepUp(never), (e: any) => e.code === "bad-scopes");
    }
    assert.strictEqual(logins.length, 0);
    assert.deepStrictEqual([...STEP_UP_SCOPES].sort(), ["library:organize", "mesh:read", "profiles:read", "profiles:write"]);
  });

  it("Create fetches the list again before writing, and asks before replacing an id that now exists", async () => {
    const { sb, net } = await activateWith({
      "GET /library/profiles": [
        { status: 200, body: { profiles: { home: {} }, default: "home" } },
        { status: 200, body: { profiles: { home: {}, work: { base_url: "https://old.example.com" } }, default: "home" } },
      ],
      "PUT /library/profiles/work": [{ status: 200, body: profiles }],
    }, [...ALL, "profiles:write"]);
    await sb.profiles.getChildren();
    calls.inputQueue.push("work", "", "m", "work", "", "m");
    calls.modalChoices.push(undefined, PROFILE_TEXTS.replace);
    await calls.commands.get(ext.CMD_CREATE_PROFILE)!();
    assert.strictEqual(net.seen.filter((r) => r.method === "PUT").length, 0, "Cancel: nothing replaced");
    await calls.commands.get(ext.CMD_CREATE_PROFILE)!();
    assert.deepStrictEqual(calls.modals.map((m) => m.message), [PROFILE_TEXTS.confirmReplace("work"), PROFILE_TEXTS.confirmReplace("work")]);
    assert.strictEqual(net.seen.filter((r) => r.method === "GET").length, 3, "the view's list, then once per Create");
    const puts = net.seen.filter((r) => r.method === "PUT");
    assert.strictEqual(puts.length, 1);
    assert.deepStrictEqual(puts[0].body, { model: "m" }, "only the given fields: the server keeps the stored name, address and the rest");
  });

  it("Refresh while filtered fetches again and keeps the filter, with new counts", async () => {
    const { sb, net } = await activateWith({ "GET /library/sessions": [
      { status: 200, body: { sessions: rows } },
      { status: 200, body: { sessions: [...rows, { id: "c-7", title: "Work log", folder: null }] } },
    ] });
    sb.sessions.setFilter("work");
    assert.strictEqual((await sb.sessions.getChildren()).length, 3);
    await calls.commands.get(ext.CMD_REFRESH)!();
    const items = await sb.sessions.getChildren();
    assert.strictEqual(net.seen.length, 2);
    assert.strictEqual(sb.sessions.filter, "work");
    assert.deepStrictEqual(items.map((i) => i.label).sort(), ["Fix login", "Old notes", "Refactor router", "Work log"]);
    assert.strictEqual(calls.treeViews.get(ext.VIEW_SESSIONS)!.message, FILTER_MESSAGE("work", 4, 7));
    assert.strictEqual(calls.context["a4sx.sessionsFiltered"], true);
  });

  it("signing out with no stored key says only that, and calls nothing", async () => {
    const { net } = await activateWith({}, null);
    await calls.commands.get(ext.CMD_SIGN_OUT)!();
    assert.deepStrictEqual(calls.infos, [ext.SIGNED_OUT_NO_KEY_INFO]);
    assert.strictEqual(net.seen.length, 0);
  });

  it("Resume in terminal shows progress while the profile list loads", async () => {
    await activateWith({ "GET /library/profiles": [{ status: 200, body: profiles }] });
    calls.nextPick = 0;
    await ext.resumeSession(new SessionItem({ id: "c-1", label: "x" }), () => ({ found: true, path: "/usr/local/bin/a4sx" }));
    assert.deepStrictEqual(calls.progress.map((p) => p.title), [PROFILE_TEXTS.loadingProfiles]);
  });
});

describe("server-hidden profile values (hidden_fields, credential_in_profile)", () => {
  beforeEach(resetCalls);

  const hiddenBody = (n: number) => ({ profiles: { work: { name: "Work", model: "m", flags: ["--verbose"], hidden_fields: n } }, default: "work" });

  it("shows the hidden count in the tooltip and the edit pick, and never sends hidden_fields back", async () => {
    const { sb, net } = await activateWith({
      "GET /library/profiles": [{ status: 200, body: hiddenBody(2) }],
      "PUT /library/profiles/work": [{ status: 200, body: hiddenBody(2) }],
    }, [...ALL, "profiles:write"]);
    const [work] = (await sb.profiles.getChildren()) as ProfileItem[];
    assert.ok(String(work.tooltip).split("\n").includes(HIDDEN_FIELDS(2)));
    assert.strictEqual(HIDDEN_FIELDS(2), "2 other settings are hidden here and stay as they are. Change them with the a4sx CLI or on the website.");
    assert.strictEqual(HIDDEN_FIELDS(1), "1 other setting is hidden here and stays as it is. Change it with the a4sx CLI or on the website.");
    calls.nextPick = 1;
    calls.nextInput = "m2";
    await calls.commands.get(ext.CMD_EDIT_PROFILE)!(work);
    assert.ok(calls.quickPicks[0].options.placeHolder.includes(HIDDEN_FIELDS(2)));
    const put = net.seen.find((r) => r.method === "PUT")!;
    assert.deepStrictEqual(put.body, { model: "m2" });
    const plain = new ProfileItem("p", { model: "m" }, false);
    assert.ok(!String(plain.tooltip).includes("hidden"));
  });

  it("400 credential_in_profile keeps the edit open with the server's one-line message, prefilled with the stored value", async () => {
    // Flags are limited to a few safe additions, so the model field carries the value the server refuses.
    const SUBMITTED = "supersecretvalue";
    const { sb, net } = await activateWith({
      "GET /library/profiles": [{ status: 200, body: hiddenBody(0) }],
      "PUT /library/profiles/work": [
        { status: 400, body: { error: { code: "credential_in_profile", message: "Keep keys out of launch profiles; use a4sx launch --set-api-key.\nDetails follow." } } },
        { status: 200, body: hiddenBody(0) },
      ],
    }, [...ALL, "profiles:write"]);
    const [work] = (await sb.profiles.getChildren()) as ProfileItem[];
    calls.nextPick = 1;
    calls.inputQueue.push(SUBMITTED, "m2");
    await calls.commands.get(ext.CMD_EDIT_PROFILE)!(work);
    assert.strictEqual(calls.inputs.length, 2, "the edit stays open");
    assert.strictEqual(calls.inputs[1].prompt, "Keep keys out of launch profiles; use a4sx launch --set-api-key.");
    assert.strictEqual(calls.inputs[1].value, "m", "the stored value, not what was sent");
    const shown = JSON.stringify([calls.errors, calls.infos, calls.warnings, calls.modals, calls.inputs.map((i) => [i.prompt, i.value])]);
    assert.ok(!shown.includes("supersecretvalue"));
    assert.deepStrictEqual(net.seen.filter((r) => r.method === "PUT").map((r) => r.body.model), [SUBMITTED, "m2"]);
  });

  it("the server's message is capped to one line, and replaced if it echoes a submitted value or is missing", () => {
    const err = (message?: unknown) => ({ error: { code: "credential_in_profile", message } });
    const fb = api.MESSAGES.credentialInProfile;
    assert.strictEqual(api.serverLine(err("x".repeat(500)), [], fb).length, 200);
    assert.strictEqual(api.serverLine(err("Use the a4sx CLI or the website."), [], fb), "Use the a4sx CLI or the website.", "shown as sent");
    assert.strictEqual(api.serverLine(err("bad flag --tok=abcd1234 found"), ["--tok=abcd1234"], fb), fb);
    assert.strictEqual(api.serverLine(err(undefined), [], fb), fb);
    assert.strictEqual(api.serverLine(err("  \n second"), [], fb), fb);
  });

  it("a masked •••• is never sent: refused before any request, and refused as typed input", async () => {
    const net = fakeFetch({});
    await assert.rejects(api.putProfile(clientWith(net.fetch), TOKEN, "work", { flags: ["--key=••••"] }), (e: any) => e.code === "rejected");
    await assert.rejects(api.putProfile(clientWith(net.fetch), TOKEN, "work", { headers: { "X-K": "••••" } }), (e: any) => e.code === "rejected");
    assert.strictEqual(net.seen.length, 0);
  });
});

describe("server address is read-only; permission-loosening flags (409s)", () => {
  beforeEach(resetCalls);

  const withAddress = { profiles: { work: { name: "Work", base_url: "https://proxy.example.com", flags: ["--verbose", "--dangerously-skip-permissions"] } }, default: "work" };

  it("Edit shows the address read-only and offers the CLI (shell-free terminal) or the website; nothing is sent", async () => {
    const { sb, net } = await activateWith({ "GET /library/profiles": [{ status: 200, body: withAddress }] }, [...ALL, "profiles:write"]);
    const [work] = (await sb.profiles.getChildren()) as ProfileItem[];
    const fake = require("vscode");
    const savedInfo = fake.window.showInformationMessage;
    const asked: { message: string; items: string[] }[] = [];
    const answers = [PROFILE_TEXTS.openWebsite, PROFILE_TEXTS.runCli];
    fake.window.showInformationMessage = async (message: string, ...items: string[]) => { asked.push({ message, items }); return answers.shift(); };
    try {
      calls.pickQueue.push(3, 3);
      await calls.commands.get(ext.CMD_EDIT_PROFILE)!(work);
      await calls.commands.get(ext.CMD_EDIT_PROFILE)!(work);
    } finally {
      fake.window.showInformationMessage = savedInfo;
    }
    const pickItem = calls.quickPicks[0].items[3];
    assert.deepStrictEqual([pickItem.label, pickItem.description, pickItem.detail], ["Server address", "https://proxy.example.com", PROFILE_TEXTS.readOnlyHere]);
    assert.deepStrictEqual(asked.map((a) => [a.message, a.items]), [
      [PROFILE_TEXTS.readOnly, [PROFILE_TEXTS.runCli, PROFILE_TEXTS.openWebsite]],
      [PROFILE_TEXTS.readOnly, [PROFILE_TEXTS.runCli, PROFILE_TEXTS.openWebsite]],
    ]);
    assert.deepStrictEqual(calls.opened, [`${BASE}/account/workspace#profiles`]);
    assert.strictEqual(calls.inputs.length, 0, "no box for the address");
    assert.strictEqual(calls.modals.length, 0, "no address confirmation");
    assert.strictEqual(net.seen.filter((r) => r.method === "PUT").length, 0);
  });

  it("the CLI button runs `a4sx profile --name ID` directly in a terminal", async () => {
    const t = await ext.runProfileCli("work", () => ({ found: true, path: "/usr/local/bin/a4sx" }));
    assert.ok(t);
    assert.deepStrictEqual(calls.terminals[0].options, { name: ext.PROFILE_TERMINAL_NAME, shellPath: "/usr/local/bin/a4sx", shellArgs: ["profile", "--name", "work"] });
    assert.strictEqual(await ext.runProfileCli("--evil", () => ({ found: true, path: "/x" })), undefined);
    assert.strictEqual(calls.terminals.length, 1);
  });

  it("a key changes only name and model: no flags box anywhere, and Create sends no flags", async () => {
    const { sb, net } = await activateWith({
      "GET /library/profiles": [{ status: 200, body: withAddress }],
      "PUT /library/profiles/new": [{ status: 200, body: withAddress }],
    }, [...ALL, "profiles:write"]);
    await sb.profiles.getChildren();
    calls.inputQueue.push("new", "New one", "m1");
    await calls.commands.get(ext.CMD_CREATE_PROFILE)!();
    assert.deepStrictEqual(calls.inputs.map((i) => i.prompt), [PROFILE_TEXTS.idPrompt, PROFILE_TEXTS.prompts.name, PROFILE_TEXTS.prompts.model]);
    assert.deepStrictEqual(net.seen.find((r) => r.method === "PUT")!.body, { name: "New one", model: "m1" });
    assert.ok(!Object.values(PROFILE_TEXTS.prompts).some((p) => /flag/i.test(p)), "no text says flags can be edited");
  });

  for (const [code, message] of [
    ["base_url_needs_signin", "Change the server address with the a4sx CLI or on the website."],
    ["permission_flag_needs_signin", "Turning off permission prompts needs the a4sx CLI or the website."],
    ["hidden_fields_bound_to_host", "Hidden values stay tied to the current address."],
  ] as const) {
    it(`a 409 ${code} keeps the edit open with the server's one-line message`, async () => {
      const { sb, net } = await activateWith({
        "GET /library/profiles": [{ status: 200, body: withAddress }],
        "PUT /library/profiles/work": [{ status: 409, body: { error: { code, message: `${message}\nmore` } } }],
      }, [...ALL, "profiles:write"]);
      const [work] = (await sb.profiles.getChildren()) as ProfileItem[];
      calls.nextPick = 1;   // Model
      calls.inputQueue.push("m2", undefined);
      await calls.commands.get(ext.CMD_EDIT_PROFILE)!(work);
      assert.strictEqual(net.seen.filter((r) => r.method === "PUT").length, 1);
      assert.strictEqual(calls.inputs.length, 2, "the edit stays open");
      assert.strictEqual(calls.inputs[1].prompt, message);
      assert.strictEqual(calls.inputs[1].value, "", "the stored value (no model)");
      assert.strictEqual(calls.errors.length, 0);
    });
  }

  it("409 fallbacks are fixed short texts when the server sends no message", () => {
    for (const [code, fallback] of [["base_url_needs_signin", api.MESSAGES.baseUrlNeedsSignin], ["permission_flag_needs_signin", api.MESSAGES.permissionFlagNeedsSignin]]) {
      assert.strictEqual(api.serverLine({ error: { code } }, [], fallback), fallback);
    }
  });
});

describe("read-only fields beyond the address; set-default and delete refusals", () => {
  beforeEach(resetCalls);

  const body = { profiles: {
    home: { name: "Home", model: "m" },
    plain: { name: "Plain", model: "p" },
    work: { name: "Work", base_url: "https://proxy.example.com", harness: "codex", use_router: true, router_tenant: "acme", headers: { "X-Team": "blue", "X-Org": "red" } },
  }, default: "home" };

  it("flags, address, harness, router and headers are read-only: each offers the CLI or the website, and nothing is sent", async () => {
    const { sb, net } = await activateWith({ "GET /library/profiles": [{ status: 200, body }] }, [...ALL, "profiles:write"]);
    const work = ((await sb.profiles.getChildren()) as ProfileItem[]).find((i) => i.id === "work")!;
    const fake = require("vscode");
    const savedInfo = fake.window.showInformationMessage;
    const asked: string[] = [];
    fake.window.showInformationMessage = async (message: string, ...items: string[]) => { asked.push(`${message}|${items.join(",")}`); return undefined; };
    try {
      calls.pickQueue.push(2, 3, 4, 5, 6);
      for (let i = 0; i < 5; i++) {
        await calls.commands.get(ext.CMD_EDIT_PROFILE)!(work);
      }
    } finally {
      fake.window.showInformationMessage = savedInfo;
    }
    const items = calls.quickPicks[0].items;
    assert.deepStrictEqual(items.map((i: any) => i.field), ["name", "model", "flags", "base_url", "harness", "router", "headers"]);
    assert.deepStrictEqual(items.slice(3).map((i: any) => i.description), ["https://proxy.example.com", "codex", "on · acme", "2 headers"]);
    assert.ok(!JSON.stringify(items).match(/blue|red|X-Team/), "header names and values are never shown");
    assert.deepStrictEqual(asked, Array(5).fill(`${PROFILE_TEXTS.readOnly}|${PROFILE_TEXTS.runCli},${PROFILE_TEXTS.openWebsite}`));
    assert.strictEqual(PROFILE_TEXTS.readOnly, "This setting can only be changed with the a4sx CLI or on the website.");
    assert.strictEqual(calls.inputs.length, 0);
    assert.strictEqual(net.seen.filter((r) => r.method === "PUT").length, 0);
  });

  it("a 409 needs_signin on an edit keeps the edit open with the server's line", async () => {
    const { sb } = await activateWith({
      "GET /library/profiles": [{ status: 200, body }],
      "PUT /library/profiles/home": [{ status: 409, body: { error: { code: "needs_signin", message: "Use the a4sx CLI or the website to change this.", details: { field: "harness" } } } }],
    }, [...ALL, "profiles:write"]);
    const home = ((await sb.profiles.getChildren()) as ProfileItem[])[0];
    calls.nextPick = 1;
    calls.inputQueue.push("m2", undefined);
    await calls.commands.get(ext.CMD_EDIT_PROFILE)!(home);
    assert.strictEqual(calls.inputs[1].prompt, "Use the a4sx CLI or the website to change this.");
    assert.strictEqual(calls.inputs[1].value, "m");
  });

  for (const code of ["needs_signin", "permission_flag_needs_signin", "something_new"]) {
    it(`delete: a 409 ${code} shows the server's line and changes nothing here`, async () => {
      const { sb, net } = await activateWith({
        "GET /library/profiles": [{ status: 200, body }],
        "DELETE /library/profiles/plain": [{ status: 409, body: { error: { code, message: "Delete it with the a4sx CLI or on the website, please.\nmore" } } }],
      }, [...ALL, "profiles:write"]);
      const items = (await sb.profiles.getChildren()) as ProfileItem[];
      calls.modalChoices.push(PROFILE_TEXTS.delete);
      await calls.commands.get(ext.CMD_DELETE_PROFILE)!(items.find((i) => i.id === "plain")!);
      assert.strictEqual(net.seen.filter((r) => r.method === "DELETE").length, 1);
      assert.deepStrictEqual(calls.errors.map((e) => e.message), ["Delete it with the a4sx CLI or on the website, please."]);
      assert.deepStrictEqual(sb.profiles.data, { profiles: Object.entries(body.profiles), default: "home" }, "the local list is unchanged");
    });
  }

  it("an edit refused with any other 400 or 409 keeps the box open with the server's line", async () => {
    const { sb } = await activateWith({
      "GET /library/profiles": [{ status: 200, body }],
      "PUT /library/profiles/home": [
        { status: 400, body: { error: { code: "flag_not_allowed", message: "That flag needs the CLI." } } },
        { status: 409, body: { error: { code: "brand_new", message: "Not with a key." } } },
      ],
    }, [...ALL, "profiles:write"]);
    const home = ((await sb.profiles.getChildren()) as ProfileItem[])[0];
    calls.nextPick = 1;
    calls.inputQueue.push("m2", "m3", undefined);
    await calls.commands.get(ext.CMD_EDIT_PROFILE)!(home);
    assert.deepStrictEqual(calls.inputs.slice(1).map((i) => i.prompt), ["That flag needs the CLI.", "Not with a key."]);
    assert.strictEqual(calls.errors.length, 0);
  });
});

describe("delta review nits", () => {
  beforeEach(resetCalls);

  const body = { profiles: { home: { name: "Home", model: "m" }, plain: { name: "Plain", model: "p" } }, default: "home" };

  it("an edit that empties the name sends nothing (the stored name stays); Create with no name sends an empty object", async () => {
    const { sb, net } = await activateWith({
      "GET /library/profiles": [{ status: 200, body }],
      "PUT /library/profiles/fresh": [{ status: 200, body }],
    }, [...ALL, "profiles:write"]);
    const plain = ((await sb.profiles.getChildren()) as ProfileItem[]).find((i) => i.id === "plain")!;
    calls.nextPick = 0;
    calls.inputQueue.push("", "fresh", "", "");
    await calls.commands.get(ext.CMD_EDIT_PROFILE)!(plain);
    assert.strictEqual(net.seen.filter((r) => r.method === "PUT").length, 0);
    await calls.commands.get(ext.CMD_CREATE_PROFILE)!();
    assert.deepStrictEqual(net.seen.find((r) => r.method === "PUT")!.body, {});
  });

  it("Change default runs the CLI's `a4sx profile --set-default ID` (id as its own element, no shell), or opens the website", async () => {
    const t = await ext.runSetDefaultCli("work", () => ({ found: true, path: "/usr/local/bin/a4sx" }));
    assert.ok(t);
    assert.deepStrictEqual(calls.terminals[0].options, { name: ext.PROFILE_TERMINAL_NAME, shellPath: "/usr/local/bin/a4sx", shellArgs: ["profile", "--set-default", "work"] });
    assert.strictEqual(await ext.runSetDefaultCli("--x", () => ({ found: true, path: "/x" })), undefined);

    const { sb } = await activateWith({ "GET /library/profiles": [{ status: 200, body }] }, [...ALL, "profiles:write"]);
    const plain = ((await sb.profiles.getChildren()) as ProfileItem[]).find((i) => i.id === "plain")!;
    const fake = require("vscode");
    const savedInfo = fake.window.showInformationMessage;
    const answers = [PROFILE_TEXTS.openWebsite];
    fake.window.showInformationMessage = async () => answers.shift();
    try {
      await calls.commands.get(ext.CMD_CHANGE_DEFAULT)!(plain);
    } finally {
      fake.window.showInformationMessage = savedInfo;
    }
    assert.deepStrictEqual(calls.opened, [`${BASE}/account/workspace#profiles`]);
  });

  it("the CLI button of Change default calls the set-default runner with the profile id", async () => {
    const seen: string[] = [];
    const { changeDefault } = await import("../../profileCommands");
    const fake = require("vscode");
    const savedInfo = fake.window.showInformationMessage;
    fake.window.showInformationMessage = async () => PROFILE_TEXTS.runCli;
    try {
      await changeDefault({
        auth: {} as any, client: () => clientWith(fakeFetch({}).fetch), view: {} as any,
        elsewhere: { website: async () => undefined, cli: async (id) => { seen.push(`cli:${id}`); }, setDefault: async (id) => { seen.push(`set:${id}`); } },
      }, new ProfileItem("plain", { name: "Plain" }, false));
    } finally {
      fake.window.showInformationMessage = savedInfo;
    }
    assert.deepStrictEqual(seen, ["set:plain"]);
  });

  it("the sign-in item is offered only for the three allowed scopes; another scope is a capped note", async () => {
    for (const [need, offered] of [["profiles:read", true], ["admin:all", false], ["x".repeat(500), false]] as const) {
      resetCalls();
      const { sb } = await activateWith({ "GET /library/profiles": [scopeRefusal(need)] }, ["library:read"]);
      const [item] = await sb.profiles.getChildren();
      if (offered) {
        assert.strictEqual(item.label, ALLOW_SCOPE_ITEM(need));
        assert.strictEqual(item.command!.command, ext.CMD_ALLOW_SCOPE);
      } else {
        assert.strictEqual(item.command, undefined, need.slice(0, 20));
        assert.strictEqual(item.label, api.MESSAGES.needsScope(need.slice(0, 200)));
        assert.ok(String(item.label).length <= 200 + api.MESSAGES.needsScope("").length);
      }
    }
  });

  it("a write answered with a bare {ok:true} counts as success and refreshes the list", async () => {
    const { sb, net } = await activateWith({
      "GET /library/profiles": [{ status: 200, body }, { status: 200, body: { ...body, profiles: { ...body.profiles, plain: { name: "Plain", model: "p2" } } } }],
      "PUT /library/profiles/plain": [{ status: 200, body: { ok: true, default: "home" } }],
      "DELETE /library/profiles/plain": [{ status: 200, body: { ok: true, default: "home" } }],
    }, [...ALL, "profiles:write"]);
    let plain = ((await sb.profiles.getChildren()) as ProfileItem[]).find((i) => i.id === "plain")!;
    calls.nextPick = 1;
    calls.inputQueue.push("p2");
    let fired = 0;
    sb.profiles.onDidChangeTreeData(() => { fired++; });
    await calls.commands.get(ext.CMD_EDIT_PROFILE)!(plain);
    assert.strictEqual(calls.errors.length, 0, "not an error");
    assert.strictEqual(fired, 1, "the view refreshes");
    plain = ((await sb.profiles.getChildren()) as ProfileItem[]).find((i) => i.id === "plain")!;
    assert.strictEqual(plain.profile.model, "p2", "the refreshed list is fetched from the server");
    calls.modalChoices.push(PROFILE_TEXTS.delete);
    await calls.commands.get(ext.CMD_DELETE_PROFILE)!(plain);
    assert.strictEqual(calls.errors.length, 0);
    assert.strictEqual(fired, 2);
    assert.strictEqual(net.seen.filter((r) => r.method === "GET").length, 2);
    assert.strictEqual(await api.putProfile(clientWith(fakeFetch({ "PUT /library/profiles/x": [{ status: 200, body: { ok: true } }] }).fetch), TOKEN, "x", {}), undefined);
  });
});
