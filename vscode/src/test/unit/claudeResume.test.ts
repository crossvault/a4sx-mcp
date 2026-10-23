// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import * as cr from "../../claudeResume";
import { SessionItem } from "../../sessionsView";
import type { CliLookup } from "../../cli";

const ID = "3f2b8c1e-9a4d-4e6f-8b2a-0c1d2e3f4a5b";
const CLI = "/home/u/.local/bin/a4sx";
const found = (): CliLookup => ({ found: true, path: CLI });
const folder = (name: string, fsPath: string, scheme = "file") => ({ name, uri: { scheme, fsPath } });

interface ExecCall { file: string; args: string[]; options: cr.ExecOptions; stdinEnded: boolean }

/** A fake execFile that answers with one canned outcome and records how it was called. */
function fakeExec(outcome: { error?: (Error & { code?: unknown; killed?: boolean }) | null; stdout?: string; stderr?: string }) {
  const seen: ExecCall[] = [];
  const exec: cr.ExecFileLike = (file, args, options, callback) => {
    const rec: ExecCall = { file, args, options, stdinEnded: false };
    seen.push(rec);
    setImmediate(() => callback(outcome.error ?? null, outcome.stdout ?? "", outcome.stderr ?? ""));
    return { stdin: { end: () => { rec.stdinEnded = true; } } };
  };
  return { exec, seen };
}

function exitError(code: number | string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`Command failed`), { code, ...extra });
}

describe("Resume in Claude Code: helpers", () => {
  it("accepts exactly one UUID line (surrounding whitespace allowed)", () => {
    assert.strictEqual(cr.parseSessionId(`${ID}\n`), ID);
    assert.strictEqual(cr.parseSessionId(`  ${ID.toUpperCase()}\r\n`), ID.toUpperCase());
  });

  it("rejects extra lines, whitespace-only output and anything that is not a UUID", () => {
    for (const bad of [
      "", "   \n\t", `${ID}\n${ID}\n`, `note\n${ID}`, `${ID} extra`, `${ID}x`, "not-a-uuid",
      "3f2b8c1e9a4d4e6f8b2a0c1d2e3f4a5b", "3f2b8c1e-9a4d-4e6f-8b2a-0c1d2e3f4a5", "3f2b8c1e-9a4d-4e6f-8b2a-0c1d2e3f4a5g",
      `${ID}&foo=bar`, `{${ID}}`,
    ]) {
      assert.strictEqual(cr.parseSessionId(bad), undefined, JSON.stringify(bad));
    }
  });

  it("builds the Claude Code link from the editor's URI scheme, with the session id encoded", () => {
    assert.strictEqual(cr.claudeResumeUri("vscode", ID), `vscode://anthropic.claude-code/open?session=${ID}`);
    assert.strictEqual(cr.claudeResumeUri("vscode-insiders", ID), `vscode-insiders://anthropic.claude-code/open?session=${ID}`);
    assert.strictEqual(cr.claudeResumeUri("cursor", "a b&c=d#e"), "cursor://anthropic.claude-code/open?session=a%20b%26c%3Dd%23e");
  });

  it("detects a CLI from before --seed-only (argparse exit 2)", () => {
    const argparse = "usage: a4sx [-h] ...\na4sx: error: unrecognized arguments: --seed-only\n";
    assert.strictEqual(cr.isOldCli(2, argparse), true);
    assert.strictEqual(cr.isOldCli(1, argparse), false);
    assert.strictEqual(cr.isOldCli(2, "a4sx: error: no session named x\n"), false);
    assert.strictEqual(cr.isOldCli(null, argparse), false);
    // A newer CLI that fails for another reason and merely mentions the flag is not "old".
    assert.strictEqual(cr.isOldCli(2, "a4sx: error: --seed-only needs a saved session\n"), false);
    assert.strictEqual(cr.isOldCli(2, "a4sx: error: unrecognized arguments: --other\n"), false);
  });

  it("the error detail is the last stderr line, one line, no escapes, capped", () => {
    assert.strictEqual(cr.lastLine("first\n\x1b[31msecond\tline\x1b[0m\n\n"), "second line");
    assert.strictEqual(cr.lastLine(""), "");
    const long = cr.lastLine("x".repeat(500));
    assert.strictEqual(long.length, 200);
    assert.ok(long.endsWith("…"));
  });

  it("the CLI arguments name the session and ask for --seed-only", () => {
    assert.deepStrictEqual(cr.seedArgs("my-base"), ["launch", "--a4sx-session=my-base", "--seed-only"]);
  });
});

describe("Resume in Claude Code: seedSession", () => {
  it("runs the CLI with an args array in the folder, a timeout and no input", async () => {
    const f = fakeExec({ stdout: `${ID}\n`, stderr: "Copied 12 messages.\n" });
    assert.deepStrictEqual(await cr.seedSession(CLI, "my base; rm x", "/w/proj", f.exec), { kind: "ok", sessionId: ID });
    assert.strictEqual(f.seen.length, 1);
    assert.strictEqual(f.seen[0].file, CLI);
    assert.deepStrictEqual(f.seen[0].args, ["launch", "--a4sx-session=my base; rm x", "--seed-only"]);
    assert.strictEqual(f.seen[0].options.cwd, "/w/proj");
    assert.strictEqual(f.seen[0].options.timeout, cr.SEED_TIMEOUT_MS);
    assert.strictEqual(f.seen[0].options.maxBuffer, 64 * 1024);
    assert.ok(f.seen[0].stdinEnded, "stdin is closed so a question can't hang it");
  });

  it("classifies the failures", async () => {
    const run = (o: Parameters<typeof fakeExec>[0]) => cr.seedSession(CLI, "n", "/w", fakeExec(o).exec);
    assert.deepStrictEqual(await run({ stdout: "Session copied.\n" }), { kind: "bad-output" });
    assert.deepStrictEqual(await run({ error: exitError(2), stderr: "a4sx: error: unrecognized arguments: --seed-only\n" }), { kind: "old-cli" });
    assert.deepStrictEqual(await run({ error: exitError(1), stderr: "working\na4sx: no session named n\n" }),
      { kind: "failed", exitCode: 1, detail: "a4sx: no session named n" });
    assert.deepStrictEqual(await run({ error: exitError("ENOENT") }), { kind: "failed", exitCode: null, detail: "" });
    assert.deepStrictEqual(await run({ error: exitError(null as any, { killed: true, signal: "SIGTERM" }) }), { kind: "timeout" });
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" });
    assert.deepStrictEqual(await run({ error: abortErr }), { kind: "cancelled" });
    const tooMuch = Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    assert.deepStrictEqual(await run({ error: tooMuch, stderr: "partial note\n" }), { kind: "failed", exitCode: null, detail: "" });
    assert.deepStrictEqual(await run({ error: exitError(2), stderr: "a4sx: error: --seed-only needs a saved session\n" }),
      { kind: "failed", exitCode: 2, detail: "a4sx: error: --seed-only needs a saved session" });
  });

  it("a synchronous throw from execFile is an ordinary failure", async () => {
    const throwing: cr.ExecFileLike = () => { throw new TypeError("The argument 'args[1]' must be a string without null bytes"); };
    assert.deepStrictEqual(await cr.seedSession(CLI, "n", "/w", throwing), { kind: "failed", exitCode: null, detail: "" });
    // The real execFile throws synchronously for a NUL byte in an argument.
    assert.deepStrictEqual(await cr.seedSession(process.execPath, "bad\0name", os.tmpdir()), { kind: "failed", exitCode: null, detail: "" });
  });

  // The real child_process.execFile, against a small script: arguments arrive verbatim (no shell)
  // and the working directory is the folder.
  (process.platform === "win32" ? it.skip : it)("the real execFile passes arguments verbatim and runs in the folder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-vscode-seed-"));
    const script = path.join(dir, "fake-a4sx");
    const out = path.join(dir, "args.txt");
    fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > args.txt\necho "note on stderr" >&2\necho ${ID}\n`);
    fs.chmodSync(script, 0o755);
    const old = path.join(dir, "old-a4sx");
    fs.writeFileSync(old, "#!/bin/sh\necho 'usage: a4sx' >&2\necho 'a4sx: error: unrecognized arguments: --seed-only' >&2\nexit 2\n");
    fs.chmodSync(old, 0o755);
    try {
      const r = await cr.seedSession(script, "x $(touch pwned); `id`", dir);
      assert.deepStrictEqual(r, { kind: "ok", sessionId: ID });
      const lines = fs.readFileSync(out, "utf8").split("\n");
      assert.strictEqual(fs.realpathSync(lines[0]), fs.realpathSync(dir));
      assert.deepStrictEqual(lines.slice(1, 4), ["launch", "--a4sx-session=x $(touch pwned); `id`", "--seed-only"]);
      assert.ok(!fs.existsSync(path.join(dir, "pwned")), "no shell ran the name");
      assert.deepStrictEqual(await cr.seedSession(old, "x", dir), { kind: "old-cli" });
      const chatty = path.join(dir, "chatty-a4sx");
      fs.writeFileSync(chatty, "#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' x\n");
      fs.chmodSync(chatty, 0o755);
      try {
        assert.deepStrictEqual(await cr.seedSession(chatty, "x", dir), { kind: "failed", exitCode: null, detail: "" });
      } finally {
        fs.unlinkSync(chatty);
      }
    } finally {
      fs.unlinkSync(out);
      fs.unlinkSync(script);
      fs.unlinkSync(old);
      fs.rmdirSync(dir);
    }
  });
});

describe("a4sx.resumeInClaude", () => {
  beforeEach(() => {
    resetCalls();
    calls.extensions.add("anthropic.claude-code");
    calls.workspaceFolders = [folder("proj", "/w/proj")];
  });
  const item = new SessionItem({ id: "c-123", label: "my-base", title: "Fix the login bug" });
  const unlabeled = new SessionItem({ id: "c-456" });

  it("copies the session in the open folder and opens it in Claude Code", async () => {
    const f = fakeExec({ stdout: `${ID}\n` });
    await ext.resumeInClaude(item, found, f.exec);
    assert.deepStrictEqual(f.seen.map((c) => [c.file, c.args, c.options.cwd]), [[CLI, ["launch", "--a4sx-session=my-base", "--seed-only"], "/w/proj"]]);
    assert.deepStrictEqual(calls.progress.map((p) => [p.title, p.options.cancellable]), [[ext.CLAUDE_MESSAGES.progress, true]]);
    assert.deepStrictEqual(calls.opened, [`vscode://anthropic.claude-code/open?session=${ID}`]);
    assert.strictEqual(calls.errors.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("uses the editor's own URI scheme and the session id when the push set no label", async () => {
    calls.uriScheme = "vscode-insiders";
    const f = fakeExec({ stdout: ID });
    await ext.resumeInClaude(unlabeled, found, f.exec);
    assert.deepStrictEqual(f.seen[0].args, ["launch", "--a4sx-session=c-456", "--seed-only"]);
    assert.deepStrictEqual(calls.opened, [`vscode-insiders://anthropic.claude-code/open?session=${ID}`]);
  });

  it("output that is not exactly one session id opens nothing", async () => {
    for (const stdout of [`${ID}\nextra\n`, "  \n", "done", `${ID}&x=y`]) {
      resetCalls();
      calls.extensions.add("anthropic.claude-code");
      calls.workspaceFolders = [folder("proj", "/w/proj")];
      await ext.resumeInClaude(item, found, fakeExec({ stdout }).exec);
      assert.deepStrictEqual(calls.opened, [], JSON.stringify(stdout));
      assert.deepStrictEqual(calls.errors, [{ message: ext.CLAUDE_MESSAGES.badOutput, items: [ext.RESUME_IN_TERMINAL] }]);
    }
  });

  it("multi-root: asks which folder, runs there; Esc runs nothing", async () => {
    calls.workspaceFolders = [folder("api", "/w/api"), folder("remote", "/r", "vscode-vfs"), folder("web", "/w/web")];
    calls.nextPick = 1;
    const f = fakeExec({ stdout: ID });
    await ext.resumeInClaude(item, found, f.exec);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i) => i.label), ["api", "web"], "only local folders are offered");
    assert.strictEqual(calls.quickPicks[0].options.placeHolder, ext.CLAUDE_MESSAGES.pickFolder);
    assert.strictEqual(f.seen[0].options.cwd, "/w/web");
    calls.nextPick = undefined;
    calls.opened.length = 0;
    const g = fakeExec({ stdout: ID });
    await ext.resumeInClaude(item, found, g.exec);
    assert.strictEqual(g.seen.length, 0);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("no folder open: a short error, nothing runs", async () => {
    for (const folders of [undefined, []]) {
      resetCalls();
      calls.extensions.add("anthropic.claude-code");
      calls.workspaceFolders = folders;
      const f = fakeExec({ stdout: ID });
      await ext.resumeInClaude(item, found, f.exec);
      assert.strictEqual(f.seen.length, 0);
      assert.deepStrictEqual(calls.errors, [{ message: ext.CLAUDE_MESSAGES.noFolder, items: [] }]);
      assert.deepStrictEqual(calls.opened, []);
    }
  });

  it("only virtual folders: says a folder on disk is needed, nothing runs", async () => {
    calls.workspaceFolders = [folder("remote", "/r", "vscode-vfs")];
    const f = fakeExec({ stdout: ID });
    await ext.resumeInClaude(item, found, f.exec);
    assert.strictEqual(f.seen.length, 0);
    assert.deepStrictEqual(calls.errors, [{ message: ext.CLAUDE_MESSAGES.notOnDisk, items: [] }]);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("without the Claude Code extension: says so and offers to show it in the Extensions view", async () => {
    calls.extensions.clear();
    const f = fakeExec({ stdout: ID });
    await ext.resumeInClaude(item, found, f.exec);
    assert.strictEqual(f.seen.length, 0);
    assert.deepStrictEqual(calls.errors, [{ message: ext.CLAUDE_MESSAGES.noClaude, items: [ext.SHOW_EXTENSION] }]);
    assert.deepStrictEqual(calls.executed, []);
    calls.nextErrorChoice = ext.SHOW_EXTENSION;
    await ext.resumeInClaude(item, found, f.exec);
    assert.deepStrictEqual(calls.executed, [{ id: "workbench.extensions.search", args: ["@id:anthropic.claude-code"] }]);
    assert.strictEqual(f.seen.length, 0);
  });

  it("without the CLI: the install hint, nothing runs", async () => {
    const f = fakeExec({ stdout: ID });
    await ext.resumeInClaude(item, () => ({ found: false, reason: "not-on-path" }), f.exec);
    assert.strictEqual(f.seen.length, 0);
    assert.deepStrictEqual(calls.errors[0].items, ["How to install"]);
  });

  it("an old CLI is told to update; 'Resume in terminal' falls back to the terminal", async () => {
    const f = fakeExec({ error: exitError(2), stderr: "a4sx: error: unrecognized arguments: --seed-only\n" });
    calls.nextErrorChoice = ext.RESUME_IN_TERMINAL;
    await ext.resumeInClaude(item, found, f.exec);
    assert.deepStrictEqual(calls.errors, [{ message: ext.CLAUDE_MESSAGES.oldCli, items: [ext.RESUME_IN_TERMINAL] }]);
    assert.match(calls.errors[0].message, /a4sx update/);
    assert.deepStrictEqual(calls.terminals.map((t) => t.options), [
      { name: ext.RESUME_TERMINAL_NAME, shellPath: CLI, shellArgs: ["launch", "--a4sx-session=my-base"] },
    ]);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("other failures show the CLI's last stderr line, or the exit code", async () => {
    await ext.resumeInClaude(item, found, fakeExec({ error: exitError(1), stderr: "step 1\nNo session named my-base in your library.\n" }).exec);
    await ext.resumeInClaude(item, found, fakeExec({ error: exitError(3) }).exec);
    await ext.resumeInClaude(item, found, fakeExec({ error: exitError(null as any, { killed: true }) }).exec);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [
      "Could not copy the session for Claude Code: No session named my-base in your library.",
      "Could not copy the session for Claude Code. a4sx exited with code 3.",
      ext.CLAUDE_MESSAGES.timeout,
    ]);
    assert.ok(calls.errors.every((e) => e.items.length === 1 && e.items[0] === ext.RESUME_IN_TERMINAL));
    assert.strictEqual(calls.terminals.length, 0, "nothing falls back unless clicked");
    assert.deepStrictEqual(calls.opened, []);
  });

  it("a synchronous throw from execFile shows the error with the terminal fallback", async () => {
    const throwing: cr.ExecFileLike = () => { throw new Error("spawn EINVAL"); };
    calls.nextErrorChoice = ext.RESUME_IN_TERMINAL;
    await ext.resumeInClaude(item, found, throwing);
    assert.deepStrictEqual(calls.errors, [{ message: ext.CLAUDE_MESSAGES.failed, items: [ext.RESUME_IN_TERMINAL] }]);
    assert.strictEqual(calls.terminals.length, 1, "the fallback runs the terminal resume");
    assert.deepStrictEqual(calls.opened, []);
    assert.strictEqual(calls.cancelDisposed, 1, "the cancellation listener is disposed");
  });

  it("cancelling the progress notification shows nothing", async () => {
    calls.cancelProgress = true;
    let signal: AbortSignal | undefined;
    const exec: cr.ExecFileLike = (_f, _a, options, callback) => {
      signal = options.signal;
      setImmediate(() => callback(Object.assign(new Error("aborted"), { name: "AbortError" }), "", ""));
    };
    await ext.resumeInClaude(item, found, exec);
    assert.ok(signal?.aborted, "the child is aborted");
    assert.strictEqual(calls.cancelDisposed, 1);
    assert.deepStrictEqual(calls.errors, []);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("if the editor can't open the link, a short error", async () => {
    calls.openResult = false;
    await ext.resumeInClaude(item, found, fakeExec({ stdout: ID }).exec);
    assert.deepStrictEqual(calls.errors, [{ message: ext.CLAUDE_MESSAGES.openFailed, items: [] }]);
  });

  it("the registered command, without an item (palette), does nothing", async () => {
    ext.activate({ subscriptions: [], secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose() {} }) } } as any);
    await calls.commands.get(ext.CMD_RESUME_CLAUDE)!();
    assert.deepStrictEqual(calls.errors, []);
    assert.strictEqual(calls.progress.length, 0);
  });

  it("the manifest puts Resume in Claude Code next to Resume in terminal and hides it from the palette", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
    const menu = pkg.contributes.menus["view/item/context"].filter((m: any) => m.when === "view == a4sx.sessions && viewItem == a4sx.session");
    const group = (cmd: string, prefix: string) => menu.find((m: any) => m.command === cmd && m.group.startsWith(prefix))?.group;
    assert.strictEqual(group(ext.CMD_RESUME, "inline"), "inline@1");
    assert.strictEqual(group(ext.CMD_RESUME_CLAUDE, "inline"), "inline@2");
    assert.strictEqual(group(ext.CMD_RESUME, "1_session"), "1_session@1");
    assert.strictEqual(group(ext.CMD_RESUME_CLAUDE, "1_session"), "1_session@2");
    assert.ok(pkg.contributes.menus.commandPalette.some((m: any) => m.command === ext.CMD_RESUME_CLAUDE && m.when === "false"));
  });
});
