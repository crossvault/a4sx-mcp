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
    assert.ok(localCellDescription(mine, BASE).includes("not in the signed-in account"));
    assert.ok(localCellTooltip(mine, BASE).includes("a4sx mesh cells --refresh"));
  });

  it("every state the extension knows has its words; a revoked one still says so", () => {
    for (const s of REGISTRY_STATES) {
      assert.ok(REGISTRY_TEXTS.description[s] && REGISTRY_TEXTS.tooltip[s], s);
    }
    const gone = parseCellsAnswer(JSON.stringify({ v: 1, default: null, cells: [row("revoked")] }))!.cells[0];
    assert.ok(localCellDescription(gone, BASE).includes("registry revoked"));
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
