// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The My sessions actions that organise the list: the filter, "Move to folder…" and "Remove from
// folder". Moving needs `library:organize`, asked for with a new sign-in if the key lacks it.
import * as vscode from "vscode";
import { ApiError, Client, MESSAGES, SCOPE_ORGANIZE, setSessionFolder } from "./api";
import { allFolders, folderPath, normalizeFolder, SessionItem, SessionsProvider } from "./sessionsView";
import { callWithScope, ensureScope, errorText, ScopedAuth } from "./stepUp";

export const FOLDER_TEXTS = {
  filterTitle: "Filter my sessions",
  filterPrompt: "Match title, name, id, tags or folder. Leave empty to show all.",
  moveTitle: "Move to folder",
  movePick: "Choose a folder",
  newFolder: "New folder…",
  folderPrompt: "Folder path. Use / for sub-folders, up to 4 levels.",
  folderPlaceholder: "for example: work/a4sx",
  folderInvalid: "Use 1 to 4 parts separated by /. Each part has up to 40 letters, digits, spaces, _ . or -.",
};

export interface FolderDeps {
  auth: ScopedAuth;
  client: () => Client;
  sessions: SessionsProvider;
}

export function validateFolder(raw: string): string | undefined {
  return normalizeFolder(raw) === undefined ? FOLDER_TEXTS.folderInvalid : undefined;
}

export async function filterSessions(sessions: SessionsProvider): Promise<void> {
  const q = await vscode.window.showInputBox({
    title: FOLDER_TEXTS.filterTitle,
    prompt: FOLDER_TEXTS.filterPrompt,
    value: sessions.filter ?? "",
  });
  if (q === undefined) {
    return;
  }
  sessions.setFilter(q);
}

export function clearFilter(sessions: SessionsProvider): void {
  sessions.setFilter(undefined);
}

async function save(deps: FolderDeps, token: string, id: string, folder: string | null): Promise<void> {
  try {
    const client = deps.client();
    const done = await callWithScope(deps.auth, token, (t) => setSessionFolder(client, t, id, folder));
    if (done) {
      deps.sessions.refresh();
    }
  } catch (e) {
    await vscode.window.showErrorMessage(errorText(e));
    if (e instanceof ApiError && e.code === "not-found") {
      deps.sessions.refresh();
    }
  }
}

async function askFolder(current: string | undefined): Promise<string | undefined> {
  const got = await vscode.window.showInputBox({
    title: FOLDER_TEXTS.moveTitle,
    prompt: FOLDER_TEXTS.folderPrompt,
    placeHolder: FOLDER_TEXTS.folderPlaceholder,
    value: current ?? "",
    validateInput: (v) => validateFolder(v) ?? null,
  });
  if (got === undefined) {
    return undefined;
  }
  const path = normalizeFolder(got);
  if (path === undefined) {
    await vscode.window.showErrorMessage(FOLDER_TEXTS.folderInvalid);
  }
  return path;
}

export async function moveToFolder(deps: FolderDeps, item: SessionItem | undefined): Promise<void> {
  if (!item) {
    return;
  }
  if (!deps.sessions.foldersSupported()) {
    await vscode.window.showErrorMessage(MESSAGES.foldersNotSupported);
    return;
  }
  // Read the folders before a new sign-in: it refreshes the list.
  const current = folderPath(item.row);
  const others = allFolders(deps.sessions.rows ?? []).filter((f) => f !== current);
  const token = await ensureScope(deps.auth, SCOPE_ORGANIZE);
  if (!token) {
    return;
  }
  let target: string | undefined;
  if (others.length) {
    const picked = await vscode.window.showQuickPick(
      [...others.map((f) => ({ label: f, folder: f as string | undefined })), { label: FOLDER_TEXTS.newFolder, folder: undefined }],
      { title: FOLDER_TEXTS.moveTitle, placeHolder: FOLDER_TEXTS.movePick },
    );
    if (!picked) {
      return;
    }
    target = picked.folder ?? await askFolder(current);
  } else {
    target = await askFolder(current);
  }
  if (target === undefined || target === current) {
    return;
  }
  await save(deps, token, item.row.id, target);
}

export async function removeFromFolder(deps: FolderDeps, item: SessionItem | undefined): Promise<void> {
  if (!item || folderPath(item.row) === undefined) {
    return;
  }
  const token = await ensureScope(deps.auth, SCOPE_ORGANIZE);
  if (!token) {
    return;
  }
  await save(deps, token, item.row.id, null);
}
