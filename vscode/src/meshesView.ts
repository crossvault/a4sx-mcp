// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "Meshes" view: my meshes, and under each one my cells in it (grouped by machine when they
// come from more than one). Read-only, with the sidebar's library key and the mesh:read permission;
// every change opens the website. The view is hidden when the server has no meshes (GET /meshes is a
// 404); it offers "Allow mesh read" when the key lacks that permission, and "Open in browser" when the
// website must be visited first. The cells are read when the view is shown or a mesh is expanded, then
// every 30 s while it is visible. Loading, backoff and the probe live in meshApi.ts (MeshLoader).
import * as vscode from "vscode";
import { Client, MESSAGES } from "./api";
import {
  Cell, cellDescription, cellTooltip, isOnline, Machine, machineTooltip, MESH_TEXTS, MeshLoad, MeshLoader, MeshNode, meshTree, Timers,
} from "./meshApi";
import { stepUpAllowed } from "./stepUp";
import { MessageItem } from "./sessionsView";

export const MESH_CONTEXT = "a4sx.mesh";
export const ARCHIVED_MESH_CONTEXT = "a4sx.mesh.archived";
export const MESH_MACHINE_CONTEXT = "a4sx.meshMachine";
export const MESH_CELL_CONTEXT = "a4sx.meshCell";
export const CMD_REFRESH_MESHES = "a4sx.refreshMeshes";
export const CMD_OPEN_MESHES = "a4sx.openMeshesOnWeb";
export const CMD_CREATE_MESH = "a4sx.createMesh";
export const CMD_REDEEM_INVITE = "a4sx.redeemMeshInvite";
export const CMD_OPEN_MESH = "a4sx.openMeshOnWeb";
export const CMD_START_IN_MESH = "a4sx.startSessionInMesh";
/** The context key the view's `when` clause reads. */
export const MESHES_AVAILABLE = "a4sx.meshesAvailable";

export interface MeshTokenSource {
  token(): Promise<string | undefined>;
  clear(): Promise<void>;
}

const cellCount = (n: number) => (n === 1 ? "1 cell" : `${n} cells`);

export class MeshItem extends vscode.TreeItem {
  constructor(public readonly node: MeshNode, cellsKnown: boolean) {
    super(node.mesh.name ?? node.mesh.id, cellsKnown ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = `mesh:${node.mesh.id}`;
    const parts = [
      node.mesh.archived ? "archived" : undefined,
      node.groups === undefined ? undefined : node.cellCount ? `${cellCount(node.cellCount)} · ${node.onlineCount} online` : "no cells",
    ];
    this.description = parts.filter(Boolean).join(" · ");
    this.tooltip = [
      `Mesh: ${node.mesh.name ?? node.mesh.id}`,
      `ID: ${node.mesh.id}`,
      ...(node.mesh.role ? [`Role: ${node.mesh.role}`] : []),
      `Status: ${node.mesh.status}`,
      ...(node.mesh.memberCountBucket ? [`Members: ${node.mesh.memberCountBucket}`] : []),
      ...(node.mesh.archived ? [MESH_TEXTS.archived] : []),
    ].join("\n");
    this.contextValue = node.mesh.archived ? ARCHIVED_MESH_CONTEXT : MESH_CONTEXT;
    this.iconPath = new vscode.ThemeIcon(node.mesh.archived ? "archive" : "type-hierarchy");
  }
}

export class MachineItem extends vscode.TreeItem {
  constructor(public readonly meshId: string, public readonly machine: Machine, public readonly cells: Cell[]) {
    super(machine.label ?? machine.keyId, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `mesh:${meshId}/machine:${machine.keyId}`;
    this.description = cellCount(cells.length);
    this.tooltip = machineTooltip(machine, cells);
    this.contextValue = MESH_MACHINE_CONTEXT;
    this.iconPath = new vscode.ThemeIcon("vm");
  }
}

export function presenceIcon(c: Cell): vscode.ThemeIcon {
  if (isOnline(c)) {
    return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"));
  }
  if (c.presence === "idle" || c.presence === "away") {
    return new vscode.ThemeIcon("circle-large-outline");
  }
  return new vscode.ThemeIcon(c.presence === "offline" ? "circle-outline" : "question");
}

export class CellItem extends vscode.TreeItem {
  constructor(public readonly meshId: string, public readonly cell: Cell, machine: Machine, index: number, now: number) {
    super(cell.name ?? cell.instanceId ?? "cell", vscode.TreeItemCollapsibleState.None);
    this.id = `mesh:${meshId}/machine:${machine.keyId}/cell:${cell.instanceId ?? cell.name ?? index}`;
    this.description = cellDescription(cell, now);
    this.tooltip = cellTooltip(cell, machine, now);
    this.contextValue = MESH_CELL_CONTEXT;
    this.iconPath = presenceIcon(cell);
  }
}

export interface MeshesOptions {
  now?: () => number;
  timers?: Timers;
}

export class MeshesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly loader: MeshLoader;
  private readonly now: () => number;

  constructor(
    private readonly auth: MeshTokenSource,
    client: () => Client,
    onAvailable: (available: boolean) => void,
    opts: MeshesOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.loader = new MeshLoader({
      client,
      token: () => auth.token(),
      unauthorized: () => this.signedOut(),
      available: onAvailable,
      changed: () => this.changed.fire(),
      now: opts.now,
      timers: opts.timers,
    });
  }

  /** A 401, handled as the Sessions view does: the key is forgotten here, with one warning. */
  private async signedOut(): Promise<void> {
    if (!(await this.auth.token())) {
      return;   // already gone (another view saw the 401 first)
    }
    await this.auth.clear();
    void vscode.window.showWarningMessage(MESH_TEXTS.signedOut);
  }

  get load(): MeshLoad | undefined {
    return this.loader.load;
  }

  get available(): boolean {
    return this.loader.availability ?? false;
  }

  /** The startup probe (GET /meshes only); also after each sign-in and server change. */
  probe(): Promise<void> {
    return this.loader.probe();
  }

  /** Refresh: both routes, now. */
  refresh(): Promise<void> {
    return this.loader.full(true);
  }

  /** The visibility/poll tick. */
  tick(): Promise<void> {
    return this.loader.tick();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  private nodes(): MeshNode[] {
    const load = this.loader.load;
    if (load?.kind !== "ok") {
      return [];
    }
    return meshTree(load.meshes, Array.isArray(load.cells) ? load.cells : undefined);
  }

  async getChildren(parent?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (parent instanceof MeshItem) {
      await this.loader.ensureCells();   // the first expand reads the cells
      const node = this.nodes().find((n) => n.mesh.id === parent.node.mesh.id);
      if (!node?.groups) {
        return [];
      }
      if (node.groups.length === 0) {
        return node.mesh.archived ? [] : [new MessageItem(MESH_TEXTS.noCells, "terminal", { command: CMD_START_IN_MESH, title: "Start", arguments: [new MeshItem(node, true)] })];
      }
      const now = this.now();
      if (node.byMachine) {
        return node.groups.map((g) => new MachineItem(node.mesh.id, g.machine, g.cells));
      }
      return node.groups[0].cells.map((c, i) => new CellItem(node.mesh.id, c, node.groups![0].machine, i, now));
    }
    if (parent instanceof MachineItem) {
      const now = this.now();
      return parent.cells.map((c, i) => new CellItem(parent.meshId, c, parent.machine, i, now));
    }
    if (parent) {
      return [];
    }
    if (!this.loader.load) {
      await this.loader.probe();
    }
    const load = this.loader.load!;
    switch (load.kind) {
      case "signed-out":
      case "off":
        return [];
      case "needs-scope":
        if (!stepUpAllowed(load.scope)) {
          return [new MessageItem(MESSAGES.needsScope(load.scope), "info")];
        }
        return [new MessageItem(MESH_TEXTS.allowMeshRead, "key", { command: "a4sx.allowScope", title: MESH_TEXTS.allowMeshRead, arguments: [load.scope] })];
      case "needs-signin":
        return [
          new MessageItem(MESH_TEXTS.needsSignin, "info"),
          new MessageItem(MESH_TEXTS.openInBrowser, "link-external", { command: CMD_OPEN_MESHES, title: MESH_TEXTS.openInBrowser }),
        ];
      case "denied":
      case "error":
        return [new MessageItem(load.message, "error", { command: CMD_REFRESH_MESHES, title: "Refresh" })];
      case "ok": {
        const known = load.cells !== "unsupported";
        const items: vscode.TreeItem[] = load.cells === "unsupported" ? [new MessageItem(MESH_TEXTS.cellsNotYet, "info")] : [];
        const nodes = this.nodes();
        if (nodes.length === 0) {
          return [new MessageItem(MESH_TEXTS.noMeshes, "add", { command: CMD_CREATE_MESH, title: "Create" })];
        }
        return [...items, ...nodes.map((n) => new MeshItem(n, known))];
      }
    }
  }

  dispose(): void {
    this.loader.dispose();
    this.changed.dispose();
  }
}
