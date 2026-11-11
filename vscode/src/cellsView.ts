// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "Cells" view: the cells the a4sx CLI has stored on this machine, read from `a4sx mesh cells --json`
// (never from the CLI's files, never a key), grouped by mesh (0.5.0). Under each mesh, the cells on other
// machines come from `a4sx mesh peers <mesh> --json` (read-only, read when the group opens). The list is
// read when the view is first shown, on Refresh, after the view's own actions, when a terminal it started
// closes, and when the CLI's cell list changes. Without the CLI, the view is empty and its welcome text
// offers "Install a4sx CLI". An a4sx CLI older than 0.25.0 still lists its cells, under an "update" line.
import * as vscode from "vscode";
import { CELLS_LIST_ARGS, LocalCell, localCellDescription, localCellTooltip, startableCell } from "./cells";
import { CliGate, cliGate, IN_SESSION_MESSAGE, MeshPolicy, parseCellsAnswer, parseCliError, parseCliVersion, parsePeersAnswer, peersArgs, RemoteCell, VERSION_ARGS } from "./cliJson";
import { MessageItem } from "./sessionsView";

export const VIEW_CELLS = "a4sx.cells";
export const CMD_REFRESH_CELLS = "a4sx.refreshCells";
export const CMD_NEW_CELL = "a4sx.newCell";
export const CMD_START_CELL = "a4sx.startCell";
export const CMD_DEFAULT_CELL = "a4sx.setDefaultCell";
export const CMD_FORGET_CELL = "a4sx.forgetCell";
export const CMD_OPEN_CELL = "a4sx.openCellOnWeb";
export const CMD_STOP_CELL = "a4sx.stopCell";
export const CMD_RENAME_CELL = "a4sx.renameCell";
export const CMD_COPY_CELL_LAUNCH = "a4sx.copyCellLaunch";
export const CMD_SET_CELL_PROFILE = "a4sx.setCellProfile";
export const CMD_INSTALL_CLI = "a4sx.installCli";
export const CMD_UPDATE_CLI = "a4sx.updateCli";
/** Context keys the view's welcome texts read. */
export const CELLS_NO_CLI = "a4sx.cellsNoCli";
export const CELLS_EMPTY = "a4sx.cellsEmpty";

export const CELL_TEXTS = {
  listFailed: "Could not read the cells from the a4sx CLI.",
  tooOld: "This a4sx CLI can't list cells yet. Update it, then refresh.",
  olderCli: "Update a4sx to 0.25.0 or newer to see running cells, registry state and cells on other machines.",
  updateCli: "Update the a4sx CLI",
  remoteLocal: "The a4sx extension runs on this computer, but this window is remote. Install a4sx in the remote window to see its cells.",
  badConfig: "The a4sx.cliPath setting doesn't point to a program. Fix it or clear it.",
  openSettings: "Open settings",
  standaloneGroup: "Standalone (no mesh)",
  policy: (p: MeshPolicy | null | undefined) => `policy: ${p ?? "unknown"}`,
  meshCount: (n: number) => (n === 1 ? "1 cell here" : `${n} cells here`),
  onAnotherMachine: "on another machine",
  yoursOnAnotherMachine: "yours, on another machine",
  peersFailed: "Could not read the cells on other machines.",
  remoteTooltip: "On another machine: read-only here.",
  yoursRemoteTooltip: "Yours, on another machine: read-only here.",
};

/** The view's states: what getChildren shows. */
export type CellsLoad =
  | { kind: "ok"; cells: LocalCell[]; legacy?: boolean }
  | { kind: "no-cli" }
  | { kind: "bad-config" }
  | { kind: "remote-local" }
  | { kind: "in-session" }
  | { kind: "too-old" }
  | { kind: "error"; message?: string };

export interface CliOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Runs the CLI with an argv array (no shell); never rejects. */
export type CliRunner = (cli: string, args: readonly string[], timeoutMs?: number) => Promise<CliOutput>;
export type CliResolution = { kind: "found"; path: string } | { kind: "no-cli" } | { kind: "bad-config" } | { kind: "remote-local" } | { kind: "in-session" };

/** `a4sx --version` once per CLI path until cleared (Refresh, an update, a settings change). Never rejects. */
export class CliVersions {
  private readonly seen = new Map<string, Promise<string | undefined>>();
  constructor(private readonly run: CliRunner) {}

  /** The CLI's version ("0.26.5"), or undefined when it can't be read. */
  version(cli: string): Promise<string | undefined> {
    let v = this.seen.get(cli);
    if (!v) {
      v = this.run(cli, VERSION_ARGS, 15_000).then((out) => parseCliVersion(out.stdout), () => undefined);
      this.seen.set(cli, v);
    }
    return v;
  }

  gate(cli: string): Promise<CliGate> {
    return this.version(cli).then(cliGate);
  }

  clear(): void {
    this.seen.clear();
  }
}

export interface CellsDeps {
  resolve(): CliResolution;
  run: CliRunner;
  /** The configured server's origin (for the tooltip). */
  server(): string;
  onState(load: CellsLoad): void;
  /** The version gate (default: `a4sx --version` through `run`). */
  versions?: CliVersions;
}

export const CELL_CONTEXT = "a4sx.localCell";
export const MESH_GROUP_CONTEXT = "a4sx.cellMesh";
export const REMOTE_CELL_CONTEXT = "a4sx.remoteCell";

/** The item's contextValue: a4sx.localCell[.standalone][.default][.running][.legacy]. */
export function cellContext(cell: LocalCell, legacy = false): string {
  return `${CELL_CONTEXT}${startableCell(cell) ? "" : ".standalone"}${cell.isDefault ? ".default" : ""}${cell.localState === "running" ? ".running" : ""}${legacy ? ".legacy" : ""}`;
}

export class LocalCellItem extends vscode.TreeItem {
  constructor(public readonly cell: LocalCell, public readonly all: readonly LocalCell[], server: string, legacy = false) {
    super(cell.name, vscode.TreeItemCollapsibleState.None);
    this.id = `cell:${cell.meshId ?? "standalone"}/${cell.name}/${cell.instanceId}`;
    this.description = localCellDescription(cell, server, true);
    this.tooltip = localCellTooltip(cell, server);
    this.contextValue = cellContext(cell, legacy);
    this.iconPath = new vscode.ThemeIcon(cell.localState === "running" ? "debug-start" : cell.isDefault ? "star-full" : startableCell(cell) ? "terminal" : "circle-outline");
  }
}

/** One mesh (or "Standalone") with this computer's cells in it. */
export class MeshGroupItem extends vscode.TreeItem {
  constructor(public readonly meshId: string | undefined, public readonly cells: LocalCell[], public readonly all: readonly LocalCell[], public readonly legacy: boolean) {
    const first = cells[0];
    super(meshId ? first?.meshName ?? meshId : CELL_TEXTS.standaloneGroup, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `cellMesh:${meshId ?? "standalone"}`;
    const policy = meshId && !legacy ? CELL_TEXTS.policy(cells.find((c) => c.meshPolicy)?.meshPolicy ?? null) : undefined;
    this.description = [policy, CELL_TEXTS.meshCount(cells.length)].filter(Boolean).join(" · ");
    this.tooltip = [meshId ? `Mesh: ${first?.meshName ? `${first.meshName} (${meshId})` : meshId}` : CELL_TEXTS.standaloneGroup, policy].filter(Boolean).join("\n");
    this.contextValue = meshId ? MESH_GROUP_CONTEXT : `${MESH_GROUP_CONTEXT}.standalone`;
    this.iconPath = new vscode.ThemeIcon(meshId ? "type-hierarchy" : "circle-outline");
  }
}

/** A cell of the same mesh that isn't stored on this computer (yours or someone else's): read-only. */
export class RemoteCellItem extends vscode.TreeItem {
  constructor(public readonly meshId: string, public readonly peer: RemoteCell) {
    super(peer.name, vscode.TreeItemCollapsibleState.None);
    this.id = `remoteCell:${meshId}/${peer.instanceId}`;
    this.description = [peer.own ? CELL_TEXTS.yoursOnAnotherMachine : CELL_TEXTS.onAnotherMachine, peer.state, peer.tier].filter(Boolean).join(" · ");
    this.tooltip = [
      `Cell: ${peer.name}`, peer.own ? CELL_TEXTS.yoursRemoteTooltip : CELL_TEXTS.remoteTooltip, ...(peer.aid ? [`Address: ${peer.aid}`] : []), ...(peer.state ? [`State: ${peer.state}`] : []),
      ...(peer.tier ? [`Isolation: ${peer.tier}`] : []), `ID: ${peer.instanceId}`,
    ].join("\n");
    this.contextValue = REMOTE_CELL_CONTEXT;
    this.iconPath = new vscode.ThemeIcon(peer.own ? "vm-active" : "vm");
  }
}

/** True when argparse says the CLI has no `mesh cell profile` (an "invalid choice" for the cell subcommand). */
export function lacksCellProfile(out: CliOutput): boolean {
  return out.code !== 0 && /argument cell_cmd: invalid choice: '?profile'?/.test(out.stderr);
}

/** True when stderr says the CLI has no `mesh cells` (an argparse "invalid choice"). */
export function looksTooOld(out: CliOutput): boolean {
  return out.code !== 0 && /invalid choice|unrecognized arguments/.test(out.stderr);
}

/** The cells grouped by mesh: meshes by name, standalone last; the default first in each group. */
export function groupByMesh(cells: readonly LocalCell[]): { meshId: string | undefined; cells: LocalCell[] }[] {
  const groups = new Map<string, LocalCell[]>();
  for (const c of cells) {
    const k = c.meshId ?? "";
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const label = (k: string) => (k ? (groups.get(k)![0].meshName ?? k).toLowerCase() : "￿");
  return [...groups.keys()].sort((a, b) => label(a).localeCompare(label(b))).map((k) => ({
    meshId: k || undefined,
    cells: [...groups.get(k)!].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)),
  }));
}

type PeersLoad = { kind: "ok"; peers: RemoteCell[] } | { kind: "error" };

export class CellsProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  load: CellsLoad | undefined;
  private inflight: Promise<CellsLoad> | undefined;
  private peers = new Map<string, Promise<PeersLoad>>();
  readonly versions: CliVersions;

  constructor(private readonly deps: CellsDeps) {
    this.versions = deps.versions ?? new CliVersions(deps.run);
  }

  /** Reads the list now and redraws (one read at a time; a refresh during a read waits for it, then reads again). */
  async refresh(): Promise<CellsLoad> {
    if (this.inflight) {
      await this.inflight.catch(() => undefined);
    }
    this.peers = new Map();
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
    const gate = await this.versions.gate(cli.path);
    const out = await this.deps.run(cli.path, CELLS_LIST_ARGS, 30_000);
    if (looksTooOld(out)) {
      return { kind: "too-old" };
    }
    const answer = out.code === 0 ? parseCellsAnswer(out.stdout) : undefined;
    if (!answer) {
      const err = parseCliError(out.stdout);
      return err ? { kind: "error", message: err.message } : { kind: "error" };
    }
    return { kind: "ok", cells: answer.cells, legacy: answer.legacy || gate === "too-old" };
  }

  /** The cells as last read (for the commands' name checks). */
  get cells(): LocalCell[] {
    return this.load?.kind === "ok" ? this.load.cells : [];
  }

  /** True when the last read came from a CLI older than 0.25.0. */
  get legacy(): boolean {
    return this.load?.kind === "ok" && !!this.load.legacy;
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(parent?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (parent instanceof MeshGroupItem) {
      return this.groupChildren(parent);
    }
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
      case "in-session":
        return [new MessageItem(IN_SESSION_MESSAGE, "shield")];
      case "too-old":
        return [new MessageItem(CELL_TEXTS.tooOld, "warning", { command: CMD_UPDATE_CLI, title: CELL_TEXTS.updateCli })];
      case "error":
        return [
          new MessageItem(load.message ?? CELL_TEXTS.listFailed, "error", { command: CMD_REFRESH_CELLS, title: "Refresh" }),
          new MessageItem(CELL_TEXTS.updateCli, "cloud-download", { command: CMD_UPDATE_CLI, title: CELL_TEXTS.updateCli }),
        ];
      case "ok": {
        const legacy = !!load.legacy;
        const groups = groupByMesh(load.cells).map((g) => new MeshGroupItem(g.meshId, g.cells, load.cells, legacy));
        return legacy && load.cells.length ? [new MessageItem(CELL_TEXTS.olderCli, "warning", { command: CMD_UPDATE_CLI, title: CELL_TEXTS.updateCli }), ...groups] : groups;
      }
    }
  }

  private async groupChildren(group: MeshGroupItem): Promise<vscode.TreeItem[]> {
    const server = this.deps.server();
    const local: vscode.TreeItem[] = group.cells.map((c) => new LocalCellItem(c, group.all, server, group.legacy));
    if (!group.meshId || group.legacy) {
      return local;
    }
    const peers = await this.peersOf(group.meshId);
    if (peers.kind === "error") {
      return [...local, new MessageItem(CELL_TEXTS.peersFailed, "warning")];
    }
    // `own` is the caller's account, not this computer: a cell stored here is already listed above.
    const here = new Set(group.all.map((c) => c.instanceId));
    const elsewhere = peers.peers.filter((p) => !here.has(p.instanceId)).sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name));
    return [...local, ...elsewhere.map((p) => new RemoteCellItem(group.meshId!, p))];
  }

  private peersOf(meshId: string): Promise<PeersLoad> {
    let p = this.peers.get(meshId);
    if (!p) {
      p = this.readPeers(meshId);
      this.peers.set(meshId, p);
    }
    return p;
  }

  private async readPeers(meshId: string): Promise<PeersLoad> {
    const cli = this.deps.resolve();
    const args = peersArgs(meshId);
    if (cli.kind !== "found" || !args) {
      return { kind: "error" };
    }
    const out = await this.deps.run(cli.path, args, 30_000);
    const peers = out.code === 0 ? parsePeersAnswer(out.stdout, meshId) : undefined;
    return peers ? { kind: "ok", peers } : { kind: "error" };
  }

  dispose(): void {
    this.changed.dispose();
  }
}
