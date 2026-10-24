// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Remote windows (SSH, WSL, dev containers, Codespaces): the extension runs on the remote host there.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, fakeMemento, fakeSecrets, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
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

/** A remote window with the extension on the remote host (VS Code's default for this extension). */
function remoteWindow(name = "ssh-remote"): void {
  resetCalls();
  calls.extensions.add("anthropic.claude-code");
  calls.remoteName = name;
  calls.extensionKind = WORKSPACE;
}

describe("remote windows: the folders a session can be resumed in", () => {
  beforeEach(() => remoteWindow());
  const targets = (folders: any[]) => ext.folderTargets(folders as any, ext.remoteHostName()).map((t) => [t.folder.name, t.cwd]);

  it("on the remote host: file and vscode-remote folders count, at their paths on that host", () => {
    assert.deepStrictEqual(targets([folder("proj", "/home/dev/proj", "vscode-remote"), folder("api", "/home/dev/api")]),
      [["proj", "/home/dev/proj"], ["api", "/home/dev/api"]]);
  });

  it("virtual and other schemes never count, in remote and local windows", () => {
    for (const remote of ["ssh-remote", undefined]) {
      calls.remoteName = remote;
      for (const scheme of ["vscode-vfs", "untitled", "vscode-local"]) {
        assert.deepStrictEqual(targets([folder("x", "/x", scheme)]), [], `${remote} ${scheme}`);
      }
    }
  });

  it("a local window ignores vscode-remote folders, as in 0.2.1", () => {
    calls.remoteName = undefined;
    calls.extensionKind = UI;
    assert.deepStrictEqual(targets([folder("web", "/home/dev/web", "vscode-remote"), folder("proj", "/w/proj")]), [["proj", "/w/proj"]]);
  });

  it("only virtual folders: Resume in Claude Code says a folder on disk is needed", async () => {
    calls.workspaceFolders = [folder("x", "/x", "vscode-vfs")];
    ext.activate({ subscriptions: [], secrets: fakeSecrets(), globalState: fakeMemento() } as any);
    await (ext.sidebar!.auth as any).secrets.store("a4sx.auth", JSON.stringify({ token: "t", server: "https://session-exchange.com", id: "i", scopes: ["library:read"] }));
    await ext.resumeInClaude(item);
    assert.deepStrictEqual(calls.errors, [{ message: ext.CLAUDE_MESSAGES.notOnDisk, items: [] }]);
    assert.deepStrictEqual(calls.opened, []);
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
    let claudeLooked = 0;
    await ext.resumeInClaude(item);
    await ext.resumeSession(item, lookup, undefined, () => { claudeLooked++; return "/usr/bin/claude"; });
    await ext.saveSession(lookup);
    assert.deepStrictEqual(calls.errors, [0, 1, 2].map(() => ({ message, items: [] })));
    assert.strictEqual(looked, 0, "no CLI lookup on this computer");
    assert.strictEqual(claudeLooked, 0, "no claude lookup either");
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("the profile terminal stops the same way", async () => {
    assert.strictEqual(await ext.runProfileCli("work", found), undefined);
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
      await ext.saveSession(missing);
      assert.strictEqual(calls.errors[0].message, `a4sx isn't installed on ${label}. Install it there, then try again.`, name);
    }
  });

  it("'Copy install command' copies the installer line for the default server", async () => {
    calls.nextErrorChoice = "Copy install command";
    await ext.saveSession(missing);
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

  it("Resume in terminal without a4sx on the remote host goes CLI-free: it looks for claude there instead", async () => {
    calls.workspaceFolders = [folder("proj", "/home/dev/proj")];
    let claudeLooked = 0;
    await ext.resumeSession(item, missing, undefined, () => { claudeLooked++; return undefined; });
    assert.strictEqual(claudeLooked, 1);
    assert.deepStrictEqual(calls.errors.map((e) => e.items), [["How to install"]], "Claude Code's install hint, not a4sx's");
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
