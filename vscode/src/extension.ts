// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// a4sx for VS Code: registers the a4sx remote MCP servers for agent mode, adds the a4sx sidebar
// (sign-in, "My sessions", "Launch profiles", "Marketplace") and the save/resume commands. The sidebar
// is the only part that calls the a4sx server itself; its scoped token lives only in VS Code's secret storage.
// VS Code connects to the MCP servers when chat uses them, and runs their sign-in itself.
import * as vscode from "vscode";
import { execFile } from "child_process";
import { Client, FetchLike, listingWebUrl, MESSAGES, normalizeServerUrl, PROFILE_ID, sessionWebUrl } from "./api";
import { A4sxAuthProvider, AUTH_ID, AUTH_LABEL, LoginCancelled, LoginRequest, SECRET_KEY, vscodeLogin } from "./auth";
import { CLAUDE_EXTENSION_ID, claudeResumeUri } from "./claudeResume";
import { CLI_NAME, findClaude, findCli, CliLookup } from "./cli";
import { clearFilter, filterSessions, moveToFolder, removeFromFolder } from "./folderCommands";
import { CMD_OPEN_LISTING, ListingItem, MarketplaceProvider } from "./marketplaceView";
import {
  listMeshes, MESH_ID, MESH_TEXTS, meshesPageUrl, meshInviteUrl, meshLaunchArgs, meshPageUrl, parsePreflight, preflightArgs, reducedWarning,
  startable, suggestCellName, validateCellName, VisibilityPoller,
} from "./meshApi";
import {
  CMD_CREATE_MESH, CMD_OPEN_MESH, CMD_OPEN_MESHES, CMD_REDEEM_INVITE, CMD_REFRESH_MESHES, CMD_START_IN_MESH, MeshesProvider, MeshItem, MESHES_AVAILABLE,
} from "./meshesView";
import { changeDefault, createProfile, editProfile, pickProfileForResume, removeProfile } from "./profileCommands";
import { ProfileItem, ProfilesProvider, ProfilesViewState } from "./profilesView";
import { SessionItem, SessionsProvider, ViewState } from "./sessionsView";
import {
  CLAUDE_INSTALL_URL, offerCliInstallOnce, offerProfilesStepUp, openClaudeTerminal, openCommandTerminal, PendingAction, pickFolderWhenNoneOpen, ResumeFolder,
  RESUME_TEXTS, sameFolder, seedWithProgress, State, storePending, takePending,
} from "./resume";
import { errorText, offerStepUp, STEP_UP, stepUpAllowed } from "./stepUp";
import { SESSION_ID } from "./terminalCommand";

export const SITE = "https://session-exchange.com";
export const MCP_URL = `${SITE}/mcp`;
export const MCP_LIBRARY_URL = `${SITE}/mcp/library`;
export const LIBRARY_URL = `${SITE}/library`;
export const INSTALL_URL = `${SITE}/guide/cli`;
export const EXTENSION_ID = "crossvaultGmbH.a4sx";

export const MCP_PROVIDER_ID = "a4sx.mcpServers";
export const CMD_SAVE = "a4sx.saveSession";
export const CMD_OPEN_LIBRARY = "a4sx.openLibrary";
export const CMD_SIGN_IN = "a4sx.signIn";
export const CMD_SIGN_OUT = "a4sx.signOut";
export const CMD_REFRESH = "a4sx.refreshSessions";
export const CMD_RESUME = "a4sx.resumeSession";
export const CMD_RESUME_CLAUDE = "a4sx.resumeInClaude";
export const CMD_OPEN_SESSION = "a4sx.openSessionOnWeb";
export const CMD_COPY_ID = "a4sx.copySessionId";
export const CMD_SEARCH = "a4sx.searchMarketplace";
export const CMD_FILTER = "a4sx.filterSessions";
export const CMD_CLEAR_FILTER = "a4sx.clearSessionFilter";
export const CMD_MOVE_TO_FOLDER = "a4sx.moveToFolder";
export const CMD_REMOVE_FROM_FOLDER = "a4sx.removeFromFolder";
export const CMD_REFRESH_PROFILES = "a4sx.refreshProfiles";
export const CMD_CREATE_PROFILE = "a4sx.createProfile";
export const CMD_EDIT_PROFILE = "a4sx.editProfile";
export const CMD_CHANGE_DEFAULT = "a4sx.changeDefaultElsewhere";
export const CMD_DELETE_PROFILE = "a4sx.deleteProfile";
export const CMD_ALLOW_SCOPE = "a4sx.allowScope";
export { CMD_OPEN_LISTING, CMD_CREATE_MESH, CMD_OPEN_MESH, CMD_OPEN_MESHES, CMD_REDEEM_INVITE, CMD_REFRESH_MESHES, CMD_START_IN_MESH };
export const VIEW_SESSIONS = "a4sx.sessions";
export const VIEW_PROFILES = "a4sx.profiles";
export const VIEW_MARKETPLACE = "a4sx.marketplace";
export const VIEW_MESHES = "a4sx.meshes";
export const MESH_TERMINAL_NAME = "a4sx: mesh session";
export const TERMINAL_NAME = "a4sx: save session";
export const RESUME_TERMINAL_NAME = "a4sx: resume session";
/** `a4sx push --latest`: saves the most recently modified local Claude Code session. */
export const SAVE_ARGS = ["push", "--latest"];

export function mcpServerDefinitions(): vscode.McpServerDefinition[] {
  return [
    // Anonymous: search and summaries of the public marketplace.
    new vscode.McpHttpServerDefinition("a4sx", vscode.Uri.parse(MCP_URL)),
    // Your library: answers 401 until you sign in; VS Code then runs the OAuth sign-in itself.
    new vscode.McpHttpServerDefinition("a4sx library", vscode.Uri.parse(MCP_LIBRARY_URL)),
  ];
}

function lookupCli(lookup: (configured: string | undefined) => CliLookup): CliLookup {
  const configured = vscode.workspace.getConfiguration("a4sx").get<string>("cliPath");
  return lookup(configured);
}

/**
 * The remote's name (`vscode.env.remoteName`, e.g. "ssh-remote") when this window is remote and this
 * extension runs on the remote host; undefined in a local window, or when the extension is set to run
 * on this computer (ExtensionKind.UI). On the remote host, the CLI lookup, the CLI's working directory
 * and its home directory (`~/.local/bin`, `~/.claude`) are all the remote host's.
 */
export function remoteHostName(): string | undefined {
  const name = vscode.env.remoteName;
  if (!name) {
    return undefined;
  }
  return runsOnThisComputer() ? undefined : name;
}

/** True when this extension runs where the UI runs (this computer), as VS Code reports it. */
function runsOnThisComputer(): boolean {
  return vscode.extensions.getExtension(EXTENSION_ID)?.extensionKind === vscode.ExtensionKind.UI;
}

/**
 * The remote's name when the window is remote but this extension runs on this computer. A terminal
 * then opens on the remote host, where a CLI path found on this computer means nothing, and Claude Code
 * reads the remote host's history; so the CLI commands stop with one message instead.
 */
export function remoteWindowButLocalExtension(): string | undefined {
  const name = vscode.env.remoteName;
  return name && runsOnThisComputer() ? name : undefined;
}

export const localExtensionMessage = (label: string) =>
  `This window is connected to ${label}, but the a4sx extension runs on this computer. In the Extensions view, click "Install in ${label}" for a4sx, then try again.`;

/** Shows the message and returns true when the CLI commands can't work from here (see above). */
async function stopIfLocalInRemoteWindow(): Promise<boolean> {
  const remote = remoteWindowButLocalExtension();
  if (!remote) {
    return false;
  }
  await vscode.window.showErrorMessage(localExtensionMessage(remoteLabel(remote)));
  return true;
}

const REMOTE_LABELS: Record<string, string> = {
  "ssh-remote": "SSH",
  wsl: "WSL",
  "dev-container": "dev container",
  "attached-container": "container",
  codespaces: "Codespaces",
  tunnel: "tunnel",
};

/** A readable word for a remote name; unknown names are shown as they are. */
export function remoteLabel(name: string): string {
  return REMOTE_LABELS[name] ?? name;
}

/**
 * A server origin that is safe to paste into a shell unquoted: https, a lowercase host of letters,
 * digits, dots and dashes, an optional port, nothing else (no userinfo, path, query or shell syntax).
 */
const SAFE_ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;

/**
 * The installer one-liner. It uses the configured a4sx.serverUrl only if that is exactly a safe
 * origin (a single trailing slash is allowed); anything else gets the default site.
 */
export function installCommand(): string {
  const configured = (vscode.workspace.getConfiguration("a4sx").get<string>("serverUrl") ?? "").trim().replace(/\/$/, "");
  const base = SAFE_ORIGIN.test(configured) ? configured : SITE;
  return `curl -fsSL ${base}/install.sh | sh`;
}

export const MISSING_CLI = {
  install: "How to install",
  copyInstall: "Copy install command",
  openSettings: "Open settings",
  remoteNotFound: (label: string) => `${CLI_NAME} isn't installed on ${label}. Install it there, then try again.`,
  copied: "Copied the install command. Run it in a terminal in this window.",
};

export async function reportMissingCli(result: Exclude<CliLookup, { found: true }>): Promise<void> {
  const remote = remoteHostName();
  if (remote && result.reason === "not-on-path") {
    const choice = await vscode.window.showErrorMessage(MISSING_CLI.remoteNotFound(remoteLabel(remote)), MISSING_CLI.copyInstall, MISSING_CLI.openSettings);
    if (choice === MISSING_CLI.copyInstall) {
      await vscode.env.clipboard.writeText(installCommand());
      await vscode.window.showInformationMessage(MISSING_CLI.copied);
    } else if (choice === MISSING_CLI.openSettings) {
      await vscode.commands.executeCommand("workbench.action.openSettings", "a4sx.cliPath");
    }
    return;
  }
  const message =
    result.reason === "configured-path-invalid"
      ? `The a4sx.cliPath setting points to "${result.configured}", which is not an executable file. Fix the setting, or clear it to use ${CLI_NAME} from your PATH.`
      : `The ${CLI_NAME} command was not found. Install the ${CLI_NAME} CLI to save and resume sessions from VS Code, or set a4sx.cliPath to its full path.`;
  const choice = await vscode.window.showErrorMessage(message, MISSING_CLI.install);
  if (choice === MISSING_CLI.install) {
    await vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
  }
}

export async function saveSession(lookup: (configured: string | undefined) => CliLookup = findCli): Promise<vscode.Terminal | undefined> {
  if (await stopIfLocalInRemoteWindow()) {
    return undefined;
  }
  const result = lookupCli(lookup);
  if (!result.found) {
    await reportMissingCli(result);
    return undefined;
  }
  // Run the CLI directly (no shell), in a visible terminal, so the user sees every step and prompt.
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    shellPath: result.path,
    shellArgs: SAVE_ARGS,
  });
  terminal.show();
  return terminal;
}

export async function openLibrary(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(LIBRARY_URL));
}

/** Swappable in unit tests: the network and the interactive login. */
export const runtime: { fetch: FetchLike; login: (client: Client, req: LoginRequest) => ReturnType<typeof vscodeLogin> } = {
  fetch: (url, init) => fetch(url, init),
  login: vscodeLogin,
};

export function client(): Client {
  return {
    base: normalizeServerUrl(vscode.workspace.getConfiguration("a4sx").get<string>("serverUrl")),
    fetch: runtime.fetch,
    userAgent: "a4sx-vscode",
  };
}

export async function signIn(auth: A4sxAuthProvider): Promise<void> {
  try {
    await auth.createSession();
  } catch (e) {
    if (!(e instanceof LoginCancelled)) {
      await vscode.window.showErrorMessage(errorText(e));
    }
    return;
  }
  if (native) {
    void offerProfilesStepUp(auth, client, native.state, Date.now());
  }
}

export const SIGNED_OUT_INFO =
  "Signed out of a4sx on this computer. The key stays valid until it expires or you revoke it on the a4sx website under Account › Agent keys.";
export const SIGNED_OUT_REVOKED_INFO = "Signed out of a4sx. The key was revoked.";
export const SIGNED_OUT_NO_KEY_INFO = "Signed out of a4sx.";

export async function signOut(auth: A4sxAuthProvider): Promise<void> {
  const result = await auth.signOut();
  const info = result === undefined ? SIGNED_OUT_NO_KEY_INFO : result === "revoked" ? SIGNED_OUT_REVOKED_INFO : SIGNED_OUT_INFO;
  await vscode.window.showInformationMessage(info);
}

/**
 * Which launch profile "Resume in terminal" uses: { id } (passed as --profile=ID), {} for the CLI's
 * default, undefined when the user dismissed the pick. Set by activate(); without it, the default.
 */
export type ChooseProfile = () => Promise<{ id?: string } | undefined>;
let chooseResumeProfile: ChooseProfile = async () => ({});
/** What the CLI-free resume needs: the sidebar's sign-in and the extension's globalState. Set by activate(). */
let native: { auth: A4sxAuthProvider; state: State } | undefined;

/**
 * Resume in terminal. With the a4sx CLI: `a4sx launch --a4sx-session=NAME [--profile=ID]` as before.
 * Without it: the session is copied into Claude Code's history with the extension's own key, and a
 * terminal runs `claude --resume <id>` in the folder. Both run directly, without a shell.
 */
export async function resumeSession(
  item: SessionItem | undefined,
  lookup: (configured: string | undefined) => CliLookup = findCli,
  choose: ChooseProfile = () => chooseResumeProfile(),
  claudeLookup: () => string | undefined = () => findClaude(),
): Promise<vscode.Terminal | undefined> {
  if (!item) {
    return undefined;
  }
  if (await stopIfLocalInRemoteWindow()) {
    return undefined;
  }
  const result = lookupCli(lookup);
  if (!result.found) {
    if (result.reason === "configured-path-invalid") {
      await reportMissingCli(result);   // the user pointed a4sx.cliPath somewhere: say so
      return undefined;
    }
    return resumeWithClaude(item, claudeLookup);
  }
  const profile = await choose();
  if (!profile) {
    return undefined;
  }
  // `a4sx launch` starts Claude Code on a copy of the saved session, in the user's shell. Only
  // validated pieces go into the command: the session's id (never its free-text label) and the
  // profile id, each one quoted argument with its flag.
  if (!SESSION_ID.test(item.row.id) || (profile.id !== undefined && !PROFILE_ID.test(profile.id))) {
    await vscode.window.showErrorMessage(MESSAGES.badResponse);
    return undefined;
  }
  const args = ["launch", `--a4sx-session=${item.row.id}`];
  if (profile.id) {
    args.push(`--profile=${profile.id}`);
  }
  return openCommandTerminal(RESUME_TERMINAL_NAME, result.path, CLI_NAME, args);
}

/** No a4sx CLI: seed natively, then `claude --resume <id>` in a terminal (or after the window reopens on the folder). */
async function resumeWithClaude(item: SessionItem, claudeLookup: () => string | undefined): Promise<vscode.Terminal | undefined> {
  const claude = claudeLookup();
  if (!claude) {
    await reportMissingClaude();
    return undefined;
  }
  const seeded = await seedForResume(item, "terminal");
  if (!seeded) {
    return undefined;
  }
  const terminal = openClaudeTerminal(claude, seeded.sessionId, seeded.folder.uri, RESUME_TERMINAL_NAME);
  if (native) {
    void offerCliInstallOnce(native.state, installCommand, INSTALL_URL);
  }
  return terminal;
}

async function reportMissingClaude(): Promise<void> {
  if ((await vscode.window.showErrorMessage(RESUME_TEXTS.noClaude, MISSING_CLI.install)) === MISSING_CLI.install) {
    await vscode.env.openExternal(vscode.Uri.parse(CLAUDE_INSTALL_URL));
  }
}

export const PROFILE_TERMINAL_NAME = "a4sx: profile";
/** The website's page for launch profiles (Account › Workspace & advanced). */
export const PROFILES_PAGE = "/account/workspace#profiles";

/** Opens a terminal that runs `a4sx profile --name ID` directly (no shell): shows the profile and how to change it. */
export async function runProfileCli(profileId: string, lookup: (configured: string | undefined) => CliLookup = findCli): Promise<vscode.Terminal | undefined> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileId) || await stopIfLocalInRemoteWindow()) {
    return undefined;
  }
  const result = lookupCli(lookup);
  if (!result.found) {
    await reportMissingCli(result);
    return undefined;
  }
  const terminal = vscode.window.createTerminal({ name: PROFILE_TERMINAL_NAME, shellPath: result.path, shellArgs: ["profile", "--name", profileId] });
  terminal.show();
  return terminal;
}

/** Opens a terminal that runs the CLI's own `a4sx profile --set-default ID` directly (no shell). */
export async function runSetDefaultCli(profileId: string, lookup: (configured: string | undefined) => CliLookup = findCli): Promise<vscode.Terminal | undefined> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileId) || await stopIfLocalInRemoteWindow()) {
    return undefined;
  }
  const result = lookupCli(lookup);
  if (!result.found) {
    await reportMissingCli(result);
    return undefined;
  }
  const terminal = vscode.window.createTerminal({ name: PROFILE_TERMINAL_NAME, shellPath: result.path, shellArgs: ["profile", "--set-default", profileId] });
  terminal.show();
  return terminal;
}

export async function openProfilesOnWeb(): Promise<void> {
  try {
    await vscode.env.openExternal(vscode.Uri.parse(`${client().base}${PROFILES_PAGE}`));
  } catch (e) {
    await vscode.window.showErrorMessage(errorText(e));
  }
}

export const RESUME_IN_TERMINAL = "Resume in terminal";
export const SHOW_EXTENSION = "Show extension";
export const CLAUDE_MESSAGES = {
  noClaude: "Resume in Claude Code needs the Claude Code extension.",
  notOnDisk: "Resume in Claude Code needs a folder on disk. Open a local or remote folder.",
  pickFolder: "Choose the folder to resume the session in",
  progress: "Copying the session for Claude Code…",
  failed: "Could not copy the session for Claude Code.",
  openFailed: "Could not open Claude Code.",
};

/** A workspace folder the session can be copied for, and its path on the host this extension runs on. */
export interface FolderTarget {
  folder: vscode.WorkspaceFolder;
  cwd: string;
}

/**
 * The folders a session can be resumed in. `file` folders always count. On the remote host, VS Code
 * hands an extension its folders as `file` URIs already; a `vscode-remote` folder counts there too,
 * and its fsPath is the path on the remote host (the extension host's own platform rules apply).
 * Virtual and other schemes (vscode-vfs, untitled, vscode-local, ...) are not on this host's disk.
 */
export function folderTargets(folders: readonly vscode.WorkspaceFolder[], remote: string | undefined): FolderTarget[] {
  return folders
    .filter((f) => f.uri.scheme === "file" || (remote !== undefined && f.uri.scheme === "vscode-remote"))
    .map((folder) => ({ folder, cwd: folder.uri.fsPath }));
}

async function pickFolder(targets: readonly FolderTarget[]): Promise<FolderTarget | undefined> {
  if (targets.length === 1) {
    return targets[0];
  }
  const picked = await vscode.window.showQuickPick(
    targets.map((target) => ({ label: target.folder.name, description: target.cwd, target })),
    { placeHolder: CLAUDE_MESSAGES.pickFolder },
  );
  return picked?.target;
}

/** The folder to resume in: the open one (a pick when several), or, with none open, home or a chosen folder. */
async function chooseResumeFolder(): Promise<ResumeFolder | undefined> {
  const all = vscode.workspace.workspaceFolders ?? [];
  if (all.length === 0) {
    return pickFolderWhenNoneOpen();
  }
  const targets = folderTargets(all, remoteHostName());
  if (targets.length === 0) {
    await vscode.window.showErrorMessage(CLAUDE_MESSAGES.notOnDisk);
    return undefined;
  }
  const target = await pickFolder(targets);
  return target && { uri: target.folder.uri, cwd: target.cwd, reopen: false };
}

/** The sidebar's key; without one, says to sign in (with a button). */
async function keyForResume(): Promise<string | undefined> {
  const cur = await native?.auth.current();
  if (cur) {
    return cur.token;
  }
  if ((await vscode.window.showErrorMessage(STEP_UP.signInFirst, STEP_UP.signIn)) === STEP_UP.signIn && native) {
    await signIn(native.auth);
  }
  return undefined;
}

/**
 * Copies the saved session into Claude Code's history for a folder, with the extension's own key and
 * no CLI. When no folder was open, the window reopens on the chosen one and the resume finishes there
 * (a pending action, see completePendingResume); then this resolves to undefined.
 */
async function seedForResume(item: SessionItem, kind: PendingAction["kind"]): Promise<{ sessionId: string; folder: ResumeFolder } | undefined> {
  const token = await keyForResume();
  if (!token) {
    return undefined;
  }
  const folder = await chooseResumeFolder();
  if (!folder) {
    return undefined;
  }
  const outcome = await seedWithProgress(client(), token, item.row, folder.cwd, CLAUDE_MESSAGES.progress, CLAUDE_MESSAGES.failed);
  if (outcome.kind === "cancelled") {
    return undefined;
  }
  if (outcome.kind === "failed") {
    await vscode.window.showErrorMessage(outcome.message);
    return undefined;
  }
  if (folder.reopen) {
    if (native) {
      await storePending(native.state, { kind, sessionId: outcome.sessionId, folderUri: folder.uri.toString(), at: Date.now() });
    }
    await vscode.commands.executeCommand("vscode.openFolder", folder.uri, { forceNewWindow: false });
    return undefined;
  }
  return { sessionId: outcome.sessionId, folder };
}

async function openInClaudeCode(sessionId: string): Promise<void> {
  const opened = await vscode.env.openExternal(vscode.Uri.parse(claudeResumeUri(vscode.env.uriScheme, sessionId)));
  if (!opened) {
    await vscode.window.showErrorMessage(CLAUDE_MESSAGES.openFailed);
  }
}

/**
 * Copies the saved session into Claude Code's local history for a folder (with the extension's own
 * key, no CLI needed) and opens it in the Claude Code extension. Only a validated session id goes into
 * the link.
 */
export async function resumeInClaude(item: SessionItem | undefined): Promise<void> {
  if (!item) {
    return;
  }
  if (await stopIfLocalInRemoteWindow()) {
    return;
  }
  if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) {
    const choice = await vscode.window.showErrorMessage(CLAUDE_MESSAGES.noClaude, SHOW_EXTENSION);
    if (choice === SHOW_EXTENSION) {
      await vscode.commands.executeCommand("workbench.extensions.search", `@id:${CLAUDE_EXTENSION_ID}`);
    }
    return;
  }
  const seeded = await seedForResume(item, "claude");
  if (seeded) {
    await openInClaudeCode(seeded.sessionId);
  }
}

/** On activation: finish a resume that reopened the window on its folder (valid, under 2 minutes, this folder). */
export async function completePendingResume(state: State, claudeLookup: () => string | undefined = () => findClaude()): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const p = await takePending(state, folders, Date.now());
  if (!p) {
    return;
  }
  if (p.kind === "claude") {
    await openInClaudeCode(p.sessionId);
    return;
  }
  const claude = claudeLookup();
  if (!claude) {
    await reportMissingClaude();
    return;
  }
  const folder = folders.find((f) => sameFolder(f.uri, p.folderUri));
  if (folder) {
    openClaudeTerminal(claude, p.sessionId, folder.uri, RESUME_TERMINAL_NAME);
    void offerCliInstallOnce(state, installCommand, INSTALL_URL);
  }
}

export async function openSessionOnWeb(item: SessionItem | undefined): Promise<void> {
  if (!item) {
    return;
  }
  try {
    await vscode.env.openExternal(vscode.Uri.parse(sessionWebUrl(client().base, item.row.id)));
  } catch (e) {
    await vscode.window.showErrorMessage(errorText(e));
  }
}

export const COPIED_INFO = "Copied the session id.";

export async function copySessionId(item: SessionItem | undefined): Promise<void> {
  if (!item) {
    return;
  }
  await vscode.env.clipboard.writeText(item.row.id);
  await vscode.window.showInformationMessage(COPIED_INFO);
}

export async function openListing(item: ListingItem | undefined): Promise<void> {
  if (!item) {
    return;
  }
  try {
    await vscode.env.openExternal(vscode.Uri.parse(listingWebUrl(client().base, item.row)));
  } catch (e) {
    await vscode.window.showErrorMessage(errorText(e));
  }
}

export async function searchMarketplace(market: MarketplaceProvider): Promise<void> {
  const q = await vscode.window.showInputBox({
    title: "Search the a4sx marketplace",
    prompt: "Search public sessions by topic, tool or task.",
    placeHolder: "for example: terraform upgrade",
    value: market.query ?? "",
  });
  if (q === undefined) {
    return;
  }
  market.search(q);
}

/** Opens one of the website's mesh pages: every change to a mesh happens there. */
async function openMeshPage(url: (base: string) => string): Promise<void> {
  try {
    await vscode.env.openExternal(vscode.Uri.parse(url(client().base)));
  } catch (e) {
    await vscode.window.showErrorMessage(errorText(e));
  }
}

export const openMeshesOnWeb = () => openMeshPage(meshesPageUrl);
export const redeemMeshInvite = () => openMeshPage(meshInviteUrl);

export async function openMeshOnWeb(item: MeshItem | undefined): Promise<void> {
  if (!(item instanceof MeshItem)) {
    return;
  }
  const id = item.node.mesh.id;
  if (!MESH_ID.test(id)) {
    await vscode.window.showErrorMessage(MESH_TEXTS.badMesh);
    return;
  }
  await openMeshPage((base) => meshPageUrl(base, id)!);
}

/** Runs the CLI's read-only preflight: an argv array, no shell, a short timeout; resolves its stdout. */
export type PreflightRunner = (cliPath: string, args: readonly string[]) => Promise<string>;

export const PREFLIGHT_TIMEOUT_MS = 30_000;

/**
 * The real runner: execFile (never a shell string). The CLI gets the user's environment, which holds
 * no a4sx key of the extension's (that key lives only in SecretStorage). A non-zero exit still hands
 * over stdout, so a `{tier: "none"}` answer with exit code 1 is read too.
 */
export const runPreflight: PreflightRunner = (cliPath, args) =>
  new Promise((resolve) => {
    execFile(cliPath, [...args], { timeout: PREFLIGHT_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true, shell: false }, (_err, stdout) => {
      resolve(typeof stdout === "string" ? stdout : "");
    });
  });

/** The website's setup guide, shown with the "no isolation tier" refusal. */
export const MESH_SETUP_PATH = "/guide/cli";

/**
 * Start session in mesh: types `a4sx launch --ipc-proxy --mesh <id> --as <name>` into a new terminal.
 * First the read-only checks: the mesh is an active mesh of mine and still listed, the CLI is there,
 * and the CLI's isolation preflight (`a4sx launch --mesh <id> --preflight --json`, spec §8.8) answers
 * `sandbox` or `uid` (start), `reduced` (a modal; only an explicit click adds --mesh-reduced-isolation
 * to this one start, nothing is remembered) or `none` (refused). The name comes from an input box and
 * must follow the server's rule; the id must be a mesh id; each is quoted for the shell (or passed as
 * an argv array when the shell is unknown). Neither the terminal nor the preflight gets a key.
 */
export async function startSessionInMesh(
  auth: { token(): Promise<string | undefined> },
  item: MeshItem | undefined,
  lookup: (configured: string | undefined) => CliLookup = findCli,
  preflight: PreflightRunner = runPreflight,
): Promise<vscode.Terminal | undefined> {
  if (!(item instanceof MeshItem)) {
    return undefined;
  }
  const mesh = item.node.mesh;
  const meshId = mesh.id;
  const pfArgs = preflightArgs(meshId);
  if (!MESH_ID.test(meshId) || !pfArgs) {
    await vscode.window.showErrorMessage(MESH_TEXTS.badMesh);
    return undefined;
  }
  if (!startable(mesh)) {
    await vscode.window.showErrorMessage(MESH_TEXTS.notActive);
    return undefined;
  }
  if (await stopIfLocalInRemoteWindow()) {
    return undefined;
  }
  const cli = lookupCli(lookup);
  if (!cli.found) {
    await reportMissingCli(cli);
    return undefined;
  }
  const token = await auth.token();
  if (!token) {
    await vscode.window.showErrorMessage(STEP_UP.signInFirst);
    return undefined;
  }
  try {
    if (!(await listMeshes(client(), token)).items.some((m) => m.id === meshId && startable(m))) {
      await vscode.window.showErrorMessage(MESH_TEXTS.meshGone);
      return undefined;
    }
  } catch (e) {
    await vscode.window.showErrorMessage(errorText(e));
    return undefined;
  }
  const pf = parsePreflight(await preflight(cli.path, pfArgs));
  if (!pf) {
    await vscode.window.showErrorMessage(MESH_TEXTS.preflightFailed);
    return undefined;
  }
  if (pf.tier === "none") {
    if ((await vscode.window.showErrorMessage(MESH_TEXTS.noTier, MESH_TEXTS.setupGuide)) === MESH_TEXTS.setupGuide) {
      await openMeshPage((base) => `${base}${MESH_SETUP_PATH}`);
    }
    return undefined;
  }
  let reduced = false;
  if (pf.tier === "reduced") {
    const choice = await vscode.window.showWarningMessage(
      reducedWarning(mesh.name ?? meshId), { modal: true, ...(pf.reason ? { detail: pf.reason } : {}) }, MESH_TEXTS.reducedStart,
    );
    if (choice !== MESH_TEXTS.reducedStart) {
      return undefined;
    }
    reduced = true;
  }
  const raw = await vscode.window.showInputBox({
    title: MESH_TEXTS.nameTitle,
    prompt: MESH_TEXTS.namePrompt,
    value: suggestCellName((item.node.groups ?? []).flatMap((g) => g.cells.map((c) => c.name))),
    validateInput: validateCellName,
  });
  if (raw === undefined) {
    return undefined;
  }
  const args = meshLaunchArgs(meshId, raw, reduced);
  if (!args) {
    await vscode.window.showErrorMessage(MESH_TEXTS.nameRule);
    return undefined;
  }
  return openCommandTerminal(MESH_TERMINAL_NAME, cli.path, CLI_NAME, args);
}

function setContext(key: string, value: unknown): void {
  void vscode.commands.executeCommand("setContext", key, value);
}

function setProfilesContext(state: ProfilesViewState): void {
  // Create shows only where the server has launch profiles and the key may read them.
  setContext("a4sx.profilesAvailable", state === "ok" || state === "empty");
}

/** Editors built on VS Code (installed from Open VSX) may lack the MCP provider API; the commands still work there. */
export function hasMcpProviderApi(): boolean {
  return typeof vscode.lm?.registerMcpServerDefinitionProvider === "function" && typeof vscode.McpHttpServerDefinition === "function";
}

export interface Sidebar {
  auth: A4sxAuthProvider;
  sessions: SessionsProvider;
  profiles: ProfilesProvider;
  market: MarketplaceProvider;
  meshes: MeshesProvider;
  meshPoller: VisibilityPoller;
}

/** For tests only. Never returned from activate(): that value is readable by every other extension. */
export let sidebar: Sidebar | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_SAVE, () => saveSession()),
    vscode.commands.registerCommand(CMD_OPEN_LIBRARY, () => openLibrary()),
  );

  const auth = new A4sxAuthProvider(context.secrets, client, (c, req) => runtime.login(c, req));
  const sessions: SessionsProvider = new SessionsProvider(auth, client, (state: ViewState) => {
    setContext("a4sx.signedIn", state !== "signed-out");
    setContext("a4sx.sessionsEmpty", state === "empty");
    setContext("a4sx.foldersSupported", sessions.foldersSupported());
  }, (filter) => setContext("a4sx.sessionsFiltered", !!filter));
  const profiles = new ProfilesProvider(auth, client, setProfilesContext);
  const market = new MarketplaceProvider(client);
  // Hidden until GET /meshes answers: a server without meshes (404) never shows the view.
  setContext(MESHES_AVAILABLE, false);
  const meshes = new MeshesProvider(auth, client, (available) => setContext(MESHES_AVAILABLE, available));
  const meshesView = vscode.window.createTreeView(VIEW_MESHES, { treeDataProvider: meshes });
  const meshPoller = new VisibilityPoller(() => meshes.tick());
  const syncSignedIn = () => void auth.current().then((s) => vscode.commands.executeCommand("setContext", "a4sx.signedIn", !!s));
  syncSignedIn();
  setContext("a4sx.sessionsFiltered", false);
  const sessionsView = vscode.window.createTreeView(VIEW_SESSIONS, { treeDataProvider: sessions });
  sessions.view = sessionsView;
  chooseResumeProfile = () => pickProfileForResume(auth, client);
  native = { auth, state: context.globalState };
  const folderDeps = { auth, client, sessions };
  const profileDeps = { auth, client, view: profiles, elsewhere: {
    website: openProfilesOnWeb,
    cli: (id: string) => runProfileCli(id).then(() => undefined),
    setDefault: (id: string) => runSetDefaultCli(id).then(() => undefined),
  } };
  context.subscriptions.push(
    auth,
    sessions,
    profiles,
    market,
    vscode.authentication.registerAuthenticationProvider(AUTH_ID, AUTH_LABEL, auth, { supportsMultipleAccounts: false }),
    sessionsView,
    vscode.window.registerTreeDataProvider(VIEW_PROFILES, profiles),
    vscode.window.registerTreeDataProvider(VIEW_MARKETPLACE, market),
    meshes,
    meshesView,
    meshPoller,
    meshesView.onDidChangeVisibility((e) => meshPoller.setVisible(e.visible)),
    auth.onDidChangeSessions(() => {
      syncSignedIn();
      sessions.refresh();
      profiles.refresh();
      void meshes.probe();
    }),
    context.secrets.onDidChange((e) => {
      if (e.key === SECRET_KEY) {
        auth.notifyExternalChange();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("a4sx.serverUrl")) {
        syncSignedIn();
        sessions.refresh();
        profiles.refresh();
        market.search(market.query);
        void meshes.probe();
      }
    }),
    vscode.commands.registerCommand(CMD_SIGN_IN, () => signIn(auth)),
    vscode.commands.registerCommand(CMD_SIGN_OUT, () => signOut(auth)),
    vscode.commands.registerCommand(CMD_REFRESH, () => sessions.refresh()),
    vscode.commands.registerCommand(CMD_RESUME, (item?: SessionItem) => resumeSession(item)),
    vscode.commands.registerCommand(CMD_RESUME_CLAUDE, (item?: SessionItem) => resumeInClaude(item)),
    vscode.commands.registerCommand(CMD_OPEN_SESSION, (item?: SessionItem) => openSessionOnWeb(item)),
    vscode.commands.registerCommand(CMD_COPY_ID, (item?: SessionItem) => copySessionId(item)),
    vscode.commands.registerCommand(CMD_SEARCH, () => searchMarketplace(market)),
    vscode.commands.registerCommand(CMD_OPEN_LISTING, (item?: ListingItem) => openListing(item)),
    vscode.commands.registerCommand(CMD_FILTER, () => filterSessions(sessions)),
    vscode.commands.registerCommand(CMD_CLEAR_FILTER, () => clearFilter(sessions)),
    vscode.commands.registerCommand(CMD_MOVE_TO_FOLDER, (item?: SessionItem) => moveToFolder(folderDeps, item)),
    vscode.commands.registerCommand(CMD_REMOVE_FROM_FOLDER, (item?: SessionItem) => removeFromFolder(folderDeps, item)),
    vscode.commands.registerCommand(CMD_REFRESH_PROFILES, () => profiles.refresh()),
    vscode.commands.registerCommand(CMD_CREATE_PROFILE, () => createProfile(profileDeps)),
    vscode.commands.registerCommand(CMD_EDIT_PROFILE, (item?: ProfileItem) => editProfile(profileDeps, item)),
    vscode.commands.registerCommand(CMD_CHANGE_DEFAULT, (item?: ProfileItem) => changeDefault(profileDeps, item)),
    vscode.commands.registerCommand(CMD_DELETE_PROFILE, (item?: ProfileItem) => removeProfile(profileDeps, item)),
    vscode.commands.registerCommand(CMD_REFRESH_MESHES, () => meshes.refresh()),
    vscode.commands.registerCommand(CMD_OPEN_MESHES, () => openMeshesOnWeb()),
    vscode.commands.registerCommand(CMD_CREATE_MESH, () => openMeshesOnWeb()),
    vscode.commands.registerCommand(CMD_REDEEM_INVITE, () => redeemMeshInvite()),
    vscode.commands.registerCommand(CMD_OPEN_MESH, (item?: MeshItem) => openMeshOnWeb(item)),
    vscode.commands.registerCommand(CMD_START_IN_MESH, (item?: MeshItem) => startSessionInMesh(auth, item)),
    // From the "Sign in again to allow …" item: the item names the permission, so no extra modal.
    vscode.commands.registerCommand(CMD_ALLOW_SCOPE, async (scope?: unknown) => {
      if (typeof scope === "string" && stepUpAllowed(scope)) {
        await offerStepUp(auth, scope, false);
      }
    }),
  );
  if (hasMcpProviderApi()) {
    const changed = new vscode.EventEmitter<void>();
    context.subscriptions.push(
      changed,
      vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: () => mcpServerDefinitions(),
        resolveMcpServerDefinition: (server) => server,
      }),
    );
  }
  sidebar = { auth, sessions, profiles, market, meshes, meshPoller };
  // The probe (GET /meshes only) decides whether the view shows; the cells are read when it is shown,
  // then every 30 s while it is visible.
  void meshes.probe();
  meshPoller.setVisible(meshesView.visible);
  // A resume that reopened this window on its folder finishes now; then, once, the profiles:read offer.
  void completePendingResume(context.globalState);
  void offerProfilesStepUp(auth, client, context.globalState, Date.now());
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
