// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.8.0: "Convert to cell" and "Convert to cell in mesh…" in the context menu of a Claude Code tab (and in the
// Command Palette while such a tab is active). The tab's session is found on this computer (tabSession.ts), then
// "Run as cell in terminal" runs it in a new cell:
//   a4sx launch --new-cell [--mesh <id>] [--mesh-reduced-isolation] [--auto-allow-ipc-messages] -- --resume <session id>
// in the folder the session ran in. The options and the reduced-isolation consent are asked as in Run as cell; the
// browser approval picks the mesh. The tab stays open: the session now continues in the terminal, so the command
// offers to close the tab. saveTab.ts uses the same tab and session lookup.
import * as vscode from "vscode";
import { CellCommandDeps } from "./cellCommands";
import { findLocalSession } from "./localSession";
import { runAsCell } from "./runAsCell";
import { chooseClaudeTab, clickedKind, editorIndexOf, RecentSession, recentSessions, sessionsForLabel, slugOf } from "./tabSession";

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
  untitled: "(no title yet)",
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
  /** Where Claude Code keeps transcripts (tests). */
  projectsDir?: string;
}

function ago(mtime: number, now: number): string {
  const min = Math.max(0, Math.round((now - mtime) / 60_000));
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
}

/** The session pick's rows: title, then the session's folder name and when it was last written. Newest first. */
export function sessionPickItems(sessions: readonly RecentSession[], now: number = Date.now()): { label: string; description: string; session: RecentSession }[] {
  return sessions.map((s) => ({
    label: s.title ?? CONVERT_TEXTS.untitled,
    description: `${s.folder} · ${ago(s.mtime, now)} · ${s.sessionId.slice(0, 8)}`,
    session: s,
  }));
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

/**
 * The tab's session among this computer's transcripts: by its title when that names one session, else the user's
 * pick (the sessions with that title first, then the rest, newest first). undefined: none found (the user was
 * told), or Esc.
 */
export async function tabSessionOf(tab: vscode.Tab, projectsDir: string | undefined, pickTitle: string = CONVERT_TEXTS.pickSessionTitle): Promise<RecentSession | undefined> {
  const t = CONVERT_TEXTS;
  const recent = await recentSessions(projectsDir);
  if (recent.length === 0) {
    await vscode.window.showErrorMessage(t.noSessions);
    return undefined;
  }
  const hits = sessionsForLabel(tab.label, recent);
  if (hits.length === 1) {
    return hits[0];
  }
  const rest = recent.filter((s) => !hits.includes(s));
  const picked = await vscode.window.showQuickPick(sessionPickItems([...hits, ...rest]), {
    title: pickTitle, placeHolder: t.pickSessionPlaceholder(tab.label), matchOnDescription: true,
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
  const session = await tabSessionOf(tab, options.projectsDir);
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
  if (options.pickMesh) {
    meshId = await options.pickMesh();
    if (meshId === undefined) {
      return undefined;
    }
  }
  const terminal = await runAsCell(deps, { id: "", findLocal: async () => local }, { choice: { kind: "new" }, ...(meshId === undefined ? {} : { meshId }) });
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
