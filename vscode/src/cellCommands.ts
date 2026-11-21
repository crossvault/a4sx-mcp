// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The Cells view's actions: start a stored cell or a new one in a terminal, make one the default, forget
// one, open its page; and installing / updating the a4sx CLI in the extension's storage. Every CLI call is
// an argv array (a terminal types it quoted for the user's shell; the rest run with execFile, no shell).
// The extension never reads the CLI's key files and puts no key into a terminal, a setting or a file.
import * as vscode from "vscode";
import { createHash } from "crypto";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { CLI_NAME } from "./cli";
import { AGENT_HOST_SETUP_ARGS, AGENT_HOST_START_ARGS, AGENT_HOST_STATUS_ARGS, AGENT_HOST_STOP_ARGS, AGENT_HOST_TEXTS, directLaunch, isOpen, lacksAgentHost, parseAgentHostStatus } from "./agentHostStatus";
import { CellStartPlan, cellStartPlan, isDirectory, lastPromptFolder } from "./cellResume";
import {
  CELL_NAME, cellDefaultArgs, cellForgetArgs, cellLaunchArgs, cellPageUrl, cellProfileArgs, cellRenameArgs, cellsListDir, cellStopArgs, LocalCell, MIN_CELL_CONSENT_CLI, NEW_CELL_ARGS,
  policyUrl,
  showText,
  startHereArgs,
} from "./cells";
import { CellsProvider, CliOutput, CliResolution, CliRunner, lacksCellProfile, LocalCellItem, MeshGroupItem, RemoteCellItem } from "./cellsView";
import { IN_SESSION_MESSAGE, parseCliError, parseProfilesAnswer, PROFILES_ARGS, versionAtLeast } from "./cliJson";
import {
  bundledClaude, claudeFindable, downloadCli, Fetch, installedLauncher, launcherNeedsRepair, ProvisionError, repairLauncher, RepairResult, Runner, searchPython, updateArgs, updateDue,
  WINGET_PYTHON_ARGS, writeLauncher,
} from "./provision";
import { claudeProjectsDir, cliConfigDir } from "./nativeSeed";
import { openCommandTerminal, State } from "./resume";
import { readTail, transcriptTitle } from "./tabSession";
import { commandLine, programName, shellKind } from "./terminalCommand";

/**
 * Before 0.9.3: where the extension's own reduced-isolation consent was kept, per machine. Never read since: that
 * consent was only good for one start, and the CLI asks per cell now (cliAsksConsent).
 */
export const CONSENT_KEY = "a4sx.cellReducedIsolationConsent";
export const LAST_UPDATE_KEY = "a4sx.cliLastUpdate";
/** 0.9.2: the folder each stored cell was last started in from here, by instance id (the folder picker's default). */
export const CELL_FOLDERS_KEY = "a4sx.cellFolders";
const CELL_FOLDERS_MAX = 50;
/** 0.9.2: "Start anyway" was chosen on this computer (its claude is the CLI's harness.claude_path): not asked again. */
export const START_ANYWAY_KEY = "a4sx.cellClaudeStartAnyway";
export const CLAUDE_CODE_ID = "anthropic.claude-code";
export const CLAUDE_ENV = "A4SX_CLAUDE";
export const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";

export const CELL_CMD_TEXTS = {
  newCellTerminal: "a4sx: new cell",
  // #2301 E1
  startHereTerminal: (name: string) => `a4sx: ${name}`,
  startHereStarted: (name: string, cwd: string) =>
    `Starting «${name}» on this computer, in ${cwd}. If it still runs on the other computer, a4sx starts nothing and says in the terminal how to stop it there.`,
  startHereBad: "This cell's name or mesh isn't one the a4sx CLI takes, so nothing was started.",
  cellTerminal: (name: string) => `a4sx: cell ${name}`,
  updateTerminal: "a4sx: update",
  pythonTerminal: "a4sx: install Python",
  consentCliTooOld: (v: string) =>
    `This a4sx CLI (${v}) can't remember for a cell that you accepted reduced isolation, so a cell started from here ` +
    `would be refused when it starts again without a terminal (by the agent host, for one). Nothing was started. Update ` +
    `the a4sx CLI to ${MIN_CELL_CONSENT_CLI} or newer, then start the cell again: it then asks you once in the terminal.`,
  updateCli: "Update a4sx CLI",
  standalone: (name: string) => `The cell «${name}» isn't in a mesh yet. Add it to a mesh in the browser, then start it.`,
  openInBrowser: "Open in browser",
  badCell: "This cell can't be started from here: its name or mesh isn't one the a4sx CLI accepts.",
  forgetTitle: (name: string) => `Forget the cell «${name}» on this computer?`,
  forgetDetail: "This removes its key from this computer. The cell stays in your account until you remove it on the website.",
  forget: "Forget",
  forgotten: (name: string) => `Forgot the cell «${name}» on this computer.`,
  nowDefault: (name: string) => `«${name}» is now the default cell.`,
  cliFailed: (what: string, detail: string | undefined) => `Could not ${what}${detail ? `: ${detail}` : "."}`,
  noCli: "The Cells view needs the a4sx CLI. Install it now? It goes into this extension's own storage; no admin rights or PATH changes needed.",
  installCli: "Install a4sx CLI",
  badConfig: "The a4sx.cliPath setting doesn't point to a program. Fix it or clear it, then try again.",
  openSettings: "Open settings",
  remoteLocal: "This window is remote, but the a4sx extension runs on this computer. Install a4sx in the remote window first.",
  installing: "Installing the a4sx CLI…",
  findingPython: "Looking for Python…",
  downloading: "Downloading…",
  installed: (v: string) => `Installed the a4sx CLI ${v}. Sign-ins and cells are set up in a terminal the first time you start a cell.`,
  noPythonWin: "The a4sx CLI needs Python 3.10 or newer. Install it with winget?",
  storePythonWin:
    "Only the Microsoft Store Python was found. The a4sx CLI can't use it (Claude Code can't see the files it writes), " +
    "so it can't run until another Python is installed. Install Python 3.12 with winget?",
  installPython: "Install Python",
  pythonNext: "When Python is installed, run Install a4sx CLI again.",
  noPython: "The a4sx CLI needs Python 3.10 or newer. Install it, then try again.",
  howToInstall: "How to install",
  noStorage: "VS Code didn't give this extension a storage folder, so the a4sx CLI can't be installed here.",
  badServer: "The a4sx.serverUrl setting isn't a valid https address.",
  stopTitle: (name: string) => `Stop the cell «${name}» on this computer?`,
  stopDetail: "Its agent session ends. You can start the cell again from here.",
  stop: "Stop",
  stopped: (name: string) => `Stopped the cell «${name}».`,
  // #2309 F1: a cell the agent host runs is stopped through the host (CLI 0.59.16); an older CLI can't
  MIN_HOST_CELL_STOP_CLI: "0.59.16",
  stopHostOld: (name: string, v: string) =>
    `Needs a4sx 0.59.16 to stop a cell in the agent host: «${name}» runs there and your a4sx CLI is ${v}. Close its session in VS Code's Agents window to end it; nothing was stopped.`,
  renameTitle: (name: string) => `Rename the cell «${name}»`,
  renamePrompt: "New name: lowercase letters, digits and -",
  renameInvalid: "Use up to 48 lowercase letters, digits and -, starting and ending with a letter or digit.",
  renameTaken: "Another cell in this mesh on this computer already has this name.",
  renamed: (from: string, to: string) => `Renamed the cell «${from}» to «${to}».`,
  copiedLaunch: "Copied the launch command.",
  profileTitle: (name: string) => `Launch profile of the cell «${name}»`,
  profilePlaceholder: "It starts with this profile from its next start, every time",
  profileCurrent: "current",
  profileDefaultMark: "your default",
  profileFollowDefault: "Follow my default profile",
  profileFollowDefaultDetail: "The cell starts with whatever your default launch profile is at that time",
  profileNone: "You have no launch profiles yet. Create one in the Launch profiles view first.",
  profileSet: (name: string, profile: string) => `The cell «${name}» starts with the launch profile «${profile}» from its next start.`,
  profileCleared: (name: string) => `The cell «${name}» follows your default launch profile from its next start.`,
  profileRunning: "It runs on this computer now and keeps its current profile until you start it again.",
  profileTooOld: "This a4sx CLI can't set a cell's launch profile yet. Update it to 0.27.0 or newer, then try again.",
};

/** 0.9.2: what Start in terminal says about the cell's conversation and its folder. */
export const CELL_START_TEXTS = {
  resuming: (name: string, title: string | undefined, short: string, folder: string) =>
    `«${name}» continues its last conversation${title ? ` «${title}»` : ""} (session ${short}) in ${folder}, the folder it ran in. ` +
    "For a new conversation instead, type /clear in it.",
  banner: (short: string, folder: string) => `a4sx: continuing this cell's last conversation (session ${short}) in ${folder}`,
  gone: (name: string, short: string, folder: string) =>
    `«${name}»'s last conversation (session ${short}) can't be continued: its transcript isn't on this computer any more ` +
    `(it was deleted or moved). The cell starts a new conversation in ${folder}, the folder it last ran in.`,
  fresh: (name: string, folder: string) =>
    `«${name}» starts in ${folder}. No earlier conversation of it is recorded on this computer, so it starts a new one, ` +
    "unless the a4sx CLI finds one of an older CLI there (it says so in the terminal). From then on, Start continues it there.",
  folderTitle: (name: string, folder: string) => `«${name}»'s last conversation ran in ${folder}, where a cell can't start`,
  folderDetail: (folder: string, what: string) =>
    `${folder} ${what}. The agent writes into the folder it starts in and could read or overwrite those files, so the ` +
    `a4sx CLI doesn't start a cell there${what.startsWith("holds") ? " (only --mesh-reduced-isolation would allow it, " +
      "for that one start, and it stores nothing, so the agent host couldn't start the cell again)" : ", with or without --mesh-reduced-isolation"}. ` +
    "Choose the cell's own project folder: Claude Code keeps a conversation with its folder, so the cell starts a new " +
    "conversation there.",
  folderChoose: "Choose a folder…",
  folderRefused: (folder: string, what: string) =>
    `A cell can't start in ${folder}: it ${what}, and the agent writes into the folder it starts in, so it could read ` +
    "or overwrite those files. Nothing was started. Choose a project folder outside those folders that doesn't contain " +
    "them either, then try again.",
  sessionFolderRefused: (folder: string, what: string) =>
    `This session can't run as a cell: it ran in ${folder}, which ${what}, and the a4sx CLI doesn't start a cell there ` +
    "(the agent writes into the folder it starts in and could read or overwrite those files). Nothing was started. " +
    "Continue it with Resume in Claude Code instead (a conversation can't move to another folder), or use New cell in a " +
    "project folder, which starts a new conversation.",
  leftGone: (name: string, folder: string) => `«${name}» starts a new conversation in ${folder}.`,
  left: (name: string, short: string, old: string, folder: string) =>
    `«${name}» starts a new conversation in ${folder}. Its last one (session ${short}) stays with ${old} ` +
    "(Claude Code keeps a conversation with its folder).",
  movedTitle: (name: string, folder: string) => `«${name}» last ran in ${folder}, which isn't there any more. Choose the folder to start it in`,
  movedStarted: (name: string, short: string, lastFolder: string, folder: string) =>
    `«${name}»'s last conversation (session ${short}) ran in ${lastFolder}, which isn't on this computer any more, so it ` +
    `can't be continued (Claude Code keeps a conversation with its folder). The cell starts a new conversation in ${folder}.`,
  pickTitle: (name: string) => `Choose the folder to start «${name}» in: no earlier conversation of it is recorded on this computer`,
  pickLabel: "Start the cell here",
  pickNewTitle: "Choose the folder to start the cell in (no folder is open in this window)",
};

/** 0.9.2: what a cell's terminal says when the Claude Code to start isn't there. */
export const CELL_CLAUDE_TEXTS = {
  badUserEnv: (p: string) => `A4SX_CLAUDE is set to ${p}, but no program is there, so the cell can't start Claude Code. Nothing was started.`,
  badUserEnvDetail: (exe: string, bundled: boolean) =>
    `VS Code passes its environment to the cell's terminal, and the a4sx CLI uses A4SX_CLAUDE before anything else. Fix: ` +
    `remove A4SX_CLAUDE from your environment variables, or set it to the full path of ${exe}, then restart VS Code and ` +
    `start the cell again.${bundled ? " \"Use Claude Code's claude\" starts it now with the Claude Code extension's claude instead." : ""}`,
  useBundled: "Use Claude Code's claude",
  none: "Claude Code wasn't found on this computer, so the cell can't start it. Nothing was started.",
  noneDetail: (extPath: string | undefined, install: string, shell: string | undefined) =>
    `${extPath ? `The Claude Code extension's folder ${extPath} holds no claude program` : "The Claude Code extension isn't installed"}, and ` +
    `claude isn't on PATH or where its installer puts it. Fix: install Claude Code${shell ? ` in ${shell}` : ""} with\n\n${install}\n\n` +
    "or install (or reinstall) the Claude Code extension, then start the cell again. If you pointed the a4sx CLI at claude " +
    "yourself (a4sx config set harness.claude_path <path>), or the cell's launch profile starts another agent than Claude " +
    "Code, \"Start anyway\" starts it, and this message isn't shown again on this computer.",
  copyInstall: "Copy install command",
  startAnyway: "Start anyway",
  copied: "Copied the install command. Run it, then start the cell again.",
};

/** Claude Code's installer command (the CLI's HARNESS_INSTALL). */
export function claudeInstallCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash";
}

export interface CellCommandDeps {
  state: State;
  /** <globalStorage>/cli: where the extension's copy of the CLI lives; undefined when VS Code gave none. */
  cliDir: string | undefined;
  provider: CellsProvider;
  resolve(): CliResolution;
  run: CliRunner;
  /** The configured server's origin; throws for a bad a4sx.serverUrl. */
  server(): string;
  defaultServer: string;
  /** The folder a terminal starts in (undefined: the default), or null when the user cancelled. */
  folder(): Promise<string | vscode.Uri | undefined | null>;
  fetch: Fetch;
  python: Runner;
  platform?: NodeJS.Platform;
  /** Terminals this view started: a refresh follows when one closes. */
  terminals: Set<vscode.Terminal>;
  /** After the own copy's launcher was repaired: the views that show the CLI read it again (Launch profiles). */
  onRepaired?: () => void;
  /** 0.9.2: `<state home>/a4sx`, where the CLI records each cell's last conversation (default: cellsListDir()). */
  stateDir?: string;
  /** 0.9.2: your Claude Code projects folder (default: claudeProjectsDir()). */
  claudeProjects?: string;
  /** 0.9.2: the environment and home folder the Claude Code checks read (default: this process's). */
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** This machine, as the consent remembers it: a hash, so no host name is stored. */
export function machineKey(): string {
  return createHash("sha256").update([os.hostname(), process.platform, os.homedir()].join("\0")).digest("hex").slice(0, 32);
}

/**
 * 0.9.3: whether this CLI asks the reduced-isolation question itself (0.32.0+), so Start and New cell can leave it to
 * the CLI. An older one: the user is told to update (with the button), and nothing starts. An unknown version: yes
 * (the CLI then says itself what it needs).
 */
export async function cliAsksConsent(deps: CellCommandDeps, cli: string): Promise<boolean> {
  let v = await deps.provider.versions.version(cli);
  if (v !== undefined && !versionAtLeast(v, MIN_CELL_CONSENT_CLI)) {
    deps.provider.versions.clear();   // asked once more: an update may have finished since the version was read
    v = await deps.provider.versions.version(cli);
  }
  // Deliberately on an unknown version too: a CLI that doesn't answer --version still gets the start, and an old one
  // then refuses with its own message. Asked on every computer, also where the sandbox works and nothing is asked:
  // the extension can't tell that before the start, and an older CLI should be updated anyway.
  if (v === undefined || versionAtLeast(v, MIN_CELL_CONSENT_CLI)) {
    return true;
  }
  if ((await vscode.window.showErrorMessage(CELL_CMD_TEXTS.consentCliTooOld(v), CELL_CMD_TEXTS.updateCli)) === CELL_CMD_TEXTS.updateCli) {
    await updateCliInTerminal(deps);
  }
  return false;
}

function plainFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 0.9.2: the env for a cell's terminal, after checking that the cell will find Claude Code: { env } to start with
 * (env undefined: nothing to add), or undefined when nothing may start (the user was told what to fix). An
 * A4SX_CLAUDE of the user's that names no program is said here, with the fix, instead of in the terminal; the
 * bundled claude is offered for this start. With no bundled claude, the CLI looks for claude itself; when it
 * wouldn't find one either, one message names the install command.
 */
export async function cellClaudeEnv(deps: Pick<CellCommandDeps, "platform" | "env" | "home"> & { state?: State }): Promise<{ env?: Record<string, string> } | undefined> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const extPath = vscode.extensions.getExtension(CLAUDE_CODE_ID)?.extensionPath;
  const bundled = bundledClaude(extPath, platform);
  const t = CELL_CLAUDE_TEXTS;
  const own = env[CLAUDE_ENV]?.trim();
  if (own) {
    // The CLI expands ~, $VAR and %VAR% in it: such a value is left to the CLI, which says what's wrong with it.
    if (/[~$%]/.test(own) || plainFile(own)) {
      return {};
    }
    const shown = showText(own, 300) ?? CLAUDE_ENV;
    const exe = platform === "win32" ? "claude.exe" : "claude";
    const choice = await vscode.window.showErrorMessage(t.badUserEnv(shown), { modal: true, detail: t.badUserEnvDetail(exe, !!bundled) }, ...(bundled ? [t.useBundled] : []));
    return choice === t.useBundled && bundled ? { env: { [CLAUDE_ENV]: bundled } } : undefined;
  }
  if (bundled) {
    return { env: { [CLAUDE_ENV]: bundled } };
  }
  if (claudeFindable(env, deps.home ?? os.homedir(), platform)) {
    return {};
  }
  if (deps.state?.get<unknown>(START_ANYWAY_KEY) === machineKey()) {
    return {};   // the user's own harness.claude_path, said once on this computer
  }
  const install = claudeInstallCommand(platform);
  const choice = await vscode.window.showErrorMessage(
    t.none, { modal: true, detail: t.noneDetail(showText(extPath, 300), install, platform === "win32" ? "PowerShell" : undefined) }, t.copyInstall, t.startAnyway,
  );
  if (choice === t.startAnyway) {
    await deps.state?.update(START_ANYWAY_KEY, machineKey());
    return {};
  }
  if (choice === t.copyInstall) {
    await vscode.env.clipboard.writeText(install);
    void vscode.window.showInformationMessage(t.copied);
  }
  return undefined;
}

/** The CLI to run: found, or after offering the install. undefined when there is none (the user was told). */
export async function ensureCli(deps: CellCommandDeps): Promise<string | undefined> {
  const r = deps.resolve();
  switch (r.kind) {
    case "found":
      return (await ownCliUsable(deps, r.path)) ? r.path : undefined;
    case "bad-config":
      if ((await vscode.window.showErrorMessage(CELL_CMD_TEXTS.badConfig, CELL_CMD_TEXTS.openSettings)) === CELL_CMD_TEXTS.openSettings) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "a4sx.cliPath");
      }
      return undefined;
    case "remote-local":
      await vscode.window.showErrorMessage(CELL_CMD_TEXTS.remoteLocal);
      return undefined;
    case "in-session":
      await vscode.window.showErrorMessage(IN_SESSION_MESSAGE);
      return undefined;
    case "no-cli": {
      const choice = await vscode.window.showInformationMessage(CELL_CMD_TEXTS.noCli, { modal: true }, CELL_CMD_TEXTS.installCli);
      if (choice !== CELL_CMD_TEXTS.installCli || !(await installCli(deps))) {
        return undefined;
      }
      const again = deps.resolve();
      return again.kind === "found" ? again.path : undefined;
    }
  }
}

/** The repair in flight, per launcher folder: activation and an action never search and write at the same time. */
const repairs = new Map<string, Promise<RepairResult>>();

/**
 * repairLauncher for the own copy, shared by everyone who asks while it runs. After a rewrite, the CLI's
 * version is asked again and the Cells and Launch profiles views read it again.
 */
export function repairOnce(deps: CellCommandDeps): Promise<RepairResult> {
  const dir = deps.cliDir;
  if (!dir) {
    return Promise.resolve("ok");
  }
  const running = repairs.get(dir);
  if (running) {
    return running;
  }
  const p = (async () => {
    const r = await repairLauncher(dir, deps.python, deps.platform ?? process.platform);
    if (r === "repaired") {
      deps.provider.versions.clear();
      void deps.provider.refresh();
      deps.onRepaired?.();
    }
    return r;
  })().finally(() => repairs.delete(dir));
  repairs.set(dir, p);
  return p;
}

/**
 * Before the own copy is used: "ok" when `cli` isn't the extension's own launcher, or its Python is one the
 * CLI accepts (a better Python found now replaces a Store one silently). Otherwise the user was told:
 * "declined" when they turned down the Python offer, "stop" when they took it or saw an error.
 */
export async function ownCliCheck(deps: CellCommandDeps, cli: string): Promise<"ok" | "declined" | "stop"> {
  const platform = deps.platform ?? process.platform;
  if (!deps.cliDir || installedLauncher(deps.cliDir, platform) !== cli) {
    return "ok";
  }
  let r: RepairResult;
  try {
    r = await repairOnce(deps);
  } catch (e) {
    await vscode.window.showErrorMessage(e instanceof ProvisionError ? e.message : String(e));
    return "stop";
  }
  if (r === "ok" || r === "repaired") {
    return "ok";
  }
  return (await offerPython(platform, r === "store-only")) ? "stop" : "declined";
}

/** ownCliCheck as a yes/no: false when the own copy can't run (the user was told). */
export async function ownCliUsable(deps: CellCommandDeps, cli: string): Promise<boolean> {
  return (await ownCliCheck(deps, cli)) === "ok";
}

/**
 * Once, at activation and silently: a launcher of the extension's own copy that runs a Python the CLI can't
 * use is rewritten with a better one when there is one. True when it was rewritten. Otherwise the next CLI
 * action shows the Python offer (ownCliCheck).
 */
export async function repairOwnCli(deps: CellCommandDeps): Promise<boolean> {
  if (deps.resolve().kind === "in-session") {
    return false;
  }
  try {
    return (await repairOnce(deps)) === "repaired";
  } catch {
    return false;
  }
}

function track(deps: CellCommandDeps, t: vscode.Terminal): vscode.Terminal {
  deps.terminals.add(t);
  return t;
}

/** The folder the user last started this cell in from here, when it is still there. */
function rememberedFolder(state: State, cell: LocalCell): string | undefined {
  const all = state.get<unknown>(CELL_FOLDERS_KEY);
  const v = all && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, unknown>)[cell.instanceId] : undefined;
  return typeof v === "string" && isDirectory(v) ? v : undefined;
}

async function rememberFolder(state: State, cell: LocalCell, folder: string): Promise<void> {
  const all = state.get<unknown>(CELL_FOLDERS_KEY);
  const kept = Object.entries(all && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, unknown>) : {})
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[0] !== cell.instanceId);
  await state.update(CELL_FOLDERS_KEY, Object.fromEntries([...kept, [cell.instanceId, folder]].slice(-CELL_FOLDERS_MAX)));
}

/**
 * The folder picker for a cell whose conversation folder isn't known (or is gone): it opens on the folder the cell
 * was last started in from here, else the folder of the last prompt typed in it, else this window's first folder;
 * never a silent default. undefined: cancelled.
 */
async function pickCellFolder(state: State, cell: LocalCell, title: string, stateDir: string | undefined, platform: NodeJS.Platform): Promise<string | undefined> {
  const start = rememberedFolder(state, cell) ?? lastPromptFolder(stateDir, cell.name, platform)
    ?? vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "file")?.uri.fsPath;
  const chosen = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title, openLabel: CELL_START_TEXTS.pickLabel,
    ...(start ? { defaultUri: vscode.Uri.file(start) } : {}),
  });
  const uri = chosen?.[0];
  return uri && uri.scheme === "file" && uri.fsPath ? uri.fsPath : undefined;
}

/**
 * The folder with its links resolved, as Python's realpath does: the longest part of it that exists, resolved, and
 * the rest as given (the CLI records and compares folders that way).
 */
function realFolder(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const up = path.dirname(cur);
      if (up === cur) {
        return p;
      }
      rest.push(path.basename(cur));
      cur = up;
    }
  }
  return p;
}

/**
 * 0.9.3: the folder a cell without a folder of its own starts in: the window's folder (`chosen`), else one picked
 * (with no folder open the terminal would start in the home folder, where the CLI refuses a cell). undefined: cancelled,
 * or a folder the CLI refuses (the user was told).
 */
export async function cellStartFolder(deps: CellCommandDeps, chosen: string | vscode.Uri | undefined | null): Promise<string | undefined> {
  if (chosen === null) {
    return undefined;
  }
  let cwd = typeof chosen === "string" ? chosen : chosen?.fsPath;
  if (!cwd) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: CELL_START_TEXTS.pickNewTitle, openLabel: CELL_START_TEXTS.pickLabel,
    });
    const uri = picked?.[0];
    if (!uri || uri.scheme !== "file" || !uri.fsPath) {
      return undefined;
    }
    cwd = uri.fsPath;
  }
  const platform = deps.platform ?? process.platform;
  const what = cellFolderConflict(cwd, deps, deps.stateDir ?? cellsListDir(deps.env ?? process.env, platform, deps.home), platform);
  if (what) {
    await vscode.window.showErrorMessage(CELL_START_TEXTS.folderRefused(showText(cwd, 300) ?? cwd, what));
    return undefined;
  }
  return cwd;
}

/**
 * 0.9.3: why the a4sx CLI refuses to start a cell in `folder` without --mesh-reduced-isolation (its _ipc_check_cwd):
 * the folder is, is inside, or holds the a4sx state folder, the a4sx config folder or your Claude Code folder (the home
 * folder holds all three). undefined: none of that. Links resolved and, on Windows, case-blind, as the CLI compares.
 */
export function cellFolderConflict(folder: string, deps: Pick<CellCommandDeps, "env" | "home">, stateDir: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  const p = platform === "win32" ? path.win32 : path.posix;
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const norm = (x: string) => {
    const abs = p.resolve(realFolder(x));
    const r = abs === p.parse(abs).root ? abs : abs.replace(/[\\/]+$/, "");   // a drive root keeps its separator
    return platform === "win32" ? r.toLowerCase() : r;
  };
  const under = (child: string, parent: string) => child.startsWith(parent.endsWith(p.sep) ? parent : parent + p.sep);
  const cw = norm(folder);
  const dirs: [string, string | undefined][] = [
    ["the a4sx state folder", stateDir],
    ["the a4sx config folder", cliConfigDir(home)],
    ["your Claude Code folder", env.CLAUDE_CONFIG_DIR || p.join(home, ".claude")],
  ];
  for (const [label, dir] of dirs) {
    if (!dir) {
      continue;
    }
    const d = norm(dir);
    if (d === cw || under(cw, d)) {
      return `is ${d === cw ? "" : "inside "}${label} (${showText(dir, 300) ?? dir})`;
    }
    if (d !== cw && cw !== p.parse(cw).root && under(d, cw)) {   // the CLI never counts a root as holding them
      return `holds ${label} (${showText(dir, 300) ?? dir})`;
    }
  }
  return undefined;
}

/** Whether two folders are the same (Windows: case-blind, either slash, no trailing slash). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (x: string) => {
    const y = (platform === "win32" ? x.replace(/\//g, "\\") : x).replace(/[\\/]+$/, "");
    return platform === "win32" ? y.toLowerCase() : y;
  };
  return norm(a) === norm(b);
}

async function transcriptTitleOf(file: string): Promise<string | undefined> {
  try {
    const st = await fs.promises.stat(file);
    return showText(transcriptTitle(await readTail(file, st.size)), 80);
  } catch {
    return undefined;
  }
}

/**
 * Start in terminal: `a4sx launch --cell NAME [--mesh ID]`. 0.9.2: in the folder the cell's
 * last conversation ran in, and with `-- --resume <its id>` while its transcript is there (Claude Code finds a
 * conversation only from its own folder). The CLI records that conversation (0.31.10+); with none recorded, or its
 * folder gone, the user picks the folder. Never the home folder by default, never this window's folder silently.
 */
export async function startCell(deps: CellCommandDeps, item: LocalCellItem | undefined): Promise<vscode.Terminal | undefined> {
  if (!(item instanceof LocalCellItem)) {
    return undefined;
  }
  const cell = item.cell;
  if (cell.meshId === undefined) {
    const choice = await vscode.window.showInformationMessage(CELL_CMD_TEXTS.standalone(cell.name), CELL_CMD_TEXTS.openInBrowser);
    if (choice === CELL_CMD_TEXTS.openInBrowser) {
      await openCellOnWeb(deps, item);
    }
    return undefined;
  }
  if (!cellLaunchArgs(cell, item.all)) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.badCell);
    return undefined;
  }
  // 0.9.3: no reduced-isolation dialog here: the CLI asks in the terminal, once per cell, and stores the answer
  const cli = await ensureCli(deps);
  if (!cli || !(await cliAsksConsent(deps, cli))) {
    return undefined;
  }
  // Claude Code first: nobody picks a folder for a start that then can't happen.
  const claude = await cellClaudeEnv(deps);
  if (!claude) {
    return undefined;
  }
  const platform = deps.platform ?? process.platform;
  const stateDir = deps.stateDir ?? cellsListDir(deps.env ?? process.env, platform, deps.home);
  const plan: CellStartPlan = cellStartPlan(stateDir, deps.claudeProjects ?? claudeProjectsDir(deps.env ?? process.env, deps.home), cell, platform);
  const t = CELL_START_TEXTS;
  let cwd: string | undefined;
  /** The conversation's folder is one a cell can't start in: the user chose another, a new conversation there. */
  let left = false;
  const conflict = plan.kind === "resume" || plan.kind === "gone" ? cellFolderConflict(plan.cwd, deps, stateDir, platform) : undefined;
  if (conflict && (plan.kind === "resume" || plan.kind === "gone")) {
    // 0.9.1 started a cell in the home folder when no folder was open, so the CLI may have recorded that. The CLI
    // refuses a cell there without --mesh-reduced-isolation, which 0.9.3 no longer adds.
    const shown = showText(plan.cwd, 300) ?? plan.cwd;
    const choice = await vscode.window.showWarningMessage(t.folderTitle(cell.name, shown), { modal: true, detail: t.folderDetail(shown, conflict) }, t.folderChoose);
    if (choice !== t.folderChoose) {
      return undefined;
    }
    cwd = await pickCellFolder(deps.state, cell, t.pickTitle(cell.name), stateDir, platform);
    if (cwd === undefined) {
      return undefined;
    }
    left = true;
  } else if (plan.kind === "resume" || plan.kind === "gone") {
    cwd = plan.cwd;
  } else {
    cwd = await pickCellFolder(deps.state, cell, plan.kind === "moved" ? t.movedTitle(cell.name, plan.lastCwd) : t.pickTitle(cell.name), stateDir, platform);
    if (cwd === undefined) {
      return undefined;
    }
  }
  const picked = cellFolderConflict(cwd, deps, stateDir, platform);
  if (picked) {
    await vscode.window.showErrorMessage(t.folderRefused(showText(cwd, 300) ?? cwd, picked));
    return undefined;
  }
  // Only a Claude Code session id goes on the command line; another id the CLI recorded is resumed by the CLI itself
  // (0.31.10+: a stored cell started in its last conversation's folder continues it).
  // A record exists only from CLI 0.31.10 on, which knows --new-session: a gone folder's start doesn't ask again.
  // The CLI records a last conversation only for a Claude Code launch, so `--resume` goes to Claude Code.
  const resuming = plan.kind === "resume" && !left;
  const session = resuming && cellLaunchArgs(cell, item.all, plan.sessionId) ? plan.sessionId : plan.kind === "moved" || left ? "new" : undefined;
  const args = cellLaunchArgs(cell, item.all, session)!;
  const short = plan.kind === "none" ? "" : plan.sessionId.slice(0, 8);
  const shownCwd = showText(cwd, 300) ?? cwd;
  const terminal = track(deps, openCommandTerminal(
    CELL_CMD_TEXTS.cellTerminal(cell.name), cli, CLI_NAME, args, cwd, claude.env, resuming ? t.banner(short, shownCwd) : undefined, true,
  ));
  await rememberFolder(deps.state, cell, cwd);
  const said = left && plan.kind === "resume" ? t.left(cell.name, short, showText(plan.cwd, 300) ?? plan.cwd, shownCwd)
    : left ? t.leftGone(cell.name, shownCwd)
    : plan.kind === "resume" ? t.resuming(cell.name, await transcriptTitleOf(plan.transcript), short, shownCwd)
    : plan.kind === "gone" ? t.gone(cell.name, short, shownCwd)
      : plan.kind === "moved" ? t.movedStarted(cell.name, short, showText(plan.lastCwd, 300) ?? plan.lastCwd, shownCwd)
        : t.fresh(cell.name, shownCwd);
  void vscode.window.showInformationMessage(said);
  return terminal;
}

/** New cell: `a4sx launch --new-cell`; the claim happens in the browser, the reduced-isolation question in the terminal. */
export async function newCell(deps: CellCommandDeps): Promise<vscode.Terminal | undefined> {
  const cli = await ensureCli(deps);
  if (!cli || !(await cliAsksConsent(deps, cli))) {
    return undefined;
  }
  const claude = await cellClaudeEnv(deps);
  if (!claude) {
    return undefined;
  }
  const cwd = await cellStartFolder(deps, await deps.folder());
  if (cwd === undefined) {
    return undefined;
  }
  return track(deps, openCommandTerminal(CELL_CMD_TEXTS.newCellTerminal, cli, CLI_NAME, NEW_CELL_ARGS, cwd, claude.env, undefined, true));
}

/**
 * #2301 E1: "Start on this computer" for one of your own cells on another computer: `a4sx launch --cell NAME --mesh
 * MESH` in a terminal, in a folder the person picks (as New cell). The CLI decides: it refuses while the cell runs
 * elsewhere, else moves it here; its text is shown in the terminal as it is.
 */
export async function startCellHere(deps: CellCommandDeps, item: RemoteCellItem | undefined): Promise<vscode.Terminal | undefined> {
  if (!(item instanceof RemoteCellItem) || !item.peer.own) {
    return undefined;
  }
  const args = startHereArgs(item.peer.name, item.meshId);
  if (!args) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.startHereBad);
    return undefined;
  }
  const cli = await ensureCli(deps);
  if (!cli || !(await cliAsksConsent(deps, cli))) {
    return undefined;
  }
  const claude = await cellClaudeEnv(deps);
  if (!claude) {
    return undefined;
  }
  const cwd = await cellStartFolder(deps, await deps.folder());
  if (cwd === undefined) {
    return undefined;
  }
  const name = item.peer.name;
  const terminal = track(deps, openCommandTerminal(CELL_CMD_TEXTS.startHereTerminal(name), cli, CLI_NAME, args, cwd, claude.env, undefined, true));
  void vscode.window.showInformationMessage(CELL_CMD_TEXTS.startHereStarted(name, showText(cwd, 300) ?? cwd));
  return terminal;
}

/** #2301 E2: `a4sx agent-host` in a terminal (it runs there until Ctrl+C or the terminal closes). */
export async function startAgentHost(deps: CellCommandDeps): Promise<vscode.Terminal | undefined> {
  const cli = await ensureCli(deps);
  if (!cli) {
    return undefined;
  }
  const direct = directLaunch(cli, readSmall, (p) => fs.existsSync(p), deps.platform ?? process.platform);
  const t = direct
    ? openCommandTerminal(AGENT_HOST_TEXTS.startTerminal, direct.exe, "python", [...direct.pre, ...AGENT_HOST_START_ARGS], deps.home ?? os.homedir(), undefined, undefined, true)
    : openCommandTerminal(AGENT_HOST_TEXTS.startTerminal, cli, CLI_NAME, [...AGENT_HOST_START_ARGS], deps.home ?? os.homedir(), undefined, undefined, true);
  deps.provider.rereadHostSoon();
  return track(deps, t);
}

/**
 * a4sx #2326: `a4sx agent-host stop` (CLI 0.59.15+), the same stop as Ctrl+C in the host's terminal, with a progress
 * notification while it waits (at most about 30 s). Says the CLI's own line on a refusal, and "update" for a CLI
 * without the command. Resolves true when the host stopped (or wasn't running).
 */
export async function stopAgentHost(deps: CellCommandDeps): Promise<boolean> {
  const cli = await ensureCli(deps);
  if (!cli) {
    return false;
  }
  // coordinator (as the deck's S): ask first when cells run in it; with none, stop without asking
  const now = await deps.run(cli, AGENT_HOST_STATUS_ARGS, 15_000);
  const open = (now.code === 0 ? parseAgentHostStatus(now.stdout)?.open : undefined) ?? [];
  const plain = now.code === 0 ? plainOpenCount(now.stdout) : 0;   // review: a plain conversation ends too
  if ((open.length || plain) && (await vscode.window.showWarningMessage(AGENT_HOST_TEXTS.stopAsk(open.map((o) => o.name), plain), { modal: true },
    AGENT_HOST_TEXTS.stopIt)) !== AGENT_HOST_TEXTS.stopIt) {
    return false;
  }
  const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: AGENT_HOST_TEXTS.stopping },
    () => deps.run(cli, AGENT_HOST_STOP_ARGS, 45_000));
  deps.provider.rereadHostSoon();
  if (out.code === 0) {   // the CLI says "stopped (pid N)", or "not running, so there is nothing to stop"
    await vscode.window.showInformationMessage(/not running/.test(out.stdout) ? AGENT_HOST_TEXTS.stopNotRunning : AGENT_HOST_TEXTS.stopDone);
    return true;
  }
  const why = cliErrorText(out);
  await vscode.window.showErrorMessage(lacksAgentHost(out.stderr) ? AGENT_HOST_TEXTS.stopNeedsUpdate
    : !why && out.code === null ? AGENT_HOST_TEXTS.stopNoAnswer   // review: the run's own timeout says nothing itself
      : CELL_CMD_TEXTS.cliFailed(AGENT_HOST_TEXTS.stopWhat, why));
  return false;
}

/** How many plain Agents-window conversations (not cells) the status lists as open: "name (plain)" entries. */
function plainOpenCount(stdout: string): number {
  try {
    const raw = JSON.parse(stdout) as { open?: unknown };
    return Array.isArray(raw.open) ? raw.open.slice(0, 64).filter((e) => typeof e === "string" && e.endsWith(" (plain)")).length : 0;
  } catch {
    return 0;
  }
}

/** A launcher file's text (at most 4 KiB), or undefined. */
function readSmall(p: string): string | undefined {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size <= 4096 ? fs.readFileSync(p, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** #2301 E2: `a4sx setup-vscode` in a terminal: it says what it changed. */
export async function setupAgentsWindow(deps: CellCommandDeps): Promise<vscode.Terminal | undefined> {
  const cli = await ensureCli(deps);
  if (!cli) {
    return undefined;
  }
  const direct = directLaunch(cli, readSmall, (p) => fs.existsSync(p), deps.platform ?? process.platform);
  const t = direct
    ? openCommandTerminal(AGENT_HOST_TEXTS.setupTerminal, direct.exe, "python", [...direct.pre, ...AGENT_HOST_SETUP_ARGS], deps.home ?? os.homedir(), undefined, undefined, true)
    : openCommandTerminal(AGENT_HOST_TEXTS.setupTerminal, cli, CLI_NAME, [...AGENT_HOST_SETUP_ARGS], deps.home ?? os.homedir(), undefined, undefined, true);
  deps.provider.rereadHostSoon();   // setup-vscode starts the host too
  return track(deps, t);
}

/** The last line the CLI wrote to stderr, made safe to show (its own message, e.g. "no cell named …"). */
export function cliDetail(stderr: string): string | undefined {
  const line = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  return showText(line?.replace(/^a4sx:\s*/, ""), 300);
}

/** What the CLI said about a refusal: its JSON error's message (0.25.0+), else its last stderr line. */
export function cliErrorText(out: CliOutput): string | undefined {
  return parseCliError(out.stdout)?.message ?? cliDetail(out.stderr);
}

export async function setDefaultCell(deps: CellCommandDeps, item: LocalCellItem | undefined): Promise<boolean> {
  if (!(item instanceof LocalCellItem)) {
    return false;
  }
  const args = cellDefaultArgs(item.cell, item.all);
  const cli = args && (await ensureCli(deps));
  if (!args || !cli) {
    return false;
  }
  const out = await deps.run(cli, args, 30_000);
  await deps.provider.refresh();
  if (out.code !== 0) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.cliFailed("make it the default", cliErrorText(out)));
    return false;
  }
  void vscode.window.showInformationMessage(CELL_CMD_TEXTS.nowDefault(item.cell.name));
  return true;
}

export async function forgetCell(deps: CellCommandDeps, item: LocalCellItem | undefined): Promise<boolean> {
  if (!(item instanceof LocalCellItem)) {
    return false;
  }
  const args = cellForgetArgs(item.cell, item.all);
  if (!args) {
    return false;
  }
  const choice = await vscode.window.showWarningMessage(CELL_CMD_TEXTS.forgetTitle(item.cell.name), { modal: true, detail: CELL_CMD_TEXTS.forgetDetail }, CELL_CMD_TEXTS.forget);
  if (choice !== CELL_CMD_TEXTS.forget) {
    return false;
  }
  const cli = await ensureCli(deps);
  if (!cli) {
    return false;
  }
  const out = await deps.run(cli, args, 30_000);
  await deps.provider.refresh();
  if (out.code !== 0) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.cliFailed("forget the cell", cliErrorText(out)));
    return false;
  }
  void vscode.window.showInformationMessage(CELL_CMD_TEXTS.forgotten(item.cell.name));
  return true;
}

/** Open mesh in browser: on a cell, or on a mesh group (a standalone one opens the meshes page). */
export async function openCellOnWeb(deps: CellCommandDeps, item: LocalCellItem | MeshGroupItem | undefined): Promise<void> {
  const cell = item instanceof LocalCellItem ? item.cell : item instanceof MeshGroupItem ? item.cells[0] : undefined;
  if (!cell) {
    return;
  }
  let base: string;
  try {
    base = deps.server();
  } catch {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.badServer);
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(cellPageUrl(base, cell)));
}

/** Open policy in browser (0.7.0, a4sx #1861): the mesh's Policy tab, only from a URL that passed cells.policyUrl. */
export async function openCellPolicy(item: LocalCellItem | undefined): Promise<boolean> {
  const url = item instanceof LocalCellItem ? policyUrl(item.cell.policy?.url, item.cell) : undefined;
  if (!url) {
    return false;
  }
  return vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Stop (a cell running on this computer): asks first, then `mesh cell stop NAME`. */
export async function stopCell(deps: CellCommandDeps, item: LocalCellItem | undefined): Promise<boolean> {
  if (!(item instanceof LocalCellItem)) {
    return false;
  }
  const args = cellStopArgs(item.cell, item.all);
  if (!args) {
    return false;
  }
  const cli = await ensureCli(deps);
  if (!cli) {
    return false;
  }
  const host = deps.provider.hostKnown;
  if (host && isOpen(host, item.cell)) {   // F1: in the agent host, only a CLI that stops it through the host
    const v = await deps.provider.versions.version(cli);
    if (v !== undefined && !versionAtLeast(v, CELL_CMD_TEXTS.MIN_HOST_CELL_STOP_CLI)) {
      // cell01: no question for something that can't be done; only the explanation
      await vscode.window.showErrorMessage(CELL_CMD_TEXTS.stopHostOld(item.cell.name, v));
      return false;
    }
  }
  const choice = await vscode.window.showWarningMessage(CELL_CMD_TEXTS.stopTitle(item.cell.name), { modal: true, detail: CELL_CMD_TEXTS.stopDetail }, CELL_CMD_TEXTS.stop);
  if (choice !== CELL_CMD_TEXTS.stop) {
    return false;
  }
  const out = await deps.run(cli, args, 30_000);
  if (out.code !== 0) {   // F1: a failed stop changes nothing shown (no re-read: the row stays as it was)
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.cliFailed("stop the cell", cliErrorText(out)));
    return false;
  }
  await deps.provider.refresh();
  void vscode.window.showInformationMessage(CELL_CMD_TEXTS.stopped(item.cell.name));
  return true;
}

/** The input box's check for a new cell name: the CLI's rule, and not another stored cell's in the same mesh. */
export function validateNewCellName(raw: string, cell: { name: string; meshId?: string }, all: readonly { name: string; meshId?: string }[]): string | undefined {
  const v = raw.trim();
  if (!CELL_NAME.test(v)) {
    return CELL_CMD_TEXTS.renameInvalid;
  }
  return v !== cell.name && all.some((c) => c.name === v && c.meshId === cell.meshId) ? CELL_CMD_TEXTS.renameTaken : undefined;
}

/**
 * Set launch profile… (CLI 0.27.0): pick one of your launch profiles (from `profiles --json`), or "Follow my
 * default profile", then `mesh cell profile NAME PROFILE|--clear`. The change applies at the cell's next start.
 */
export async function setCellProfile(deps: CellCommandDeps, item: LocalCellItem | undefined): Promise<boolean> {
  if (!(item instanceof LocalCellItem)) {
    return false;
  }
  const cell = item.cell;
  const cli = await ensureCli(deps);
  if (!cli) {
    return false;
  }
  const listed = await deps.run(cli, PROFILES_ARGS, 30_000);
  const answer = listed.code === 0 ? parseProfilesAnswer(listed.stdout) : undefined;
  if (!answer) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.cliFailed("read your launch profiles", cliErrorText(listed)));
    return false;
  }
  if (!answer.profiles.length) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.profileNone);
    return false;
  }
  const t = CELL_CMD_TEXTS;
  const items = [
    ...answer.profiles.map((p) => ({
      label: p.name ?? p.id, id: p.id as string | undefined, shown: p.name ?? p.id,
      description: [p.id === cell.launchProfile && cell.profileSource === "assigned" ? t.profileCurrent : undefined, p.id === answer.default ? t.profileDefaultMark : undefined]
        .filter(Boolean).join(" · ") || undefined,
      detail: [p.name && p.name !== p.id ? p.id : undefined, p.operator ? `X-Fleet-Operator: ${p.operator}` : undefined, p.model].filter(Boolean).join(" · ") || undefined,
    })),
    {
      label: t.profileFollowDefault, id: undefined, shown: t.profileFollowDefault,
      // the cell follows the default now: by choice ("default"), or because its own profile was deleted ("fallback")
      description: cell.profileSource === "default" || cell.profileSource === "fallback" ? t.profileCurrent : undefined, detail: t.profileFollowDefaultDetail,
    },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: t.profileTitle(cell.name), placeHolder: t.profilePlaceholder, ignoreFocusOut: true });
  if (!picked) {
    return false;
  }
  const args = cellProfileArgs(cell, item.all, picked.id);
  if (!args) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.badCell);
    return false;
  }
  const out = await deps.run(cli, args, 60_000);
  await deps.provider.refresh();
  if (out.code !== 0) {
    await vscode.window.showErrorMessage(lacksCellProfile(out) ? t.profileTooOld : t.cliFailed("set the cell's launch profile", cliErrorText(out)));
    return false;
  }
  const done = picked.id ? t.profileSet(cell.name, picked.shown) : t.profileCleared(cell.name);
  void vscode.window.showInformationMessage(cell.localState === "running" ? `${done} ${t.profileRunning}` : done);
  return true;
}

/** Rename (a cell in a mesh): an input box, then `mesh cell rename OLD NEW`. */
export async function renameCell(deps: CellCommandDeps, item: LocalCellItem | undefined): Promise<boolean> {
  if (!(item instanceof LocalCellItem) || item.cell.meshId === undefined) {
    return false;
  }
  const cell = item.cell;
  const raw = await vscode.window.showInputBox({
    title: CELL_CMD_TEXTS.renameTitle(cell.name), prompt: CELL_CMD_TEXTS.renamePrompt, value: cell.name,
    validateInput: (v) => validateNewCellName(v, cell, item.all) ?? null,
  });
  if (raw === undefined || raw.trim() === cell.name) {
    return false;
  }
  const to = raw.trim();
  const problem = validateNewCellName(to, cell, item.all);
  const args = problem ? undefined : cellRenameArgs(cell, item.all, to);
  if (!args) {
    await vscode.window.showErrorMessage(problem ?? CELL_CMD_TEXTS.renameInvalid);
    return false;
  }
  const cli = await ensureCli(deps);
  if (!cli) {
    return false;
  }
  const out = await deps.run(cli, args, 30_000);
  await deps.provider.refresh();
  if (out.code !== 0) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.cliFailed("rename the cell", cliErrorText(out)));
    return false;
  }
  void vscode.window.showInformationMessage(CELL_CMD_TEXTS.renamed(cell.name, to));
  return true;
}

/**
 * The launch command as the user would type it in the default shell (a POSIX shell when it is unknown, or
 * when a piece can't be quoted for it): the program by name when it is on PATH, else its full path.
 */
export function typedCommand(found: string, args: readonly string[], shell: string | undefined, pathEnv?: string, platform?: NodeJS.Platform): string | undefined {
  const exe = programName(found, CLI_NAME, pathEnv, platform);
  const kind = shellKind(shell);
  return (kind && commandLine(exe, args, kind)) ?? commandLine(exe, args, "posix");
}

/** Copy launch command: `a4sx launch --cell NAME [--mesh ID]`, quoted for the default shell. */
export async function copyCellLaunch(deps: CellCommandDeps, item: LocalCellItem | undefined): Promise<string | undefined> {
  if (!(item instanceof LocalCellItem)) {
    return undefined;
  }
  const args = cellLaunchArgs(item.cell, item.all);
  if (!args) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.badCell);
    return undefined;
  }
  const cli = await ensureCli(deps);
  const line = cli && typedCommand(cli, args, vscode.env.shell);
  if (!line) {
    return undefined;
  }
  await vscode.env.clipboard.writeText(line);
  void vscode.window.showInformationMessage(CELL_CMD_TEXTS.copiedLaunch);
  return line;
}

/**
 * Install a4sx CLI: find Python 3.10+ (on Windows, offer winget when there is none), download the CLI's
 * files from the configured server into the extension's storage with their sha256 checked, write the
 * launcher, and refresh the view. True when the CLI is installed.
 */
export async function installCli(deps: CellCommandDeps): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (deps.resolve().kind === "in-session") {
    await vscode.window.showErrorMessage(IN_SESSION_MESSAGE);
    return false;
  }
  if (!deps.cliDir) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.noStorage);
    return false;
  }
  let base: string;
  try {
    base = deps.server();
  } catch {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.badServer);
    return false;
  }
  const dir = deps.cliDir;
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: CELL_CMD_TEXTS.installing, cancellable: false },
    async (progress): Promise<{ ok: true; version: string } | { ok: false; error?: string; python?: "none" | "store-only" }> => {
      progress.report({ message: CELL_CMD_TEXTS.findingPython });
      const python = await searchPython(deps.python, platform);
      if (python.kind !== "found") {
        return { ok: false, python: python.kind };
      }
      progress.report({ message: CELL_CMD_TEXTS.downloading });
      try {
        const version = await downloadCli(base, dir, deps.fetch);
        writeLauncher(python.exe, dir, platform);
        return { ok: true, version };
      } catch (e) {
        return { ok: false, error: e instanceof ProvisionError ? e.message : String(e) };
      }
    },
  );
  if (!result.ok) {
    if (result.python) {
      await offerPython(platform, result.python === "store-only");
    } else {
      await vscode.window.showErrorMessage(result.error ?? CELL_CMD_TEXTS.cliFailed("install the a4sx CLI", undefined));
    }
    return false;
  }
  await deps.state.update(LAST_UPDATE_KEY, Date.now());
  void vscode.window.showInformationMessage(CELL_CMD_TEXTS.installed(result.version));
  await deps.provider.refresh();
  return true;
}

/**
 * No usable Python: on Windows, `winget install Python.Python.3.12` in a terminal (saying so when only the
 * Store build is there). True when the user took the offer.
 */
async function offerPython(platform: NodeJS.Platform, storeOnly = false): Promise<boolean> {
  if (platform === "win32") {
    const message = storeOnly ? CELL_CMD_TEXTS.storePythonWin : CELL_CMD_TEXTS.noPythonWin;
    const choice = await vscode.window.showErrorMessage(message, { modal: true, detail: `winget ${WINGET_PYTHON_ARGS.join(" ")}` }, CELL_CMD_TEXTS.installPython);
    if (choice === CELL_CMD_TEXTS.installPython) {
      openCommandTerminal(CELL_CMD_TEXTS.pythonTerminal, "winget", "winget", WINGET_PYTHON_ARGS);
      void vscode.window.showInformationMessage(CELL_CMD_TEXTS.pythonNext);
      return true;
    }
    return false;
  }
  if ((await vscode.window.showErrorMessage(CELL_CMD_TEXTS.noPython, CELL_CMD_TEXTS.howToInstall)) === CELL_CMD_TEXTS.howToInstall) {
    await vscode.env.openExternal(vscode.Uri.parse(PYTHON_DOWNLOAD_URL));
    return true;
  }
  return false;
}

/** Update the a4sx CLI: `a4sx update` in a terminal, so its output shows. */
export async function updateCliInTerminal(deps: CellCommandDeps): Promise<vscode.Terminal | undefined> {
  const cli = await ensureCli(deps);
  if (!cli) {
    return undefined;
  }
  let base: string;
  try {
    base = deps.server();
  } catch {
    base = deps.defaultServer;
  }
  return track(deps, openCommandTerminal(CELL_CMD_TEXTS.updateTerminal, cli, CLI_NAME, updateArgs(base, deps.defaultServer)));
}

/**
 * Once a day, silently: `a4sx update` for the extension's own copy of the CLI (a CLI the user installed
 * elsewhere is theirs to update). The day counts from the attempt, so an offline start doesn't retry
 * on every window. Resolves true when an update ran and succeeded.
 */
export async function dailyUpdate(deps: CellCommandDeps, now: number = Date.now()): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const launcher = installedLauncher(deps.cliDir, platform);
  // A launcher whose Python the CLI can't use can't update either; repairOwnCli runs first.
  if (!launcher || launcherNeedsRepair(deps.cliDir, platform) || deps.resolve().kind === "in-session" || !updateDue(deps.state.get<unknown>(LAST_UPDATE_KEY), now)) {
    return false;
  }
  await deps.state.update(LAST_UPDATE_KEY, now);
  let base: string;
  try {
    base = deps.server();
  } catch {
    return false;
  }
  const out = await deps.run(launcher, updateArgs(base, deps.defaultServer), 120_000);
  return out.code === 0;
}
