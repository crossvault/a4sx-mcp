// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "Launch profiles" view: how `a4sx launch` starts a session (model, server address, harness,
// flags), with the default marked. Profiles never hold an API key, and this view shows none of a
// profile's headers.
import * as vscode from "vscode";
import { ApiError, Client, listProfiles, MESSAGES, Profile, ProfilesState } from "./api";
import { MessageItem } from "./sessionsView";

export const PROFILE_CONTEXT = "a4sx.profile";
export const DEFAULT_PROFILE_CONTEXT = "a4sx.profile.default";
export const DEFAULT_MARK = "default";
export const NO_PROFILES = "No launch profiles yet. Create one.";
export const ALLOW_SCOPE_ITEM = (scope: string) => `Sign in again to allow ${scope}`;
export const NOT_SET = "not set";

export type ProfilesViewState = "signed-out" | "ok" | "empty" | "needs-scope" | "unsupported" | "error";

export interface ProfileTokenSource {
  token(): Promise<string | undefined>;
}

/** A base_url as it is shown and named in confirmations: no user name, password, query or fragment. */
export function displayAddress(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) {
    return undefined;
  }
  try {
    const u = new URL(value);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return value.replace(/[?#].*$/, "");
  }
}

export function profileName(id: string, p: Profile): string {
  return typeof p.name === "string" && p.name.trim() ? p.name.trim() : id;
}

export class ProfileItem extends vscode.TreeItem {
  constructor(public readonly id: string, public readonly profile: Profile, public readonly isDefault: boolean) {
    super(profileName(id, profile), vscode.TreeItemCollapsibleState.None);
    const model = typeof profile.model === "string" && profile.model ? profile.model : undefined;
    const address = displayAddress(typeof profile.base_url === "string" ? profile.base_url : undefined);
    this.description = [isDefault ? DEFAULT_MARK : undefined, model, address].filter(Boolean).join(" · ");
    const flags = Array.isArray(profile.flags) ? profile.flags.filter((f) => typeof f === "string").join(" ") : "";
    this.tooltip = [
      `ID: ${id}`,
      `Model: ${model ?? NOT_SET}`,
      `Server address: ${address ?? NOT_SET}`,
      `Harness: ${typeof profile.harness === "string" && profile.harness ? profile.harness : NOT_SET}`,
      `Flags: ${flags || NOT_SET}`,
    ].join("\n");
    this.contextValue = isDefault ? DEFAULT_PROFILE_CONTEXT : PROFILE_CONTEXT;
    this.iconPath = new vscode.ThemeIcon(isDefault ? "star-full" : "rocket");
  }
}

/** The default first, then by name. */
export function sortedProfiles(state: ProfilesState): [string, Profile][] {
  return [...state.profiles].sort(([a, pa], [b, pb]) => {
    if (a === state.default) {
      return -1;
    }
    if (b === state.default) {
      return 1;
    }
    return profileName(a, pa).localeCompare(profileName(b, pb));
  });
}

export class ProfilesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  state: ProfilesViewState = "signed-out";
  /** The last list the server sent; commands work on it. */
  data: ProfilesState | undefined;
  /** A list a write just returned: the next getChildren shows it instead of asking again. */
  private pending: ProfilesState | undefined;

  constructor(
    private readonly auth: ProfileTokenSource,
    private readonly client: () => Client,
    private readonly onState: (state: ProfilesViewState) => void,
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  /** Shows a list a write returned, without asking the server again. */
  show(data: ProfilesState): void {
    this.data = data;
    this.pending = data;
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  private set(state: ProfilesViewState): void {
    this.state = state;
    this.onState(state);
  }

  async getChildren(parent?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (parent) {
      return [];
    }
    let data: ProfilesState;
    try {
      const token = await this.auth.token();
      if (!token) {
        this.data = undefined;
        this.pending = undefined;
        this.set("signed-out");
        return [];
      }
      data = this.pending ?? await listProfiles(this.client(), token);
      this.pending = undefined;
    } catch (e) {
      this.data = undefined;
      if (e instanceof ApiError && e.code === "insufficient-scope" && e.requiredScope) {
        this.set("needs-scope");
        return [new MessageItem(ALLOW_SCOPE_ITEM(e.requiredScope), "key", { command: "a4sx.allowScope", title: "Sign in", arguments: [e.requiredScope] })];
      }
      if (e instanceof ApiError && e.code === "not-supported") {
        this.set("unsupported");
        return [new MessageItem(MESSAGES.profilesNotSupported, "info")];
      }
      this.set("error");
      const message = e instanceof ApiError ? e.message : MESSAGES.unreachable;
      return [new MessageItem(message, "error", { command: "a4sx.refreshProfiles", title: "Refresh" })];
    }
    this.data = data;
    if (data.profiles.length === 0) {
      this.set("empty");
      return [new MessageItem(NO_PROFILES, "add", { command: "a4sx.createProfile", title: "Create" })];
    }
    this.set("ok");
    return sortedProfiles(data).map(([id, p]) => new ProfileItem(id, p, id === data.default));
  }

  dispose(): void {
    this.changed.dispose();
  }
}
