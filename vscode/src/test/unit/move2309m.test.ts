// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
/** a4sx #2309 (m), cell01: terminal → Agents window took three steps; "Move it into the Agents window" is one. */
import * as assert from "assert";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { CELL_ACTION_TEXTS, CellActionDeps, openCellInAgentsWindow } from "../../cellActions";
import { CELL_CMD_TEXTS } from "../../cellCommands";
import { cellStopArgs } from "../../cells";
import { CellsProvider, CliOutput, LocalCellItem } from "../../cellsView";
import { parseCellsAnswer } from "../../cliJson";

const BASE = "https://session-exchange.com";
const MESH = "msh_0123456789abcdef0123456789abcdef";
const CLI = "/opt/a4sx/a4sx";
const INS = "ins_fc319f874d0d16d0b38ae01af3af0728";
const STATUS = JSON.stringify({ running: true, proved: true, answering: true, pid: 4242, address: "ws://127.0.0.1:8799/",
  open: [], vscode: { address: "ws://127.0.0.1:8799", editors: { stable: "ok" } }, last_error: null, cells: [] });

function harness(opts: { stopCode?: number; stopsAfter?: number; listFailsAfterStop?: boolean } = {}) {
  const runs: string[] = [];
  let state = "running";
  let reads = 0;
  const cells = () => JSON.stringify({ v: 1, default: "build", cells: [{ name: "build", mesh_id: MESH, mesh_name: "Team mesh", instance_id: INS,
    profile: null, local: { state, pid: null }, registry: { state: "active" }, path: null, mesh_policy: null, tags: [] }] });
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    const line = args.join(" ");
    runs.push(line);
    if (line === "agent-host status --json") {
      return { code: 0, stdout: STATUS, stderr: "" };
    }
    if (line.startsWith("mesh cell stop")) {
      if (opts.stopCode) {
        return { code: opts.stopCode, stdout: "", stderr: "a4sx: couldn't stop it\n" };
      }
      reads = 0;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (line === "mesh cells --json") {
      reads++;
      if (opts.listFailsAfterStop && runs.some((r) => r.startsWith("mesh cell stop"))) {
        return { code: 1, stdout: "", stderr: "a4sx: cells.json unreadable\n" };
      }
      if (runs.some((r) => r.startsWith("mesh cell stop")) && reads > (opts.stopsAfter ?? 1)) {
        state = "stored";
      }
      return { code: 0, stdout: cells(), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
  const deps: CellActionDeps = {
    state: fakeMemento() as any, cliDir: undefined, provider, resolve: () => ({ kind: "found", path: CLI }), run,
    server: () => BASE, defaultServer: BASE, folder: async () => "/w/proj",
    fetch: async () => { throw new Error("no network in tests"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
    show: () => undefined, agentsWait: { ms: 600, pollMs: 20 }, moveWait: { ms: 300, pollMs: 10 },
  };
  const list = parseCellsAnswer(cells())!.cells;
  return { deps, runs, item: new LocalCellItem(list[0], list, BASE) };
}

describe("#2309 (m): Move it into the Agents window", () => {
  beforeEach(resetCalls);

  it("one action: stops the cell (no second question), waits until it no longer runs, then opens it in the Agents window", async () => {
    const h = harness({ stopsAfter: 2 });
    calls.nextInfoChoice = CELL_ACTION_TEXTS.moveIt;
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), true);
    assert.deepStrictEqual(calls.modals, [], "the move was the person's choice: no Stop «build»? modal");
    assert.strictEqual(h.runs.filter((r) => r.startsWith("mesh cell stop")).length, 1);
    assert.strictEqual(h.runs.find((r) => r.startsWith("mesh cell stop")), cellStopArgs(h.item.cell, h.item.all)!.join(" "));
    assert.strictEqual(calls.progress[0].options.cancellable, true, "a move can be cancelled");
    assert.deepStrictEqual(calls.opened, [`vscode://agents/agent-host-session/ahp-session/a4sx-cell-${INS}`]);
    assert.deepStrictEqual(calls.executed, [], "not through the Stop command (which asks)");
  });

  it("offers Move first and Stop it second; Stop it is as before", async () => {
    const h = harness();
    calls.nextInfoChoice = CELL_ACTION_TEXTS.stopIt;
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), false);
    assert.deepStrictEqual(calls.executed.map((e) => e.id), ["a4sx.stopCell"]);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("a failed stop says why and opens nothing", async () => {
    const h = harness({ stopCode: 1 });
    calls.nextInfoChoice = CELL_ACTION_TEXTS.moveIt;
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), false);
    assert.strictEqual(calls.errors[0].message, CELL_CMD_TEXTS.cliFailed("stop the cell", "couldn't stop it"));
    assert.deepStrictEqual(calls.opened, []);
  });

  it("a cell that still runs after the wait: said, nothing opens", async () => {
    const h = harness({ stopsAfter: 10_000 });
    calls.nextInfoChoice = CELL_ACTION_TEXTS.moveIt;
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), false);
    assert.strictEqual(calls.errors[0].message, CELL_ACTION_TEXTS.moveStillRunning("build"));
    assert.deepStrictEqual(calls.opened, []);
  });

  it("review: a stop that worked, then an unreadable cell list: said, not a silent end; nothing opens", async () => {
    const h = harness({ listFailsAfterStop: true });
    calls.nextInfoChoice = CELL_ACTION_TEXTS.moveIt;
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), false);
    assert.strictEqual(calls.errors.length, 1);
    assert.strictEqual(calls.errors[0].message, CELL_ACTION_TEXTS.moveUnread("build"));
    assert.deepStrictEqual(calls.opened, []);
  });

  it("review: cancelling the wait says the cell may already be stopped; nothing opens", async () => {
    const h = harness({ stopsAfter: 10_000 });
    calls.nextInfoChoice = CELL_ACTION_TEXTS.moveIt;
    calls.cancelProgress = true;
    assert.strictEqual(await openCellInAgentsWindow(h.deps, h.item), false);
    assert.strictEqual(calls.errors[0].message, CELL_ACTION_TEXTS.moveCancelled("build"));
    assert.deepStrictEqual(calls.opened, []);
  });
});
