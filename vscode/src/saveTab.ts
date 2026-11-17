// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.8.0: "Save session to a4sx" and "Preview save to a4sx (dry run)" in the context menu of a Claude Code tab (and
// in the Command Palette while such a tab is active). Unlike "Save this session" (`a4sx push --latest`, the newest
// transcript on this computer), these save the session of that tab: its transcript is found as for Convert to cell
// (tabSession.ts), then a terminal runs
//   a4sx push <transcript> [--into <library entry>]      (save)
//   a4sx push <transcript> --dry-run                     (preview: uploads nothing, needs no sign-in)
// `--into` is added when the library already holds this session, so the save becomes a new version of that entry;
// when the library can't be read (signed out, offline), the plain push runs and the server files it. The CLI
// scrubs the transcript and prints what it changed; the extension reads none of its content.
import * as vscode from "vscode";
import { CellCommandDeps, ensureCli } from "./cellCommands";
import { CLI_NAME } from "./cli";
import { claudeTabOf, tabSessionOf } from "./convertTab";
import { openCommandTerminal } from "./resume";
import { slugOf } from "./tabSession";
import { SESSION_ID } from "./terminalCommand";

export const SAVE_TAB_TEXTS = {
  terminal: "a4sx: save session",
  previewTerminal: "a4sx: preview save",
  title: "Save session to a4sx",
  previewTitle: "Preview save to a4sx",
  pickSessionTitle: (title: string) => `${title}: which session is this tab?`,
  pickEntryTitle: "Save session to a4sx: which library entry?",
  pickEntryPlaceholder: "This session is in your library more than once. Choose the entry that gets the new version",
  newEntry: "$(add) Save without choosing an entry",
  newEntryDetail: "Runs a plain `a4sx push`; the server files the save.",
  badEntry: "This library entry's id can't be passed to the a4sx CLI.",
};

/** A library entry that holds a session. */
export interface SavedEntry {
  id: string;
  label?: string;
  title?: string;
}

/** The library entries that hold the session with this slug (tabSession.slugOf); [] when none or when the library can't be read. */
export type SavedLookup = (slug: string) => Promise<SavedEntry[]>;

export interface SaveTabOptions {
  /** Preview save: `--dry-run`. Nothing is uploaded and the library isn't asked. */
  preview?: boolean;
  /** Finds the session in the library, so a later save becomes a new version of its entry. */
  saved?: SavedLookup;
  /** Where Claude Code keeps transcripts (tests). */
  projectsDir?: string;
}

/** `push <transcript> [--into ID] [--dry-run]`; undefined for an entry id the CLI doesn't take. */
export function pushArgs(file: string, o: { into?: string; preview?: boolean } = {}): string[] | undefined {
  if (o.into !== undefined && !SESSION_ID.test(o.into)) {
    return undefined;
  }
  return ["push", file, ...(o.into === undefined ? [] : ["--into", o.into]), ...(o.preview ? ["--dry-run"] : [])];
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
  const session = await tabSessionOf(tab, options.projectsDir, t.pickSessionTitle(title));
  if (!session) {
    return undefined;
  }
  const cli = await ensureCli(deps);
  if (!cli) {
    return undefined;
  }
  let into: string | undefined;
  if (!options.preview && options.saved) {
    const entries = await options.saved(slugOf(session.sessionId)).catch(() => []);
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
    await vscode.window.showErrorMessage(t.badEntry);
    return undefined;
  }
  return openCommandTerminal(options.preview ? t.previewTerminal : t.terminal, cli, CLI_NAME, pushed);
}
