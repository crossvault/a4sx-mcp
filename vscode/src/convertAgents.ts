// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.9.0: "a4sx: Convert an Agents-window session to a cell…" in the Command Palette. VS Code's Agents window has no
// stable API for its sessions (its session menus are proposed API, which a Marketplace extension can't use), so this
// is a Command Palette entry, not a menu entry. It lists this computer's Claude Agent SDK sessions (agentSessions.ts:
// the Agents window's Claude sessions are among them) by title, folder and when they last changed. The user picks
// one and confirms it (title, last change, first prompt, short id, folder); then "Run as cell in terminal" runs it:
//   a4sx launch --cell <cell> [--mesh ID] [flags] -- --resume <session id>    (a cell you already have)
//   a4sx launch --new-cell [flags] -- --resume <session id>                    (New cell…)
// in the folder the session ran in. The session id comes from the transcript's file name, checked again just before
// the start (findLocalSession); it never comes from anything the user typed.
import * as vscode from "vscode";
import { AgentSession, agentSdkSessions } from "./agentSessions";
import { CellCommandDeps } from "./cellCommands";
import { changedText, CONVERT_TEXTS, sessionDetail } from "./convertTab";
import { findLocalSession } from "./localSession";
import { runAsCell } from "./runAsCell";
import { slugOf } from "./tabSession";

export const AGENTS_TEXTS = {
  noSessions: "No Claude session of VS Code's Agents window was found on this computer, so nothing was started. The list reads the sessions the Claude Agent SDK saved under this computer's Claude Code folder (CLAUDE_CONFIG_DIR, or ~/.claude); a session on a remote agent host isn't there. Start or continue the session in the Agents window on this computer, then run this again.",
  pickTitle: "Convert an Agents-window session to a cell",
  pickPlaceholder: "Choose the session. Listed: Claude sessions started through the Claude Agent SDK on this computer, the Agents window's among them, newest first",
  untitled: "(no title yet)",
  noFolder: "(folder not named)",
  confirm: "Convert this Agents-window session to a cell?",
  confirmYes: "Convert this session",
  twoPlaces: "The cell continues this session in a terminal. Archive or close it in the Agents window first: if it goes on there too, two programs write the same session.",
  notResumable: "This session can't be resumed on this computer, so nothing was started: `claude --resume` needs the folder the session ran in, and that folder no longer exists, or its transcript doesn't name a folder Claude Code files it under. Continue it in the Agents window instead, or recreate the folder and run this again.",
  started: "The session now continues as a cell in the terminal. Archive it in the Agents window so it isn't continued in two places.",
};

/** The session pick's rows: title (else the first prompt); folder, last change and short id; the first prompt. Newest first. */
export function agentPickItems(sessions: readonly AgentSession[], now: number = Date.now()): { label: string; description: string; detail: string; session: AgentSession }[] {
  const t = AGENTS_TEXTS;
  return sessions.map((s) => ({
    label: s.title ?? s.firstPrompt ?? t.untitled,
    description: `${s.cwd ?? t.noFolder} · ${changedText(s.mtime, now)} · ${s.sessionId.slice(0, 8)}`,
    detail: s.firstPrompt ? `"${s.firstPrompt}"` : `First prompt: ${CONVERT_TEXTS.noPrompt}`,
    session: s,
  }));
}

export interface ConvertAgentsOptions {
  /** Where Claude Code keeps transcripts (tests). */
  projectsDir?: string;
}

/**
 * The session the user means: picked from the list, then confirmed. "Choose another…" goes back to the list.
 * undefined: none found (the user was told), Esc or Cancel.
 */
export async function pickAgentSession(projectsDir: string | undefined): Promise<AgentSession | undefined> {
  const t = AGENTS_TEXTS;
  const sessions = await agentSdkSessions(projectsDir);
  if (sessions.length === 0) {
    await vscode.window.showErrorMessage(t.noSessions);
    return undefined;
  }
  for (;;) {
    const picked = await vscode.window.showQuickPick(agentPickItems(sessions), {
      title: t.pickTitle, placeHolder: t.pickPlaceholder, matchOnDescription: true, matchOnDetail: true,
    });
    if (!picked) {
      return undefined;
    }
    const choice = await vscode.window.showInformationMessage(t.confirm, { modal: true, detail: `${sessionDetail(picked.session)}\n\n${t.twoPlaces}` }, t.confirmYes, CONVERT_TEXTS.chooseAnother);
    if (choice === t.confirmYes) {
      return picked.session;
    }
    if (choice !== CONVERT_TEXTS.chooseAnother) {
      return undefined;
    }
  }
}

/**
 * Convert an Agents-window session to a cell: the user picks and confirms the session, then a cell they already have
 * or a new one (Run as cell's pick). Resolves the terminal, or undefined when nothing was started (the user was told
 * why, or cancelled).
 */
export async function convertAgentSessionToCell(deps: CellCommandDeps, options: ConvertAgentsOptions = {}): Promise<vscode.Terminal | undefined> {
  const session = await pickAgentSession(options.projectsDir);
  if (!session) {
    return undefined;
  }
  // `claude --resume` finds the session only in the folder it ran in, and only while that folder exists.
  const local = await findLocalSession(slugOf(session.sessionId), options.projectsDir, session.folder);
  // the same id in another folder would be another transcript: only the one the user confirmed
  if (!local || local.sessionId !== session.sessionId || local.folder !== session.folder) {
    await vscode.window.showErrorMessage(AGENTS_TEXTS.notResumable);
    return undefined;
  }
  const terminal = await runAsCell(deps, { id: "", findLocal: async () => local });
  if (terminal) {
    void Promise.resolve(vscode.window.showInformationMessage(AGENTS_TEXTS.started)).then(undefined, () => undefined);   // never blocks the start
  }
  return terminal;
}
