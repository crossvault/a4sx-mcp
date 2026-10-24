// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The Launch profiles actions (create, edit one field, delete) and the profile pick for "Resume in
// terminal". Writes need `profiles:write`, asked for with a new sign-in the first time.
// A library key may change only a profile's name and model. Everything else (flags, server address,
// harness, router, headers) is shown read-only, and Edit offers the a4sx CLI or the website for it; so
// do changing the default and deleting the default or a profile with hidden settings. A write sends
// only `name` and/or `model`: the server keeps every field it doesn't receive as it is.
// No API key is ever asked for, shown or stored: a profile holds none.
import * as vscode from "vscode";
import {
  ApiError, Client, deleteProfile, MESSAGES, listProfiles, Profile, PROFILE_ID, ProfilesState, putProfile,
  SCOPE_PROFILES_READ, SCOPE_PROFILES_WRITE,
} from "./api";
import {
  DEFAULT_MARK, deletable, DELETE_ELSEWHERE, displayAddress, HIDDEN_FIELDS, hiddenCount, NOT_SET, ProfileItem, profileName,
  ProfilesProvider, shownFlags, sortedProfiles,
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
  fields: { name: "Name", model: "Model", flags: "Flags", base_url: "Server address", harness: "Harness", router: "Router", headers: "Headers" },
  readOnlyHere: "Read-only here",
  prompts: {
    name: "Name shown in the list. Leave empty to show the id.",
    model: "Model. Leave empty to use the CLI's default.",
  },
  nameInvalid: "Use up to 64 letters, digits, spaces and . _ ( ) -.",
  modelInvalid: "Use up to 64 letters, digits and . _ : / [ ] -, starting with a letter or digit.",
  readOnly: MESSAGES.needsSignin,
  routerOn: "on",
  routerOff: "off",
  headerCount: (n: number) => (n === 1 ? "1 header" : `${n} headers`),
  openWebsite: "Open on the website",
  runCli: "Run a4sx profile",
  deleteElsewhere: DELETE_ELSEWHERE,
  cliDefaultAddress: "the CLI's default server address",
  confirmDelete: (name: string) => `Delete the launch profile "${name}"?`,
  confirmReplace: (id: string) => `A launch profile "${id}" already exists. Change its name and model?`,
  replace: "Change",
  loadingProfiles: "Loading launch profiles…",
  delete: "Delete",
  pickForResume: "Choose a launch profile",
};

export type ProfileField = keyof typeof PROFILE_TEXTS.fields;
/** What Edit may change; every other field is shown read-only. */
export type EditableField = "name" | "model";
const EDITABLE: readonly ProfileField[] = ["name", "model"];
const READ_ONLY: readonly ProfileField[] = ["flags", "base_url", "harness", "router", "headers"];

export function isEditable(field: ProfileField): field is EditableField {
  return EDITABLE.includes(field);
}

/** Where a read-only setting can be changed: the a4sx CLI in a terminal, or the website. */
export interface AddressElsewhere {
  website(): Promise<void>;
  cli(profileId: string): Promise<void>;
  /** Runs the CLI's own set-default command for the profile. */
  setDefault(profileId: string): Promise<void>;
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

/** The server's rules for what a key may write. Empty: the name falls back to the id, the model to the CLI's default. */
export function validateField(field: EditableField, raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  if (field === "name") {
    return /^[A-Za-z0-9 ._()-]{1,64}$/.test(value) ? undefined : PROFILE_TEXTS.nameInvalid;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,63}$/.test(value) ? undefined : PROFILE_TEXTS.modelInvalid;
}

/**
 * The body of a key write: only the field changed. An empty name is left out (the list then shows
 * the id); an empty model is "" (the CLI's default).
 */
export function fieldBody(field: EditableField, raw: string): Profile {
  const value = raw.trim();
  if (field === "name") {
    return value ? { name: value } : {};
  }
  return { model: value };
}

/** A field as it may be shown: flags with a key or token are masked; header names and values never. */
function shownText(p: Profile, field: ProfileField): string {
  if (field === "flags") {
    return shownFlags(p.flags).join(" ");
  }
  if (field === "base_url") {
    return displayAddress(typeof p.base_url === "string" ? p.base_url : undefined) ?? "";
  }
  if (field === "router") {
    if (typeof p.use_router !== "boolean") {
      return "";
    }
    const tenant = typeof p.router_tenant === "string" && p.router_tenant ? p.router_tenant : undefined;
    return [p.use_router ? PROFILE_TEXTS.routerOn : PROFILE_TEXTS.routerOff, tenant].filter(Boolean).join(" · ");
  }
  if (field === "headers") {
    const n = p.headers && typeof p.headers === "object" && !Array.isArray(p.headers) ? Object.keys(p.headers).length : 0;
    return n ? PROFILE_TEXTS.headerCount(n) : "";
  }
  const v = p[field];
  return typeof v === "string" ? v : "";
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
const KEEP_OPEN = new Set([
  "credential-in-profile", "hidden-bound-to-host", "base-url-needs-signin", "permission-flag-needs-signin", "needs-signin", "conflict", "rejected",
]);

/**
 * Runs one profile write with a key holding profiles:write, and shows the list it returns. With
 * `keepOpen`, a refusal in KEEP_OPEN is returned (not shown), so the caller can open the box again.
 */
async function write(
  deps: ProfileDeps, token: string, call: (c: Client, token: string) => Promise<ProfilesState | undefined>, keepOpen = false,
): Promise<ApiError | undefined> {
  try {
    const client = deps.client();
    const done = await callWithScope(deps.auth, token, (t) => call(client, t));
    if (done?.value) {
      deps.view.show(done.value);
    } else if (done) {
      deps.view.refresh();   // the write succeeded but the reply has no list (a key that can't read)
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
  const pid = id.trim();
  const name = await input(t.createTitle, t.prompts.name, "", (v) => validateField("name", v));
  if (name === undefined) {
    return;
  }
  const model = await input(t.createTitle, t.prompts.model, "", (v) => validateField("model", v));
  if (model === undefined) {
    return;
  }
  // Only a name and a model: a key sets nothing else (no flags, no server address).
  const profile: Profile = { ...fieldBody("name", name), ...(model.trim() ? { model: model.trim() } : {}) };
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
  await write(deps, token, (c, tok) => putProfile(c, tok, pid, profile));
}

/** Something a key may not change: say where it can be changed and offer both ways. */
async function changeElsewhere(
  deps: ProfileDeps, item: ProfileItem, message: string = PROFILE_TEXTS.readOnly, runCli?: (id: string) => Promise<void>,
): Promise<void> {
  const t = PROFILE_TEXTS;
  const buttons = deps.elsewhere ? [t.runCli, t.openWebsite] : [];
  const choice = await vscode.window.showInformationMessage(message, ...buttons);
  if (choice === t.runCli) {
    await (runCli ?? deps.elsewhere?.cli)?.(item.id);
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
    [...EDITABLE, ...READ_ONLY].map((field) => ({
      label: t.fields[field],
      description: shownText(item.profile, field) || (field === "base_url" ? t.cliDefaultAddress : NOT_SET),
      detail: isEditable(field) ? undefined : t.readOnlyHere,
      field,
    })),
    { title: t.editTitle(name), placeHolder: hiddenOnServer ? `${t.pickField}. ${HIDDEN_FIELDS(hiddenOnServer)}` : t.pickField },
  );
  if (!picked) {
    return;
  }
  if (!isEditable(picked.field)) {
    await changeElsewhere(deps, item);
    return;
  }
  const field: EditableField = picked.field;
  const before = shownText(item.profile, field);
  // A refusal in KEEP_OPEN keeps the edit open: the box opens again with the server's message.
  // It is prefilled with the stored value, never with what was just sent.
  let notice: string | undefined;
  for (;;) {
    const value = await input(t.editTitle(name), notice ?? t.prompts[field], before, (v) => validateField(field, v));
    if (value === undefined) {
      return;
    }
    const body = fieldBody(field, value);
    if (!(field in body) || body[field] === before) {
      return;   // unchanged (an empty name sends nothing: the server keeps the stored one)
    }
    const refused = await write(deps, token, (c, tok) => putProfile(c, tok, item.id, body), true);
    if (!refused) {
      return;
    }
    notice = refused.message;
  }
}

/** The default is changed only with the a4sx CLI or on the website: offer both. The CLI button runs `a4sx profile --set-default ID`. */
export async function changeDefault(deps: ProfileDeps, item: ProfileItem | undefined): Promise<void> {
  if (item) {
    await changeElsewhere(deps, item, PROFILE_TEXTS.readOnly, deps.elsewhere?.setDefault);
  }
}

export async function removeProfile(deps: ProfileDeps, item: ProfileItem | undefined): Promise<void> {
  if (!item) {
    return;
  }
  const t = PROFILE_TEXTS;
  if (!deletable(item.isDefault, item.profile)) {
    // The default, or a profile with hidden settings: a key may not delete it.
    await changeElsewhere(deps, item, t.deleteElsewhere);
    return;
  }
  const token = await ensureScope(deps.auth, SCOPE_PROFILES_WRITE);
  if (!token) {
    return;
  }
  if (!(await confirm(t.confirmDelete(profileName(item.id, item.profile)), t.delete))) {
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
