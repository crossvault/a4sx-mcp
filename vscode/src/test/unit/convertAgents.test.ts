// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.9.0: Convert an Agents-window session to a cell, and Convert into a cell… on a Claude Code tab. Which transcripts
// are Agent SDK sessions, the pick and its confirm, the cell pick (a cell you have, or a new one), and the whole
// command against a fake CLI runner and transcripts in a temp folder. Nothing reaches a network or a shell.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { AGENT_LIST_MAX, agentSdkSessions, SDK_TS_ENTRYPOINT, transcriptEntrypoint } from "../../agentSessions";
import { CELL_CMD_TEXTS, CellCommandDeps, CONSENT_KEY, machineKey } from "../../cellCommands";
import { CellsProvider, CliOutput } from "../../cellsView";
import { AGENTS_TEXTS, agentPickItems, convertAgentSessionToCell } from "../../convertAgents";
import { CONVERT_TEXTS, convertTabToCell } from "../../convertTab";
import { projectDirName } from "../../nativeSeed";
import { RUN_AS_CELL_TEXTS } from "../../runAsCell";
import { CLAUDE_PANEL } from "../../tabSession";

const BASE = "https://session-exchange.com";
const CLI = "/opt/a4sx bin/a4sx";
const MESH = `msh_${"a".repeat(32)}`;
const SID = "0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b";
const SID2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SID3 = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

const CELL_ROW = { mesh_id: MESH, mesh_name: "Team mesh", name: "build", instance_id: "ins_A1", created: "2026-11-01T10:00:00Z", standalone: false, default: true, needs_approval: false, duplicate: false };
const out = (stdout: unknown, code = 0): CliOutput => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const flush = async (n = 6) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); } };

function harness(cells: unknown[] = [CELL_ROW]): { deps: CellCommandDeps; runs: string[] } {
  const runs: string[] = [];
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    const key = args.join(" ");
    runs.push(key);
    return key === "--version" ? out("a4sx 0.25.0  (server 0.718.0)") : key === "mesh cells --json" ? out({ v: 1, default: null, cells }) : out("");
  };
  const resolve = () => ({ kind: "found" as const, path: CLI });
  const provider = new CellsProvider({ resolve, run, server: () => BASE, onState: () => undefined });
  const deps: CellCommandDeps = {
    state: fakeMemento({ [CONSENT_KEY]: [machineKey()] }) as any, cliDir: undefined, provider, resolve, run, server: () => BASE, defaultServer: BASE,
    folder: async () => "/w/proj", fetch: async () => { throw new Error("no network"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
  };
  return { deps, runs };
}

/** A temp projects dir; transcripts as the Agent SDK (or the CLI, or the Claude Code extension) files them. */
function projects() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-agents-"));
  const dir = path.join(root, "projects");
  let clock = Date.parse("2026-11-17T12:00:00Z");
  return {
    dir,
    cwd(name: string): string {
      const p = path.join(root, name);
      fs.mkdirSync(p, { recursive: true });
      return p;
    },
    /** Writes a transcript (each newer than the one before): two queue records, then the user's prompt. */
    session(cwd: string, id: string, entrypoint: string | undefined, prompt: string, records: Record<string, unknown>[] = []): string {
      const folder = path.join(dir, projectDirName(cwd));
      fs.mkdirSync(folder, { recursive: true });
      const ep = entrypoint === undefined ? {} : { entrypoint };
      const lines = [
        JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: id }),
        JSON.stringify({ type: "queue-operation", operation: "dequeue", sessionId: id }),
        JSON.stringify({ type: "user", cwd, sessionId: id, ...ep, message: { role: "user", content: prompt } }),
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

describe("Agents-window sessions: which transcripts", () => {
  let p: ReturnType<typeof projects>;
  beforeEach(() => { p = projects(); });
  afterEach(() => p.remove());

  it("the entrypoint is the first record's that names one; cut or foreign lines are skipped", () => {
    assert.strictEqual(transcriptEntrypoint(`{"type":"queue-operation"}\n{"entrypoint":"sdk-ts","type":"user"}\n{"entrypoint":"cli"}`), "sdk-ts");
    assert.strictEqual(transcriptEntrypoint(`{"entrypoint":"sdk-t\n{"entrypoint":"cli"}`), "cli");
    assert.strictEqual(transcriptEntrypoint(`{"entrypoint":7}\n{"type":"user"}`), undefined);
    assert.strictEqual(transcriptEntrypoint(""), undefined);
    assert.strictEqual(SDK_TS_ENTRYPOINT, "sdk-ts");
  });

  it("lists only TypeScript Agent SDK sessions, newest first, with title, first prompt and folder", async () => {
    const a = p.cwd("alpha");
    const b = p.cwd("beta");
    p.session(a, SID, "sdk-ts", "Refactor the parser", [{ type: "ai-title", aiTitle: "Parser refactor" }]);
    p.session(a, SID2, "cli", "a terminal session");
    p.session(b, SID3, "claude-vscode", "a Claude Code tab");
    const four = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";
    p.session(b, four, "sdk-ts", "Write the release notes");
    p.session(b, "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", "sdk-py", "python SDK");
    p.session(b, "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c", undefined, "no entrypoint");
    const found = await agentSdkSessions(p.dir);
    assert.deepStrictEqual(found.map((s) => [s.sessionId, s.title, s.firstPrompt, s.cwd]), [
      [four, undefined, "Write the release notes", b],
      [SID, "Parser refactor", "Refactor the parser", a],
    ]);
    assert.deepStrictEqual((await agentSdkSessions(p.dir, 1)).map((s) => s.sessionId), [four]);
    assert.deepStrictEqual((await agentSdkSessions(p.dir, AGENT_LIST_MAX, 2)).map((s) => s.sessionId), [], "only the newest `scan` transcripts are read");
    assert.deepStrictEqual(await agentSdkSessions(path.join(p.dir, "missing")), []);
  });

  it("the pick shows the title (else the first prompt), the folder, when it changed and the short id", () => {
    const now = Date.parse("2026-11-17T12:10:00Z");
    const s = { sessionId: SID, folder: "-w-a", file: "/x", mtime: now - 5 * 60_000, cwd: "/w/a", firstPrompt: "Do it" };
    const [titled, untitled, bare] = agentPickItems([{ ...s, title: "Parser" }, s, { sessionId: SID2, folder: "-w-b", file: "/y", mtime: now }], now);
    assert.strictEqual(titled.label, "Parser");
    assert.match(titled.description, /^\/w\/a · \d{4}-\d\d-\d\d \d\d:\d\d, 5 min ago · 0f1e2d3c$/);
    assert.strictEqual(titled.detail, `"Do it"`);
    assert.strictEqual(untitled.label, "Do it");
    assert.strictEqual(bare.label, AGENTS_TEXTS.untitled);
    assert.match(bare.description, /^\(folder not named\) · /);
    assert.strictEqual(bare.detail, `First prompt: ${CONVERT_TEXTS.noPrompt}`);
  });
});

describe("Convert an Agents-window session to a cell: the command", () => {
  let p: ReturnType<typeof projects>;
  beforeEach(() => {
    resetCalls();
    p = projects();
  });
  afterEach(() => p.remove());

  it("pick, confirm, then a new cell resumes it by its id in its own folder", async () => {
    const cwd = p.cwd("alpha");
    p.session(cwd, SID, "sdk-ts", "Refactor the parser", [{ type: "ai-title", aiTitle: "Parser refactor" }]);
    p.session(p.cwd("beta"), SID2, "cli", "a terminal session");
    calls.modalAnswers.set(AGENTS_TEXTS.confirm, AGENTS_TEXTS.confirmYes);
    calls.pickQueue.push(0, 1, [0]);   // the session; New cell… (after the cell "build"); the options as offered
    const h = harness();
    const t = await convertAgentSessionToCell(h.deps, { projectsDir: p.dir });
    assert.ok(t);
    assert.strictEqual(calls.quickPicks[0].options.title, AGENTS_TEXTS.pickTitle);
    assert.deepStrictEqual(calls.quickPicks[0].items.map((i: any) => i.session.sessionId), [SID], "the CLI session isn't offered");
    const confirm = calls.modals.find((m) => m.message === AGENTS_TEXTS.confirm)!;
    assert.deepStrictEqual(confirm.items, [AGENTS_TEXTS.confirmYes, CONVERT_TEXTS.chooseAnother]);
    assert.match(confirm.detail!, /^Title: Parser refactor\nLast changed: .+\nFirst prompt: "Refactor the parser"\nSession: 0f1e2d3c \(in .+\)\n\nThe cell continues this session/);
    assert.strictEqual(calls.quickPicks[1].options.title, RUN_AS_CELL_TEXTS.pickTitle);
    assert.strictEqual(calls.quickPicks[1].items[1].label, RUN_AS_CELL_TEXTS.newCell);
    assert.strictEqual(calls.terminals[0].options.name, CELL_CMD_TEXTS.newCellTerminal);
    assert.strictEqual(calls.terminals[0].options.cwd, cwd);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--new-cell' '--mesh-reduced-isolation' '--' '--resume' '${SID}'\n`]);
    await flush();
    assert.ok(calls.infos.includes(AGENTS_TEXTS.started));
  });

  it("into a cell you already have: `launch --cell <cell>`", async () => {
    const cwd = p.cwd("alpha");
    p.session(cwd, SID, "sdk-ts", "Refactor the parser");
    calls.modalAnswers.set(AGENTS_TEXTS.confirm, AGENTS_TEXTS.confirmYes);
    calls.pickQueue.push(0, 0, [0]);   // the session; the cell "build"; the options
    assert.ok(await convertAgentSessionToCell(harness().deps, { projectsDir: p.dir }));
    assert.strictEqual(calls.terminals[0].options.name, CELL_CMD_TEXTS.cellTerminal("build"));
    assert.strictEqual(calls.terminals[0].options.cwd, cwd);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--cell' 'build' '--mesh-reduced-isolation' '--' '--resume' '${SID}'\n`]);
  });

  it("Cancel on the confirm, or Esc on the pick, starts nothing and runs no CLI; Choose another… goes back to the list", async () => {
    p.session(p.cwd("alpha"), SID, "sdk-ts", "first");
    p.session(p.cwd("beta"), SID2, "sdk-ts", "second");
    const h = harness();
    calls.pickQueue.push(0);
    assert.strictEqual(await convertAgentSessionToCell(h.deps, { projectsDir: p.dir }), undefined);   // Cancel
    assert.strictEqual(await convertAgentSessionToCell(h.deps, { projectsDir: p.dir }), undefined);   // Esc
    assert.deepStrictEqual(h.runs, []);
    assert.strictEqual(calls.terminals.length, 0);
    resetCalls();
    calls.modalChoices.push(CONVERT_TEXTS.chooseAnother, AGENTS_TEXTS.confirmYes);
    calls.pickQueue.push(0, 1, 1, [0]);   // SID2 (newest), Choose another…, SID, New cell…, options
    assert.ok(await convertAgentSessionToCell(h.deps, { projectsDir: p.dir }));
    assert.match(calls.modals[0].detail!, /Session: 1a2b3c4d /);
    assert.match(calls.modals[1].detail!, /Session: 0f1e2d3c /);
    assert.match(calls.terminals[0].sent[0], new RegExp(`'--resume' '${SID}'\\n$`));
  });

  it("refusals: no Agent SDK session; a session whose folder is gone. Each names why and what to do", async () => {
    const h = harness();
    p.session(p.cwd("alpha"), SID2, "cli", "terminal only");
    assert.strictEqual(await convertAgentSessionToCell(h.deps, { projectsDir: p.dir }), undefined);
    const gone = p.cwd("gone");
    p.session(gone, SID, "sdk-ts", "gone");
    fs.rmSync(gone, { recursive: true, force: true });
    calls.modalAnswers.set(AGENTS_TEXTS.confirm, AGENTS_TEXTS.confirmYes);
    calls.pickQueue.push(0);
    assert.strictEqual(await convertAgentSessionToCell(h.deps, { projectsDir: p.dir }), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [AGENTS_TEXTS.noSessions, AGENTS_TEXTS.notResumable]);
    assert.match(AGENTS_TEXTS.noSessions, /nothing was started/);
    assert.match(AGENTS_TEXTS.noSessions, /remote agent host/);
    assert.match(AGENTS_TEXTS.notResumable, /nothing was started/);
    assert.match(AGENTS_TEXTS.notResumable, /Continue it in the Agents window instead, or recreate the folder/);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(h.runs, [], "the CLI is not run before the session is known");
  });

  it("the same id in another folder: the confirmed transcript is resumed in its own folder; Esc on the cell pick starts nothing", async () => {
    const a = p.cwd("alpha");
    p.session(a, SID, "sdk-ts", "the one shown");
    calls.modalAnswers.set(AGENTS_TEXTS.confirm, AGENTS_TEXTS.confirmYes);
    calls.pickQueue.push(0);   // the session, then Esc on the cell pick
    const h = harness();
    assert.strictEqual(await convertAgentSessionToCell(h.deps, { projectsDir: p.dir }), undefined);
    assert.strictEqual(calls.quickPicks[1].options.title, RUN_AS_CELL_TEXTS.pickTitle);
    assert.strictEqual(calls.terminals.length, 0);
    // A newer transcript with the same id under another existing folder (not an SDK session, so not listed).
    p.session(p.cwd("beta"), SID, "cli", "another transcript with the same id");
    resetCalls();
    calls.modalAnswers.set(AGENTS_TEXTS.confirm, AGENTS_TEXTS.confirmYes);
    calls.pickQueue.push(0, 1, [0]);
    assert.ok(await convertAgentSessionToCell(h.deps, { projectsDir: p.dir }));
    assert.strictEqual(calls.terminals[0].options.cwd, a, "resumed where the confirmed transcript is, not in the newer copy's folder");
    assert.match(calls.terminals[0].sent[0], new RegExp(`'--resume' '${SID}'\\n$`));
  });

  it("a first record longer than 64 KB (a pasted file) still lists the session", async () => {
    p.session(p.cwd("alpha"), SID, "sdk-ts", "x".repeat(100 * 1024));
    const found = await agentSdkSessions(p.dir);
    assert.deepStrictEqual(found.map((s) => s.sessionId), [SID]);
  });

  it("nothing from a transcript reaches the command line: the id is the file name's, the folder is the terminal's cwd", async () => {
    const cwd = p.cwd("we'ird; $(touch x) `y`");
    p.session(cwd, SID, "sdk-ts", "'; rm -rf ~ #", [{ type: "custom-title", customTitle: "$(reboot)'\"" }]);
    calls.modalAnswers.set(AGENTS_TEXTS.confirm, AGENTS_TEXTS.confirmYes);
    calls.pickQueue.push(0, 1, [0]);
    assert.ok(await convertAgentSessionToCell(harness().deps, { projectsDir: p.dir }));
    assert.strictEqual(calls.quickPicks[0].items[0].label, "$(reboot)'\"");
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--new-cell' '--mesh-reduced-isolation' '--' '--resume' '${SID}'\n`]);
    assert.strictEqual(calls.terminals[0].options.cwd, cwd);
  });
});

describe("Convert into a cell… on a Claude Code tab", () => {
  let p: ReturnType<typeof projects>;
  beforeEach(() => {
    resetCalls();
    p = projects();
    calls.modalAnswers.set(CONVERT_TEXTS.confirm, CONVERT_TEXTS.confirmYes);
  });
  afterEach(() => p.remove());

  it("asks for the cell (one you have, or New cell…) with the session named in its title; no confirm, no mesh pick", async () => {
    const cwd = p.cwd("alpha");
    p.session(cwd, SID, "claude-vscode", "tab work", [{ type: "ai-title", aiTitle: "Alpha work" }]);
    const tab = { label: "Alpha work", input: { viewType: `mainThreadWebview-${CLAUDE_PANEL}` } };
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    calls.pickQueue.push(0, [0]);
    let meshAsked = false;
    assert.ok(await convertTabToCell(harness().deps, [], { projectsDir: p.dir, pickCell: true, listMeshes: async () => { meshAsked = true; return { kind: "ok", meshes: [] }; } }));
    assert.strictEqual(meshAsked, false);
    assert.deepStrictEqual(calls.modals.filter((m) => m.message === CONVERT_TEXTS.confirm), [], "the cell pick names the session: no separate confirm");
    assert.strictEqual(calls.quickPicks[0].options.title, CONVERT_TEXTS.intoCellTitle("Alpha work"));
    assert.match(calls.quickPicks[0].options.placeHolder, new RegExp(`^Session ${SID.slice(0, 8)} in .*alpha, changed .*Choose the cell`));
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--cell' 'build' '--mesh-reduced-isolation' '--' '--resume' '${SID}'\n`]);
    assert.strictEqual(calls.terminals[0].options.cwd, cwd);
    // Esc on the cell pick starts nothing.
    resetCalls();
    calls.modalAnswers.set(CONVERT_TEXTS.confirm, CONVERT_TEXTS.confirmYes);
    calls.tabGroups = [{ tabs: [tab], activeTab: tab }];
    assert.strictEqual(await convertTabToCell(harness().deps, [], { projectsDir: p.dir, pickCell: true }), undefined);
    assert.strictEqual(calls.terminals.length, 0);
  });
});
