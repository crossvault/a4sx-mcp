// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.6.0 (a4sx #1910): the Cells view shows each cell's launch profile and what its route serves (from
// `mesh cells --json`, CLI 0.27.0), and "Set launch profile…" runs `mesh cell profile`. The CLI is a fake
// runner; nothing reaches a network or a shell.
import * as assert from "assert";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { cellProfileArgs, CELL_PROFILE_TEXTS, LocalCell, localCellDescription, localCellTooltip } from "../../cells";
import { CELL_CMD_TEXTS, CellCommandDeps, CONSENT_KEY, machineKey, setCellProfile } from "../../cellCommands";
import { CellsProvider, CliOutput, LocalCellItem, MeshGroupItem } from "../../cellsView";
import { parseCellsAnswer } from "../../cliJson";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../../package.json");

const MESH = "msh_0123456789abcdef0123456789abcdef";
const BASE = "https://session-exchange.com";
const CLI = "/opt/a4sx/a4sx";

const row = (o: Record<string, unknown>) => ({
  name: "build", mesh_id: MESH, mesh_name: "Team mesh", instance_id: "ins_A1", profile: "high", local: { state: "stored", pid: null },
  registry: { state: "active" }, path: null, mesh_policy: "open", tags: [], launch_profile: "High effort", profile_source: "assigned",
  operator: "high-effort-cell", router: "https://router.example", route_model: "claude-fable-5-2", route_effort: "high", ...o,
});
const CELLS = { v: 1, default: "build", cells: [row({}), row({ name: "docs", instance_id: "ins_D4", profile: "work", launch_profile: "Work", profile_source: "default", operator: null, route_model: null, route_effort: null })] };
const PROFILES = {
  v: 1, default: "work",
  profiles: [
    { id: "work", harness: "claude-code", model: "opus", base_url: null, operator: null, header_names: [], flags: [], env_keys: [], used_by_cells: 1 },
    { id: "high", harness: "claude-code", model: null, base_url: null, operator: "high-effort-cell", header_names: ["X-Fleet-Operator"], flags: [], env_keys: [], used_by_cells: 1 },
  ],
};
const out = (stdout: unknown, code = 0, stderr = ""): CliOutput => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr });

function harness(answers: Record<string, CliOutput> = {}) {
  const runs: string[] = [];
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    const key = args.join(" ");
    runs.push(key);
    return answers[key] ?? (key === "--version" ? out("a4sx 0.27.0  (server 0.728.0)") : key === "mesh cells --json" ? out(CELLS)
      : key === "profiles --json" ? out(PROFILES) : key.startsWith("mesh peers") ? out({ v: 1, mesh_id: MESH, peers: [] }) : out(""));
  };
  const resolve = () => ({ kind: "found" as const, path: CLI });
  const provider = new CellsProvider({ resolve, run, server: () => BASE, onState: () => undefined });
  const deps: CellCommandDeps = {
    state: fakeMemento({ [CONSENT_KEY]: [machineKey()] }) as any, cliDir: undefined, provider, resolve, run, server: () => BASE, defaultServer: BASE,
    folder: async () => "/w/proj", fetch: async () => { throw new Error("no network"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
  };
  return { deps, runs, provider };
}

async function items(h: ReturnType<typeof harness>): Promise<LocalCellItem[]> {
  const all: LocalCellItem[] = [];
  for (const g of await h.provider.getChildren()) {
    if (g instanceof MeshGroupItem) {
      all.push(...((await h.provider.getChildren(g)).filter((i) => i instanceof LocalCellItem) as LocalCellItem[]));
    }
  }
  return all;
}

describe("Cells view: profile and route (CLI 0.27.0)", () => {
  beforeEach(resetCalls);

  it("parses the profile's name, source, operator and route; drops values the CLI wouldn't pass", () => {
    const a = parseCellsAnswer(JSON.stringify(CELLS))!;
    const [build, docs] = a.cells;
    assert.deepStrictEqual([build.launchProfile, build.profileName, build.profileSource, build.operator, build.routeModel, build.routeEffort],
      ["high", "High effort", "assigned", "high-effort-cell", "claude-fable-5-2", "high"]);
    assert.deepStrictEqual([docs.profileSource, docs.operator, docs.routeModel], ["default", undefined, undefined]);
    const bad = parseCellsAnswer(JSON.stringify({ v: 1, cells: [row({ profile_source: "x", operator: "a b", route_model: "m; rm -rf", route_effort: "ludicrous" })] }))!;
    assert.deepStrictEqual([bad.cells[0].profileSource, bad.cells[0].operator, bad.cells[0].routeModel, bad.cells[0].routeEffort], [undefined, undefined, undefined, undefined]);
    const old = parseCellsAnswer(JSON.stringify({ v: 1, cells: [{ ...row({}), launch_profile: undefined, profile_source: undefined, route_model: undefined }] }))!;
    assert.strictEqual(old.cells[0].profileName, undefined, "a 0.25/0.26 CLI: the id only, as before");
  });

  it("the description shows the profile and what its route serves; the tooltip says where the profile comes from", async () => {
    const h = harness();
    const [build, docs] = await items(h);
    assert.strictEqual(build.description, "default · profile High effort → claude-fable-5-2 (high) · stored · registry active");
    assert.strictEqual(docs.description, "profile Work · stored · registry active");
    assert.match(String(build.tooltip), /Launch profile: High effort \(set for this cell\)\nX-Fleet-Operator: high-effort-cell\nRoute: serves claude-fable-5-2 at high effort/);
    assert.match(String(docs.tooltip), /Launch profile: Work \(your default profile\)\n/);
    const plain: LocalCell = { name: "x", instanceId: "ins_X", meshId: MESH, isDefault: false, needsApproval: false, duplicate: false, launchProfile: "work" };
    assert.strictEqual(localCellDescription(plain, BASE, true), "profile work");
    assert.ok(!localCellTooltip(plain, BASE).includes("Route:"));
    assert.strictEqual(CELL_PROFILE_TEXTS.description("p", "m"), "profile p → m");
  });

  it("Set launch profile… picks a profile (or the default) and runs `mesh cell profile`", async () => {
    const h = harness();
    const [build, docs] = await items(h);
    calls.nextPick = 0;                                         // «work»
    assert.ok(await setCellProfile(h.deps, build));
    const pick = calls.quickPicks[0];
    assert.strictEqual(pick.options.title, CELL_CMD_TEXTS.profileTitle("build"));
    assert.deepStrictEqual(pick.items.map((i: any) => [i.label, i.description, i.detail]), [
      ["work", "your default", "opus"],
      ["high", "current", "X-Fleet-Operator: high-effort-cell"],
      [CELL_CMD_TEXTS.profileFollowDefault, undefined, CELL_CMD_TEXTS.profileFollowDefaultDetail],
    ]);
    calls.nextPick = 2;                                         // follow the default
    assert.ok(await setCellProfile(h.deps, docs));
    assert.strictEqual(calls.quickPicks[1].items[2].description, "current");
    assert.deepStrictEqual(h.runs.filter((r) => r.startsWith("mesh cell ")), ["mesh cell profile build work", "mesh cell profile docs --clear"]);
    assert.deepStrictEqual(calls.infos, [CELL_CMD_TEXTS.profileSet("build", "work"), CELL_CMD_TEXTS.profileCleared("docs")]);
    calls.nextPick = undefined;                                 // Esc: nothing runs
    assert.ok(!(await setCellProfile(h.deps, build)));
    assert.strictEqual(h.runs.filter((r) => r.startsWith("mesh cell ")).length, 2);
  });

  it("an older CLI is told to update; a refusal shows the CLI's text", async () => {
    let h = harness({ "mesh cell profile build work": out("", 2, "a4sx: error: argument cell_cmd: invalid choice: 'profile'") });
    calls.nextPick = 0;
    assert.ok(!(await setCellProfile(h.deps, (await items(h))[0])));
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [CELL_CMD_TEXTS.profileTooOld]);
    resetCalls();
    h = harness({ "mesh cell profile build work": out("", 1, "a4sx: too many changes in the last minute, so nothing was changed. Wait a minute and run the command again.") });
    calls.nextPick = 0;
    assert.ok(!(await setCellProfile(h.deps, (await items(h))[0])));
    assert.match(calls.errors[0].message, /^Could not set the cell's launch profile: .*too many changes/);
  });

  it("the argv: --mesh when the name is shared, --clear for the default, never a bad profile id", () => {
    const a: LocalCell = { name: "build", instanceId: "ins_A1", meshId: MESH, isDefault: false, needsApproval: false, duplicate: false };
    const b: LocalCell = { ...a, instanceId: "ins_B2", meshId: undefined };
    assert.deepStrictEqual(cellProfileArgs(a, [a], "high"), ["mesh", "cell", "profile", "build", "high"]);
    assert.deepStrictEqual(cellProfileArgs(a, [a, b], undefined), ["mesh", "cell", "profile", "build", "--clear", "--mesh", MESH]);
    assert.deepStrictEqual(cellProfileArgs(b, [a, b], "high"), ["mesh", "cell", "profile", "build", "high", "--mesh", "standalone"]);
    assert.strictEqual(cellProfileArgs(a, [a], "Bad Id"), undefined);
  });

  it("the menu: on stored, standalone, default and running cells; not on legacy ones; hidden from the palette", () => {
    const m = pkg.contributes.menus["view/item/context"].find((x: any) => x.command === "a4sx.setCellProfile");
    const re = new RegExp(m.when.match(/viewItem =~ \/(.*)\/$/)[1]);
    assert.deepStrictEqual(["a4sx.localCell", "a4sx.localCell.default.running", "a4sx.localCell.standalone", "a4sx.localCell.legacy"].map((c) => re.test(c)),
      [true, true, true, false]);
    assert.ok(pkg.contributes.menus.commandPalette.some((x: any) => x.command === "a4sx.setCellProfile" && x.when === "false"));
    assert.strictEqual(pkg.contributes.commands.find((c: any) => c.command === "a4sx.setCellProfile").title, "Set launch profile…");
  });
});
