// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// "Open deck": the bundled deck in one terminal; its starts checked, opened visibly and logged.
import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { CellCommandDeps, startDeckRequest } from "../../cellCommands";
import { CellsProvider, CliOutput } from "../../cellsView";
import {
  checkDeckRequest, closeStaleDecks, Deck, DECK_SHA256, DECK_TEXTS, DeckDeps, DeckRequest, deckEnv, deckFolderOk, deckLaunchArgs, RateLimit,
  sha256File, takeRequests,
} from "../../deck";

const EXT = path.join(__dirname, "..", "..", "..");
const NONCE = "ab".repeat(16);
const ALLOWED = [
  ["launch", "--cell", "bob-cell"], ["launch", "--cell", "bob-cell", "--new-session"],
  ["launch", "--cell", "bob-cell", "--a4sx-session", "handoff-bob-cell"], ["launch", "--cell"], ["launch", "--a4sx-session", "my.saved_1"],
];
const REFUSED: unknown[] = [
  ["mesh", "cell", "rename", "a", "b"], ["delete", "x"], ["mesh", "permit", "m", "a", "b", "--none"], ["agent-host"], ["login"],
  ["launch"], ["launch", "--join", "-"], ["launch", "--cell", "a", "--as", "b"], ["launch", "--cell", "a", "--cell", "b"],
  ["launch", "--cell", "Bad_Name"], ["launch", "--a4sx-session", "has space"], ["launch", "--a4sx-session"],
  ["launch", "--a4sx-session", "-x"], ["launch", "--new-session"], ["launch", "--cell", "a", "--a4sx-session", "s", "--new-session"],
  ["launch", "--cell", "a;rm"], ["launch", "--cell", 7], "launch --cell a", null,
];

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deck-test-"));   // 0700
}

/** A stand-in home folder (0700) and a project folder in it. */
const HOME = fs.realpathSync(tmp());
const WORK = path.join(HOME, "projects", "bob-cell");
fs.mkdirSync(WORK, { recursive: true, mode: 0o700 });
const WHERE = { home: HOME };

function request(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, nonce: NONCE, label: "bob-cell", cwd: WORK, args: ["launch", "--cell", "bob-cell"], ...over });
}

function findPython(): string | undefined {
  for (const c of ["python3", "python"]) {
    try {
      execFileSync(c, ["-c", "import sys; assert sys.version_info >= (3, 10)"], { stdio: "ignore" });
      return c;
    } catch {
      // next
    }
  }
  return undefined;
}

/** Runs a function of the bundled deck.py (never writing bytecode next to it). */
function deckPy(py: string, body: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const script = "import importlib.util, json, sys\n"
    + "s = importlib.util.spec_from_file_location('d', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)\n"
    + body;
  return execFileSync(py, ["-I", "-B", "-c", script, path.join(EXT, "deck", "deck.py"), ...args], { encoding: "utf8", env });
}

describe("Open deck: the allow-list", () => {
  it("takes every start the deck sends and nothing else", () => {
    for (const a of ALLOWED) {
      assert.deepStrictEqual(deckLaunchArgs(a), a);
    }
    for (const a of REFUSED) {
      assert.strictEqual(deckLaunchArgs(a), undefined, JSON.stringify(a));
    }
  });

  it("is the same list as the bundled deck.py's own, and so is the folder check", function () {
    const py = findPython();
    if (!py) {
      this.skip();
    }
    const cases = [...ALLOWED, ...REFUSED].filter((a) => Array.isArray(a));
    const out = JSON.parse(deckPy(py!, "print(json.dumps([m.vscode_request_args(a) for a in json.loads(sys.argv[2])]))", [JSON.stringify(cases)]));
    assert.deepStrictEqual(out, cases.map((a) => deckLaunchArgs(a) ?? null));
    const names = ["plain", "tab\there", "rtl\u202eabc", "zw\u200bsp", "line\u2028sep", "nel\x85", "priv\ue000", "ümlaut é"];
    const pyOk = JSON.parse(deckPy(py!, "print(json.dumps([m.vscode_plain_folder(n) for n in json.loads(sys.argv[2])]))", [JSON.stringify(names)]));
    const tsOk = names.map((n) => {
      const d = path.join(HOME, n);
      try {
        fs.mkdirSync(d);
      } catch {
        return null;   // a name this file system refuses
      }
      return deckFolderOk(d, WHERE);
    });
    names.forEach((n, i) => tsOk[i] !== null && assert.strictEqual(tsOk[i], pyOk[i], JSON.stringify(n)));
  });
});

describe("Open deck: the real deck.py and this check agree", () => {
  it("a start the bundled deck writes in VS Code mode is taken here as it was sent", function () {
    const py = findPython();
    if (!py) {
      this.skip();
    }
    const chan = tmp();
    const out = deckPy(py!, "m.run = m.jrun = None\n"
      + "print(m.new_tab('bob-cell', sys.argv[2], [*m.A4SX_ARGV, 'launch', '--cell', 'bob-cell', '--new-session'], cell='bob-cell'))",
    [WORK], { ...process.env, A4SX_DECK_HOST: "vscode", A4SX_DECK_CHANNEL: chan, A4SX_DECK_NONCE: NONCE });
    assert.ok(out.includes("asked VS Code to open the terminal «a4sx: bob-cell»"), out);
    const got = takeRequests(chan);
    assert.strictEqual(got.length, 1);
    assert.deepStrictEqual(checkDeckRequest(got[0], NONCE, WHERE),
      { ok: true, req: { label: "bob-cell", cwd: WORK, args: ["launch", "--cell", "bob-cell", "--new-session"] } });
  });
});

describe("Open deck: a request", () => {
  it("is taken with its nonce, a plain label and a folder in the home folder", () => {
    assert.deepStrictEqual(checkDeckRequest(request(), NONCE, WHERE),
      { ok: true, req: { label: "bob-cell", cwd: WORK, args: ["launch", "--cell", "bob-cell"] } });
  });

  it("is refused for a wrong or missing nonce, another version, or text that isn't one, without saying more", () => {
    for (const t of [request({ nonce: "cd".repeat(16) }), request({ nonce: undefined }), request({ nonce: NONCE.slice(1) }), request({ v: 2 }), "{", "[]", ""]) {
      assert.deepStrictEqual(checkDeckRequest(t, NONCE, WHERE), { ok: false, why: DECK_TEXTS.unreadable }, t);
    }
    assert.strictEqual(checkDeckRequest(request(), "", WHERE).ok, false);   // no deck open: nothing is taken
  });

  it("is refused for a label that isn't plain ASCII (no right-to-left or zero-width name), and names what was asked", () => {
    for (const label of ["a\nb", "\x1b[31mx", "", "x".repeat(41), "evil\u202elleh", "bob\u200b", "bob\u00a0cell", 7]) {
      assert.deepStrictEqual(checkDeckRequest(request({ label }), NONCE, WHERE), { ok: false, why: "a4sx launch" }, JSON.stringify(label));
    }
    assert.deepStrictEqual(checkDeckRequest(request({ args: ["delete", "x"] }), NONCE, WHERE), { ok: false, why: "a4sx delete" });
    assert.deepStrictEqual(checkDeckRequest(request({ args: ["$(x)\u202e"] }), NONCE, WHERE), { ok: false, why: "a4sx x" });
  });

  it("is refused for a folder outside the home folder, a link out of it, one others can write to, or a relative one", () => {
    const outside = tmp();
    const link = path.join(HOME, "link-out");
    fs.symlinkSync(outside, link);
    const open = path.join(HOME, "open");
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o777);
    for (const cwd of [outside, os.tmpdir(), link, path.join(HOME, "nope"), "projects/bob-cell", WORK + "\n", HOME + "/../x",
      ...(process.platform === "win32" ? [] : [open])]) {
      assert.deepStrictEqual(checkDeckRequest(request({ cwd }), NONCE, WHERE), { ok: false, why: DECK_TEXTS.outsideHome }, cwd);
    }
    assert.ok(deckFolderOk(HOME, WHERE));                     // the home folder itself: the CLI decides about it
    assert.ok(!deckFolderOk("\\\\host\\share\\x", { ...WHERE, platform: "win32" }));
    assert.ok(!deckFolderOk("//host/share/x", { ...WHERE, platform: "win32" }));
  });

  it("at most 10 in a minute", () => {
    const r = new RateLimit();
    for (let i = 0; i < 10; i++) {
      assert.ok(r.allow(1000 + i));
    }
    assert.ok(!r.allow(2000));
    assert.ok(r.allow(61_000));
  });
});

describe("Open deck: the channel folder", () => {
  it("each request file is read once, oldest first, and deleted; half-written ones wait", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "req-2-1.json"), "two");
    fs.writeFileSync(path.join(d, "req-1-1.json"), "one");
    fs.writeFileSync(path.join(d, ".req-3-1.json.tmp"), "three");
    fs.writeFileSync(path.join(d, "other.json"), "x");
    assert.deepStrictEqual(takeRequests(d), ["one", "two"]);
    assert.deepStrictEqual(fs.readdirSync(d).sort(), [".req-3-1.json.tmp", "other.json"]);
    assert.deepStrictEqual(takeRequests(d), []);
  });

  it("a large file, a link, a folder or a FIFO is deleted unread, and a FIFO never blocks", function () {
    const d = tmp();
    fs.writeFileSync(path.join(d, "req-1-1.json"), "x".repeat(17 * 1024));
    const target = path.join(tmp(), "t.json");
    fs.writeFileSync(target, "secret");
    try {
      fs.symlinkSync(target, path.join(d, "req-2-1.json"));
    } catch {
      // Windows without the right to make links
    }
    fs.mkdirSync(path.join(d, "req-3-1.json"));
    if (process.platform !== "win32") {
      // a FIFO would block the extension host for good: read in a child with a timeout, so a regression fails, not hangs
      execFileSync("mkfifo", [path.join(d, "req-4-1.json")]);
      const out = execFileSync(process.execPath, ["-r", path.join(__dirname, "..", "fakeVscode.js"), "-e",
        `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(__dirname, "..", "..", "deck.js"))}).takeRequests(${JSON.stringify(d)})))`],
      { encoding: "utf8", timeout: 10_000 });
      const taken = JSON.parse(out) as string[];
      assert.ok(taken.length >= 2 && taken.every((t) => t === ""), out);   // the big file, the link and the FIFO, all unread
    }
    const got = takeRequests(d);
    assert.ok(got.every((t) => t === ""), JSON.stringify(got));
    assert.ok(fs.readdirSync(d).every((n) => n === "req-3-1.json"), JSON.stringify(fs.readdirSync(d)));   // a folder isn't unlinked
    assert.strictEqual(fs.readFileSync(target, "utf8"), "secret");
  });

  it("another user's file is not read", function () {
    if (typeof process.getuid !== "function") {
      this.skip();
    }
    const d = tmp();
    fs.writeFileSync(path.join(d, "req-1-1.json"), "x");
    assert.deepStrictEqual(takeRequests(d, process.getuid!() + 1), [""]);
  });
});

describe("Open deck: the deck's environment", () => {
  it("has the channel and nonce, the extension's CLI first on PATH with its a4sx.py, and no herdr", () => {
    const d = tmp();
    const cli = path.join(d, "a4sx");
    fs.writeFileSync(cli, "");
    fs.writeFileSync(path.join(d, "a4sx.py"), "");
    const env = deckEnv("/chan", NONCE, cli, { PATH: "/usr/bin", HERDR_PANE_ID: "p" });
    assert.deepStrictEqual(env, {
      A4SX_DECK_HOST: "vscode", A4SX_DECK_CHANNEL: "/chan", A4SX_DECK_NONCE: NONCE, HERDR_SOCKET_PATH: null, HERDR_PANE_ID: null,
      PATH: d + path.delimiter + "/usr/bin", DECK_A4SX_PY: path.join(d, "a4sx.py"),
    });
    assert.strictEqual(deckEnv("/c", NONCE, "/opt/x/a4sx", { Path: "C:\\w" }).Path, "/opt/x" + path.delimiter + "C:\\w");
    assert.strictEqual(deckEnv("/c", NONCE, "/opt/x/a4sx", {}).DECK_A4SX_PY, undefined);
    assert.ok(!("PATH" in deckEnv("/c", NONCE, "bin/a4sx", { PATH: "/usr/bin" })));   // a relative CLI path: PATH as it is
  });
});

describe("Open deck: the terminal", () => {
  let started: DeckRequest[];
  let logs: string[];
  let decks: Deck[];
  beforeEach(() => {
    resetCalls();
    started = [];
    logs = [];
    decks = [];
  });
  afterEach(() => decks.forEach((d) => d.dispose()));

  function deck(over: Partial<DeckDeps> = {}): Deck {
    const d = new Deck({
      extensionPath: EXT, trusted: async () => true, python: async () => "/usr/bin/python3", cli: async () => "/opt/a4sx/a4sx",
      start: async (r) => { started.push(r); return {}; }, log: (l) => logs.push(l), now: () => Date.UTC(2026, 10, 26, 14, 0, 0),
      home: HOME, channelRoot: path.join(tmp(), "deck"), ...over,
    });
    decks.push(d);
    return d;
  }

  const env = (i = 0) => calls.terminals[i].options.env as Record<string, string>;
  const put = (name: string, text: string) => fs.writeFileSync(path.join(env().A4SX_DECK_CHANNEL, name), text);
  const req = (nonce: string, label: string, args = ["launch", "--cell", label]) => JSON.stringify({ v: 1, nonce, label, cwd: WORK, args });

  it("the bundled deck is the pinned one", () => {
    assert.strictEqual(sha256File(path.join(EXT, "deck", "deck.py")), DECK_SHA256);
  });

  it("opens the bundled deck with Python, isolated, in one terminal, its folder in the extension's storage; a second press shows it", async () => {
    const root = path.join(tmp(), "storage", "deck");
    const d = deck({ channelRoot: root });
    const t = await d.open();
    assert.strictEqual(calls.terminals.length, 1);
    const o = calls.terminals[0].options;
    assert.strictEqual(o.name, "a4sx deck");
    assert.strictEqual(o.shellPath, "/usr/bin/python3");
    assert.deepStrictEqual(o.shellArgs, ["-I", path.join(EXT, "deck", "deck.py")]);
    assert.strictEqual(o.isTransient, true);
    assert.strictEqual(env().A4SX_DECK_NONCE.length, 32);
    assert.strictEqual(path.dirname(env().A4SX_DECK_CHANNEL), root);
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(env().A4SX_DECK_CHANNEL).mode & 0o777, 0o700);
    }
    assert.strictEqual(await d.open(), t);
    assert.strictEqual(calls.terminals.length, 1);
    assert.ok(calls.terminals[0].shown);
  });

  it("a request with the nonce is logged as accepted, then as opened; a forged one is refused, said and logged", async () => {
    const d = deck();
    await d.open();
    const nonce = env().A4SX_DECK_NONCE;
    put("req-1-1.json", req(nonce, "bob-cell"));
    put("req-2-1.json", req("x".repeat(32), "evil"));
    put("req-3-1.json", req(nonce, "x", ["delete", "everything"]));
    await d.drain();
    assert.deepStrictEqual(started, [{ label: "bob-cell", cwd: WORK, args: ["launch", "--cell", "bob-cell"] }]);
    assert.deepStrictEqual(logs, [
      `2026-11-26T14:00:00Z deck: accepted «bob-cell» in ${WORK}: a4sx launch --cell bob-cell`,
      "2026-11-26T14:00:00Z deck: opened the terminal «a4sx: bob-cell»",
      "2026-11-26T14:00:00Z deck: refused a request it can't read",
      "2026-11-26T14:00:00Z deck: refused a4sx delete",
    ]);
    assert.deepStrictEqual(calls.warnings, [DECK_TEXTS.refused("a request it can't read")]);   // one toast a minute
  });

  it("a start that opens nothing (no CLI, Claude Code not found) is logged as not opened", async () => {
    const d = deck({ start: async () => undefined });
    await d.open();
    put("req-1-1.json", req(env().A4SX_DECK_NONCE, "bob-cell"));
    await d.drain();
    assert.strictEqual(logs[1], "2026-11-26T14:00:00Z deck: «bob-cell» was not opened (the message before says why)");
  });

  it("more than 10 in a minute: the 11th is not opened and is said; a flood of refusals shows one toast", async () => {
    const d = deck();
    await d.open();
    const nonce = env().A4SX_DECK_NONCE;
    for (let i = 10; i < 21; i++) {
      put(`req-${i}-1.json`, req(nonce, `c${i}`));
    }
    for (let i = 30; i < 80; i++) {
      put(`req-${i}-1.json`, req("y".repeat(32), "f"));
    }
    await d.drain();
    assert.strictEqual(started.length, 10);
    assert.deepStrictEqual(calls.warnings, [DECK_TEXTS.tooMany]);
    assert.strictEqual(logs.filter((l) => l.includes("refused")).length, 51);   // each one logged
  });

  it("closing the deck's terminal removes its folder and forgets its nonce", async () => {
    const d = deck();
    await d.open();
    const dir = env().A4SX_DECK_CHANNEL;
    const nonce = env().A4SX_DECK_NONCE;
    d.closed(calls.terminals[0]);
    assert.ok(!fs.existsSync(dir));
    fs.mkdirSync(dir);                                   // the same folder again, with a request with the old nonce
    fs.writeFileSync(path.join(dir, "req-1-1.json"), req(nonce, "bob-cell"));
    await d.drain();
    assert.deepStrictEqual(started, []);
    await d.open();
    assert.strictEqual(calls.terminals.length, 2);   // a new deck, with a new folder and nonce
    assert.notStrictEqual(env(1).A4SX_DECK_CHANNEL, dir);
    assert.notStrictEqual(env(1).A4SX_DECK_NONCE, nonce);
  });

  it("a deck closed while a start runs drops the rest of that batch", async () => {
    let d: Deck;
    d = deck({ start: async (r) => { started.push(r); d.closed(calls.terminals[0]); return {}; } });
    await d.open();
    const nonce = env().A4SX_DECK_NONCE;
    put("req-1-1.json", req(nonce, "one"));
    put("req-2-1.json", req(nonce, "two"));
    await d.drain();
    assert.deepStrictEqual(started.map((r) => r.label), ["one"]);
  });

  it("the extension stopping closes the deck's terminal too; a deck from before is closed at the start", async () => {
    const d = deck();
    await d.open();
    let disposed = 0;
    calls.terminals[0].dispose = () => { disposed++; };
    d.dispose();
    assert.strictEqual(disposed, 1);
    const stale = { creationOptions: { env: { A4SX_DECK_HOST: "vscode", A4SX_DECK_CHANNEL: "/gone" } }, dispose() { disposed++; } };
    const mine = { creationOptions: { env: { FOO: "1" } }, dispose() { assert.fail("not a deck"); } };
    assert.strictEqual(closeStaleDecks([stale, mine, {}] as any), 1);
    assert.strictEqual(disposed, 2);
  });

  it("a changed deck, no Python, no CLI or an untrusted window: nothing starts, and the first two are said", async () => {
    const bad = tmp();
    fs.mkdirSync(path.join(bad, "deck"));
    fs.writeFileSync(path.join(bad, "deck", "deck.py"), "print('changed')");
    assert.strictEqual(await deck({ extensionPath: bad }).open(), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [DECK_TEXTS.changed]);
    resetCalls();
    assert.strictEqual(await deck({ python: async () => undefined }).open(), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [DECK_TEXTS.noPython]);
    resetCalls();
    assert.strictEqual(await deck({ cli: async () => undefined }).open(), undefined);
    assert.strictEqual(await deck({ trusted: async () => false }).open(), undefined);
    assert.deepStrictEqual([calls.terminals.length, calls.errors.length], [0, 0]);
  });
});

describe("Open deck: an accepted start's terminal", () => {
  beforeEach(resetCalls);

  it("is named «a4sx: <name>» and runs the extension's own CLI with exactly the request's arguments, in its folder", async () => {
    const CLI = "/opt/a4sx/a4sx";
    const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> =>
      args.join(" ") === "--version" ? { code: 0, stdout: "a4sx 0.59.48  (server 0.761.0)\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => "https://x", onState: () => undefined });
    const deps: CellCommandDeps = {
      state: fakeMemento() as any, cliDir: undefined, provider, resolve: () => ({ kind: "found", path: CLI }), run,
      server: () => "https://x", defaultServer: "https://x", folder: async () => undefined,
      fetch: async () => { throw new Error("no network in tests"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
      stateDir: tmp(), claudeProjects: tmp(), home: tmp(),
    };
    const t = await startDeckRequest(deps, DECK_TEXTS.requestTerminal("bob-cell"), WORK, ["launch", "--cell", "bob-cell", "--new-session"]);
    assert.ok(t);
    assert.strictEqual(calls.terminals.length, 1);
    const o = calls.terminals[0].options;
    assert.strictEqual(o.name, "a4sx: bob-cell");
    assert.strictEqual(o.cwd, WORK);
    const ran = calls.terminals[0].sent.length ? calls.terminals[0].sent[0] : [o.shellPath, ...o.shellArgs].join(" ");
    assert.ok(/a4sx'? '?launch'? '?--cell'? '?bob-cell'? '?--new-session'?/.test(ran), ran);
    assert.ok(deps.terminals.has(t!));   // the Cells view reads again when it closes
  });
});
