// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "My sessions" view: the sessions in your a4sx library, newest first, in nested folders
// (unfiled sessions at the top level). A filter shows the matching sessions as a flat list.
import * as vscode from "vscode";
import { ApiError, Client, listSessions, MESSAGES, SessionRow } from "./api";

export const SESSION_CONTEXT = "a4sx.session";
/** A session that sits in a folder: it also gets "Remove from folder". */
export const FILED_SESSION_CONTEXT = "a4sx.session.filed";
export const FOLDER_CONTEXT = "a4sx.folder";
export const NO_MATCH = (q: string) => `No sessions match "${q}".`;
export const FILTER_MESSAGE = (q: string, shown: number, total: number) => `Filter: "${q}" · ${shown} of ${total}`;
export const SIGNED_OUT_MESSAGE = "You were signed out of a4sx because your sign-in is no longer valid. Sign in again to see your sessions.";

export type ViewState = "signed-out" | "empty" | "error" | "ok";

export interface TokenSource {
  token(): Promise<string | undefined>;
  clear(): Promise<void>;
}

export function formatTokens(n: number | undefined): string | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    return undefined;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M tokens`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k tokens`;
  }
  return `${n} tokens`;
}

export function formatDate(iso: string | undefined): string | undefined {
  if (!iso) {
    return undefined;
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

/** The name `a4sx launch --a4sx-session=NAME` takes: the label, or the id when the push set no label. */
export function launchName(row: SessionRow): string {
  return row.label || row.id;
}

/** A row's folder as path segments; anything that isn't a usable path means unfiled. */
export function folderSegments(row: SessionRow): string[] {
  if (typeof row.folder !== "string") {
    return [];
  }
  return row.folder.split("/").map((p) => p.trim()).filter((p) => p.length > 0);
}

export function folderPath(row: SessionRow): string | undefined {
  const segs = folderSegments(row);
  return segs.length ? segs.join("/") : undefined;
}

/**
 * The server's rule for a folder path: 1-4 parts joined by "/", each 1-40 characters of letters,
 * digits, space, "_", "." and "-" (trimmed, not "." or ".."), at most 120 characters in all.
 * Returns the normalised path, or undefined when the text breaks the rule.
 */
export function normalizeFolder(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.startsWith("/") || value.endsWith("/")) {
    return undefined;
  }
  const parts = value.split("/").map((p) => p.trim());
  if (parts.length > 4 || parts.some((p) => !/^[A-Za-z0-9 _.-]{1,40}$/.test(p) || p === "." || p === "..")) {
    return undefined;
  }
  const path = parts.join("/");
  return path.length <= 120 ? path : undefined;
}

const when = (r: SessionRow) => Date.parse(r.updated_at || r.created_at || "") || 0;
const newestFirst = (a: SessionRow, b: SessionRow) => when(b) - when(a);

export interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  sessions: SessionRow[];
}

/** Nested folders (sorted by name) and their sessions (newest first); the root holds the unfiled ones. */
export function buildFolderTree(rows: readonly SessionRow[]): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], sessions: [] };
  for (const row of rows) {
    let node = root;
    for (const seg of folderSegments(row)) {
      let next = node.folders.find((f) => f.name === seg);
      if (!next) {
        next = { name: seg, path: node.path ? `${node.path}/${seg}` : seg, folders: [], sessions: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.sessions.push(row);
  }
  const sort = (node: FolderNode) => {
    node.folders.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    node.sessions.sort(newestFirst);
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export function countSessions(node: FolderNode): number {
  return node.sessions.length + node.folders.reduce((n, f) => n + countSessions(f), 0);
}

/** Every folder path in use (sorted), for the "Move to folder" choices. */
export function allFolders(rows: readonly SessionRow[]): string[] {
  return [...new Set(rows.map(folderPath).filter((p): p is string => !!p))].sort();
}

/** Case-insensitive substring match on title, label, id, tags and folder. */
export function matchesFilter(row: SessionRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  const fields = [row.title, row.label, row.id, folderPath(row), ...(Array.isArray(row.tags) ? row.tags : [])];
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(q));
}

export class SessionItem extends vscode.TreeItem {
  /** `showFolder`: a flat (filtered) list, so the folder goes into the description. */
  constructor(public readonly row: SessionRow, showFolder = false) {
    super(row.title || row.label || row.id, vscode.TreeItemCollapsibleState.None);
    const date = formatDate(row.updated_at || row.created_at);
    const size = formatTokens(row.tokens?.current);
    const folder = folderPath(row);
    this.description = [showFolder ? folder : undefined, date, size].filter(Boolean).join(" · ");
    this.tooltip = [row.title || row.id, `Name: ${launchName(row)}`, folder && `Folder: ${folder}`, date && `Updated: ${date}`, size && `Size: ${size}`]
      .filter(Boolean).join("\n");
    this.contextValue = folder ? FILED_SESSION_CONTEXT : SESSION_CONTEXT;
    this.iconPath = new vscode.ThemeIcon("comment-discussion");
  }
}

export class FolderItem extends vscode.TreeItem {
  constructor(public readonly node: FolderNode) {
    super(node.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `a4sx.folder:${node.path}`;
    this.description = String(countSessions(node));
    this.tooltip = node.path;
    this.contextValue = FOLDER_CONTEXT;
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class MessageItem extends vscode.TreeItem {
  constructor(message: string, icon: string, command?: vscode.Command) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
    this.tooltip = message;
  }
}

/** Where the provider shows the active filter (the TreeView, once created). */
export interface FilterDisplay {
  message?: string;
}

export class SessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  state: ViewState = "signed-out";
  /** The last list from the server; a filter change reuses it, Refresh fetches again. */
  rows: SessionRow[] | undefined;
  filter: string | undefined;
  view: FilterDisplay | undefined;

  constructor(
    private readonly auth: TokenSource,
    private readonly client: () => Client,
    private readonly onState: (state: ViewState) => void,
    private readonly onFilter: (filter: string | undefined) => void = () => undefined,
  ) {}

  refresh(): void {
    this.rows = undefined;
    this.changed.fire();
  }

  /** Sets (or, with an empty text, clears) the filter. */
  setFilter(text: string | undefined): void {
    const q = (text ?? "").trim();
    this.filter = q || undefined;
    this.onFilter(this.filter);
    if (!this.filter && this.view) {
      this.view.message = undefined;
    }
    this.changed.fire();
  }

  /** True when the server sends folders (a `folder` key on its rows); older servers don't. */
  foldersSupported(): boolean {
    return (this.rows ?? []).some((r) => Object.prototype.hasOwnProperty.call(r, "folder"));
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  private set(state: ViewState): void {
    this.state = state;
    this.onState(state);
  }

  private show(message: string | undefined): void {
    if (this.view) {
      this.view.message = message;
    }
  }

  async getChildren(parent?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (parent instanceof FolderItem) {
      return this.nodeItems(parent.node);
    }
    if (parent) {
      return [];
    }
    let rows: SessionRow[];
    try {
      const token = await this.auth.token();
      if (!token) {
        this.rows = undefined;
        this.show(undefined);
        this.set("signed-out");
        return [];
      }
      rows = this.rows ?? await listSessions(this.client(), token);
    } catch (e) {
      this.show(undefined);
      if (e instanceof ApiError && e.code === "unauthorized") {
        await this.auth.clear();
        this.set("signed-out");
        void vscode.window.showWarningMessage(SIGNED_OUT_MESSAGE);
        return [];
      }
      this.set("error");
      const message = e instanceof ApiError ? e.message : MESSAGES.unreachable;
      return [new MessageItem(message, "error", { command: "a4sx.refreshSessions", title: "Refresh" })];
    }
    this.rows = rows;
    if (rows.length === 0) {
      this.show(undefined);
      this.set("empty");
      return [];
    }
    this.set("ok");
    if (this.filter) {
      const q = this.filter;
      const hits = rows.filter((r) => matchesFilter(r, q)).sort(newestFirst);
      this.show(FILTER_MESSAGE(q, hits.length, rows.length));
      if (hits.length === 0) {
        return [new MessageItem(NO_MATCH(q), "filter", { command: "a4sx.clearSessionFilter", title: "Clear filter" })];
      }
      return hits.map((r) => new SessionItem(r, true));
    }
    this.show(undefined);
    return this.nodeItems(buildFolderTree(rows));
  }

  /** A folder's contents: its sub-folders first, then its sessions. */
  private nodeItems(node: FolderNode): vscode.TreeItem[] {
    return [...node.folders.map((f) => new FolderItem(f)), ...node.sessions.map((r) => new SessionItem(r))];
  }

  dispose(): void {
    this.changed.dispose();
  }
}
