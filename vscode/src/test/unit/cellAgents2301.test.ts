/**
 * a4sx #2301 (the owner, 2026-11-21: "would it make sense to add operations to resume/start it in ahp as well?"):
 * "Open in Agents window" on a cell stored on this computer. It opens the Agents window's own link to the cell's
 * session; without a running agent host, or without the Agents window set up, it offers that one step and opens nothing.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { agentsWindowLink, CELL_ACTION_TEXTS, CellActionDeps, CMD_CELL_OPEN_AGENTS, openCellInAgentsWindow } from "../../cellActions";
import { AGENT_HOST_TEXTS } from "../../agentHostStatus";
import { CELL_CMD_TEXTS } from "../../cellCommands";
import { CellsProvider, CliOutput, CMD_SETUP_AGENTS_WINDOW, CMD_START_AGENT_HOST, LocalCellItem } from "../../cellsView";
import { parseCellsAnswer } from "../../cliJson";

const BASE = "https://session-exchange.com";
const MESH = "msh_0123456789abcdef0123456789abcdef";
const CLI = "/opt/a4sx/a4sx";
const INS = "ins_fc319f874d0d16d0b38ae01af3af0728";
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
const status = (o: Record<string, unknown>) => JSON.stringify({ running: true, proved: true, answering: true, pid: 4242, address: "ws://127.0.0.1:8799/",
  open: [], vscode: { address: "ws://127.0.0.1:8799", editors: { stable: "ok" } }, last_error: null, cells: [], ...o });

function harness(statusOut: CliOutput, meshId: string | null = MESH) {
  const runs: string[] = [];
  const cellsJson = JSON.stringify({ v: 1, default: "build", cells: [{ name: "build", mesh_id: meshId, mesh_name: meshId ? "Team mesh" : null, instance_id: INS, profile: null,
    local: { state: "stored", pid: null }, registry: { state: "active" }, path: null, mesh_policy: null, tags: [] }] });
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    const line = args.join(" ");
    runs.push(line);
    return line === "agent-host status --json" ? statusOut : { code: 0, stdout: line === "mesh cells --json" ? cellsJson : "", stderr: "" };
  };
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
  const deps: CellActionDeps = {
    state: fakeMemento() as any, cliDir: undefined, provider, resolve: () => ({ kind: "found", path: CLI }), run,
    server: () => BASE, defaultServer: BASE, folder: async () => "/w/proj",
    fetch: async () => { throw new Error("no network in tests"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
    show: () => undefined,
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

  it("agent host not running: says so and offers Start agent host; nothing opens", async () => {
    const h = harness({ code: 0, stdout: status({ running: false, address: null }), stderr: "" });
    calls.nextInfoChoice = AGENT_HOST_TEXTS.start;
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), false);
    assert.deepStrictEqual(calls.infoPrompts, [{ message: "The a4sx agent host isn't running on this computer, so the Agents window can't reach «build». Start it, then choose Open in Agents window again.", items: ["Start agent host"] }]);
    assert.deepStrictEqual(calls.executed.map((e) => e.id), [CMD_START_AGENT_HOST]);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("the Agents window not set up: offers Set up the Agents window first, even with the host stopped", async () => {
    const h = harness({ code: 0, stdout: status({ running: false, vscode: null }), stderr: "" });
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), false);   // the offer is declined
    assert.deepStrictEqual(calls.infoPrompts, [{ message: CELL_ACTION_TEXTS.agentsNotSetUp, items: [AGENT_HOST_TEXTS.setup] }]);
    assert.strictEqual(calls.executed.length, 0);
    calls.nextInfoChoice = AGENT_HOST_TEXTS.setup;
    await openCellInAgentsWindow(h.deps, h.item);
    assert.deepStrictEqual(calls.executed.map((e) => e.id), [CMD_SETUP_AGENTS_WINDOW]);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("an older CLI, a failing status, a standalone cell, a link VS Code refuses: said, nothing opens", async () => {
    const old = harness({ code: 0, stdout: "not json", stderr: "" });
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
