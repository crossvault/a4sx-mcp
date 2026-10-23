// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The Launch profiles actions (create, edit one field, set default, delete) and the profile pick for
// "Resume in terminal". Writes need `profiles:write`, asked for with a new sign-in the first time.
// A changed server address, or a changed default, is confirmed in a modal that names the address.
// No API key is ever asked for, shown or stored: a profile holds none.
import * as vscode from "vscode";
import {
  ApiError, Client, deleteProfile, listProfiles, nextDefaultAfterDelete, Profile, PROFILE_ID, ProfilesState, putProfile,
  SCOPE_PROFILES_READ, SCOPE_PROFILES_WRITE, setDefaultProfile,
} from "./api";
import {
  DEFAULT_MARK, displayAddress, NOT_SET, ProfileItem, profileName, ProfilesProvider, SECRET_FLAG, secretFlags, shownFlags, sortedProfiles,
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
  prompts: {
    name: "Name shown in the list. Leave empty to show the id.",
    model: "Model. Leave empty to use the CLI's default.",
    base_url: "Server address (base_url). Leave empty to use the CLI's default.",
    harness: "Harness, for example claude-code. Leave empty to use the CLI's default.",
    flags: "Launch flags, separated by spaces. Leave empty for none.",
  },
  flagsHiddenKept: "Flags with a key or token are hidden here and kept as they are.",
  baseUrlInvalid: "Enter an http:// or https:// address without a user name, password or query.",
  tooLong: (max: number) => `Use at most ${max} characters.`,
  flagsSecret: "Flags can't contain an API key or token.",
  flagsTooMany: "Use at most 20 flags of up to 128 characters each.",
  cliDefaultAddress: "the CLI's default server address",
  confirmBaseUrl: (name: string, address: string) => `Launches with "${name}" will send their requests to ${address}. Change the server address?`,
  changeAddress: "Change address",
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
const FIELD_ORDER: ProfileField[] = ["name", "model", "base_url", "harness", "flags"];
const MAX_LEN: Record<Exclude<ProfileField, "flags">, number> = { name: 64, model: 128, base_url: 512, harness: 64 };

export interface ProfileDeps {
  auth: ScopedAuth;
  client: () => Client;
  view: ProfilesProvider;
}

export function validateProfileId(raw: string, taken: readonly string[] = []): string | undefined {
  const id = raw.trim();
  if (!PROFILE_ID.test(id)) {
    return PROFILE_TEXTS.idInvalid;
  }
  return taken.includes(id) ? PROFILE_TEXTS.idTaken : undefined;
}

/** An http(s) address with a host and no user name, password, query or fragment. Empty is allowed (the CLI's default). */
export function validateBaseUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return PROFILE_TEXTS.baseUrlInvalid;
  }
  if (!(u.protocol === "http:" || u.protocol === "https:") || !u.hostname || u.username || u.password || u.search || u.hash
    || value.includes("?") || value.includes("#")) {
    return PROFILE_TEXTS.baseUrlInvalid;
  }
  return value.length > MAX_LEN.base_url ? PROFILE_TEXTS.tooLong(MAX_LEN.base_url) : undefined;
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
  return flags.some((f) => SECRET_FLAG.test(f)) ? PROFILE_TEXTS.flagsSecret : undefined;
}

export function validateField(field: ProfileField, raw: string): string | undefined {
  if (field === "base_url") {
    return validateBaseUrl(raw);
  }
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
export function withField(p: Profile, field: ProfileField, raw: string): Profile {
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

/** Runs one profile write with a key holding profiles:write, and shows the list it returns. */
async function write(deps: ProfileDeps, token: string, call: (c: Client, token: string) => Promise<ProfilesState>): Promise<void> {
  try {
    const client = deps.client();
    const done = await callWithScope(deps.auth, token, (t) => call(client, t));
    if (done) {
      deps.view.show(done.value);
    }
  } catch (e) {
    await vscode.window.showErrorMessage(errorText(e));
    if (e instanceof ApiError && e.code === "not-found") {
      deps.view.refresh();
    }
  }
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
  const fresh = async (): Promise<ProfilesState | undefined> => {
    try {
      return await listProfiles(deps.client(), token);
    } catch (e) {
      await vscode.window.showErrorMessage(errorText(e));
      return undefined;
    }
  };
  const id = await input(t.createTitle, t.idPrompt, "", (v) => validateProfileId(v, taken), t.idPlaceholder);
  if (id === undefined) {
    return;
  }
  const model = await input(t.createTitle, t.prompts.model, "", (v) => validateField("model", v));
  if (model === undefined) {
    return;
  }
  const base = await input(t.createTitle, t.prompts.base_url, "", validateBaseUrl);
  if (base === undefined) {
    return;
  }
  const pid = id.trim();
  let profile = withField(withField({}, "model", model), "base_url", base);
  if (Object.keys(profile).length === 0) {
    // The server wants a non-empty profile; a name equal to the id changes nothing that is shown.
    profile = { name: pid };
  }
  // The list may have changed while the boxes were open (another window, the CLI, the web).
  const now = await fresh();
  if (!now) {
    return;
  }
  const existing = now.profiles.find(([pid2]) => pid2 === pid)?.[1];
  if (existing && !(await confirm(t.confirmReplace(pid), t.replace))) {
    return;
  }
  // The server makes the first profile the default.
  const becomesDefault = !now.default && !existing;
  const addressChanged = existing ? addressOf(existing) !== addressOf(profile) : !!profile.base_url;
  if (becomesDefault && !existing) {
    if (!(await confirm(t.confirmDefault(pid, addressOf(profile)), t.makeDefault))) {
      return;
    }
  } else if (addressChanged && !(await confirm(t.confirmBaseUrl(profileName(pid, profile), addressOf(profile)), t.changeAddress))) {
    return;
  }
  await write(deps, token, (c, tok) => putProfile(c, tok, pid, profile));
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
  const picked = await vscode.window.showQuickPick(
    FIELD_ORDER.map((field) => ({ label: t.fields[field], description: shownText(item.profile, field) || NOT_SET, field })),
    { title: t.editTitle(name), placeHolder: t.pickField },
  );
  if (!picked) {
    return;
  }
  const field = picked.field;
  let next: Profile;
  if (field === "flags") {
    // Flags with a key or token are never prefilled; they are kept as they are.
    const { visible, hidden } = splitFlags(item.profile);
    const prompt = hidden.length ? `${t.prompts.flags} ${t.flagsHiddenKept}` : t.prompts.flags;
    const value = await input(t.editTitle(name), prompt, visible.join(" "), (v) => validateFlags(v, hidden.length));
    if (value === undefined) {
      return;
    }
    if (JSON.stringify(parseFlags(value)) === JSON.stringify(visible)) {
      return;   // unchanged: the stored order (hidden flags included) stays as it is
    }
    next = withField(item.profile, "flags", [...parseFlags(value), ...hidden].join(" "));
  } else {
    const before = shownText(item.profile, field);
    const value = await input(t.editTitle(name), t.prompts[field], before, (v) => validateField(field, v));
    if (value === undefined) {
      return;
    }
    next = withField(item.profile, field, value);
    if (shownText(next, field) === before) {
      return;
    }
  }
  if (field === "base_url" && !(await confirm(t.confirmBaseUrl(profileName(item.id, next), addressOf(next)), t.changeAddress))) {
    return;
  }
  await write(deps, token, (c, tok) => putProfile(c, tok, item.id, next));
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
