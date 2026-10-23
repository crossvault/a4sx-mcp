// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Remote windows (SSH, WSL, dev containers, Codespaces): the extension runs on the remote host there.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import * as cr from "../../claudeResume";
import { findCli, type CliLookup } from "../../cli";
import { SessionItem } from "../../sessionsView";

const ID = "3f2b8c1e-9a4d-4e6f-8b2a-0c1d2e3f4a5b";
const CLI = "/home/dev/.local/bin/a4sx";
const WORKSPACE = 2;
const UI = 1;
const found = (): CliLookup => ({ found: true, path: CLI });
const missing = (): CliLookup => ({ found: false, reason: "not-on-path" });
const folder = (name: string, fsPath: string, scheme = "file") => ({ name, uri: { scheme, fsPath } });
const item = new SessionItem({ id: "c-123", label: "my-base", title: "Fix the login bug" });

function fakeExec(outcome: { error?: (Error & { code?: unknown }) | null; stdout?: string; stderr?: string }) {
  const seen: { file: string; args: string[]; cwd: string }[] = [];
  const exec: cr.ExecFileLike = (file, args, options, callback) => {
    seen.push({ file, args, cwd: options.cwd });
    setImmediate(() => callback(outcome.error ?? null, outcome.stdout ?? "", outcome.stderr ?? ""));
    return { stdin: { end: () => undefined } };
  };
  return { exec, seen };
}

/** A remote window with the extension on the remote host (VS Code's default for this extension). */
function remoteWindow(name = "ssh-remote"): void {
  resetCalls();
  calls.extensions.add("anthropic.claude-code");
  calls.remoteName = name;
  calls.extensionKind = WORKSPACE;
}

describe("remote windows: Resume in Claude Code folders", () => {
  beforeEach(() => remoteWindow());

  it("a vscode-remote folder is accepted; the CLI runs in its path on the remote host", async () => {
    calls.workspaceFolders = [folder("proj", "/home/dev/proj", "vscode-remote")];
    const f = fakeExec({ stdout: `${ID}\n` });
    await ext.resumeInClaude(item, found, f.exec);
    assert.deepStrictEqual(f.seen, [{ file: CLI, args: ["launch", "--a4sx-session=my-base", "--seed-only"], cwd: "/home/dev/proj" }]);
    assert.deepStrictEqual(calls.errors, []);
    assert.deepStrictEqual(calls.opened, [`vscode://anthropic.claude-code/open?session=${ID}`]);
  });

  it("a file folder (how the remote extension host sees its folders) works as before", async () => {
    calls.workspaceFolders = [folder("proj", "/home/dev/proj")];
    const f = fakeExec({ stdout: ID });
    await ext.resumeInClaude(item, found, f.exec);
    assert.strictEqual(f.seen[0].cwd, "/home/dev/proj");
    assert.deepStrictEqual(calls.errors, []);
  });

  it("multi-root with mixed schemes: offers only the folders on the remote host", async () => {
    calls.workspaceFolders = [
      folder("api", "/home/dev/api"),
      folder("docs", "/docs", "vscode-vfs"),
      folder("web", "/home/dev/web", "vscode-remote"),
      folder("laptop", "/Users/me/notes", "vscode-local"),
      folder("scratch", "/Untitled-1", "untitled"),
    ];
    calls.nextPick = 1;
    const f = fakeExec({ stdout: ID });
    await ext.resumeInClaude(item, found, f.exec);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i) => [i.label, i.description]), [["api", "/home/dev/api"], ["web", "/home/dev/web"]]);
    assert.strictEqual(f.seen[0].cwd, "/home/dev/web");
  });

  it("virtual and other schemes are refused with a clear message, in remote and local windows", async () => {
    for (const remote of ["ssh-remote", undefined]) {
      for (const scheme of ["vscode-vfs", "untitled", "vscode-local"]) {
        remoteWindow();
        calls.remoteName = remote;
        calls.workspaceFolders = [folder("x", "/x", scheme)];
        let looked = false;
        const f = fakeExec({ stdout: ID });
        await ext.resumeInClaude(item, () => { looked = true; return found(); }, f.exec);
        assert.strictEqual(f.seen.length, 0, scheme);
        assert.strictEqual(looked, false, "no CLI lookup");
        assert.deepStrictEqual(calls.errors, [{ message: ext.CLAUDE_MESSAGES.notOnDisk, items: [] }], `${remote} ${scheme}`);
        assert.deepStrictEqual(calls.opened, []);
      }
    }
  });

  it("a local window ignores vscode-remote folders, as in 0.2.1", async () => {
    calls.remoteName = undefined;
    calls.extensionKind = UI;
    calls.workspaceFolders = [folder("web", "/home/dev/web", "vscode-remote"), folder("proj", "/w/proj")];
    const f = fakeExec({ stdout: ID });
    await ext.resumeInClaude(item, found, f.exec);
    assert.strictEqual(calls.quickPicks.length, 0, "one usable folder: no picker");
    assert.strictEqual(f.seen[0].cwd, "/w/proj");
  });

  it("remoteHostName: only when the window is remote and the extension runs there", () => {
    assert.strictEqual(ext.remoteHostName(), "ssh-remote");
    calls.extensionKind = UI;
    assert.strictEqual(ext.remoteHostName(), undefined);
    calls.extensionKind = WORKSPACE;
    calls.remoteName = undefined;
    assert.strictEqual(ext.remoteHostName(), undefined);
  });
});

describe("remote window, but the extension runs on this computer", () => {
  const message = 'This window is connected to SSH, but the a4sx extension runs on this computer. In the Extensions view, click "Install in SSH" for a4sx, then try again.';
  beforeEach(() => {
    remoteWindow();
    calls.extensionKind = UI;
    calls.workspaceFolders = [folder("web", "/home/dev/web", "vscode-remote"), folder("proj", "/w/proj")];
  });

  it("Resume in Claude Code, Resume in terminal and Save stop with one message; nothing runs", async () => {
    let looked = 0;
    const lookup = () => { looked++; return found(); };
    const f = fakeExec({ stdout: ID });
    await ext.resumeInClaude(item, lookup, f.exec);
    await ext.resumeSession(item, lookup);
    await ext.saveSession(lookup);
    assert.deepStrictEqual(calls.errors, [0, 1, 2].map(() => ({ message, items: [] })));
    assert.strictEqual(looked, 0, "no CLI lookup on this computer");
    assert.strictEqual(f.seen.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("the login button stops the same way", async () => {
    assert.strictEqual(await ext.runLogin(CLI), undefined);
    assert.deepStrictEqual(calls.errors, [{ message, items: [] }]);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("uses the readable remote label", async () => {
    calls.remoteName = "wsl";
    await ext.resumeSession(item, found);
    assert.match(calls.errors[0].message, /^This window is connected to WSL, .*"Install in WSL" for a4sx/);
  });

  it("only applies in a remote window with the extension on this computer", () => {
    assert.strictEqual(ext.remoteWindowButLocalExtension(), "ssh-remote");
    calls.extensionKind = WORKSPACE;
    assert.strictEqual(ext.remoteWindowButLocalExtension(), undefined);
    calls.extensionKind = UI;
    calls.remoteName = undefined;
    assert.strictEqual(ext.remoteWindowButLocalExtension(), undefined);
  });
});

describe("remote windows: a4sx not found", () => {
  beforeEach(() => remoteWindow());

  it("names the remote, says to install the CLI there, and offers the two buttons", async () => {
    await ext.saveSession(missing);
    assert.deepStrictEqual(calls.errors, [{
      message: "a4sx isn't installed on SSH. Install it there, then try again.",
      items: ["Copy install command", "Open settings"],
    }]);
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(calls.clipboard, undefined, "nothing copied until clicked");
    assert.deepStrictEqual(calls.opened, []);
  });

  it("maps remote names to readable words; unknown names stay as they are", async () => {
    const cases: [string, string][] = [
      ["ssh-remote", "SSH"], ["wsl", "WSL"], ["dev-container", "dev container"], ["attached-container", "container"],
      ["codespaces", "Codespaces"], ["tunnel", "tunnel"], ["my-resolver", "my-resolver"],
    ];
    for (const [name, label] of cases) {
      remoteWindow(name);
      await ext.resumeSession(item, missing);
      assert.strictEqual(calls.errors[0].message, `a4sx isn't installed on ${label}. Install it there, then try again.`, name);
    }
  });

  it("'Copy install command' copies the installer line for the default server", async () => {
    calls.nextErrorChoice = "Copy install command";
    await ext.resumeSession(item, missing);
    assert.strictEqual(calls.clipboard, "curl -fsSL https://session-exchange.com/install.sh | sh");
    assert.deepStrictEqual(calls.infos, ["Copied the install command. Run it in a terminal in this window."]);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("'Copy install command' keeps a plain custom origin, with or without a port", async () => {
    calls.nextErrorChoice = "Copy install command";
    for (const [setting, want] of [
      ["https://a4sx.example.org", "https://a4sx.example.org"],
      ["https://a4sx.example.org/", "https://a4sx.example.org"],
      ["  https://a4sx-1.example.org:8443  ", "https://a4sx-1.example.org:8443"],
    ]) {
      calls.config["a4sx.serverUrl"] = setting;
      await ext.saveSession(missing);
      assert.strictEqual(calls.clipboard, `curl -fsSL ${want}/install.sh | sh`, setting);
    }
  });

  it("'Copy install command' falls back to the default for anything that is not a plain https origin", async () => {
    calls.nextErrorChoice = "Copy install command";
    for (const setting of [
      "https://$(id).example.com", "https://`id`.example.com", "https://a.example.com;id", "https://a.example.com|sh",
      "https://a.example.com/x", "https://a.example.com?q=1", "https://a.example.com#x", "https://u:p@a.example.com",
      "https://A.Example.com", "http://a.example.com", "http://localhost:8080", "https://a.example.com:123456",
      "https://a.example.com /x", "not a url", "",
    ]) {
      calls.config["a4sx.serverUrl"] = setting;
      calls.clipboard = undefined;
      await ext.saveSession(missing);
      assert.strictEqual(calls.clipboard, "curl -fsSL https://session-exchange.com/install.sh | sh", JSON.stringify(setting));
    }
  });

  it("'Open settings' opens the a4sx.cliPath setting", async () => {
    calls.nextErrorChoice = "Open settings";
    await ext.saveSession(missing);
    assert.deepStrictEqual(calls.executed, [{ id: "workbench.action.openSettings", args: ["a4sx.cliPath"] }]);
    assert.strictEqual(calls.clipboard, undefined);
  });

  it("Resume in Claude Code shows the same remote message", async () => {
    calls.workspaceFolders = [folder("proj", "/home/dev/proj")];
    const f = fakeExec({ stdout: ID });
    await ext.resumeInClaude(item, missing, f.exec);
    assert.strictEqual(f.seen.length, 0);
    assert.deepStrictEqual(calls.errors[0].items, ["Copy install command", "Open settings"]);
  });

  it("an invalid a4sx.cliPath keeps the 0.2.1 message", async () => {
    await ext.saveSession(() => ({ found: false, reason: "configured-path-invalid", configured: "/nope/a4sx" }));
    assert.match(calls.errors[0].message, /a4sx\.cliPath setting points to "\/nope\/a4sx"/);
    assert.deepStrictEqual(calls.errors[0].items, ["How to install"]);
  });

  it("a local window keeps the 0.2.1 message", async () => {
    for (const kind of [UI, WORKSPACE]) {
      remoteWindow();
      calls.remoteName = undefined;
      calls.extensionKind = kind;
      await ext.saveSession(missing);
      assert.deepStrictEqual(calls.errors, [{
        message: "The a4sx command was not found. Install the a4sx CLI to save and resume sessions from VS Code, or set a4sx.cliPath to its full path.",
        items: ["How to install"],
      }]);
    }
  });

  // The fallback directories come from os.homedir() of the process the extension runs in; on the
  // remote host that is the remote user's home.
  (process.platform === "win32" ? it.skip : it)("the ~/.local/bin fallback uses the extension host's home directory", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-vscode-home-"));
    const bin = path.join(home, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    const exe = path.join(bin, "a4sx");
    fs.writeFileSync(exe, "#!/bin/sh\n");
    fs.chmodSync(exe, 0o755);
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      assert.deepStrictEqual(findCli(undefined, { pathEnv: "" }), { found: true, path: exe });
    } finally {
      process.env.HOME = oldHome;
      fs.unlinkSync(exe);
      fs.rmdirSync(bin);
      fs.rmdirSync(path.join(home, ".local"));
      fs.rmdirSync(home);
    }
  });
});

describe("not signed in", () => {
  const routerText = "a4sx: the router needs a sign-in — run `a4sx login` first\n";
  const seedText = "a4sx: seeding from a saved session needs a sign-in — run `a4sx login` first\n";

  it("classifies the CLI's sign-in errors", () => {
    assert.strictEqual(cr.isNotSignedIn(1, seedText), true);
    assert.strictEqual(cr.isNotSignedIn(1, `working\n${routerText}`), true);
    assert.strictEqual(cr.isNotSignedIn(0, seedText), false);
    assert.strictEqual(cr.isNotSignedIn(null, seedText), false);
    assert.strictEqual(cr.isNotSignedIn(1, "a4sx: no session named x\n"), false);
    assert.strictEqual(cr.isNotSignedIn(1, "amdx: seeding from a saved session needs a sign-in — run `amdx login` first\n"), true, "legacy name");
    assert.strictEqual(cr.isNotSignedIn(1, "a4sx: run `a4sx login` to switch accounts\n"), false);
    assert.strictEqual(cr.isNotSignedIn(1, "a4sx: this needs a sign-in\n"), false);
  });

  it("seedSession reports not-signed-in", async () => {
    const r = await cr.seedSession(CLI, "n", "/w", fakeExec({ error: Object.assign(new Error("Command failed"), { code: 1 }), stderr: seedText }).exec);
    assert.deepStrictEqual(r, { kind: "not-signed-in" });
  });

  for (const remote of [undefined, "ssh-remote"]) {
    it(`Resume in Claude Code says to run a4sx login; the button opens a terminal running it (${remote ?? "local"})`, async () => {
      remoteWindow();
      calls.remoteName = remote;
      calls.workspaceFolders = [folder("proj", "/home/dev/proj")];
      const exec = fakeExec({ error: Object.assign(new Error("Command failed"), { code: 1 }), stderr: seedText }).exec;
      await ext.resumeInClaude(item, found, exec);
      assert.deepStrictEqual(calls.errors, [{ message: "The a4sx CLI isn't signed in on this machine. Run a4sx login in a terminal, then try again.", items: ["Run a4sx login"] }]);
      assert.strictEqual(calls.terminals.length, 0, "nothing runs until clicked");
      calls.nextErrorChoice = "Run a4sx login";
      await ext.resumeInClaude(item, found, exec);
      assert.deepStrictEqual(calls.terminals.map((t) => t.options), [{ name: ext.LOGIN_TERMINAL_NAME, shellPath: CLI, shellArgs: ["login"] }]);
      assert.ok(calls.terminals[0].shown);
      assert.deepStrictEqual(calls.opened, []);
    });
  }
});
