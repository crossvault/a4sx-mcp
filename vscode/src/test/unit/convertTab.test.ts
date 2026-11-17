// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.8.0: Convert to cell on a Claude Code tab. Which tab a command is about, which session a tab shows (by the
// title Claude Code writes into the transcript), the command builder with `--mesh`, and the whole command against
// a fake CLI runner and transcripts in a temp folder. Nothing reaches a network or a shell.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, fakeMemento, fakeSecrets, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import { newCellRunArgs } from "../../cells";
import { CELL_CMD_TEXTS, CellCommandDeps, CONSENT_KEY, machineKey } from "../../cellCommands";
import { CellsProvider, CliOutput, CliResolution } from "../../cellsView";
import { IN_SESSION_MESSAGE } from "../../cliJson";
import { CONVERT_TEXTS, convertTabToCell, meshPickItems, sessionPickItems } from "../../convertTab";
import { projectDirName } from "../../nativeSeed";
import { RUN_AS_CELL_TEXTS } from "../../runAsCell";
import { entryPickItems, pushArgs, SAVE_TAB_TEXTS, saveTabSession } from "../../saveTab";
import {
  chooseClaudeTab, CLAUDE_PANEL, editorIndexOf, isClaudeTab, labelMatches, recentSessions, sessionsForLabel, slugOf, TAIL_BYTES, transcriptTitle,
} from "../../tabSession";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../../package.json");

const BASE = "https://session-exchange.com";
const CLI = "/opt/a4sx bin/a4sx";
const MESH = `msh_${"a".repeat(32)}`;
const SID = "0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b";
const SID2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SID3 = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

const claudeTab = (label: string) => ({ label, input: { viewType: `mainThreadWebview-${CLAUDE_PANEL}` } });
const fileTab = (label: string) => ({ label, input: { uri: { scheme: "file", fsPath: `/w/${label}` } } });
const out = (stdout: unknown, code = 0): CliOutput => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const flush = async (n = 6) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); } };

function harness(state = fakeMemento({ [CONSENT_KEY]: [machineKey()] }), resolution: CliResolution = { kind: "found", path: CLI }): { deps: CellCommandDeps; runs: string[] } {
  const runs: string[] = [];
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    const key = args.join(" ");
    runs.push(key);
    return key === "--version" ? out("a4sx 0.25.0  (server 0.718.0)") : key === "mesh cells --json" ? out({ v: 1, default: null, cells: [] }) : out("");
  };
  const resolve = () => resolution;
  const provider = new CellsProvider({ resolve, run, server: () => BASE, onState: () => undefined });
  const deps: CellCommandDeps = {
    state: state as any, cliDir: undefined, provider, resolve, run, server: () => BASE, defaultServer: BASE,
    folder: async () => "/w/proj", fetch: async () => { throw new Error("no network"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
  };
  return { deps, runs };
}

/** A temp projects dir with transcripts as Claude Code files them: <projects>/<folder name>/<session id>.jsonl. */
function projects() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-convert-"));
  const dir = path.join(root, "projects");
  let clock = Date.parse("2026-11-01T12:00:00Z");
  return {
    dir,
    /** A folder a session ran in (it exists). */
    cwd(name: string): string {
      const p = path.join(root, name);
      fs.mkdirSync(p, { recursive: true });
      return p;
    },
    /** Writes a transcript; each one is newer than the one before. */
    session(cwd: string, id: string, records: Record<string, unknown>[], pad = 0): string {
      const folder = path.join(dir, projectDirName(cwd));
      fs.mkdirSync(folder, { recursive: true });
      const lines = [
        JSON.stringify({ type: "user", cwd, sessionId: id, message: { role: "user", content: "x".repeat(pad) } }),
        ...records.map((r) => JSON.stringify({ sessionId: id, ...r })),
      ];
      const file = path.join(folder, `${id}.jsonl`);
      fs.writeFileSync(file, `${lines.join("\n")}\n`);
      clock += 60_000;
      fs.utimesSync(file, new Date(clock), new Date(clock));
      return file;
    },
    remove(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("Convert to cell: which tab", () => {
  it("a Claude Code tab is a webview whose view type is, or ends with, the Claude panel's", () => {
    assert.strictEqual(isClaudeTab(claudeTab("x")), true);
    assert.strictEqual(isClaudeTab({ label: "x", input: { viewType: CLAUDE_PANEL } }), true);
    assert.strictEqual(isClaudeTab({ label: "x", input: { viewType: "mainThreadWebview-claudePlanPreview" } }), false);
    assert.strictEqual(isClaudeTab({ label: "x", input: { viewType: `${CLAUDE_PANEL}Other` } }), false);
    assert.strictEqual(isClaudeTab(fileTab("a.ts")), false);
    assert.strictEqual(isClaudeTab({ label: "x" }), false);
    assert.strictEqual(isClaudeTab(undefined), false);
  });

  it("the tab's index comes from the context menu's arguments; anything else gives none", () => {
    assert.strictEqual(editorIndexOf([{ scheme: "webview-panel" }, { groupId: 3, editorIndex: 2 }]), 2);
    assert.strictEqual(editorIndexOf([{ groupId: 0, editorIndex: 0 }]), 0);
    assert.strictEqual(editorIndexOf([]), undefined);
    assert.strictEqual(editorIndexOf([undefined, null, "x", { editorIndex: "1" }, { editorIndex: -1 }, { editorIndex: 1.5 }]), undefined);
  });

  it("from a context menu: the tab at that index in the active group, else in the only group with a Claude tab there", () => {
    const a = claudeTab("A");
    const b = claudeTab("B");
    const g1 = { tabs: [fileTab("x.ts"), a], activeTab: a };
    const g2 = { tabs: [b, fileTab("y.ts")], activeTab: b };
    assert.deepStrictEqual(chooseClaudeTab([g1, g2], g1, 1), { kind: "one", tab: a });
    assert.deepStrictEqual(chooseClaudeTab([g1, g2], g1, 0), { kind: "one", tab: b }, "index 0 is a Claude tab only in the other group");
    // Claude tabs at the same index in both groups: the active group's.
    const g3 = { tabs: [fileTab("z.ts"), b], activeTab: b };
    assert.deepStrictEqual(chooseClaudeTab([g1, g3], g3, 1), { kind: "one", tab: b });
    // The index names no Claude tab anywhere: every Claude tab is offered.
    assert.deepStrictEqual(chooseClaudeTab([g1, g2], g1, 7), { kind: "many", tabs: [a, b] });
  });

  it("from the Command Palette: the active tab; else the only Claude tab; several are offered; none is none", () => {
    const a = claudeTab("A");
    const b = claudeTab("B");
    const f = fileTab("x.ts");
    assert.deepStrictEqual(chooseClaudeTab([{ tabs: [f, a, b], activeTab: b }], { tabs: [f, a, b], activeTab: b }, undefined), { kind: "one", tab: b });
    assert.deepStrictEqual(chooseClaudeTab([{ tabs: [f, a], activeTab: f }], { tabs: [f, a], activeTab: f }, undefined), { kind: "one", tab: a });
    assert.deepStrictEqual(chooseClaudeTab([{ tabs: [f, a, b], activeTab: f }], { tabs: [f, a, b], activeTab: f }, undefined), { kind: "many", tabs: [a, b] });
    assert.deepStrictEqual(chooseClaudeTab([{ tabs: [f], activeTab: f }], undefined, undefined), { kind: "none" });
    assert.deepStrictEqual(chooseClaudeTab([], undefined, 0), { kind: "none" });
  });
});

describe("Convert to cell: which session", () => {
  const line = (r: Record<string, unknown>) => JSON.stringify(r);

  it("the title is the last custom-title (a rename), else the last ai-title", () => {
    const ai1 = line({ type: "ai-title", aiTitle: "First title", sessionId: SID });
    const ai2 = line({ type: "ai-title", aiTitle: "  Later\ttitle ", sessionId: SID });
    const custom = line({ type: "custom-title", customTitle: "My name", sessionId: SID });
    assert.strictEqual(transcriptTitle([ai1, ai2].join("\n")), "Later title");
    assert.strictEqual(transcriptTitle([ai1, custom, ai2].join("\n")), "My name", "a rename wins over a later ai-title, as in Claude Code");
    assert.strictEqual(transcriptTitle(""), undefined);
    assert.strictEqual(transcriptTitle(line({ type: "user", message: { content: "\"ai-title\" is only mentioned here", aiTitle: "no" } })), undefined);
    assert.strictEqual(transcriptTitle(line({ type: "ai-title", aiTitle: 7 })), undefined);
    assert.strictEqual(transcriptTitle(line({ type: "ai-title", aiTitle: "   " })), undefined);
  });

  it("a line cut at the start of the tail is skipped; a long title is capped", () => {
    const cut = line({ type: "ai-title", aiTitle: "Cut off", sessionId: SID }).slice(20);
    const whole = line({ type: "ai-title", aiTitle: "Whole", sessionId: SID });
    assert.strictEqual(transcriptTitle(`${cut}\n${whole}\n`), "Whole");
    assert.strictEqual(transcriptTitle(`${cut}\n`), undefined);
    assert.strictEqual(transcriptTitle(line({ type: "ai-title", aiTitle: "t".repeat(500) }))!.length, 200);
  });

  it("a tab's label is a title when the text is the same, or the title's start when the label was shortened", () => {
    assert.strictEqual(labelMatches("Fix the login bug", "Fix the login bug"), true);
    assert.strictEqual(labelMatches("  fix the  LOGIN bug ", "Fix the login bug"), true);
    assert.strictEqual(labelMatches("Fix the login…", "Fix the login bug"), true);
    assert.strictEqual(labelMatches("Fix the login...", "Fix the login bug"), true);
    assert.strictEqual(labelMatches("Fix the", "Fix the login bug"), false, "a shorter label without the mark is another title");
    assert.strictEqual(labelMatches("Fix…", "Fix the login bug"), false, "too short to tell");
    assert.strictEqual(labelMatches("Fix the login bug", undefined), false);
    assert.strictEqual(labelMatches("", ""), false);
    assert.strictEqual(labelMatches("Other", "Fix the login bug"), false);
  });

  it("reads the newest transcripts, newest first, each with its title; only the end of a long one is read", async () => {
    const p = projects();
    try {
      const a = p.cwd("alpha");
      const b = p.cwd("beta");
      p.session(a, SID, [{ type: "ai-title", aiTitle: "Old title" }, { type: "ai-title", aiTitle: "Alpha work" }]);
      p.session(b, SID2, [{ type: "assistant", message: { content: "no title record" } }]);
      // The title sits before the last TAIL_BYTES: the session is listed without one.
      p.session(a, SID3, [{ type: "ai-title", aiTitle: "Too far back" }, { type: "user", message: { content: "y".repeat(TAIL_BYTES + 10) } }]);
      fs.writeFileSync(path.join(p.dir, projectDirName(a), "notes.txt"), "not a transcript");
      const list = await recentSessions(p.dir);
      assert.deepStrictEqual(list.map((s) => [s.sessionId, s.folder, s.title]), [
        [SID3, projectDirName(a), undefined], [SID2, projectDirName(b), undefined], [SID, projectDirName(a), "Alpha work"],
      ]);
      assert.strictEqual(list[2].file, path.join(p.dir, projectDirName(a), `${SID}.jsonl`));
      assert.deepStrictEqual((await recentSessions(p.dir, 1)).map((s) => s.sessionId), [SID3]);
      assert.deepStrictEqual(sessionsForLabel("Alpha work", list).map((s) => s.sessionId), [SID]);
      assert.deepStrictEqual(sessionsForLabel("Claude Code", list), []);
      assert.deepStrictEqual(await recentSessions(path.join(p.dir, "missing")), []);
    } finally {
      p.remove();
    }
  });

  it("the session pick shows title, folder, age and the id's start; the slug is the id's first 12 letters and digits", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    const rows = sessionPickItems([
      { sessionId: SID, folder: "-w-proj", file: "", mtime: now - 20_000, title: "Alpha work" },
      { sessionId: SID2, folder: "-w-other", file: "", mtime: now - 5 * 60_000 },
      { sessionId: SID3, folder: "-w-old", file: "", mtime: now - 3 * 3_600_000, title: "Older" },
      { sessionId: SID3, folder: "-w-old", file: "", mtime: now - 5 * 86_400_000, title: "Oldest" },
    ], now);
    assert.deepStrictEqual(rows.map((r) => [r.label, r.description]), [
      ["Alpha work", "-w-proj · just now · 0f1e2d3c"], [CONVERT_TEXTS.untitled, "-w-other · 5 min ago · 1a2b3c4d"],
      ["Older", "-w-old · 3 h ago · 2b3c4d5e"], ["Oldest", "-w-old · 5 d ago · 2b3c4d5e"],
    ]);
    assert.strictEqual(slugOf(SID), "0f1e2d3c4b5a");
  });
});

describe("Convert to cell: the command", () => {
  let p: ReturnType<typeof projects>;
  beforeEach(() => {
    resetCalls();
    p = projects();
  });
  afterEach(() => p.remove());

  it("`launch --new-cell` takes an optional mesh; a mesh id the CLI doesn't take gives no command", () => {
    const o = { reduced: true, autoAllow: false };
    assert.deepStrictEqual(newCellRunArgs(o, { kind: "local", sessionId: SID }), ["launch", "--new-cell", "--mesh-reduced-isolation", "--", "--resume", SID]);
    assert.deepStrictEqual(newCellRunArgs(o, { kind: "local", sessionId: SID }, MESH), ["launch", "--new-cell", "--mesh", MESH, "--mesh-reduced-isolation", "--", "--resume", SID]);
    assert.strictEqual(newCellRunArgs(o, { kind: "local", sessionId: SID }, "msh_x; rm -rf ~"), undefined);
    assert.strictEqual(newCellRunArgs(o, { kind: "local", sessionId: "not-an-id" }, MESH), undefined);
  });

  it("a tab whose title names one session: a new cell resumes it in its own folder, with no cell or session pick", async () => {
    const cwd = p.cwd("alpha");
    p.session(cwd, SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    p.session(p.cwd("beta"), SID2, [{ type: "ai-title", aiTitle: "Beta work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [fileTab("a.ts"), tab], activeTab: tab }];
    const h = harness();
    calls.pickQueue.push([0]);   // the options as offered (Keep my sign-in on)
    const t = await convertTabToCell(h.deps, [undefined, { groupId: 1, editorIndex: 1 }], { projectsDir: p.dir });
    assert.ok(t);
    assert.strictEqual(calls.quickPicks.length, 1, "only the options are asked");
    assert.strictEqual(calls.quickPicks[0].options.title, RUN_AS_CELL_TEXTS.optionsTitle);
    assert.strictEqual(calls.terminals[0].options.name, CELL_CMD_TEXTS.newCellTerminal);
    assert.strictEqual(calls.terminals[0].options.cwd, cwd);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--new-cell' '--mesh-reduced-isolation' '--' '--resume' '${SID}'\n`]);
    assert.ok(h.deps.terminals.has(t!));
    // The tab stays; closing it is offered and not done unasked.
    await flush();
    assert.deepStrictEqual(calls.infoPrompts, [{ message: CONVERT_TEXTS.started, items: [CONVERT_TEXTS.closeTab] }]);
    assert.deepStrictEqual(calls.closedTabs, []);
  });

  it("Close tab closes the converted tab", async () => {
    p.session(p.cwd("alpha"), SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    calls.pickQueue.push([0]);
    calls.nextInfoChoice = CONVERT_TEXTS.closeTab;
    assert.ok(await convertTabToCell(harness().deps, [], { projectsDir: p.dir }));
    await flush();
    assert.deepStrictEqual(calls.closedTabs, [tab]);
  });

  it("in a mesh: the mesh is asked first and passed as --mesh; no mesh chosen starts nothing", async () => {
    const cwd = p.cwd("alpha");
    p.session(cwd, SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    const h = harness();
    assert.strictEqual(await convertTabToCell(h.deps, [], { projectsDir: p.dir, pickMesh: async () => undefined }), undefined);
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(calls.quickPicks.length, 0);
    calls.pickQueue.push([0]);
    assert.ok(await convertTabToCell(h.deps, [], { projectsDir: p.dir, pickMesh: async () => MESH }));
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--new-cell' '--mesh' '${MESH}' '--mesh-reduced-isolation' '--' '--resume' '${SID}'\n`]);
  });

  it("reduced isolation is not waved through: without the stored consent its dialog is shown, and Cancel starts nothing", async () => {
    p.session(p.cwd("alpha"), SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    calls.pickQueue.push([0]);
    assert.strictEqual(await convertTabToCell(harness(fakeMemento()).deps, [], { projectsDir: p.dir }), undefined);
    assert.deepStrictEqual(calls.modals.map((m) => [m.kind, m.message, m.items]), [["warning", CELL_CMD_TEXTS.consentTitle, [CELL_CMD_TEXTS.consentAccept]]]);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.infoPrompts, []);
    // Keep my sign-in off: no flag, no consent dialog.
    calls.pickQueue.push([]);
    assert.ok(await convertTabToCell(harness(fakeMemento()).deps, [], { projectsDir: p.dir }));
    assert.strictEqual(calls.modals.length, 1);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--new-cell' '--' '--resume' '${SID}'\n`]);
  });

  it("a title that names no single session: the session is asked for, the matches first; Esc starts nothing", async () => {
    const a = p.cwd("alpha");
    const b = p.cwd("beta");
    p.session(a, SID, [{ type: "ai-title", aiTitle: "Same title" }]);
    p.session(b, SID2, [{ type: "ai-title", aiTitle: "Other" }]);
    p.session(b, SID3, [{ type: "ai-title", aiTitle: "Same title" }]);
    const tab = claudeTab("Same title");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    const h = harness();
    assert.strictEqual(await convertTabToCell(h.deps, [], { projectsDir: p.dir }), undefined);   // Esc
    const pick = calls.quickPicks[0];
    assert.strictEqual(pick.options.title, CONVERT_TEXTS.pickSessionTitle);
    assert.strictEqual(pick.options.placeHolder, CONVERT_TEXTS.pickSessionPlaceholder("Same title"));
    assert.deepStrictEqual(pick.items.map((i: any) => [i.label, i.session.sessionId]), [["Same title", SID3], ["Same title", SID], ["Other", SID2]]);
    assert.strictEqual(calls.terminals.length, 0);
    calls.pickQueue.push(1, [0]);
    assert.ok(await convertTabToCell(h.deps, [], { projectsDir: p.dir }));
    assert.strictEqual(calls.terminals[0].options.cwd, a);
    assert.match(calls.terminals[0].sent[0], new RegExp(`'--resume' '${SID}'\\n$`));
    // A tab with no title yet (a new chat): every session is offered, newest first.
    resetCalls();
    const fresh = claudeTab("Claude Code");
    calls.tabGroups = [{ tabs: [fresh], activeTab: fresh }];
    assert.strictEqual(await convertTabToCell(harness().deps, [], { projectsDir: p.dir }), undefined);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.session.sessionId), [SID3, SID2, SID]);
  });

  it("refusals: no Claude Code tab; no session on this computer; a session whose folder is gone", async () => {
    const h = harness();
    calls.tabGroups = [{ tabs: [fileTab("a.ts")], activeTab: fileTab("a.ts") }];
    assert.strictEqual(await convertTabToCell(h.deps, [], { projectsDir: p.dir }), undefined);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    assert.strictEqual(await convertTabToCell(h.deps, [], { projectsDir: p.dir }), undefined);
    const gone = p.cwd("gone");
    p.session(gone, SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    fs.rmSync(gone, { recursive: true, force: true });
    assert.strictEqual(await convertTabToCell(h.deps, [], { projectsDir: p.dir }), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [CONVERT_TEXTS.noTab, CONVERT_TEXTS.noSessions, CONVERT_TEXTS.notResumable]);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(h.runs, [], "the CLI is not run before the session is known");
  });

  it("several Claude Code tabs and no index: the tab is asked for by its label", async () => {
    p.session(p.cwd("alpha"), SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    p.session(p.cwd("beta"), SID2, [{ type: "ai-title", aiTitle: "Beta work" }]);
    const a = claudeTab("Alpha work");
    const b = claudeTab("Beta work");
    const f = fileTab("a.ts");
    calls.tabGroups = [{ tabs: [a, f, b], activeTab: f }];
    calls.pickQueue.push(1, [0]);
    assert.ok(await convertTabToCell(harness().deps, [], { projectsDir: p.dir }));
    assert.strictEqual(calls.quickPicks[0].options.placeHolder, CONVERT_TEXTS.pickTabPlaceholder);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.label), ["Alpha work", "Beta work"]);
    assert.match(calls.terminals[0].sent[0], new RegExp(`'--resume' '${SID2}'\\n$`));
  });
});

describe("Save session to a4sx, from a tab", () => {
  const ENTRY = "col-lib-0f1e2d3c4b5a";
  let p: ReturnType<typeof projects>;
  let file: string;
  beforeEach(() => {
    resetCalls();
    p = projects();
    file = p.session(p.cwd("alpha"), SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    p.session(p.cwd("beta"), SID2, [{ type: "ai-title", aiTitle: "Beta work" }]);   // newer: `push --latest` would save this one
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [fileTab("a.ts"), tab], activeTab: tab }];
  });
  afterEach(() => p.remove());

  it("`push <transcript> [--into ID] [--dry-run]`; an entry id the CLI doesn't take gives no command", () => {
    assert.deepStrictEqual(pushArgs("/t/s.jsonl"), ["push", "/t/s.jsonl"]);
    assert.deepStrictEqual(pushArgs("/t/s.jsonl", { into: ENTRY }), ["push", "/t/s.jsonl", "--into", ENTRY]);
    assert.deepStrictEqual(pushArgs("/t/s.jsonl", { preview: true }), ["push", "/t/s.jsonl", "--dry-run"]);
    assert.strictEqual(pushArgs("/t/s.jsonl", { into: "x; rm -rf ~" }), undefined);
    assert.strictEqual(pushArgs("/t/s.jsonl", { into: "" }), undefined);
  });

  it("a session that isn't in the library yet: a plain push of the tab's own transcript, not of the newest one", async () => {
    const slugs: string[] = [];
    const h = harness();
    const t = await saveTabSession(h.deps, [undefined, { groupId: 1, editorIndex: 1 }], { projectsDir: p.dir, saved: async (slug) => { slugs.push(slug); return []; } });
    assert.ok(t);
    assert.deepStrictEqual(slugs, ["0f1e2d3c4b5a"]);
    assert.strictEqual(calls.quickPicks.length, 0);
    assert.strictEqual(calls.terminals[0].options.name, SAVE_TAB_TEXTS.terminal);
    assert.strictEqual(calls.terminals[0].options.cwd, undefined);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}'\n`]);
    assert.strictEqual(path.basename(file), `${SID}.jsonl`);
    assert.deepStrictEqual(h.runs, [], "the extension runs nothing itself: the push runs in the terminal");
  });

  it("a session that is in the library once: the save is a new version of that entry (--into)", async () => {
    await saveTabSession(harness().deps, [], { projectsDir: p.dir, saved: async () => [{ id: ENTRY, label: "alpha" }] });
    assert.strictEqual(calls.quickPicks.length, 0);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}' '--into' '${ENTRY}'\n`]);
  });

  it("in the library more than once: the entry is asked for; the last row saves without --into; Esc saves nothing", async () => {
    const saved = async () => [{ id: ENTRY, title: "Alpha work" }, { id: "my-base", label: "my-base", title: "Squashed" }];
    assert.deepStrictEqual(entryPickItems(await saved()), [
      { label: "Alpha work", description: ENTRY, into: ENTRY },
      { label: "my-base", description: "Squashed · my-base", into: "my-base" },
      { label: SAVE_TAB_TEXTS.newEntry, detail: SAVE_TAB_TEXTS.newEntryDetail },
    ]);
    const h = harness();
    assert.strictEqual(await saveTabSession(h.deps, [], { projectsDir: p.dir, saved }), undefined);   // Esc
    assert.strictEqual(calls.quickPicks[0].options.title, SAVE_TAB_TEXTS.pickEntryTitle);
    assert.strictEqual(calls.terminals.length, 0);
    calls.pickQueue.push(1);
    await saveTabSession(h.deps, [], { projectsDir: p.dir, saved });
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}' '--into' 'my-base'\n`]);
    calls.pickQueue.push(2);
    await saveTabSession(h.deps, [], { projectsDir: p.dir, saved });
    assert.deepStrictEqual(calls.terminals[1].sent, [`'${CLI}' 'push' '${file}'\n`]);
  });

  it("the library can't be read, or names an id the CLI doesn't take: a plain push, or a refusal", async () => {
    const h = harness();
    await saveTabSession(h.deps, [], { projectsDir: p.dir, saved: async () => { throw new Error("offline"); } });
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}'\n`]);
    await saveTabSession(h.deps, [], { projectsDir: p.dir });   // no lookup at all
    assert.deepStrictEqual(calls.terminals[1].sent, [`'${CLI}' 'push' '${file}'\n`]);
    assert.strictEqual(await saveTabSession(h.deps, [], { projectsDir: p.dir, saved: async () => [{ id: "bad id" }] }), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [SAVE_TAB_TEXTS.badEntry]);
    assert.strictEqual(calls.terminals.length, 2);
  });

  it("the preview: --dry-run, in its own terminal, and the library isn't asked", async () => {
    let asked = 0;
    calls.shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    await saveTabSession(harness().deps, [], { projectsDir: p.dir, preview: true, saved: async () => { asked++; return [{ id: ENTRY }]; } });
    assert.strictEqual(asked, 0);
    assert.strictEqual(calls.terminals[0].options.name, SAVE_TAB_TEXTS.previewTerminal);
    assert.deepStrictEqual(calls.terminals[0].sent, [`& '${CLI}' 'push' '${file}' '--dry-run'\n`]);
  });

  it("a tab that names no single session: the session is asked for under this command's title; no CLI: nothing is started", async () => {
    const lone = claudeTab("Claude Code");
    calls.tabGroups = [{ tabs: [lone], activeTab: lone }];
    assert.strictEqual(await saveTabSession(harness().deps, [], { projectsDir: p.dir }), undefined);   // Esc
    assert.strictEqual(calls.quickPicks[0].options.title, SAVE_TAB_TEXTS.pickSessionTitle(SAVE_TAB_TEXTS.title));
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.session.sessionId), [SID2, SID]);
    calls.pickQueue.push(1);
    await saveTabSession(harness().deps, [], { projectsDir: p.dir });
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}'\n`]);
    // VS Code started inside an a4sx session: the CLI is never run.
    calls.pickQueue.push(1);
    assert.strictEqual(await saveTabSession(harness(undefined, { kind: "in-session" }).deps, [], { projectsDir: p.dir }), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [IN_SESSION_MESSAGE]);
    assert.strictEqual(calls.terminals.length, 1);
  });

  it("the library lookup: the entries that hold this session, by its slug; signed out or a failing server gives none", async () => {
    const rows = { sessions: [
      { id: ENTRY, title: "Alpha work", sessions: ["lib-0f1e2d3c4b5a"] },
      { id: "my-base", label: "my-base", sessions: ["lib-0f1e2d3c4b5a"] },
      { id: "col-lib-ffffffffffff", title: "Other" },
    ] };
    const saved = ext.runtime.fetch;
    try {
      ext.runtime.fetch = async () => ({ status: 200, json: async () => rows, headers: { get: () => null } }) as any;
      const lookup = ext.savedEntries({ token: async () => "tok" });
      assert.deepStrictEqual(await lookup("0f1e2d3c4b5a"), [{ id: ENTRY, label: undefined, title: "Alpha work" }, { id: "my-base", label: "my-base", title: undefined }]);
      assert.deepStrictEqual(await lookup("aaaaaaaaaaaa"), []);
      assert.deepStrictEqual(await ext.savedEntries({ token: async () => undefined })("0f1e2d3c4b5a"), []);
      ext.runtime.fetch = async () => ({ status: 500, json: async () => ({}), headers: { get: () => null } }) as any;
      assert.deepStrictEqual(await lookup("0f1e2d3c4b5a"), []);
      ext.runtime.fetch = async () => { throw new Error("offline"); };
      assert.deepStrictEqual(await lookup("0f1e2d3c4b5a"), []);
    } finally {
      ext.runtime.fetch = saved;
    }
  });
});

describe("Convert to cell: the mesh pick, manifest and wiring", () => {
  beforeEach(resetCalls);

  const meshes = { meshes: [
    { mesh_id: MESH, name: "Alpha team", role: "owner", status: "active" },
    { mesh_id: `msh_${"b".repeat(32)}`, role: "member", status: "active" },
    { mesh_id: `msh_${"0".repeat(32)}`, name: "Old project", role: "owner", status: "archived" },
    { mesh_id: `msh_${"9".repeat(32)}`, name: "Public directory", status: "active" },
  ], next_cursor: null };

  async function withFetch<T>(answer: () => { status: number; body?: unknown }, fn: () => Promise<T>): Promise<T> {
    const saved = ext.runtime.fetch;
    ext.runtime.fetch = async () => {
      const a = answer();
      return { status: a.status, json: async () => a.body, headers: { get: () => null } } as any;
    };
    try {
      return await fn();
    } finally {
      ext.runtime.fetch = saved;
    }
  }

  it("offers my active meshes by name (the id when a mesh has none) and resolves the chosen id", async () => {
    assert.deepStrictEqual(meshPickItems([{ id: MESH, name: "Alpha team" }, { id: "msh_x" }]), [
      { label: "Alpha team", description: MESH, id: MESH }, { label: "msh_x", id: "msh_x" },
    ]);
    calls.pickQueue.push(0);
    const id = await withFetch(() => ({ status: 200, body: meshes }), () => ext.pickMeshForCell({ token: async () => "tok" }));
    assert.strictEqual(id, MESH);
    assert.strictEqual(calls.quickPicks[0].options.title, CONVERT_TEXTS.meshTitle);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.label), ["Alpha team", `msh_${"b".repeat(32)}`], "archived meshes and meshes I'm not in are left out");
    assert.strictEqual(await withFetch(() => ({ status: 200, body: meshes }), () => ext.pickMeshForCell({ token: async () => "tok" })), undefined, "Esc");
  });

  it("signed out, or no active mesh: says so and resolves nothing", async () => {
    assert.strictEqual(await ext.pickMeshForCell({ token: async () => undefined }), undefined);
    assert.strictEqual(await withFetch(() => ({ status: 200, body: { meshes: [], next_cursor: null } }), () => ext.pickMeshForCell({ token: async () => "tok" })), undefined);
    assert.strictEqual(calls.errors.length, 2);
    assert.strictEqual(calls.errors[1].message, CONVERT_TEXTS.noMeshes);
    assert.strictEqual(calls.quickPicks.length, 0);
  });

  it("the tab commands are in a tab's context menu and the Command Palette, only while a Claude Code tab is active", () => {
    const claude = `activeWebviewPanelId == '${CLAUDE_PANEL}'`;
    const inMesh = `${claude} && a4sx.signedIn && a4sx.meshesAvailable`;
    const expected = [[ext.CMD_CONVERT_TAB, claude], [ext.CMD_CONVERT_TAB_IN_MESH, inMesh], [ext.CMD_SAVE_TAB, claude], [ext.CMD_PREVIEW_TAB_SAVE, claude]];
    assert.deepStrictEqual(pkg.contributes.menus["editor/title/context"].map((m: any) => [m.command, m.when]), expected);
    assert.deepStrictEqual(pkg.contributes.menus["editor/title/context"].map((m: any) => m.group), ["a4sx@1", "a4sx@2", "a4sx@3", "a4sx@4"]);
    const palette = pkg.contributes.menus.commandPalette.filter((m: any) => expected.some(([id]) => id === m.command));
    assert.deepStrictEqual(palette.map((m: any) => [m.command, m.when]), expected);
    const titles = Object.fromEntries(pkg.contributes.commands.map((c: any) => [c.command, c.title]));
    assert.strictEqual(titles[ext.CMD_CONVERT_TAB], "Convert to cell");
    assert.strictEqual(titles[ext.CMD_CONVERT_TAB_IN_MESH], "Convert to cell in mesh…");
    assert.strictEqual(titles[ext.CMD_SAVE_TAB], "Save session to a4sx");
    assert.strictEqual(titles[ext.CMD_PREVIEW_TAB_SAVE], "Preview save to a4sx (dry run)");
  });

  it("the registered commands run the conversion with the arguments VS Code passes", async () => {
    const ctx = { subscriptions: [] as { dispose(): unknown }[], secrets: fakeSecrets(), globalState: fakeMemento() };
    ext.activate(ctx as any);
    try {
      calls.tabGroups = [{ tabs: [fileTab("a.ts")], activeTab: fileTab("a.ts") }];
      assert.strictEqual(await calls.commands.get(ext.CMD_CONVERT_TAB)!(undefined, { groupId: 0, editorIndex: 0 }), undefined);
      assert.strictEqual(await calls.commands.get(ext.CMD_CONVERT_TAB_IN_MESH)!(), undefined);
      assert.strictEqual(await calls.commands.get(ext.CMD_SAVE_TAB)!(undefined, { groupId: 0, editorIndex: 0 }), undefined);
      assert.strictEqual(await calls.commands.get(ext.CMD_PREVIEW_TAB_SAVE)!(), undefined);
      assert.deepStrictEqual(calls.errors.map((e) => e.message), [CONVERT_TEXTS.noTab, CONVERT_TEXTS.noTab, CONVERT_TEXTS.noTab, CONVERT_TEXTS.noTab]);
    } finally {
      ctx.subscriptions.forEach((d) => d.dispose());
    }
  });
});
