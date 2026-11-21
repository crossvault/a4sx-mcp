/** a4sx #2326 (CLI 0.59.15): Stop agent host on This computer runs `a4sx agent-host stop`, the same stop as Ctrl+C. */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { AGENT_HOST_TEXTS } from "../../agentHostStatus";
import { CELL_CMD_TEXTS, CellCommandDeps, stopAgentHost } from "../../cellCommands";
import { CellsProvider, CliOutput } from "../../cellsView";

const BASE = "https://session-exchange.com";
const CLI = "/opt/a4sx/a4sx";
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));

function harness(answer: CliOutput) {
  const runs: { args: string; ms?: number }[] = [];
  const run = async (_cli: string, args: readonly string[], ms?: number): Promise<CliOutput> => {
    runs.push({ args: args.join(" "), ms });
    return args.join(" ") === "agent-host stop" ? answer : { code: 0, stdout: "", stderr: "" };
  };
  let rereads = 0;
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
  provider.rereadHostSoon = () => { rereads++; };
  const deps: CellCommandDeps = {
    state: fakeMemento() as any, cliDir: undefined, provider, resolve: () => ({ kind: "found", path: CLI }), run,
    server: () => BASE, defaultServer: BASE, folder: async () => "/w/proj",
    fetch: async () => { throw new Error("no network in tests"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
  };
  return { deps, runs, rereads: () => rereads };
}

describe("#2326: Stop agent host", () => {
  beforeEach(resetCalls);

  it("runs `a4sx agent-host stop` once, without a terminal, with a progress while it waits; says it stopped", async () => {
    const h = harness({ code: 0, stdout: "a4sx agent host: asked it to stop (pid 42). …\na4sx agent host: stopped (pid 42)\n", stderr: "" });
    assert.strictEqual(await stopAgentHost(h.deps), true);
    assert.deepStrictEqual(h.runs.map((r) => r.args), ["agent-host stop"]);
    assert.ok((h.runs[0].ms ?? 0) >= 35_000, "longer than the CLI's own 30 s wait");
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.progress.map((p) => p.title), [AGENT_HOST_TEXTS.stopping]);
    assert.deepStrictEqual(calls.infos, [AGENT_HOST_TEXTS.stopDone]);
    assert.strictEqual(h.rereads(), 1, "the node reads the status again");
  });

  it("not running: says so, not that it stopped", async () => {
    const h = harness({ code: 0, stdout: "a4sx agent host: not running, so there is nothing to stop\n", stderr: "" });
    assert.strictEqual(await stopAgentHost(h.deps), true);
    assert.deepStrictEqual(calls.infos, [AGENT_HOST_TEXTS.stopNotRunning]);
  });

  it("an older CLI without the command: update, or Ctrl+C; the CLI's refusal: its own line", async () => {
    const old = harness({ code: 2, stdout: "", stderr: "a4sx agent-host: error: argument agent_host_cmd: invalid choice: 'stop'\n" });
    assert.strictEqual(await stopAgentHost(old.deps), false);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [AGENT_HOST_TEXTS.stopNeedsUpdate]);
    assert.strictEqual(AGENT_HOST_TEXTS.stopNeedsUpdate, "This a4sx CLI can't stop the agent host from here (that needs CLI 0.59.15 or newer). Update a4sx, or stop it with Ctrl+C in its terminal \"a4sx: agent host\"; nothing was stopped.");
    resetCalls();
    const refused = harness({ code: 1, stdout: "", stderr: "a4sx: the agent host (pid 42) hasn't stopped within 30 s: it is still ending its cells\n" });
    assert.strictEqual(await stopAgentHost(refused.deps), false);
    assert.deepStrictEqual(calls.errors.map((e) => e.message),
      [CELL_CMD_TEXTS.cliFailed("stop the agent host", "the agent host (pid 42) hasn't stopped within 30 s: it is still ending its cells")]);
  });

  it("review: the run's own timeout (no exit code, nothing said): what that means and what to do", async () => {
    const h = harness({ code: null, stdout: "a4sx agent host: asked it to stop (pid 42). …\n", stderr: "" });
    assert.strictEqual(await stopAgentHost(h.deps), false);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [AGENT_HOST_TEXTS.stopNoAnswer]);
  });

  it("the command is contributed with its title", () => {
    const cmd = pkg.contributes.commands.find((c: any) => c.command === "a4sx.stopAgentHost");
    assert.deepStrictEqual([cmd.title, cmd.category], ["Stop agent host", "a4sx"]);
  });
});
