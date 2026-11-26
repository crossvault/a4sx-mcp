// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// "Open deck": the bundled deck in one terminal; its starts checked, opened visibly and logged.
import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, resetCalls } from "../fakeVscode";
import {
  checkDeckRequest, Deck, DECK_SHA256, DECK_TEXTS, DeckDeps, DeckRequest, deckEnv, deckLaunchArgs, RateLimit, sha256File, takeRequests,
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "deck-test-"));
}

function request(over: Record<string, unknown> = {}, cwd = os.tmpdir()): string {
  return JSON.stringify({ v: 1, nonce: NONCE, label: "bob-cell", cwd, args: ["launch", "--cell", "bob-cell"], ...over });
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

  it("is the same list as the bundled deck.py's own", function () {
    let py: string | undefined;
    for (const c of ["python3", "python"]) {
      try {
        execFileSync(c, ["-c", "import sys; assert sys.version_info >= (3, 10)"], { stdio: "ignore" });
        py = c;
        break;
      } catch {
        // next
      }
    }
    if (!py) {
      this.skip();
    }
    const cases = [...ALLOWED, ...REFUSED].filter((a) => Array.isArray(a));
    const script = "import importlib.util, json, sys\n"
      + "s = importlib.util.spec_from_file_location('d', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)\n"
      + "print(json.dumps([m.vscode_request_args(a) for a in json.loads(sys.argv[2])]))";
    const out = JSON.parse(execFileSync(py!, ["-I", "-B", "-c", script, path.join(EXT, "deck", "deck.py"), JSON.stringify(cases)], { encoding: "utf8" }));
    assert.deepStrictEqual(out, cases.map((a) => deckLaunchArgs(a) ?? null));
  });
});

describe("Open deck: the real deck.py and this check agree", () => {
  it("a start the bundled deck writes in VS Code mode is taken here as it was sent", function () {
    let py: string | undefined;
    for (const c of ["python3", "python"]) {
      try {
        execFileSync(c, ["-c", "import sys; assert sys.version_info >= (3, 10)"], { stdio: "ignore" });
        py = c;
        break;
      } catch {
        // next
      }
    }
    if (!py) {
      this.skip();
    }
    const chan = tmp();
    const work = tmp();
    const script = "import importlib.util, sys\n"
      + "s = importlib.util.spec_from_file_location('d', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)\n"
      + "m.run = m.jrun = None\n"
      + "print(m.new_tab('bob-cell', sys.argv[2], [*m.A4SX_ARGV, 'launch', '--cell', 'bob-cell', '--new-session'], cell='bob-cell'))";
    const out = execFileSync(py!, ["-I", "-B", "-c", script, path.join(EXT, "deck", "deck.py"), work], {
      encoding: "utf8", env: { ...process.env, A4SX_DECK_HOST: "vscode", A4SX_DECK_CHANNEL: chan, A4SX_DECK_NONCE: NONCE },
    });
    assert.ok(out.includes("asked VS Code to open the terminal «a4sx: bob-cell»"), out);
    const got = takeRequests(chan);
    assert.strictEqual(got.length, 1);
    assert.deepStrictEqual(checkDeckRequest(got[0], NONCE), { ok: true, req: { label: "bob-cell", cwd: work, args: ["launch", "--cell", "bob-cell", "--new-session"] } });
  });
});

describe("Open deck: a request", () => {
  it("is taken with its nonce, a plain label and an existing absolute folder", () => {
    const c = checkDeckRequest(request(), NONCE);
    assert.deepStrictEqual(c, { ok: true, req: { label: "bob-cell", cwd: os.tmpdir(), args: ["launch", "--cell", "bob-cell"] } });
  });

  it("is refused for a wrong or missing nonce, another version, or text that isn't one, without saying more", () => {
    for (const t of [request({ nonce: "cd".repeat(16) }), request({ nonce: undefined }), request({ nonce: NONCE.slice(1) }), request({ v: 2 }), "{", "[]", ""]) {
      assert.deepStrictEqual(checkDeckRequest(t, NONCE), { ok: false, why: DECK_TEXTS.unreadable }, t);
    }
    assert.strictEqual(checkDeckRequest(request(), "").ok, false);   // no deck open: nothing is taken
  });

  it("is refused for a label or folder it can't show plainly, and names what was asked", () => {
    for (const over of [{ label: "a\nb" }, { label: "\x1b[31mx" }, { label: "" }, { label: "x".repeat(41) }, { cwd: "relative/dir" },
      { cwd: path.join(os.tmpdir(), "no-such-deck-dir-x") }, { cwd: os.tmpdir() + "\n" }, { args: ["delete", "x"] }]) {
      const c = checkDeckRequest(request(over), NONCE);
      assert.strictEqual(c.ok, false, JSON.stringify(over));
      assert.strictEqual((c as { why: string }).why, "a4sx " + (Array.isArray((over as { args?: string[] }).args) ? "delete" : "launch"));
    }
    assert.deepStrictEqual(checkDeckRequest(request({ args: ["$(x)\u202e"] }), NONCE), { ok: false, why: "a4sx x" });
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

  it("a large file, a link or a folder is deleted unread", function () {
    const d = tmp();
    fs.writeFileSync(path.join(d, "req-1-1.json"), "x".repeat(17 * 1024));
    const target = path.join(tmp(), "t.json");
    fs.writeFileSync(target, "secret");
    try {
      fs.symlinkSync(target, path.join(d, "req-2-1.json"));
    } catch {
      // Windows without the right to make links
    }
    const got = takeRequests(d);
    assert.ok(got.every((t) => t === ""), JSON.stringify(got));
    assert.deepStrictEqual(fs.readdirSync(d), []);
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
      start: async (r) => { started.push(r); }, log: (l) => logs.push(l), now: () => Date.UTC(2026, 10, 26, 14, 0, 0), ...over,
    });
    decks.push(d);
    return d;
  }

  const env = () => calls.terminals[0].options.env as Record<string, string>;
  const put = (name: string, text: string) => fs.writeFileSync(path.join(env().A4SX_DECK_CHANNEL, name), text);

  it("the bundled deck is the pinned one", () => {
    assert.strictEqual(sha256File(path.join(EXT, "deck", "deck.py")), DECK_SHA256);
  });

  it("opens the bundled deck with Python, isolated, in one terminal; a second press shows it", async () => {
    const d = deck();
    const t = await d.open();
    assert.strictEqual(calls.terminals.length, 1);
    const o = calls.terminals[0].options;
    assert.strictEqual(o.name, "a4sx deck");
    assert.strictEqual(o.shellPath, "/usr/bin/python3");
    assert.deepStrictEqual(o.shellArgs, ["-I", path.join(EXT, "deck", "deck.py")]);
    assert.strictEqual(o.isTransient, true);
    assert.strictEqual(env().A4SX_DECK_NONCE.length, 32);
    assert.ok(fs.statSync(env().A4SX_DECK_CHANNEL).isDirectory());
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(env().A4SX_DECK_CHANNEL).mode & 0o777, 0o700);
    }
    assert.strictEqual(await d.open(), t);
    assert.strictEqual(calls.terminals.length, 1);
    assert.ok(calls.terminals[0].shown);
  });

  it("a request with the nonce opens a terminal and is logged; a forged one is refused, said and logged", async () => {
    const d = deck();
    await d.open();
    const nonce = env().A4SX_DECK_NONCE;
    put("req-1-1.json", JSON.stringify({ v: 1, nonce, label: "bob-cell", cwd: os.tmpdir(), args: ["launch", "--cell", "bob-cell"] }));
    put("req-2-1.json", JSON.stringify({ v: 1, nonce: "x".repeat(32), label: "evil", cwd: os.tmpdir(), args: ["launch", "--cell", "evil"] }));
    put("req-3-1.json", JSON.stringify({ v: 1, nonce, label: "x", cwd: os.tmpdir(), args: ["delete", "everything"] }));
    await d.drain();
    assert.deepStrictEqual(started, [{ label: "bob-cell", cwd: os.tmpdir(), args: ["launch", "--cell", "bob-cell"] }]);
    assert.deepStrictEqual(logs, [
      `2026-11-26T14:00:00Z deck: opened «bob-cell» in ${os.tmpdir()}: a4sx launch --cell bob-cell`,
      "2026-11-26T14:00:00Z deck: refused a request it can't read",
      "2026-11-26T14:00:00Z deck: refused a4sx delete",
    ]);
    assert.deepStrictEqual(calls.warnings, [DECK_TEXTS.refused("a request it can't read"), DECK_TEXTS.refused("a4sx delete")]);
  });

  it("more than 10 in a minute: the 11th is not opened and is said", async () => {
    const d = deck();
    await d.open();
    const nonce = env().A4SX_DECK_NONCE;
    for (let i = 10; i < 21; i++) {
      put(`req-${i}-1.json`, JSON.stringify({ v: 1, nonce, label: `c${i}`, cwd: os.tmpdir(), args: ["launch", "--cell", `c${i}`] }));
    }
    await d.drain();
    assert.strictEqual(started.length, 10);
    assert.deepStrictEqual(calls.warnings, [DECK_TEXTS.tooMany]);
  });

  it("closing the deck's terminal removes its folder; requests after that start nothing", async () => {
    const d = deck();
    await d.open();
    const dir = env().A4SX_DECK_CHANNEL;
    d.closed(calls.terminals[0]);
    assert.ok(!fs.existsSync(dir));
    await d.drain();
    assert.deepStrictEqual(started, []);
    await d.open();
    assert.strictEqual(calls.terminals.length, 2);   // a new deck, with a new folder and nonce
    assert.notStrictEqual(env().A4SX_DECK_CHANNEL, (calls.terminals[1].options.env as Record<string, string>).A4SX_DECK_CHANNEL);
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
