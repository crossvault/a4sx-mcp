/** a4sx CLI `ended_why`: an agent host whose terminal went away (VS Code closed with it) says so on This computer. */
import * as assert from "assert";
import { AGENT_HOST_TEXTS, parseAgentHostStatus } from "../../agentHostStatus";
import { thisComputerChildren } from "../../cellsView";

const stopped = (extra: Record<string, unknown>) => parseAgentHostStatus(JSON.stringify({ running: false, open: [], ...extra }))!;

describe("agent host ended when its terminal or VS Code was closed", () => {
  it("reads ended_why \"terminal closed\" while the host doesn't run, and shows it on the host row", () => {
    const s = stopped({ ended_why: "terminal closed", stopped_at: "2026-11-22T19:00:00Z" });
    assert.strictEqual(s.endedWhy, "terminal closed");
    assert.strictEqual(String(thisComputerChildren(s)[0].label), "agent host ended when its terminal or VS Code was closed");
    assert.strictEqual(AGENT_HOST_TEXTS.endedClosed, "agent host ended when its terminal or VS Code was closed");
  });

  it("a closed host whose stop Windows cut short (no stop time) isn't also called an unclean end", () => {
    const s = stopped({ ended_why: "terminal closed", started_at: "2026-11-22T18:00:00Z" });
    const labels = thisComputerChildren(s).map((i) => String(i.label));
    assert.strictEqual(labels[0], AGENT_HOST_TEXTS.endedClosed);
    assert.ok(!labels.includes(AGENT_HOST_TEXTS.uncleanEnd), labels.join(" | "));
    const old = thisComputerChildren(stopped({ started_at: "2026-11-22T18:00:00Z" })).map((i) => String(i.label));
    assert.ok(old.includes(AGENT_HOST_TEXTS.uncleanEnd), "without a reason: as before");
  });

  it("without a known reason (an older CLI, null, anything else) the old text stays", () => {
    for (const extra of [{}, { ended_why: null }, { ended_why: "crashed" }, { ended_why: 1 }]) {
      const s = stopped(extra);
      assert.strictEqual(s.endedWhy, undefined, JSON.stringify(extra));
      assert.strictEqual(String(thisComputerChildren(s)[0].label), AGENT_HOST_TEXTS.stopped);
    }
  });

  it("a running host never shows it", () => {
    const s = parseAgentHostStatus(JSON.stringify({ running: true, address: "ws://127.0.0.1:8765/", open: [], ended_why: "terminal closed" }))!;
    assert.strictEqual(s.endedWhy, undefined);
    assert.match(String(thisComputerChildren(s)[0].label), /^agent host running/);
  });
});

describe("#2309 (p): This computer always has two rows, so the cell rows below never move", () => {
  const rows = (raw: Record<string, unknown>, can = false) => thisComputerChildren(parseAgentHostStatus(JSON.stringify({ open: [], ...raw }))!, can);
  const OK = { vscode: { editors: { stable: "ok" } } };
  it("in every state: running (Stop or the greyed Stop), stopped, ended, unclean, not set up, with and without an error", () => {
    const err = { last_error: { at: "2026-11-22T10:00:00Z", text: "boom" } };
    const states: Record<string, unknown>[] = [
      { running: true, address: "ws://127.0.0.1:8765/", stop_request: 2, ...OK },
      { running: true, address: "ws://127.0.0.1:8765/", stop_request: 0, ...OK, ...err },
      { running: true, address: "ws://127.0.0.1:8765/" },
      { running: false, ...OK },
      { running: false, ...OK, ...err },
      { running: false, ...OK, started_at: "2026-11-22T08:00:00Z" },
      { running: false, ...OK, started_at: "2026-11-22T08:00:00Z", ended_why: "terminal closed", ...err },
      { running: false },
    ];
    for (const s of states) {
      const r = rows(s);
      assert.strictEqual(r.length, 2, JSON.stringify(s));
      assert.ok(r[1].command || String(r[1].label).startsWith("Stop agent host (needs"), JSON.stringify(s));
    }
  });
  it("the action is Set up when the Agents window isn't set up, else Stop while running, else Start", () => {
    assert.strictEqual(rows({ running: true, address: "ws://127.0.0.1:8765/", stop_request: 2 })[1].label, AGENT_HOST_TEXTS.setup);
    assert.strictEqual(rows({ running: true, address: "ws://127.0.0.1:8765/", stop_request: 2, ...OK })[1].label, AGENT_HOST_TEXTS.stop);
    assert.strictEqual(rows({ running: false, ...OK })[1].label, AGENT_HOST_TEXTS.start);
  });
});

describe("#2309 F10: the CLI's sign-in file is watched, never read", () => {
  it("its folders are the CLI's config folders (new and old), per platform", () => {
    const { cliSignInDirs, CLI_SIGN_IN_FILE } = require("../../cells");
    assert.deepStrictEqual(cliSignInDirs("linux", "/home/me"), ["/home/me/.config/a4sx", "/home/me/.config/agent-mdx"]);
    assert.deepStrictEqual(cliSignInDirs("win32", "C:\\Users\\me"), ["C:\\Users\\me\\.config\\a4sx", "C:\\Users\\me\\.config\\agent-mdx"]);
    assert.strictEqual(CLI_SIGN_IN_FILE, "session");
  });
  it("activate watches it and reads Cells and Launch profiles again on a change; the file is never opened", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "..", "..", "..", "src", "extension.ts"), "utf8");
    assert.match(src, /for \(const dir of cliSignInDirs\(\)\) \{\n\s*const w = vscode\.workspace\.createFileSystemWatcher\(new vscode\.RelativePattern\(vscode\.Uri\.file\(dir\), CLI_SIGN_IN_FILE\)\);\n\s*context\.subscriptions\.push\(w, w\.onDidChange\(refreshAll\), w\.onDidCreate\(refreshAll\), w\.onDidDelete\(refreshAll\)\);/);
    for (const f of fs.readdirSync(require("path").join(__dirname, "..", "..", "..", "src")).filter((n: string) => n.endsWith(".ts"))) {
      const t = fs.readFileSync(require("path").join(__dirname, "..", "..", "..", "src", f), "utf8");
      assert.ok(!/readFile[^\n]*CLI_SIGN_IN_FILE|CLI_SIGN_IN_FILE[^\n]*readFile/.test(t), f);
    }
  });
});
