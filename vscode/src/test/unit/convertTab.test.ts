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
import { cellNameProblem, changedText, CONVERT_TEXTS, convertTabToCell, MeshListing, meshPickItems, sessionDetail, sessionPickItems, suggestedCellName } from "../../convertTab";
import { projectDirName } from "../../nativeSeed";
import { RUN_AS_CELL_TEXTS } from "../../runAsCell";
import { entryPickItems, LibraryUnreadable, pushArgs, SAVE_TAB_TEXTS, saveTabSession } from "../../saveTab";
import {
  chooseClaudeTab, CLAUDE_PANEL, clickedKind, detectTabSession, editorIndexOf, firstPrompt, inWindowFolder, isClaudeTab, labelMatches, pickOrder, PROMPT_MAX, RecentSession, recentSessions,
  sessionsForLabel, slugOf, TAIL_BYTES, transcriptEntrypoint, transcriptLastPrompt, transcriptTitle, transcriptTitles, VSCODE_ENTRYPOINT, windowFolderNames,
} from "../../tabSession";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../../package.json");

const BASE = "https://session-exchange.com";
const CLI = "/opt/a4sx bin/a4sx";
const MESH = `msh_${"a".repeat(32)}`;
const SID = "0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b";
const SID2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SID3 = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const SID4 = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";

const claudeTab = (label: string) => ({ label, input: { viewType: `mainThreadWebview-${CLAUDE_PANEL}` } });
const fileTab = (label: string) => ({ label, input: { uri: { scheme: "file", fsPath: `/w/${label}` } } });
const out = (stdout: unknown, code = 0): CliOutput => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const flush = async (n = 6) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); } };

function harness(state = fakeMemento({ [CONSENT_KEY]: [machineKey()] }), resolution: CliResolution = { kind: "found", path: CLI }, cells: unknown[] = []): { deps: CellCommandDeps; runs: string[] } {
  const runs: string[] = [];
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    const key = args.join(" ");
    runs.push(key);
    return key === "--version" ? out("a4sx 0.25.0  (server 0.718.0)") : key === "mesh cells --json" ? out({ v: 1, default: null, cells }) : out("");
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

  it("the resource VS Code passes for the clicked tab tells whether it is a Claude Code tab", () => {
    const uuid = "3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
    const wv = (name: string) => ({ scheme: "webview-panel", path: `/webview-panel/${name}` });
    assert.strictEqual(clickedKind([wv(`webview-${CLAUDE_PANEL}-${uuid}`), { editorIndex: 0 }]), "claude");
    assert.strictEqual(clickedKind([wv(`webview-${uuid}`)]), "webview", "VS Code before 1.106 names no view type");
    assert.strictEqual(clickedKind([wv(`webview-markdown.preview-${uuid}`)]), "other");
    assert.strictEqual(clickedKind([wv(`webview-${CLAUDE_PANEL}Other-${uuid}`)]), "other");
    assert.strictEqual(clickedKind([{ scheme: "file", path: "/w/a.ts" }]), "other");
    assert.strictEqual(clickedKind([undefined, { editorIndex: 0 }]), undefined);
    assert.strictEqual(clickedKind([]), undefined);
    assert.strictEqual(clickedKind(["webview-panel"]), undefined);
  });

  it("from a context menu with one group: the tab at that index; a non-Claude tab there is refused", () => {
    const a = claudeTab("A");
    const g = { tabs: [fileTab("x.ts"), a], activeTab: a };
    assert.deepStrictEqual(chooseClaudeTab([g], g, 1), { kind: "one", tab: a });
    assert.deepStrictEqual(chooseClaudeTab([g], g, 0), { kind: "notClaude" }, "the file tab was clicked while the Claude tab is active");
    // The index names no tab (the tabs moved meanwhile): every Claude tab is offered.
    assert.deepStrictEqual(chooseClaudeTab([g], g, 7), { kind: "ask", tabs: [a] });
  });

  it("split editors: a Claude tab clicked in the inactive group is never taken for the active group's tab at that index", () => {
    const a = claudeTab("A");
    const b = claudeTab("B");
    const active = { tabs: [fileTab("x.ts"), a], activeTab: a };
    const other = { tabs: [fileTab("y.ts"), b], activeTab: b };
    // Without a resource (or VS Code before 1.106): both groups have a Claude tab at index 1, so the user chooses.
    assert.deepStrictEqual(chooseClaudeTab([active, other], active, 1), { kind: "ask", tabs: [a, b] });
    assert.deepStrictEqual(chooseClaudeTab([active, other], active, 1, "webview"), { kind: "ask", tabs: [a, b] });
    assert.deepStrictEqual(chooseClaudeTab([active, other], active, 1, "claude"), { kind: "ask", tabs: [a, b] });
    // Only the inactive group has a Claude tab at the index, and the resource says a Claude tab was clicked: that one.
    const active2 = { tabs: [a, fileTab("x.ts")], activeTab: a };
    assert.deepStrictEqual(chooseClaudeTab([active2, other], active2, 1, "claude"), { kind: "one", tab: b });
    // The same without a resource: the clicked tab could be the active group's file tab, so the user confirms.
    assert.deepStrictEqual(chooseClaudeTab([active2, other], active2, 1), { kind: "ask", tabs: [b] });
  });

  it("split editors: a non-Claude tab clicked while a Claude tab is active acts on no Claude tab", () => {
    const a = claudeTab("A");
    const b = claudeTab("B");
    const active = { tabs: [a, fileTab("x.ts")], activeTab: a };
    const other = { tabs: [b, fileTab("y.ts")], activeTab: b };
    // The file tab at index 1 of either group, by its resource.
    assert.deepStrictEqual(chooseClaudeTab([active, other], active, 1, "other"), { kind: "notClaude" });
    assert.deepStrictEqual(chooseClaudeTab([active, other], active, undefined, "other"), { kind: "notClaude" });
    // Without a resource the index names only file tabs: refused, not "the only Claude tab".
    assert.deepStrictEqual(chooseClaudeTab([active, other], active, 1), { kind: "notClaude" });
    // Another extension's webview, VS Code before 1.106: only webview tabs fit, and the one at index 1 isn't Claude's.
    const preview = { label: "Preview", input: { viewType: "mainThreadWebview-markdown.preview" } };
    const g = { tabs: [a, preview], activeTab: a };
    assert.deepStrictEqual(chooseClaudeTab([g, other], g, 1, "webview"), { kind: "notClaude" });
  });

  it("from the Command Palette: the active tab; else the only Claude tab; several are offered; none is none", () => {
    const a = claudeTab("A");
    const b = claudeTab("B");
    const f = fileTab("x.ts");
    assert.deepStrictEqual(chooseClaudeTab([{ tabs: [f, a, b], activeTab: b }], { tabs: [f, a, b], activeTab: b }, undefined), { kind: "one", tab: b });
    assert.deepStrictEqual(chooseClaudeTab([{ tabs: [f, a], activeTab: f }], { tabs: [f, a], activeTab: f }, undefined), { kind: "one", tab: a });
    assert.deepStrictEqual(chooseClaudeTab([{ tabs: [f, a, b], activeTab: f }], { tabs: [f, a, b], activeTab: f }, undefined), { kind: "ask", tabs: [a, b] });
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

  it("the first prompt: the first user record the user typed, cleaned and shortened; meta, tool results and command wrappers are skipped", () => {
    const u = (content: unknown, extra: Record<string, unknown> = {}) => line({ type: "user", message: { role: "user", content }, ...extra });
    const head = [
      line({ type: "summary", summary: "x" }),
      u("ignored, meta", { isMeta: true }),
      u("<command-name>/clear</command-name>"),
      u([{ type: "tool_result", content: "out" }]),
      u(""),
      u([{ type: "text", text: "Fix the\u001b[31m login\u009b bug\n\nplease" }]),
      u("later prompt"),
    ].join("\n");
    assert.strictEqual(firstPrompt(head), "Fix the [31m login bug please");
    assert.strictEqual(firstPrompt(u("y".repeat(500))), `${"y".repeat(PROMPT_MAX - 1)}…`);
    assert.strictEqual(Array.from(firstPrompt(u("😀".repeat(300)))!).length, PROMPT_MAX, "shortened by characters, not UTF-16 units");
    assert.strictEqual(firstPrompt(line({ type: "assistant", message: { role: "assistant", content: "user" } })), undefined);
    assert.strictEqual(firstPrompt(`{"type":"user","message":{"role":"user","content":"cut`), undefined);
    assert.strictEqual(firstPrompt(""), undefined);
  });

  it("the session pick shows title, folder, last change, the id's start and the first prompt; the slug is the id's first 12 letters and digits", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    const rows = sessionPickItems([
      { sessionId: SID, folder: "-w-proj", file: "", mtime: now - 20_000, title: "Alpha work", firstPrompt: "Fix the login bug" },
      { sessionId: SID2, folder: "-w-other", file: "", mtime: now - 5 * 60_000 },
      { sessionId: SID3, folder: "-w-old", file: "", mtime: now - 3 * 3_600_000, title: "Older" },
      { sessionId: SID3, folder: "-w-old", file: "", mtime: now - 5 * 86_400_000, title: "Oldest" },
    ], now);
    const at = (ms: number) => changedText(now - ms, now);
    assert.deepStrictEqual(rows.map((r) => [r.label, r.description, r.detail]), [
      ["Alpha work", `-w-proj · ${at(20_000)} · 0f1e2d3c`, "\"Fix the login bug\""],
      [CONVERT_TEXTS.untitled, `-w-other · ${at(5 * 60_000)} · 1a2b3c4d`, `First prompt: ${CONVERT_TEXTS.noPrompt}`],
      ["Older", `-w-old · ${at(3 * 3_600_000)} · 2b3c4d5e`, `First prompt: ${CONVERT_TEXTS.noPrompt}`],
      ["Oldest", `-w-old · ${at(5 * 86_400_000)} · 2b3c4d5e`, `First prompt: ${CONVERT_TEXTS.noPrompt}`],
    ]);
    assert.match(at(20_000), /^\d{4}-\d\d-\d\d \d\d:\d\d, just now$/);
    assert.match(at(5 * 86_400_000), /, 5 d ago$/);
    assert.strictEqual(slugOf(SID), "0f1e2d3c4b5a");
  });
});

describe("Convert to cell: which session a tab shows (0.9.1)", () => {
  const W = "/w/proj";
  const ctx = { window: windowFolderNames([W]), platform: "linux" as const };
  const rs = (id: string, folder: string, more: Partial<RecentSession> = {}): RecentSession => ({ sessionId: id, folder, file: `/p/${folder}/${id}.jsonl`, mtime: 0, ...more });
  // Claude Code 2.1.x's own tab label rule (its webview): the summary, cut to 24 characters plus "…" when longer than 25.
  const tabLabel = (summary?: string) => (!summary ? "Claude Code" : summary.length > 25 ? `${summary.substring(0, 24)}…` : summary);
  const here = projectDirName(W);

  it("a unique title: that session, with no question; a label cut by Claude Code's rule matches its title", () => {
    const long = "Refactor the cells view and its refresh logic";
    const list = [rs(SID, here, { title: long }), rs(SID2, "-elsewhere", { title: "Beta work" })];
    assert.strictEqual(tabLabel(long), "Refactor the cells view …");
    assert.deepStrictEqual(detectTabSession(tabLabel(long), list, ctx), { kind: "one", session: list[0], how: "title" });
    assert.deepStrictEqual(detectTabSession("Beta work", list, ctx), { kind: "one", session: list[1], how: "title" });
  });

  it("the tab keeps the first generated title it got: a title the session had before matches too", () => {
    const list = [rs(SID, here, { title: "Renamed later", earlierTitles: ["First generated title"] }), rs(SID2, here, { title: "Other" })];
    assert.deepStrictEqual(detectTabSession("First generated title", list, ctx), { kind: "one", session: list[0], how: "earlierTitle" });
    // Another session whose title is that label: both count, so it is asked.
    const both = [...list, rs(SID3, here, { title: "First generated title" })];
    assert.deepStrictEqual(detectTabSession("First generated title", both, ctx), { kind: "ask", why: "duplicate", matches: [list[0], both[2]] });
  });

  it("before any title the label is the prompt: matched among the sessions with no title", () => {
    const prompt = "please fix the failing login test in ci";
    const list = [rs(SID, here, { firstPrompt: prompt }), rs(SID2, here, { title: "please fix the failing login test", firstPrompt: prompt })];
    assert.deepStrictEqual(detectTabSession(tabLabel(prompt), list, ctx), { kind: "one", session: list[1], how: "title" }, "a title wins over a prompt");
    assert.deepStrictEqual(detectTabSession(tabLabel(prompt), [list[0]], ctx), { kind: "one", session: list[0], how: "prompt" });
    assert.deepStrictEqual(detectTabSession(tabLabel("later prompt here"), [rs(SID, here, { lastPrompt: "later prompt here" })], ctx).kind, "one");
  });

  it("the default label (\"Claude Code\") names no session: always asked", () => {
    const list = [rs(SID, here, { title: "Claude Code" })];
    assert.deepStrictEqual(detectTabSession("Claude Code", list, ctx), { kind: "ask", why: "defaultTitle", matches: [] });
    assert.deepStrictEqual(detectTabSession("Nothing like it", list, ctx), { kind: "ask", why: "noMatch", matches: [] });
  });

  it("same-title duplicates: one in this window's folder (or its .claude/worktrees) wins over copies elsewhere", () => {
    const wt = projectDirName(path.join(W, ".claude", "worktrees", "fix-1"));
    const list = [rs(SID2, "-root-cells-copy", { title: "Same" }), rs(SID, here, { title: "Same" })];
    assert.deepStrictEqual(detectTabSession("Same", list, ctx), { kind: "one", session: list[1], how: "title" });
    const inWt = [rs(SID2, "-root-cells-copy", { title: "Same" }), rs(SID3, wt, { title: "Same" })];
    assert.deepStrictEqual(detectTabSession("Same", inWt, ctx), { kind: "one", session: inWt[1], how: "title" });
    // Without workspace folders nothing narrows: asked, newest first.
    assert.deepStrictEqual(detectTabSession("Same", list, {}), { kind: "ask", why: "duplicate", matches: list });
    // A sibling folder that only starts like the window's is not the window's.
    assert.strictEqual(inWindowFolder(`${here}-other`, ctx.window, "linux"), false);
    assert.strictEqual(inWindowFolder(here.toUpperCase(), ctx.window, "win32"), true, "Windows folders compare without case");
    assert.strictEqual(inWindowFolder(here.toUpperCase(), ctx.window, "linux"), false);
  });

  it("matches in the window's folder: one another open tab names alone by its current title is that tab's; else asked", () => {
    const a = rs(SID, here, { title: "Refactor the cells view and more" });
    const b = rs(SID2, here, { title: "Refactor the cells view 2" });
    const label = tabLabel(a.title);
    assert.strictEqual(label, "Refactor the cells view …");
    assert.deepStrictEqual(detectTabSession(label, [a, b], ctx), { kind: "ask", why: "duplicate", matches: [a, b] });
    assert.deepStrictEqual(detectTabSession(label, [a, b], { ...ctx, otherLabels: [b.title!] }), { kind: "one", session: a, how: "title" });
    // Two tabs with the same label tell nothing apart, nor does a fresh tab.
    const same = [rs(SID, here, { title: "Same" }), rs(SID2, here, { title: "Same" })];
    assert.deepStrictEqual(detectTabSession("Same", same, { ...ctx, otherLabels: ["Same", "Claude Code"] }), { kind: "ask", why: "duplicate", matches: same });
  });

  it("conflicting evidence is asked, never resolved to a session the rules rule out", () => {
    // The window's session A, its copy B in a cell's folder; another tab's label is A's EARLIER title: no claim, A wins.
    const a = rs(SID, here, { title: "Fix the login bug", earlierTitles: ["Login work"] });
    const b = rs(SID2, "-root-cells-copy", { title: "Fix the login bug" });
    assert.deepStrictEqual(detectTabSession("Fix the login bug", [b, a], { ...ctx, otherLabels: ["Login work"] }), { kind: "one", session: a, how: "title" });
    // Other tabs name every in-window match by its current title (stale or unscanned evidence): never the copy
    // outside the window, which the window rule ruled out; the user picks, the window's first.
    const a2 = rs(SID, here, { title: "Fix the login bug in the cells view" });
    const b2 = rs(SID2, "-root-cells-copy", { title: "Fix the login bug in the cells view" });
    const c2 = rs(SID3, here, { title: "Fix the login bug in the" });
    const label = tabLabel(a2.title);
    assert.deepStrictEqual(detectTabSession(label, [b2, a2, c2], { ...ctx, otherLabels: [c2.title!, "Fix the login bug in the cells view"] }).kind, "ask");
    const d = detectTabSession(label, [b2, a2], { ...ctx, otherLabels: ["Fix the login bug in the cells view"] });
    assert.deepStrictEqual(d, { kind: "ask", why: "duplicate", matches: [a2, b2] });
  });

  it("the pick order: the matches, then this window's sessions, then Claude Code for VS Code's, then the rest", () => {
    const a = rs("a", "-else", {});
    const b = rs("b", here, {});
    const c = rs("c", "-else", { entrypoint: VSCODE_ENTRYPOINT });
    const d = rs("d", here, { entrypoint: VSCODE_ENTRYPOINT });
    const m = rs("m", "-else", {});
    assert.deepStrictEqual(pickOrder([a, b, c, m, d], [m], ctx).map((s) => s.sessionId), ["m", "d", "b", "c", "a"]);
  });

  it("the end of a transcript: every title newest first, the last prompt, the newest entrypoint", () => {
    const l = (r: Record<string, unknown>) => JSON.stringify(r);
    const tail = [
      l({ type: "ai-title", aiTitle: "One" }), l({ type: "user", entrypoint: "cli", message: { role: "user", content: "x" } }),
      l({ type: "ai-title", aiTitle: "Two" }), l({ type: "last-prompt", lastPrompt: "  the\nlast one " }), l({ type: "ai-title", aiTitle: "Two" }),
      l({ type: "assistant", entrypoint: "claude-vscode" }),
    ].join("\n");
    assert.deepStrictEqual(transcriptTitles(tail), ["Two", "One"]);
    assert.strictEqual(transcriptLastPrompt(tail), "the last one");
    assert.strictEqual(transcriptEntrypoint(tail), "claude-vscode");
    assert.strictEqual(transcriptEntrypoint(l({ type: "user", entrypoint: "bad value!" })), undefined);
    assert.strictEqual(transcriptLastPrompt(""), undefined);
  });

  it("reads the window's older transcripts too, beyond the newest of all", async () => {
    const p = projects();
    try {
      const w = p.cwd("work");
      p.session(w, SID, [{ type: "ai-title", aiTitle: "Idle tab" }, { type: "ai-title", aiTitle: "Idle tab, renamed" }]);
      for (const id of [SID2, SID3, SID4]) {
        p.session(p.cwd(`cell-${id.slice(0, 4)}`), id, [{ type: "ai-title", aiTitle: "busy cell" }, { type: "user", entrypoint: "sdk-cli" }]);
      }
      assert.deepStrictEqual((await recentSessions(p.dir, 2)).map((s) => s.sessionId), [SID4, SID3], "the newest two of all");
      const list = await recentSessions(p.dir, 2, windowFolderNames([w]));
      assert.deepStrictEqual(list.map((s) => s.sessionId), [SID4, SID3, SID]);
      assert.deepStrictEqual([list[2].title, list[2].earlierTitles, list[0].entrypoint], ["Idle tab, renamed", ["Idle tab"], "sdk-cli"]);
      assert.deepStrictEqual(detectTabSession("Idle tab", list, { window: windowFolderNames([w]) }).kind, "one");
    } finally {
      p.remove();
    }
  });
});

describe("Convert to cell: the command", () => {
  let p: ReturnType<typeof projects>;
  beforeEach(() => {
    resetCalls();
    p = projects();
  });
  afterEach(() => p.remove());

  const MESH2 = `msh_${"b".repeat(32)}`;
  const listing = async (): Promise<MeshListing> => ({ kind: "ok", meshes: [{ id: MESH, name: "Alpha team", role: "owner", members: "3" }, { id: MESH2, role: "member", members: "2-5" }] });
  const labels = () => calls.quickPicks.map((q) => q.options.title);
  const AID = SID.slice(0, 8);

  it("`launch --new-cell` takes an optional name and mesh; a mesh id or a name the CLI doesn't take gives no command", () => {
    const o = { reduced: true, autoAllow: false };
    assert.deepStrictEqual(newCellRunArgs(o, { kind: "local", sessionId: SID }), ["launch", "--new-cell", "--mesh-reduced-isolation", "--", "--resume", SID]);
    assert.deepStrictEqual(newCellRunArgs(o, { kind: "local", sessionId: SID }, MESH), ["launch", "--new-cell", "--mesh", MESH, "--mesh-reduced-isolation", "--", "--resume", SID]);
    assert.deepStrictEqual(newCellRunArgs(o, { kind: "local", sessionId: SID }, MESH, "alpha-work"), ["launch", "--new-cell", "--as", "alpha-work", "--mesh", MESH, "--mesh-reduced-isolation", "--", "--resume", SID]);
    assert.strictEqual(newCellRunArgs(o, { kind: "local", sessionId: SID }, "msh_x; rm -rf ~"), undefined);
    assert.strictEqual(newCellRunArgs(o, { kind: "local", sessionId: "not-an-id" }, MESH), undefined);
    for (const bad of ["", "Alpha", "-a", "a-", "a b", "a;rm", "$(x)", "a".repeat(49), "--mesh"]) {
      assert.strictEqual(newCellRunArgs(o, { kind: "local", sessionId: SID }, MESH, bad), undefined, bad);
    }
  });

  it("a tab whose title names one session: no session question and no confirm; the mesh pick names the session, then the name, then the start", async () => {
    const cwd = p.cwd("alpha");
    p.session(cwd, SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    p.session(p.cwd("beta"), SID2, [{ type: "ai-title", aiTitle: "Beta work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [fileTab("a.ts"), tab], activeTab: tab }];
    const h = harness();
    calls.pickQueue.push(0, [0]);   // the first mesh; the options as offered (Keep my sign-in on)
    calls.inputQueue.push("alpha-work");
    const t = await convertTabToCell(h.deps, [undefined, { groupId: 1, editorIndex: 1 }], { projectsDir: p.dir, listMeshes: listing });
    assert.ok(t);
    assert.deepStrictEqual(calls.modals, [], "no confirm dialog");
    assert.deepStrictEqual(labels(), [CONVERT_TEXTS.meshTitle("Alpha work", AID), RUN_AS_CELL_TEXTS.optionsTitle]);
    const mesh = calls.quickPicks[0];
    assert.match(mesh.options.placeHolder, new RegExp(`^Session ${SID.slice(0, 8)} in .*alpha, changed .*\\. Choose the mesh for the new cell$`));
    assert.deepStrictEqual(mesh.items.map((i: any) => [i.label, i.description]), [
      ["$(type-hierarchy) Alpha team", "owner · 3 members"], [`$(type-hierarchy) ${MESH2}`, "member · 2-5 members"],
      [CONVERT_TEXTS.meshInBrowser, undefined], [CONVERT_TEXTS.chooseAnotherSession, undefined],
    ]);
    // The name box: prefilled from the title, with the empty-for-a-suggestion hint, never the host name.
    assert.strictEqual(calls.inputs.length, 1);
    assert.strictEqual(calls.inputs[0].title, CONVERT_TEXTS.nameTitle("Alpha team"));
    assert.strictEqual(calls.inputs[0].value, "alpha-work");
    assert.match(calls.inputs[0].prompt, /Leave it empty for a suggested name \(two random words\)/);
    assert.notStrictEqual(calls.inputs[0].value, os.hostname().toLowerCase());
    assert.strictEqual(calls.terminals[0].options.name, CELL_CMD_TEXTS.newCellTerminal);
    assert.strictEqual(calls.terminals[0].options.cwd, cwd);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--new-cell' '--as' 'alpha-work' '--mesh' '${MESH}' '--mesh-reduced-isolation' '--' '--resume' '${SID}'\n`]);
    assert.ok(h.deps.terminals.has(t!));
    // The tab stays; closing it is offered and not done unasked.
    await flush();
    assert.deepStrictEqual(calls.infoPrompts, [{ message: CONVERT_TEXTS.started, items: [CONVERT_TEXTS.closeTab] }]);
    assert.deepStrictEqual(calls.closedTabs, []);
  });

  it("an empty name gives no --as (the server proposes two words); the browser row gives no --mesh", async () => {
    p.session(p.cwd("alpha"), SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    calls.pickQueue.push(2, [0]);   // Choose the mesh in the browser
    calls.inputQueue.push("  ");
    assert.ok(await convertTabToCell(harness().deps, [], { projectsDir: p.dir, listMeshes: listing }));
    assert.strictEqual(calls.inputs[0].title, CONVERT_TEXTS.nameTitle(undefined));
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--new-cell' '--mesh-reduced-isolation' '--' '--resume' '${SID}'\n`]);
  });

  it("the name box checks the name: empty is fine, a bad name or a name stored here is refused with the rule", () => {
    const taken = new Set(["build"]);
    assert.strictEqual(cellNameProblem("", taken), undefined);
    assert.strictEqual(cellNameProblem("  ", taken), undefined);
    assert.strictEqual(cellNameProblem("alpha-2", taken), undefined);
    assert.strictEqual(cellNameProblem("Alpha", taken), CONVERT_TEXTS.nameRule);
    assert.strictEqual(cellNameProblem("a b", taken), CONVERT_TEXTS.nameRule);
    assert.strictEqual(cellNameProblem("$(rm)", taken), CONVERT_TEXTS.nameRule);
    assert.strictEqual(cellNameProblem("build", taken), CONVERT_TEXTS.nameTaken("build"));
    // The suggestion: the title's first words in the CLI's form, made free; "" when the title gives none.
    assert.strictEqual(suggestedCellName("Alpha work", new Set()), "alpha-work");
    assert.strictEqual(suggestedCellName("Fix the Login-redirect bug in prod now", new Set()), "fix-the-login-redirect");
    assert.strictEqual(suggestedCellName("Café über naïve", new Set()), "cafe-uber-naive");
    assert.strictEqual(suggestedCellName("alpha work", new Set(["alpha-work", "alpha-work-2"])), "alpha-work-3");
    assert.strictEqual(suggestedCellName("„…“ ✓", new Set()), "");
    assert.strictEqual(suggestedCellName(undefined, new Set()), "");
    assert.strictEqual(suggestedCellName("x".repeat(60), new Set()), "", "one word over 32 characters gives none");
  });

  it("a name a cell stored here already has: says so before the options, and starts nothing", async () => {
    p.session(p.cwd("alpha"), SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    const cells = [{ mesh_id: MESH, mesh_name: "Alpha team", name: "alpha-work", instance_id: "ins_A1", created: "2026-11-01T10:00:00Z", standalone: false, default: true, needs_approval: false, duplicate: false }];
    calls.pickQueue.push(0);
    calls.inputQueue.push("alpha-work");   // the Cells view hadn't read the list yet, so the box let it through
    assert.strictEqual(await convertTabToCell(harness(undefined, undefined, cells).deps, [], { projectsDir: p.dir, listMeshes: listing }), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [RUN_AS_CELL_TEXTS.nameTaken("alpha-work")]);
    assert.strictEqual(calls.quickPicks.length, 1, "no options asked");
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("Esc on the mesh pick or on the name box starts nothing and runs no CLI", async () => {
    p.session(p.cwd("alpha"), SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    const h = harness();
    assert.strictEqual(await convertTabToCell(h.deps, [], { projectsDir: p.dir, listMeshes: listing }), undefined);
    calls.pickQueue.push(0);
    assert.strictEqual(await convertTabToCell(h.deps, [], { projectsDir: p.dir, listMeshes: listing }), undefined);   // Esc on the name
    assert.strictEqual(calls.inputs.length, 1);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(h.runs, []);
  });

  it("signed out, or the meshes can't be read: the pick says so and still offers the browser approval", async () => {
    const rows = (l: MeshListing) => meshPickItems(l).map((i: any) => [i.label, i.kind]);
    assert.deepStrictEqual(rows({ kind: "signedOut" }), [[CONVERT_TEXTS.meshSignedOut, -1], [CONVERT_TEXTS.meshInBrowser, undefined], [CONVERT_TEXTS.chooseAnotherSession, undefined]]);
    assert.deepStrictEqual(rows({ kind: "error", message: "Can't reach a4sx" }), [["Can't reach a4sx", -1], [CONVERT_TEXTS.meshInBrowser, undefined], [CONVERT_TEXTS.chooseAnotherSession, undefined]]);
    assert.deepStrictEqual(rows({ kind: "ok", meshes: [] }), [[CONVERT_TEXTS.meshNone, -1], [CONVERT_TEXTS.meshInBrowser, undefined], [CONVERT_TEXTS.chooseAnotherSession, undefined]]);
    p.session(p.cwd("alpha"), SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    calls.pickQueue.push(0);   // the separator row is no choice: nothing starts
    assert.strictEqual(await convertTabToCell(harness().deps, [], { projectsDir: p.dir, listMeshes: async () => { throw new Error("offline"); } }), undefined);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.label), ["offline", CONVERT_TEXTS.meshInBrowser, CONVERT_TEXTS.chooseAnotherSession]);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("Not this session? on the mesh pick: the session pick, then the mesh pick again names the chosen one", async () => {
    const a = p.cwd("alpha");
    p.session(a, SID, [{ type: "ai-title", aiTitle: "Other work" }]);
    p.session(p.cwd("beta"), SID2, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    calls.pickQueue.push(3, 1, 0, [0]);   // Not this session?; the second row (Other work); the first mesh; options
    calls.inputQueue.push("");
    assert.ok(await convertTabToCell(harness().deps, [], { projectsDir: p.dir, listMeshes: listing }));
    assert.deepStrictEqual(labels(), [CONVERT_TEXTS.meshTitle("Alpha work", SID2.slice(0, 8)), CONVERT_TEXTS.pickSessionTitle, CONVERT_TEXTS.meshTitle("Other work", SID.slice(0, 8)), RUN_AS_CELL_TEXTS.optionsTitle]);
    assert.strictEqual(calls.terminals[0].options.cwd, a);
    assert.match(calls.terminals[0].sent[0], new RegExp(`'--resume' '${SID}'\\n$`));
  });

  it("Close tab closes the converted tab", async () => {
    p.session(p.cwd("alpha"), SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    calls.pickQueue.push(0, [0]);
    calls.inputQueue.push("");
    calls.nextInfoChoice = CONVERT_TEXTS.closeTab;
    assert.ok(await convertTabToCell(harness().deps, [], { projectsDir: p.dir, listMeshes: listing }));
    await flush();
    assert.deepStrictEqual(calls.closedTabs, [tab]);
  });

  it("reduced isolation is not waved through: without the stored consent its dialog is shown, and Cancel starts nothing", async () => {
    p.session(p.cwd("alpha"), SID, [{ type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    calls.pickQueue.push(2, [0]);
    calls.inputQueue.push("");
    assert.strictEqual(await convertTabToCell(harness(fakeMemento()).deps, [], { projectsDir: p.dir, listMeshes: listing }), undefined);
    assert.deepStrictEqual(calls.modals.map((m) => [m.kind, m.message, m.items]), [["warning", CELL_CMD_TEXTS.consentTitle, [CELL_CMD_TEXTS.consentAccept]]]);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.infoPrompts, []);
    // Keep my sign-in off: no flag, no consent dialog.
    calls.pickQueue.push(2, []);
    calls.inputQueue.push("");
    assert.ok(await convertTabToCell(harness(fakeMemento()).deps, [], { projectsDir: p.dir, listMeshes: listing }));
    assert.strictEqual(calls.modals.length, 1);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--new-cell' '--' '--resume' '${SID}'\n`]);
  });

  it("two sessions with the tab's title that nothing tells apart: the session is asked for, the matches first; Esc starts nothing", async () => {
    const a = p.cwd("alpha");
    const b = p.cwd("beta");
    p.session(a, SID, [{ type: "ai-title", aiTitle: "Same title" }]);
    p.session(b, SID2, [{ type: "ai-title", aiTitle: "Other" }]);
    p.session(b, SID3, [{ type: "ai-title", aiTitle: "Same title" }]);
    const tab = claudeTab("Same title");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    const h = harness();
    assert.strictEqual(await convertTabToCell(h.deps, [], { projectsDir: p.dir, listMeshes: listing }), undefined);   // Esc
    const pick = calls.quickPicks[0];
    assert.strictEqual(pick.options.title, CONVERT_TEXTS.pickSessionTitle);
    assert.strictEqual(pick.options.placeHolder, CONVERT_TEXTS.pickDuplicatePlaceholder("Same title", 2));
    assert.deepStrictEqual(pick.items.map((i: any) => [i.label, i.session.sessionId]), [["Same title", SID3], ["Same title", SID], ["Other", SID2]]);
    assert.strictEqual(calls.terminals.length, 0);
    calls.pickQueue.push(1, 0, [0]);
    calls.inputQueue.push("");
    assert.ok(await convertTabToCell(h.deps, [], { projectsDir: p.dir, listMeshes: listing }));
    assert.strictEqual(calls.terminals[0].options.cwd, a);
    assert.match(calls.terminals[0].sent[0], new RegExp(`'--resume' '${SID}'\\n$`));
  });

  it("the same title in this window's folder and in another one: the window's, with no question", async () => {
    const w = p.cwd("work");
    const elsewhere = p.cwd("cells-copy");
    p.session(w, SID, [{ type: "ai-title", aiTitle: "Same title" }]);
    p.session(elsewhere, SID2, [{ type: "ai-title", aiTitle: "Same title" }]);   // newer: a copy in a cell's folder
    calls.workspaceFolders = [{ name: "work", uri: { scheme: "file", fsPath: w } }];
    const tab = claudeTab("Same title");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    calls.pickQueue.push(2, [0]);
    calls.inputQueue.push("");
    assert.ok(await convertTabToCell(harness().deps, [], { projectsDir: p.dir, listMeshes: listing }));
    assert.strictEqual(calls.quickPicks[0].options.title, CONVERT_TEXTS.meshTitle("Same title", SID.slice(0, 8)));
    assert.match(calls.terminals[0].sent[0], new RegExp(`'--resume' '${SID}'\\n$`));
  });

  it("a tab with no title yet (\"Claude Code\"): always asked, this window's sessions first", async () => {
    const w = p.cwd("work");
    p.session(w, SID, [{ type: "ai-title", aiTitle: "Mine" }]);
    p.session(p.cwd("else"), SID2, [{ type: "ai-title", aiTitle: "Elsewhere" }]);
    calls.workspaceFolders = [{ name: "work", uri: { scheme: "file", fsPath: w } }];
    const fresh = claudeTab("Claude Code");
    calls.tabGroups = [{ tabs: [fresh], activeTab: fresh }];
    assert.strictEqual(await convertTabToCell(harness().deps, [], { projectsDir: p.dir, listMeshes: listing }), undefined);
    assert.strictEqual(calls.quickPicks[0].options.placeHolder, CONVERT_TEXTS.pickDefaultPlaceholder);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.session.sessionId), [SID, SID2]);
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
    calls.pickQueue.push(1);   // without a mesh lister: the browser row is the second
    calls.inputQueue.push("");
    assert.strictEqual(await convertTabToCell(h.deps, [], { projectsDir: p.dir }), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [CONVERT_TEXTS.noTab, CONVERT_TEXTS.noSessions, CONVERT_TEXTS.notResumable]);
    // The refusal names the cause, the consequence and the next step.
    assert.match(CONVERT_TEXTS.notResumable, /nothing was started/);
    assert.match(CONVERT_TEXTS.notResumable, /no longer exists, or its transcript doesn't name a folder/);
    assert.match(CONVERT_TEXTS.notResumable, /Save it to a4sx first .*then use Run as cell in terminal on it in My sessions/);
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
    calls.pickQueue.push(1, 2, [0]);
    calls.inputQueue.push("");
    assert.ok(await convertTabToCell(harness().deps, [], { projectsDir: p.dir, listMeshes: listing }));
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
    // A session matched by its title is confirmed (the confirm itself is tested below).
    calls.modalAnswers.set(SAVE_TAB_TEXTS.confirm, SAVE_TAB_TEXTS.confirmYes);
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

  it("the library can't be read, or the sidebar is signed out: nothing is saved, and the user is told why and what to do", async () => {
    const h = harness();
    assert.strictEqual(await saveTabSession(h.deps, [], { projectsDir: p.dir, saved: async () => { throw new LibraryUnreadable(false, "offline"); } }), undefined);
    assert.strictEqual(await saveTabSession(h.deps, [], { projectsDir: p.dir, saved: async () => { throw new Error("boom"); } }), undefined);
    assert.strictEqual(await saveTabSession(h.deps, [], { projectsDir: p.dir, saved: async () => { throw new LibraryUnreadable(true); } }), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [SAVE_TAB_TEXTS.libraryUnreadable("offline"), SAVE_TAB_TEXTS.libraryUnreadable("boom"), SAVE_TAB_TEXTS.signedOut]);
    assert.strictEqual(calls.terminals.length, 0, "no plain push that could add a second entry");
    for (const m of calls.errors.map((e) => e.message)) {
      assert.match(m, /^Nothing was saved: /, "what happened");
      assert.match(m, /second entry instead of a new version/, "the consequence a save would have had");
      assert.match(m, /Preview save to a4sx \(dry run\) works/, "what still works");
    }
    assert.match(SAVE_TAB_TEXTS.signedOut, /Sign in \(a4sx: Sign in\), then run Save session to a4sx again/);
    assert.match(SAVE_TAB_TEXTS.libraryUnreadable("x"), /Try again when your a4sx server is reachable/);
    // No lookup at all: the plain push.
    await saveTabSession(h.deps, [], { projectsDir: p.dir });
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}'\n`]);
  });

  it("an entry id the CLI doesn't take: says so and offers to save as a new entry; dismissed saves nothing", async () => {
    const h = harness();
    const saved = async () => [{ id: "bad id\u0007" }];
    assert.strictEqual(await saveTabSession(h.deps, [], { projectsDir: p.dir, saved }), undefined);
    assert.deepStrictEqual(calls.errors, [{ message: SAVE_TAB_TEXTS.badEntry("bad id"), items: [SAVE_TAB_TEXTS.saveAsNew] }]);
    assert.match(calls.errors[0].message, /Choose Save as a new entry to save the session as a separate entry in your library; otherwise nothing is saved\.$/);
    assert.strictEqual(calls.terminals.length, 0);
    calls.nextErrorChoice = SAVE_TAB_TEXTS.saveAsNew;
    assert.ok(await saveTabSession(h.deps, [], { projectsDir: p.dir, saved }));
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}'\n`]);
  });

  it("split editors: the Claude tab clicked in the inactive group is asked for, never taken from the active group", async () => {
    const uuid = "3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
    const clicked = { scheme: "webview-panel", path: `/webview-panel/webview-${CLAUDE_PANEL}-${uuid}` };
    const beta = { ...claudeTab("Beta work"), group: { viewColumn: 2 } };
    const alpha = { ...claudeTab("Alpha work"), group: { viewColumn: 1 } };
    calls.tabGroups = [{ tabs: [fileTab("a.ts"), alpha], activeTab: alpha }, { tabs: [fileTab("b.ts"), beta], activeTab: beta }];
    const h = harness();
    // Esc: nothing is saved.
    assert.strictEqual(await saveTabSession(h.deps, [clicked, { groupId: 7, editorIndex: 1 }], { projectsDir: p.dir }), undefined);
    assert.strictEqual(calls.quickPicks[0].options.title, SAVE_TAB_TEXTS.title);
    assert.strictEqual(calls.quickPicks[0].options.placeHolder, CONVERT_TEXTS.pickClickedTabPlaceholder);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => [i.label, i.description]), [["Alpha work", "editor group 1"], ["Beta work", "editor group 2"]]);
    assert.strictEqual(calls.terminals.length, 0);
    // The inactive group's tab chosen: its own session is saved.
    calls.pickQueue.push(1);
    assert.ok(await saveTabSession(h.deps, [clicked, { groupId: 7, editorIndex: 1 }], { projectsDir: p.dir }));
    assert.match(calls.terminals[0].sent[0], new RegExp(`'push' '[^']*${SID2}\\.jsonl'\\n$`));
  });

  it("split editors: a non-Claude tab right-clicked while a Claude tab is active saves nothing", async () => {
    const alpha = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [alpha, fileTab("a.ts")], activeTab: alpha }, { tabs: [claudeTab("Beta work"), fileTab("b.ts")] }];
    const h = harness();
    assert.strictEqual(await saveTabSession(h.deps, [{ scheme: "file", path: "/w/b.ts" }, { groupId: 2, editorIndex: 1 }], { projectsDir: p.dir }), undefined);
    assert.strictEqual(await convertTabToCell(h.deps, [undefined, { groupId: 2, editorIndex: 1 }], { projectsDir: p.dir }), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [CONVERT_TEXTS.notClaudeTab, CONVERT_TEXTS.notClaudeTab]);
    assert.strictEqual(calls.quickPicks.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(h.runs, []);
  });

  it("a session matched by title is confirmed with its title, last change, first prompt and short id before the save", async () => {
    resetCalls();
    p.session(p.cwd("alpha"), SID, [{ type: "user", message: { role: "user", content: "Fix the login bug" } }, { type: "ai-title", aiTitle: "Alpha work" }]);
    file = path.join(p.dir, projectDirName(p.cwd("alpha")), `${SID}.jsonl`);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    calls.modalChoices.push(SAVE_TAB_TEXTS.confirmYes);
    const t = await saveTabSession(harness().deps, [], { projectsDir: p.dir });
    assert.ok(t);
    assert.strictEqual(calls.modals.length, 1);
    const m = calls.modals[0];
    assert.deepStrictEqual([m.kind, m.message, m.items], ["info", SAVE_TAB_TEXTS.confirm, [SAVE_TAB_TEXTS.confirmYes, CONVERT_TEXTS.chooseAnother]]);
    assert.match(m.detail!, /^Title: Alpha work\nLast changed: \d{4}-\d\d-\d\d \d\d:\d\d, .+\nFirst prompt: "Fix the login bug"\nSession: 0f1e2d3c \(in .+alpha\)$/);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}'\n`]);
    // The terminal names the session too, written to the terminal and not sent to the shell.
    assert.strictEqual(calls.terminals[0].options.message, SAVE_TAB_TEXTS.banner(false, m.detail!));
    assert.ok(!calls.terminals[0].sent.join("").includes("Fix the login bug"));
  });

  it("the confirm's Cancel saves nothing; Choose another… shows the session pick, and only an explicit pick saves", async () => {
    resetCalls();
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    const h = harness();
    calls.modalChoices.push(undefined);   // Cancel
    assert.strictEqual(await saveTabSession(h.deps, [], { projectsDir: p.dir }), undefined);
    assert.strictEqual(calls.quickPicks.length, 0);
    assert.strictEqual(calls.terminals.length, 0);
    calls.modalChoices.push(CONVERT_TEXTS.chooseAnother);   // then Esc in the pick
    assert.strictEqual(await saveTabSession(h.deps, [], { projectsDir: p.dir }), undefined);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.session.sessionId), [SID, SID2], "the title's match first");
    assert.strictEqual(calls.terminals.length, 0);
    calls.modalChoices.push(CONVERT_TEXTS.chooseAnother);
    calls.pickQueue.push(1);
    assert.ok(await saveTabSession(h.deps, [], { projectsDir: p.dir }));
    assert.match(calls.terminals[0].sent[0], new RegExp(`'push' '[^']*${SID2}\\.jsonl'\\n$`));
  });

  it("two sessions with the tab's title: no auto-match and no confirm, the pick shows both with their details", async () => {
    resetCalls();
    const older = p.session(p.cwd("delta"), SID3, [{ type: "user", message: { role: "user", content: "Write the docs" } }, { type: "ai-title", aiTitle: "Alpha work" }]);
    p.session(p.cwd("gamma"), SID4, [{ type: "user", message: { role: "user", content: "Fix the login bug" } }, { type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    calls.modalAnswers.clear();
    const h = harness();
    assert.strictEqual(await saveTabSession(h.deps, [], { projectsDir: p.dir }), undefined);   // Esc
    assert.strictEqual(calls.modals.length, 0);
    const pick = calls.quickPicks[0];
    assert.strictEqual(pick.options.placeHolder, CONVERT_TEXTS.pickDuplicatePlaceholder("Alpha work", 3), "the beforeEach session has this title too");
    assert.deepStrictEqual(pick.items.slice(0, 3).map((i: any) => [i.label, i.session.sessionId, i.detail]), [
      ["Alpha work", SID4, "\"Fix the login bug\""], ["Alpha work", SID3, "\"Write the docs\""], ["Alpha work", SID, `First prompt: ${CONVERT_TEXTS.noPrompt}`],
    ]);
    assert.ok(pick.items.every((i: any) => i.description.includes(i.session.sessionId.slice(0, 8))));
    assert.strictEqual(calls.terminals.length, 0);
    calls.pickQueue.push(1);
    assert.ok(await saveTabSession(h.deps, [], { projectsDir: p.dir }));
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${older}'\n`]);
  });

  it("Save never pushes without a unique title match the user confirmed, or the user's explicit pick", async () => {
    p.session(p.cwd("d1"), SID3, [{ type: "ai-title", aiTitle: "Dup" }]);
    p.session(p.cwd("d2"), SID4, [{ type: "ai-title", aiTitle: "Dup" }]);
    let runs = 0;
    for (const label of ["Alpha work", "Dup", "Claude Code"]) {
      for (const answer of [SAVE_TAB_TEXTS.confirmYes, CONVERT_TEXTS.chooseAnother, undefined]) {
        for (const pickAnswer of [undefined, 0]) {
          resetCalls();
          const tab = claudeTab(label);
          calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
          calls.modalChoices.push(answer);
          calls.pickQueue.push(pickAnswer);
          const t = await saveTabSession(harness().deps, [], { projectsDir: p.dir });
          const confirmed = calls.modals.some((m) => m.message === SAVE_TAB_TEXTS.confirm) && answer === SAVE_TAB_TEXTS.confirmYes;
          const picked = calls.quickPicks.length === 1 && pickAnswer !== undefined;
          const where = `${label} / ${answer} / ${pickAnswer}`;
          assert.strictEqual(calls.terminals.length, confirmed || picked ? 1 : 0, where);
          assert.strictEqual(!!t, confirmed || picked, where);
          assert.ok(!(confirmed && picked), where);
          if (label !== "Alpha work") {
            assert.ok(!calls.modals.some((m) => m.message === SAVE_TAB_TEXTS.confirm), `${where}: no confirm without a unique match`);
          }
          if (confirmed) {
            assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}'\n`], where);
          }
          runs += t ? 1 : 0;
        }
      }
    }
    // Alpha work: confirmed (2, whatever the unused pick), Choose another… + pick (1); Dup and no match: the pick (3 each).
    assert.strictEqual(runs, 2 + 1 + 3 + 3);
  });

  it("the preview isn't confirmed, and its terminal names the session (title, last change, first prompt, short id)", async () => {
    resetCalls();
    const tab = claudeTab("Alpha work");
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    assert.ok(await saveTabSession(harness().deps, [], { projectsDir: p.dir, preview: true }));
    assert.strictEqual(calls.modals.length, 0);
    const msg: string = calls.terminals[0].options.message;
    assert.ok(msg.startsWith("Preview save to a4sx (dry run) of this session:\r\n  Title: Alpha work\r\n  Last changed: "), msg);
    assert.match(msg, /\r\n  First prompt: \(not found\)\r\n  Session: 0f1e2d3c \(in .+alpha\)\r\n$/);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'push' '${file}' '--dry-run'\n`]);
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

  it("the library lookup: the entries that hold this session, by its slug; signed out or a failing server rejects", async () => {
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
      await assert.rejects(ext.savedEntries({ token: async () => undefined })("0f1e2d3c4b5a"), (e: unknown) => e instanceof LibraryUnreadable && e.signedOut);
      ext.runtime.fetch = async () => ({ status: 500, json: async () => ({}), headers: { get: () => null } }) as any;
      await assert.rejects(lookup("0f1e2d3c4b5a"), (e: unknown) => e instanceof LibraryUnreadable && !e.signedOut && e.message.length > 0);
      // An expired sign-in is told as signed out (sign in again), not as an unreachable server.
      ext.runtime.fetch = async () => ({ status: 401, json: async () => ({ error: { code: "auth_invalid", message: "x" } }), headers: { get: () => null } }) as any;
      await assert.rejects(lookup("0f1e2d3c4b5a"), (e: unknown) => e instanceof LibraryUnreadable && e.signedOut);
      ext.runtime.fetch = async () => { throw new Error("offline"); };
      await assert.rejects(lookup("0f1e2d3c4b5a"), (e: unknown) => e instanceof LibraryUnreadable && !e.signedOut && /Can't reach a4sx/.test(e.message));
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

  it("lists my active meshes with my role and their member count; archived meshes and meshes I'm not in are left out", async () => {
    const withCounts = { meshes: meshes.meshes.map((m, i) => (i === 0 ? { ...m, member_count_bucket: "3" } : m)), next_cursor: null };
    const l = await withFetch(() => ({ status: 200, body: withCounts }), () => ext.listMeshesForCell({ token: async () => "tok" }));
    assert.deepStrictEqual(l, { kind: "ok", meshes: [{ id: MESH, name: "Alpha team", role: "owner", members: "3" }, { id: `msh_${"b".repeat(32)}`, role: "member" }] });
    assert.deepStrictEqual(meshPickItems(l).map((i: any) => [i.label, i.description, i.pick?.id]), [
      ["$(type-hierarchy) Alpha team", "owner · 3 members", MESH], [`$(type-hierarchy) msh_${"b".repeat(32)}`, "member", `msh_${"b".repeat(32)}`],
      [CONVERT_TEXTS.meshInBrowser, undefined, undefined], [CONVERT_TEXTS.chooseAnotherSession, undefined, undefined],
    ]);
    assert.strictEqual(calls.quickPicks.length, 0, "listing asks nothing");
  });

  it("signed out, or a failing server: says why in the listing, asks nothing", async () => {
    assert.deepStrictEqual(await ext.listMeshesForCell({ token: async () => undefined }), { kind: "signedOut" });
    const l = await withFetch(() => ({ status: 500, body: { error: { code: "internal", message: "x" } } }), () => ext.listMeshesForCell({ token: async () => "tok" }));
    assert.strictEqual(l.kind, "error");
    assert.strictEqual(calls.errors.length, 0);
    assert.strictEqual(calls.quickPicks.length, 0);
  });

  it("the tab commands are in a Claude Code tab's context menu (by the clicked tab), and in the Command Palette while one is active", () => {
    const claude = `activeWebviewPanelId == '${CLAUDE_PANEL}'`;
    const tab = `resourceScheme == 'webview-panel' && (resourceFilename =~ /^webview-${CLAUDE_PANEL}-/ || ${claude} && resourceFilename =~ /^webview-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)`;
    const menu = [[ext.CMD_CONVERT_TAB, tab], [ext.CMD_CONVERT_TAB_INTO_CELL, tab], [ext.CMD_SAVE_TAB, tab], [ext.CMD_PREVIEW_TAB_SAVE, tab]];
    assert.deepStrictEqual(pkg.contributes.menus["editor/title/context"].map((m: any) => [m.command, m.when]), menu);
    assert.deepStrictEqual(pkg.contributes.menus["editor/title/context"].map((m: any) => m.group), ["a4sx@1", "a4sx@2", "a4sx@3", "a4sx@4"]);
    // The clause's two patterns, against the resource names VS Code gives a clicked tab (resourceFilename).
    const [byType, noType] = [...tab.matchAll(/=~ \/(.*?)\/(?= |\))/g)].map((m) => new RegExp(m[1]));
    const uuid = "3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
    assert.ok(byType.test(`webview-${CLAUDE_PANEL}-${uuid}`), "VS Code 1.106 and newer");
    assert.ok(!byType.test(`webview-markdown.preview-${uuid}`) && !byType.test(`webview-${uuid}`));
    assert.ok(noType.test(`webview-${uuid}`), "before 1.106: no view type, so the active panel decides");
    assert.ok(!noType.test(`webview-${CLAUDE_PANEL}-${uuid}`) && !noType.test(`webview-markdown.preview-${uuid}`));
    // 0.9.1: "Convert to cell in mesh…" is part of "Convert to cell…"; its id stays registered, out of the menus
    const expected = [[ext.CMD_CONVERT_TAB, claude], [ext.CMD_CONVERT_TAB_IN_MESH, "false"], [ext.CMD_CONVERT_TAB_INTO_CELL, claude], [ext.CMD_SAVE_TAB, claude], [ext.CMD_PREVIEW_TAB_SAVE, claude]];
    const palette = pkg.contributes.menus.commandPalette.filter((m: any) => expected.some(([id]) => id === m.command));
    assert.deepStrictEqual(palette.map((m: any) => [m.command, m.when]), expected);
    const titles = Object.fromEntries(pkg.contributes.commands.map((c: any) => [c.command, c.title]));
    assert.strictEqual(titles[ext.CMD_CONVERT_TAB], "Convert to cell…");
    assert.strictEqual(titles[ext.CMD_CONVERT_TAB_IN_MESH], "Convert to cell in mesh…");
    assert.strictEqual(titles[ext.CMD_CONVERT_TAB_INTO_CELL], "Convert into an existing cell…");
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
      assert.strictEqual(await calls.commands.get(ext.CMD_CONVERT_TAB_INTO_CELL)!(), undefined);
      assert.strictEqual(await calls.commands.get(ext.CMD_SAVE_TAB)!(undefined, { groupId: 0, editorIndex: 0 }), undefined);
      assert.strictEqual(await calls.commands.get(ext.CMD_PREVIEW_TAB_SAVE)!(), undefined);
      // From the menu the clicked tab (index 0) is the file tab; from the Command Palette there is no Claude Code tab.
      assert.deepStrictEqual(calls.errors.map((e) => e.message), [CONVERT_TEXTS.notClaudeTab, CONVERT_TEXTS.noTab, CONVERT_TEXTS.noTab, CONVERT_TEXTS.notClaudeTab, CONVERT_TEXTS.noTab]);
    } finally {
      ctx.subscriptions.forEach((d) => d.dispose());
    }
  });
});
