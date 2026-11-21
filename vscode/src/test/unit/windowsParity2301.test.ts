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
    assert.ok(localCellDescription(mine, BASE).includes("other account"));   // cell01: short, never cut
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
    assert.ok(tip.includes("If it still starts and connects, it belongs to another account"), tip);
  });

  it("the texts, verbatim, with no literal backticks", () => {
    assert.strictEqual(REGISTRY_TEXTS.description.not_in_account, "other account");
    assert.strictEqual(REGISTRY_TEXTS.description.other_account, "other account (its key works)");
    assert.ok(!Object.values(REGISTRY_TEXTS.tooltip).some((t) => t.includes("of your accounts")), "a colleague's too");
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
import { cellLaunchArgs, startHereArgs } from "../../cells";
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

// ---- #2301 E2: This computer (the agent host) ------------------------------------------------------------------------
import { AGENT_HOST_SETUP_ARGS, AGENT_HOST_TEXTS, directLaunch, isOpen, parseAgentHostStatus } from "../../agentHostStatus";
import { CELLS_LIST_ARGS } from "../../cells";
import { LocalCellItem, MeshGroupItem, ThisComputerItem, thisComputerChildren } from "../../cellsView";

// what `agent-host status --json` prints (review: "name (mesh)" entries, the editor keys stable/insiders/…)
const RUNNING = { running: true, proved: true, answering: true, pid: 4242, address: "ws://127.0.0.1:8765/",
  open: ["build (Team mesh)", "notes (plain)"], vscode: { address: "ws://127.0.0.1:8765", editors: { stable: "ok" } },
  last_error: null, cells: [] };

describe("#2301 E2: This computer", () => {
  beforeEach(resetCalls);

  it("reads `agent-host status --json`; anything else is no answer", () => {
    const s = parseAgentHostStatus(JSON.stringify(RUNNING))!;
    assert.deepStrictEqual(s, { running: true, address: "ws://127.0.0.1:8765/", open: [{ name: "build", mesh: "Team mesh" }],
      editors: { stable: "ok" }, lastError: undefined });   // a plain session is no cell row
    assert.strictEqual(parseAgentHostStatus("usage: a4sx …"), undefined);
    assert.strictEqual(parseAgentHostStatus(JSON.stringify({ v: 1 })), undefined);
    const odd = parseAgentHostStatus(JSON.stringify({ ...RUNNING, address: "ws://x/; rm", open: ["../x (m)", "ok (m)"] }))!;
    assert.strictEqual(odd.running, false, "no usable address: not shown as running");
    assert.deepStrictEqual(odd.open, []);
  });

  it("running and set up: one row; stopped: Start agent host and Set up the Agents window; the last error", () => {
    const up = thisComputerChildren(parseAgentHostStatus(JSON.stringify(RUNNING))!);
    assert.deepStrictEqual(up.map((i) => i.label), ["agent host running · 127.0.0.1:8765"]);
    const down = thisComputerChildren(parseAgentHostStatus(JSON.stringify({
      running: false, address: null, open: [], vscode: null, last_error: { at: "2026-11-21T16:00:00Z", text: "port 8765 is taken" },
    }))!);
    // review: not set up and stopped: only Set up (it starts the host too), never two terminals
    assert.deepStrictEqual(down.map((i) => i.label), [AGENT_HOST_TEXTS.stopped, AGENT_HOST_TEXTS.setup,
      "Last error: port 8765 is taken"]);
    assert.strictEqual(down[2].tooltip, "Last error of the agent host (2026-11-21T16:00:00Z): port 8765 is taken");
    const long = "x".repeat(250);
    assert.strictEqual(AGENT_HOST_TEXTS.lastError(long).length, "Last error: ".length + 48, "cell01: short at the default width");
    assert.strictEqual(down[1].command!.command, "a4sx.setupAgentsWindow");
    const setUpStopped = thisComputerChildren(parseAgentHostStatus(JSON.stringify({
      running: false, address: null, open: [], vscode: { editors: { stable: "ok" } }, last_error: null }))!);
    assert.deepStrictEqual(setUpStopped.map((i) => i.label), [AGENT_HOST_TEXTS.stopped, AGENT_HOST_TEXTS.start]);
    assert.strictEqual(setUpStopped[1].command!.command, "a4sx.startAgentHost");
  });

  it("above the meshes when there are cells; its rows read the status once; open cells are marked", async () => {
    const runs: string[] = [];
    const cells = { v: 1, default: "build", cells: [{ ...row("active"), name: "build" }] };
    const run = async (_c: string, args: readonly string[]): Promise<CliOutput> => {
      runs.push(args.join(" "));
      const a = args.join(" ");
      return a === "--version" ? { code: 0, stdout: "a4sx 0.59.7\n", stderr: "" }
        : a === CELLS_LIST_ARGS.join(" ") ? { code: 0, stdout: JSON.stringify(cells), stderr: "" }
          : a === "agent-host status --json" ? { code: 0, stdout: JSON.stringify(RUNNING), stderr: "" }
            : { code: 0, stdout: "[]", stderr: "" };
    };
    const p = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
    const top = await p.getChildren();
    assert.ok(top[0] instanceof ThisComputerItem && top[1] instanceof MeshGroupItem);
    assert.ok(!runs.includes("agent-host status --json"), "not before its rows are asked for");
    const rows = await p.getChildren(top[0]);
    assert.strictEqual(rows[0].label, "agent host running · 127.0.0.1:8765");
    await p.getChildren(top[0]);
    assert.strictEqual(runs.filter((r) => r === "agent-host status --json").length, 1, "once per refresh");
    const group = (await p.getChildren()).find((i) => i instanceof MeshGroupItem)!;
    const build = (await p.getChildren(group)).find((i) => i instanceof LocalCellItem)!;
    assert.ok(String(build.description).endsWith("· open in the Agents window"), String(build.description));
  });

  it("the open mark matches name and mesh: a same-named cell in another mesh isn't marked", () => {
    const s = parseAgentHostStatus(JSON.stringify(RUNNING))!;
    assert.ok(isOpen(s, { name: "build", meshName: "Team mesh", meshId: "msh_x" }));
    assert.ok(!isOpen(s, { name: "build", meshName: "Other", meshId: "msh_y" }));
    assert.ok(isOpen(parseAgentHostStatus(JSON.stringify({ ...RUNNING, open: ["build (msh_x)"] }))!, { name: "build", meshId: "msh_x" }));
  });

  it("Set up runs `a4sx agent-host setup-vscode` (review: there is no top-level setup-vscode)", () => {
    assert.deepStrictEqual([...AGENT_HOST_SETUP_ARGS], ["agent-host", "setup-vscode"]);
    assert.ok(AGENT_HOST_TEXTS.setupTooltip.includes("a4sx agent-host setup-vscode"));
  });

  it("a failing `agent-host status`: the CLI's own line, not \"update a4sx\"", async () => {
    const run = async (_c: string, args: readonly string[]): Promise<CliOutput> =>
      args.join(" ") === "agent-host status --json" ? { code: 1, stdout: "", stderr: "a4sx: the state folder can't be read\n" }
        : args.join(" ") === "--version" ? { code: 0, stdout: "a4sx 0.59.7\n", stderr: "" }
          : { code: 0, stdout: JSON.stringify({ v: 1, default: null, cells: [row("active")] }), stderr: "" };
    const p = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
    const rows = await p.getChildren((await p.getChildren())[0]);
    assert.deepStrictEqual(rows.map((i) => i.label), [AGENT_HOST_TEXTS.failed("the state folder can't be read")]);
  });

  it("an older CLI without `agent-host status`: one row that says so", async () => {
    const run = async (_c: string, args: readonly string[]): Promise<CliOutput> =>
      args.join(" ") === "agent-host status --json" ? { code: 2, stdout: "", stderr: "invalid choice: 'agent-host'" }
        : args.join(" ") === "--version" ? { code: 0, stdout: "a4sx 0.30.0\n", stderr: "" }
          : { code: 0, stdout: JSON.stringify({ v: 1, default: null, cells: [row("active")] }), stderr: "" };
    const p = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
    const top = await p.getChildren();
    const rows = await p.getChildren(top[0]);
    assert.deepStrictEqual(rows.map((i) => i.label), [AGENT_HOST_TEXTS.unknown]);
  });
});


describe("cell01 on Windows: Ctrl+C on the agent host started from here asks nothing", () => {
  it("the a4sx.cmd launcher is started as its python and script (no batch job to terminate)", () => {
    const files: Record<string, string> = { "C:\\Users\\me\\bin\\a4sx.cmd": '@"C:\\Python312\\python.exe" "C:\\Users\\me\\a4sx\\amdx.py" %*\r\n' };
    const exists = (p: string) => p === "C:\\Python312\\python.exe" || p === "C:\\Users\\me\\a4sx\\amdx.py";
    assert.deepStrictEqual(directLaunch("C:\\Users\\me\\bin\\a4sx.cmd", (p) => files[p], exists, "win32"),
      { exe: "C:\\Python312\\python.exe", pre: ["C:\\Users\\me\\a4sx\\amdx.py"] });
    assert.strictEqual(directLaunch("C:\\Users\\me\\bin\\a4sx.cmd", (p) => files[p], () => false, "win32"), undefined, "gone: the launcher");
    const ext = '@echo off\r\n"C:\\Python312\\python.exe" "C:\\Users\\me\\a4sx\\amdx.py" %*\r\n';   // the extension's own (provision.ts)
    assert.deepStrictEqual(directLaunch("C:\\x\\a4sx.cmd", () => ext, exists, "win32"),
      { exe: "C:\\Python312\\python.exe", pre: ["C:\\Users\\me\\a4sx\\amdx.py"] });
    assert.strictEqual(directLaunch("/usr/local/bin/a4sx", () => "", () => true, "linux"), undefined);
    assert.strictEqual(directLaunch("C:\\a.cmd", () => "@echo off\r\nrem something else", () => true, "win32"), undefined);
  });

  it("after Start agent host, the status is read again a few times", async () => {
    const p = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run: async () => ({ code: 0, stdout: "", stderr: "" }),
      server: () => BASE, onState: () => undefined });
    let fired = 0;
    p.onDidChangeTreeData(() => fired++);
    p.rereadHostSoon([1, 2]);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(fired, 2);
  });
});

describe("cell01 (#2301): --mesh only when another stored cell really has the name", () => {
  it("a list read again (new objects) doesn't count the cell itself; a same-named cell in another mesh does", () => {
    const mk = (name: string, meshId: string, instanceId: string) =>
      ({ name, meshId, instanceId, isDefault: false, tags: [] } as unknown as import("../../cells").LocalCell);
    const docs = mk("docs", MESH, "ins_A1");
    const again = [mk("docs", MESH, "ins_A1"), mk("build", MESH, "ins_B1")];
    assert.deepStrictEqual(cellLaunchArgs(docs, again), ["launch", "--cell", "docs"]);
    const other = [...again, mk("docs", "msh_fedcba9876543210fedcba9876543210", "ins_C1")];
    assert.deepStrictEqual(cellLaunchArgs(docs, other), ["launch", "--cell", "docs", "--mesh", MESH]);
  });
});
