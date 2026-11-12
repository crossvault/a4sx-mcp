// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.7.0 (a4sx #1861, mesh access control P1): the Cells view shows each cell's tags and one policy summary line
// from `mesh cells --json` (CLI 0.28.0: `tags`, `policy`), and "Open policy in browser" opens the mesh's Policy tab.
// Read-only: nothing here edits a tag or a policy. The CLI is a fake runner; nothing reaches a network or a shell.
import * as assert from "assert";
import { calls, resetCalls } from "../fakeVscode";
import { cellPolicySummary, CELL_POLICY_TEXTS, LocalCell, localCellDescription, localCellTooltip, parseCellPolicy, policyUrl, shownTags } from "../../cells";
import { openCellPolicy } from "../../cellCommands";
import { cellContext, CellsProvider, CliOutput, LocalCellItem, MeshGroupItem } from "../../cellsView";
import { MeshPolicy, parseCellsAnswer } from "../../cliJson";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../../package.json");

const MESH = "msh_0123456789abcdef0123456789abcdef";
const BASE = "https://session-exchange.com";
const URL_OK = `${BASE}/meshes/m/${MESH}?tab=policy`;
const CLI = "/opt/a4sx/a4sx";

/** A CLI 0.27.0 row: no `policy`, `tags` empty. */
const row27 = (o: Record<string, unknown> = {}) => ({
  name: "build", mesh_id: MESH, mesh_name: "Team mesh", instance_id: "ins_A1", base: "session-exchange.com", profile: null,
  local: { state: "stored", pid: null }, registry: { state: "active" }, path: "lan", mesh_policy: "open", tags: [], ...o,
});
/** A CLI 0.28.0 row: `tags` and `policy`. */
const row28 = (o: Record<string, unknown> = {}) => row27({
  tags: ["tag:ci", "tag:gpu"], policy: { basis: "preset", policy_rev: 7, can_talk_to: 3, reachable_from: 3, url: URL_OK }, ...o,
});
const one = (r: Record<string, unknown>): LocalCell => parseCellsAnswer(JSON.stringify({ v: 1, default: null, cells: [r] }))!.cells[0];
const out = (stdout: unknown, code = 0): CliOutput => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });

async function localItems(cells: unknown): Promise<LocalCellItem[]> {
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    const key = args.join(" ");
    return key === "--version" ? out("a4sx 0.28.0") : key === "mesh cells --json" ? out(cells) : key.startsWith("mesh peers") ? out({ v: 1, mesh_id: MESH, peers: [] }) : out("");
  };
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
  const all: LocalCellItem[] = [];
  for (const g of await provider.getChildren()) {
    if (g instanceof MeshGroupItem) {
      all.push(...((await provider.getChildren(g)).filter((i) => i instanceof LocalCellItem) as LocalCellItem[]));
    }
  }
  return all;
}

describe("Cells: tags and the policy summary (0.7.0, a4sx #1861)", () => {
  beforeEach(resetCalls);

  it("reads `tags` and `policy` from a CLI 0.28.0 row", () => {
    const c = one(row28());
    assert.deepStrictEqual(c.tags, ["tag:ci", "tag:gpu"]);
    assert.deepStrictEqual(c.policy, { basis: "preset", policyRev: 7, canTalkTo: 3, reachableFrom: 3, url: URL_OK });
    assert.strictEqual(cellPolicySummary(c), "Open · can talk to 3");
    assert.strictEqual(localCellDescription(c, BASE, true), "stored · registry active · path lan · tag:ci tag:gpu · Open · can talk to 3");
    const tip = localCellTooltip(c, BASE).split("\n");
    assert.ok(tip.includes("Tags: tag:ci, tag:gpu"));
    assert.ok(tip.includes("Open · can talk to 3"));
    assert.strictEqual(cellContext(c), "a4sx.localCell.policy");
  });

  it("a CLI that doesn't send `policy` (0.25.0–0.27.0) or `tags` shows nothing extra, and never fails", () => {
    for (const r of [row27(), row27({ tags: undefined }), row27({ tags: null, mesh_policy: null })]) {
      const c = one(r);
      assert.strictEqual(c.policy, undefined);
      assert.strictEqual(cellPolicySummary(c), undefined);
      assert.deepStrictEqual(shownTags(c), []);
      assert.strictEqual(localCellDescription(c, BASE, true), "stored · registry active · path lan");
      assert.ok(!localCellTooltip(c, BASE).includes("Tags:"));
      assert.strictEqual(cellContext(c), "a4sx.localCell");
    }
    // An older CLI's bare list (legacy): no tags, no policy.
    const legacy = parseCellsAnswer(JSON.stringify([{ name: "build", mesh_id: MESH, instance_id: "ins_A1", policy: { url: URL_OK, can_talk_to: 1 }, tags: ["tag:ci"] }]))!;
    assert.ok(legacy.legacy);
    assert.strictEqual(legacy.cells[0].policy, undefined);
    assert.strictEqual(cellPolicySummary(legacy.cells[0]), undefined);
    assert.strictEqual(cellContext(legacy.cells[0], true), "a4sx.localCell.legacy");
  });

  it("the summary: one label per policy, the count when known, nothing without a mesh policy", () => {
    const table = (["open", "own", "closed", null] as (MeshPolicy | null)[]).map((p) => [
      cellPolicySummary(one(row28({ mesh_policy: p }))),
      cellPolicySummary(one(row28({ mesh_policy: p, policy: { basis: "preset", policy_rev: null, can_talk_to: null, reachable_from: null, url: URL_OK } }))),
      cellPolicySummary(one(row28({ mesh_policy: p, policy: null }))),
      cellPolicySummary(one(row28({ mesh_policy: p, policy: { can_talk_to: 0 } }))),
    ]);
    assert.deepStrictEqual(table, [
      ["Open · can talk to 3", "Open", "Open", "Open · can talk to 0"],
      ["Own cells · can talk to 3", "Own cells", "Own cells", "Own cells · can talk to 0"],
      ["Closed · can talk to 3", "Closed", "Closed", "Closed · can talk to 0"],
      [undefined, undefined, undefined, undefined],
    ]);
    assert.strictEqual(cellPolicySummary(one(row28({ mesh_policy: "weird" }))), undefined, "an unknown policy is no policy");
    assert.deepStrictEqual(CELL_POLICY_TEXTS.labels, { open: "Open", own: "Own cells", closed: "Closed" });
  });

  it("a malformed `policy` never breaks the row: counts only when they are counts, null for anything but an object", () => {
    const cell = { meshId: MESH, server: BASE };
    assert.deepStrictEqual(parseCellPolicy({ policy_rev: "7", can_talk_to: -1, reachable_from: 1.5, basis: "<b>x</b>" }, cell),
      { policyRev: null, canTalkTo: null, reachableFrom: null });
    assert.deepStrictEqual(parseCellPolicy({ can_talk_to: 2, url: "javascript:alert(1)" }, cell), { policyRev: null, canTalkTo: 2, reachableFrom: null });
    for (const v of [null, "open", 3, [], true]) {
      assert.strictEqual(parseCellPolicy(v, cell), null);
    }
    const c = one(row28({ policy: "open" }));
    assert.strictEqual(c.policy, null);
    assert.strictEqual(cellPolicySummary(c), "Open");
    assert.strictEqual(cellContext(c), "a4sx.localCell");
  });

  it("the URL guard: https on the cell's own server, the cell's own mesh, exactly ?tab=policy; http only on localhost", () => {
    const cell = { meshId: MESH, server: BASE };
    const ok = [
      URL_OK,
      `https://session-exchange.com/meshes/m/${MESH}/?tab=policy`,
      `http://localhost:8080/meshes/m/${MESH}?tab=policy`,
      `http://127.0.0.1/meshes/m/${MESH}?tab=policy`,
    ];
    for (const u of ok) {
      assert.ok(policyUrl(u, u.startsWith("http:") ? { meshId: MESH } : cell), u);
    }
    assert.ok(policyUrl(`https://other.example/meshes/m/${MESH}?tab=policy`, { meshId: MESH }), "any https server when the CLI doesn't say which");
    const bad = [
      `http://session-exchange.com/meshes/m/${MESH}?tab=policy`,
      `http://localhost.evil.example/meshes/m/${MESH}?tab=policy`,
      `http://10.0.0.1/meshes/m/${MESH}?tab=policy`,
      `https://other.example/meshes/m/${MESH}?tab=policy`,
      `https://user:pw@session-exchange.com/meshes/m/${MESH}?tab=policy`,
      `https://session-exchange.com/meshes/m/${MESH}`,
      `https://session-exchange.com/meshes/m/${MESH}?tab=policy&x=1`,
      `https://session-exchange.com/meshes/m/${MESH}?tab=settings`,
      `https://session-exchange.com/meshes/m/${MESH}?tab=policy#x`,
      `https://session-exchange.com/meshes/m/msh_other?tab=policy`,
      `https://session-exchange.com/logout?tab=policy`,
      `https://session-exchange.com\\@evil.example/meshes/m/${MESH}?tab=policy`,
      `https://session-exchange.com/meshes/m/${MESH}?tab=policy\n`,
      ` ${URL_OK}`,
      `javascript:alert(1)//?tab=policy`,
      `file:///etc/passwd?tab=policy`,
      `vscode://a4sx/meshes/m/${MESH}?tab=policy`,
      `${BASE}/${"a".repeat(2100)}/meshes/m/${MESH}?tab=policy`,
      "not a url",
      42,
      null,
    ];
    for (const u of bad) {
      assert.strictEqual(policyUrl(u, cell), undefined, String(u));
    }
    assert.strictEqual(policyUrl(URL_OK, { meshId: undefined, server: BASE }), undefined, "a standalone cell has no Policy tab");
    assert.strictEqual(policyUrl(`http://localhost:8080/meshes/m/${MESH}?tab=policy`, cell), undefined, "localhost, but the cell's server is another");
    assert.ok(policyUrl(`http://localhost:8080/meshes/m/${MESH}?tab=policy`, { meshId: MESH, server: "https://localhost:8080" }), "a local server stored as a bare host");
    assert.strictEqual(policyUrl(`http://localhost:8080/meshes/m/${MESH}?tab=policy`, { meshId: MESH, server: "https://localhost:9090" }), undefined);
    // A refused URL leaves the summary and drops only the action.
    const c = one(row28({ policy: { basis: "preset", policy_rev: 1, can_talk_to: 2, reachable_from: 2, url: `https://evil.example/meshes/m/${MESH}?tab=policy` } }));
    assert.strictEqual(c.policy!.url, undefined);
    assert.strictEqual(cellPolicySummary(c), "Open · can talk to 2");
    assert.strictEqual(cellContext(c), "a4sx.localCell");
  });

  it("tags are plain text: only well-formed `tag:<name>` values are shown, never markup, icons or hidden characters", () => {
    const c = one(row28({
      tags: ["tag:ci", "<b>tag:x</b>", "[tag:y](https://evil.example)", "$(alert) tag:z", "tag:a‮b", "tag:UPPER", "tag:a4sx-ok", "ci", "tag:" + "a".repeat(33), 7, null, "tag:gpu"],
    }));
    assert.deepStrictEqual(shownTags(c), ["tag:ci", "tag:a4sx-ok", "tag:gpu"]);
    const desc = localCellDescription(c, BASE, true);
    assert.strictEqual(desc, "stored · registry active · path lan · tag:ci tag:a4sx-ok tag:gpu · Open · can talk to 3");
    assert.ok(!/[<>[\]$‮]/.test(desc + localCellTooltip(c, BASE)));
  });

  it("the view: each cell's description, a string tooltip (never markdown) and the `.policy` context", async () => {
    const items = await localItems({ v: 1, default: "build", cells: [
      row28(),
      row28({ name: "docs", instance_id: "ins_D4", mesh_policy: "own", tags: [], policy: { basis: "preset", policy_rev: 7, can_talk_to: null, reachable_from: null, url: URL_OK } }),
      row27({ name: "old", instance_id: "ins_O1" }),
    ] });
    assert.deepStrictEqual(items.map((i) => [i.label, i.description, i.contextValue]), [
      ["build", "default · stored · registry active · path lan · tag:ci tag:gpu · Open · can talk to 3", "a4sx.localCell.default.policy"],
      ["docs", "stored · registry active · path lan · Own cells", "a4sx.localCell.policy"],
      ["old", "stored · registry active · path lan", "a4sx.localCell"],
    ]);
    assert.ok(items.every((i) => typeof i.tooltip === "string"));
  });

  it("Open policy in browser opens the checked URL, and nothing for a cell without one", async () => {
    const items = await localItems({ v: 1, default: null, cells: [row28(), row27({ name: "old", instance_id: "ins_O1" })] });
    const [withUrl, without] = items;
    assert.ok(await openCellPolicy(withUrl));
    assert.ok(!(await openCellPolicy(without)));
    assert.ok(!(await openCellPolicy(undefined)));
    // A URL that got into the item some other way is checked again before it is opened.
    withUrl.cell.policy!.url = "https://evil.example/?tab=policy";
    assert.ok(!(await openCellPolicy(withUrl)));
    assert.deepStrictEqual(calls.opened, [URL_OK]);
  });

  it("the menu: Open policy in browser only on a cell with `.policy`; every other cell action keeps its verdict", () => {
    const menu = pkg.contributes.menus["view/item/context"].filter((m: any) => m.when.startsWith("view == a4sx.cells"));
    const res = (cmd: string) => menu.filter((m: any) => m.command === cmd && m.when.includes("=~")).map((m: any) => new RegExp(m.when.match(/viewItem =~ \/(.*)\/$/)[1]));
    const policy = res("a4sx.openCellPolicy");
    assert.strictEqual(policy.length, 1);
    assert.deepStrictEqual(menu.filter((m: any) => m.command === "a4sx.openCellPolicy").map((m: any) => m.group), ["1_cell@6"]);
    const ctxs = ["a4sx.localCell", "a4sx.localCell.default", "a4sx.localCell.running", "a4sx.localCell.default.running", "a4sx.localCell.standalone", "a4sx.localCell.legacy", "a4sx.cellMesh"];
    assert.deepStrictEqual(ctxs.map((c) => [policy[0].test(c), policy[0].test(`${c}.policy`)]), [
      [false, true], [false, true], [false, true], [false, true], [false, true], [false, true], [false, false],
    ]);
    for (const cmd of ["a4sx.startCell", "a4sx.stopCell", "a4sx.renameCell", "a4sx.forgetCell", "a4sx.setDefaultCell", "a4sx.copyCellLaunch", "a4sx.setCellProfile", "a4sx.openCellOnWeb"]) {
      for (const re of res(cmd)) {
        for (const c of ctxs.filter((x) => x.startsWith("a4sx.localCell") && !x.includes("legacy"))) {
          assert.strictEqual(re.test(`${c}.policy`), re.test(c), `${cmd} on ${c}`);
        }
      }
    }
    assert.ok(pkg.contributes.menus.commandPalette.some((m: any) => m.command === "a4sx.openCellPolicy" && m.when === "false"));
    assert.strictEqual(pkg.contributes.commands.find((c: any) => c.command === "a4sx.openCellPolicy").title, CELL_POLICY_TEXTS.openPolicy);
  });
});
