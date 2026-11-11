// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.5.0: "Run as cell in terminal" on a session in My sessions. Pick one of this computer's cells (or a new
// one), set two toggles, and a terminal in the session's folder runs
//   a4sx launch --cell <cell> [--mesh-reduced-isolation] [--auto-allow-ipc-messages] -- --resume <session id>
// for a session that is on this computer, or `… --a4sx-session=<id>` for one that is only in the library.
// "New cell…" runs `a4sx launch --new-cell [flags] …`: the browser approval then picks the mesh.
// 0.5.2: no flag picks a router or a launch profile. A cell with neither runs on this computer's Claude Code sign-in
// (the CLI's default since 0.26.5); when that is sure, one line says so as the terminal opens (claudeSignInHint).
// Every piece is an argv element, quoted for the user's shell (PowerShell, bash, …) by openCommandTerminal.
import * as vscode from "vscode";
import { CLI_NAME } from "./cli";
import { LaunchOptions, LocalCell, newCellRunArgs, ResumeTarget, runAsCellArgs, startableCell } from "./cells";
import { CELL_CMD_TEXTS, CellCommandDeps, cellTerminalEnv, consentReducedIsolation, ensureCli } from "./cellCommands";
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
  claudeSignIn: "Uses your Claude Code sign-in on this machine; run /login inside the cell if you have none.",
  keepSignIn: "Keep my sign-in (reduced isolation)",
  keepSignInDetail: "The cell runs as your user and can use the a4sx sign-ins and keys and the Claude Code sign-in saved on this computer.",
  autoAllow: "Deliver messages from mesh peers without asking",
  autoAllowDetail: "Off: you approve each message another session in the mesh sends to this one, unless ipc.auto_allow_messages is on in your a4sx config.",
  autoAllowFromConfig: "On in your a4sx config (ipc.auto_allow_messages): turning it off here doesn't change that. `a4sx config set ipc.auto_allow_messages false` does.",
  seedSignInTitle: "This session is only in your a4sx library. Keep your sign-in for this start?",
  seedSignInDetail:
    "The cell fetches the session from your library with your a4sx sign-in. Without \"Keep my sign-in\", the a4sx CLI refuses to start it.",
  seedSignInAccept: "Keep my sign-in and start",
  autoAllowTitle: "Deliver messages from mesh peers without asking?",
  autoAllowWarning:
    "Messages that other sessions in the mesh send to this cell will reach the agent without you approving each one. " +
    "A peer could use that to steer the agent. Turn this on only for a mesh whose members you trust.",
  autoAllowAccept: "Deliver without asking",
  badSession: "This session can't be started in a cell: its id isn't one the a4sx CLI accepts.",
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
 * Whether the cell surely runs on this computer's Claude Code sign-in, so the hint may say so: a new cell, or one
 * whose launch profile the CLI reported (its rows carry profiles: not `legacy`) as none after reading the server
 * (its registry state is known: `profile: null` with state "unknown" can mean the server part couldn't be read); a
 * CLI with that default (0.26.5+); and "Keep my sign-in" on (without it the CLI refuses the start in reduced isolation).
 */
export function claudeSignInHint(choice: CellChoice, legacy: boolean, cliVersion: string | undefined, o: LaunchOptions): boolean {
  const read = (c: LocalCell) => !legacy && c.registryState !== undefined && c.registryState !== "unknown";
  const noProfile = choice.kind === "new" || (read(choice.cell) && !choice.cell.launchProfile);
  return noProfile && o.reduced && cliVersion !== undefined && versionAtLeast(cliVersion, MIN_CLAUDE_SIGNIN_CLI);
}

/**
 * The two toggles; "Keep my sign-in" starts on, "Deliver … without asking" off (on, and saying so, when the
 * CLI's config already turns it on). undefined: Esc.
 */
export async function pickLaunchOptions(configAutoAllowOn = false): Promise<LaunchOptions | undefined> {
  const t = RUN_AS_CELL_TEXTS;
  const items = [
    { label: t.keepSignIn, description: "--mesh-reduced-isolation", detail: t.keepSignInDetail, picked: true, key: "reduced" as const },
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
  const o: LaunchOptions = { reduced: keys.has("reduced"), autoAllow: keys.has("autoAllow") };
  if (o.autoAllow) {
    const choice = await vscode.window.showWarningMessage(t.autoAllowTitle, { modal: true, detail: t.autoAllowWarning }, t.autoAllowAccept);
    if (choice !== t.autoAllowAccept) {
      return undefined;
    }
  }
  return o;
}

/** Run as cell in terminal. Resolves the terminal, or undefined when nothing was started (the user was told why). */
export async function runAsCell(deps: CellCommandDeps, session: RunAsCellSession | undefined): Promise<vscode.Terminal | undefined> {
  if (!session) {
    return undefined;
  }
  const t = RUN_AS_CELL_TEXTS;
  const cli = await ensureCli(deps);
  if (!cli) {
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
  const target: ResumeTarget = local ? { kind: "local", sessionId: local.sessionId } : { kind: "library", id: session.id };
  const picked = await vscode.window.showQuickPick(cellChoices(load.cells), { title: t.pickTitle, placeHolder: t.pickPlaceholder });
  if (!picked) {
    return undefined;
  }
  const options = await pickLaunchOptions(await readConfigAutoAllow(deps.run, cli));
  if (!options) {
    return undefined;
  }
  // A library-only session is seeded with the user's a4sx sign-in, which only "Keep my sign-in" keeps in the
  // cell (the CLI refuses otherwise: LAUNCH_TEXT_SEED_SIGNIN). Say so before anything starts.
  if (target.kind === "library" && !options.reduced) {
    const choice = await vscode.window.showWarningMessage(t.seedSignInTitle, { modal: true, detail: t.seedSignInDetail }, t.seedSignInAccept);
    if (choice !== t.seedSignInAccept) {
      return undefined;
    }
    options.reduced = true;
  }
  const args = picked.choice.kind === "cell" ? runAsCellArgs(picked.choice.cell, load.cells, options, target) : newCellRunArgs(options, target);
  if (!args) {
    await vscode.window.showErrorMessage(picked.choice.kind === "cell" ? CELL_CMD_TEXTS.badCell : t.badSession);
    return undefined;
  }
  if (options.reduced && !(await consentReducedIsolation(deps.state))) {
    return undefined;
  }
  // A session on this computer resumes in its own folder (Claude Code files it there); else the workspace's.
  const cwd = local ? local.cwd : await deps.folder();
  if (cwd === null) {
    return undefined;
  }
  const name = picked.choice.kind === "cell" ? CELL_CMD_TEXTS.cellTerminal(picked.choice.cell.name) : CELL_CMD_TEXTS.newCellTerminal;
  const terminal = openCommandTerminal(name, cli, CLI_NAME, args, cwd, cellTerminalEnv(deps.platform));
  deps.terminals.add(terminal);
  if (claudeSignInHint(picked.choice, load.legacy === true, await deps.provider.versions.version(cli), options)) {
    void vscode.window.showInformationMessage(t.claudeSignIn);   // not awaited: it never blocks the start
  }
  return terminal;
}
