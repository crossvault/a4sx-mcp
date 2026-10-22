// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "Marketplace" view: search public a4sx listings; each result opens on the web. No sign-in, no buying.
// Titles and texts come from other users, so they are shown as plain text only (no Markdown, no links).
import * as vscode from "vscode";
import { ApiError, Client, discover, ListingRow, MESSAGES } from "./api";
import { MessageItem } from "./sessionsView";

export const LISTING_CONTEXT = "a4sx.listing";
export const CMD_OPEN_LISTING = "a4sx.openListing";
export const NO_RESULTS = (q: string) => `No sessions match "${q}".`;

export function formatPrice(row: ListingRow): string | undefined {
  if (typeof row.price_cents !== "number") {
    return undefined;
  }
  if (row.price_cents === 0) {
    return "Free";
  }
  const currency = (row.currency || "EUR").toUpperCase();
  return `${(row.price_cents / 100).toFixed(2)} ${currency}`;
}

export class ListingItem extends vscode.TreeItem {
  constructor(public readonly row: ListingRow) {
    super(row.title || row.id, vscode.TreeItemCollapsibleState.None);
    this.description = formatPrice(row);
    this.tooltip = [row.title || row.id, row.abstract || row.description].filter(Boolean).join("\n\n");
    this.contextValue = LISTING_CONTEXT;
    this.iconPath = new vscode.ThemeIcon("library");
    this.command = { command: CMD_OPEN_LISTING, title: "Open on the web", arguments: [this] };
  }
}

export class MarketplaceProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  query: string | undefined;

  constructor(private readonly client: () => Client) {}

  search(query: string | undefined): void {
    this.query = query?.trim() || undefined;
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(parent?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (parent || !this.query) {
      return [];
    }
    let rows: ListingRow[];
    try {
      rows = await discover(this.client(), this.query);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : MESSAGES.unreachable;
      return [new MessageItem(message, "error")];
    }
    if (rows.length === 0) {
      return [new MessageItem(NO_RESULTS(this.query), "info")];
    }
    return rows.map((r) => new ListingItem(r));
  }

  dispose(): void {
    this.changed.dispose();
  }
}
