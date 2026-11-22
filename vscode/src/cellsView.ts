// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The "Cells" view: the cells the a4sx CLI has stored on this machine, read from `a4sx mesh cells --json`
// (never from the CLI's files, never a key), grouped by mesh (0.5.0). Under each mesh, the cells on other
// machines come from `a4sx mesh peers <mesh> --json` (read-only, read when the group opens). The list is
// read when the view is first shown, on Refresh, after the view's own actions, when a terminal it started
// closes, and when the CLI's cell list changes. Without the CLI, the view is empty and its welcome text
// offers "Install a4sx CLI". An a4sx CLI older than 0.25.0 still lists its cells, under an "update" line.
import * as vscode from "vscode";
import { BUSY_BACKOFF_MS, BusyRetry } from "./busyRetry";
import { CELLS_LIST_ARGS, LocalCell, localCellDescription, localCellTooltip, showText, startableCell } from "./cells";
import { CliGate, cliGate, IN_SESSION_MESSAGE, MeshPolicy, parseCellsAnswer, parseCliError, parseCliVersion, parsePeersAnswer, peerPresence, peersArgs, RemoteCell, VERSION_ARGS } from "./cliJson";
import { MessageItem } from "./sessionsView";
import { AGENT_HOST_STATUS_ARGS, AGENT_HOST_TEXTS, AgentHostStatus, agentsWindowSetUp, isOpen, lacksAgentHost, isBefore, parseAgentHostStatus, shortTime } from "./agentHostStatus";

export const VIEW_CELLS = "a4sx.cells";
export const CMD_REFRESH_CELLS = "a4sx.refreshCells";
export const CMD_NEW_CELL = "a4sx.newCell";
export const CMD_START_CELL_HERE = "a4sx.startCellHere";
/** #2309 review: the one extra cell-list read after a host change. */
export const CELLS_REREAD_AFTER_MS = 5_000;
/**
 * #2309 (l), cell01: a cell this view started in a terminal stayed "stored" until a Refresh: its start changes no file
 * the view watches, and the CLI records that it runs only once the launch is up. The cell list is read again a few
 * times after such a start (the launch's sign-in and Claude Code's start take a few seconds to half a minute).
 */
export const CELLS_LAUNCH_REREADS_MS: readonly number[] = [4_000, 12_000, 30_000];
export const CMD_START_AGENT_HOST = "a4sx.startAgentHost";
export const CMD_SETUP_AGENTS_WINDOW = "a4sx.setupAgentsWindow";
export const CMD_STOP_AGENT_HOST = "a4sx.stopAgentHost";
export const THIS_COMPUTER_CONTEXT = "a4sx.thisComputer";
export const CMD_START_CELL = "a4sx.startCell";
export const CMD_DEFAULT_CELL = "a4sx.setDefaultCell";
export const CMD_FORGET_CELL = "a4sx.forgetCell";
export const CMD_OPEN_CELL = "a4sx.openCellOnWeb";
export const CMD_STOP_CELL = "a4sx.stopCell";
export const CMD_RENAME_CELL = "a4sx.renameCell";
export const CMD_COPY_CELL_LAUNCH = "a4sx.copyCellLaunch";
export const CMD_SET_CELL_PROFILE = "a4sx.setCellProfile";
export const CMD_OPEN_CELL_POLICY = "a4sx.openCellPolicy";
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
  yoursRemoteTooltip: "Yours, on another machine. Start on this computer moves it here once it no longer runs there.",
  othersLabel: "Other members' cells",
  othersCount: (n: number, online: number) => `${n} on other machines${online ? ` · ${online} online` : ""}`,
  othersTooltip: "The cells of this mesh's other members, on their machines: read-only here. Your own cells on other machines stay listed above.",
};

/**
 * cell01 (#2301, the looks): a row's state at a glance, as its icon's colour. Only VS Code's own theme colours, so
 * every theme (and high contrast) decides how they look; the words in the description stay as they are.
 */
export const CELL_ICON_COLORS = { running: "charts.green", open: "charts.blue", attention: "charts.yellow", away: "disabledForeground" } as const;

function themed(id: string, color?: string): vscode.ThemeIcon {
  return color ? new vscode.ThemeIcon(id, new vscode.ThemeColor(color)) : new vscode.ThemeIcon(id);
}

/**
 * A stored cell's icon: open in the Agents window (blue), running here (green), waiting for an admin or stored twice
 * (yellow), else the plain one. The registry's word alone never colours a row: a cell of another account reads
 * "revoked" for the signed-in one and still works.
 */
export function localCellIcon(cell: LocalCell, open = false): vscode.ThemeIcon {
  if (open) {
    return themed("comment-discussion", CELL_ICON_COLORS.open);
  }
  if (cell.localState === "running") {
    return themed("debug-start", CELL_ICON_COLORS.running);
  }
  return themed(cell.isDefault ? "star-full" : startableCell(cell) ? "terminal" : "circle-outline",
    cell.needsApproval || cell.duplicate ? CELL_ICON_COLORS.attention : undefined);
}

/** A cell on another machine: yours or not by the shape, online (green) or offline (dimmed) by the colour. */
export function remoteCellIcon(peer: Pick<RemoteCell, "own" | "state" | "presence">): vscode.ThemeIcon {
  const now = peerPresence(peer);
  return themed(peer.own ? "vm-active" : "vm", now === "online" ? CELL_ICON_COLORS.running : now === "offline" ? CELL_ICON_COLORS.away : undefined);
}

/** More other members' cells than this in one mesh are folded into one row (your own cells elsewhere never are). */
export const FOLD_OTHERS_ABOVE = 3;

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

/**
 * #2309 review: whether a failed `mesh peers --json` looks temporary (the server busy or unreachable, a timeout), so
 * it is worth reading again by itself; a refusal (not a member, no such mesh, an older CLI) isn't.
 */
export function peersErrorLooksTemporary(out: CliOutput): boolean {
  const code = parseCliError(out.stdout)?.code ?? "";
  if (/not_member|forbidden|no_such|unknown_mesh|unauthorized|revoked|invalid/i.test(code) || /invalid choice/i.test(out.stderr)) {
    return false;
  }
  return out.code === null || !code || /busy|rate|unavailable|warm|timeout|unreachable|503|502|504|429/i.test(code + " " + out.stderr);
}

/** `a4sx --version` once per CLI path until cleared (Refresh, an update, a settings change). Never rejects. */
export class CliVersions {
  private readonly seen = new Map<string, Promise<string | undefined>>();
  private readonly stop = new Map<string, Promise<boolean>>();
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

  /** Review of #43: whether the CLI has `agent-host stop` (`agent-host stop --help` answers 0); once per path until cleared. */
  canStopHost(cli: string): Promise<boolean> {
    let p = this.stop.get(cli);
    if (!p) {
      p = this.run(cli, ["agent-host", "stop", "--help"], 15_000).then((o) => o.code === 0, () => false);
      this.stop.set(cli, p);
    }
    return p;
  }

  clear(): void {
    this.seen.clear();
    this.stop.clear();
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
/** #2301 E1: one of your own cells on another computer: it can be started here. */
export const REMOTE_OWN_CELL_CONTEXT = "a4sx.remoteCell.own";

/**
 * The item's contextValue: a4sx.localCell[.standalone][.default][.running][.legacy][.policy]. `.policy` (0.7.0): the
 * CLI gave a Policy tab URL that passed cells.policyUrl, so "Open policy in browser" is offered.
 */
export function cellContext(cell: LocalCell, legacy = false): string {
  return `${CELL_CONTEXT}${startableCell(cell) ? "" : ".standalone"}${cell.isDefault ? ".default" : ""}${cell.localState === "running" ? ".running" : ""}${legacy ? ".legacy" : ""}${!legacy && cell.policy?.url ? ".policy" : ""}`;
}

export class LocalCellItem extends vscode.TreeItem {
  constructor(public readonly cell: LocalCell, public readonly all: readonly LocalCell[], server: string, legacy = false) {
    super(cell.name, vscode.TreeItemCollapsibleState.None);
    this.id = `cell:${cell.meshId ?? "standalone"}/${cell.name}/${cell.instanceId}`;
    this.description = localCellDescription(cell, server, true);
    this.tooltip = localCellTooltip(cell, server);
    this.contextValue = cellContext(cell, legacy);
    this.iconPath = localCellIcon(cell);
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
/** The CLI's last stderr line, made safe to show. */
function cliLastLine(stderr: string): string | undefined {
  const line = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  return showText(line?.replace(/^a4sx:\s*/, ""), 200);
}

/** #2301 E2: the agent host on this computer, above the meshes. */
export class ThisComputerItem extends vscode.TreeItem {
  constructor() {
    super(AGENT_HOST_TEXTS.node, vscode.TreeItemCollapsibleState.Expanded);
    this.id = "thisComputer";
    this.contextValue = THIS_COMPUTER_CONTEXT;
    this.iconPath = new vscode.ThemeIcon("vm");
  }
}

/**
 * The rows under This computer. a4sx #2309 (p), cell01: the cell rows below shifted by one whenever this node gained
 * or lost a row (a Stop that came and went, an error row), so a click right after a Refresh could land on the wrong
 * cell. It is always exactly two rows now: the state (an unclean end in its label; the last error in its description,
 * the whole text in its tooltip), and the one action that applies.
 */
export function thisComputerChildren(host: AgentHostStatus, cliCanStop = false): vscode.TreeItem[] {
  const unclean = !host.running && !!host.startedAt && !host.stoppedAt && !host.endedWhy;   // a restart, a kill
  const label = host.running && host.address ? AGENT_HOST_TEXTS.running(host.address)
    : host.endedWhy === "terminal closed" ? AGENT_HOST_TEXTS.endedClosed
      : unclean ? AGENT_HOST_TEXTS.uncleanEnd : AGENT_HOST_TEXTS.stopped;
  const state = new MessageItem(label, host.running ? "pass" : unclean ? "debug-disconnect" : "circle-slash");
  if (host.running) {
    state.iconPath = themed("pass", CELL_ICON_COLORS.running);
  } else if (unclean) {
    state.iconPath = themed("debug-disconnect", CELL_ICON_COLORS.attention);
  }
  const tips = [host.running && host.address ? AGENT_HOST_TEXTS.runningTooltip(host.address) : AGENT_HOST_TEXTS.stoppedTooltip];
  if (unclean) {
    tips.push(AGENT_HOST_TEXTS.uncleanEndTooltip(host.startedAt));
  }
  if (host.lastError) {
    const at = shortTime(host.lastError.at);
    // cell01: an error from before a start that then ran is stale: named so
    const stale = host.running && isBefore(host.lastError.at, host.startedAt);
    state.description = stale ? AGENT_HOST_TEXTS.earlierError(host.lastError.text, at) : AGENT_HOST_TEXTS.lastError(host.lastError.text, at);
    tips.push(stale ? AGENT_HOST_TEXTS.earlierErrorTooltip(host.lastError.text, host.lastError.at)
      : AGENT_HOST_TEXTS.lastErrorTooltip(host.lastError.text, host.lastError.at));
    if (!stale && !unclean) {   // review: a fresh error stands out, also while the host runs (its row was yellow)
      state.iconPath = themed("warning", CELL_ICON_COLORS.attention);
    }
  }
  state.tooltip = tips.join("\n\n");
  return [state, thisComputerAction(host, cliCanStop)];
}

/** #2309 (p): the one action row under This computer: Set up (it starts the host too), else Stop, else Start. */
function thisComputerAction(host: AgentHostStatus, cliCanStop: boolean): vscode.TreeItem {
  if (!agentsWindowSetUp(host)) {
    const setup = new MessageItem(AGENT_HOST_TEXTS.setup, "settings-gear", { command: CMD_SETUP_AGENTS_WINDOW, title: AGENT_HOST_TEXTS.setup });
    setup.tooltip = AGENT_HOST_TEXTS.setupTooltip;
    return setup;
  }
  if (!host.running) {
    return new MessageItem(AGENT_HOST_TEXTS.start, "play", { command: CMD_START_AGENT_HOST, title: AGENT_HOST_TEXTS.start });
  }
  // review of #43: a CLI that doesn't report the field yet (#2326 without #2338) but has `agent-host stop` can stop it
  if ((host.stopRequest ?? (cliCanStop ? 1 : 0)) < 1) {
    // #2309 F2: greyed, no action, the reason in the tooltip; by the host's own capability, not a version number
    const old = new MessageItem(AGENT_HOST_TEXTS.stopOld, "debug-stop");
    old.iconPath = themed("debug-stop", "disabledForeground");
    old.tooltip = AGENT_HOST_TEXTS.stopOldTooltip;
    return old;
  }
  const stop = new MessageItem(AGENT_HOST_TEXTS.stop, "debug-stop", { command: CMD_STOP_AGENT_HOST, title: AGENT_HOST_TEXTS.stop });
  stop.tooltip = AGENT_HOST_TEXTS.stopTooltip;
  return stop;
}

export class RemoteCellItem extends vscode.TreeItem {
  constructor(public readonly meshId: string, public readonly peer: RemoteCell) {
    super(peer.name, vscode.TreeItemCollapsibleState.None);
    this.id = `remoteCell:${meshId}/${peer.instanceId}`;
    // cell01: connected now or not comes first (the registry's word and the isolation follow)
    this.description = [peer.own ? CELL_TEXTS.yoursOnAnotherMachine : CELL_TEXTS.onAnotherMachine, peer.presence, peer.state, peer.tier].filter(Boolean).join(" · ");
    this.tooltip = [
      `Cell: ${peer.name}`, peer.own ? CELL_TEXTS.yoursRemoteTooltip : CELL_TEXTS.remoteTooltip, ...(peer.aid ? [`Address: ${peer.aid}`] : []), ...(peer.presence ? [`Now: ${peer.presence}`] : []), ...(peer.state ? [`State: ${peer.state}`] : []),
      ...(peer.tier ? [`Isolation: ${peer.tier}`] : []), `ID: ${peer.instanceId}`,
    ].join("\n");
    this.contextValue = peer.own ? REMOTE_OWN_CELL_CONTEXT : REMOTE_CELL_CONTEXT;
    this.iconPath = remoteCellIcon(peer);
  }
}

export const OTHER_CELLS_CONTEXT = "a4sx.otherCells";

/** cell01 (#2301, the looks): the other members' cells of one mesh, folded into one row that opens on a click. */
export class OtherCellsItem extends vscode.TreeItem {
  constructor(public readonly meshId: string, public readonly peers: readonly RemoteCell[]) {
    super(CELL_TEXTS.othersLabel, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `otherCells:${meshId}`;
    this.description = CELL_TEXTS.othersCount(peers.length, peers.filter((p) => peerPresence(p) === "online").length);
    this.tooltip = CELL_TEXTS.othersTooltip;
    this.contextValue = OTHER_CELLS_CONTEXT;
    this.iconPath = new vscode.ThemeIcon("organization");
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
  /**
   * #2309 (cell01, a deploy window): "Could not read the cells on other machines" stayed until a Refresh. A failed read
   * stays cached (redraws don't read again), and its own mesh's timer reads it again with a back-off (5 s … 60 s, at
   * most 10 times; only errors that look temporary); the row goes once a read works. Review: one retry per mesh.
   */
  readonly peersRetry = new Map<string, BusyRetry>();
  load: CellsLoad | undefined;
  private inflight: Promise<CellsLoad> | undefined;
  private peers = new Map<string, Promise<PeersLoad>>();
  /** #2301 E2: the agent host's status, read once per refresh when This computer's rows are asked for. */
  private host: Promise<AgentHostStatus | { failed: string } | undefined> | undefined;
  /** #35 review: the delayed re-reads still to come (cleared on dispose), and their delay (tests shorten it). */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** #2309 (l): the pending re-reads after a cell start from here (also in `timers`); a new start replaces them. */
  private readonly launchTimers = new Set<ReturnType<typeof setTimeout>>();
  rereadAfterMs = CELLS_REREAD_AFTER_MS;
  /** #2309: the last host state seen (running and the open set), across refreshes: a change re-reads the cells. */
  private hostKey: string | undefined;
  private hostSeen: AgentHostStatus | undefined;
  /** cell01 (the status bar): fires when the cells were read again or the agent host's status became known. */
  private readonly summaryChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeSummary = this.summaryChanged.event;
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
    this.peersRetry.forEach((r) => r.dispose());   // review: a Refresh starts clean, no old timer drops a fresh result
    this.peersRetry.clear();
    this.host = undefined;
    this.hostSeen = undefined;
    this.inflight = this.read();
    try {
      this.load = await this.inflight;
    } finally {
      this.inflight = undefined;
    }
    this.deps.onState(this.load);
    this.changed.fire();
    this.summaryChanged.fire();
    return this.load;
  }

  /** Whether this CLI has `agent-host stop` (CliVersions.canStopHost). */
  cliCanStopHost(): Promise<boolean> {
    const cli = this.deps.resolve();
    return cli.kind === "found" ? this.versions.canStopHost(cli.path) : Promise.resolve(false);
  }

  /** The agent host's status as last read for This computer's rows (undefined: not read since the last refresh). */
  get hostKnown(): AgentHostStatus | undefined {
    return this.hostSeen;
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
    if (parent instanceof OtherCellsItem) {
      return parent.peers.map((p) => new RemoteCellItem(parent.meshId, p));
    }
    if (parent instanceof ThisComputerItem) {
      const host = await this.hostStatus();
      // #2309 (p): two rows in every state, so the cell rows below never move when this one changes
      return !host ? [new MessageItem(AGENT_HOST_TEXTS.unknown, "question"),
        new MessageItem(CELL_TEXTS.updateCli, "cloud-download", { command: CMD_UPDATE_CLI, title: CELL_TEXTS.updateCli })]
        : "failed" in host ? [new MessageItem(AGENT_HOST_TEXTS.failed(host.failed), "warning"),
          new MessageItem(AGENT_HOST_TEXTS.readAgain, "refresh", { command: CMD_REFRESH_CELLS, title: AGENT_HOST_TEXTS.readAgain })]
          : thisComputerChildren(host, host.stopRequest === undefined && host.running ? await this.cliCanStopHost() : false);
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
        const groups: vscode.TreeItem[] = groupByMesh(load.cells).map((g) => new MeshGroupItem(g.meshId, g.cells, load.cells, legacy));
        if (legacy) {
          return load.cells.length ? [new MessageItem(CELL_TEXTS.olderCli, "warning", { command: CMD_UPDATE_CLI, title: CELL_TEXTS.updateCli }), ...groups] : groups;
        }
        // #2301 E2: the agent host, above the meshes (with no cells, the welcome text stays)
        return load.cells.length ? [new ThisComputerItem(), ...groups] : groups;
      }
    }
  }

  /**
   * cell01: the host can stop without the view knowing (Ctrl+C in its terminal). While the Cells view is visible and
   * VS Code has focus, the status (a local `agent-host status --json`, no server call) is read again every
   * HOST_POLL_MS, and once when the window gets focus. Only This computer's rows and the open marks change.
   */
  rereadHostNow(): void {
    if (this.load?.kind === "ok" && this.load.cells.length && !this.load.legacy) {
      this.host = undefined;
      this.changed.fire();
    }
  }

  /**
   * #2309 (l): after a cell start in a terminal from here, the cell list is read again a few times, keeping the host
   * status it had (no open-mark flicker). Cancelled on dispose, like the other delayed reads.
   */
  rereadCellsSoon(delays: readonly number[] = CELLS_LAUNCH_REREADS_MS): void {
    // review: a second start replaces the first one's re-reads (each refresh also reads the other machines again)
    this.launchTimers.forEach((t) => {
      clearTimeout(t);
      this.timers.delete(t);
    });
    this.launchTimers.clear();
    for (const ms of delays) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.launchTimers.delete(t);
        const keep = this.hostSeen;
        void this.refresh().then(() => {
          if (!this.hostSeen && keep) {
            this.hostSeen = keep;
            this.changed.fire();
            this.summaryChanged.fire();
          }
        }, () => undefined);
      }, ms);
      t.unref?.();
      this.timers.add(t);
      this.launchTimers.add(t);
    }
  }

  /**
   * cell01: after Start agent host (or Set up), the status is read again a few times, so This computer shows the host
   * running without a manual Refresh. Each re-read replaces the last one; nothing else is read again.
   */
  rereadHostSoon(delays: readonly number[] = [3_000, 8_000, 15_000]): void {
    for (const ms of delays) {
      setTimeout(() => {
        this.host = undefined;
        this.changed.fire();
      }, ms).unref?.();
    }
  }

  /**
   * #2301 E2: `agent-host status --json`, once per refresh: the status, {failed: the CLI's own line}, or undefined
   * from a CLI without the command.
   */
  hostStatus(): Promise<AgentHostStatus | { failed: string } | undefined> {
    if (!this.host) {
      const cli = this.deps.resolve();
      const mine = cli.kind !== "found" ? Promise.resolve(undefined) : this.deps.run(cli.path, AGENT_HOST_STATUS_ARGS, 15_000)
        .then((out): AgentHostStatus | { failed: string } | undefined => {
          if (out.code === 0) {
            return parseAgentHostStatus(out.stdout) ?? { failed: AGENT_HOST_TEXTS.notJson };
          }
          return lacksAgentHost(out.stderr) ? undefined : { failed: cliLastLine(out.stderr) ?? `exit ${out.code}` };
        }, () => ({ failed: AGENT_HOST_TEXTS.notJson }))
        .then((s) => {
          if (this.host === mine && s && !("failed" in s)) {   // review: never the marks of a read a refresh replaced
            const had = this.hostSeen?.open.length ?? 0;
            this.hostSeen = s;
            // #2309 (cell01): a session opened or closed in the Agents window, or the host started or stopped, also
            // changes which cells run here: the cell list is read again then (once per change; kept across refreshes,
            // so a refresh's own status read never refreshes again)
            const key = `${s.running}|${s.open.map((o) => `${o.name} (${o.mesh})`).sort().join(",")}`;
            const before = this.hostKey;
            this.hostKey = key;
            if (before !== undefined && before !== key) {
              // the status just read stays what the view and the status bar show until the next one
              void this.refresh().then(() => {
                if (!this.hostSeen) {
                  this.hostSeen = s;
                  this.summaryChanged.fire();
                  this.changed.fire();   // review: the open marks too, whatever redraws first
                }
              }, () => undefined);
              // review: the cell may record that it runs a moment after the Agents window opened it: read once more,
              // keeping the host status it had (no open-mark flicker); cancelled on dispose
              const t = setTimeout(() => {
                this.timers.delete(t);
                const keep = this.hostSeen;
                void this.refresh().then(() => {
                  if (!this.hostSeen && keep) {
                    this.hostSeen = keep;
                    this.changed.fire();
                    this.summaryChanged.fire();
                  }
                }, () => undefined);
              }, this.rereadAfterMs);
              t.unref?.();
              this.timers.add(t);
              this.summaryChanged.fire();
              return s;
            }
            if (s.open.length || had) {
              this.changed.fire();   // the open marks on the cell rows
            }
            this.summaryChanged.fire();
          }
          return s;
        });
      this.host = mine;
    }
    return this.host;
  }

  private async groupChildren(group: MeshGroupItem): Promise<vscode.TreeItem[]> {
    const server = this.deps.server();
    const seen = this.hostSeen;
    const local: vscode.TreeItem[] = group.cells.map((c) => {
      const item = new LocalCellItem(c, group.all, server, group.legacy);
      if (isOpen(seen, c)) {   // #2301 E2: open in VS Code's Agents window now (by name and mesh)
        // cell01: first, so the default width never cuts it; and in the tooltip
        item.description = [AGENT_HOST_TEXTS.openMark, item.description].filter(Boolean).join(" · ");
        item.tooltip = `${AGENT_HOST_TEXTS.openTooltip}\n${String(item.tooltip ?? "")}`;
        item.iconPath = localCellIcon(c, true);
      }
      return item;
    });
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
    // cell01 (the looks): your own cells elsewhere stay rows; many other members' cells fold into one row
    const others = elsewhere.filter((p) => !p.own);
    const shown = others.length > FOLD_OTHERS_ABOVE ? elsewhere.filter((p) => p.own) : elsewhere;
    return [...local, ...shown.map((p) => new RemoteCellItem(group.meshId!, p)),
      ...(others.length > FOLD_OTHERS_ABOVE ? [new OtherCellsItem(group.meshId, others)] : [])];
  }

  /** Tests: whether mesh `meshId`'s failed peers read is planned to be read again. */
  peersRetryPending(meshId: string): boolean {
    return !!this.peersRetry.get(meshId)?.pending;
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
    let retry = this.peersRetry.get(meshId);
    if (!peers) {
      if (peersErrorLooksTemporary(out)) {
        if (!retry) {
          retry = new BusyRetry(() => {   // this mesh only: drop its cached failure, redraw (which reads it again)
            this.peers.delete(meshId);
            this.changed.fire();
          }, BUSY_BACKOFF_MS, 10);
          this.peersRetry.set(meshId, retry);
        }
        retry.busy();
      }
      return { kind: "error" };   // kept in the cache: a redraw doesn't read again
    }
    retry?.settled();
    return { kind: "ok", peers };
  }

  dispose(): void {
    this.peersRetry.forEach((r) => r.dispose());
    this.timers.forEach((t) => clearTimeout(t));   // #35 review: no CLI run after the extension stopped
    this.timers.clear();
    this.changed.dispose();
    this.summaryChanged.dispose();
  }
}
