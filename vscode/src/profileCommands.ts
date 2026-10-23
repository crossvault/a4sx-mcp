// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The Launch profiles actions (create, edit one field, set default, delete) and the profile pick for
// "Resume in terminal". Writes need `profiles:write`, asked for with a new sign-in the first time.
// The server address is read-only here (a library key may not set it): Edit shows it and offers the
// a4sx CLI or the website. A changed default is confirmed in a modal that names the address. Adding a
// flag that turns off permission prompts is refused; keeping or removing one is fine.
// No API key is ever asked for, shown or stored: a profile holds none.
import * as vscode from "vscode";
import {
  ApiError, Client, deleteProfile, MESSAGES, listProfiles, nextDefaultAfterDelete, Profile, PROFILE_ID, ProfilesState, putProfile,
  SCOPE_PROFILES_READ, SCOPE_PROFILES_WRITE, setDefaultProfile,
} from "./api";
import {
  DEFAULT_MARK, displayAddress, HIDDEN_FIELDS, hiddenCount, MASK, NOT_SET, ProfileItem, profileName, ProfilesProvider, SECRET_FLAG, secretFlags,
  shownFlags, sortedProfiles,
} from "./profilesView";
import { callWithScope, ensureScope, errorText, ScopedAuth } from "./stepUp";

export const PROFILE_TEXTS = {
  createTitle: "Create launch profile",
  editTitle: (name: string) => `Edit launch profile "${name}"`,
  idPrompt: "Profile id: lowercase letters, digits, - and _",
  idPlaceholder: "for example: work",
  idInvalid: "Use up to 64 lowercase letters, digits, - and _, starting with a letter or digit.",
  idTaken: "A launch profile with this id already exists.",
  pickField: "Choose what to change",
  fields: { name: "Name", model: "Model", base_url: "Server address", harness: "Harness", flags: "Flags" },
  readOnlyHere: "Read-only here",
  prompts: {
    name: "Name shown in the list. Leave empty to show the id.",
    model: "Model. Leave empty to use the CLI's default.",
    harness: "Harness, for example claude-code. Leave empty to use the CLI's default.",
    flags: "Launch flags, separated by spaces. Leave empty for none.",
  },
  addressReadOnly: MESSAGES.baseUrlNeedsSignin,
  openWebsite: "Open on the website",
  runCli: "Run a4sx profile",
  flagsHiddenKept: "Flags with a key or token are hidden here and kept as they are.",
  tooLong: (max: number) => `Use at most ${max} characters.`,
  flagsSecret: "Flags can't contain an API key or token.",
  flagsTooMany: "Use at most 20 flags of up to 128 characters each.",
  maskTyped: "Type the whole value instead of ••••.",
  permissionFlag: MESSAGES.permissionFlagNeedsSignin,
  cliDefaultAddress: "the CLI's default server address",
  confirmDefault: (name: string, address: string) => `New launches will use "${name}" and send their requests to ${address}. Make it the default?`,
  makeDefault: "Make default",
  confirmDelete: (name: string) => `Delete the launch profile "${name}"?`,
  confirmDeleteDefault: (name: string, next: string, address: string) =>
    `Delete the launch profile "${name}"? "${next}" becomes the default, and new launches send their requests to ${address}.`,
  confirmDeleteDefaultUnknown: (name: string) =>
    `Delete the launch profile "${name}"? Another profile becomes the default. Check which one in the list, and pick a new default if you need to.`,
  confirmReplace: (id: string) => `A launch profile "${id}" already exists. Replace it?`,
  replace: "Replace",
  loadingProfiles: "Loading launch profiles…",
  delete: "Delete",
  pickForResume: "Choose a launch profile",
};

export type ProfileField = keyof typeof PROFILE_TEXTS.fields;
/** What Edit may change. The server address is shown but not editable. */
export type EditableField = Exclude<ProfileField, "base_url">;
const FIELD_ORDER: ProfileField[] = ["name", "model", "base_url", "harness", "flags"];
const MAX_LEN: Record<Exclude<EditableField, "flags">, number> = { name: 64, model: 128, harness: 64 };

/** Where the server address can be changed: the a4sx CLI in a terminal, or the website. */
export interface AddressElsewhere {
  website(): Promise<void>;
  cli(profileId: string): Promise<void>;
}

export interface ProfileDeps {
  auth: ScopedAuth;
  client: () => Client;
  view: ProfilesProvider;
  elsewhere?: AddressElsewhere;
}

export function validateProfileId(raw: string, taken: readonly string[] = []): string | undefined {
  const id = raw.trim();
  if (!PROFILE_ID.test(id)) {
    return PROFILE_TEXTS.idInvalid;
  }
  return taken.includes(id) ? PROFILE_TEXTS.idTaken : undefined;
}

export function parseFlags(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean);
}

/** `kept`: how many hidden (credential) flags are kept besides the typed ones. */
export function validateFlags(raw: string, kept = 0): string | undefined {
  const flags = parseFlags(raw);
  if (flags.length + kept > 20 || flags.some((f) => f.length > 128)) {
    return PROFILE_TEXTS.flagsTooMany;
  }
  if (flags.some((f) => f.includes(MASK))) {
    return PROFILE_TEXTS.maskTyped;
  }
  return flags.some((f) => SECRET_FLAG.test(f)) ? PROFILE_TEXTS.flagsSecret : undefined;
}

const squash = (f: string) => f.toLowerCase().replace(/[-_]/g, "");

/**
 * The permission-loosening flags in a list, by kind, in any spelling: `--dangerously-skip-permissions`
 * (also `--dangerously_skip_permissions`, `--allow-dangerously-skip-permissions`, any case) and
 * `--permission-mode bypassPermissions` / `--permission-mode=bypassPermissions`.
 */
export function looseningFlags(flags: readonly string[]): { skip: number; bypass: number } {
  const out = { skip: 0, bypass: 0 };
  for (let i = 0; i < flags.length; i++) {
    const f = squash(flags[i]);
    if (f.includes("dangerouslyskippermissions")) {
      out.skip++;
    } else if (/^permissionmode(=|$)/.test(f)) {
      const value = f.includes("=") ? f.slice(f.indexOf("=") + 1) : squash(flags[i + 1] ?? "");
      if (value.replace(/["']/g, "") === "bypasspermissions") {
        out.bypass++;
      }
    }
  }
  return out;
}

/** True when `after` has more permission-loosening flags of some kind than `before` (adding one). */
export function addsLooseningFlag(before: readonly string[], after: readonly string[]): boolean {
  const a = looseningFlags(before);
  const b = looseningFlags(after);
  return b.skip > a.skip || b.bypass > a.bypass;
}

export function validateField(field: EditableField, raw: string): string | undefined {
  if (field === "flags") {
    return validateFlags(raw);
  }
  return raw.trim().length > MAX_LEN[field] ? PROFILE_TEXTS.tooLong(MAX_LEN[field]) : undefined;
}

/** A field as it may be shown: flags with a key or token are masked. */
function shownText(p: Profile, field: ProfileField): string {
  if (field === "flags") {
    return shownFlags(p.flags).join(" ");
  }
  if (field === "base_url") {
    return displayAddress(typeof p.base_url === "string" ? p.base_url : undefined) ?? "";
  }
  const v = p[field];
  return typeof v === "string" ? v : "";
}

function flagList(p: Profile): string[] {
  return Array.isArray(p.flags) ? p.flags.filter((f): f is string => typeof f === "string") : [];
}

/** The flags split into the ones that may be shown and edited, and the hidden ones (kept unchanged). */
export function splitFlags(p: Profile): { visible: string[]; hidden: string[] } {
  const flags = flagList(p);
  const secret = secretFlags(flags);
  return { visible: flags.filter((_f, i) => !secret[i]), hidden: flags.filter((_f, i) => secret[i]) };
}

/** The profile with one field changed; an empty value removes the field (the CLI's default applies). */
export function withField(p: Profile, field: EditableField, raw: string): Profile {
  const next: Profile = { ...p };
  const value = raw.trim();
  if (field === "flags") {
    const flags = parseFlags(value);
    if (flags.length) {
      next.flags = flags;
    } else {
      delete next.flags;
    }
  } else if (value) {
    next[field] = value;
  } else {
    delete next[field];
  }
  return next;
}

function addressOf(p: Profile | undefined): string {
  return displayAddress(typeof p?.base_url === "string" ? p.base_url : undefined) ?? PROFILE_TEXTS.cliDefaultAddress;
}

async function confirm(message: string, button: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true }, button)) === button;
}

async function input(title: string, prompt: string, value: string, validate: (v: string) => string | undefined, placeHolder?: string): Promise<string | undefined> {
  const got = await vscode.window.showInputBox({ title, prompt, value, placeHolder, validateInput: (v) => validate(v) ?? null });
  if (got === undefined) {
    return undefined;
  }
  const problem = validate(got);
  if (problem) {
    await vscode.window.showErrorMessage(problem);
    return undefined;
  }
  return got;
}

/** Refusals that keep the edit open with the server's message (the box opens again). */
const KEEP_OPEN = new Set(["credential-in-profile", "hidden-bound-to-host", "base-url-needs-signin", "permission-flag-needs-signin"]);

/**
 * Runs one profile write with a key holding profiles:write, and shows the list it returns. With
 * `keepOpen`, a refusal in KEEP_OPEN is returned (not shown), so the caller can open the box again.
 */
async function write(
  deps: ProfileDeps, token: string, call: (c: Client, token: string) => Promise<ProfilesState>, keepOpen = false,
): Promise<ApiError | undefined> {
  try {
    const client = deps.client();
    const done = await callWithScope(deps.auth, token, (t) => call(client, t));
    if (done) {
      deps.view.show(done.value);
    }
  } catch (e) {
    if (keepOpen && e instanceof ApiError && KEEP_OPEN.has(e.code)) {
      return e;
    }
    await vscode.window.showErrorMessage(errorText(e));
    if (e instanceof ApiError && e.code === "not-found") {
      deps.view.refresh();
    }
  }
  return undefined;
}

export async function createProfile(deps: ProfileDeps): Promise<void> {
  const token = await ensureScope(deps.auth, SCOPE_PROFILES_WRITE);
  if (!token) {
    return;
  }
  let state = deps.view.data;
  if (!state) {
    try {
      state = await listProfiles(deps.client(), token);
    } catch (e) {
      await vscode.window.showErrorMessage(errorText(e));
      return;
    }
  }
  const taken = state.profiles.map(([id]) => id);
  const t = PROFILE_TEXTS;
  const id = await input(t.createTitle, t.idPrompt, "", (v) => validateProfileId(v, taken), t.idPlaceholder);
  if (id === undefined) {
    return;
  }
  const model = await input(t.createTitle, t.prompts.model, "", (v) => validateField("model", v));
  if (model === undefined) {
    return;
  }
  const pid = id.trim();
  // No server address: a library key may not set one (the CLI's default applies until it is set
  // with the a4sx CLI or on the website).
  let profile = withField({}, "model", model);
  // The list may have changed while the boxes were open (another window, the CLI, the web).
  let now: ProfilesState;
  try {
    now = await listProfiles(deps.client(), token);
  } catch (e) {
    await vscode.window.showErrorMessage(errorText(e));
    return;
  }
  const existing = now.profiles.find(([pid2]) => pid2 === pid)?.[1];
  if (existing && !(await confirm(t.confirmReplace(pid), t.replace))) {
    return;
  }
  if (existing && typeof existing.base_url === "string" && existing.base_url) {
    profile = { ...profile, base_url: existing.base_url };   // replacing keeps the address it has
  }
  if (Object.keys(profile).length === 0) {
    // The server wants a non-empty profile; a name equal to the id changes nothing that is shown.
    profile = { name: pid };
  }
  // The server makes the first profile the default.
  if (!now.default && !existing && !(await confirm(t.confirmDefault(pid, addressOf(profile)), t.makeDefault))) {
    return;
  }
  await write(deps, token, (c, tok) => putProfile(c, tok, pid, profile));
}

/** The server address is read-only here: say where it can be changed and offer both ways. */
async function addressElsewhere(deps: ProfileDeps, item: ProfileItem): Promise<void> {
  const t = PROFILE_TEXTS;
  const buttons = deps.elsewhere ? [t.runCli, t.openWebsite] : [];
  const choice = await vscode.window.showInformationMessage(t.addressReadOnly, ...buttons);
  if (choice === t.runCli) {
    await deps.elsewhere?.cli(item.id);
  } else if (choice === t.openWebsite) {
    await deps.elsewhere?.website();
  }
}

export async function editProfile(deps: ProfileDeps, item: ProfileItem | undefined): Promise<void> {
  if (!item) {
    return;
  }
  const token = await ensureScope(deps.auth, SCOPE_PROFILES_WRITE);
  if (!token) {
    return;
  }
  const t = PROFILE_TEXTS;
  const name = profileName(item.id, item.profile);
  const hiddenOnServer = hiddenCount(item.profile);
  const picked = await vscode.window.showQuickPick(
    FIELD_ORDER.map((field) => ({
      label: t.fields[field],
      description: shownText(item.profile, field) || (field === "base_url" ? t.cliDefaultAddress : NOT_SET),
      detail: field === "base_url" ? t.readOnlyHere : undefined,
      field,
    })),
    { title: t.editTitle(name), placeHolder: hiddenOnServer ? `${t.pickField}. ${HIDDEN_FIELDS(hiddenOnServer)}` : t.pickField },
  );
  if (!picked) {
    return;
  }
  if (picked.field === "base_url") {
    await addressElsewhere(deps, item);
    return;
  }
  const field: EditableField = picked.field;
  // A refusal in KEEP_OPEN keeps the edit open: the box opens again with the server's message.
  // It is prefilled with the stored value, never with what was just sent.
  let notice: string | undefined;
  for (;;) {
    let next: Profile;
    if (field === "flags") {
      // Flags with a key or token are never prefilled; they are kept as they are.
      const { visible, hidden } = splitFlags(item.profile);
      const stored = flagList(item.profile);
      const prompt = notice ?? (hidden.length ? `${t.prompts.flags} ${t.flagsHiddenKept}` : t.prompts.flags);
      const check = (v: string) => validateFlags(v, hidden.length)
        ?? (addsLooseningFlag(stored, [...parseFlags(v), ...hidden]) ? t.permissionFlag : undefined);
      const value = await input(t.editTitle(name), prompt, visible.join(" "), check);
      if (value === undefined) {
        return;
      }
      if (JSON.stringify(parseFlags(value)) === JSON.stringify(visible)) {
        return;   // unchanged: the stored order (hidden flags included) stays as it is
      }
      next = withField(item.profile, "flags", [...parseFlags(value), ...hidden].join(" "));
    } else {
      const before = shownText(item.profile, field);
      const value = await input(t.editTitle(name), notice ?? t.prompts[field], before, (v) => validateField(field, v));
      if (value === undefined) {
        return;
      }
      next = withField(item.profile, field, value);
      if (shownText(next, field) === before) {
        return;
      }
    }
    const profile = next;
    const refused = await write(deps, token, (c, tok) => putProfile(c, tok, item.id, profile), true);
    if (!refused) {
      return;
    }
    notice = refused.message;
  }
}

export async function setDefault(deps: ProfileDeps, item: ProfileItem | undefined): Promise<void> {
  if (!item || item.isDefault) {
    return;
  }
  const token = await ensureScope(deps.auth, SCOPE_PROFILES_WRITE);
  if (!token) {
    return;
  }
  const t = PROFILE_TEXTS;
  if (!(await confirm(t.confirmDefault(profileName(item.id, item.profile), addressOf(item.profile)), t.makeDefault))) {
    return;
  }
  await write(deps, token, (c, tok) => setDefaultProfile(c, tok, item.id));
}

export async function removeProfile(deps: ProfileDeps, item: ProfileItem | undefined): Promise<void> {
  if (!item) {
    return;
  }
  const token = await ensureScope(deps.auth, SCOPE_PROFILES_WRITE);
  if (!token) {
    return;
  }
  const t = PROFILE_TEXTS;
  const name = profileName(item.id, item.profile);
  // Deleting the default makes the first remaining profile (in the server's stored order) the default.
  let message = t.confirmDelete(name);
  const state = deps.view.data;
  if (item.isDefault && state) {
    const nextId = nextDefaultAfterDelete(state, item.id);
    const next = nextId ? state.profiles.find(([id]) => id === nextId) : undefined;
    if (next) {
      message = t.confirmDeleteDefault(name, profileName(next[0], next[1]), addressOf(next[1]));
    } else if (nextId === undefined) {
      message = t.confirmDeleteDefaultUnknown(name);
    }
  }
  if (!(await confirm(message, t.delete))) {
    return;
  }
  await write(deps, token, (c, tok) => deleteProfile(c, tok, item.id));
}

/**
 * The profile for "Resume in terminal": with more than one profile, a quick pick (default first).
 * Resolves to { id } for the picked profile, {} when there is nothing to pick (one or no profile,
 * no `profiles:read`, an older server or any error: the CLI then uses your default), or undefined
 * when the pick was dismissed.
 */
export async function pickProfileForResume(auth: ScopedAuth, client: () => Client): Promise<{ id?: string } | undefined> {
  let state: ProfilesState;
  try {
    const cur = await auth.current();
    if (!cur || !cur.scopes.includes(SCOPE_PROFILES_READ)) {
      return {};
    }
    state = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: PROFILE_TEXTS.loadingProfiles },
      () => listProfiles(client(), cur.token),
    );
  } catch {
    return {};
  }
  const list = sortedProfiles(state).filter(([id]) => PROFILE_ID.test(id));
  if (list.length <= 1) {
    return {};
  }
  const picked = await vscode.window.showQuickPick(
    list.map(([id, p]) => {
      const name = profileName(id, p);
      const model = typeof p.model === "string" && p.model ? p.model : undefined;
      return {
        label: name,
        description: [id === state.default ? DEFAULT_MARK : undefined, name !== id ? id : undefined, model].filter(Boolean).join(" · "),
        detail: addressOf(p),
        id,
      };
    }),
    { placeHolder: PROFILE_TEXTS.pickForResume },
  );
  return picked ? { id: picked.id } : undefined;
}
