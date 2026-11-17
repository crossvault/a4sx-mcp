// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.8.0: "Convert to cell" and "Convert to cell in mesh…" in the context menu of a Claude Code tab (and in the
// Command Palette while such a tab is active). The tab's session is found on this computer (tabSession.ts), then
// "Run as cell in terminal" runs it in a new cell:
//   a4sx launch --new-cell [--mesh <id>] [--mesh-reduced-isolation] [--auto-allow-ipc-messages] -- --resume <session id>
// in the folder the session ran in. The options and the reduced-isolation consent are asked as in Run as cell; the
// browser approval picks the mesh. The tab stays open: the session now continues in the terminal, so the command
// offers to close the tab. saveTab.ts uses the same tab and session lookup.
// 0.9.0: "Convert into a cell…" does the same, but asks for the cell as Run as cell does: a cell you already have
//   a4sx launch --cell <cell> [--mesh ID] [flags] -- --resume <session id>
// or New cell…. convertAgents.ts does it for a session of VS Code's Agents window.
import * as vscode from "vscode";
import { CellCommandDeps } from "./cellCommands";
import { findLocalSession } from "./localSession";
import { runAsCell } from "./runAsCell";
import { chooseClaudeTab, clickedKind, editorIndexOf, readFirstPrompt, RecentSession, recentSessions, sessionsForLabel, slugOf } from "./tabSession";

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
  meshTitle: "Convert to cell in mesh",
  meshPlaceholder: "Choose the mesh for the new cell. You pick it again in the browser approval; the a4sx CLI says so if the two differ",
  noMeshes: "You have no active mesh of your own. Create one in the Meshes view first.",
};

/** The mesh pick's rows: each mesh by name (its id when it has none). */
export function meshPickItems(meshes: readonly { id: string; name?: string }[]): { label: string; description?: string; id: string }[] {
  return meshes.map((m) => (m.name ? { label: m.name, description: m.id, id: m.id } : { label: m.id, id: m.id }));
}

/** Asks for the mesh of "Convert to cell in mesh…": its id, or undefined when nothing was chosen (the user was told why). */
export type MeshPicker = () => Promise<string | undefined>;

export interface ConvertOptions {
  /** Set for "Convert to cell in mesh…". */
  pickMesh?: MeshPicker;
  /** Set for "Convert into a cell…" (0.9.0): the cell is picked as in Run as cell (one you have, or a new one). */
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

/**
 * The tab's session among this computer's transcripts. Its title names exactly one of them: with `confirm`, the
 * user confirms it (title, last change, first prompt, short id) or chooses another; without (the dry run), it is
 * used. Otherwise, also when several share the title, the user picks (the sessions with that title first, then
 * the rest, newest first). undefined: none found (the user was told), Cancel or Esc.
 */
export async function tabSessionOf(tab: vscode.Tab, projectsDir: string | undefined, pickTitle: string = CONVERT_TEXTS.pickSessionTitle, confirm?: SessionConfirm): Promise<RecentSession | undefined> {
  const t = CONVERT_TEXTS;
  const recent = await recentSessions(projectsDir);
  if (recent.length === 0) {
    await vscode.window.showErrorMessage(t.noSessions);
    return undefined;
  }
  const hits = sessionsForLabel(tab.label, recent);
  if (hits.length === 1) {
    const s = await withPrompt(hits[0]);
    if (!confirm) {
      return s;
    }
    const choice = await vscode.window.showInformationMessage(confirm.message, { modal: true, detail: sessionDetail(s) }, confirm.yes, t.chooseAnother);
    if (choice === confirm.yes) {
      return s;
    }
    if (choice !== t.chooseAnother) {
      return undefined;
    }
  }
  const rest = recent.filter((s) => !hits.includes(s));
  const listed = await Promise.all([...hits, ...rest].map(withPrompt));
  const picked = await vscode.window.showQuickPick(sessionPickItems(listed), {
    title: pickTitle, placeHolder: hits.length > 1 ? t.pickDuplicatePlaceholder(tab.label, hits.length) : t.pickSessionPlaceholder(tab.label), matchOnDescription: true, matchOnDetail: true,
  });
  return picked?.session;
}

/**
 * Convert to cell: runs the session of a Claude Code tab in a new cell, in a terminal. `args` are what VS Code
 * passed to the command (from a tab's context menu: the tab's index in its group). Resolves the terminal, or
 * undefined when nothing was started (the user was told why, or cancelled).
 */
export async function convertTabToCell(deps: CellCommandDeps, args: readonly unknown[] = [], options: ConvertOptions = {}): Promise<vscode.Terminal | undefined> {
  const tab = await claudeTabOf(args);
  if (!tab) {
    return undefined;
  }
  const session = await tabSessionOf(tab, options.projectsDir, CONVERT_TEXTS.pickSessionTitle, { message: CONVERT_TEXTS.confirm, yes: CONVERT_TEXTS.confirmYes });
  if (!session) {
    return undefined;
  }
  // `claude --resume` finds the session only in the folder it ran in, and only while that folder exists.
  const local = await findLocalSession(slugOf(session.sessionId), options.projectsDir);
  if (!local || local.sessionId !== session.sessionId) {
    await vscode.window.showErrorMessage(CONVERT_TEXTS.notResumable);
    return undefined;
  }
  let meshId: string | undefined;
  if (options.pickMesh && !options.pickCell) {
    meshId = await options.pickMesh();
    if (meshId === undefined) {
      return undefined;
    }
  }
  const terminal = await runAsCell(deps, { id: "", findLocal: async () => local },
    options.pickCell ? undefined : { choice: { kind: "new" }, ...(meshId === undefined ? {} : { meshId }) });
  if (terminal) {
    // not awaited: it never blocks the start
    void Promise.resolve(vscode.window.showInformationMessage(CONVERT_TEXTS.started, CONVERT_TEXTS.closeTab)).then((choice) => {
      if (choice === CONVERT_TEXTS.closeTab) {
        return vscode.window.tabGroups.close(tab);
      }
      return undefined;
    }).then(undefined, () => undefined);
  }
  return terminal;
}
