/**
 * a4sx #2301 (the owner, 2026-11-21: "would it make sense to add operations to resume/start it in ahp as well?"):
 * "Open in Agents window" on a cell stored on this computer. It opens the Agents window's own link to the cell's
 * session; without a running agent host, or without the Agents window set up, it offers that one step and opens nothing.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { AGENTS_WAIT_MS, agentsWindowLink, CELL_ACTION_TEXTS, waitForHost, CellActionDeps, CMD_CELL_OPEN_AGENTS, openCellInAgentsWindow } from "../../cellActions";
import { AGENT_HOST_TEXTS, agentsWindowSetUp } from "../../agentHostStatus";
import { CELL_CMD_TEXTS } from "../../cellCommands";
import { CellsProvider, CliOutput, LocalCellItem } from "../../cellsView";
import { parseCellsAnswer } from "../../cliJson";

const BASE = "https://session-exchange.com";
const MESH = "msh_0123456789abcdef0123456789abcdef";
const CLI = "/opt/a4sx/a4sx";
const INS = "ins_fc319f874d0d16d0b38ae01af3af0728";
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
const status = (o: Record<string, unknown>) => JSON.stringify({ running: true, proved: true, answering: true, pid: 4242, address: "ws://127.0.0.1:8799/",
  open: [], vscode: { address: "ws://127.0.0.1:8799", editors: { stable: "ok" } }, last_error: null, cells: [], ...o });

function harness(statusOuts: CliOutput | CliOutput[], meshId: string | null = MESH, localState = "stored") {
  const runs: string[] = [];
  const cellsJson = JSON.stringify({ v: 1, default: "build", cells: [{ name: "build", mesh_id: meshId, mesh_name: meshId ? "Team mesh" : null, instance_id: INS, profile: null,
    local: { state: localState, pid: null }, registry: { state: "active" }, path: null, mesh_policy: null, tags: [] }] });
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    const line = args.join(" ");
    runs.push(line);
    // a list: one answer per status call, the last one kept (the host starting up)
    const statusOut = Array.isArray(statusOuts) ? (statusOuts.length > 1 ? statusOuts.shift()! : statusOuts[0]) : statusOuts;
    return line === "agent-host status --json" ? statusOut : { code: 0, stdout: line === "mesh cells --json" ? cellsJson : "", stderr: "" };
  };
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
  const deps: CellActionDeps = {
    state: fakeMemento() as any, cliDir: undefined, provider, resolve: () => ({ kind: "found", path: CLI }), run,
    server: () => BASE, defaultServer: BASE, folder: async () => "/w/proj",
    fetch: async () => { throw new Error("no network in tests"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
    show: () => undefined, agentsWait: { ms: 600, pollMs: 20 },
  };
  const cells = parseCellsAnswer(cellsJson)!.cells;
  return { deps, runs, item: new LocalCellItem(cells[0], cells, BASE) };
}

describe("#2301: Open in Agents window", () => {
  beforeEach(resetCalls);

  it("the link is the Agents window's own Copy Link of a cell row", () => {
    // read from VS Code 1.147 on Windows (cell01, 2026-11-21): vscode://agents/agent-host-session/ahp-session/a4sx-cell-ins_…
    assert.strictEqual(agentsWindowLink("vscode", INS), `vscode://agents/agent-host-session/ahp-session/a4sx-cell-${INS}`);
    assert.strictEqual(agentsWindowLink("vscode-insiders", INS), `vscode-insiders://agents/agent-host-session/ahp-session/a4sx-cell-${INS}`);
    assert.strictEqual(agentsWindowLink("vscode", "ins_x/../y"), undefined);
    assert.strictEqual(agentsWindowLink("java script", INS), undefined);
  });

  it("agent host running and the Agents window set up: opens the link, starts nothing itself", async () => {
    const h = harness({ code: 0, stdout: status({}), stderr: "" });
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), true);
    assert.deepStrictEqual(calls.opened, [`vscode://agents/agent-host-session/ahp-session/a4sx-cell-${INS}`]);
    assert.deepStrictEqual(h.runs, ["agent-host status --json"], "one local question, no launch");
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("agent host not running: one action: it starts the host, waits until it answers, then opens the cell (cell01, #2309)", async () => {
    const off = { code: 0, stdout: status({ running: false, address: null }), stderr: "" };
    const h = harness([off, off, off, { code: 0, stdout: status({}), stderr: "" }]);
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), true);
    assert.deepStrictEqual(calls.infoPrompts, [], "no second click: nothing to choose");
    assert.deepStrictEqual(calls.progress.map((p) => p.title), ["Starting the a4sx agent host, then opening «build» in the Agents window…"]);
    assert.deepStrictEqual(calls.terminals.map((t) => t.options.name), [AGENT_HOST_TEXTS.startTerminal], "started here, not through a command");
    assert.deepStrictEqual(calls.executed, []);
    assert.deepStrictEqual(h.runs, Array(4).fill("agent-host status --json"), "asked until it ran, then no more");
    assert.deepStrictEqual(calls.opened, [`vscode://agents/agent-host-session/ahp-session/a4sx-cell-${INS}`]);
  });

  it("agent host started but not answering in time: says so with where to look; nothing opens", async () => {
    const h = harness({ code: 0, stdout: status({ running: false, address: null }), stderr: "" });
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), false);
    assert.strictEqual(calls.terminals.length, 1);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [CELL_ACTION_TEXTS.agentsHostSlow(1)]);
    assert.strictEqual(CELL_ACTION_TEXTS.agentsHostSlow(30), "The a4sx agent host didn't answer within 30 seconds, so the Agents window wasn't opened. Its terminal \"a4sx: agent host\" says why; choose Open in Agents window again once it runs.");
    assert.strictEqual(AGENTS_WAIT_MS, 30_000);
    assert.deepStrictEqual(calls.opened, []);
    // a failing status while it starts is waited through, not shown
    const flaky = harness([{ code: 0, stdout: status({ running: false, address: null }), stderr: "" }, { code: 1, stdout: "", stderr: "busy" }, { code: 0, stdout: status({}), stderr: "" }]);
    assert.strictEqual(await openCellInAgentsWindow(flaky.deps, flaky.item), true);
  });

  it("review: a host that runs but didn't answer yet isn't ready; Cancel, a closed terminal, a host that failed, no CLI", async () => {
    const off = { code: 0, stdout: status({ running: false, address: null }), stderr: "" };
    const silent = { code: 0, stdout: status({ answering: false }), stderr: "" };
    const h = harness([off, silent, silent, { code: 0, stdout: status({ answering: true }), stderr: "" }]);
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), true);
    assert.strictEqual(h.runs.length, 4, "waited through the host that didn't answer yet");
    resetCalls();
    calls.cancelProgress = true;   // Cancel on the progress notification
    const c = harness(off);
    assert.strictEqual(await openCellInAgentsWindow(c.deps, c.item), false);
    assert.deepStrictEqual(c.runs, ["agent-host status --json"], "no wait after a cancel");
    assert.strictEqual(calls.errors.length, 0);
    assert.deepStrictEqual(calls.infos, [CELL_ACTION_TEXTS.agentsWaitCancelled]);
    assert.strictEqual(calls.progress[0].options.cancellable, true);
    resetCalls();
    const e = harness(off);
    const vs = require("vscode") as any;
    const make = vs.window.createTerminal;
    vs.window.createTerminal = (o: unknown) => ({ ...make(o), exitStatus: { code: undefined, reason: 3 } });   // you closed it
    try {
      assert.strictEqual(await openCellInAgentsWindow(e.deps, e.item), false);
    } finally {
      vs.window.createTerminal = make;
    }
    assert.strictEqual(calls.errors.length, 0, "nothing to say: you closed it");
    assert.deepStrictEqual(calls.opened, []);
    resetCalls();
    // review: a host run as the terminal's own process (a shell VS Code doesn't know) that ended: said, with its code
    const x = harness(off);
    vs.window.createTerminal = (o: unknown) => ({ ...make(o), exitStatus: { code: 1, reason: 2 } });
    try {
      assert.strictEqual(await openCellInAgentsWindow(x.deps, x.item), false);
    } finally {
      vs.window.createTerminal = make;
    }
    assert.deepStrictEqual(calls.errors.map((m) => m.message), [CELL_ACTION_TEXTS.agentsHostEnded("its terminal ended with exit code 1")]);
    resetCalls();
    // the host stopped with an error (its shell stays open, so only the status says so): said at once, with the error
    const now = new Date().toISOString();
    const failed = harness([off, { code: 0, stdout: status({ running: false, address: null, last_error: { at: now, text: "couldn't listen on 127.0.0.1:8765" } }), stderr: "" }]);
    const t0 = Date.now();
    assert.strictEqual(await openCellInAgentsWindow(failed.deps, failed.item), false);
    assert.ok(Date.now() - t0 < 500, "not the whole wait");
    assert.deepStrictEqual(calls.errors.map((x) => x.message), [CELL_ACTION_TEXTS.agentsHostEnded("couldn't listen on 127.0.0.1:8765")]);
    assert.strictEqual(CELL_ACTION_TEXTS.agentsHostEnded("x"), "The a4sx agent host stopped before it answered (x), so the Agents window wasn't opened. Its terminal \"a4sx: agent host\" has the details; choose Open in Agents window again once that is fixed.");
    resetCalls();
    // an older error (from before this start) is not this start's
    const old = harness([off, { code: 0, stdout: status({ running: false, address: null, last_error: { at: "2020-01-01T00:00:00Z", text: "old" } }), stderr: "" }]);
    assert.strictEqual(await openCellInAgentsWindow(old.deps, old.item), false);
    assert.deepStrictEqual(calls.errors.map((x) => x.message), [CELL_ACTION_TEXTS.agentsHostSlow(1)]);
    resetCalls();
    const n = harness(off);
    let asked = 0;
    n.deps.resolve = () => (asked++ === 0 ? { kind: "found", path: CLI } : { kind: "no-cli" });   // gone before the start
    assert.strictEqual(await openCellInAgentsWindow(n.deps, n.item), false);
    assert.deepStrictEqual(n.runs, ["agent-host status --json"], "nothing to wait for");
    assert.ok(!calls.errors.some((x) => x.message.startsWith("The a4sx agent host didn't answer")));
  });

  it("waitForHost: each status call gets only the time that is left", async () => {
    const h = harness({ code: 0, stdout: status({ running: false, address: null }), stderr: "" });
    const asks: { at: number; ms: number }[] = [];
    const run = h.deps.run;
    h.deps.run = async (cli, args, ms) => { asks.push({ at: Date.now(), ms: ms ?? -1 }); return run(cli, args, ms); };
    const t0 = Date.now();
    assert.strictEqual(await waitForHost(h.deps, CLI, 400, 20), undefined);
    assert.ok(asks.length > 0 && asks.every((a) => a.ms >= 200 && a.at + a.ms <= t0 + 400 + 30), "never past the end");
  });

  it("the Agents window not set up: offers Set up the Agents window first, even with the host stopped", async () => {
    const h = harness({ code: 0, stdout: status({ running: false, vscode: null }), stderr: "" });
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), false);   // the offer is declined
    assert.deepStrictEqual(calls.infoPrompts, [{ message: CELL_ACTION_TEXTS.agentsNotSetUp, items: [AGENT_HOST_TEXTS.setup] }]);
    assert.strictEqual(calls.terminals.length, 0);
    calls.nextInfoChoice = AGENT_HOST_TEXTS.setup;
    await openCellInAgentsWindow(h.deps, h.item);
    // cell01 (#2309): the first click works: set up here, not through a command a notification may drop
    assert.deepStrictEqual(calls.terminals.map((t) => t.options.name), [AGENT_HOST_TEXTS.setupTerminal]);
    assert.deepStrictEqual(calls.executed, []);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("an older CLI, a failing status, a standalone cell, a link VS Code refuses: said, nothing opens", async () => {
    // review: an older a4sx fails with argparse's invalid choice (not a 0 exit with bad JSON)
    const old = harness({ code: 2, stdout: "", stderr: "a4sx: error: argument cmd: invalid choice: 'agent-host'\n" });
    assert.strictEqual(await openCellInAgentsWindow(old.deps, old.item), false);
    assert.strictEqual(calls.errors[0].message, CELL_ACTION_TEXTS.agentsNoStatus);
    const failed = harness({ code: 1, stdout: "", stderr: "a4sx: refusing the a4sx folders\n" });
    assert.strictEqual(await openCellInAgentsWindow(failed.deps, failed.item), false);
    assert.strictEqual(calls.errors[1].message, CELL_CMD_TEXTS.cliFailed("read the agent host's status", "refusing the a4sx folders"));
    const alone = harness({ code: 0, stdout: status({}), stderr: "" }, null);
    assert.strictEqual(await openCellInAgentsWindow(alone.deps, alone.item), false);
    assert.strictEqual(calls.errors[2].message, "The cell «build» isn't in a mesh yet, so the agent host doesn't serve it.");
    assert.deepStrictEqual(alone.runs, []);
    const refused = harness({ code: 0, stdout: status({}), stderr: "" });
    calls.openResult = false;
    assert.strictEqual(await openCellInAgentsWindow(refused.deps, refused.item), false);
    assert.strictEqual(calls.errors[3].message, "VS Code didn't open the link to the Agents window.");
  });

  it("the menu: first on a mesh cell stored here, running or not; not inline, not in the Command Palette", () => {
    const menu = pkg.contributes.menus["view/item/context"].filter((m: any) => m.command === CMD_CELL_OPEN_AGENTS);
    assert.strictEqual(menu.length, 1);
    assert.strictEqual(menu[0].group, "0_cell_open@1");
    const re = new RegExp(menu[0].when.match(/viewItem =~ \/(.*)\/$/)[1]);
    assert.deepStrictEqual(["a4sx.localCell", "a4sx.localCell.default.running", "a4sx.localCell.standalone", "a4sx.localCell.legacy", "a4sx.remoteCell.own"].map((x) => re.test(x)),
      [true, true, false, false, false]);
    assert.strictEqual(pkg.contributes.commands.find((c: any) => c.command === CMD_CELL_OPEN_AGENTS).title, "Open in Agents window");
    assert.ok(pkg.contributes.menus.commandPalette.some((m: any) => m.command === CMD_CELL_OPEN_AGENTS && m.when === "false"));
  });
});


describe("#34 review: Open in Agents window edge cases", () => {
  beforeEach(resetCalls);

  it("a cell running in a terminal here: says so and offers Stop it; nothing opens", async () => {
    const h = harness({ code: 0, stdout: status({ open: [] }), stderr: "" }, MESH, "running");
    calls.nextInfoChoice = CELL_ACTION_TEXTS.stopIt;
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), false);
    assert.deepStrictEqual(calls.opened, []);
    assert.deepStrictEqual(calls.executed.map((e) => e.id), ["a4sx.stopCell"]);
  });

  it("a cell running in a terminal with the host stopped: Stop it first, not Start the host", async () => {
    const h = harness({ code: 0, stdout: status({ running: false, address: null, open: [] }), stderr: "" }, MESH, "running");
    await openCellInAgentsWindow(h.deps, h.item);
    assert.deepStrictEqual(calls.infos, [CELL_ACTION_TEXTS.agentsRunningElsewhere("build")], "Stop it is the first step");
    assert.deepStrictEqual(calls.opened, []);
  });

  it("the set-up check is this editor's when setup-vscode set it up", () => {
    const s = { running: true, open: [], editors: { stable: "ok", insiders: "missing" } } as any;
    assert.strictEqual(agentsWindowSetUp(s, "vscode"), true);
    assert.strictEqual(agentsWindowSetUp(s, "vscode-insiders"), false);
    assert.strictEqual(agentsWindowSetUp(s, "vscodium"), false, "a known editor setup-vscode didn't set up");
    assert.strictEqual(agentsWindowSetUp({ running: true, open: [], editors: { stable: "ok" } } as any, "vscodium"), false);
    assert.strictEqual(agentsWindowSetUp({ running: true, open: [], editors: { stable: "ok" } } as any, "cursor"), true, "unknown: all ok");
  });

  it("a hostile status answer can't change the opened link", async () => {
    const h = harness({ code: 0, stdout: status({ address: "ws://evil.example:1/", open: ["x (y)"] }), stderr: "" });
    await openCellInAgentsWindow(h.deps, h.item);
    assert.strictEqual(calls.opened.length, 1, "it opened: the loop below checks something");
    for (const u of calls.opened) {
      assert.ok(String(u).includes("://agents/agent-host-session/ahp-session/a4sx-cell-ins_"), String(u));
      assert.ok(!String(u).includes("evil"), String(u));
    }
  });
});
