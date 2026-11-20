// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.8.0: "Convert to cell" and "Convert to cell in mesh…" in the context menu of a Claude Code tab (and in the
// Command Palette while such a tab is active). The tab's session is found on this computer (tabSession.ts), then
// "Run as cell in terminal" runs it in a new cell:
//   a4sx launch --new-cell [--mesh <id>] [--auto-allow-ipc-messages] -- --resume <session id>
// in the folder the session ran in. The option is asked as in Run as cell (reduced isolation: the CLI asks); the
// browser approval picks the mesh. The tab stays open: the session now continues in the terminal, so the command
// offers to close the tab. saveTab.ts uses the same tab and session lookup.
// 0.9.0: "Convert into a cell…" does the same, but asks for the cell as Run as cell does: a cell you already have
//   a4sx launch --cell <cell> [--mesh ID] [flags] -- --resume <session id>
// or New cell…. convertAgents.ts does it for a session of VS Code's Agents window.
// 0.9.1: "Convert to cell…" is one step: the tab's session is found without a question in the normal case
// (tabSession.detectTabSession), and the mesh pick names it (title, folder, short id) instead of a separate confirm,
// with "Choose another session…" as its last row. Then the new cell's name (empty: the server proposes two random
// words), then the start:
//   a4sx launch --new-cell [--as <name>] [--mesh <id>] [flags] -- --resume <session id>
// "Convert into an existing cell…" (was "Convert into a cell…") names the session in its cell pick the same way.
import * as vscode from "vscode";
import { CELL_NAME } from "./cells";
import { CellCommandDeps } from "./cellCommands";
import { findLocalSession } from "./localSession";
import { runAsCell } from "./runAsCell";
import {
  chooseClaudeTab, clickedKind, DetectContext, Detection, detectTabSession, editorIndexOf, isClaudeTab, pickOrder, readFirstPrompt, RecentSession, recentSessions, shorten, slugOf, windowFolderNames,
} from "./tabSession";

export const CONVERT_TEXTS = {
  noTab: "This works on a Claude Code tab. Open the session's tab, then run it from the tab's context menu.",
  pickTabTitle: "Convert to cell",
  pickTabPlaceholder: "Choose the Claude Code tab",
  pickClickedTabPlaceholder: "Which tab you right-clicked can't be told for sure (with split editors VS Code doesn't say which group). Choose the Claude Code tab you clicked",
  notClaudeTab: "The tab you right-clicked isn't a Claude Code tab, so nothing was done. Right-click the Claude Code tab of the session instead.",
  group: (column: number) => `editor group ${column}`,
  noSessions: "No Claude Code session was found on this computer.",
  pickSessionTitle: "Convert to cell: which session is this tab?",
  pickSessionPlaceholder: (label: string) => `The tab "${label}" couldn't be matched to one session. Choose its session`,
  pickDuplicatePlaceholder: (label: string, n: number) => `${n} sessions on this computer are titled "${label}". Choose this tab's session`,
  untitled: "(no title yet)",
  noPrompt: "(not found)",
  confirm: "Convert this session to a cell?",
  confirmYes: "Convert this session",
  chooseAnother: "Choose another…",
  detail: (title: string, changed: string, prompt: string, id: string, folder: string) =>
    `Title: ${title}\nLast changed: ${changed}\nFirst prompt: ${prompt}\nSession: ${id} (in ${folder})`,
  notResumable: "This session can't be resumed on this computer, so nothing was started: `claude --resume` needs the folder the session ran in, and that folder no longer exists, or its transcript doesn't name a folder Claude Code files it under. Save it to a4sx first (Save session to a4sx in the tab's context menu), then use Run as cell in terminal on it in My sessions: the cell fetches it from your library.",
  started: "The session now continues as a cell in the terminal. Close its tab so it isn't used in two places?",
  closeTab: "Close tab",
  pickOtherPlaceholder: "Choose the session to convert (the tab's matches first, then this window's folders)",
  pickDefaultPlaceholder: "This tab has no title yet, so its session can't be told by it. Choose its session (this window's folders first)",
  meshTitle: (title: string, id: string) => `Convert to cell: ${title} (session ${id})`,
  meshPlaceholder: (line: string) => `${line}. Choose the mesh for the new cell`,
  meshSignedOut: "Sign in to a4sx to list your meshes here",
  meshNone: "You have no active mesh of your own yet",
  meshRow: (role: string | undefined, members: string | undefined) => [role, members ? `${members} members` : undefined].filter(Boolean).join(" · "),
  meshInBrowser: "$(globe) Choose the mesh in the browser",
  meshInBrowserDetail: "The browser approval of the new cell asks for its mesh.",
  meshConfirmDetail: "You confirm the mesh in the browser approval; the a4sx CLI says so if the two differ.",
  chooseAnotherSession: "$(arrow-swap) Not this session? Choose another…",
  sessionLine: (id: string, folder: string, changed: string) => `Session ${id} in ${folder}, changed ${changed}`,
  nameTitle: (mesh: string | undefined) => (mesh ? `Name of the new cell in ${mesh}` : "Name of the new cell"),
  namePrompt: "Every member of the mesh sees this name. Leave it empty for a suggested name (two random words). a-z, 0-9 and '-', at most 48 characters; you can still change it in the browser approval.",
  namePlaceholder: "Leave empty for a suggested name",
  nameRule: "Use a-z, 0-9 and '-' (not at the start or end), at most 48 characters; or leave it empty for a suggested name.",
  nameTaken: (name: string) => `A cell named ${name} is already on this computer. Choose another name, or leave it empty for a suggested one.`,
  intoCellTitle: (title: string, id: string) => `Convert into an existing cell: ${title} (session ${id})`,
  intoCellPlaceholder: (line: string) => `${line}. Choose the cell to continue it in`,
};

/** A mesh the new cell can join, as the mesh pick shows it. */
export interface MeshRow {
  id: string;
  name?: string;
  /** My role in it: owner, admin or member. */
  role?: string;
  /** How many members it has, as the server says it ("3", "2-5", "50+"). */
  members?: string;
}

/** The meshes a new cell can join (my active ones), or why there are none to list. */
export type MeshListing = { kind: "ok"; meshes: MeshRow[] } | { kind: "signedOut" } | { kind: "error"; message: string };

/** Lists the meshes for the mesh pick; it never asks the user anything. */
export type MeshLister = () => Promise<MeshListing>;

type MeshPick = { label: string; description?: string; detail?: string; kind?: vscode.QuickPickItemKind; pick?: { kind: "mesh"; id: string; name: string } | { kind: "browser" } | { kind: "another" } };

/**
 * The mesh pick's rows: each mesh by name (its id when it has none), with my role and its member count; then
 * "Choose the mesh in the browser" (no --mesh) and "Not this session? Choose another…". When no mesh can be listed,
 * a separator says why.
 */
export function meshPickItems(listing: MeshListing): MeshPick[] {
  const t = CONVERT_TEXTS;
  const rows: MeshPick[] = [];
  if (listing.kind === "ok" && listing.meshes.length) {
    for (const m of listing.meshes) {
      const description = t.meshRow(m.role, m.members);
      rows.push({ label: `$(type-hierarchy) ${m.name ?? m.id}`, ...(description ? { description } : {}), detail: t.meshConfirmDetail, pick: { kind: "mesh", id: m.id, name: m.name ?? m.id } });
    }
  } else {
    const why = listing.kind === "signedOut" ? t.meshSignedOut : listing.kind === "error" ? listing.message : t.meshNone;
    rows.push({ label: shorten(why.replace(/\s+/g, " "), 200), kind: vscode.QuickPickItemKind.Separator });
  }
  rows.push({ label: t.meshInBrowser, detail: t.meshInBrowserDetail, pick: { kind: "browser" } });
  rows.push({ label: t.chooseAnotherSession, pick: { kind: "another" } });
  return rows;
}

/** A session as one line: short id, folder and last change ("Session 0f1e2d3c in -w-proj, changed …"). */
export function sessionLine(s: RecentSession, now: number = Date.now()): string {
  // eslint-disable-next-line no-control-regex
  return CONVERT_TEXTS.sessionLine(s.sessionId.slice(0, 8), s.folder.replace(/[\x00-\x1f\x7f-\x9f]/g, " "), changedText(s.mtime, now));
}

/**
 * The name the name box suggests: the session title's first words in the CLI's cell-name form (a-z, 0-9, '-', at
 * most 48 characters; at most 4 words and 32 characters here), with "-2", "-3", … when a cell on this computer has
 * it. "" when the title gives no such name: then the server proposes one.
 */
export function suggestedCellName(title: string | undefined, taken: ReadonlySet<string>): string {
  const words = (title ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let base = "";
  for (const w of words.slice(0, 4)) {
    const next = base ? `${base}-${w}` : w;
    if (next.length > 32) {
      break;
    }
    base = next;
  }
  if (!base || !CELL_NAME.test(base)) {
    return "";
  }
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(name) && CELL_NAME.test(name)) {
      return name;
    }
  }
  return "";
}

/** The name box's check: empty (the server proposes one), or a cell name the CLI takes and no cell here has. */
export function cellNameProblem(raw: string, taken: ReadonlySet<string>): string | undefined {
  const v = raw.trim();
  if (!v) {
    return undefined;
  }
  if (!CELL_NAME.test(v)) {
    return CONVERT_TEXTS.nameRule;
  }
  return taken.has(v) ? CONVERT_TEXTS.nameTaken(v) : undefined;
}

export interface ConvertOptions {
  /** Lists the meshes of the mesh pick (0.9.1); without it, the pick offers only the browser approval. */
  listMeshes?: MeshLister;
  /** Set for "Convert into an existing cell…" (0.9.0): the cell is picked as in Run as cell (one you have, or a new one). */
  pickCell?: boolean;
  /** Where Claude Code keeps transcripts (tests). */
  projectsDir?: string;
}

function ago(mtime: number, now: number): string {
  const min = Math.max(0, Math.round((now - mtime) / 60_000));
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
}

/** When a transcript was last written: local date and time, then how long ago ("2026-11-01 13:05, 5 min ago"). */
export function changedText(mtime: number, now: number = Date.now()): string {
  const d = new Date(mtime);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}, ${ago(mtime, now)}`;
}

/** The lines that tell a session apart: title, last change, first prompt, short id and folder. */
export function sessionDetail(s: RecentSession, now: number = Date.now()): string {
  const t = CONVERT_TEXTS;
  return t.detail(s.title ?? t.untitled, changedText(s.mtime, now), s.firstPrompt ? `"${s.firstPrompt}"` : t.noPrompt, s.sessionId.slice(0, 8),
    // eslint-disable-next-line no-control-regex
    s.folder.replace(/[\x00-\x1f\x7f-\x9f]/g, " "));
}

/** The session pick's rows: title; the folder, when it was last written and the short id; the first prompt. Newest first. */
export function sessionPickItems(sessions: readonly RecentSession[], now: number = Date.now()): { label: string; description: string; detail: string; session: RecentSession }[] {
  return sessions.map((s) => ({
    label: s.title ?? CONVERT_TEXTS.untitled,
    description: `${s.folder} · ${changedText(s.mtime, now)} · ${s.sessionId.slice(0, 8)}`,
    detail: s.firstPrompt ? `"${s.firstPrompt}"` : `First prompt: ${CONVERT_TEXTS.noPrompt}`,
    session: s,
  }));
}

/** The session with its first prompt read from its transcript. */
async function withPrompt(s: RecentSession): Promise<RecentSession> {
  const firstPrompt = await readFirstPrompt(s.file);
  return firstPrompt ? { ...s, firstPrompt } : s;
}

/**
 * The Claude Code tab a command is about (tabSession.chooseClaudeTab); when it can't be told for sure, the user
 * picks one by its label and group. undefined: there is none, the clicked tab isn't one (the user was told), or Esc.
 */
export async function claudeTabOf(args: readonly unknown[], pickTitle: string = CONVERT_TEXTS.pickTabTitle): Promise<vscode.Tab | undefined> {
  const groups = vscode.window.tabGroups;
  const index = editorIndexOf(args);
  const found = chooseClaudeTab(groups?.all ?? [], groups?.activeTabGroup, index, clickedKind(args));
  if (found.kind === "one") {
    return found.tab;
  }
  if (found.kind === "none" || found.kind === "notClaude") {
    await vscode.window.showErrorMessage(found.kind === "none" ? CONVERT_TEXTS.noTab : CONVERT_TEXTS.notClaudeTab);
    return undefined;
  }
  const items = found.tabs.map((tab) => {
    const column = tab.group?.viewColumn;
    return { label: tab.label, ...(typeof column === "number" ? { description: CONVERT_TEXTS.group(column) } : {}), tab };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: pickTitle, placeHolder: index === undefined ? CONVERT_TEXTS.pickTabPlaceholder : CONVERT_TEXTS.pickClickedTabPlaceholder, matchOnDescription: true,
  });
  return picked?.tab;
}

/** The confirm a matched session needs before a command acts on it. */
export interface SessionConfirm {
  message: string;
  yes: string;
}

/** What tells this window's Claude Code tabs apart (tabSession.DetectContext): its folders, and the other tabs' labels. */
export function windowContext(tab: vscode.Tab): DetectContext {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
  const others = (vscode.window.tabGroups?.all ?? []).flatMap((g) => g.tabs).filter((t) => t !== tab && isClaudeTab(t)).map((t) => t.label);
  return { ...(folders.length ? { window: windowFolderNames(folders) } : {}), otherLabels: others };
}

/** This computer's sessions, and which one the tab shows (detectTabSession). undefined: there is none (the user was told). */
export async function detectOf(tab: vscode.Tab, projectsDir: string | undefined): Promise<{ sessions: RecentSession[]; ctx: DetectContext; found: Detection } | undefined> {
  const ctx = windowContext(tab);
  let sessions = await recentSessions(projectsDir, undefined, ctx.window ? { exact: [...ctx.window.exact], worktreePrefixes: [...ctx.window.worktreePrefixes] } : undefined);
  if (sessions.length === 0) {
    await vscode.window.showErrorMessage(CONVERT_TEXTS.noSessions);
    return undefined;
  }
  let found = detectTabSession(tab.label, sessions, ctx);
  if (found.kind === "ask" && found.why === "noMatch") {
    // Before its session has a title, a tab's label is its prompt: read the first prompts of the untitled ones.
    sessions = await Promise.all(sessions.map((s) => (s.title ? s : withPrompt(s))));
    found = detectTabSession(tab.label, sessions, ctx);
  }
  return { sessions, ctx, found };
}

/** The session pick (the label's matches first, then this window's folders); undefined: Esc. */
export async function askSession(tab: vscode.Tab, sessions: readonly RecentSession[], found: Detection, ctx: DetectContext, pickTitle: string): Promise<RecentSession | undefined> {
  const t = CONVERT_TEXTS;
  const matches = found.kind === "ask" ? found.matches : [found.session];
  const listed = await Promise.all(pickOrder(sessions, matches, ctx).map((s) => (s.firstPrompt ? s : withPrompt(s))));
  // "one": the user asked for another session than the one found
  const placeHolder = found.kind === "one" ? t.pickOtherPlaceholder
    : found.why === "duplicate" ? t.pickDuplicatePlaceholder(tab.label, found.matches.length)
      : found.why === "defaultTitle" ? t.pickDefaultPlaceholder : t.pickSessionPlaceholder(tab.label);
  const picked = await vscode.window.showQuickPick(sessionPickItems(listed), { title: pickTitle, placeHolder, matchOnDescription: true, matchOnDetail: true });
  return picked?.session;
}

/**
 * The tab's session among this computer's transcripts (detectTabSession). When it names one: with `confirm`, the
 * user confirms it (title, last change, first prompt, short id) or chooses another; without, it is used. Otherwise
 * the user picks (the label's matches first). undefined: none found (the user was told), Cancel or Esc.
 */
export async function tabSessionOf(tab: vscode.Tab, projectsDir: string | undefined, pickTitle: string = CONVERT_TEXTS.pickSessionTitle, confirm?: SessionConfirm): Promise<RecentSession | undefined> {
  const d = await detectOf(tab, projectsDir);
  if (!d) {
    return undefined;
  }
  if (d.found.kind === "one") {
    const s = await withPrompt(d.found.session);
    if (!confirm) {
      return s;
    }
    const choice = await vscode.window.showInformationMessage(confirm.message, { modal: true, detail: sessionDetail(s) }, confirm.yes, CONVERT_TEXTS.chooseAnother);
    if (choice === confirm.yes) {
      return s;
    }
    if (choice !== CONVERT_TEXTS.chooseAnother) {
      return undefined;
    }
  }
  return askSession(tab, d.sessions, d.found, d.ctx, pickTitle);
}

/** The names of the cells on this computer, as the Cells view last read them (a new cell can't take one). */
function localCellNames(deps: CellCommandDeps): Set<string> {
  try {
    return new Set(deps.provider.cells.map((c) => c.name));
  } catch {
    return new Set();
  }
}

/**
 * Convert to cell…: runs the session of a Claude Code tab in a new cell, in a terminal. `args` are what VS Code
 * passed to the command (from a tab's context menu: the tab's index in its group). The mesh pick names the session
 * it found, and offers another; then the cell's name. With `pickCell`, the cell pick of Run as cell instead, naming
 * the session in its title. Resolves the terminal, or undefined when nothing was started (the user was told why,
 * or cancelled).
 */
export async function convertTabToCell(deps: CellCommandDeps, args: readonly unknown[] = [], options: ConvertOptions = {}): Promise<vscode.Terminal | undefined> {
  const t = CONVERT_TEXTS;
  const tab = await claudeTabOf(args);
  if (!tab) {
    return undefined;
  }
  const d = await detectOf(tab, options.projectsDir);
  if (!d) {
    return undefined;
  }
  let session = d.found.kind === "one" ? await withPrompt(d.found.session) : await askSession(tab, d.sessions, d.found, d.ctx, t.pickSessionTitle);
  if (!session) {
    return undefined;
  }
  let meshId: string | undefined;
  let cellName: string | undefined;
  if (!options.pickCell) {
    const listing: Promise<MeshListing> = options.listMeshes ? options.listMeshes().catch((e: unknown) => ({ kind: "error" as const, message: e instanceof Error ? e.message : String(e) }))
      : Promise.resolve({ kind: "ok", meshes: [] });
    let meshName: string | undefined;
    for (;;) {
      const picked = await vscode.window.showQuickPick<MeshPick>(listing.then((l): MeshPick[] => meshPickItems(l)), {
        title: t.meshTitle(session.title ?? t.untitled, session.sessionId.slice(0, 8)), placeHolder: t.meshPlaceholder(sessionLine(session)), matchOnDescription: true, ignoreFocusOut: true,
      });
      if (!picked?.pick) {
        return undefined;
      }
      if (picked.pick.kind === "another") {
        session = await askSession(tab, d.sessions, d.found.kind === "one" ? d.found : { kind: "one", session, how: "title" }, d.ctx, t.pickSessionTitle);
        if (!session) {
          return undefined;
        }
        continue;
      }
      if (picked.pick.kind === "mesh") {
        meshId = picked.pick.id;
        meshName = picked.pick.name;
      }
      break;
    }
    const taken = localCellNames(deps);
    const raw = await vscode.window.showInputBox({
      title: t.nameTitle(meshName), prompt: t.namePrompt, value: suggestedCellName(session.title, taken), placeHolder: t.namePlaceholder,
      validateInput: (v: string) => cellNameProblem(v, taken), ignoreFocusOut: true,
    });
    if (raw === undefined) {
      return undefined;
    }
    cellName = raw.trim() || undefined;
  }
  // `claude --resume` finds the session only in the folder it ran in, and only while that folder exists.
  const local = await findLocalSession(slugOf(session.sessionId), options.projectsDir, session.folder);
  // the same id in another folder would be another transcript: only the one shown to the user
  if (!local || local.sessionId !== session.sessionId || local.folder !== session.folder) {
    await vscode.window.showErrorMessage(t.notResumable);
    return undefined;
  }
  const terminal = await runAsCell(deps, { id: "", findLocal: async () => local },
    options.pickCell ? undefined : { choice: { kind: "new" }, ...(meshId === undefined ? {} : { meshId }), ...(cellName === undefined ? {} : { cellName }) },
    options.pickCell ? { title: t.intoCellTitle(session.title ?? t.untitled, session.sessionId.slice(0, 8)), placeHolder: t.intoCellPlaceholder(sessionLine(session)) } : undefined);
  if (terminal) {
    // not awaited: it never blocks the start
    void Promise.resolve(vscode.window.showInformationMessage(t.started, t.closeTab)).then((choice) => {
      if (choice === t.closeTab) {
        return vscode.window.tabGroups.close(tab);
      }
      return undefined;
    }).then(undefined, () => undefined);
  }
  return terminal;
}
