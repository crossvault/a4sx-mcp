// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.9.3: Start and New cell leave the reduced-isolation question to the a4sx CLI (0.32.0+), which asks it in the
// terminal once per cell and per computer and stores the answer. --mesh-reduced-isolation accepts it for one start
// only and stores nothing, so a cell started from here with it was refused at its next start without a terminal (the
// agent host's). The CLI is a fake runner.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { CELLS_LIST_ARGS, MIN_CELL_CONSENT_CLI, NEW_CELL_ARGS, REDUCED_FLAG } from "../../cells";
import { CELL_CMD_TEXTS, CellCommandDeps, cliAsksConsent, CONSENT_KEY, copyCellLaunch, newCell, startCell } from "../../cellCommands";
import { CellsProvider, CliOutput, LocalCellItem, MeshGroupItem } from "../../cellsView";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscodeFake = require("vscode");

const MESH = "msh_0123456789abcdef0123456789abcdef";
const CLI = "/opt/a4sx/a4sx";
const ANSWER = [{ mesh_id: MESH, mesh_name: "Test mesh", name: "kartanwk8-cell01", instance_id: "ins_K8", created: "2026-11-19T10:00:00Z", standalone: false, default: true, needs_approval: false, duplicate: false }];

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-consent-test-"));
}

function harness(version: string | undefined) {
  const runs: string[] = [];
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    runs.push(args.join(" "));
    if (args.join(" ") === "--version") {
      return { code: version ? 0 : 1, stdout: version ? `a4sx ${version}  (server 0.720.0)\n` : "", stderr: "" };
    }
    return { code: 0, stdout: args.join(" ") === CELLS_LIST_ARGS.join(" ") ? JSON.stringify(ANSWER) : "", stderr: "" };
  };
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => "https://session-exchange.com", onState: () => undefined });
  const state = fakeMemento();
  const deps: CellCommandDeps = {
    state: state as any, cliDir: undefined, provider, resolve: () => ({ kind: "found", path: CLI }), run,
    server: () => "https://session-exchange.com", defaultServer: "https://session-exchange.com", folder: async () => "/w/proj",
    fetch: async () => { throw new Error("no network in tests"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
    stateDir: tmpdir(), claudeProjects: tmpdir(), home: tmpdir(),
  };
  calls.nextOpenDialog = [vscodeFake.Uri.file("/w/proj")];
  return { deps, runs, state };
}

async function cellItem(d: CellCommandDeps): Promise<LocalCellItem> {
  for (const top of await d.provider.getChildren()) {
    if (top instanceof MeshGroupItem) {
      return (await d.provider.getChildren(top)).find((i) => i instanceof LocalCellItem) as LocalCellItem;
    }
  }
  throw new Error("no cell");
}

describe("0.9.3: the reduced-isolation question is the CLI's, stored per cell", () => {
  beforeEach(resetCalls);

  it("Start with CLI 0.40.3: no dialog of the extension's, no --mesh-reduced-isolation, in a terminal (where the CLI asks)", async () => {
    const h = harness("0.40.3");
    const t = await startCell(h.deps, await cellItem(h.deps));
    assert.ok(t);
    assert.deepStrictEqual(calls.modals, []);
    assert.ok(!calls.terminals[0].sent[0].includes(REDUCED_FLAG));
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--cell' 'kartanwk8-cell01'\n`]);
    assert.ok(!h.runs.some((r) => r.startsWith("launch")), "never started without a terminal");
    assert.strictEqual(h.state.data_.get(CONSENT_KEY), undefined, "the extension accepts nothing");
  });

  it("New cell and Copy launch command: no flag either", async () => {
    const h = harness("0.40.3");
    await newCell(h.deps);
    assert.deepStrictEqual(calls.modals, []);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--new-cell'\n`]);
    assert.ok(!NEW_CELL_ARGS.includes(REDUCED_FLAG));
    calls.shell = "/bin/bash";
    assert.strictEqual(await copyCellLaunch(h.deps, await cellItem(h.deps)), `'${CLI}' 'launch' '--cell' 'kartanwk8-cell01'`);
  });

  it("New cell in PowerShell and cmd: no flag", async () => {
    for (const [shell, want] of [
      ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", `& '${CLI}' 'launch' '--new-cell'\n`],
      ["C:\\WINDOWS\\System32\\cmd.exe", `"${CLI}" "launch" "--new-cell"\n`],
    ]) {
      resetCalls();
      calls.shell = shell;
      const h = harness("0.40.3");
      await newCell(h.deps);
      assert.deepStrictEqual(calls.terminals[0].sent, [want], shell);
    }
  });

  it("an update that finished meanwhile is seen: the version is read again before saying it's too old", async () => {
    let version = "0.31.11";
    const h = harness("0.31.11");
    const run = h.deps.run;
    h.deps.run = async (cli, args, t) => (args.join(" ") === "--version" ? { code: 0, stdout: `a4sx ${version}\n`, stderr: "" } : run(cli, args, t));
    (h.deps.provider as any).versions = new (require("../../cellsView").CliVersions)(h.deps.run);
    assert.strictEqual(await cliAsksConsent(h.deps, CLI), false);
    version = "0.40.3";
    assert.strictEqual(await cliAsksConsent(h.deps, CLI), true);
  });

  it("a CLI before 0.32.0 can't store the answer: said with the fix, Update a4sx CLI runs `a4sx update`; nothing starts", async () => {
    const h = harness("0.31.11");
    calls.nextErrorChoice = CELL_CMD_TEXTS.updateCli;
    assert.strictEqual(await startCell(h.deps, await cellItem(h.deps)), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => [e.message, e.items]), [[CELL_CMD_TEXTS.consentCliTooOld("0.31.11"), [CELL_CMD_TEXTS.updateCli]]]);
    assert.match(CELL_CMD_TEXTS.consentCliTooOld("0.31.11"), new RegExp(`Nothing was started\\. Update the a4sx CLI to ${MIN_CELL_CONSENT_CLI.replace(/\./g, "\\.")}`));
    assert.strictEqual(calls.terminals.length, 1);
    assert.strictEqual(calls.terminals[0].options.name, CELL_CMD_TEXTS.updateTerminal);
    resetCalls();
    assert.strictEqual(await newCell(h.deps), undefined);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("the version gate: 0.32.0 and later, or an unknown version, leave the question to the CLI", async () => {
    for (const [v, want] of [["0.32.0", true], ["0.44.0", true], [undefined, true], ["0.31.11", false], ["0.27.1", false]] as const) {
      resetCalls();
      const h = harness(v);
      assert.strictEqual(await cliAsksConsent(h.deps, CLI), want, String(v));
    }
  });
});
