// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.8.0: "Save session to a4sx" and "Preview save to a4sx (dry run)" in the context menu of a Claude Code tab (and
// in the Command Palette while such a tab is active). Unlike "Save this session" (`a4sx push --latest`, the newest
// transcript on this computer), these save the session of that tab: its transcript is found as for Convert to cell
// (tabSession.ts) and, for a save, confirmed by the user (or picked), then a terminal runs
//   a4sx push <transcript> [--into <library entry>]      (save)
//   a4sx push <transcript> --dry-run                     (preview: uploads nothing, needs no sign-in)
// `--into` is added when the library already holds this session, so the save becomes a new version of that entry.
// When the library can't be read (signed out in the sidebar, offline), nothing is saved and the user is told why:
// a plain push could add the session a second time instead of a new version. The CLI scrubs the transcript and
// prints what it changed; the extension reads none of its content.
import * as vscode from "vscode";
import { CellCommandDeps, ensureCli } from "./cellCommands";
import { CLI_NAME } from "./cli";
import { claudeTabOf, sessionDetail, tabSessionOf } from "./convertTab";
import { openCommandTerminal } from "./resume";
import { slugOf } from "./tabSession";
import { SESSION_ID } from "./terminalCommand";

export const SAVE_TAB_TEXTS = {
  terminal: "a4sx: save session",
  previewTerminal: "a4sx: preview save",
  title: "Save session to a4sx",
  previewTitle: "Preview save to a4sx",
  pickSessionTitle: (title: string) => `${title}: which session is this tab?`,
  confirm: "Save this session to a4sx?",
  confirmYes: "Save this session",
  banner: (preview: boolean, detail: string) => `${preview ? "Preview save to a4sx (dry run) of this session:" : "Save session to a4sx, this session:"}\r\n${detail.split("\n").map((l) => `  ${l}`).join("\r\n")}\r\n`,
  pickEntryTitle: "Save session to a4sx: which library entry?",
  pickEntryPlaceholder: "This session is in your library more than once. Choose the entry that gets the new version",
  newEntry: "$(add) Save without choosing an entry",
  newEntryDetail: "Runs a plain `a4sx push`; the server files the save.",
  badEntry: (id: string) => `The library entry that holds this session has an id the a4sx CLI doesn't take ("${id}"), so the save can't become a new version of it. Choose Save as a new entry to save the session as a separate entry in your library; otherwise nothing is saved.`,
  saveAsNew: "Save as a new entry",
  signedOut: "Nothing was saved: you aren't signed in to a4sx in the sidebar, or your sign-in is no longer valid, so the extension can't check whether your library already holds this session. Saved now, it could become a second entry instead of a new version. Sign in (a4sx: Sign in), then run Save session to a4sx again. Preview save to a4sx (dry run) works without sign-in.",
  libraryUnreadable: (reason: string) => `Nothing was saved: your a4sx library couldn't be read (${reason}), so the extension can't check whether it already holds this session. Saved now, it could become a second entry instead of a new version. Try again when your a4sx server is reachable. Preview save to a4sx (dry run) works meanwhile.`,
};

/** Thrown by a SavedLookup when the library can't be read; `signedOut` when there is no sign-in to read it with. */
export class LibraryUnreadable extends Error {
  constructor(readonly signedOut: boolean, reason?: string) {
    super(reason ?? (signedOut ? "signed out" : "unknown error"));
    this.name = "LibraryUnreadable";
  }
}

/** A library entry that holds a session. */
export interface SavedEntry {
  id: string;
  label?: string;
  title?: string;
}

/** The library entries that hold the session with this slug (tabSession.slugOf); [] when none. Rejects (LibraryUnreadable) when the library can't be read. */
export type SavedLookup = (slug: string) => Promise<SavedEntry[]>;

export interface SaveTabOptions {
  /** Preview save: `--dry-run`. Nothing is uploaded and the library isn't asked. */
  preview?: boolean;
  /** Finds the session in the library, so a later save becomes a new version of its entry. */
  saved?: SavedLookup;
  /** Where Claude Code keeps transcripts (tests). */
  projectsDir?: string;
}

/** An entry id for a message: control characters dropped, at most 80 characters. */
function showId(id: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = id.replace(/[\x00-\x1f\x7f]/g, "");
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

/**
 * `push <transcript> [--into ID | --label L --title T] [--dry-run]`; undefined for an entry id the CLI doesn't take.
 * `label` and `title` name a new entry (a4sx #2309 (o): a cell's saves go to `<cell>-backup`, as the deck's do).
 */
export function pushArgs(file: string, o: { into?: string; preview?: boolean; label?: string; title?: string } = {}): string[] | undefined {
  if (o.into !== undefined && !SESSION_ID.test(o.into)) {
    return undefined;
  }
  const named = o.into === undefined && o.label ? ["--label", o.label, ...(o.title ? ["--title", o.title] : [])] : [];
  return ["push", file, ...(o.into === undefined ? [] : ["--into", o.into]), ...named, ...(o.preview ? ["--dry-run"] : [])];
}

/**
 * a4sx #2309 (o): the library entry a cell's saves go to, the name every front end uses (the herdr deck's backup).
 * One scheme: not one `session-<id>` entry per save.
 */
export function cellBackupLabel(cell: string): string {
  return `${cell}-backup`;
}

/** The title a cell's backup entry gets when the first save makes it. */
export function cellBackupTitle(cell: string): string {
  return `${cell}: backups`;
}

/** The entry pick's rows, for a session that is in the library more than once; the last row saves without `--into`. */
export function entryPickItems(entries: readonly SavedEntry[]): { label: string; description?: string; detail?: string; into?: string }[] {
  return [
    ...entries.map((e) => ({ label: e.label ?? e.title ?? e.id, description: [e.label ? e.title : undefined, e.id].filter(Boolean).join(" · "), into: e.id })),
    { label: SAVE_TAB_TEXTS.newEntry, detail: SAVE_TAB_TEXTS.newEntryDetail },
  ];
}

/**
 * Save session to a4sx / Preview save to a4sx: runs `a4sx push` for the session of a Claude Code tab, in a
 * terminal. `args` are what VS Code passed to the command. Resolves the terminal, or undefined when nothing was
 * started (the user was told why, or cancelled).
 */
export async function saveTabSession(deps: CellCommandDeps, args: readonly unknown[] = [], options: SaveTabOptions = {}): Promise<vscode.Terminal | undefined> {
  const t = SAVE_TAB_TEXTS;
  const title = options.preview ? t.previewTitle : t.title;
  const tab = await claudeTabOf(args, title);
  if (!tab) {
    return undefined;
  }
  // A save is confirmed (or the session picked); the dry run uploads nothing, so it isn't, and its terminal names the session.
  const session = await tabSessionOf(tab, options.projectsDir, t.pickSessionTitle(title), options.preview ? undefined : { message: t.confirm, yes: t.confirmYes });
  if (!session) {
    return undefined;
  }
  const cli = await ensureCli(deps);
  if (!cli) {
    return undefined;
  }
  let into: string | undefined;
  if (!options.preview && options.saved) {
    let entries: SavedEntry[];
    try {
      entries = await options.saved(slugOf(session.sessionId));
    } catch (e) {
      const signedOut = e instanceof LibraryUnreadable && e.signedOut;
      await vscode.window.showErrorMessage(signedOut ? t.signedOut : t.libraryUnreadable(e instanceof Error && e.message ? e.message : "unknown error"));
      return undefined;
    }
    if (entries.length === 1) {
      into = entries[0].id;
    } else if (entries.length > 1) {
      const picked = await vscode.window.showQuickPick(entryPickItems(entries), { title: t.pickEntryTitle, placeHolder: t.pickEntryPlaceholder, matchOnDescription: true });
      if (!picked) {
        return undefined;
      }
      into = picked.into;
    }
  }
  const pushed = pushArgs(session.file, { ...(into === undefined ? {} : { into }), preview: options.preview === true });
  if (!pushed) {
    const choice = await vscode.window.showErrorMessage(t.badEntry(showId(into ?? "")), t.saveAsNew);
    if (choice !== t.saveAsNew) {
      return undefined;
    }
    return openCommandTerminal(t.terminal, cli, CLI_NAME, pushArgs(session.file)!, undefined, undefined, t.banner(false, sessionDetail(session)));
  }
  return openCommandTerminal(options.preview ? t.previewTerminal : t.terminal, cli, CLI_NAME, pushed, undefined, undefined, t.banner(options.preview === true, sessionDetail(session)));
}
