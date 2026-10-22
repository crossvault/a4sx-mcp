// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "My sessions" view: the sessions in your a4sx library, newest first.
import * as vscode from "vscode";
import { ApiError, Client, listSessions, MESSAGES, SessionRow } from "./api";

export const SESSION_CONTEXT = "a4sx.session";
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

export class SessionItem extends vscode.TreeItem {
  constructor(public readonly row: SessionRow) {
    super(row.title || row.label || row.id, vscode.TreeItemCollapsibleState.None);
    const date = formatDate(row.updated_at || row.created_at);
    const size = formatTokens(row.tokens?.current);
    this.description = [date, size].filter(Boolean).join(" · ");
    this.tooltip = [row.title || row.id, `Name: ${launchName(row)}`, date && `Updated: ${date}`, size && `Size: ${size}`]
      .filter(Boolean).join("\n");
    this.contextValue = SESSION_CONTEXT;
    this.iconPath = new vscode.ThemeIcon("comment-discussion");
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

export class SessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  state: ViewState = "signed-out";

  constructor(
    private readonly auth: TokenSource,
    private readonly client: () => Client,
    private readonly onState: (state: ViewState) => void,
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  private set(state: ViewState): void {
    this.state = state;
    this.onState(state);
  }

  async getChildren(parent?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (parent) {
      return [];
    }
    let rows: SessionRow[];
    try {
      const token = await this.auth.token();
      if (!token) {
        this.set("signed-out");
        return [];
      }
      rows = await listSessions(this.client(), token);
    } catch (e) {
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
    if (rows.length === 0) {
      this.set("empty");
      return [];
    }
    this.set("ok");
    const when = (r: SessionRow) => Date.parse(r.updated_at || r.created_at || "") || 0;
    return [...rows].sort((a, b) => when(b) - when(a)).map((r) => new SessionItem(r));
  }

  dispose(): void {
    this.changed.dispose();
  }
}
