// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// a4sx #2301 E5/E6 (0.9.4): four more actions on the rows of the Cells view. Each is a thin wrapper over a command the
// a4sx CLI already has; none adds a request the view makes by itself (nothing here runs on a timer or on a refresh).
//   on a cell on another machine:
//     "Last messages"                 a4sx mesh deliveries <instance id> --mesh <mesh id> --last 10
//                                     (this computer's own delivery records, kept by its running cells; the CLI asks
//                                     no server for them, and "no delivery results" is an answer, not a failure)
//     "Why can or can't I message it" a4sx mesh policy <mesh id> --explain <a cell here> <that cell>
//   on a cell stored on this computer:
//     "Save its conversation"         a4sx push <the cell's last transcript> --into <id of «<cell>-backup»>, or
//                                     --label <cell>-backup --title "<cell>: backups" for the first save, in a
//                                     terminal. The copy the CLI uploads is scrubbed; the confirmation says so before
//                                     anything runs. #2309 (o): one entry per cell, the name the herdr deck uses too.
//     "Start from a saved session…"   pick a library entry, then Run as cell in terminal with this cell preselected
//                                     (runAsCell.ts): the CLI's own questions are asked in the terminal as always.
// There is no "Hand off" here on purpose: a scrubbed copy is not an exact copy, so a cell continued from it on
// another computer may not read what really happened. It waits for the CLI's as-is mode (a4sx #2292).
// Every CLI call is an argv array; what is read back is only shown, never run.
import * as vscode from "vscode";
import { SessionRow } from "./api";
import { CELL_CMD_TEXTS, CellCommandDeps, cliErrorText, ensureCli, setupAgentsWindow, startAgentHost } from "./cellCommands";
import { cellStartPlan } from "./cellResume";
import { CELL_NAME, CELLS_LIST_ARGS, cellsListDir, cellStopArgs, CLI_MESH_ID, INSTANCE_ID, LocalCell, showText, startableCell } from "./cells";
import { AgentHostStatus, AGENT_HOST_STATUS_ARGS, AGENT_HOST_TEXTS, agentsWindowSetUp, isOpen, lacksAgentHost, parseAgentHostStatus } from "./agentHostStatus";
import { CMD_STOP_CELL, LocalCellItem, RemoteCellItem } from "./cellsView";
import { CLI_NAME } from "./cli";
import { parseCellsAnswer } from "./cliJson";
import { findLocalSession, librarySlug } from "./localSession";
import { claudeProjectsDir } from "./nativeSeed";
import { openCommandTerminal } from "./resume";
import { runAsCell, RunAsCellSession } from "./runAsCell";
import { cellBackupLabel, cellBackupTitle, entryPickItems, LibraryUnreadable, pushArgs, SAVE_TAB_TEXTS, SavedEntry } from "./saveTab";

export const CMD_CELL_MESSAGES = "a4sx.cellLastMessages";
export const CMD_CELL_EXPLAIN = "a4sx.cellWhyMessage";
export const CMD_CELL_SAVE = "a4sx.saveCellConversation";
export const CMD_CELL_FROM_SAVED = "a4sx.startCellFromSaved";
export const CMD_CELL_OPEN_AGENTS = "a4sx.openCellInAgentsWindow";

/** The CLI's MESH_TEXT_DELIVERIES_NONE (it exits non-zero with it): nothing recorded, which is no failure. */
const NO_DELIVERIES = /^no delivery results for /;
/** How many results per cell "Last messages" asks for. */
export const MESSAGES_LAST = 10;

export const CELL_ACTION_TEXTS = {
  messagesTitle: (name: string) => `Last messages with «${name}»`,
  messagesNone: (name: string) =>
    `No messages with «${name}» are recorded on this computer. Each running cell here keeps the results of its last ` +
    "messages, and they go when it stops.",
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
  savePickTitle: (name: string) => `Save «${name}»'s conversation: which library entry?`,
  savePickPlaceholder: (label: string) => `Your library has more than one entry named «${label}». Choose the one that gets the new version`,
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
  agentsBad: "This cell can't be opened in the Agents window from here: its id isn't one the a4sx CLI accepts.",
  agentsStandalone: (name: string) => `The cell «${name}» isn't in a mesh yet, so the agent host doesn't serve it.`,
  agentsNoStatus: "This a4sx CLI can't say whether its agent host runs (it has no agent-host status command). Update a4sx, then try again.",
  agentsStatusWhat: "read the agent host's status",
  agentsNotSetUp: "VS Code's Agents window isn't set up for the a4sx agent host on this computer yet. Set it up now? a4sx then starts the agent host and opens the cell; nothing is changed if you cancel.",
  agentsNotOpened: "VS Code didn't open the link to the Agents window.",
  // review: a cell running in a terminal here can't also run in the Agents window (one launch per cell)
  agentsRunningElsewhere: (name: string) =>
    `«${name}» is running in a terminal on this computer, so the Agents window can't start it too. Stop it there, then choose Open in Agents window again.`,
  stopIt: "Stop it",
  /** a4sx #2309 (m), cell01: terminal → Agents window took three steps; one action does the stop and the open */
  moveIt: "Move it into the Agents window",
  moving: (name: string) => `Moving «${name}» into the Agents window: stopping it in its terminal, then opening it in the Agents window…`,
  moveStillRunning: (name: string) =>
    `«${name}» still runs in its terminal after the stop, so the Agents window wasn't opened. Close that terminal, then choose Open in Agents window again.`,
  // review: a stop that worked, then no cell list to confirm it: said, never a silent end
  moveUnread: (name: string) =>
    `Stopped «${name}», but the cell list couldn't be read, so the Agents window wasn't opened. Choose Open in Agents window again.`,
  moveGone: (name: string) =>
    `Stopped «${name}», but it is no longer in this computer's cell list, so the Agents window wasn't opened. Refresh the Cells view.`,
  moveCancelled: (name: string) =>
    `Stopped waiting. «${name}» may already be stopped; choose Open in Agents window again to open it there.`,
  agentsStarting: (name: string) => `Starting the a4sx agent host, then opening «${name}» in the Agents window…`,
  agentsHostEnded: (why: string) =>
    `The a4sx agent host stopped before it answered (${why}), so the Agents window wasn't opened. Its terminal "a4sx: agent host" has the details; choose Open in Agents window again once that is fixed.`,
  agentsHostExited: (code: number | undefined) => (code === undefined ? "its terminal ended" : `its terminal ended with exit code ${code}`),
  agentsSettingUp: (name: string) => `Setting up the Agents window and starting the a4sx agent host, then opening «${name}»…`,
  agentsSetupCancelled: "Stopped waiting, so the Agents window wasn't opened. The setup goes on in its terminal \"a4sx: set up the Agents window\"; choose Open in Agents window again once it says it is done.",
  agentsSetupSlow: (s: number) =>
    `The Agents window wasn't set up for the a4sx agent host within ${s} seconds, so it wasn't opened. Its terminal "a4sx: set up the Agents window" says why; choose Open in Agents window again once it is done.`,
  agentsWaitCancelled: "Stopped waiting, so the Agents window wasn't opened. The agent host keeps starting in its terminal \"a4sx: agent host\"; choose Open in Agents window again once it runs.",
  agentsHostSlow: (s: number) =>
    `The a4sx agent host didn't answer within ${s} seconds, so the Agents window wasn't opened. Its terminal "a4sx: agent host" says why; choose Open in Agents window again once it runs.`,
};

export interface CellActionDeps extends CellCommandDeps {
  /** Shows text the CLI printed (the extension's output channel): a heading and the lines under it. */
  show(title: string, text: string): void;
  /** Tests: how long Open in Agents window waits for an agent host it started, and how often it asks. */
  agentsWait?: { ms: number; pollMs: number };
  /** #2309 F12: My sessions reads the library again (after a save from here). */
  refreshSessions?: () => void;
  /** Tests: when My sessions is read again after a save (ms after the push started). */
  saveRereads?: readonly number[];
  /** Tests: how long a move (#2309 m) waits for the stopped cell, and how often it looks. */
  moveWait?: { ms: number; pollMs: number };
}

/** F12 (cell01): a save's push takes a few seconds to a minute; My sessions is read again meanwhile, a few times. */
export const SAVE_REREADS_MS: readonly number[] = [8_000, 20_000, 45_000];

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
  const name = showText(item.peer.name) ?? item.peer.instanceId;
  const text = out.code === 0 ? shownOutput(out.stdout) : "";
  if (out.code !== 0 ? NO_DELIVERIES.test(cliErrorText(out) ?? "") : !text) {
    void vscode.window.showInformationMessage(t.messagesNone(name));   // the usual case while no cell here runs
    return true;
  }
  if (out.code !== 0) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.cliFailed(t.messagesWhat, cliErrorText(out)));
    return false;
  }
  deps.show(t.messagesTitle(name), text);
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
  /**
   * The library's entries (as My sessions reads them): a save goes to the cell's backup entry `<cell>-backup` as a new
   * version when it exists (by its id: the server would also take a label, but it falls back to a title that only
   * contains it), else it makes that entry (a4sx #2309 (o), the deck's scheme). Rejects (LibraryUnreadable) when the
   * library can't be read: then nothing is saved.
   */
  library?: () => Promise<SessionRow[]>;
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
  const label = cellBackupLabel(cell.name);
  if (options.library) {
    let entries: SavedEntry[];
    try {
      entries = backupEntries(await options.library(), label);
    } catch (e) {
      const signedOut = e instanceof LibraryUnreadable && e.signedOut;
      await vscode.window.showErrorMessage(signedOut ? SAVE_TAB_TEXTS.signedOut : SAVE_TAB_TEXTS.libraryUnreadable(e instanceof Error && e.message ? e.message : "unknown error"));
      return undefined;
    }
    if (entries.length === 1) {
      into = entries[0].id;
    } else if (entries.length > 1) {
      // #2309 (o): only the entries of that name: a "new entry" row would add one more of them
      const picked = await vscode.window.showQuickPick(entryPickItems(entries).filter((i) => i.into !== undefined),
        { title: t.savePickTitle(cell.name), placeHolder: t.savePickPlaceholder(label), matchOnDescription: true });
      if (!picked) {
        return undefined;
      }
      into = picked.into;
    }
  }
  const named = { label, title: cellBackupTitle(cell.name) };
  let args = pushArgs(plan.transcript, into === undefined ? named : { into });
  if (!args) {
    const again = await vscode.window.showErrorMessage(SAVE_TAB_TEXTS.badEntry((showText(into, 80) ?? "")), SAVE_TAB_TEXTS.saveAsNew);
    if (again !== SAVE_TAB_TEXTS.saveAsNew) {
      return undefined;
    }
    args = pushArgs(plan.transcript, named)!;
  }
  const terminal = openCommandTerminal(t.saveTerminal(cell.name), cli, CLI_NAME, args, undefined, undefined, t.saveBanner(cell.name, short, showText(plan.cwd, 300) ?? plan.cwd));
  deps.terminals.add(terminal);
  if (deps.refreshSessions) {   // F12: the new entry or version shows up in My sessions without a Refresh
    for (const ms of deps.saveRereads ?? SAVE_REREADS_MS) {
      setTimeout(() => deps.refreshSessions?.(), ms);
    }
  }
  return terminal;
}

/** a4sx #2309 (o): the library entries labelled exactly `label`, newest first (more than one: the person picks). */
export function backupEntries(rows: readonly SessionRow[], label: string): SavedEntry[] {
  const when = (r: SessionRow) => (typeof r.updated_at === "string" ? r.updated_at : typeof r.created_at === "string" ? r.created_at : "");
  return rows.filter((r) => r.label === label).sort((a, b) => when(b).localeCompare(when(a)))
    .map((r) => ({ id: r.id, label: showText(r.label), title: [showText(r.title, 120), showText(when(r).replace("T", " ").slice(0, 16), 20)].filter(Boolean).join(" · ") || undefined }));
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

/**
 * The Agents window's own link to a cell's session there (what its "Copy Link" gives for a cell row):
 * <scheme>://agents/agent-host-session/ahp-session/a4sx-cell-<instance id>. undefined for an id the CLI doesn't take.
 */
export function agentsWindowLink(uriScheme: string, instanceId: string): string | undefined {
  return /^[a-z][a-z0-9+.-]{0,31}$/.test(uriScheme) && INSTANCE_ID.test(instanceId)
    ? `${uriScheme}://agents/agent-host-session/ahp-session/a4sx-cell-${instanceId}` : undefined;
}

/** vscode.TerminalExitReason.User / .Shutdown (VS Code 1.90+), as numbers: the test double has no such enum. */
const TERMINAL_CLOSED_BY_USER = 3;
const TERMINAL_SHUTDOWN = 1;

/** cell01: how long "Open in Agents window" waits for an agent host it started (cold, it answered in about 8 s). */
export const AGENTS_WAIT_MS = 30_000;
const AGENTS_POLL_MS = 1_000;

/**
 * The agent host's status once it runs and answers (a local `agent-host status --json` each second); `{ failed }`
 * when the status shows an error from after the wait began while the host doesn't run (it stopped: the shell of its
 * terminal stays open, so the terminal never says so); undefined after `ms`, or as soon as `gone()` says to stop
 * (cancelled, or the terminal closed). Review: a host that runs but didn't answer the probe yet isn't ready; each
 * status call gets only the time that is left.
 */
export async function waitForHost(deps: CellActionDeps, cli: string, ms: number, pollMs = AGENTS_POLL_MS,
  gone: () => boolean = () => false, ready: (s: AgentHostStatus) => boolean = () => true): Promise<AgentHostStatus | { failed: string } | undefined> {
  const began = Date.now();
  const until = began + ms;
  while (Date.now() < until && !gone()) {
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, until - Date.now()))));
    const left = until - Date.now();
    if (left < 200 || gone()) {
      break;
    }
    const out = await deps.run(cli, AGENT_HOST_STATUS_ARGS, Math.min(10_000, left));
    const s = out.code === 0 ? parseAgentHostStatus(out.stdout) : undefined;
    if (s?.running && s.answering !== false && ready(s)) {
      return s;
    }
    const at = s && !s.running && s.lastError?.at ? Date.parse(s.lastError.at) : NaN;
    if (s?.lastError && at >= began - 1000) {   // the same computer's clock; 1 s for the time between its write and our start
      return { failed: s.lastError.text };
    }
  }
  return undefined;
}

/** #2309 (m): how long a move waits for the stopped cell to leave the list of running cells (and how often it looks). */
export const MOVE_WAIT_MS = 20_000;
const MOVE_POLL_MS = 1_000;

/**
 * #2309 (m): the stop half of a move: `a4sx mesh cell stop`, then `mesh cells --json` read again (this computer's own
 * file, no server call) until the cell no longer runs; the Cells view is refreshed once at the end. The fresh row of
 * the cell (stored, not running), or the message that says why nothing opens (shown by the caller, after the progress
 * notification is gone), or nothing when there is nothing to say.
 */
async function stopForMove(deps: CellActionDeps, cli: string, item: LocalCellItem,
  cancelled: () => boolean): Promise<LocalCellItem | { error: string } | undefined> {
  const args = cellStopArgs(item.cell, item.all);
  if (!args) {
    return undefined;
  }
  const t = CELL_ACTION_TEXTS;
  const out = await deps.run(cli, args, 30_000);
  if (out.code !== 0) {   // F1: a failed stop changes nothing shown
    return { error: CELL_CMD_TEXTS.cliFailed("stop the cell", cliErrorText(out)) };
  }
  const end = Date.now() + (deps.moveWait?.ms ?? MOVE_WAIT_MS);
  try {
    for (;;) {
      if (cancelled()) {
        return { error: t.moveCancelled(item.cell.name) };
      }
      const read = await deps.run(cli, CELLS_LIST_ARGS, 30_000);
      const cells = read.code === 0 ? parseCellsAnswer(read.stdout)?.cells : undefined;
      if (!cells) {
        return { error: t.moveUnread(item.cell.name) };
      }
      const now = cells.find((c) => c.instanceId === item.cell.instanceId);
      if (!now) {
        return { error: t.moveGone(item.cell.name) };
      }
      if (now.localState !== "running") {
        return new LocalCellItem(now, cells, deps.server());
      }
      if (Date.now() >= end) {
        return { error: t.moveStillRunning(item.cell.name) };
      }
      await new Promise((r) => setTimeout(r, deps.moveWait?.pollMs ?? MOVE_POLL_MS));
    }
  } finally {
    void deps.provider.refresh();   // review: the view once, not a peers re-read per poll
  }
}

/**
 * Open in Agents window: the cell's session in VS Code's Agents window, through that window's own link. The agent host
 * must run and the Agents window must be set up for it. Not set up: this says so, offers Set up the Agents window and
 * opens nothing. Host stopped (cell01, #2309): one action: it starts the host, waits until it answers (at most
 * AGENTS_WAIT_MS), then opens the cell; when it doesn't answer, says so and opens nothing. The agent host starts the cell when its
 * session opens, and asks there when the cell still needs your OK on this computer. Resolves true when the link opened.
 */
export async function openCellInAgentsWindow(deps: CellActionDeps, item: LocalCellItem | undefined): Promise<boolean> {
  if (!(item instanceof LocalCellItem)) {
    return false;
  }
  const t = CELL_ACTION_TEXTS;
  const cell = item.cell;
  if (!startableCell(cell)) {
    await vscode.window.showErrorMessage(t.agentsStandalone(cell.name));
    return false;
  }
  const link = agentsWindowLink(vscode.env.uriScheme, cell.instanceId);
  if (!link) {
    await vscode.window.showErrorMessage(t.agentsBad);
    return false;
  }
  const cli = await ensureCli(deps);
  if (!cli) {
    return false;
  }
  const out = await deps.run(cli, AGENT_HOST_STATUS_ARGS, 15_000);   // this computer's own file, no server call
  let host = out.code === 0 ? parseAgentHostStatus(out.stdout) : undefined;
  if (!host) {
    // review: an a4sx without `agent-host status` fails with argparse's invalid choice: that is the "update" case
    await vscode.window.showErrorMessage(out.code !== 0 && lacksAgentHost(out.stderr) ? t.agentsNoStatus
      : CELL_CMD_TEXTS.cliFailed(t.agentsStatusWhat, out.code === 0 ? AGENT_HOST_TEXTS.notJson : cliErrorText(out)));
    return false;
  }
  if (cell.localState === "running" && !isOpen(host, cell)) {   // review: first: the host would refuse it in the window only
    const pick = await vscode.window.showInformationMessage(t.agentsRunningElsewhere(cell.name), t.moveIt, t.stopIt);
    if (pick === t.stopIt) {
      await vscode.commands.executeCommand(CMD_STOP_CELL, item);
    }
    if (pick !== t.moveIt) {
      return false;
    }
    // #2309 (m): the person chose the move, so no second question: stop it, wait until it no longer runs, then open it
    // here (the cell continues its last conversation in the Agents window, a4sx 0.59.6+)
    const moved = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t.moving(cell.name), cancellable: true },
      (_p, token) => stopForMove(deps, cli, item, () => token.isCancellationRequested));
    if (!(moved instanceof LocalCellItem)) {
      if (moved) {   // review: said after the progress notification is gone, not behind it
        await vscode.window.showErrorMessage(moved.error);
      }
      return false;
    }
    return openCellInAgentsWindow(deps, moved);
  }
  if (!agentsWindowSetUp(host, vscode.env.uriScheme)) {
    // cell01: a modal, not a toast that vanishes after a few seconds with the only way forward on it
    if ((await vscode.window.showInformationMessage(t.agentsNotSetUp, { modal: true }, AGENT_HOST_TEXTS.setup)) !== AGENT_HOST_TEXTS.setup) {
      return false;
    }
    // F5 (cell01): after the setup it goes on by itself: setup-vscode starts the host too; the cell opens once the host
    // answers and the Agents window is set up for it
    const scheme = vscode.env.uriScheme;
    const got = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t.agentsSettingUp(cell.name), cancellable: true },
      async (_p, token) => {
        const term = await setupAgentsWindow(deps);   // cell01: called directly, not through a command a notification may drop
        if (!term) {
          return "none" as const;
        }
        // review: a setup that ended (its terminal's process) stops the wait too; its terminal says why
        const up = await waitForHost(deps, cli, deps.agentsWait?.ms ?? AGENTS_WAIT_MS, deps.agentsWait?.pollMs,
          () => token.isCancellationRequested || term.exitStatus !== undefined, (s) => agentsWindowSetUp(s, scheme));
        if (up || token.isCancellationRequested) {
          return up ?? "cancelled" as const;
        }
        // review: a setup that ended at once (the host already ran) may have worked: one last look before giving up
        const last = await deps.run(cli, AGENT_HOST_STATUS_ARGS, 10_000);
        const s = last.code === 0 ? parseAgentHostStatus(last.stdout) : undefined;
        return s?.running && s.answering !== false && agentsWindowSetUp(s, scheme) ? s : undefined;
      });
    if (got === "none") {
      return false;
    }
    if (got === "cancelled") {
      await vscode.window.showInformationMessage(t.agentsSetupCancelled);
      return false;
    }
    if (got && "failed" in got) {
      await vscode.window.showErrorMessage(t.agentsHostEnded(got.failed));
      return false;
    }
    if (!got) {
      await vscode.window.showErrorMessage(t.agentsSetupSlow(Math.round((deps.agentsWait?.ms ?? AGENTS_WAIT_MS) / 1000)));
      return false;
    }
    host = got;
  }
  if (!host.running) {
    // cell01 (#2309): one action: the host is started here, and the cell opens once it answers
    const got = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t.agentsStarting(cell.name), cancellable: true },
      async (_p, token) => {
        const term = await startAgentHost(deps);
        if (!term) {
          return "none" as const;   // no CLI to start it with: ensureCli said why, nothing to wait for
        }
        const up = await waitForHost(deps, cli, deps.agentsWait?.ms ?? AGENTS_WAIT_MS, deps.agentsWait?.pollMs,
          () => token.isCancellationRequested || term.exitStatus !== undefined);
        const exit = term.exitStatus;
        // review: closed by you (or VS Code shutting down) is said by nothing; a host that ran as the terminal's own
        // process (a shell VS Code doesn't know) and ended closes it too: that is said, with its exit code
        return up ?? (token.isCancellationRequested ? "cancelled" as const : exit === undefined ? undefined
          : exit.reason === TERMINAL_CLOSED_BY_USER || exit.reason === TERMINAL_SHUTDOWN ? "closed" as const
            : { failed: t.agentsHostExited(exit.code) });
      });
    if (got === "none" || got === "closed") {
      return false;   // no CLI (ensureCli said why), or you closed the host's terminal yourself
    }
    if (got === "cancelled") {
      await vscode.window.showInformationMessage(t.agentsWaitCancelled);
      return false;
    }
    if (got && "failed" in got) {
      await vscode.window.showErrorMessage(t.agentsHostEnded(got.failed));
      return false;
    }
    const up = got;
    if (!up) {
      await vscode.window.showErrorMessage(t.agentsHostSlow(Math.round((deps.agentsWait?.ms ?? AGENTS_WAIT_MS) / 1000)));
      return false;
    }
    host = up;
  }
  if (!(await vscode.env.openExternal(vscode.Uri.parse(link)))) {
    await vscode.window.showErrorMessage(t.agentsNotOpened);
    return false;
  }
  deps.provider.rereadHostSoon();   // the open mark follows
  return true;
}
