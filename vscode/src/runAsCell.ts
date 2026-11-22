// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.5.0: "Run as cell in terminal" on a session in My sessions. Pick one of this computer's cells (or a new
// one), set two toggles, and a terminal in the session's folder runs
//   a4sx launch --cell <cell> [--auto-allow-ipc-messages] -- --resume <session id>
// for a session that is on this computer, or `… --a4sx-session=<id>` for one that is only in the library.
// "New cell…" runs `a4sx launch --new-cell [flags] …`: the browser approval then picks the mesh.
// 0.9.3: no --mesh-reduced-isolation and no reduced-isolation dialog of the extension's: the CLI (0.32.0+) asks its own
// question in the terminal, once per cell per computer, and stores the answer (cellCommands.cliAsksConsent).
// 0.5.2: no flag picks a router or a launch profile. A cell with neither runs on this computer's Claude Code sign-in
// (the CLI's default since 0.26.5); when that is sure, one line says so as the terminal opens (claudeSignInHint).
// Every piece is an argv element, quoted for the user's shell (PowerShell, bash, …) by openCommandTerminal.
import * as vscode from "vscode";
import { CLI_NAME } from "./cli";
import { LaunchOptions, LocalCell, newCellRunArgs, ResumeTarget, runAsCellArgs, startableCell } from "./cells";
import { CELL_CMD_TEXTS, CELL_START_TEXTS, CellCommandDeps, cellClaudeEnv, cellFolderConflict, cellStartFolder, cliAsksConsent, ensureCli } from "./cellCommands";
import { cellsListDir, showText } from "./cells";
import { CELL_TEXTS, CliRunner, CMD_UPDATE_CLI } from "./cellsView";
import { CONFIG_SHOW_ARGS, configAutoAllow, versionAtLeast } from "./cliJson";
import { LocalSession } from "./localSession";
import { openCommandTerminal } from "./resume";

export const RUN_AS_CELL_TEXTS = {
  pickTitle: "Run as cell in terminal",
  pickPlaceholder: "Choose the cell to run this session in",
  newCell: "$(add) New cell…",
  newCellDetail: "Approve it in your browser, where you pick its mesh.",
  defaultMark: "default",
  noProfile: "no launch profile",
  optionsTitle: "Run as cell: options",
  optionsPlaceholder: "Choose the options for this start, then press Enter",
  claudeSignIn: "Without a launch profile, this cell uses your Claude Code sign-in on this machine; run /login inside the cell if you have none.",
  autoAllow: "Deliver messages from mesh peers without asking",
  autoAllowDetail: "Off: you approve each message another session in the mesh sends to this one, unless ipc.auto_allow_messages is on in your a4sx config.",
  autoAllowFromConfig: "On in your a4sx config (ipc.auto_allow_messages): turning it off here doesn't change that. `a4sx config set ipc.auto_allow_messages false` does.",
  autoAllowTitle: "Deliver messages from mesh peers without asking?",
  autoAllowWarning:
    "Messages that other sessions in the mesh send to this cell will reach the agent without you approving each one. " +
    "A peer could use that to steer the agent. Turn this on only for a mesh whose members you trust.",
  autoAllowAccept: "Deliver without asking",
  badSession: "This session can't be started in a cell: its id isn't one the a4sx CLI accepts.",
  nameTaken: (name: string) => `A cell named ${name} is already stored on this computer, so nothing was started: the a4sx CLI refuses a new cell with that name. Run this again with another name, or leave the name empty for a suggested one.`,
};

/** What a session item gives this command: its library id, and how to find it on this computer. */
export interface RunAsCellSession {
  /** The library id (`--a4sx-session=` takes it). */
  id: string;
  /** Finds the session on this computer (its Claude Code id and folder), or undefined. */
  findLocal(): Promise<LocalSession | undefined>;
}

export type CellChoice = { kind: "cell"; cell: LocalCell } | { kind: "new" };

/** The cells offered: those in a mesh (a standalone cell can't start), the default first, then by name. */
export function cellChoices(cells: readonly LocalCell[]): { label: string; description: string; choice: CellChoice }[] {
  const t = RUN_AS_CELL_TEXTS;
  const startable = cells.filter(startableCell).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  return [
    ...startable.map((cell) => ({
      label: `$(${cell.localState === "running" ? "debug-start" : cell.isDefault ? "star-full" : "terminal"}) ${cell.name}`,
      // name · mesh · launch profile
      description: [cell.meshName ?? cell.meshId, cell.launchProfile ? `profile ${cell.launchProfile}` : t.noProfile, cell.isDefault ? t.defaultMark : undefined, cell.localState === "running" ? "running" : undefined]
        .filter(Boolean).join(" · "),
      choice: { kind: "cell", cell } as CellChoice,
    })),
    { label: t.newCell, description: t.newCellDetail, choice: { kind: "new" } as CellChoice },
  ];
}

/** Whether `a4sx config show` (a local file, no network) turns on ipc.auto_allow_messages; false when unknown. */
export async function readConfigAutoAllow(run: CliRunner, cli: string): Promise<boolean> {
  try {
    return configAutoAllow((await run(cli, CONFIG_SHOW_ARGS, 10_000)).stdout) === true;
  } catch {
    return false;
  }
}

/** The first a4sx CLI that runs a cell with no router and no launch profile on the Claude Code sign-in. */
export const MIN_CLAUDE_SIGNIN_CLI = "0.26.5";

/**
 * Whether the hint ("Without a launch profile, this cell uses your Claude Code sign-in …") applies: a new cell, or one
 * whose launch profile the CLI reported (its rows carry profiles: not `legacy`) as none after reading the server
 * (state active or reserved: `profile: null` with state "unknown" can mean the server part couldn't be read, and a
 * revoked cell can't start); and a CLI with that default (0.26.5+).
 */
export function claudeSignInHint(choice: CellChoice, legacy: boolean, cliVersion: string | undefined): boolean {
  // read from the server, and a cell that can start (a revoked one can't)
  const read = (c: LocalCell) => !legacy && (c.registryState === "active" || c.registryState === "reserved");
  const noProfile = choice.kind === "new" || (read(choice.cell) && !choice.cell.launchProfile);
  return noProfile && cliVersion !== undefined && versionAtLeast(cliVersion, MIN_CLAUDE_SIGNIN_CLI);
}

/**
 * The option: "Deliver … without asking", off (on, and saying so, when the CLI's config already turns it on).
 * 0.9.3: "Keep my sign-in (reduced isolation)" is gone: the CLI asks about reduced isolation itself, and its stored yes
 * keeps the sign-ins as that flag did. undefined: Esc.
 */
export async function pickLaunchOptions(configAutoAllowOn = false): Promise<LaunchOptions | undefined> {
  const t = RUN_AS_CELL_TEXTS;
  const items = [
    {
      label: t.autoAllow, description: "--auto-allow-ipc-messages", detail: configAutoAllowOn ? t.autoAllowFromConfig : t.autoAllowDetail,
      picked: configAutoAllowOn, key: "autoAllow" as const,
    },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: t.optionsTitle, placeHolder: t.optionsPlaceholder, canPickMany: true, ignoreFocusOut: true });
  if (!picked) {
    return undefined;
  }
  const keys = new Set(picked.map((i) => i.key));
  const o: LaunchOptions = { reduced: false, autoAllow: keys.has("autoAllow") };
  if (o.autoAllow) {
    const choice = await vscode.window.showWarningMessage(t.autoAllowTitle, { modal: true, detail: t.autoAllowWarning }, t.autoAllowAccept);
    if (choice !== t.autoAllowAccept) {
      return undefined;
    }
  }
  return o;
}

/** A cell chosen before the command runs (0.8.0, Convert to cell): the cell pick is skipped. */
export interface CellPreset {
  choice: CellChoice;
  /** For a new cell: the mesh it is meant for (`--mesh ID`; the browser approval still picks the mesh). */
  meshId?: string;
  /** 0.9.1, for a new cell: the name it proposes (`--as NAME`); none: the server proposes one. */
  cellName?: string;
}

/** 0.9.1: the cell pick's title and placeholder, when the caller names the session in them (Convert into an existing cell…). */
export interface CellPickText {
  title: string;
  placeHolder: string;
}

/**
 * Run as cell in terminal. Resolves the terminal, or undefined when nothing was started (the user was told why).
 * With `preset` the cell isn't asked for; the option is asked as always. Reduced isolation is the CLI's question.
 */
export async function runAsCell(deps: CellCommandDeps, session: RunAsCellSession | undefined, preset?: CellPreset, pickText?: CellPickText): Promise<vscode.Terminal | undefined> {
  if (!session) {
    return undefined;
  }
  const t = RUN_AS_CELL_TEXTS;
  const cli = await ensureCli(deps);
  if (!cli || !(await cliAsksConsent(deps, cli))) {
    return undefined;
  }
  const [load, local] = await Promise.all([deps.provider.refresh(), session.findLocal().catch(() => undefined)]);
  if (load.kind === "too-old") {
    if ((await vscode.window.showErrorMessage(CELL_TEXTS.tooOld, CELL_TEXTS.updateCli)) === CELL_TEXTS.updateCli) {
      await vscode.commands.executeCommand(CMD_UPDATE_CLI);
    }
    return undefined;
  }
  if (load.kind !== "ok") {
    await vscode.window.showErrorMessage(load.kind === "error" && load.message ? load.message : CELL_TEXTS.listFailed);
    return undefined;
  }
  // A session that ran in a folder the CLI refuses a cell in can't run as one: said before any pick.
  if (local) {
    const platform = deps.platform ?? process.platform;
    const what = cellFolderConflict(local.cwd, deps, deps.stateDir ?? cellsListDir(deps.env ?? process.env, platform, deps.home), platform);
    if (what) {
      await vscode.window.showErrorMessage(CELL_START_TEXTS.sessionFolderRefused(showText(local.cwd, 300) ?? local.cwd, what));
      return undefined;
    }
  }
  const target: ResumeTarget = local ? { kind: "local", sessionId: local.sessionId } : { kind: "library", id: session.id };
  const picked: { choice: CellChoice } | undefined = preset
    ? { choice: preset.choice }
    : await vscode.window.showQuickPick(cellChoices(load.cells), { title: pickText?.title ?? t.pickTitle, placeHolder: pickText?.placeHolder ?? t.pickPlaceholder });
  if (!picked) {
    return undefined;
  }
  // The CLI refuses a new cell's name that a cell stored here has; say so before the options are asked.
  const wanted = preset?.cellName;
  if (picked.choice.kind === "new" && wanted !== undefined && load.cells.some((c) => c.name === wanted)) {
    await vscode.window.showErrorMessage(t.nameTaken(wanted));
    return undefined;
  }
  const options = await pickLaunchOptions(await readConfigAutoAllow(deps.run, cli));
  if (!options) {
    return undefined;
  }
  // A library-only session is seeded with the user's a4sx sign-in: the CLI's yes to reduced isolation keeps it in
  // the cell (it sets what --mesh-reduced-isolation set), so no flag is needed for that either.
  const args = picked.choice.kind === "cell" ? runAsCellArgs(picked.choice.cell, load.cells, options, target) : newCellRunArgs(options, target, preset?.meshId, preset?.cellName);
  if (!args) {
    await vscode.window.showErrorMessage(picked.choice.kind === "cell" ? CELL_CMD_TEXTS.badCell : t.badSession);
    return undefined;
  }
  // A session on this computer resumes in its own folder (Claude Code files it there); else the workspace's.
  let cwd: string | undefined = local?.cwd;
  if (!local) {
    cwd = await cellStartFolder(deps, await deps.folder());
    if (cwd === undefined) {
      return undefined;
    }
  }
  const name = picked.choice.kind === "cell" ? CELL_CMD_TEXTS.cellTerminal(picked.choice.cell.name) : CELL_CMD_TEXTS.newCellTerminal;
  const claude = await cellClaudeEnv(deps);
  if (!claude) {
    return undefined;
  }
  const terminal = openCommandTerminal(name, cli, CLI_NAME, args, cwd, claude.env, undefined, true);
  deps.terminals.add(terminal);
  deps.provider.rereadCellsSoon();   // #2309 (l): the row shows the cell running without a Refresh
  if (claudeSignInHint(picked.choice, load.legacy === true, await deps.provider.versions.version(cli))) {
    void vscode.window.showInformationMessage(t.claudeSignIn);   // not awaited: it never blocks the start
  }
  return terminal;
}
