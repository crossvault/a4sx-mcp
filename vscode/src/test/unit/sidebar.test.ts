// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
import * as assert from "assert";
import { calls, fakeMemento, fakeSecrets, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import * as api from "../../api";
import { A4sxAuthProvider, deviceLogin, LoginCancelled, SECRET_KEY } from "../../auth";
import { SessionItem, SessionsProvider, formatTokens, SIGNED_OUT_MESSAGE } from "../../sessionsView";
import { ListingItem, MarketplaceProvider, NO_RESULTS } from "../../marketplaceView";
import type { CliLookup } from "../../cli";

const TOKEN = "lib_tok_SECRET_value_123";
const BASE = "https://session-exchange.com";

interface Req { url: string; method: string; headers: Record<string, string>; body?: any }

/** A fake fetch: `routes` maps "METHOD path" (path without query) to a list of answers, used in order. */
function fakeFetch(routes: Record<string, ({ status: number; body?: unknown } | Error)[]>) {
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

const stored = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ token: TOKEN, server: BASE, id: "tok_1", scopes: ["library:read"], ...over });

function fakeContext() {
  return { subscriptions: [] as { dispose(): unknown }[], secrets: fakeSecrets(), globalState: fakeMemento() };
}

/** Activates with a fake network; returns the context and the sidebar objects. */
function activateWith(routes: Parameters<typeof fakeFetch>[0]) {
  const net = fakeFetch(routes);
  ext.runtime.fetch = net.fetch;
  const ctx = fakeContext();
  ext.activate(ctx as any);
  return { ctx, net, sb: ext.sidebar! };
}

const savedRuntime = { ...ext.runtime };
afterEach(() => Object.assign(ext.runtime, savedRuntime));

function noTokenAnywhere(): void {
  const shown = [...calls.errors.map((e) => e.message), ...calls.infos, ...calls.warnings, ...calls.progress.flatMap((p) => p.messages)];
  for (const m of shown) {
    assert.ok(!m.includes(TOKEN), `token leaked into a message: ${m}`);
  }
  assert.ok(!JSON.stringify(calls.config).includes(TOKEN), "token leaked into settings");
}

describe("api", () => {
  it("the server URL defaults to session-exchange.com and must be HTTPS (plain http only for this machine)", () => {
    assert.strictEqual(api.normalizeServerUrl(undefined), BASE);
    assert.strictEqual(api.normalizeServerUrl("  "), BASE);
    assert.strictEqual(api.normalizeServerUrl("https://staging.example.com/some/path/"), "https://staging.example.com");
    assert.strictEqual(api.normalizeServerUrl("http://localhost:8080"), "http://localhost:8080");
    for (const bad of ["http://example.com", "ftp://example.com", "not a url", "https://user:pw@example.com"]) {
      assert.throws(() => api.normalizeServerUrl(bad), (e: any) => e.code === "bad-server-url");
    }
  });

  it("listSessions sends the token as a Bearer header; a 401 is 'unauthorized'", async () => {
    const ok = fakeFetch({ "GET /library/sessions": [{ status: 200, body: { sessions: [{ id: "c1" }, { title: "no id" }] } }] });
    assert.deepStrictEqual(await api.listSessions(clientWith(ok.fetch), TOKEN), [{ id: "c1" }]);
    assert.strictEqual(ok.seen[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(ok.seen[0].url, `${BASE}/library/sessions`);
    const denied = fakeFetch({ "GET /library/sessions": [{ status: 401, body: { error: { code: "auth_invalid", message: "x" } } }] });
    await assert.rejects(api.listSessions(clientWith(denied.fetch), TOKEN), (e: any) => e.code === "unauthorized" && !e.message.includes(TOKEN));
  });

  it("discover is anonymous and escapes the query", async () => {
    const net = fakeFetch({ "GET /memory/discover": [{ status: 200, body: { items: [{ id: "L1", title: "T" }] } }] });
    await api.discover(clientWith(net.fetch), "a&b=c");
    assert.strictEqual(net.seen[0].headers.Authorization, undefined);
    assert.strictEqual(new URL(net.seen[0].url).searchParams.get("q"), "a&b=c");
  });

  it("network failures and odd answers map to short fixed messages", async () => {
    const down = fakeFetch({ "GET /library/sessions": [new Error("ECONNREFUSED 10.0.0.1")] });
    await assert.rejects(api.listSessions(clientWith(down.fetch), TOKEN), (e: any) => e.code === "unreachable" && !/10\.0\.0\.1/.test(e.message));
    const odd = fakeFetch({ "GET /library/sessions": [{ status: 200, body: { nope: 1 } }] });
    await assert.rejects(api.listSessions(clientWith(odd.fetch), TOKEN), (e: any) => e.code === "bad-response");
    const busy = fakeFetch({ "GET /library/sessions": [{ status: 503 }] });
    await assert.rejects(api.listSessions(clientWith(busy.fetch), TOKEN), (e: any) => e.code === "busy");
  });

  it("web links: a library session, and a listing with ?t= only outside the default tenant", () => {
    assert.strictEqual(api.sessionWebUrl(BASE, "c/1"), `${BASE}/library/session/c%2F1`);
    assert.strictEqual(api.listingWebUrl(BASE, { id: "L1", tenant: "default" }), `${BASE}/marketplace/L1`);
    assert.strictEqual(api.listingWebUrl(BASE, { id: "L1", tenant: "acme" }), `${BASE}/marketplace/L1?t=acme`);
  });
});

describe("device login (same protocol as `a4sx login`)", () => {
  const start = { status: 200, body: { code: "PAIR", user_code: "ABCD-EFGH", login_url: `${BASE}/auth/cli/choose?code=PAIR`, expires_in: 600 } };
  const hooks = (over: Partial<Parameters<typeof deviceLogin>[1]> = {}) => {
    const log = { opened: [] as string[], reports: [] as string[] };
    let t = 0;
    return {
      log,
      hooks: {
        open: async (u: string) => log.opened.push(u),
        report: (m: string) => log.reports.push(m),
        cancelled: () => false,
        sleep: async (ms: number) => { t += ms; },
        now: () => t,
        ...over,
      },
    };
  };

  it("asks for library:read + profiles:read + library:organize, opens the link, shows the code, polls until ok", async () => {
    const net = fakeFetch({
      "POST /auth/cli/start": [start],
      "GET /auth/cli/poll": [
        { status: 202, body: { status: "pending" } },
        { status: 503 },
        { status: 202, body: { status: "awaiting_approval" } },
        { status: 200, body: { status: "ok", token: TOKEN, token_type: "library", token_id: "tok_9", scopes: ["library:read"], expires_at: "2099-01-01T00:00:00Z" } },
      ],
    });
    const h = hooks();
    const got = await deviceLogin(clientWith(net.fetch), h.hooks);
    assert.deepStrictEqual(net.seen[0].body, { token_type: "library", scopes: ["library:read", "profiles:read", "library:organize"], label: "a4sx for VS Code" });
    assert.deepStrictEqual(h.log.opened, [`${BASE}/auth/cli/choose?code=PAIR`]);
    assert.ok(h.log.reports.every((r) => r.includes("ABCD-EFGH")));
    assert.deepStrictEqual(got, { token: TOKEN, server: BASE, id: "tok_9", scopes: ["library:read"], expiresAt: "2099-01-01T00:00:00Z" });
    assert.ok(net.seen.slice(1).every((r) => r.url === `${BASE}/auth/cli/poll?code=PAIR` && !r.headers.Authorization));
  });

  it("refuses to open a sign-in link on another site", async () => {
    const net = fakeFetch({ "POST /auth/cli/start": [{ status: 200, body: { ...start.body, login_url: "https://evil.example/login" } }] });
    const h = hooks();
    await assert.rejects(deviceLogin(clientWith(net.fetch), h.hooks), (e: any) => e.code === "bad-login-url");
    assert.deepStrictEqual(h.log.opened, []);
  });

  it("an expired pairing (404) and the token cap (429 too_many_tokens) end the login with a message", async () => {
    const gone = fakeFetch({ "POST /auth/cli/start": [start], "GET /auth/cli/poll": [{ status: 404, body: { error: { code: "bad_code" } } }] });
    await assert.rejects(deviceLogin(clientWith(gone.fetch), hooks().hooks), (e: any) => e.code === "expired");
    const cap = fakeFetch({ "POST /auth/cli/start": [start], "GET /auth/cli/poll": [{ status: 429, body: { error: { code: "too_many_tokens" } } }] });
    await assert.rejects(deviceLogin(clientWith(cap.fetch), hooks().hooks), (e: any) => e.code === "too-many-tokens" && /Agent keys/.test(e.message));
  });

  it("stops polling when the link's lifetime runs out, and when cancelled", async () => {
    const net = fakeFetch({ "POST /auth/cli/start": [{ status: 200, body: { ...start.body, expires_in: 10 } }], "GET /auth/cli/poll": [{ status: 202, body: { status: "pending" } }] });
    await assert.rejects(deviceLogin(clientWith(net.fetch), hooks().hooks), (e: any) => e.code === "expired");
    const net2 = fakeFetch({ "POST /auth/cli/start": [start], "GET /auth/cli/poll": [{ status: 202, body: { status: "pending" } }] });
    let n = 0;
    await assert.rejects(deviceLogin(clientWith(net2.fetch), hooks({ cancelled: () => ++n > 3 }).hooks), LoginCancelled);
  });

  it("a busy server at start is a short message", async () => {
    const net = fakeFetch({ "POST /auth/cli/start": [{ status: 429, body: { error: { code: "rate_limited" } } }] });
    await assert.rejects(deviceLogin(clientWith(net.fetch), hooks().hooks), (e: any) => e.code === "busy");
  });
});

describe("auth provider", () => {
  beforeEach(resetCalls);

  const login = async () => ({ token: TOKEN, server: BASE, id: "tok_1", scopes: ["library:read"] });

  it("is registered as 'a4sx', single account", () => {
    activateWith({});
    const reg = calls.authProviders.get("a4sx")!;
    assert.strictEqual(reg.label, "a4sx");
    assert.deepStrictEqual(reg.options, { supportsMultipleAccounts: false });
  });

  it("stores the token only in secret storage and reports a session for the current server", async () => {
    const secrets = fakeSecrets();
    const auth = new A4sxAuthProvider(secrets as any, ext.client, login);
    const events: any[] = [];
    auth.onDidChangeSessions((e) => events.push(e));
    const s = await auth.createSession();
    assert.strictEqual(s.accessToken, TOKEN);
    assert.deepStrictEqual(s.account, { id: "tok_1", label: "session-exchange.com" });
    assert.deepStrictEqual([...secrets.store_.keys()], [SECRET_KEY]);
    assert.strictEqual(events[0].added.length, 1);
    assert.strictEqual((await auth.getSessions()).length, 1);
    noTokenAnywhere();
  });

  it("a token from another server is not used after a4sx.serverUrl changes", async () => {
    const secrets = fakeSecrets();
    await secrets.store(SECRET_KEY, stored({ server: "https://other.example" }));
    const auth = new A4sxAuthProvider(secrets as any, ext.client, login);
    assert.strictEqual(await auth.token(), undefined);
    assert.deepStrictEqual(await auth.getSessions(), []);
  });

  it("an expired token is forgotten", async () => {
    const secrets = fakeSecrets();
    await secrets.store(SECRET_KEY, stored({ expiresAt: "2000-01-01T00:00:00Z" }));
    const auth = new A4sxAuthProvider(secrets as any, ext.client, login);
    assert.strictEqual(await auth.token(), undefined);
    assert.strictEqual(secrets.store_.size, 0);
  });

  it("sign out removes the token and says it stays valid until revoked", async () => {
    const { ctx } = activateWith({});
    await ctx.secrets.store(SECRET_KEY, stored());
    await calls.commands.get(ext.CMD_SIGN_OUT)!();
    assert.strictEqual(ctx.secrets.store_.size, 0);
    assert.deepStrictEqual(calls.infos, [ext.SIGNED_OUT_INFO]);
  });

  it("sign in: the command runs the login; a failure shows its short message, a cancel shows nothing", async () => {
    const { ctx } = activateWith({});
    ext.runtime.login = login;
    await calls.commands.get(ext.CMD_SIGN_IN)!();
    assert.strictEqual(JSON.parse(ctx.secrets.store_.get(SECRET_KEY)!).token, TOKEN);
    ext.runtime.login = async () => { throw new api.ApiError("expired", api.MESSAGES.expired); };
    await calls.commands.get(ext.CMD_SIGN_IN)!();
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [api.MESSAGES.expired]);
    ext.runtime.login = async () => { throw new LoginCancelled(); };
    await calls.commands.get(ext.CMD_SIGN_IN)!();
    assert.strictEqual(calls.errors.length, 1);
    noTokenAnywhere();
  });

  it("the real login runs in a progress notification and opens the browser", async () => {
    const net = fakeFetch({
      "POST /auth/cli/start": [{ status: 200, body: { code: "P", user_code: "WXYZ-1234", login_url: `${BASE}/auth/cli/choose?code=P`, expires_in: 600 } }],
      "GET /auth/cli/poll": [{ status: 200, body: { status: "ok", token: TOKEN, token_id: "t" } }],
    });
    const { vscodeLogin, timing } = await import("../../auth");
    const saved = timing.pollMs;
    timing.pollMs = 1;
    const got = await vscodeLogin(clientWith(net.fetch)).finally(() => { timing.pollMs = saved; });
    assert.strictEqual(got.token, TOKEN);
    assert.strictEqual(calls.progress[0].title, "Signing in to a4sx");
    assert.deepStrictEqual(calls.opened, [`${BASE}/auth/cli/choose?code=P`]);
    noTokenAnywhere();
  });
});

describe("My sessions view", () => {
  beforeEach(resetCalls);

  const rows = [
    { id: "c-old", title: "Old work", label: "old", updated_at: "2026-10-01T10:00:00Z", tokens: { current: 850 } },
    { id: "c-new", title: "Fix the login bug", updated_at: "2026-10-20T10:00:00Z", tokens: { current: 42_300, peak: 50_000 } },
    { id: "c-none" },
  ];

  it("signed out: no items, the welcome view shows (a4sx.signedIn = false), no request is made", async () => {
    const { sb, net } = activateWith({});
    assert.deepStrictEqual(await sb.sessions.getChildren(), []);
    assert.strictEqual(sb.sessions.state, "signed-out");
    assert.strictEqual(calls.context["a4sx.signedIn"], false);
    assert.strictEqual(net.seen.length, 0);
  });

  it("lists sessions newest first with date and size; items carry the session context", async () => {
    const { sb, ctx } = activateWith({ "GET /library/sessions": [{ status: 200, body: { sessions: rows } }] });
    await ctx.secrets.store(SECRET_KEY, stored());
    const items = (await sb.sessions.getChildren()) as SessionItem[];
    assert.deepStrictEqual(items.map((i) => i.label), ["Fix the login bug", "Old work", "c-none"]);
    assert.deepStrictEqual(items.map((i) => i.description), ["2026-10-20 · 42k tokens", "2026-10-01 · 850 tokens", ""]);
    assert.ok(items.every((i) => i.contextValue === "a4sx.session"));
    assert.strictEqual(sb.sessions.state, "ok");
    assert.strictEqual(calls.context["a4sx.signedIn"], true);
    assert.strictEqual(calls.context["a4sx.sessionsEmpty"], false);
  });

  it("an empty library sets a4sx.sessionsEmpty so the empty-state hint shows", async () => {
    const { sb, ctx } = activateWith({ "GET /library/sessions": [{ status: 200, body: { sessions: [] } }] });
    await ctx.secrets.store(SECRET_KEY, stored());
    assert.deepStrictEqual(await sb.sessions.getChildren(), []);
    assert.strictEqual(calls.context["a4sx.sessionsEmpty"], true);
  });

  it("a server error shows one short message item that refreshes on click", async () => {
    const { sb, ctx } = activateWith({ "GET /library/sessions": [{ status: 500, body: { error: { code: "internal", message: `boom ${TOKEN}` } } }] });
    await ctx.secrets.store(SECRET_KEY, stored());
    const items = await sb.sessions.getChildren();
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].label, api.MESSAGES.http(500));
    assert.strictEqual(items[0].command!.command, ext.CMD_REFRESH);
    assert.strictEqual(sb.sessions.state, "error");
  });

  it("a 401 forgets the token and goes back to the sign-in view", async () => {
    const { sb, ctx } = activateWith({ "GET /library/sessions": [{ status: 401 }] });
    await ctx.secrets.store(SECRET_KEY, stored());
    assert.deepStrictEqual(await sb.sessions.getChildren(), []);
    assert.strictEqual(ctx.secrets.store_.size, 0);
    assert.strictEqual(sb.sessions.state, "signed-out");
    assert.strictEqual(calls.context["a4sx.signedIn"], false);
    assert.deepStrictEqual(calls.warnings, [SIGNED_OUT_MESSAGE]);
    noTokenAnywhere();
  });

  it("formats sizes", () => {
    assert.strictEqual(formatTokens(undefined), undefined);
    assert.strictEqual(formatTokens(999), "999 tokens");
    assert.strictEqual(formatTokens(1_250_000), "1.3M tokens");
    assert.strictEqual(formatTokens(2_000_000), "2M tokens");
  });
});

describe("session commands", () => {
  beforeEach(resetCalls);
  const item = new SessionItem({ id: "c-123", label: "my-base", title: "Fix the login bug" });
  const unlabeled = new SessionItem({ id: "c-456" });
  const found = (p: string) => (): CliLookup => ({ found: true, path: p });

  it("Resume in terminal types `a4sx launch --a4sx-session=<id>` into the user's shell, quoted; the id, never the label", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "/usr/bin";
    try {
      await ext.resumeSession(item, found("/usr/local/bin/a4sx"));
      await ext.resumeSession(unlabeled, found("/usr/local/bin/a4sx"));
    } finally {
      process.env.PATH = savedPath;
    }
    assert.deepStrictEqual(calls.terminals.map((t) => t.options), [{ name: ext.RESUME_TERMINAL_NAME }, { name: ext.RESUME_TERMINAL_NAME }]);
    assert.deepStrictEqual(calls.terminals.map((t) => t.sent), [
      ["'/usr/local/bin/a4sx' 'launch' '--a4sx-session=c-123'\n"],
      ["'/usr/local/bin/a4sx' 'launch' '--a4sx-session=c-456'\n"],
    ]);
    assert.ok(calls.terminals.every((t) => t.shown));
  });

  it("Resume without the a4sx CLI and without claude shows Claude Code's install hint and runs nothing", async () => {
    await ext.resumeSession(item, () => ({ found: false, reason: "not-on-path" }), undefined, () => undefined);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.errors[0].items, ["How to install"]);
  });

  it("Open on the web, Copy session id; palette calls without an item do nothing", async () => {
    activateWith({});
    await calls.commands.get(ext.CMD_OPEN_SESSION)!(item);
    await calls.commands.get(ext.CMD_COPY_ID)!(item);
    assert.deepStrictEqual(calls.opened, [`${BASE}/library/session/c-123`]);
    assert.strictEqual(calls.clipboard, "c-123");
    assert.deepStrictEqual(calls.infos, [ext.COPIED_INFO]);
    for (const id of [ext.CMD_RESUME, ext.CMD_OPEN_SESSION, ext.CMD_COPY_ID, ext.CMD_OPEN_LISTING]) {
      await calls.commands.get(id)!();
    }
    assert.strictEqual(calls.opened.length, 1);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("links follow a4sx.serverUrl; a bad value is a short error, nothing opens", async () => {
    activateWith({});
    calls.config["a4sx.serverUrl"] = "https://staging.example.com";
    await calls.commands.get(ext.CMD_OPEN_SESSION)!(item);
    assert.deepStrictEqual(calls.opened, ["https://staging.example.com/library/session/c-123"]);
    calls.config["a4sx.serverUrl"] = "http://staging.example.com";
    await calls.commands.get(ext.CMD_OPEN_SESSION)!(item);
    assert.strictEqual(calls.opened.length, 1);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [api.MESSAGES.badServerUrl]);
  });
});

describe("Marketplace view", () => {
  beforeEach(resetCalls);

  it("starts empty (the welcome view offers search), then lists results with a price", async () => {
    const { sb, net } = activateWith({ "GET /memory/discover": [{ status: 200, body: { items: [
      { id: "L1", title: "Terraform 1.9 upgrade", tenant: "default", price_cents: 0 },
      { id: "L2", title: "Rust async", tenant: "acme", price_cents: 490, currency: "eur" },
    ] } }] });
    assert.deepStrictEqual(await sb.market.getChildren(), []);
    assert.strictEqual(net.seen.length, 0);
    calls.nextInput = "terraform";
    await calls.commands.get(ext.CMD_SEARCH)!();
    assert.strictEqual(sb.market.query, "terraform");
    const items = (await sb.market.getChildren()) as ListingItem[];
    assert.deepStrictEqual(items.map((i) => [i.label, i.description]), [["Terraform 1.9 upgrade", "Free"], ["Rust async", "4.90 EUR"]]);
    assert.strictEqual(net.seen[0].headers.Authorization, undefined, "search is anonymous, even when signed in");
    await calls.commands.get(items[1].command!.command)!(...items[1].command!.arguments!);
    assert.deepStrictEqual(calls.opened, [`${BASE}/marketplace/L2?t=acme`]);
  });

  it("Esc in the search box keeps the current results; no match and errors are one message item", async () => {
    const { sb } = activateWith({ "GET /memory/discover": [{ status: 200, body: { items: [] } }] });
    sb.market.search("zzz");
    calls.nextInput = undefined;
    await calls.commands.get(ext.CMD_SEARCH)!();
    assert.strictEqual(sb.market.query, "zzz");
    assert.deepStrictEqual((await sb.market.getChildren()).map((i) => i.label), [NO_RESULTS("zzz")]);
    const down = new MarketplaceProvider(() => clientWith(fakeFetch({ "GET /memory/discover": [new Error("offline")] }).fetch));
    down.search("x");
    assert.deepStrictEqual((await down.getChildren()).map((i) => i.label), [api.MESSAGES.unreachable]);
  });
});

describe("SessionsProvider without activate", () => {
  it("reports state through the callback", async () => {
    const states: string[] = [];
    const p = new SessionsProvider({ token: async () => undefined, clear: async () => undefined }, () => clientWith(fakeFetch({}).fetch), (s) => states.push(s));
    await p.getChildren();
    assert.deepStrictEqual(states, ["signed-out"]);
  });
});
