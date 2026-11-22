/** #2309 (l), cell01: a cell started in a terminal from the Cells view stayed "stored" until a Refresh. */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { CELLS_LIST_ARGS } from "../../cells";
import { CellCommandDeps, newCell, startCell } from "../../cellCommands";
import { CELLS_LAUNCH_REREADS_MS, CellsProvider, CliOutput, LocalCellItem, MeshGroupItem } from "../../cellsView";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscodeFake = require("vscode");

const MESH = "msh_0123456789abcdef0123456789abcdef";
const CLI = "/opt/a4sx/a4sx";
const ANSWER = [{ mesh_id: MESH, mesh_name: "Test mesh", name: "kartanwk8-cell01", instance_id: "ins_K8", created: "2026-11-19T10:00:00Z", standalone: false, default: true, needs_approval: false, duplicate: false }];

function harness() {
  const runs: string[] = [];
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    runs.push(args.join(" "));
    if (args.join(" ") === "--version") {
      return { code: 0, stdout: "a4sx 0.59.18  (server 0.754.0)\n", stderr: "" };
    }
    return { code: 0, stdout: args.join(" ") === CELLS_LIST_ARGS.join(" ") ? JSON.stringify(ANSWER) : "", stderr: "" };
  };
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => "https://session-exchange.com", onState: () => undefined });
  const rereads: number[][] = [];
  const real = provider.rereadCellsSoon.bind(provider);
  provider.rereadCellsSoon = (delays?: readonly number[]) => { rereads.push([...(delays ?? CELLS_LAUNCH_REREADS_MS)]); };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-l-test-"));
  const deps: CellCommandDeps = {
    state: fakeMemento() as any, cliDir: undefined, provider, resolve: () => ({ kind: "found", path: CLI }), run,
    server: () => "https://session-exchange.com", defaultServer: "https://session-exchange.com", folder: async () => "/w/proj",
    fetch: async () => { throw new Error("no network in tests"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
    stateDir: tmp(), claudeProjects: tmp(), home: tmp(),
  };
  calls.nextOpenDialog = [vscodeFake.Uri.file("/w/proj")];
  return { deps, runs, provider, rereads, real };
}

async function cellItem(d: CellCommandDeps): Promise<LocalCellItem> {
  for (const top of await d.provider.getChildren()) {
    if (top instanceof MeshGroupItem) {
      return (await d.provider.getChildren(top)).find((i) => i instanceof LocalCellItem) as LocalCellItem;
    }
  }
  throw new Error("no cell");
}

const listReads = (runs: string[]) => runs.filter((r) => r === CELLS_LIST_ARGS.join(" ")).length;

describe("#2309 (l): the Cells view reads the list again after a cell start in a terminal from here", () => {
  beforeEach(resetCalls);

  it("Start and New cell open their terminal and ask for the re-reads; a start that opens nothing asks for none", async () => {
    const h = harness();
    assert.ok(await startCell(h.deps, await cellItem(h.deps)));
    assert.strictEqual(calls.terminals.length, 1);
    assert.deepStrictEqual(h.rereads, [[...CELLS_LAUNCH_REREADS_MS]]);
    await newCell(h.deps);
    assert.strictEqual(h.rereads.length, 2);
    assert.strictEqual(await startCell(h.deps, undefined), undefined);
    assert.strictEqual(h.rereads.length, 2, "no terminal: no re-read");
  });

  it("the re-reads read the cell list once each and stop on dispose", async () => {
    const h = harness();
    await h.provider.getChildren();
    const before = listReads(h.runs);
    h.real([5, 15]);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(listReads(h.runs) - before, 2);
    h.real([40]);
    h.provider.dispose();
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(listReads(h.runs) - before, 2, "none after dispose");
  });

  it("a second start replaces the first one's pending re-reads (no pile-up of refreshes)", async () => {
    const h = harness();
    await h.provider.getChildren();
    const before = listReads(h.runs);
    h.real([60, 70]);
    h.real([5]);
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(listReads(h.runs) - before, 1, "only the second start's one re-read ran");
    h.provider.dispose();
  });

  it("Run as cell and its callers (Convert, continue a saved session) ask for the re-reads too", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "..", "src", "runAsCell.ts"), "utf8");
    assert.match(src, /deps\.terminals\.add\(terminal\);\n\s*deps\.provider\.rereadCellsSoon\(\);/);
  });

  it("the delays cover a launch's sign-in and Claude Code's start (a few seconds to half a minute)", () => {
    assert.ok(CELLS_LAUNCH_REREADS_MS[0] >= 2_000 && CELLS_LAUNCH_REREADS_MS[CELLS_LAUNCH_REREADS_MS.length - 1] >= 30_000);
  });
});
