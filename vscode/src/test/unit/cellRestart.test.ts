// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.9.2: restarting a stored cell from the Cells view (owner, 2026-11-20, Windows). Start continues the cell's last
// conversation (bug 1), finds the Claude Code extension's claude in the version that is installed now (bug 2), and
// runs in the folder the conversation ran in, never the home folder (bug 3). The CLI is a fake runner; the CLI's
// record, the transcripts and the extension folders are real files in a temp folder.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import { cellLaunchArgs, CELLS_LIST_ARGS, LocalCell } from "../../cells";
import {
  cellFolderConflict, CELL_CLAUDE_TEXTS, CELL_FOLDERS_KEY, CELL_START_TEXTS, CellCommandDeps, claudeInstallCommand, CONSENT_KEY, machineKey, newCell, samePath, START_ANYWAY_KEY, startCell,
} from "../../cellCommands";
import { runAsCell } from "../../runAsCell";
import { cellStartPlan, lastPromptFolder, parseCellLastSession, readCellLastSession } from "../../cellResume";
import { CellsProvider, CliOutput, LocalCellItem, MeshGroupItem } from "../../cellsView";
import { projectDirName } from "../../nativeSeed";
import { bundledClaude, claudeFindable } from "../../provision";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscodeFake = require("vscode");

const MESH = "msh_0123456789abcdef0123456789abcdef";
const SID = "83ce93e5-1111-4222-8333-944445555666";
const NAME = "kartanwk8-cell01";
const IID = "ins_K8cell01";
const CLI = "/opt/a4sx/a4sx";
const EXE = process.platform === "win32" ? "claude.exe" : "claude";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-restart-test-"));
}

function write(file: string, text = ""): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });   // a claude stand-in must be runnable
  return file;
}

interface World {
  /** <state home>/a4sx */
  stateDir: string;
  /** your ~/.claude/projects */
  projects: string;
  /** the folder the cell's conversation ran in */
  folder: string;
  home: string;
}

function world(): World {
  const root = tmpdir();
  const w = { stateDir: path.join(root, "state", "a4sx"), projects: path.join(root, "home", ".claude", "projects"), folder: path.join(root, "projects", "meshtest"), home: path.join(root, "home") };
  fs.mkdirSync(w.folder, { recursive: true });
  fs.mkdirSync(w.projects, { recursive: true });
  return w;
}

/** The CLI's record (_cell_last_put): {"v": 1, "cells": {<iid>: {"sid", "cwd", "at"}}}. */
function record(w: World, cells: Record<string, unknown>, name = NAME): void {
  write(path.join(w.stateDir, "agents", name, "state", "cell-last-session.json"), JSON.stringify({ v: 1, cells }, null, 2));
}

/** The transcript in the cell's overlay projects folder (a link to yours in real life). */
function overlayTranscript(w: World, cwd = w.folder, sid = SID, title = "Mesh test session"): string {
  return write(path.join(w.stateDir, "harness", NAME, "claude", "projects", projectDirName(cwd), `${sid}.jsonl`),
    `${JSON.stringify({ type: "user", sessionId: sid, cwd })}\n${JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: sid })}\n`);
}

const ANSWER = [{ mesh_id: MESH, mesh_name: "Test mesh", name: NAME, instance_id: IID, created: "2026-11-19T10:00:00Z", standalone: false, default: true, needs_approval: false, duplicate: false }];

function deps(w: World, over: Partial<CellCommandDeps> = {}): { deps: CellCommandDeps; folderAsked: () => number } {
  let asked = 0;
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> =>
    ({ code: 0, stdout: args.join(" ") === CELLS_LIST_ARGS.join(" ") ? JSON.stringify(ANSWER) : "", stderr: "" });
  const provider = new CellsProvider({ resolve: () => ({ kind: "found", path: CLI }), run, server: () => "https://session-exchange.com", onState: () => undefined });
  const d: CellCommandDeps = {
    state: fakeMemento() as any,
    cliDir: undefined,
    provider,
    resolve: () => ({ kind: "found", path: CLI }),
    run,
    server: () => "https://session-exchange.com",
    defaultServer: "https://session-exchange.com",
    // what the owner had: no folder open, so the old Start ran in the home folder
    folder: async () => { asked++; return undefined; },
    fetch: async () => { throw new Error("no network in tests"); },
    python: async () => ({ code: 1, stdout: "" }),
    terminals: new Set(),
    stateDir: w.stateDir,
    claudeProjects: w.projects,
    env: { A4SX_CLAUDE: write(path.join(tmpdir(), EXE)) },
    home: w.home,
    ...over,
  };
  return { deps: d, folderAsked: () => asked };
}

async function cellItem(d: CellCommandDeps): Promise<LocalCellItem> {
  for (const top of await d.provider.getChildren()) {
    if (top instanceof MeshGroupItem) {
      const hit = (await d.provider.getChildren(top)).find((i) => i instanceof LocalCellItem);
      if (hit) {
        return hit as LocalCellItem;
      }
    }
  }
  throw new Error("no cell");
}

const q = (args: string[]) => `${[CLI, ...args].map((a) => `'${a}'`).join(" ")}\n`;

describe("0.9.2 bug 1: Start continues the cell's last conversation", () => {
  beforeEach(resetCalls);

  it("with a recorded conversation and its transcript: `-- --resume <id>` in its folder, and the UI says so", async () => {
    const w = world();
    record(w, { [IID]: { sid: SID, cwd: w.folder, at: 1763600000 } });
    overlayTranscript(w);
    const { deps: d } = deps(w);
    const t = await startCell(d, await cellItem(d));
    assert.ok(t);
    assert.deepStrictEqual(calls.terminals[0].sent, [q(["launch", "--cell", NAME, "--", "--resume", SID])]);
    assert.strictEqual(calls.terminals[0].options.cwd, w.folder);
    assert.strictEqual(calls.terminals[0].options.message, CELL_START_TEXTS.banner("83ce93e5", w.folder));
    assert.deepStrictEqual(calls.infos, [CELL_START_TEXTS.resuming(NAME, "Mesh test session", "83ce93e5", w.folder)]);
    assert.deepStrictEqual(calls.openDialogs, [], "no folder question: the folder is known");
  });

  it("the transcript in your own Claude Code folder counts too; one under a shortened folder name is found by its id", async () => {
    const w = world();
    record(w, { [IID]: { sid: SID, cwd: w.folder } });
    write(path.join(w.projects, "-shortened-name-x", `${SID}.jsonl`), "{}\n");
    const plan = cellStartPlan(w.stateDir, w.projects, { name: NAME, instanceId: IID });
    assert.strictEqual(plan.kind, "resume");
  });

  it("a recorded conversation whose transcript is gone: a new one in its folder, said so; no --resume", async () => {
    const w = world();
    record(w, { [IID]: { sid: SID, cwd: w.folder } });
    const { deps: d } = deps(w);
    await startCell(d, await cellItem(d));
    assert.deepStrictEqual(calls.terminals[0].sent, [q(["launch", "--cell", NAME])]);
    assert.strictEqual(calls.terminals[0].options.cwd, w.folder);
    assert.deepStrictEqual(calls.infos, [CELL_START_TEXTS.gone(NAME, "83ce93e5", w.folder)]);
  });

  it("an id the CLI recorded that isn't a Claude Code session id: the folder only (the CLI resumes it itself)", async () => {
    const w = world();
    record(w, { [IID]: { sid: "not-a-uuid_1", cwd: w.folder } });
    overlayTranscript(w, w.folder, "not-a-uuid_1");
    const { deps: d } = deps(w);
    await startCell(d, await cellItem(d));
    assert.deepStrictEqual(calls.terminals[0].sent, [q(["launch", "--cell", NAME])]);
    assert.strictEqual(calls.terminals[0].options.cwd, w.folder);
  });

  it("the record is read as the CLI reads it: only this cell's entry, a valid id and an absolute folder", () => {
    const w = world();
    assert.deepStrictEqual(parseCellLastSession(JSON.stringify({ v: 1, cells: { [IID]: { sid: SID, cwd: "/p" } } }), IID, "linux"), { sessionId: SID, cwd: "/p" });
    assert.deepStrictEqual(parseCellLastSession(JSON.stringify({ v: 1, cells: { [IID]: { sid: SID, cwd: "C:\\Users\\kartan\\projects\\meshtest" } } }), IID, "win32"),
      { sessionId: SID, cwd: "C:\\Users\\kartan\\projects\\meshtest" });
    for (const bad of [
      { cells: { ins_Other: { sid: SID, cwd: "/p" } } }, { cells: { [IID]: { sid: SID, cwd: "relative/p" } } }, { cells: { [IID]: { sid: "-x", cwd: "/p" } } },
      { cells: { [IID]: { sid: SID, cwd: "/p\nq" } } }, { cells: { [IID]: "x" } }, { cells: [] }, [], "x",
    ]) {
      assert.strictEqual(parseCellLastSession(JSON.stringify(bad), IID, "linux"), undefined, JSON.stringify(bad));
    }
    assert.strictEqual(parseCellLastSession("not json", IID, "linux"), undefined);
    assert.strictEqual(readCellLastSession(w.stateDir, { name: "../x", instanceId: IID }), undefined, "a name the CLI doesn't take reads nothing");
    assert.strictEqual(cellLaunchArgs({ name: NAME, instanceId: IID, meshId: MESH } as LocalCell, [], "x; rm"), undefined);
  });
});

describe("0.9.2 bug 2: the Claude Code extension's claude, found where it is now", () => {
  beforeEach(resetCalls);

  /** <extensions>/anthropic.claude-code-<version>-<platform>[/resources/native-binary/claude]. */
  function ext(root: string, version: string, withClaude = true, sub = ["resources", "native-binary"]): string {
    const dir = path.join(root, `anthropic.claude-code-${version}-${process.platform}-${process.arch}`);
    fs.mkdirSync(dir, { recursive: true });
    if (withClaude) {
      write(path.join(dir, ...sub, EXE));
    }
    return dir;
  }

  it("the extension updated while VS Code ran: its path names the removed 2.1.325 folder, the claude of 2.1.328 is used", async () => {
    const root = tmpdir();
    const stale = path.join(root, `anthropic.claude-code-2.1.325-${process.platform}-${process.arch}`);   // gone after the update
    const now = ext(root, "2.1.328");
    calls.extensions.add("anthropic.claude-code");
    calls.extensionPaths.set("anthropic.claude-code", stale);
    const w = world();
    const { deps: d } = deps(w, { env: {}, folder: async () => tmpdir() });
    await newCell(d);
    assert.deepStrictEqual(calls.terminals[0].options.env, { A4SX_CLAUDE: path.join(now, "resources", "native-binary", EXE) });
    assert.ok(!calls.terminals[0].options.env.A4SX_CLAUDE.includes("2.1.325"));
    assert.deepStrictEqual(calls.modals, []);
  });

  it("asked at every start, never kept: an update between two starts is picked up by the second", async () => {
    const root = tmpdir();
    const old = ext(root, "2.1.325");
    calls.extensions.add("anthropic.claude-code");
    calls.extensionPaths.set("anthropic.claude-code", old);
    const { deps: d } = deps(world(), { folder: async () => tmpdir(), env: {} });
    await newCell(d);
    assert.strictEqual(calls.terminals[0].options.env.A4SX_CLAUDE, path.join(old, "resources", "native-binary", EXE));
    fs.unlinkSync(path.join(old, "resources", "native-binary", EXE));
    const now = ext(root, "2.1.329");
    await newCell(d);
    assert.strictEqual(calls.terminals[1].options.env.A4SX_CLAUDE, path.join(now, "resources", "native-binary", EXE));
  });

  it("newest version first; a folder VS Code's .obsolete lists is skipped; another layout is found by the search", () => {
    const root = tmpdir();
    const a = ext(root, "2.1.325");
    const b = ext(root, "2.1.330", true, ["dist", "bin"]);
    assert.strictEqual(bundledClaude(a), path.join(b, "dist", "bin", EXE));
    write(path.join(root, ".obsolete"), JSON.stringify({ [path.basename(b)]: true }));
    fs.chmodSync(path.join(root, ".obsolete"), 0o644);   // as VS Code writes it
    assert.strictEqual(bundledClaude(a), path.join(a, "resources", "native-binary", EXE));
    const lone = path.join(tmpdir(), "my-dev-copy");
    write(path.join(lone, "resources", "native-binary", EXE));
    assert.strictEqual(bundledClaude(lone), path.join(lone, "resources", "native-binary", EXE));
    assert.strictEqual(bundledClaude(path.join(tmpdir(), `anthropic.claude-code-2.1.1-${process.platform}-${process.arch}`)), undefined);
  });

  it("no claude in any Claude Code folder, but on PATH: no A4SX_CLAUDE, so the CLI finds it", async () => {
    const root = tmpdir();
    calls.extensions.add("anthropic.claude-code");
    calls.extensionPaths.set("anthropic.claude-code", ext(root, "2.1.325", false));
    const bin = path.dirname(write(path.join(tmpdir(), EXE)));
    const { deps: d } = deps(world(), { folder: async () => tmpdir(), env: { PATH: bin, Path: bin } });
    await newCell(d);
    assert.strictEqual(calls.terminals.length, 1);
    assert.strictEqual(calls.terminals[0].options.env, undefined);
    assert.deepStrictEqual(calls.modals, []);
    const home = path.dirname(path.dirname(path.dirname(write(path.join(tmpdir(), ".local", "bin", "claude")))));
    assert.ok(claudeFindable({ PATH: "/nowhere" }, home, "linux", (p) => fs.existsSync(p)), "~/.local/bin/claude");
  });

  it("nothing anywhere: one message with the install command; nothing starts; Copy and Start anyway", async () => {
    const root = tmpdir();
    const extPath = ext(root, "2.1.325", false);
    calls.extensions.add("anthropic.claude-code");
    calls.extensionPaths.set("anthropic.claude-code", extPath);
    const { deps: d } = deps(world(), { folder: async () => tmpdir(), env: { PATH: "" } });
    calls.modalChoices.push(CELL_CLAUDE_TEXTS.copyInstall);
    assert.strictEqual(await newCell(d), undefined);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.modals.map((m) => [m.kind, m.message, m.items]), [["error", CELL_CLAUDE_TEXTS.none, [CELL_CLAUDE_TEXTS.copyInstall, CELL_CLAUDE_TEXTS.startAnyway]]]);
    assert.ok(calls.modals[0].detail!.includes(claudeInstallCommand(process.platform)));
    assert.ok(calls.modals[0].detail!.includes(extPath));
    assert.strictEqual(calls.clipboard, claudeInstallCommand(process.platform));
    calls.modalChoices.push(CELL_CLAUDE_TEXTS.startAnyway);
    await newCell(d);
    assert.strictEqual(calls.terminals.length, 1);
    assert.strictEqual(calls.terminals[0].options.env, undefined);
  });

  it("your own A4SX_CLAUDE names no program: said with the fix before anything starts; the bundled one is offered", async () => {
    const root = tmpdir();
    const now = ext(root, "2.1.328");
    calls.extensions.add("anthropic.claude-code");
    calls.extensionPaths.set("anthropic.claude-code", now);
    const gone = path.join(root, "anthropic.claude-code-2.1.325-win32-x64", "resources", "native-binary", "claude.exe");
    const { deps: d } = deps(world(), { folder: async () => tmpdir(), env: { A4SX_CLAUDE: gone } });
    assert.strictEqual(await newCell(d), undefined);
    assert.deepStrictEqual(calls.modals.map((m) => [m.message, m.items]), [[CELL_CLAUDE_TEXTS.badUserEnv(gone), [CELL_CLAUDE_TEXTS.useBundled]]]);
    assert.match(calls.modals[0].detail!, /remove A4SX_CLAUDE from your environment variables/);
    calls.modalChoices.push(CELL_CLAUDE_TEXTS.useBundled);
    await newCell(d);
    assert.deepStrictEqual(calls.terminals[0].options.env, { A4SX_CLAUDE: path.join(now, "resources", "native-binary", EXE) });
  });

  it("a cell's terminal isn't revived by VS Code after a restart (it would keep an old A4SX_CLAUDE and folder)", async () => {
    const w = world();
    record(w, { [IID]: { sid: SID, cwd: w.folder } });
    overlayTranscript(w);
    const { deps: d } = deps(w);
    await startCell(d, await cellItem(d));
    assert.strictEqual(calls.terminals[0].options.isTransient, true);
  });
});

describe("0.9.2 bug 3: Start runs in the cell's folder, never the home folder", () => {
  beforeEach(resetCalls);

  it("no folder open (the owner's window): the recorded folder, not the default (home) and without asking", async () => {
    const w = world();
    record(w, { [IID]: { sid: SID, cwd: w.folder } });
    overlayTranscript(w);
    const { deps: d, folderAsked } = deps(w);
    await startCell(d, await cellItem(d));
    assert.strictEqual(calls.terminals[0].options.cwd, w.folder);
    assert.notStrictEqual(calls.terminals[0].options.cwd, os.homedir());
    assert.strictEqual(folderAsked(), 0, "the window's folder isn't asked for");
    assert.deepStrictEqual((d.state.get(CELL_FOLDERS_KEY) as Record<string, string>)[IID], w.folder);
  });

  it("with a workspace folder open, the recorded folder still wins", async () => {
    const w = world();
    record(w, { [IID]: { sid: SID, cwd: w.folder } });
    overlayTranscript(w);
    calls.workspaceFolders = [{ name: "other", uri: vscodeFake.Uri.file(tmpdir()) }];
    const { deps: d } = deps(w, { folder: async () => calls.workspaceFolders![0].uri.fsPath });
    await startCell(d, await cellItem(d));
    assert.strictEqual(calls.terminals[0].options.cwd, w.folder);
  });

  it("no conversation recorded: a folder picker (never a silent default); Cancel starts nothing", async () => {
    const w = world();
    const { deps: d, folderAsked } = deps(w);
    assert.strictEqual(await startCell(d, await cellItem(d)), undefined);
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(calls.openDialogs.length, 1);
    assert.deepStrictEqual([calls.openDialogs[0].canSelectFolders, calls.openDialogs[0].title], [true, CELL_START_TEXTS.pickTitle(NAME)]);
    assert.strictEqual(calls.openDialogs[0].defaultUri, undefined, "no folder known: no default, and never home");
    assert.strictEqual(folderAsked(), 0);
    calls.nextOpenDialog = [vscodeFake.Uri.file(w.folder)];
    await startCell(d, await cellItem(d));
    assert.strictEqual(calls.terminals[0].options.cwd, w.folder);
    assert.deepStrictEqual(calls.infos, [CELL_START_TEXTS.fresh(NAME, w.folder)]);
    // The next start's picker opens on that folder.
    calls.nextOpenDialog = undefined;
    await startCell(d, await cellItem(d));
    assert.strictEqual(calls.openDialogs[2].defaultUri.fsPath, w.folder);
  });

  it("no record, but a prompt was typed in the cell: the picker opens on that prompt's folder", () => {
    const w = world();
    write(path.join(w.stateDir, "harness", NAME, "claude", "history.jsonl"),
      `${JSON.stringify({ display: "x", project: "/gone/away", sessionId: SID })}\n${JSON.stringify({ display: "y", project: w.folder, sessionId: SID })}\n{"cut`);
    assert.strictEqual(lastPromptFolder(w.stateDir, NAME), w.folder);
    assert.strictEqual(lastPromptFolder(w.stateDir, "other-cell"), undefined);
  });

  it("the recorded folder is gone: the picker says so; a new conversation in the folder picked, said so", async () => {
    const w = world();
    const gone = path.join(w.folder, "removed");
    record(w, { [IID]: { sid: SID, cwd: gone } });
    const { deps: d } = deps(w);
    calls.nextOpenDialog = [vscodeFake.Uri.file(w.folder)];
    await startCell(d, await cellItem(d));
    assert.strictEqual(calls.openDialogs[0].title, CELL_START_TEXTS.movedTitle(NAME, gone));
    assert.deepStrictEqual(calls.terminals[0].sent, [q(["launch", "--cell", NAME, "--new-session"])], "--new-session: the CLI doesn't ask whether to start a new conversation");
    assert.strictEqual(calls.terminals[0].options.cwd, w.folder);
    assert.deepStrictEqual(calls.infos, [CELL_START_TEXTS.movedStarted(NAME, "83ce93e5", gone, w.folder)]);
  });
});

describe("0.9.2 review: a home-folder record, other platforms' builds, Windows paths, Run as cell", () => {
  beforeEach(resetCalls);

  /** A world whose conversation ran in the home folder (what 0.9.1's Start left behind with no folder open). */
  function homeWorld(): World {
    const w = world();
    w.home = w.folder;
    record(w, { [IID]: { sid: SID, cwd: w.folder } });
    overlayTranscript(w);
    return w;
  }

  it("a conversation recorded in the home folder (it holds ~/.claude): the CLI won't start a cell there, so it says why; Cancel starts nothing", async () => {
    const w = homeWorld();
    const { deps: d } = deps(w);
    assert.strictEqual(await startCell(d, await cellItem(d)), undefined);
    const what = `holds the a4sx config folder (${path.join(w.folder, ".config", "a4sx")})`;
    assert.deepStrictEqual(calls.modals.map((m) => [m.kind, m.message, m.items, m.detail]),
      [["warning", CELL_START_TEXTS.folderTitle(NAME, w.folder), [CELL_START_TEXTS.folderChoose], CELL_START_TEXTS.folderDetail(w.folder, what)]]);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("home folder: Choose a folder… starts a new conversation in the folder chosen; the home folder chosen again is refused", async () => {
    const w = homeWorld();
    const { deps: d } = deps(w);
    const other = tmpdir();
    calls.modalChoices.push(CELL_START_TEXTS.folderChoose);
    calls.nextOpenDialog = [vscodeFake.Uri.file(other)];
    await startCell(d, await cellItem(d));
    assert.deepStrictEqual(calls.terminals[0].sent, [q(["launch", "--cell", NAME, "--new-session"])]);
    assert.strictEqual(calls.terminals[0].options.cwd, other);
    assert.strictEqual(calls.terminals[0].options.message, undefined);
    assert.strictEqual(calls.infos[0], CELL_START_TEXTS.left(NAME, "83ce93e5", w.folder, other));
    calls.modalChoices.push(CELL_START_TEXTS.folderChoose);
    calls.nextOpenDialog = [vscodeFake.Uri.file(w.folder)];
    assert.strictEqual(await startCell(d, await cellItem(d)), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [CELL_START_TEXTS.folderRefused(w.folder, `holds the a4sx config folder (${path.join(w.folder, ".config", "a4sx")})`)]);
    assert.strictEqual(calls.terminals.length, 1);
  });

  it("the folders the CLI refuses: the home folder, ~/.claude itself or inside it, the a4sx state folder; a project folder is fine", () => {
    const home = tmpdir();
    const state = path.join(home, ".local", "state", "a4sx");
    const d = { env: {}, home };
    assert.match(cellFolderConflict(home, d, state)!, /^holds the a4sx state folder/);
    assert.match(cellFolderConflict(path.join(home, ".claude"), d, state)!, /^is your Claude Code folder/);
    assert.match(cellFolderConflict(path.join(home, ".claude", "projects"), d, state)!, /^is inside your Claude Code folder/);
    assert.strictEqual(cellFolderConflict(path.join(home, "projects", "meshtest"), d, state), undefined);
    assert.match(cellFolderConflict("C:\\Users\\Kartan", { env: {}, home: "C:\\Users\\kartan" }, undefined, "win32")!, /holds the a4sx config folder/);
    // CLAUDE_CONFIG_DIR moves the Claude Code folder; a root never counts as holding them (as in the CLI)
    const cc = path.join(tmpdir(), "cc");
    assert.match(cellFolderConflict(path.join(cc, "x"), { env: { CLAUDE_CONFIG_DIR: cc }, home }, state)!, /^is inside your Claude Code folder/);
    assert.strictEqual(cellFolderConflict(path.parse(home).root, d, state), undefined);
    // a folder below a link that doesn't exist yet resolves through the link, as Python's realpath does
    const real = tmpdir();
    const link = path.join(tmpdir(), "home-link");
    fs.symlinkSync(real, link);
    assert.match(cellFolderConflict(path.join(link, ".claude", "new"), { env: {}, home: real }, undefined)!, /^is inside your Claude Code folder/);
    // "is inside": the flag wouldn't help either, and the text says so
    assert.match(CELL_START_TEXTS.folderDetail("/x", "is inside your Claude Code folder (/x)"), /with or without --mesh-reduced-isolation/);
    assert.match(CELL_START_TEXTS.folderDetail("/x", "holds your Claude Code folder (/x/.claude)"), /only --mesh-reduced-isolation would allow it/);
  });

  it("Start anyway is remembered on this computer: the not-found message isn't shown again", async () => {
    const { deps: d } = deps(world(), { env: { PATH: "" }, folder: async () => tmpdir() });
    calls.modalChoices.push(CELL_CLAUDE_TEXTS.startAnyway);
    await newCell(d);
    assert.strictEqual(d.state.get(START_ANYWAY_KEY), machineKey());
    await newCell(d);
    assert.strictEqual(calls.modals.length, 1);
    assert.strictEqual(calls.terminals.length, 2);
  });

  it("a build for another platform never counts; this machine's architecture before a newer build for another", () => {
    const root = tmpdir();
    const mine = path.join(root, "anthropic.claude-code-2.1.325-win32-x64");
    write(path.join(mine, "resources", "native-binary", "claude.exe"));
    write(path.join(root, "anthropic.claude-code-2.1.330-linux-x64", "resources", "native-binary", "claude.exe"));
    write(path.join(root, "anthropic.claude-code-2.1.329-win32-arm64", "resources", "native-binary", "claude.exe"));
    const isFile = (p: string) => fs.existsSync(p.replace(/\\/g, "/"));
    const dirs = (p: string) => { try { return fs.readdirSync(p.replace(/\\/g, "/")); } catch { return []; } };
    assert.strictEqual(bundledClaude(mine, "win32", isFile, dirs, "x64"), path.win32.join(mine, "resources", "native-binary", "claude.exe"));
    assert.strictEqual(bundledClaude(mine, "win32", isFile, dirs, "arm64"), path.win32.join(root, "anthropic.claude-code-2.1.329-win32-arm64", "resources", "native-binary", "claude.exe"));
  });

  it("macOS/Linux: a claude that isn't executable doesn't count", function () {
    if (process.platform === "win32") {
      this.skip();
    }
    const dir = path.join(tmpdir(), `anthropic.claude-code-2.1.325-${process.platform}-${process.arch}`);
    const f = write(path.join(dir, "resources", "native-binary", "claude"));
    fs.chmodSync(f, 0o644);
    assert.strictEqual(bundledClaude(dir), undefined);
    fs.chmodSync(f, 0o755);
    assert.strictEqual(bundledClaude(dir), f);
  });

  it("Windows: the CLI's record with a drive-letter folder, its project-folder name, and the same folder spelt differently", () => {
    const text = JSON.stringify({ v: 1, cells: { [IID]: { sid: SID, cwd: "C:\\Users\\kartan\\projects\\meshtest", at: 1 } } });
    const last = parseCellLastSession(text, IID, "win32")!;
    assert.strictEqual(last.cwd, "C:\\Users\\kartan\\projects\\meshtest");
    assert.strictEqual(projectDirName(last.cwd), "C--Users-kartan-projects-meshtest");
    assert.ok(samePath("c:\\users\\Kartan\\", "C:/Users/kartan", "win32"));
    assert.ok(!samePath("/home/Me", "/home/me", "linux"));
    assert.strictEqual(cellStartPlan(undefined, "/nowhere", { name: NAME, instanceId: IID }, "win32").kind, "none");
  });

  it("Run as cell goes through the same Claude Code check: a user A4SX_CLAUDE that names nothing starts nothing", async () => {
    const { deps: d } = deps(world(), { env: { A4SX_CLAUDE: path.join(tmpdir(), "gone", EXE) } });
    calls.pickQueue.push(0, []);   // the cell; the option off
    const t = await runAsCell(d, { id: "ses_1", findLocal: async () => ({ sessionId: SID, cwd: tmpdir() }) });
    assert.strictEqual(t, undefined);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.modals.map((m) => m.message), [CELL_CLAUDE_TEXTS.badUserEnv(path.join(path.dirname(d.env!.A4SX_CLAUDE!), EXE))]);
  });
});
