// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.5.0: "Run as cell in terminal" on a session in My sessions. Pick one of this computer's cells (or a new
// one), set two toggles, and a terminal in the session's folder runs
//   a4sx launch --cell <cell> [--mesh-reduced-isolation] [--auto-allow-ipc-messages] -- --resume <session id>
// for a session that is on this computer, or `… --a4sx-session=<id>` for one that is only in the library.
// "New cell…" runs `a4sx launch --new-cell [flags] …`: the browser approval then picks the mesh and profile.
// Every piece is an argv element, quoted for the user's shell (PowerShell, bash, …) by openCommandTerminal.
import * as vscode from "vscode";
import { CLI_NAME } from "./cli";
import { LaunchOptions, LocalCell, newCellRunArgs, ResumeTarget, runAsCellArgs, startableCell } from "./cells";
import { CELL_CMD_TEXTS, CellCommandDeps, cellTerminalEnv, consentReducedIsolation, ensureCli } from "./cellCommands";
import { CELL_TEXTS, CMD_UPDATE_CLI } from "./cellsView";
import { LocalSession } from "./localSession";
import { openCommandTerminal } from "./resume";

export const RUN_AS_CELL_TEXTS = {
  pickTitle: "Run as cell in terminal",
  pickPlaceholder: "Choose the cell to run this session in",
  newCell: "$(add) New cell…",
  newCellDetail: "Approve it in your browser, where you pick its mesh and launch profile.",
  defaultMark: "default",
  noProfile: "no launch profile",
  optionsTitle: "Run as cell: options",
  optionsPlaceholder: "Choose the options for this start, then press Enter",
  keepSignIn: "Keep my sign-in (reduced isolation)",
  keepSignInDetail: "The cell runs as your user and can use the a4sx sign-ins and keys saved on this computer.",
  autoAllow: "Deliver messages from mesh peers without asking",
  autoAllowDetail: "Off: you approve each message another session in the mesh sends to this one.",
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

/** The two toggles; "Keep my sign-in" starts on, "Deliver … without asking" off. undefined: Esc. */
export async function pickLaunchOptions(): Promise<LaunchOptions | undefined> {
  const t = RUN_AS_CELL_TEXTS;
  const items = [
    { label: t.keepSignIn, description: "--mesh-reduced-isolation", detail: t.keepSignInDetail, picked: true, key: "reduced" as const },
    { label: t.autoAllow, description: "--auto-allow-ipc-messages", detail: t.autoAllowDetail, picked: false, key: "autoAllow" as const },
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
  const options = await pickLaunchOptions();
  if (!options) {
    return undefined;
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
  return terminal;
}
