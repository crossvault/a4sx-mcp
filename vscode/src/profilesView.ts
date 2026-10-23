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
/** A profile a key may not delete (hidden settings, or anything besides a name and a model). */
export const LOCKED_PROFILE_CONTEXT = "a4sx.profile.locked";
export const DELETE_ELSEWHERE = "Delete it with the a4sx CLI or on the website.";
export const DEFAULT_MARK = "default";
export const NO_PROFILES = "No launch profiles yet. Create one.";
export const ALLOW_SCOPE_ITEM = (scope: string) => `Sign in again to allow ${scope}`;
export const NOT_SET = "not set";

export type ProfilesViewState = "signed-out" | "ok" | "empty" | "needs-scope" | "unsupported" | "error";

export { MASK } from "./api";
import { MASK } from "./api";

export const HIDDEN_FIELDS = (n: number) =>
  n === 1
    ? "1 other setting is hidden here and stays as it is. Change it with the a4sx CLI or on the website."
    : `${n} other settings are hidden here and stay as they are. Change them with the a4sx CLI or on the website.`;

/** The server's count of left-out credential-like entries (newer servers only). */
export function hiddenCount(p: Profile): number {
  const n = p.hidden_fields;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
}

/** Flag text that looks like a credential (the server drops such header values too). */
export const SECRET_FLAG = /(^|[=\s:])(bearer\b|basic\s|sk-|sk_live|sk_test|ghp_|github_pat_|xox[baprs]-|ya29\.)|authorization|(api[-_]?key|token|secret|password)(=|$)/i;
/** A flag that only names a credential, so the next flag is its value (`--api-key VALUE`). */
const SECRET_NAME = /^-{0,2}[a-z0-9_-]*(api[-_]?key|token|secret|password|authorization)$/i;

/**
 * Which flags hold a credential: `true` at each index whose value must never be shown or prefilled.
 * A flag naming a credential (`--api-key`) marks the following flag too.
 */
export function secretFlags(flags: readonly string[]): boolean[] {
  const out = flags.map(() => false);
  for (let i = 0; i < flags.length; i++) {
    if (SECRET_FLAG.test(flags[i])) {
      out[i] = true;
      if (SECRET_NAME.test(flags[i]) && i + 1 < flags.length) {
        out[i + 1] = true;
        i++;
      }
    }
  }
  return out;
}

/** One flag as it may be shown: the value part of a credential-looking flag becomes ••••. */
export function maskFlag(flag: string): string {
  if (SECRET_NAME.test(flag)) {
    return flag;   // just the name; its value is the next flag
  }
  const eq = flag.indexOf("=");
  if (eq > 0) {
    return `${flag.slice(0, eq + 1)}${MASK}`;
  }
  const colon = flag.indexOf(":");
  if (colon > 0 && /authorization/i.test(flag.slice(0, colon))) {
    return `${flag.slice(0, colon + 1)}${MASK}`;
  }
  return MASK;
}

/** The profile's flags as they may be shown, credential values masked. */
export function shownFlags(flags: unknown): string[] {
  const list = Array.isArray(flags) ? flags.filter((f): f is string => typeof f === "string") : [];
  const secret = secretFlags(list);
  return list.map((f, i) => (secret[i] ? maskFlag(f) : f));
}

export interface ProfileTokenSource {
  token(): Promise<string | undefined>;
}

/**
 * A base_url as it is shown and named in confirmations: scheme://host[:port] only. Newer servers send
 * no more than that to a key; older ones may send a path, which is not shown either.
 */
export function displayAddress(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) {
    return undefined;
  }
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return value.replace(/[/?#].*$/, "");
  }
}

const blank = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)
  || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/**
 * A key may delete a profile only if it is not the default, has no hidden settings, and holds
 * nothing but a name and/or a model (no flags, address, harness, headers or router setting).
 */
export function deletable(isDefault: boolean, p: Profile): boolean {
  if (isDefault || hiddenCount(p) > 0) {
    return false;
  }
  return Object.entries(p).every(([k, v]) => k === "name" || k === "model" || k === "hidden_fields" || blank(v));
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
    const flags = shownFlags(profile.flags).join(" ");
    this.tooltip = [
      `ID: ${id}`,
      `Model: ${model ?? NOT_SET}`,
      `Server address: ${address ?? NOT_SET}`,
      `Harness: ${typeof profile.harness === "string" && profile.harness ? profile.harness : NOT_SET}`,
      `Flags: ${flags || NOT_SET}`,
      ...(hiddenCount(profile) ? [HIDDEN_FIELDS(hiddenCount(profile))] : []),
      ...(deletable(isDefault, profile) ? [] : [DELETE_ELSEWHERE]),
    ].join("\n");
    this.contextValue = isDefault ? DEFAULT_PROFILE_CONTEXT : deletable(false, profile) ? PROFILE_CONTEXT : LOCKED_PROFILE_CONTEXT;
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
