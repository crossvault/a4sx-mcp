// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "Launch profiles" view: how `a4sx launch` starts a session (model, server address, harness,
// flags), with the default marked. Profiles never hold an API key, and this view shows none of a
// profile's headers.
import * as vscode from "vscode";
import { ApiError, Client, listProfiles, MESSAGES, Profile, ProfilesState, SCOPE_ORGANIZE, SCOPE_PROFILES_READ, SCOPE_PROFILES_WRITE } from "./api";

/** The scopes the "Sign in again to allow" item may offer (the step-up allow-list). */
const STEP_UP_SCOPES: readonly string[] = [SCOPE_PROFILES_READ, SCOPE_PROFILES_WRITE, SCOPE_ORGANIZE];
const SERVER_LINE_MAX = 200;
import { MessageItem } from "./sessionsView";
import { CliProfile, cliGate, parseCliError, parseCliVersion, parseProfilesAnswer, PROFILES_ARGS, ProfilesAnswer, VERSION_ARGS } from "./cliJson";
import type { CliResolution, CliRunner } from "./cellsView";

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
/**
 * 0.5.0: a flag NAME that holds a credential (`--api-key`, `--token`, `--client-secret-file`, `--db-password`,
 * `--auth-header`, …), as the CLI masks them: its value is never shown, whatever it looks like.
 */
const SECRET_FLAG_NAME = /^-{1,2}[a-z0-9_.-]*(api[-_]?key|key|token|secret|passw(?:or)?d|passphrase|credential|auth|bearer|cookie)[a-z0-9_.-]*$/i;
/** A flag that only names a credential, so the next flag is its value (`--api-key VALUE`). */
const SECRET_NAME = /^-{0,2}[a-z0-9_-]*(api[-_]?key|token|secret|password|authorization)$/i;

/**
 * Which flags hold a credential: `true` at each index whose value must never be shown or prefilled.
 * A flag naming a credential (`--api-key`) marks the following flag too.
 */
export function secretFlags(flags: readonly string[]): boolean[] {
  const out = flags.map(() => false);
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const eq = f.indexOf("=");
    // A bare credential name takes the next flag as its value (for the wider name rule: unless that is a flag).
    const bareName = eq < 0 && (SECRET_NAME.test(f) || SECRET_FLAG_NAME.test(f));
    const takesNext = eq < 0 && i + 1 < flags.length && (SECRET_NAME.test(f) || (SECRET_FLAG_NAME.test(f) && !flags[i + 1].startsWith("-")));
    if (SECRET_FLAG.test(f) || (eq > 0 && SECRET_FLAG_NAME.test(f.slice(0, eq))) || bareName) {
      out[i] = true;
      if (takesNext) {
        out[i + 1] = true;
        i++;
      }
    }
  }
  return out;
}

/** One flag as it may be shown: the value part of a credential-looking flag becomes ••••. */
export function maskFlag(flag: string): string {
  if (SECRET_NAME.test(flag) || SECRET_FLAG_NAME.test(flag)) {
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

// --- 0.5.0: the profiles as the a4sx CLI lists them (`a4sx profiles --json`, CLI 0.25.0+) -----------------

export const CLI_PROFILE_CONTEXT = "a4sx.cliProfile";
export const CLI_DEFAULT_PROFILE_CONTEXT = "a4sx.cliProfile.default";
export const PROFILE_DETAIL_CONTEXT = "a4sx.profileDetail";
export const CLI_PROFILE_TEXTS = {
  harness: "Harness",
  model: "Model",
  baseUrl: "Base URL",
  operator: "Router operator",
  headers: "Header names",
  flags: "Flags",
  env: "Env keys",
  usedBy: "Used by",
  none: "none",
  cells: (n: number | undefined) => (n === undefined ? "unknown" : n === 0 ? "no cells" : n === 1 ? "1 cell" : `${n} cells`),
  updateCli: "Update a4sx to 0.25.0 or newer to see each profile's details here and to duplicate profiles.",
  cliFailed: "Could not read the launch profiles from the a4sx CLI.",
};

/** A profile's details as shown: header NAMES and env KEYS only; of the header values, only the router operator. */
export function profileDetails(p: CliProfile): [string, string][] {
  const t = CLI_PROFILE_TEXTS;
  const list = (v: readonly string[]) => (v.length ? v.join(", ") : t.none);
  return [
    [t.harness, p.harness ?? NOT_SET],
    [t.model, p.model ?? NOT_SET],
    [t.baseUrl, displayAddress(p.base_url) ?? NOT_SET],
    [t.operator, p.operator ?? NOT_SET],
    [t.headers, list(p.headerNames)],
    [t.flags, shownFlags(p.flags).join(" ") || t.none],
    [t.env, list(p.envKeys)],
    [t.usedBy, t.cells(p.usedByCells)],
  ];
}

export class CliProfileItem extends vscode.TreeItem {
  constructor(public readonly profile: CliProfile, public readonly isDefault: boolean) {
    super(profile.id, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `cliProfile:${profile.id}`;
    this.description = [isDefault ? DEFAULT_MARK : undefined, profile.model, displayAddress(profile.base_url), profile.operator ? `operator ${profile.operator}` : undefined]
      .filter(Boolean).join(" · ");
    this.tooltip = [`ID: ${profile.id}${isDefault ? " (default)" : ""}`, ...profileDetails(profile).map(([k, v]) => `${k}: ${v}`)].join("\n");
    this.contextValue = isDefault ? CLI_DEFAULT_PROFILE_CONTEXT : CLI_PROFILE_CONTEXT;
    this.iconPath = new vscode.ThemeIcon(isDefault ? "star-full" : "rocket");
  }
}

export class ProfileDetailItem extends vscode.TreeItem {
  constructor(profileId: string, label: string, value: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `cliProfile:${profileId}/${label}`;
    this.description = value;
    this.tooltip = `${label}: ${value}`;
    this.contextValue = PROFILE_DETAIL_CONTEXT;
  }
}

/** The default first, then by id. */
export function sortedCliProfiles(a: ProfilesAnswer): CliProfile[] {
  return [...a.profiles].sort((x, y) => Number(y.id === a.default) - Number(x.id === a.default) || x.id.localeCompare(y.id));
}

export type CliProfilesLoad =
  | { kind: "ok"; data: ProfilesAnswer }
  /** No CLI, a bad a4sx.cliPath, a remote window, or inside an a4sx session: the server's list as before. */
  | { kind: "unavailable" }
  | { kind: "too-old" }
  | { kind: "error"; message: string };

export interface CliProfilesSource {
  load(): Promise<CliProfilesLoad>;
}

/** Reads `a4sx profiles --json` behind the version gate (`gate` defaults to running `a4sx --version`). */
export async function loadCliProfiles(
  resolve: () => CliResolution, run: CliRunner, gate?: (cli: string) => Promise<"ok" | "too-old" | "unknown">,
): Promise<CliProfilesLoad> {
  const r = resolve();
  if (r.kind !== "found") {
    return { kind: "unavailable" };
  }
  const g = gate ? await gate(r.path) : cliGate(parseCliVersion((await run(r.path, VERSION_ARGS, 15_000)).stdout));
  if (g === "too-old") {
    return { kind: "too-old" };
  }
  const out = await run(r.path, PROFILES_ARGS, 30_000);
  if (out.code !== 0 && /invalid choice|unrecognized arguments/.test(out.stderr)) {
    return { kind: "too-old" };
  }
  const data = out.code === 0 ? parseProfilesAnswer(out.stdout) : undefined;
  if (data) {
    return { kind: "ok", data };
  }
  return { kind: "error", message: parseCliError(out.stdout)?.message ?? CLI_PROFILE_TEXTS.cliFailed };
}

export class ProfilesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  state: ProfilesViewState = "signed-out";
  /** The last list the server sent; commands work on it. */
  data: ProfilesState | undefined;
  /** A list a write just returned: the next getChildren shows it instead of asking again. */
  private pending: ProfilesState | undefined;

  /** The CLI's list, when the view shows it (0.5.0); undefined: the server's list. */
  cliData: ProfilesAnswer | undefined;

  constructor(
    private readonly auth: ProfileTokenSource,
    private readonly client: () => Client,
    private readonly onState: (state: ProfilesViewState) => void,
    private readonly cli?: CliProfilesSource,
    private readonly onSource: (fromCli: boolean) => void = () => undefined,
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
    if (parent instanceof CliProfileItem) {
      return profileDetails(parent.profile).map(([k, v]) => new ProfileDetailItem(parent.profile.id, k, v));
    }
    if (parent) {
      return [];
    }
    // 0.5.0: the a4sx CLI's list (with header names, env keys and the cells using each profile) when it has
    // one; else the server's list with the sidebar's sign-in, as before.
    const cli: CliProfilesLoad = this.cli ? await this.cli.load().catch((): CliProfilesLoad => ({ kind: "unavailable" })) : { kind: "unavailable" };
    if (cli.kind === "ok") {
      this.cliData = cli.data;
      this.pending = undefined;
      this.onSource(true);
      if (cli.data.profiles.length === 0) {
        this.set("empty");
        return [new MessageItem(NO_PROFILES, "add", { command: "a4sx.createProfile", title: "Create" })];
      }
      this.set("ok");
      return sortedCliProfiles(cli.data).map((p) => new CliProfileItem(p, p.id === cli.data.default));
    }
    this.cliData = undefined;
    this.onSource(false);
    const api = await this.serverChildren();
    const note = cli.kind === "too-old"
      ? new MessageItem(CLI_PROFILE_TEXTS.updateCli, "warning", { command: "a4sx.updateCli", title: "Update a4sx CLI" })
      : cli.kind === "error" ? new MessageItem(cli.message, "warning", { command: "a4sx.refreshProfiles", title: "Refresh" }) : undefined;
    // Signed out, the tree stays empty so the welcome's "Sign in" shows.
    return note && api.length ? [note, ...api] : api;
  }

  private async serverChildren(): Promise<vscode.TreeItem[]> {
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
        const scope = e.requiredScope.slice(0, SERVER_LINE_MAX);
        if (!STEP_UP_SCOPES.includes(scope)) {
          return [new MessageItem(MESSAGES.needsScope(scope), "info")];   // never offered as a sign-in
        }
        return [new MessageItem(ALLOW_SCOPE_ITEM(scope), "key", { command: "a4sx.allowScope", title: "Sign in", arguments: [scope] })];
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
