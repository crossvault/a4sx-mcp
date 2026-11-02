// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "Cells" view: the cells the a4sx CLI has stored on this machine, read from `a4sx mesh cells --json`
// (never from the CLI's files, never a key). The list is read when the view is first shown, on Refresh,
// after the view's own actions, when a terminal it started closes, and when the CLI's cell list changes.
// Without the CLI, the view is empty and its welcome text offers "Install a4sx CLI".
import * as vscode from "vscode";
import { CELLS_LIST_ARGS, LocalCell, localCellDescription, localCellTooltip, parseCellsJson, startableCell } from "./cells";
import { MessageItem } from "./sessionsView";

export const VIEW_CELLS = "a4sx.cells";
export const CMD_REFRESH_CELLS = "a4sx.refreshCells";
export const CMD_NEW_CELL = "a4sx.newCell";
export const CMD_START_CELL = "a4sx.startCell";
export const CMD_DEFAULT_CELL = "a4sx.setDefaultCell";
export const CMD_FORGET_CELL = "a4sx.forgetCell";
export const CMD_OPEN_CELL = "a4sx.openCellOnWeb";
export const CMD_INSTALL_CLI = "a4sx.installCli";
export const CMD_UPDATE_CLI = "a4sx.updateCli";
/** Context keys the view's welcome texts read. */
export const CELLS_NO_CLI = "a4sx.cellsNoCli";
export const CELLS_EMPTY = "a4sx.cellsEmpty";

export const CELL_TEXTS = {
  listFailed: "Could not read the cells from the a4sx CLI.",
  tooOld: "This a4sx CLI can't list cells yet. Update it, then refresh.",
  updateCli: "Update the a4sx CLI",
  remoteLocal: "The a4sx extension runs on this computer, but this window is remote. Install a4sx in the remote window to see its cells.",
  badConfig: "The a4sx.cliPath setting doesn't point to a program. Fix it or clear it.",
  openSettings: "Open settings",
};

/** The view's states: what getChildren shows. */
export type CellsLoad =
  | { kind: "ok"; cells: LocalCell[] }
  | { kind: "no-cli" }
  | { kind: "bad-config" }
  | { kind: "remote-local" }
  | { kind: "too-old" }
  | { kind: "error" };

export interface CliOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Runs the CLI with an argv array (no shell); never rejects. */
export type CliRunner = (cli: string, args: readonly string[], timeoutMs?: number) => Promise<CliOutput>;
export type CliResolution = { kind: "found"; path: string } | { kind: "no-cli" } | { kind: "bad-config" } | { kind: "remote-local" };

export interface CellsDeps {
  resolve(): CliResolution;
  run: CliRunner;
  /** The configured server's origin (for the tooltip). */
  server(): string;
  onState(load: CellsLoad): void;
}

export const CELL_CONTEXT = "a4sx.localCell";

/** The item's contextValue: a4sx.localCell[.standalone][.default]. */
export function cellContext(cell: LocalCell): string {
  return `${CELL_CONTEXT}${startableCell(cell) ? "" : ".standalone"}${cell.isDefault ? ".default" : ""}`;
}

export class LocalCellItem extends vscode.TreeItem {
  constructor(public readonly cell: LocalCell, public readonly all: readonly LocalCell[], server: string) {
    super(cell.name, vscode.TreeItemCollapsibleState.None);
    this.id = `cell:${cell.meshId ?? "standalone"}/${cell.name}/${cell.instanceId}`;
    this.description = localCellDescription(cell, server);
    this.tooltip = localCellTooltip(cell, server);
    this.contextValue = cellContext(cell);
    this.iconPath = new vscode.ThemeIcon(cell.isDefault ? "star-full" : startableCell(cell) ? "terminal" : "circle-outline");
  }
}

/** True when stderr says the CLI has no `mesh cells` (an argparse "invalid choice"). */
export function looksTooOld(out: CliOutput): boolean {
  return out.code !== 0 && /invalid choice|unrecognized arguments/.test(out.stderr);
}

export class CellsProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  load: CellsLoad | undefined;
  private inflight: Promise<CellsLoad> | undefined;

  constructor(private readonly deps: CellsDeps) {}

  /** Reads the list now and redraws (one read at a time; a refresh during a read waits for it, then reads again). */
  async refresh(): Promise<CellsLoad> {
    if (this.inflight) {
      await this.inflight.catch(() => undefined);
    }
    this.inflight = this.read();
    try {
      this.load = await this.inflight;
    } finally {
      this.inflight = undefined;
    }
    this.deps.onState(this.load);
    this.changed.fire();
    return this.load;
  }

  private async read(): Promise<CellsLoad> {
    const cli = this.deps.resolve();
    if (cli.kind !== "found") {
      return cli;
    }
    const out = await this.deps.run(cli.path, CELLS_LIST_ARGS, 30_000);
    if (looksTooOld(out)) {
      return { kind: "too-old" };
    }
    const cells = out.code === 0 ? parseCellsJson(out.stdout) : undefined;
    return cells ? { kind: "ok", cells } : { kind: "error" };
  }

  /** The cells as last read (for the commands' name checks). */
  get cells(): LocalCell[] {
    return this.load?.kind === "ok" ? this.load.cells : [];
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(parent?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (parent) {
      return [];
    }
    const load = this.load ?? (await this.refresh());
    switch (load.kind) {
      case "no-cli":
        return [];   // the welcome text offers the install
      case "bad-config":
        return [new MessageItem(CELL_TEXTS.badConfig, "error", { command: "workbench.action.openSettings", title: CELL_TEXTS.openSettings, arguments: ["a4sx.cliPath"] })];
      case "remote-local":
        return [new MessageItem(CELL_TEXTS.remoteLocal, "info")];
      case "too-old":
        return [new MessageItem(CELL_TEXTS.tooOld, "warning", { command: CMD_UPDATE_CLI, title: CELL_TEXTS.updateCli })];
      case "error":
        return [
          new MessageItem(CELL_TEXTS.listFailed, "error", { command: CMD_REFRESH_CELLS, title: "Refresh" }),
          new MessageItem(CELL_TEXTS.updateCli, "cloud-download", { command: CMD_UPDATE_CLI, title: CELL_TEXTS.updateCli }),
        ];
      case "ok": {
        const server = this.deps.server();
        // The default first, then by name (the CLI's order).
        const sorted = [...load.cells].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
        return sorted.map((c) => new LocalCellItem(c, load.cells, server));
      }
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}
