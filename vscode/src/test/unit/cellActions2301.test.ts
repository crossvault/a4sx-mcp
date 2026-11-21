/**
 * a4sx #2301 E5/E6 (cell01): four more actions on the rows of the Cells view: Last messages and Why can or can't I
 * message it on a cell on another machine; Save its conversation… and Start from a saved session… on a cell stored on
 * this computer. Each is one existing CLI command; a save says first that the copy is scrubbed; there is no hand-off.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import {
  CELL_ACTION_TEXTS, CellActionDeps, cellLastMessages, cellWhyMessage, CMD_CELL_EXPLAIN, CMD_CELL_FROM_SAVED, CMD_CELL_MESSAGES, CMD_CELL_SAVE, deliveriesArgs, explainArgs,
  saveCellConversation, savedSessionItems, senderChoices, shownOutput, startCellFromSaved,
} from "../../cellActions";
import { CELL_CMD_TEXTS } from "../../cellCommands";
import { CELL_LAST_SESSION_FILE } from "../../cellResume";
import { CellsProvider, CliOutput, LocalCellItem, RemoteCellItem } from "../../cellsView";
import { parseCellsAnswer } from "../../cliJson";
import { projectDirName } from "../../nativeSeed";
import { LibraryUnreadable, SAVE_TAB_TEXTS } from "../../saveTab";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscodeFake = require("vscode");
const BASE = "https://session-exchange.com";
const MESH = "msh_0123456789abcdef0123456789abcdef";
const CLI = "/opt/a4sx/a4sx";
const SID = "0a1b2c3d-1111-2222-3333-444455556666";
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));

const row = (name: string, ins: string, state = "stored", extra: Record<string, unknown> = {}) => ({
  name, mesh_id: MESH, mesh_name: "Team mesh", instance_id: ins, profile: null, local: { state, pid: state === "running" ? 4242 : null },
  registry: { state: "active" }, path: null, mesh_policy: "open", tags: [], ...extra,
});

interface Answers {
  cells?: unknown[];
  deliveries?: CliOutput;
  explain?: CliOutput;
}

function harness(answers: Answers = {}) {
  const runs: string[] = [];
  const shown: { title: string; text: string }[] = [];
  const cellsJson = JSON.stringify({ v: 1, default: "build", cells: answers.cells ?? [row("build", "ins_A1"), row("docs", "ins_A2")] });
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    const line = args.join(" ");
    runs.push(line);
    if (line === "--version") {
      return { code: 0, stdout: "a4sx 0.59.7  (server 0.760.0)\n", stderr: "" };
    }
    if (line === "mesh cells --json") {
      return { code: 0, stdout: cellsJson, stderr: "" };
    }
    if (line.startsWith("mesh deliveries ")) {
      return answers.deliveries ?? { code: 0, stdout: "build -> desk-agent  delivered  2026-11-21 16:02\n", stderr: "" };
    }
    if (line.includes(" --explain ")) {
      return answers.explain ?? { code: 0, stdout: "«build» → «desk-agent»: allowed by the mesh's rules.\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-2301e56-"));
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => BASE, onState: () => undefined });
  const deps: CellActionDeps = {
    state: fakeMemento() as any, cliDir: undefined, provider, resolve: () => ({ kind: "found", path: CLI }), run,
    server: () => BASE, defaultServer: BASE, folder: async () => "/w/proj",
    fetch: async () => { throw new Error("no network in tests"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
    stateDir: tmp(), claudeProjects: tmp(), home: tmp(),
    show: (title, text) => { shown.push({ title, text }); },
  };
  calls.nextOpenDialog = [vscodeFake.Uri.file("/w/proj")];
  const cells = parseCellsAnswer(cellsJson)!.cells;
  const local = (name: string) => new LocalCellItem(cells.find((c) => c.name === name)!, cells, BASE);
  return { deps, runs, shown, provider, cells, local };
}

const remote = (own = true, name = "desk-agent", ins = "ins_D1") => new RemoteCellItem(MESH, { instanceId: ins, name, own, tags: [] });

/** Records the cell's last conversation as the CLI does, with its transcript; returns the transcript's path. */
function recordConversation(h: ReturnType<typeof harness>, name: string, ins: string, withTranscript = true): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-2301e56-cwd-"));
  const stateFile = path.join(h.deps.stateDir!, "agents", name, "state", CELL_LAST_SESSION_FILE);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ v: 1, cells: { [ins]: { sid: SID, cwd, at: "2026-11-21T16:00:00Z" } } }));
  const file = path.join(h.deps.claudeProjects!, projectDirName(cwd), `${SID}.jsonl`);
  if (withTranscript) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"type":"user","sessionId":"' + SID + '","message":{"role":"user","content":"hello"}}\n');
  }
  return file;
}

describe("#2301 E5: asking about a cell on another machine", () => {
  beforeEach(resetCalls);

  it("the commands, as argv arrays; nothing the CLI wouldn't take", () => {
    assert.deepStrictEqual(deliveriesArgs("ins_D1", MESH), ["mesh", "deliveries", "ins_D1", "--mesh", MESH, "--last", "10"]);
    assert.strictEqual(deliveriesArgs("ins_D1; rm", MESH), undefined);
    assert.strictEqual(deliveriesArgs("ins_D1", "Team mesh"), undefined);
    assert.strictEqual(deliveriesArgs("ins_D1", MESH, 0), undefined);
    // review: by instance ids (names aren't unique in a mesh; the CLI refuses an ambiguous one)
    assert.deepStrictEqual(explainArgs(MESH, "ins_A1", "ins_D1"), ["mesh", "policy", MESH, "--explain", "ins_A1", "ins_D1"]);
    assert.strictEqual(explainArgs(MESH, "build", "desk-agent"), undefined);
    assert.strictEqual(explainArgs(MESH, "ins_A1", "--cap"), undefined);
    assert.strictEqual(explainArgs("testmesh", "ins_A1", "ins_D1"), undefined);
  });

  it("Last messages: one `mesh deliveries` with the ids, shown as the CLI printed it", async () => {
    const h = harness();
    assert.strictEqual(await cellLastMessages(h.deps, remote(false)), true);   // also on another person's cell
    assert.deepStrictEqual(h.runs, [`mesh deliveries ins_D1 --mesh ${MESH} --last 10`]);
    assert.deepStrictEqual(h.shown, [{ title: "Last messages with «desk-agent»", text: "build -> desk-agent  delivered  2026-11-21 16:02" }]);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("Last messages: nothing recorded reads as a sentence (the CLI exits 1 with it); a refusal shows the CLI's own line", async () => {
    const none = "No messages with «desk-agent» are recorded on this computer. Each running cell here keeps the results of its last messages, and they go when it stops.";
    // the CLI's MESH_TEXT_DELIVERIES_NONE, as cell01 saw it on Windows with no cell running
    const quiet = harness({ deliveries: { code: 1, stdout: "", stderr: "a4sx: no delivery results for «ins_D1» on this host: no cell of yours here has exchanged messages with it since its proxy started\n" } });
    assert.strictEqual(await cellLastMessages(quiet.deps, remote()), true);
    assert.deepStrictEqual(calls.infos, [none]);
    assert.strictEqual(calls.errors.length, 0);
    assert.strictEqual(quiet.shown.length, 0);
    const empty = harness({ deliveries: { code: 0, stdout: "\n", stderr: "" } });
    assert.strictEqual(await cellLastMessages(empty.deps, remote()), true);
    assert.deepStrictEqual(calls.infos, [none, none]);
    const failed = harness({ deliveries: { code: 1, stdout: "", stderr: "a4sx: no cell of «Team mesh» is stored on this host\n" } });
    assert.strictEqual(await cellLastMessages(failed.deps, remote()), false);
    assert.strictEqual(failed.shown.length, 0);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [CELL_CMD_TEXTS.cliFailed("read the last messages", "no cell of «Team mesh» is stored on this host")]);
  });

  it("what is shown is text: control characters go, an oversized answer is cut", () => {
    assert.strictEqual(shownOutput("a\x1b[31mb\r\nc\x07\n\n\n\nd  \n"), "a[31mb\nc\n\nd");
    assert.strictEqual(shownOutput("x".repeat(50), 10), `${"x".repeat(9)}…`);
  });

  it("Why can or can't I message it: the only cell here asks, and a one-sentence answer is a message", async () => {
    const h = harness({ cells: [row("build", "ins_A1")] });
    await h.provider.refresh();
    h.runs.length = 0;
    assert.strictEqual(await cellWhyMessage(h.deps, remote()), true);
    assert.deepStrictEqual(h.runs, [`mesh policy ${MESH} --explain ins_A1 ins_D1`]);
    assert.deepStrictEqual(calls.infos, ["«build» → «desk-agent»: allowed by the mesh's rules."]);
    assert.strictEqual(calls.quickPicks.length, 0);
    assert.strictEqual(h.shown.length, 0);
  });

  it("Why…: several cells here: the default first, the person picks the sender; a long answer goes to the output", async () => {
    const h = harness({ explain: { code: 0, stdout: "«docs» → «desk-agent»: refused.\nThe rule that decides: tag:lead → * one-way\n", stderr: "" } });
    await h.provider.refresh();
    assert.deepStrictEqual(senderChoices(h.provider.cells, MESH).map((c) => c.name), ["build", "docs"]);
    assert.deepStrictEqual(senderChoices(h.provider.cells, "msh_other"), []);
    calls.pickQueue.push(1);
    assert.strictEqual(await cellWhyMessage(h.deps, remote()), true);
    assert.strictEqual(calls.quickPicks[0].options.title, "Which of your cells here should message «desk-agent»?");
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => [i.label, i.description]), [["build", "default"], ["docs", undefined]]);
    assert.strictEqual(h.runs[h.runs.length - 1], `mesh policy ${MESH} --explain ins_A2 ins_D1`);
    assert.deepStrictEqual(h.shown, [{ title: "Can «docs» message «desk-agent»?", text: "«docs» → «desk-agent»: refused.\nThe rule that decides: tag:lead → * one-way" }]);
  });

  it("Why…: Esc at the pick asks nothing; no cell of that mesh here says so; a refusal shows the CLI's line", async () => {
    const h = harness();
    await h.provider.refresh();
    h.runs.length = 0;
    calls.pickQueue.push(undefined);
    assert.strictEqual(await cellWhyMessage(h.deps, remote()), false);
    assert.deepStrictEqual(h.runs, []);
    const none = harness({ cells: [] });
    await none.provider.refresh();
    assert.strictEqual(await cellWhyMessage(none.deps, remote()), false);
    assert.strictEqual(calls.errors[calls.errors.length - 1].message, CELL_ACTION_TEXTS.whyNoLocal);
    const admin = harness({ cells: [row("build", "ins_A1")], explain: { code: 1, stdout: "", stderr: "a4sx: Only an admin of this mesh can do that\n" } });
    await admin.provider.refresh();
    assert.strictEqual(await cellWhyMessage(admin.deps, remote()), false);
    assert.strictEqual(calls.errors[calls.errors.length - 1].message, CELL_CMD_TEXTS.cliFailed("ask the mesh's rules", "Only an admin of this mesh can do that"));
  });
});

describe("#2301 E6: Save its conversation…", () => {
  beforeEach(resetCalls);

  it("asks first, and says plainly that the saved copy is scrubbed", async () => {
    const h = harness();
    recordConversation(h, "docs", "ins_A2");
    assert.strictEqual(await saveCellConversation(h.deps, h.local("docs")), undefined);   // Cancel
    assert.strictEqual(calls.modals.length, 1);
    assert.strictEqual(calls.modals[0].message, "Save «docs»'s conversation to your a4sx library?");
    assert.deepStrictEqual(calls.modals[0].items, ["Save scrubbed copy"]);
    assert.strictEqual(calls.modals[0].detail,
      "The saved copy is scrubbed: before it uploads, the a4sx CLI removes secrets and replaces e-mail addresses, host " +
      "names, IP addresses and your home folder in paths. The conversation on this computer stays as it is. A cell " +
      "started later from the saved copy reads the replaced values, not the real ones.");
    assert.strictEqual(calls.terminals.length, 0);
    assert.ok(!h.runs.some((r) => r.startsWith("push")), "nothing is uploaded without a terminal the person sees");
  });

  it("a first save is a plain `a4sx push <transcript>` in a terminal", async () => {
    const h = harness();
    const file = recordConversation(h, "docs", "ins_A2");
    calls.modalChoices.push(CELL_ACTION_TEXTS.save);
    const t = await saveCellConversation(h.deps, h.local("docs"), { saved: async () => [] });
    assert.ok(t);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}'\n`]);
    assert.ok(h.deps.terminals.has(t as any), "the view reads the cells again when it closes");
  });

  it("a later save becomes a new version of the entry that holds this conversation", async () => {
    const h = harness();
    const file = recordConversation(h, "docs", "ins_A2");
    calls.modalChoices.push(CELL_ACTION_TEXTS.save);
    const asked: string[] = [];
    await saveCellConversation(h.deps, h.local("docs"), { saved: async (slug) => { asked.push(slug); return [{ id: "col-lib-0a1b2c3d1111" }]; } });
    assert.deepStrictEqual(asked, ["0a1b2c3d1111"]);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}' '--into' 'col-lib-0a1b2c3d1111'\n`]);
  });

  it("a running cell's conversation can be saved too", async () => {
    const h = harness({ cells: [row("build", "ins_A1", "running")] });
    const file = recordConversation(h, "build", "ins_A1");
    calls.modalChoices.push(CELL_ACTION_TEXTS.save);
    await saveCellConversation(h.deps, h.local("build"), { saved: async () => [] });
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}'\n`]);
  });

  it("an unreadable library saves nothing (a plain push could add the conversation a second time)", async () => {
    const h = harness();
    recordConversation(h, "docs", "ins_A2");
    calls.modalChoices.push(CELL_ACTION_TEXTS.save);
    assert.strictEqual(await saveCellConversation(h.deps, h.local("docs"), { saved: async () => { throw new LibraryUnreadable(true); } }), undefined);
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(calls.errors[0].message, SAVE_TAB_TEXTS.signedOut);
  });

  it("no conversation yet, or its transcript gone: said, and nothing is asked or started", async () => {
    const h = harness();
    assert.strictEqual(await saveCellConversation(h.deps, h.local("docs")), undefined);
    assert.deepStrictEqual(calls.infos, ["«docs» has no conversation recorded on this computer yet, so there is nothing to save."]);
    recordConversation(h, "build", "ins_A1", false);
    assert.strictEqual(await saveCellConversation(h.deps, h.local("build")), undefined);
    assert.strictEqual(calls.errors[0].message, "«build»'s last conversation (session 0a1b2c3d) can't be found on this computer any more, so it can't be saved.");
    assert.strictEqual(calls.modals.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
  });
});

describe("#2301 E6: Start from a saved session…", () => {
  beforeEach(resetCalls);
  const library = [
    { id: "col-lib-aaaaaaaaaaaa", label: "docs-backup", title: "Docs: backups", updated_at: "2026-11-20T10:00:00Z", sessions: ["lib-aaaaaaaaaaaa"] },
    { id: "col-lib-bbbbbbbbbbbb", title: "Fleet router base", updated_at: "2026-11-21T09:30:00Z", sessions: ["lib-bbbbbbbbbbbb"] },
  ];

  it("the pick: newest first; label, else title; title and last change beside it", () => {
    assert.deepStrictEqual(savedSessionItems(library).map((i) => [i.label, i.description]), [
      ["Fleet router base", "2026-11-21 09:30"],
      ["docs-backup", "Docs: backups · 2026-11-20 10:00"],
    ]);
  });

  it("picks a library entry, then runs as Run as cell in terminal does, with this cell", async () => {
    const h = harness();
    calls.pickQueue.push(1, []);   // docs-backup; no option ticked
    const t = await startCellFromSaved(h.deps, h.local("docs"), { sessions: async () => library, projectsDir: h.deps.claudeProjects });
    assert.ok(t, JSON.stringify(calls.errors));
    assert.strictEqual(calls.quickPicks[0].options.title, "Start «docs» from a saved session");
    // Run as cell reads the cells again, so the cell chosen beforehand is named with its mesh (as Convert into an existing cell… does)
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--cell' 'docs' '--a4sx-session=col-lib-aaaaaaaaaaaa'\n`]);
    assert.ok(!h.runs.some((r) => r.startsWith("launch")), "never started without a terminal");
  });

  it("a running cell isn't restarted behind the person's back; Esc starts nothing", async () => {
    const h = harness({ cells: [row("build", "ins_A1", "running"), row("docs", "ins_A2")] });
    assert.strictEqual(await startCellFromSaved(h.deps, h.local("build"), { sessions: async () => library }), undefined);
    assert.strictEqual(calls.errors[0].message, "«build» is running on this computer. Stop it first, then start it from a saved session.");
    calls.pickQueue.push(undefined);
    assert.strictEqual(await startCellFromSaved(h.deps, h.local("docs"), { sessions: async () => library }), undefined);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("signed out, an unreadable library, an empty one: said, nothing started", async () => {
    const h = harness();
    await startCellFromSaved(h.deps, h.local("docs"), { sessions: async () => { throw new LibraryUnreadable(true); } });
    assert.strictEqual(calls.errors[0].message, CELL_ACTION_TEXTS.fromSavedSignedOut);
    await startCellFromSaved(h.deps, h.local("docs"), { sessions: async () => { throw new LibraryUnreadable(false, "the server didn't answer"); } });
    assert.strictEqual(calls.errors[1].message, "Nothing was started: your a4sx library couldn't be read (the server didn't answer).");
    await startCellFromSaved(h.deps, h.local("docs"), { sessions: async () => [] });
    assert.deepStrictEqual(calls.infos, ["Your a4sx library holds no saved sessions yet."]);
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(calls.quickPicks.length, 0);
  });
});

describe("#2301 E5/E6: the menus", () => {
  const menu = pkg.contributes.menus["view/item/context"].filter((m: any) => m.when.startsWith("view == a4sx.cells"));
  const when = (cmd: string) => new RegExp(menu.find((m: any) => m.command === cmd).when.match(/viewItem =~ \/(.*)\/$/)[1]);
  const title = (cmd: string) => pkg.contributes.commands.find((c: any) => c.command === cmd).title;

  it("the titles, verbatim", () => {
    assert.strictEqual(title(CMD_CELL_MESSAGES), "Last messages");
    assert.strictEqual(title(CMD_CELL_EXPLAIN), "Why can or can't I message it");
    assert.strictEqual(title(CMD_CELL_SAVE), "Save its conversation…");
    assert.strictEqual(title(CMD_CELL_FROM_SAVED), "Start from a saved session…");
  });

  it("the two questions are on every cell elsewhere; Save on a mesh cell here; Start from saved only while it isn't running", () => {
    const ctxs = ["a4sx.localCell", "a4sx.localCell.default.running", "a4sx.localCell.standalone", "a4sx.localCell.legacy", "a4sx.localCell.default.policy", "a4sx.remoteCell", "a4sx.remoteCell.own"];
    const table = Object.fromEntries([CMD_CELL_MESSAGES, CMD_CELL_EXPLAIN, CMD_CELL_SAVE, CMD_CELL_FROM_SAVED].map((c) => [c, ctxs.map((x) => when(c).test(x))]));
    assert.deepStrictEqual(table, {
      [CMD_CELL_MESSAGES]: [false, false, false, false, false, true, true],
      [CMD_CELL_EXPLAIN]: [false, false, false, false, false, true, true],
      [CMD_CELL_SAVE]: [true, true, false, false, true, false, false],
      [CMD_CELL_FROM_SAVED]: [true, false, false, false, true, false, false],
    });
  });

  it("none of them is in the Command Palette or inline, and there is no hand-off", () => {
    for (const c of [CMD_CELL_MESSAGES, CMD_CELL_EXPLAIN, CMD_CELL_SAVE, CMD_CELL_FROM_SAVED]) {
      assert.ok(pkg.contributes.menus.commandPalette.some((m: any) => m.command === c && m.when === "false"), c);
      assert.ok(menu.filter((m: any) => m.command === c).every((m: any) => !m.group.startsWith("inline")), c);
    }
    assert.ok(!pkg.contributes.commands.some((c: any) => /hand.?off/i.test(c.command + c.title)), "waits for the CLI's as-is mode (a4sx #2292)");
  });
});
