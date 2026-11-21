/** #2301 (cell01 on Windows, signed in to a second account): E3 the registry states in words, E7 the layout. */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { localCellDescription, localCellTooltip, REGISTRY_TEXTS } from "../../cells";
import { parseCellsAnswer, REGISTRY_STATES } from "../../cliJson";

const BASE = "https://session-exchange.com";
const row = (state: string) => ({
  name: "build", mesh_id: "msh_0123456789abcdef0123456789abcdef", mesh_name: "Team mesh", instance_id: "ins_A1",
  profile: null, local: { state: "stored", pid: null }, registry: { state }, path: null, mesh_policy: null, tags: [],
});

describe("#2301 E3: a cell the signed-in account doesn't list", () => {
  it("reads the CLI 0.59.6 states and shows them without an alarming word", () => {
    for (const state of ["not_in_account", "other_account"]) {
      const ans = parseCellsAnswer(JSON.stringify({ v: 1, default: null, cells: [row(state)] }))!;
      const cell = ans.cells[0];
      assert.strictEqual(cell.registryState, state);
      const shown = localCellDescription(cell, BASE) + "\n" + localCellTooltip(cell, BASE);
      assert.ok(!/revoked/.test(shown), shown);
    }
    const mine = parseCellsAnswer(JSON.stringify({ v: 1, default: null, cells: [row("not_in_account")] }))!.cells[0];
    assert.ok(localCellDescription(mine, BASE).includes("not in the signed-in account"));
    assert.ok(localCellTooltip(mine, BASE).includes("a4sx mesh cells --refresh"));
  });

  it("every state the extension knows has its words; a revoked one still says so", () => {
    for (const s of REGISTRY_STATES) {
      assert.ok(REGISTRY_TEXTS.description[s] && REGISTRY_TEXTS.tooltip[s], s);
    }
    const gone = parseCellsAnswer(JSON.stringify({ v: 1, default: null, cells: [row("revoked")] }))!.cells[0];
    assert.ok(localCellDescription(gone, BASE).includes("registry revoked"));
    // review: a CLI before 0.59.7 says "revoked" for another account's working cell too: no advice to remove it
    const tip = localCellTooltip(gone, BASE);
    assert.ok(!/forget|remove|make a new cell/i.test(tip), tip);
    assert.ok(tip.includes("If it still starts and connects, it belongs to another of your accounts"), tip);
  });

  it("the texts, verbatim, with no literal backticks", () => {
    assert.strictEqual(REGISTRY_TEXTS.description.not_in_account, "not in the signed-in account");
    assert.strictEqual(REGISTRY_TEXTS.description.other_account, "another account's (its key works)");
    for (const s of REGISTRY_STATES) {
      assert.ok(!REGISTRY_TEXTS.tooltip[s].includes("`"), s);
    }
  });

  it("a state from a newer CLI is unknown, as before", () => {
    const c = parseCellsAnswer(JSON.stringify({ v: 1, default: null, cells: [row("something_new")] }))!.cells[0];
    assert.strictEqual(c.registryState, "unknown");
  });
});

describe("#2301 E7: Cells first", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
  it("Cells and Meshes come first; My sessions and Marketplace start collapsed", () => {
    const views = pkg.contributes.views.a4sx;
    assert.deepStrictEqual(views.map((v: any) => v.id),
      ["a4sx.cells", "a4sx.meshes", "a4sx.sessions", "a4sx.profiles", "a4sx.marketplace"]);
    const vis = Object.fromEntries(views.map((v: any) => [v.id, v.visibility]));
    assert.strictEqual(vis["a4sx.sessions"], "collapsed");
    assert.strictEqual(vis["a4sx.marketplace"], "collapsed");
    assert.strictEqual(vis["a4sx.cells"], "visible");
  });
});

// ---- #2301 E1: Start on this computer, for your own cell on another machine -----------------------------------------
import * as os from "os";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { startHereArgs } from "../../cells";
import { CELL_CMD_TEXTS, CellCommandDeps, startCellHere } from "../../cellCommands";
import { CellsProvider, CliOutput, RemoteCellItem } from "../../cellsView";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscodeFake = require("vscode");
const MESH = "msh_0123456789abcdef0123456789abcdef";
const CLI = "/opt/a4sx/a4sx";

function startHereHarness(version = "0.59.7") {
  const runs: string[] = [];
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    runs.push(args.join(" "));
    if (args.join(" ") === "--version") {
      return { code: 0, stdout: `a4sx ${version}  (server 0.760.0)\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-2301-"));
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
  const deps: CellCommandDeps = {
    state: fakeMemento() as any, cliDir: undefined, provider, resolve: () => ({ kind: "found", path: CLI }), run,
    server: () => BASE, defaultServer: BASE, folder: async () => "/w/proj",
    fetch: async () => { throw new Error("no network in tests"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
    stateDir: tmp(), claudeProjects: tmp(), home: tmp(),
  };
  calls.nextOpenDialog = [vscodeFake.Uri.file("/w/proj")];
  return { deps, runs };
}

describe("#2301 E1: Start on this computer", () => {
  beforeEach(resetCalls);

  it("your own cell elsewhere: `a4sx launch --cell NAME --mesh MESH` in a terminal; the CLI decides and says why", async () => {
    const h = startHereHarness();
    const item = new RemoteCellItem(MESH, { instanceId: "ins_D1", name: "desk-agent", own: true, tags: [] });
    assert.strictEqual(item.contextValue, "a4sx.remoteCell.own");
    const t = await startCellHere(h.deps, item);
    assert.ok(t);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--cell' 'desk-agent' '--mesh' '${MESH}'\n`]);
    assert.ok(!h.runs.some((r) => r.startsWith("launch")), "never started without a terminal");
    assert.ok(calls.infos.some((m: string) => m.startsWith("Starting «desk-agent» on this computer")), JSON.stringify(calls.infos));
  });

  it("another person's cell has no such action, and starts nothing", async () => {
    const h = startHereHarness();
    const item = new RemoteCellItem(MESH, { instanceId: "ins_L1", name: "laptop-agent", own: false, tags: [] });
    assert.strictEqual(item.contextValue, "a4sx.remoteCell");
    assert.strictEqual(await startCellHere(h.deps, item), undefined);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("a name or mesh id the CLI doesn't take starts nothing and says so", async () => {
    const h = startHereHarness();
    assert.strictEqual(startHereArgs("Bad Name", MESH), undefined);
    assert.strictEqual(startHereArgs("ok", "msh_x; rm"), undefined);
    const item = new RemoteCellItem(MESH, { instanceId: "ins_D1", name: "bad name", own: true, tags: [] });
    assert.strictEqual(await startCellHere(h.deps, item), undefined);
    assert.strictEqual(calls.terminals.length, 0);
    assert.ok(calls.errors.some((e) => e.message === CELL_CMD_TEXTS.startHereBad), JSON.stringify(calls.errors));
  });
});
