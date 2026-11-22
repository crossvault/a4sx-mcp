/** a4sx #2326 (CLI 0.59.15): Stop agent host on This computer runs `a4sx agent-host stop`, the same stop as Ctrl+C. */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { AGENT_HOST_TEXTS, parseAgentHostStatus } from "../../agentHostStatus";
import { CELL_CMD_TEXTS, CellCommandDeps, stopAgentHost } from "../../cellCommands";
import { CellsProvider, CliOutput, thisComputerChildren } from "../../cellsView";

const BASE = "https://session-exchange.com";
const CLI = "/opt/a4sx/a4sx";
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));

function harness(answer: CliOutput, status: CliOutput = { code: 0, stdout: JSON.stringify({ running: true, address: "ws://127.0.0.1:8765/", open: [] }), stderr: "" }) {
  const runs: { args: string; ms?: number }[] = [];
  const run = async (_cli: string, args: readonly string[], ms?: number): Promise<CliOutput> => {
    runs.push({ args: args.join(" "), ms });
    return args.join(" ") === "agent-host stop" ? answer : args.join(" ") === "agent-host status --json" ? status : { code: 0, stdout: "", stderr: "" };
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
    assert.deepStrictEqual(h.runs.map((r) => r.args), ["agent-host status --json", "agent-host stop"]);
    assert.ok((h.runs[1].ms ?? 0) >= 35_000, "longer than the CLI's own 30 s wait");
    assert.deepStrictEqual(calls.modals, [], "no cell runs in it: no question");
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.progress.map((p) => p.title), [AGENT_HOST_TEXTS.stopping]);
    assert.deepStrictEqual(calls.infos, [AGENT_HOST_TEXTS.stopDone]);
    assert.strictEqual(h.rereads(), 1, "the node reads the status again");
  });

  it("cells run in it: asks first, naming them (as the deck's S); Cancel stops nothing, Stop it stops", async () => {
    const st = { code: 0, stdout: JSON.stringify({ running: true, address: "ws://127.0.0.1:8765/", open: ["build (Team mesh)", "docs (Team mesh)", "x (plain)"] }), stderr: "" };
    const h = harness({ code: 0, stdout: "a4sx agent host: stopped (pid 42)\n", stderr: "" }, st);
    calls.modalChoices.push(undefined);   // Cancel
    assert.strictEqual(await stopAgentHost(h.deps), false);
    assert.deepStrictEqual(calls.modals.map((m) => [m.kind, m.message, m.items]),
      [["warning", "Stop the a4sx agent host? «build», «docs», 1 plain conversation end (VS Code is told first).", ["Stop it"]]]);
    assert.deepStrictEqual(h.runs.map((r) => r.args), ["agent-host status --json"], "nothing stopped");
    resetCalls();
    assert.strictEqual(AGENT_HOST_TEXTS.stopAsk(["build"]), "Stop the a4sx agent host? «build» ends (VS Code is told first).");
    assert.strictEqual(AGENT_HOST_TEXTS.stopAsk([], 2), "Stop the a4sx agent host? 2 plain conversations end (VS Code is told first).");
    assert.strictEqual(AGENT_HOST_TEXTS.stopAsk(["a"], 1), "Stop the a4sx agent host? «a», 1 plain conversation end (VS Code is told first).");
    calls.modalChoices.push(AGENT_HOST_TEXTS.stopIt);
    assert.strictEqual(await stopAgentHost(h.deps), true);
    assert.deepStrictEqual(h.runs.map((r) => r.args).slice(-1), ["agent-host stop"]);
    assert.deepStrictEqual(calls.infos, [AGENT_HOST_TEXTS.stopDone]);
  });

  it("only plain conversations open: asks too (they end as well)", async () => {
    const st = { code: 0, stdout: JSON.stringify({ running: true, address: "ws://127.0.0.1:8765/", open: ["chat (plain)"] }), stderr: "" };
    const h = harness({ code: 0, stdout: "stopped (pid 1)\n", stderr: "" }, st);
    calls.modalChoices.push(undefined);
    assert.strictEqual(await stopAgentHost(h.deps), false);
    assert.deepStrictEqual(calls.modals.map((m) => m.message), ["Stop the a4sx agent host? 1 plain conversation ends (VS Code is told first)."]);
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
    assert.strictEqual(AGENT_HOST_TEXTS.stopNeedsUpdate, "Update a4sx to stop the agent host from here (needs a4sx 0.59.10 or newer). Nothing was stopped; Ctrl+C in its terminal \"a4sx: agent host\" stops it now.");
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

  it("cell01: the done toast's first sentence is short (VS Code cuts a toast at about 60 characters)", () => {
    assert.strictEqual(AGENT_HOST_TEXTS.stopDone, "a4sx agent host stopped. Start it again to use your cells in the Agents window.");
    assert.ok(AGENT_HOST_TEXTS.stopDone.split(". ")[0].length <= 30);
    // review of #40: the other messages of the command also give their point within the first ~60 characters
    assert.ok(AGENT_HOST_TEXTS.stopping.startsWith("Stopping the a4sx agent host…"));
    assert.ok(AGENT_HOST_TEXTS.stopNeedsUpdate.startsWith("Update a4sx to stop the agent host from here"));
    assert.ok(AGENT_HOST_TEXTS.stopNoAnswer.indexOf("45 s") < 60);
  });

  it("#2309 F2, by capability (stop_request): a host that can't be asked is greyed with the reason; one that can is the action", () => {
    const at = (stop_request?: number) => parseAgentHostStatus(JSON.stringify({ running: true, address: "ws://127.0.0.1:8765/", open: [],
      vscode: { editors: { stable: "ok" } }, ...(stop_request === undefined ? {} : { stop_request }) }))!;
    assert.strictEqual(at().stopRequest, undefined, "a CLI that doesn't say");
    assert.strictEqual(parseAgentHostStatus(JSON.stringify({ running: true, address: "ws://127.0.0.1:8765/", stop_request: "2" }))!.stopRequest, 0);
    // review of #43: a CLI that doesn't say but has `agent-host stop` (#2326 without #2338) offers it
    assert.strictEqual(thisComputerChildren(at(), true).find((i) => String(i.label).startsWith("Stop agent host"))!.command!.command,
      "a4sx.stopAgentHost");
    for (const [sr, can] of [[undefined, false], [0, false], [0, true]] as [number | undefined, boolean][]) {
      const old = thisComputerChildren(at(sr), can).find((i) => String(i.label).startsWith("Stop agent host"))!;
      assert.strictEqual(old.label, "Stop agent host (needs a4sx 0.59.10)");
      assert.strictEqual(old.command, undefined);
      assert.strictEqual((old.iconPath as any).color?.id, "disabledForeground");
      assert.strictEqual(old.tooltip, "This a4sx CLI, or the agent host it started, can't be asked to stop from here: that needs a4sx 0.59.10 or newer for both. Run a4sx update, then start the agent host again. Until then, Ctrl+C in its terminal \"a4sx: agent host\" stops it.");
    }
    for (const sr of [1, 2]) {
      const row = thisComputerChildren(at(sr)).find((i) => String(i.label).startsWith("Stop agent host"))!;
      assert.strictEqual(row.label, "Stop agent host", String(sr));
      assert.strictEqual(row.command!.command, "a4sx.stopAgentHost");
    }
  });

  it("the command is contributed with its title", () => {
    const cmd = pkg.contributes.commands.find((c: any) => c.command === "a4sx.stopAgentHost");
    assert.deepStrictEqual([cmd.title, cmd.category], ["Stop agent host", "a4sx"]);
  });
});
