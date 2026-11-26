// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
/**
 * #2309 H1 (cell01): Developer: Reload Window ended the agent host the extension had started in its terminal, and the
 * cell with it. The host's terminal is now a normal (not transient) shell terminal, which VS Code's persistent terminal
 * sessions keep running across a reload; one that is the process itself (an unknown shell) stays transient, so a
 * restart never starts the host by itself.
 */
import * as assert from "assert";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { AGENT_HOST_TEXTS } from "../../agentHostStatus";
import { CellCommandDeps, setupAgentsWindow, startAgentHost } from "../../cellCommands";
import { CellsProvider } from "../../cellsView";

const BASE = "https://session-exchange.com";
const CLI = "/opt/a4sx/a4sx";

function deps(): CellCommandDeps {
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
  provider.rereadHostSoon = () => undefined;
  return {
    state: fakeMemento() as any, cliDir: undefined, provider, resolve: () => ({ kind: "found", path: CLI }), run,
    server: () => BASE, defaultServer: BASE, folder: async () => "/w/proj",
    fetch: async () => { throw new Error("no network"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
  };
}

describe("#2309 H1: the agent host's terminal survives a window reload", () => {
  beforeEach(resetCalls);

  it("in a known shell: not transient (persistent sessions keep its process across a reload)", async () => {
    calls.shell = "/bin/bash";
    await startAgentHost(deps());
    await setupAgentsWindow(deps());
    assert.deepStrictEqual(calls.terminals.map((t) => [t.options.name, t.options.isTransient]),
      [[AGENT_HOST_TEXTS.startTerminal, undefined], [AGENT_HOST_TEXTS.setupTerminal, undefined]]);
    assert.ok(calls.terminals.every((t) => t.sent.length === 1), "the command is typed into the shell");
  });

  it("when the terminal is the process (an unknown shell): transient, so a restart doesn't start it by itself", async () => {
    calls.shell = "/usr/bin/xonsh";
    await startAgentHost(deps());
    assert.strictEqual(calls.terminals[0].options.isTransient, true);
    assert.strictEqual(calls.terminals[0].options.shellPath, CLI);
  });
});
