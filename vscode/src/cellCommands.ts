// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The Cells view's actions: start a stored cell or a new one in a terminal, make one the default, forget
// one, open its page; and installing / updating the a4sx CLI in the extension's storage. Every CLI call is
// an argv array (a terminal types it quoted for the user's shell; the rest run with execFile, no shell).
// The extension never reads the CLI's key files and puts no key into a terminal, a setting or a file.
import * as vscode from "vscode";
import { createHash } from "crypto";
import * as os from "os";
import { CLI_NAME } from "./cli";
import {
  CELL_NAME, cellDefaultArgs, cellForgetArgs, cellLaunchArgs, cellPageUrl, cellRenameArgs, cellStopArgs, NEW_CELL_ARGS, showText,
} from "./cells";
import { CellsProvider, CliOutput, CliResolution, CliRunner, LocalCellItem, MeshGroupItem } from "./cellsView";
import { IN_SESSION_MESSAGE, parseCliError } from "./cliJson";
import {
  bundledClaude, downloadCli, Fetch, installedLauncher, launcherNeedsRepair, ProvisionError, repairLauncher, RepairResult, Runner, searchPython, updateArgs, updateDue,
  WINGET_PYTHON_ARGS, writeLauncher,
} from "./provision";
import { openCommandTerminal, State } from "./resume";
import { commandLine, programName, shellKind } from "./terminalCommand";

export const CONSENT_KEY = "a4sx.cellReducedIsolationConsent";
export const LAST_UPDATE_KEY = "a4sx.cliLastUpdate";
export const CLAUDE_CODE_ID = "anthropic.claude-code";
export const CLAUDE_ENV = "A4SX_CLAUDE";
export const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";

export const CELL_CMD_TEXTS = {
  newCellTerminal: "a4sx: new cell",
  cellTerminal: (name: string) => `a4sx: cell ${name}`,
  updateTerminal: "a4sx: update",
  pythonTerminal: "a4sx: install Python",
  consentTitle: "Start cells with reduced isolation on this computer?",
  consentDetail:
    "Where this computer can't sandbox your agent, a cell runs as your own user (\"reduced isolation\"). Then your agent " +
    "could act as this cell in its mesh and skip the cell's outgoing checks, and it can read and use the a4sx sign-ins " +
    "and keys saved on this computer. Every other session still checks everything it receives. Continue only if you " +
    "trust the agent on this computer.\n\nWhere the sandbox works, the cell runs in it and none of this applies. " +
    "You're asked once on this computer.",
  consentAccept: "Accept and start",
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
  renameTitle: (name: string) => `Rename the cell «${name}»`,
  renamePrompt: "New name: lowercase letters, digits and -",
  renameInvalid: "Use up to 48 lowercase letters, digits and -, starting and ending with a letter or digit.",
  renameTaken: "Another cell in this mesh on this computer already has this name.",
  renamed: (from: string, to: string) => `Renamed the cell «${from}» to «${to}».`,
  copiedLaunch: "Copied the launch command.",
};

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
}

/** This machine, as the consent remembers it: a hash, so no host name is stored. */
export function machineKey(): string {
  return createHash("sha256").update([os.hostname(), process.platform, os.homedir()].join("\0")).digest("hex").slice(0, 32);
}

/** Asks once per machine before the first start with --mesh-reduced-isolation; true when accepted. */
export async function consentReducedIsolation(state: State, key: string = machineKey()): Promise<boolean> {
  const seen = state.get<unknown>(CONSENT_KEY);
  const list = Array.isArray(seen) ? seen.filter((x): x is string => typeof x === "string") : [];
  if (list.includes(key)) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(CELL_CMD_TEXTS.consentTitle, { modal: true, detail: CELL_CMD_TEXTS.consentDetail }, CELL_CMD_TEXTS.consentAccept);
  if (choice !== CELL_CMD_TEXTS.consentAccept) {
    return false;
  }
  await state.update(CONSENT_KEY, [...list, key].slice(-20));
  return true;
}

/**
 * The env for a cell's terminal: A4SX_CLAUDE = the Claude Code extension's bundled claude, when that
 * extension is installed and the user hasn't set A4SX_CLAUDE themselves. No key, nothing secret.
 */
export function cellTerminalEnv(platform: NodeJS.Platform = process.platform): Record<string, string> | undefined {
  if (process.env[CLAUDE_ENV]) {
    return undefined;
  }
  const claude = bundledClaude(vscode.extensions.getExtension(CLAUDE_CODE_ID)?.extensionPath, platform);
  return claude ? { [CLAUDE_ENV]: claude } : undefined;
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

/** Start in terminal: `a4sx launch --cell NAME [--mesh ID] --mesh-reduced-isolation` in the workspace folder. */
export async function startCell(deps: CellCommandDeps, item: LocalCellItem | undefined): Promise<vscode.Terminal | undefined> {
  if (!(item instanceof LocalCellItem)) {
    return undefined;
  }
  if (item.cell.meshId === undefined) {
    const choice = await vscode.window.showInformationMessage(CELL_CMD_TEXTS.standalone(item.cell.name), CELL_CMD_TEXTS.openInBrowser);
    if (choice === CELL_CMD_TEXTS.openInBrowser) {
      await openCellOnWeb(deps, item);
    }
    return undefined;
  }
  const args = cellLaunchArgs(item.cell, item.all);
  if (!args) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.badCell);
    return undefined;
  }
  const cli = await ensureCli(deps);
  if (!cli || !(await consentReducedIsolation(deps.state))) {
    return undefined;
  }
  const cwd = await deps.folder();
  if (cwd === null) {
    return undefined;
  }
  return track(deps, openCommandTerminal(CELL_CMD_TEXTS.cellTerminal(item.cell.name), cli, CLI_NAME, args, cwd, cellTerminalEnv(deps.platform)));
}

/** New cell: `a4sx launch --new-cell --mesh-reduced-isolation`; the claim happens in the browser from there. */
export async function newCell(deps: CellCommandDeps): Promise<vscode.Terminal | undefined> {
  const cli = await ensureCli(deps);
  if (!cli || !(await consentReducedIsolation(deps.state))) {
    return undefined;
  }
  const cwd = await deps.folder();
  if (cwd === null) {
    return undefined;
  }
  return track(deps, openCommandTerminal(CELL_CMD_TEXTS.newCellTerminal, cli, CLI_NAME, NEW_CELL_ARGS, cwd, cellTerminalEnv(deps.platform)));
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

/** Stop (a cell running on this computer): asks first, then `mesh cell stop NAME`. */
export async function stopCell(deps: CellCommandDeps, item: LocalCellItem | undefined): Promise<boolean> {
  if (!(item instanceof LocalCellItem)) {
    return false;
  }
  const args = cellStopArgs(item.cell, item.all);
  if (!args) {
    return false;
  }
  const choice = await vscode.window.showWarningMessage(CELL_CMD_TEXTS.stopTitle(item.cell.name), { modal: true, detail: CELL_CMD_TEXTS.stopDetail }, CELL_CMD_TEXTS.stop);
  if (choice !== CELL_CMD_TEXTS.stop) {
    return false;
  }
  const cli = await ensureCli(deps);
  if (!cli) {
    return false;
  }
  const out = await deps.run(cli, args, 30_000);
  await deps.provider.refresh();
  if (out.code !== 0) {
    await vscode.window.showErrorMessage(CELL_CMD_TEXTS.cliFailed("stop the cell", cliErrorText(out)));
    return false;
  }
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

/** Copy launch command: `a4sx launch --cell NAME [--mesh ID] --mesh-reduced-isolation`, quoted for the default shell. */
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
