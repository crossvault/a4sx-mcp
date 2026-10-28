// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "Meshes" view: my meshes, and under each one my cells in it (grouped by machine when they
// come from more than one). Read-only, with the sidebar's library key and the mesh:read permission;
// every change opens the website. The view is hidden when the server has no meshes (a 404); it offers
// "Allow mesh read" when the key lacks that permission, and "Open in browser" when the website must be
// visited first. It polls every 30 s while it is visible.
import * as vscode from "vscode";
import { Client, MESSAGES } from "./api";
import {
  Cell, cellDescription, cellTooltip, isOnline, loadMeshes, Machine, machineTooltip, MESH_TEXTS, MeshLoad, MeshNode, meshTree, viewAvailable,
} from "./meshApi";
import { stepUpAllowed } from "./stepUp";
import { MessageItem } from "./sessionsView";

export const MESH_CONTEXT = "a4sx.mesh";
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
}

const cellCount = (n: number) => (n === 1 ? "1 cell" : `${n} cells`);

export class MeshItem extends vscode.TreeItem {
  constructor(public readonly node: MeshNode) {
    super(node.mesh.name ?? node.mesh.id, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `mesh:${node.mesh.id}`;
    this.description = node.cellCount ? `${cellCount(node.cellCount)} · ${node.onlineCount} online` : "no cells";
    this.tooltip = [`Mesh: ${node.mesh.name ?? node.mesh.id}`, `ID: ${node.mesh.id}`, ...(node.mesh.role ? [`Role: ${node.mesh.role}`] : [])].join("\n");
    this.contextValue = MESH_CONTEXT;
    this.iconPath = new vscode.ThemeIcon("type-hierarchy");
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
  return new vscode.ThemeIcon(c.presence ? "circle-outline" : "question");
}

export class CellItem extends vscode.TreeItem {
  constructor(public readonly meshId: string, public readonly cell: Cell, machine: Machine, index: number, now: number) {
    super(cell.name ?? cell.instance ?? "cell", vscode.TreeItemCollapsibleState.None);
    this.id = `mesh:${meshId}/machine:${machine.keyId}/cell:${cell.instance ?? cell.name ?? index}`;
    this.description = cellDescription(cell, now);
    this.tooltip = cellTooltip(cell, machine, now);
    this.contextValue = MESH_CELL_CONTEXT;
    this.iconPath = presenceIcon(cell);
  }
}

export class MeshesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  /** The last answer; the tree is drawn from it. */
  load: MeshLoad | undefined;
  available = false;
  private inflight: Promise<MeshLoad> | undefined;

  constructor(
    private readonly auth: MeshTokenSource,
    private readonly client: () => Client,
    private readonly onAvailable: (available: boolean) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Reads both routes again (one read at a time), updates the context key and redraws. */
  reload(): Promise<MeshLoad> {
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const load = await loadMeshes(this.client, await this.auth.token());
          this.load = load;
          this.available = viewAvailable(load, this.available);
          this.onAvailable(this.available);
          this.changed.fire();
          return load;
        } finally {
          this.inflight = undefined;
        }
      })();
    }
    return this.inflight;
  }

  /** The meshes of the last answer (for the commands). */
  nodes(): MeshNode[] {
    return this.load?.kind === "ok" ? meshTree(this.load.meshes, this.load.machines) : [];
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(parent?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (parent instanceof MeshItem) {
      const node = parent.node;
      if (node.groups.length === 0) {
        return [new MessageItem(MESH_TEXTS.noCells, "terminal", { command: CMD_START_IN_MESH, title: "Start", arguments: [parent] })];
      }
      if (node.byMachine) {
        return node.groups.map((g) => new MachineItem(node.mesh.id, g.machine, g.cells));
      }
      const now = this.now();
      return node.groups[0].cells.map((c, i) => new CellItem(node.mesh.id, c, node.groups[0].machine, i, now));
    }
    if (parent instanceof MachineItem) {
      const now = this.now();
      return parent.cells.map((c, i) => new CellItem(parent.meshId, c, parent.machine, i, now));
    }
    if (parent) {
      return [];
    }
    const load = this.load ?? await this.reload();
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
      case "error":
        return [new MessageItem(load.message, "error", { command: CMD_REFRESH_MESHES, title: "Refresh" })];
      case "ok": {
        const nodes = meshTree(load.meshes, load.machines);
        if (nodes.length === 0) {
          return [new MessageItem(MESH_TEXTS.noMeshes, "add", { command: CMD_CREATE_MESH, title: "Create" })];
        }
        return nodes.map((n) => new MeshItem(n));
      }
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}
