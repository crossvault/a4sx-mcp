// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Zero-setup resume (0.3.1): seed a saved session into Claude Code's local history with the extension's
// own key (no a4sx CLI), pick a folder when none is open, finish the resume after the window reopens on
// that folder, run `claude --resume <id>` in a shell-free terminal, and two one-time prompts (install
// the CLI for launch profiles; allow profiles:read). The key never goes into argv, env or a log, and no
// transcript content is logged.
import * as os from "os";
import * as vscode from "vscode";
import { ApiError, Client, fetchTranscript, listProfiles, MESSAGES, otherHarness, SCOPE_PROFILES_READ, SessionRow } from "./api";
import { seedTranscript, SeedError } from "./nativeSeed";
import { offerStepUp, ScopedAuth } from "./stepUp";

export const RESUME_TEXTS = {
  useHome: "Use my home folder",
  chooseFolder: "Choose a folder…",
  cancel: "Cancel",
  openLabel: "Resume here",
  badSessionId: "This saved session can't be resumed: its transcript has no valid session id.",
  noClaude: "Resume in terminal needs Claude Code. Install it, then try again.",
  cliForProfiles: "Launch profiles need the a4sx CLI.",
  installA4sx: "Install a4sx",
  notNow: "Not now",
  installTerminal: "a4sx: install",
  profilesStepUp: "Launch profiles need one more a4sx permission.",
  allow: "Allow",
};

export const CLAUDE_INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/setup";

/** The canonical 8-4-4-4-12 form of a UUID; the only session id that goes into a link or argv. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The globalState the extension uses (vscode.Memento). */
export interface State {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

// --- choosing a folder ---------------------------------------------------------------------------

export interface ResumeFolder {
  uri: vscode.Uri;
  /** The path on the host this extension runs on (the remote host in a remote window). */
  cwd: string;
  /** True when no folder was open: the window must reopen on `uri` before the resume completes. */
  reopen: boolean;
}

/**
 * No folder is open: offer the home folder of the host this extension runs on, or a folder from the
 * open dialog (VS Code shows the remote file system in a remote window, starting at the remote home).
 */
export async function pickFolderWhenNoneOpen(home: string = os.homedir()): Promise<ResumeFolder | undefined> {
  const t = RESUME_TEXTS;
  const picked = await vscode.window.showQuickPick([{ label: t.useHome, id: "home" }, { label: t.chooseFolder, id: "choose" }, { label: t.cancel, id: "cancel" }]);
  if (!picked || picked.id === "cancel") {
    return undefined;
  }
  // On the remote host, file URIs are this host's paths; VS Code maps them to the remote window.
  const homeUri = vscode.Uri.file(home);
  if (picked.id === "home") {
    return { uri: homeUri, cwd: homeUri.fsPath, reopen: true };
  }
  const chosen = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: homeUri, openLabel: t.openLabel,
  });
  const uri = chosen?.[0];
  if (!uri || uri.scheme !== homeUri.scheme) {
    return undefined;
  }
  return { uri, cwd: uri.fsPath, reopen: true };
}

// --- seeding --------------------------------------------------------------------------------------

export type SeedOutcome = { kind: "ok"; sessionId: string } | { kind: "cancelled" } | { kind: "failed"; message: string };

/** Fetches the session with the extension's key and seeds it into `cwd`, in a cancellable progress notification. */
export async function seedWithProgress(client: Client, token: string, row: SessionRow, cwd: string, title: string, failed: string): Promise<SeedOutcome> {
  if (otherHarness(row.harness)) {
    return { kind: "failed", message: MESSAGES.notClaudeCode };
  }
  return Promise.resolve(vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, cancel): Promise<SeedOutcome> => {
      const abort = new AbortController();
      const sub = cancel.onCancellationRequested(() => abort.abort());
      let reported = 0;
      const report = (share: number) => {
        // 0-30 % download, 30-100 % copy
        const at = Math.round(30 + share * 70);
        if (at > reported) {
          progress.report({ increment: at - reported });
          reported = at;
        }
      };
      try {
        const text = await fetchTranscript(client, token, row.id, abort.signal);
        report(0);
        const sessionId = await seedTranscript(text, { cwd }, { cid: row.id, version: row.version }, { signal: abort.signal, progress: report });
        return UUID.test(sessionId) ? { kind: "ok", sessionId } : { kind: "failed", message: failed };
      } catch (e) {
        if (abort.signal.aborted || (e instanceof SeedError && e.code === "cancelled") || (e instanceof ApiError && e.code === "cancelled")) {
          return { kind: "cancelled" };
        }
        if (e instanceof SeedError) {
          return { kind: "failed", message: RESUME_TEXTS.badSessionId };
        }
        if (e instanceof ApiError) {
          return { kind: "failed", message: e.message };
        }
        return { kind: "failed", message: failed };   // a file-system error: no path or content in the message
      } finally {
        sub.dispose();
      }
    },
  ));
}

// --- the claude terminal --------------------------------------------------------------------------

/** Opens a terminal that runs `claude --resume <id>` directly (no shell) in `cwd`. Nothing secret in argv or env. */
export function openClaudeTerminal(claudePath: string, sessionId: string, cwd: string | vscode.Uri, name: string): vscode.Terminal | undefined {
  if (!UUID.test(sessionId)) {
    return undefined;
  }
  const terminal = vscode.window.createTerminal({ name, shellPath: claudePath, shellArgs: ["--resume", sessionId], cwd });
  terminal.show();
  return terminal;
}

export const CLI_HINT_KEY = "a4sx.cliHintShown";

/**
 * Once ever: launch profiles need the a4sx CLI. "Install a4sx" runs the installer one-liner (built only
 * from a safe origin) in a terminal; on Windows, where it doesn't apply, it opens the install guide.
 */
export async function offerCliInstallOnce(state: State, installCommand: () => string, installUrl: string): Promise<void> {
  if (state.get<boolean>(CLI_HINT_KEY)) {
    return;
  }
  await state.update(CLI_HINT_KEY, true);
  const t = RESUME_TEXTS;
  const choice = await vscode.window.showInformationMessage(t.cliForProfiles, t.installA4sx, t.notNow);
  if (choice !== t.installA4sx) {
    return;
  }
  if (process.platform === "win32") {
    await vscode.env.openExternal(vscode.Uri.parse(installUrl));
    return;
  }
  const terminal = vscode.window.createTerminal({ name: t.installTerminal, shellPath: "/bin/sh", shellArgs: ["-c", installCommand()] });
  terminal.show();
}

// --- finishing after the window reopens -----------------------------------------------------------

export const PENDING_KEY = "a4sx.pendingResume";
export const PENDING_MAX_AGE_MS = 2 * 60_000;

export interface PendingAction {
  kind: "claude" | "terminal";
  sessionId: string;
  folderUri: string;
  at: number;
}

/** A pending action as stored, or undefined when anything about it is off. */
export function validPending(raw: unknown): PendingAction | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const p = raw as Record<string, unknown>;
  if ((p.kind !== "claude" && p.kind !== "terminal") || typeof p.sessionId !== "string" || !UUID.test(p.sessionId)
    || typeof p.folderUri !== "string" || p.folderUri.length > 4096 || typeof p.at !== "number" || !Number.isFinite(p.at)) {
    return undefined;
  }
  return { kind: p.kind, sessionId: p.sessionId, folderUri: p.folderUri, at: p.at };
}

export async function storePending(state: State, action: PendingAction): Promise<void> {
  await state.update(PENDING_KEY, action);
}

/**
 * On activation: the pending action, if it is valid, under 2 minutes old and its folder is open in this
 * window. It is always cleared, so a stale or foreign one never runs later.
 */
export async function takePending(state: State, openFolders: readonly { uri: { toString(): string } }[], now: number): Promise<PendingAction | undefined> {
  const raw = state.get<unknown>(PENDING_KEY);
  if (raw === undefined) {
    return undefined;
  }
  await state.update(PENDING_KEY, undefined);
  const p = validPending(raw);
  if (!p || now - p.at < 0 || now - p.at > PENDING_MAX_AGE_MS) {
    return undefined;
  }
  return openFolders.some((f) => f.uri.toString() === p.folderUri) ? p : undefined;
}

// --- the profiles:read prompt ---------------------------------------------------------------------

export const STEP_UP_SNOOZE_KEY = "a4sx.profilesPromptSnoozedUntil";
export const STEP_UP_SNOOZE_MS = 7 * 24 * 60 * 60_000;

/**
 * After sign-in or activation: if the key lacks profiles:read and the server offers it (its 403 names
 * profiles:read), ask once. "Allow" runs the step-up sign-in; "Not now" is remembered for 7 days.
 */
export async function offerProfilesStepUp(auth: ScopedAuth, client: () => Client, state: State, now: number): Promise<void> {
  const snoozed = state.get<number>(STEP_UP_SNOOZE_KEY);
  if (typeof snoozed === "number" && snoozed > now) {
    return;
  }
  const cur = await auth.current();
  if (!cur || cur.scopes.includes(SCOPE_PROFILES_READ)) {
    return;
  }
  try {
    await listProfiles(client(), cur.token);
    return;
  } catch (e) {
    if (!(e instanceof ApiError && e.code === "insufficient-scope" && e.requiredScope === SCOPE_PROFILES_READ)) {
      return;   // an older server (no launch profiles), offline, ...: nothing to offer
    }
  }
  const t = RESUME_TEXTS;
  const choice = await vscode.window.showInformationMessage(t.profilesStepUp, t.allow, t.notNow);
  if (choice === t.allow) {
    await offerStepUp(auth, SCOPE_PROFILES_READ, false);
  } else if (choice === t.notNow) {
    await state.update(STEP_UP_SNOOZE_KEY, now + STEP_UP_SNOOZE_MS);
  }
}
