// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.3.1 zero-setup resume: Resume in Claude Code and Resume in terminal without the a4sx CLI, the
// no-folder pick and the pending action that finishes after the window reopens, the one-time CLI hint
// and the profiles:read prompt. The server is faked; files go to a temp HOME / CLAUDE_CONFIG_DIR.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, fakeMemento, fakeSecrets, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import * as api from "../../api";
import * as cr from "../../claudeResume";
import { LoginRequest, SECRET_KEY } from "../../auth";
import {
  CLAUDE_INSTALL_URL, CLI_HINT_KEY, offerProfilesStepUp, PENDING_KEY, resetPromptForTests, RESUME_TEXTS, sameFolder, STEP_UP_SNOOZE_KEY,
  STEP_UP_SNOOZE_MS, takePending, validPending,
} from "../../resume";
import { SessionItem } from "../../sessionsView";
import { STEP_UP } from "../../stepUp";
import type { CliLookup } from "../../cli";

const ID = "3f2b8c1e-9a4d-4e6f-8b2a-0c1d2e3f4a5b";
const TOKEN = "lib_tok_SECRET_resume_777";
const BASE = "https://session-exchange.com";
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAUDE = "/usr/local/bin/claude";
const missing = (): CliLookup => ({ found: false, reason: "not-on-path" });
const foundCli = (): CliLookup => ({ found: true, path: "/usr/local/bin/a4sx" });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscodeFake = require("vscode");
const folder = (name: string, p: string) => ({ name, uri: vscodeFake.Uri.file(p) });

const transcript = [
  JSON.stringify({ type: "user", sessionId: "base-1", message: { content: "hello" } }),
  JSON.stringify({ type: "assistant", sessionId: "base-1", message: { content: "hi" } }),
].join("\n");
const fetchBody = (t = transcript, harness: unknown = "claude-code") => ({
  status: 200, body: { harness, members: [{ kind: "session", id: "s1", files: [{ path: "transcript.jsonl", content_b64: Buffer.from(t).toString("base64") }] }] },
});

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

const savedRuntime = { ...ext.runtime };
let home: string;
const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

function rmTree(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isDirectory()) {
      rmTree(p);
    } else {
      fs.unlinkSync(p);
    }
  }
  fs.rmdirSync(dir);
}

beforeEach(() => {
  resetCalls();
  resetPromptForTests();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-home-"));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, "claude-cfg");
  calls.extensions.add("anthropic.claude-code");
});

afterEach(() => {
  Object.assign(ext.runtime, savedRuntime);
  process.env.HOME = saved.HOME;
  if (saved.CLAUDE_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
  }
  rmTree(home);
});

const FULL = ["library:read", "profiles:read", "library:organize"];

async function activateWith(routes: Record<string, Answer[]>, scopes: string[] | null = FULL, state = fakeMemento()) {
  const net = fakeFetch(routes);
  ext.runtime.fetch = net.fetch;
  const logins: LoginRequest[] = [];
  ext.runtime.login = async (_c, req) => {
    logins.push(req);
    return { token: "lib_tok_NEW_888", server: BASE, id: "t2", scopes: [...req.scopes] };
  };
  const ctx = { subscriptions: [] as { dispose(): unknown }[], secrets: fakeSecrets(), globalState: state };
  ext.activate(ctx as any);
  if (scopes) {
    await ctx.secrets.store(SECRET_KEY, JSON.stringify({ token: TOKEN, server: BASE, id: "t1", scopes }));
  }
  return { ctx, net, logins, state };
}

const seededFiles = (cwd: string) => {
  const dir = path.join(home, "claude-cfg", "projects", cwd.replace(/[^A-Za-z0-9]/gu, "-"));
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const item = new SessionItem({ id: "c-123", label: "my-base", title: "Fix the login bug", version: "v7" });
const tick = () => new Promise((r) => setImmediate(r));

function noTokenAnywhere(): void {
  const shown = JSON.stringify([calls.errors, calls.infos, calls.warnings, calls.modals, calls.progress, calls.terminals.map((t) => t.options), calls.opened]);
  assert.ok(!shown.includes(TOKEN), "the key never shows up in a message, a terminal or a link");
}

describe("Resume in Claude Code: helpers", () => {
  it("only a UUID goes into the link; the link uses the editor's own scheme", () => {
    assert.strictEqual(cr.parseSessionId(`  ${ID}\n`), ID);
    for (const bad of ["", `${ID}\n${ID}`, `${ID}&x=1`, "not-a-uuid", "../x"]) {
      assert.strictEqual(cr.parseSessionId(bad), undefined, bad);
    }
    assert.strictEqual(cr.claudeResumeUri("vscode-insiders", ID), `vscode-insiders://anthropic.claude-code/open?session=${ID}`);
  });
});

describe("Resume in Claude Code: native, no CLI", () => {
  it("fetches the session with the extension's key, copies it into the open folder's history and opens it", async () => {
    calls.workspaceFolders = [folder("proj", "/w/proj")];
    const { net } = await activateWith({ "GET /library/fetch": [fetchBody()] });
    await ext.resumeInClaude(item);
    const req = net.seen.find((r) => r.url.includes("/library/fetch"))!;
    assert.strictEqual(new URL(req.url).searchParams.get("cid"), "c-123");
    assert.strictEqual(req.headers.Authorization, `Bearer ${TOKEN}`);
    const [file] = seededFiles("/w/proj");
    const id = file.replace(/\.jsonl$/, "");
    assert.match(id, UUID4);
    const recs = fs.readFileSync(path.join(home, "claude-cfg", "projects", "-w-proj", file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepStrictEqual(recs.map((r) => r.sessionId), [id, id]);
    assert.deepStrictEqual(calls.opened, [`vscode://anthropic.claude-code/open?session=${id}`]);
    assert.deepStrictEqual(calls.progress.map((p) => [p.title, p.options.cancellable]), [[ext.CLAUDE_MESSAGES.progress, true]]);
    assert.strictEqual(calls.terminals.length, 0, "no CLI runs");
    assert.deepStrictEqual(calls.errors, []);
    noTokenAnywhere();
  });

  it("not signed in: says so with a Sign in button; nothing is fetched", async () => {
    calls.workspaceFolders = [folder("proj", "/w/proj")];
    const { net } = await activateWith({}, null);
    await ext.resumeInClaude(item);
    assert.deepStrictEqual(calls.errors, [{ message: STEP_UP.signInFirst, items: [STEP_UP.signIn] }]);
    assert.strictEqual(net.seen.length, 0);
  });

  it("failures are short messages: another harness, a gone session, a bad transcript; a cancel shows nothing", async () => {
    calls.workspaceFolders = [folder("proj", "/w/proj")];
    await activateWith({ "GET /library/fetch": [
      { status: 404, body: { error: { code: "not_found" } } },
      fetchBody(JSON.stringify({ sessionId: "../../etc/passwd" })),
      fetchBody(transcript, { id: "codex-cli" }),
    ] });
    await ext.resumeInClaude(new SessionItem({ id: "c-x", harness: "codex-cli" }));
    await ext.resumeInClaude(item);
    await ext.resumeInClaude(item);
    await ext.resumeInClaude(item);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [
      api.MESSAGES.notClaudeCode, api.MESSAGES.sessionGone, RESUME_TEXTS.badSessionId, api.MESSAGES.notClaudeCode,
    ]);
    assert.deepStrictEqual(seededFiles("/w/proj"), []);
    assert.deepStrictEqual(calls.opened, []);
    resetCalls();
    calls.extensions.add("anthropic.claude-code");
    calls.workspaceFolders = [folder("proj", "/w/proj")];
    calls.cancelProgress = true;
    await activateWith({ "GET /library/fetch": [fetchBody()] });
    await ext.resumeInClaude(item);
    assert.deepStrictEqual(calls.errors, []);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("a timeout or a dropped connection while the body downloads is the network error, not 'no transcript'", async () => {
    calls.workspaceFolders = [folder("proj", "/w/proj")];
    await activateWith({});
    for (const err of [Object.assign(new TypeError("terminated"), {}), Object.assign(new Error("The operation was aborted"), { name: "AbortError" })]) {
      ext.runtime.fetch = async () => ({ status: 200, json: async () => { throw err; } });
      await ext.resumeInClaude(item);
    }
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [api.MESSAGES.unreachable, api.MESSAGES.unreachable]);
    assert.deepStrictEqual(seededFiles("/w/proj"), []);
  });

  it("multi-root asks which folder; virtual folders only: says a folder on disk is needed", async () => {
    calls.workspaceFolders = [folder("a", "/w/a"), folder("b", "/w/b")];
    await activateWith({ "GET /library/fetch": [fetchBody()] });
    calls.nextPick = 1;
    await ext.resumeInClaude(item);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.label), ["a", "b"]);
    assert.strictEqual(seededFiles("/w/b").length, 1);
    calls.workspaceFolders = [{ name: "v", uri: { scheme: "vscode-vfs", fsPath: "/v", toString: () => "vscode-vfs:/v" } } as any];
    await ext.resumeInClaude(item);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [ext.CLAUDE_MESSAGES.notOnDisk]);
  });

  it("without the Claude Code extension: says so and offers to show it", async () => {
    calls.extensions.clear();
    await activateWith({});
    calls.nextErrorChoice = ext.SHOW_EXTENSION;
    await ext.resumeInClaude(item);
    assert.deepStrictEqual(calls.errors, [{ message: ext.CLAUDE_MESSAGES.noClaude, items: [ext.SHOW_EXTENSION] }]);
    assert.deepStrictEqual(calls.executed.filter((e) => e.id === "workbench.extensions.search"), [{ id: "workbench.extensions.search", args: ["@id:anthropic.claude-code"] }]);
  });

  it("if the editor can't open the link, a short error", async () => {
    calls.workspaceFolders = [folder("proj", "/w/proj")];
    calls.openResult = false;
    await activateWith({ "GET /library/fetch": [fetchBody()] });
    await ext.resumeInClaude(item);
    assert.deepStrictEqual(calls.errors, [{ message: ext.CLAUDE_MESSAGES.openFailed, items: [] }]);
  });
});

describe("no folder open: pick one, reopen on it, finish there", () => {
  it("offers the home folder, a folder from the dialog, or Cancel", async () => {
    await activateWith({ "GET /library/fetch": [fetchBody()] });
    calls.nextPick = 2;
    await ext.resumeInClaude(item);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.label), [RESUME_TEXTS.useHome, RESUME_TEXTS.chooseFolder, RESUME_TEXTS.cancel]);
    calls.nextPick = 1;
    calls.nextOpenDialog = undefined;
    await ext.resumeInClaude(item);
    assert.deepStrictEqual(calls.openDialogs.map((o) => [o.canSelectFolders, o.canSelectFiles, o.canSelectMany, o.defaultUri.fsPath, o.openLabel]),
      [[true, false, false, home, RESUME_TEXTS.openLabel]], "the dialog starts at the home of the host the extension runs on");
    assert.deepStrictEqual(calls.executed.filter((e) => e.id === "vscode.openFolder"), [], "Cancel and Esc do nothing");
    assert.deepStrictEqual(seededFiles(home), []);
  });

  it("'Use my home folder' seeds there, stores the pending action, reopens the window; the new window opens Claude Code", async () => {
    const state = fakeMemento();
    await activateWith({ "GET /library/fetch": [fetchBody()] }, FULL, state);
    calls.nextPick = 0;
    const before = Date.now();
    await ext.resumeInClaude(item);
    const [file] = seededFiles(home);
    const id = file.replace(/\.jsonl$/, "");
    const pending = state.data_.get(PENDING_KEY) as any;
    assert.deepStrictEqual({ ...pending, at: undefined }, { kind: "claude", sessionId: id, folderUri: vscodeFake.Uri.file(home).toString(), at: undefined });
    assert.ok(pending.at >= before && pending.at <= Date.now());
    const open = calls.executed.filter((e) => e.id === "vscode.openFolder");
    assert.strictEqual(open.length, 1);
    assert.strictEqual(String(open[0].args[0]), vscodeFake.Uri.file(home).toString());
    assert.deepStrictEqual(open[0].args[1], { forceNewWindow: false });
    assert.deepStrictEqual(calls.opened, [], "nothing opens before the window reopens");

    // the window reloads on the folder: the extension activates again with the same globalState
    resetCalls();
    calls.extensions.add("anthropic.claude-code");
    calls.workspaceFolders = [folder("home", home)];
    await activateWith({}, null, state);
    await tick();
    assert.deepStrictEqual(calls.opened, [`vscode://anthropic.claude-code/open?session=${id}`]);
    assert.strictEqual(state.data_.has(PENDING_KEY), false, "done: cleared");
  });

  it("'Choose a folder…' seeds into the folder from the dialog", async () => {
    await activateWith({ "GET /library/fetch": [fetchBody()] });
    calls.nextPick = 1;
    calls.nextOpenDialog = [vscodeFake.Uri.file("/w/other")];
    await ext.resumeInClaude(item);
    assert.strictEqual(seededFiles("/w/other").length, 1);
    assert.strictEqual(String(calls.executed.find((e) => e.id === "vscode.openFolder")!.args[0]), "file:///w/other");
  });

  it("a pending action is validated, runs only in its folder within 2 minutes, and is always cleared", async () => {
    const uri = vscodeFake.Uri.file("/w/p").toString();
    const open = [{ uri: vscodeFake.Uri.file("/w/p") }];
    const now = 1_000_000;
    const ok = { kind: "terminal", sessionId: ID, folderUri: uri, at: now - 1000 };
    for (const [raw, expect] of [
      [ok, true],
      [{ ...ok, at: now - 2 * 60_000 - 1 }, false],
      [{ ...ok, at: now + 5000 }, false],
      [{ ...ok, folderUri: "file:///w/other" }, false],
      [{ ...ok, sessionId: "../../x" }, false],
      [{ ...ok, kind: "shell" }, false],
      [{ ...ok, at: "soon" }, false],
      ["junk", false],
    ] as [unknown, boolean][]) {
      const state = fakeMemento({ [PENDING_KEY]: raw });
      const got = await takePending(state, open, now);
      assert.strictEqual(!!got, expect, JSON.stringify(raw));
      assert.strictEqual(state.data_.has(PENDING_KEY), false, "cleared either way");
    }
    assert.strictEqual(validPending({ ...ok, folderUri: "x".repeat(5000) }), undefined);
  });

  it("the folder matches across the reload when the window reports it as vscode-remote and the host stored file", () => {
    const remote = { scheme: "vscode-remote", fsPath: "/home/dev/p", toString: () => "vscode-remote://ssh-remote%2Bbox/home/dev/p" };
    assert.strictEqual(sameFolder(remote, "file:///home/dev/p"), true);
    assert.strictEqual(sameFolder(remote, "file:///home/dev/other"), false);
    assert.strictEqual(sameFolder({ scheme: "vscode-vfs", fsPath: "/home/dev/p", toString: () => "vscode-vfs://x/home/dev/p" }, "file:///home/dev/p"), false);
  });
});

describe("Resume in terminal without the a4sx CLI", () => {
  it("seeds natively and runs `claude --resume <id>` in the folder, shell-free, with nothing secret in argv or env", async () => {
    calls.workspaceFolders = [folder("proj", "/w/proj")];
    await activateWith({ "GET /library/fetch": [fetchBody()] });
    const t = await ext.resumeSession(item, missing, undefined, () => CLAUDE);
    assert.ok(t);
    const [file] = seededFiles("/w/proj");
    const id = file.replace(/\.jsonl$/, "");
    assert.strictEqual(calls.terminals.length, 1);
    const opts = calls.terminals[0].options;
    assert.deepStrictEqual({ ...opts, cwd: String(opts.cwd) }, { name: ext.RESUME_TERMINAL_NAME, shellPath: CLAUDE, shellArgs: ["--resume", id], cwd: "file:///w/proj" });
    assert.ok(!("env" in opts), "no env: the key is never handed to claude");
    assert.ok(calls.terminals[0].shown);
    noTokenAnywhere();
  });

  it("once: launch profiles need the a4sx CLI; 'Install a4sx' runs the safe-origin installer line", async () => {
    calls.workspaceFolders = [folder("proj", "/w/proj")];
    const { state } = await activateWith({ "GET /library/fetch": [fetchBody()] });
    calls.nextInfoChoice = RESUME_TEXTS.installA4sx;
    await ext.resumeSession(item, missing, undefined, () => CLAUDE);
    await tick();
    assert.deepStrictEqual(calls.infoPrompts, [{ message: RESUME_TEXTS.cliForProfiles, items: [RESUME_TEXTS.installA4sx, RESUME_TEXTS.notNow] }]);
    assert.strictEqual(state.data_.get(CLI_HINT_KEY), true);
    if (process.platform !== "win32") {
      assert.deepStrictEqual(calls.terminals[1].options, {
        name: RESUME_TEXTS.installTerminal, shellPath: "/bin/sh", shellArgs: ["-c", "curl -fsSL https://session-exchange.com/install.sh | sh"],
      });
    }
    await ext.resumeSession(item, missing, undefined, () => CLAUDE);
    await tick();
    assert.strictEqual(calls.infoPrompts.length, 1, "only once");
  });

  it("without claude either: a short message whose button opens the Claude Code install docs; nothing is fetched", async () => {
    calls.workspaceFolders = [folder("proj", "/w/proj")];
    const { net } = await activateWith({});
    calls.nextErrorChoice = "How to install";
    await ext.resumeSession(item, missing, undefined, () => undefined);
    assert.deepStrictEqual(calls.errors, [{ message: RESUME_TEXTS.noClaude, items: ["How to install"] }]);
    assert.deepStrictEqual(calls.opened, [CLAUDE_INSTALL_URL]);
    assert.strictEqual(net.seen.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("no folder open: seeds into the picked folder, reopens, then the terminal starts in the new window", async () => {
    const state = fakeMemento();
    await activateWith({ "GET /library/fetch": [fetchBody()] }, FULL, state);
    calls.nextPick = 0;
    await ext.resumeSession(item, missing, undefined, () => CLAUDE);
    assert.strictEqual(calls.terminals.length, 0);
    const pending = state.data_.get(PENDING_KEY) as any;
    assert.strictEqual(pending.kind, "terminal");
    resetCalls();
    calls.workspaceFolders = [folder("home", home)];
    await ext.completePendingResume(state, () => CLAUDE);
    assert.deepStrictEqual(calls.terminals.map((t) => [t.options.shellPath, t.options.shellArgs, String(t.options.cwd)]), [
      [CLAUDE, ["--resume", pending.sessionId], vscodeFake.Uri.file(home).toString()],
    ]);
    assert.strictEqual(state.data_.has(PENDING_KEY), false);
  });

  it("with the a4sx CLI, Resume in terminal is unchanged; an invalid a4sx.cliPath still says so", async () => {
    calls.workspaceFolders = [folder("proj", "/w/proj")];
    const { net } = await activateWith({});
    await ext.resumeSession(item, foundCli, async () => ({}), () => CLAUDE);
    assert.deepStrictEqual(calls.terminals[0].options, { name: ext.RESUME_TERMINAL_NAME, shellPath: "/usr/local/bin/a4sx", shellArgs: ["launch", "--a4sx-session=my-base"] });
    await ext.resumeSession(item, () => ({ found: false, reason: "configured-path-invalid", configured: "/nope/a4sx" }), undefined, () => CLAUDE);
    assert.match(calls.errors[0].message, /a4sx\.cliPath setting points to "\/nope\/a4sx"/);
    assert.strictEqual(net.seen.length, 0);
  });
});

describe("the profiles:read prompt", () => {
  const refusal = { status: 403, body: { error: { code: "insufficient_scope", details: { required_scope: "profiles:read" } } } };
  const keyWith = async (scopes: string[]) => {
    const auth = ext.sidebar!.auth;
    await (auth as any).secrets.store(SECRET_KEY, JSON.stringify({ token: TOKEN, server: BASE, id: "t1", scopes }));
    return auth;
  };

  it("a key without profiles:read on a server that offers it: one prompt; Allow runs the step-up", async () => {
    const { logins } = await activateWith({ "GET /library/profiles": [refusal] }, null);
    const auth = await keyWith(["library:read"]);
    calls.nextInfoChoice = RESUME_TEXTS.allow;
    await offerProfilesStepUp(auth, ext.client, fakeMemento(), Date.now());
    assert.deepStrictEqual(calls.infoPrompts, [{ message: RESUME_TEXTS.profilesStepUp, items: [RESUME_TEXTS.allow, RESUME_TEXTS.notNow] }]);
    assert.deepStrictEqual(logins.map((l) => l.adding), ["profiles:read"]);
    assert.strictEqual(calls.modals.length, 0, "the prompt already named the permission");
  });

  it("'Not now' is remembered for 7 days; then it asks again", async () => {
    const { net } = await activateWith({ "GET /library/profiles": [refusal] }, null);
    const auth = await keyWith(["library:read"]);
    const state = fakeMemento();
    const now = 5_000_000;
    calls.nextInfoChoice = RESUME_TEXTS.notNow;
    await offerProfilesStepUp(auth, ext.client, state, now);
    assert.strictEqual(state.data_.get(STEP_UP_SNOOZE_KEY), now + STEP_UP_SNOOZE_MS);
    const asked = net.seen.length;
    resetPromptForTests();   // a new window
    await offerProfilesStepUp(auth, ext.client, state, now + STEP_UP_SNOOZE_MS - 1);
    assert.strictEqual(calls.infoPrompts.length, 1);
    assert.strictEqual(net.seen.length, asked, "snoozed: not even a request");
    resetPromptForTests();
    await offerProfilesStepUp(auth, ext.client, state, now + STEP_UP_SNOOZE_MS + 1);
    assert.strictEqual(calls.infoPrompts.length, 2);
  });

  it("Esc (or leaving it in the notification centre) counts as 'Not now' for this window only", async () => {
    const { net } = await activateWith({ "GET /library/profiles": [refusal] }, null);
    const auth = await keyWith(["library:read"]);
    const state = fakeMemento();
    calls.nextInfoChoice = undefined;
    await offerProfilesStepUp(auth, ext.client, state, 1);
    assert.strictEqual(calls.infoPrompts.length, 1);
    assert.strictEqual(state.data_.has(STEP_UP_SNOOZE_KEY), false, "no 7-day snooze");
    const asked = net.seen.length;
    for (let i = 0; i < 5; i++) {
      await offerProfilesStepUp(auth, ext.client, state, 2 + i);   // sign-in, other triggers in the same window
    }
    assert.strictEqual(calls.infoPrompts.length, 1, "never twice in one window");
    assert.strictEqual(net.seen.length, asked, "and no more requests");
    resetPromptForTests();
    await offerProfilesStepUp(auth, ext.client, state, 10);
    assert.strictEqual(calls.infoPrompts.length, 2, "a new window asks again");
  });

  it("two triggers at once (activation and sign-in) show one prompt", async () => {
    await activateWith({ "GET /library/profiles": [refusal] }, null);
    const auth = await keyWith(["library:read"]);
    await Promise.all([offerProfilesStepUp(auth, ext.client, fakeMemento(), 1), offerProfilesStepUp(auth, ext.client, fakeMemento(), 1)]);
    assert.strictEqual(calls.infoPrompts.length, 1);
  });

  it("no prompt when the key has profiles:read, or the server doesn't offer launch profiles", async () => {
    const { net } = await activateWith({ "GET /library/profiles": [{ status: 403, body: { error: { code: "insufficient_scope", details: { required_scope: null } } } }] }, null);
    let auth = await keyWith(["library:read", "profiles:read"]);
    await offerProfilesStepUp(auth, ext.client, fakeMemento(), Date.now());
    assert.strictEqual(net.seen.length, 0);
    auth = await keyWith(["library:read"]);
    resetPromptForTests();
    await offerProfilesStepUp(auth, ext.client, fakeMemento(), Date.now());
    assert.strictEqual(net.seen.length, 1);
    assert.strictEqual(calls.infoPrompts.length, 0, "an older server: nothing to offer");
  });
});

describe("manifest", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));

  it("Resume in Claude Code sits next to Resume in terminal and is hidden from the palette", () => {
    const menu = pkg.contributes.menus["view/item/context"].filter((m: any) => m.when === "view == a4sx.sessions && viewItem =~ /^a4sx\\.session(\\.filed)?$/");
    const group = (cmd: string, prefix: string) => menu.find((m: any) => m.command === cmd && m.group.startsWith(prefix))?.group;
    assert.strictEqual(group(ext.CMD_RESUME, "inline"), "inline@1");
    assert.strictEqual(group(ext.CMD_RESUME_CLAUDE, "inline"), "inline@2");
    assert.ok(pkg.contributes.menus.commandPalette.some((m: any) => m.command === ext.CMD_RESUME_CLAUDE && m.when === "false"));
  });

  it("activates at startup (to finish a pending resume) and shows Launch profiles expanded", () => {
    assert.deepStrictEqual(pkg.activationEvents, ["onStartupFinished"]);
    assert.strictEqual(pkg.contributes.views.a4sx.find((v: any) => v.id === "a4sx.profiles").visibility, "visible");
    assert.strictEqual(pkg.version, "0.3.1");
  });

  it("the registered command, without an item (palette), does nothing", async () => {
    await activateWith({});
    await calls.commands.get(ext.CMD_RESUME_CLAUDE)!();
    assert.deepStrictEqual(calls.errors, []);
    assert.strictEqual(calls.progress.length, 0);
  });
});
