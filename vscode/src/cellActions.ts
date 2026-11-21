// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// a4sx #2301 E5/E6 (0.9.4): four more actions on the rows of the Cells view. Each is a thin wrapper over a command the
// a4sx CLI already has; none adds a request the view makes by itself (nothing here runs on a timer or on a refresh).
//   on a cell on another machine:
//     "Last messages"                 a4sx mesh deliveries <instance id> --mesh <mesh id> --last 10
//                                     (this computer's own delivery records; the CLI asks no server for them)
//     "Why can or can't I message it" a4sx mesh policy <mesh id> --explain <a cell here> <that cell>
//   on a cell stored on this computer:
//     "Save its conversation"         a4sx push <the cell's last transcript> [--into <library entry>], in a terminal.
//                                     The copy the CLI uploads is scrubbed; the confirmation says so before anything
//                                     runs. A later save of the same conversation becomes a new version of its entry,
//                                     found as "Save session to a4sx" finds it (saveTab.ts).
//     "Start from a saved session…"   pick a library entry, then Run as cell in terminal with this cell preselected
//                                     (runAsCell.ts): the CLI's own questions are asked in the terminal as always.
// There is no "Hand off" here on purpose: a scrubbed copy is not an exact copy, so a cell continued from it on
// another computer may not read what really happened. It waits for the CLI's as-is mode (a4sx #2292).
// Every CLI call is an argv array; what is read back is only shown, never run.
import * as vscode from "vscode";
import { SessionRow } from "./api";
import { CELL_CMD_TEXTS, CellCommandDeps, cliErrorText, ensureCli } from "./cellCommands";
import { cellStartPlan } from "./cellResume";
import { CELL_NAME, cellsListDir, CLI_MESH_ID, INSTANCE_ID, LocalCell, showText, startableCell } from "./cells";
import { LocalCellItem, RemoteCellItem } from "./cellsView";
import { CLI_NAME } from "./cli";
import { findLocalSession, librarySlug } from "./localSession";
import { claudeProjectsDir } from "./nativeSeed";
import { openCommandTerminal } from "./resume";
import { runAsCell, RunAsCellSession } from "./runAsCell";
import { entryPickItems, LibraryUnreadable, pushArgs, SAVE_TAB_TEXTS, SavedEntry, SavedLookup } from "./saveTab";
import { slugOf } from "./tabSession";

export const CMD_CELL_MESSAGES = "a4sx.cellLastMessages";
export const CMD_CELL_EXPLAIN = "a4sx.cellWhyMessage";
export const CMD_CELL_SAVE = "a4sx.saveCellConversation";
export const CMD_CELL_FROM_SAVED = "a4sx.startCellFromSaved";

/** How many results per cell "Last messages" asks for. */
export const MESSAGES_LAST = 10;

export const CELL_ACTION_TEXTS = {
  messagesTitle: (name: string) => `Last messages with «${name}»`,
  messagesNone: (name: string) => `No messages between your cells on this computer and «${name}» are recorded here.`,
  messagesWhat: "read the last messages",
  badPeer: "This cell can't be asked about from here: its id or its mesh isn't one the a4sx CLI accepts.",
  whyTitle: (from: string, to: string) => `Can «${from}» message «${to}»?`,
  whyPickTitle: (to: string) => `Which of your cells here should message «${to}»?`,
  whyPickPlaceholder: "The mesh's rules are asked for this sender",
  whyNoLocal: "No cell of this mesh is stored on this computer, so there is no sender to ask about.",
  whyWhat: "ask the mesh's rules",
  whyNothing: "The a4sx CLI gave no answer.",
  saveNone: (name: string) => `«${name}» has no conversation recorded on this computer yet, so there is nothing to save.`,
  saveGone: (name: string, short: string) =>
    `«${name}»'s last conversation (session ${short}) can't be found on this computer any more, so it can't be saved.`,
  saveTitle: (name: string) => `Save «${name}»'s conversation to your a4sx library?`,
  saveDetail:
    "The saved copy is scrubbed: before it uploads, the a4sx CLI removes secrets and replaces e-mail addresses, host " +
    "names, IP addresses and your home folder in paths. The conversation on this computer stays as it is. A cell " +
    "started later from the saved copy reads the replaced values, not the real ones.",
  save: "Save scrubbed copy",
  saveTerminal: (name: string) => `a4sx: save ${name}`,
  saveBanner: (name: string, short: string, folder: string) =>
    `Saving a scrubbed copy of «${name}»'s conversation (session ${short}, which ran in ${folder}):\r\n`,
  fromSavedRunning: (name: string) => `«${name}» is running on this computer. Stop it first, then start it from a saved session.`,
  fromSavedStandalone: (name: string) => `The cell «${name}» isn't in a mesh yet, so it can't be started.`,
  fromSavedTitle: (name: string) => `Start «${name}» from a saved session`,
  fromSavedPlaceholder: "The cell continues from this computer's copy of that session when it is here, else from the library's scrubbed copy",
  libraryEmpty: "Your a4sx library holds no saved sessions yet.",
  fromSavedSignedOut:
    "Nothing was started: you aren't signed in to a4sx in the sidebar, or your sign-in is no longer valid, so the " +
    "extension can't read your library. Sign in under My sessions, then try again.",
  fromSavedUnreadable: (reason: string) => `Nothing was started: your a4sx library couldn't be read (${reason}).`,
  untitled: "(untitled)",
};

export interface CellActionDeps extends CellCommandDeps {
  /** Shows text the CLI printed (the extension's output channel): a heading and the lines under it. */
  show(title: string, text: string): void;
}

/** `mesh deliveries <instance id> --mesh <mesh id> --last N`; undefined for an id the CLI doesn't take. */
export function deliveriesArgs(instanceId: string, meshId: string, last: number = MESSAGES_LAST): string[] | undefined {
  if (!INSTANCE_ID.test(instanceId) || !CLI_MESH_ID.test(meshId) || !Number.isInteger(last) || last < 1 || last > 200) {
    return undefined;
  }
  return ["mesh", "deliveries", instanceId, "--mesh", meshId, "--last", String(last)];
}

/**
 * `mesh policy <mesh id> --explain FROM TO` by instance ids (review: names aren't unique in a mesh, and the CLI
 * refuses an ambiguous one); undefined for an id or mesh id the CLI doesn't take.
 */
export function explainArgs(meshId: string, from: string, to: string): string[] | undefined {
  return CLI_MESH_ID.test(meshId) && INSTANCE_ID.test(from) && INSTANCE_ID.test(to) ? ["mesh", "policy", meshId, "--explain", from, to] : undefined;
}

/** What the CLI printed, for showing: control characters dropped (line ends kept), at most `max` characters. */
export function shownOutput(text: string, max = 20_000): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** The senders "Why can or can't I message it" offers: this computer's cells of that mesh, the default first. */
export function senderChoices(cells: readonly LocalCell[], meshId: string): LocalCell[] {
  return cells.filter((c) => c.meshId === meshId && startableCell(c) && CELL_NAME.test(c.name))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

/** Last messages: what happened to the last messages between this computer's cells and that cell. */
export async function cellLastMessages(deps: CellActionDeps, item: RemoteCellItem | undefined): Promise<boolean> {
  if (!(item instanceof RemoteCellItem)) {
    return false;
  }
  const t = CELL_ACTION_TEXTS;
  const args = deliveriesArgs(item.peer.instanceId, item.meshId);
  if (!args) {
    await vscode.window.showErrorMessage(t.badPeer);
    return false;
  }
  const cli = await ensureCli(deps);
  if (!cli) {
    return false;
  }
  const out = await deps.run(cli, args, 30_000);
  if (out.code !== 0) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.cliFailed(t.messagesWhat, cliErrorText(out)));
    return false;
  }
  const name = showText(item.peer.name) ?? item.peer.instanceId;
  deps.show(t.messagesTitle(name), shownOutput(out.stdout) || t.messagesNone(name));
  return true;
}

/** Why can or can't I message it: the rule that decides, as `mesh policy --explain` says it. */
export async function cellWhyMessage(deps: CellActionDeps, item: RemoteCellItem | undefined): Promise<boolean> {
  if (!(item instanceof RemoteCellItem)) {
    return false;
  }
  const t = CELL_ACTION_TEXTS;
  const senders = senderChoices(deps.provider.cells, item.meshId);
  if (senders.length === 0) {
    await vscode.window.showErrorMessage(t.whyNoLocal);
    return false;
  }
  let from = senders[0];
  if (senders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      senders.map((c) => ({ label: c.name, description: c.isDefault ? "default" : undefined, cell: c })),
      { title: t.whyPickTitle(showText(item.peer.name) ?? item.peer.instanceId), placeHolder: t.whyPickPlaceholder });
    if (!picked) {
      return false;
    }
    from = picked.cell;
  }
  const args = explainArgs(item.meshId, from.instanceId, item.peer.instanceId);
  if (!args) {
    await vscode.window.showErrorMessage(t.badPeer);
    return false;
  }
  const cli = await ensureCli(deps);
  if (!cli) {
    return false;
  }
  const out = await deps.run(cli, args, 30_000);
  if (out.code !== 0) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.cliFailed(t.whyWhat, cliErrorText(out)));
    return false;
  }
  const text = shownOutput(out.stdout) || t.whyNothing;
  if (!text.includes("\n") && text.length <= 300) {
    void vscode.window.showInformationMessage(text);   // the usual answer is one sentence
  } else {
    deps.show(t.whyTitle(from.name, item.peer.name), text);
  }
  return true;
}

export interface SaveCellOptions {
  /** Finds the conversation in the library, so a later save becomes a new version of its entry (saveTab.SavedLookup). */
  saved?: SavedLookup;
}

/**
 * Save its conversation: `a4sx push` of the cell's last transcript on this computer, in a terminal, after a
 * confirmation that says the saved copy is scrubbed. Resolves the terminal, or undefined when nothing was started.
 */
export async function saveCellConversation(deps: CellActionDeps, item: LocalCellItem | undefined, options: SaveCellOptions = {}): Promise<vscode.Terminal | undefined> {
  if (!(item instanceof LocalCellItem)) {
    return undefined;
  }
  const t = CELL_ACTION_TEXTS;
  const cell = item.cell;
  const platform = deps.platform ?? process.platform;
  const stateDir = deps.stateDir ?? cellsListDir(deps.env ?? process.env, platform, deps.home);
  const plan = cellStartPlan(stateDir, deps.claudeProjects ?? claudeProjectsDir(deps.env ?? process.env, deps.home), cell, platform);
  if (plan.kind === "none") {
    void vscode.window.showInformationMessage(t.saveNone(cell.name));
    return undefined;
  }
  const short = plan.sessionId.slice(0, 8);
  if (plan.kind !== "resume") {
    await vscode.window.showErrorMessage(t.saveGone(cell.name, short));
    return undefined;
  }
  const choice = await vscode.window.showWarningMessage(t.saveTitle(cell.name), { modal: true, detail: t.saveDetail }, t.save);
  if (choice !== t.save) {
    return undefined;
  }
  const cli = await ensureCli(deps);
  if (!cli) {
    return undefined;
  }
  let into: string | undefined;
  if (options.saved) {
    let entries: SavedEntry[];
    try {
      entries = await options.saved(slugOf(plan.sessionId));
    } catch (e) {
      const signedOut = e instanceof LibraryUnreadable && e.signedOut;
      await vscode.window.showErrorMessage(signedOut ? SAVE_TAB_TEXTS.signedOut : SAVE_TAB_TEXTS.libraryUnreadable(e instanceof Error && e.message ? e.message : "unknown error"));
      return undefined;
    }
    if (entries.length === 1) {
      into = entries[0].id;
    } else if (entries.length > 1) {
      const picked = await vscode.window.showQuickPick(entryPickItems(entries), { title: SAVE_TAB_TEXTS.pickEntryTitle, placeHolder: SAVE_TAB_TEXTS.pickEntryPlaceholder, matchOnDescription: true });
      if (!picked) {
        return undefined;
      }
      into = picked.into;
    }
  }
  let args = pushArgs(plan.transcript, into === undefined ? {} : { into });
  if (!args) {
    const again = await vscode.window.showErrorMessage(SAVE_TAB_TEXTS.badEntry((showText(into, 80) ?? "")), SAVE_TAB_TEXTS.saveAsNew);
    if (again !== SAVE_TAB_TEXTS.saveAsNew) {
      return undefined;
    }
    args = pushArgs(plan.transcript)!;
  }
  const terminal = openCommandTerminal(t.saveTerminal(cell.name), cli, CLI_NAME, args, undefined, undefined, t.saveBanner(cell.name, short, showText(plan.cwd, 300) ?? plan.cwd));
  deps.terminals.add(terminal);
  return terminal;
}

/** The saved-session pick's rows: label (else title, else id); title and last change; newest first. */
export function savedSessionItems(rows: readonly SessionRow[]): { label: string; description: string; row: SessionRow }[] {
  const when = (r: SessionRow) => (typeof r.updated_at === "string" ? r.updated_at : typeof r.created_at === "string" ? r.created_at : "");
  return [...rows].sort((a, b) => when(b).localeCompare(when(a))).map((r) => {
    const label = showText(r.label) ?? showText(r.title, 80) ?? showText(r.id) ?? CELL_ACTION_TEXTS.untitled;
    return {
      label,
      description: [r.label ? showText(r.title, 80) : undefined, showText(when(r).replace("T", " ").slice(0, 16), 20)].filter(Boolean).join(" · "),
      row: r,
    };
  });
}

/** A library row as Run as cell in terminal takes it (extension.runAsCellSession, for a row instead of a tree item). */
export function savedRowSession(row: SessionRow, projectsDir?: string): RunAsCellSession {
  return {
    id: row.id,
    findLocal: async () => {
      const slug = librarySlug(row);
      return slug ? findLocalSession(slug, projectsDir) : undefined;
    },
  };
}

export interface FromSavedOptions {
  /** The library's entries, read like My sessions; rejects (LibraryUnreadable) when they can't be read. */
  sessions(): Promise<SessionRow[]>;
  /** Where Claude Code keeps transcripts (tests). */
  projectsDir?: string;
}

/**
 * Start from a saved session…: pick a library entry, then Run as cell in terminal with this cell preselected. Resolves
 * the terminal, or undefined when nothing was started (the user was told why, or cancelled).
 */
export async function startCellFromSaved(deps: CellActionDeps, item: LocalCellItem | undefined, options: FromSavedOptions): Promise<vscode.Terminal | undefined> {
  if (!(item instanceof LocalCellItem)) {
    return undefined;
  }
  const t = CELL_ACTION_TEXTS;
  const cell = item.cell;
  if (!startableCell(cell)) {
    await vscode.window.showErrorMessage(t.fromSavedStandalone(cell.name));
    return undefined;
  }
  if (cell.localState === "running") {
    await vscode.window.showErrorMessage(t.fromSavedRunning(cell.name));
    return undefined;
  }
  let rows: SessionRow[];
  try {
    rows = await options.sessions();
  } catch (e) {
    const signedOut = e instanceof LibraryUnreadable && e.signedOut;
    await vscode.window.showErrorMessage(signedOut ? t.fromSavedSignedOut : t.fromSavedUnreadable(e instanceof Error && e.message ? e.message : "unknown error"));
    return undefined;
  }
  if (rows.length === 0) {
    void vscode.window.showInformationMessage(t.libraryEmpty);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(savedSessionItems(rows), { title: t.fromSavedTitle(cell.name), placeHolder: t.fromSavedPlaceholder, matchOnDescription: true });
  if (!picked) {
    return undefined;
  }
  return runAsCell(deps, savedRowSession(picked.row, options.projectsDir), { choice: { kind: "cell", cell } });
}
