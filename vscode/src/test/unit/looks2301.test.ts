/**
 * a4sx #2301, the looks (the owner, 2026-11-21: "could we make the plugin a bit prettier and sleeker?"):
 * a row's state as its icon's colour, other members' cells folded into one row, and one status bar item that shows
 * what the Cells view last read and runs nothing itself.
 */
import * as assert from "assert";
import { calls, resetCalls } from "../fakeVscode";
import {
  CELL_ICON_COLORS, CELL_TEXTS, CellsProvider, CliOutput, FOLD_OTHERS_ABOVE, LocalCellItem, localCellIcon, MeshGroupItem, OtherCellsItem, RemoteCellItem, remoteCellIcon,
  ThisComputerItem,
} from "../../cellsView";
import { parseCellsAnswer, parsePeersAnswer, peerPresence } from "../../cliJson";
import { cellsStatusBar, cellsSummary, CMD_FOCUS_CELLS, STATUS_BAR_ID, statusBarText, statusBarTooltip } from "../../statusBar";

const BASE = "https://session-exchange.com";
const MESH = "msh_0123456789abcdef0123456789abcdef";
const CLI = "/opt/a4sx/a4sx";

const row = (o: Record<string, unknown>) => ({
  mesh_id: MESH, mesh_name: "Team mesh", instance_id: "ins_A1", profile: null, local: { state: "stored", pid: null }, registry: { state: "active" }, path: null,
  mesh_policy: "open", tags: [], ...o,
});
const CELLS = {
  v: 1, default: "build",
  cells: [
    row({ name: "build", instance_id: "ins_A1", local: { state: "running", pid: 4242 } }),
    row({ name: "docs", instance_id: "ins_D4" }),
    row({ name: "other", instance_id: "ins_E5", registry: { state: "revoked" } }),
    row({ name: "spare", mesh_id: null, mesh_name: null, instance_id: "ins_C3", mesh_policy: null }),
  ],
};
// as CLI 0.59 prints a peer (read on Windows, 2026-11-21): `state` is the registry's word, `presence` says online/offline
const peer = (n: number, o: Record<string, unknown> = {}) => ({ instance_id: `ins_P${n}`, name: `peer-${n}`, tier: "uid", state: "active", presence: n % 2 ? "online" : "offline", own: false, ...o });
const peersJson = (others: number, own = 1) => JSON.stringify({
  v: 1, mesh_id: MESH,
  peers: [...Array.from({ length: own }, (_, i) => peer(90 + i, { name: `mine-${i}`, own: true, presence: "offline" })), ...Array.from({ length: others }, (_, i) => peer(i + 1))],
});
const hostJson = (o: Record<string, unknown> = {}) => JSON.stringify({ running: true, address: "ws://127.0.0.1:8799/", open: [], vscode: { editors: { stable: "ok" } }, last_error: null, ...o });

function harness(others: number, host: string = hostJson(), cells: unknown = CELLS) {
  const runs: string[] = [];
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    const key = args.join(" ");
    runs.push(key);
    const stdout = key === "--version" ? "a4sx 0.59.2  (server 0.752.0)" : key === "mesh cells --json" ? JSON.stringify(cells)
      : key === `mesh peers ${MESH} --json` ? peersJson(others) : key === "agent-host status --json" ? host : "";
    if (key === "agent-host stop --help") {   // the released 0.59.2 has no `agent-host stop`
      return { code: 2, stdout: "", stderr: "a4sx agent-host: error: argument agent_host_cmd: invalid choice: 'stop'\n" };
    }
    return { code: 0, stdout, stderr: "" };
  };
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
  return { provider, runs };
}

const icon = (i: { iconPath?: unknown }) => [(i.iconPath as any).id, (i.iconPath as any).color?.id];
const local = (name: string) => parseCellsAnswer(JSON.stringify(CELLS))!.cells.find((c) => c.name === name)!;

describe("#2301 looks: the state as the icon's colour", () => {
  beforeEach(resetCalls);

  it("a stored cell: running green, open in the Agents window blue, waiting or stored twice yellow, else plain", () => {
    assert.deepStrictEqual(icon({ iconPath: localCellIcon(local("build")) }), ["debug-start", CELL_ICON_COLORS.running]);
    assert.deepStrictEqual(icon({ iconPath: localCellIcon(local("build"), true) }), ["comment-discussion", CELL_ICON_COLORS.open]);
    assert.deepStrictEqual(icon({ iconPath: localCellIcon(local("docs")) }), ["terminal", undefined]);
    assert.deepStrictEqual(icon({ iconPath: localCellIcon({ ...local("docs"), isDefault: true }) }), ["star-full", undefined]);
    assert.deepStrictEqual(icon({ iconPath: localCellIcon({ ...local("docs"), needsApproval: true }) }), ["terminal", CELL_ICON_COLORS.attention]);
    assert.deepStrictEqual(icon({ iconPath: localCellIcon({ ...local("docs"), duplicate: true }) }), ["terminal", CELL_ICON_COLORS.attention]);
    assert.deepStrictEqual(icon({ iconPath: localCellIcon(local("spare")) }), ["circle-outline", undefined]);
  });

  it("the registry's word alone colours nothing: another account's cell reads revoked and still works", () => {
    assert.strictEqual(local("other").registryState, "revoked");
    assert.deepStrictEqual(icon({ iconPath: localCellIcon(local("other")) }), ["terminal", undefined]);
  });

  it("a cell on another machine: yours by the shape; online green, offline dimmed, an unknown state plain", () => {
    assert.deepStrictEqual(icon({ iconPath: remoteCellIcon({ own: true, state: "active", presence: "online" }) }), ["vm-active", CELL_ICON_COLORS.running]);
    assert.deepStrictEqual(icon({ iconPath: remoteCellIcon({ own: false, state: "active", presence: "offline" }) }), ["vm", CELL_ICON_COLORS.away]);
    assert.deepStrictEqual(icon({ iconPath: remoteCellIcon({ own: false, state: "active" }) }), ["vm", undefined], "the registry's word is not presence");
    assert.deepStrictEqual(icon({ iconPath: remoteCellIcon({ own: true }) }), ["vm-active", undefined]);
    // an older answer that put online/offline into `state`
    assert.deepStrictEqual(icon({ iconPath: remoteCellIcon({ own: false, state: "online" }) }), ["vm", CELL_ICON_COLORS.running]);
    assert.deepStrictEqual(icon({ iconPath: remoteCellIcon({ own: false, state: "offline" }) }), ["vm", CELL_ICON_COLORS.away]);
  });

  it("`presence` is read from the CLI's answer (online or offline only) and shown first on the row and in the tooltip", () => {
    const peers = parsePeersAnswer(JSON.stringify({ v: 1, mesh_id: MESH, peers: [peer(1), peer(2), peer(3, { presence: "away<b>" }), peer(4, { presence: 7 })] }), MESH)!;
    assert.deepStrictEqual(peers.map((p) => p.presence), ["online", "offline", undefined, undefined]);
    assert.deepStrictEqual(peers.map((p) => peerPresence(p)), ["online", "offline", undefined, undefined]);
    const item = new RemoteCellItem(MESH, peers[0]);
    assert.strictEqual(item.description, "on another machine · online · active · uid");
    assert.match(String(item.tooltip), /\nNow: online\nState: active\n/);
    assert.strictEqual(new RemoteCellItem(MESH, peers[2]).description, "on another machine · active · uid");
  });

  it("only VS Code's own theme colours are named", () => {
    for (const id of Object.values(CELL_ICON_COLORS)) {
      assert.match(id, /^(charts\.(green|blue|yellow)|disabledForeground)$/);
    }
  });

  it("in the view: the rows carry them; the open mark turns the row blue; This computer's running row is green, its last error in its description", async () => {
    const h = harness(1, hostJson({ open: ["docs (Team mesh)"], last_error: { at: "2026-11-21T18:19:09.997Z", text: "it stopped" } }));
    const top = await h.provider.getChildren();
    assert.ok(top[0] instanceof ThisComputerItem);
    const here = await h.provider.getChildren(top[0]);
    // #2309 (p): two rows, the error folded into the state row (it shifted the cell rows below)
    assert.deepStrictEqual(here.map(icon), [["pass", CELL_ICON_COLORS.running], ["debug-stop", "disabledForeground"]]);
    assert.match(String(here[0].description), /^Last error 11-21 18:19 UTC: it stopped$/);
    const team = await h.provider.getChildren(top.find((g) => g instanceof MeshGroupItem && g.meshId === MESH)!);
    assert.deepStrictEqual(team.filter((i) => i instanceof LocalCellItem).map((i) => [i.label, ...icon(i)]), [
      ["build", "debug-start", CELL_ICON_COLORS.running],
      ["docs", "comment-discussion", CELL_ICON_COLORS.open],
      ["other", "terminal", undefined],
    ]);
    const stopped = harness(1, hostJson({ running: false, address: null }));
    const rows = await stopped.provider.getChildren((await stopped.provider.getChildren())[0]);
    assert.deepStrictEqual(icon(rows[0]), ["circle-slash", undefined]);
  });
});

describe("#2301 looks: other members' cells folded into one row", () => {
  beforeEach(resetCalls);
  const team = async (others: number) => {
    const h = harness(others);
    const group = (await h.provider.getChildren()).find((g) => g instanceof MeshGroupItem && g.meshId === MESH)!;
    return { h, rows: await h.provider.getChildren(group) };
  };

  it(`up to ${FOLD_OTHERS_ABOVE} stay rows, as before`, async () => {
    const { rows } = await team(FOLD_OTHERS_ABOVE);
    assert.deepStrictEqual(rows.map((i) => i.label), ["build", "docs", "other", "mine-0", "peer-1", "peer-2", "peer-3"]);
    assert.ok(!rows.some((i) => i instanceof OtherCellsItem));
  });

  it("more than that: one collapsed row with the count; your own cells elsewhere stay rows above it", async () => {
    const { h, rows } = await team(7);
    assert.deepStrictEqual(rows.map((i) => i.label), ["build", "docs", "other", "mine-0", CELL_TEXTS.othersLabel]);
    const fold = rows[4] as OtherCellsItem;
    assert.ok(fold instanceof OtherCellsItem && rows[3] instanceof RemoteCellItem && (rows[3] as RemoteCellItem).peer.own);
    assert.strictEqual(fold.collapsibleState, 1, "collapsed");
    assert.strictEqual(fold.description, "7 on other machines · 4 online");
    assert.strictEqual(fold.contextValue, "a4sx.otherCells");
    assert.strictEqual(typeof fold.tooltip, "string");
    const inside = await h.provider.getChildren(fold);
    assert.deepStrictEqual(inside.map((i) => [i.label, i.contextValue]), [1, 2, 3, 4, 5, 6, 7].map((n) => [`peer-${n}`, "a4sx.remoteCell"]));
    assert.ok(inside.every((i) => i instanceof RemoteCellItem));
    assert.strictEqual(h.runs.filter((r) => r.startsWith("mesh peers")).length, 1, "opening the fold reads nothing again");
  });

  it("nobody online: the count alone", async () => {
    const h = harness(0);
    const fold = new OtherCellsItem(MESH, [2, 4, 6, 8].map((n) => ({ instanceId: `ins_P${n}`, name: `peer-${n}`, own: false, state: "active", presence: "offline" as const, tags: [] })));
    assert.strictEqual(fold.description, "4 on other machines");
    assert.strictEqual((await h.provider.getChildren(fold)).length, 4);
  });
});

describe("#2301 looks: the status bar item", () => {
  beforeEach(resetCalls);

  it("the words: bare before the first read, the counts after it; plain text in the tooltip", () => {
    assert.strictEqual(statusBarText(undefined), "$(vm) a4sx");
    assert.strictEqual(statusBarText({ cells: 0, running: 0, open: 0 }), "$(vm) a4sx: no cells here");
    assert.strictEqual(statusBarText({ cells: 1, running: 0, open: 0 }), "$(vm) a4sx: 1 cell");
    assert.strictEqual(statusBarText({ cells: 4, running: 2, open: 1 }), "$(vm) a4sx: 4 cells · 2 running · 1 open");
    assert.strictEqual(statusBarTooltip(undefined), "a4sx on this computer\nThe Cells view wasn't shown in this window yet: click to open it.");
    assert.strictEqual(statusBarTooltip({ cells: 4, running: 2, open: 1, host: { running: true, address: "ws://127.0.0.1:8799/" } }),
      "a4sx on this computer\nCells stored here: 4 (2 running, 1 open in the Agents window)\nAgent host: running on ws://127.0.0.1:8799/\nClick to open the Cells view.");
    assert.match(statusBarTooltip({ cells: 0, running: 0, open: 0, host: { running: false } }), /No cells are stored on this computer\.\nAgent host: not running\n/);
    assert.match(statusBarTooltip({ cells: 2, running: 0, open: 0 }), /Cells stored here: 2 \(0 running\)\nAgent host: not read yet/);
  });

  it("no list (no CLI, an error): no counts", () => {
    assert.strictEqual(cellsSummary({ kind: "no-cli" }, undefined), undefined);
    assert.strictEqual(cellsSummary({ kind: "error" }, undefined), undefined);
    assert.strictEqual(cellsSummary(undefined, undefined), undefined);
  });

  it("it follows the Cells view's own reads and runs nothing itself; a click opens the Cells view", async () => {
    const h = harness(1, hostJson({ open: ["docs (Team mesh)"] }));
    const bar = cellsStatusBar(h.provider);
    const item = calls.statusBarItems[0];
    assert.deepStrictEqual([item.id, item.alignment, item.name, item.command, item.shown], [STATUS_BAR_ID, 1, "a4sx cells", CMD_FOCUS_CELLS, true]);
    assert.strictEqual(item.text, "$(vm) a4sx");
    assert.deepStrictEqual(h.runs, [], "making the item reads nothing");
    const top = await h.provider.getChildren();   // the view is shown: the cells are read
    assert.strictEqual(item.text, "$(vm) a4sx: 4 cells · 1 running");
    assert.match(String(item.tooltip), /Agent host: not read yet/);
    await h.provider.getChildren(top[0]);   // This computer's rows: the agent host's status
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(item.text, "$(vm) a4sx: 4 cells · 1 running · 1 open");
    assert.match(String(item.tooltip), /1 open in the Agents window\)\nAgent host: running on ws:\/\/127\.0\.0\.1:8799\//);
    assert.deepStrictEqual(h.runs, ["--version", "mesh cells --json", "agent-host status --json", "agent-host stop --help"],
      "only what the view itself read (the stop probe: 0.59.2 doesn't report stop_request)");
    assert.strictEqual(typeof item.tooltip, "string");
    bar.dispose();
    assert.strictEqual(item.disposed, true);
  });

  it("a host that stopped: the next status read says so", async () => {
    let host = hostJson();
    const runs: string[] = [];
    const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
      const key = args.join(" ");
      runs.push(key);
      return { code: 0, stdout: key === "--version" ? "a4sx 0.59.2" : key === "mesh cells --json" ? JSON.stringify(CELLS) : key === "agent-host status --json" ? host : "", stderr: "" };
    };
    const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
    cellsStatusBar(provider);
    const item = calls.statusBarItems[0];
    const top = await provider.getChildren();
    await provider.getChildren(top[0]);
    await new Promise((r) => setImmediate(r));
    assert.match(String(item.tooltip), /Agent host: running on/);
    host = hostJson({ running: false, address: null });
    provider.rereadHostNow();
    await provider.getChildren(top[0]);
    await new Promise((r) => setImmediate(r));
    assert.match(String(item.tooltip), /Agent host: not running/);
  });
});
