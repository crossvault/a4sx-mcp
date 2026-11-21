// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
/**
 * cell01 (#2301, the looks): one status bar item, "a4sx: 3 cells · 1 running", that opens the Cells view on a click.
 * It reads nothing itself: it shows what the Cells view last read (the cells, and the agent host's status once
 * This computer's rows were shown), so it never adds a CLI run or a server call. Before the Cells view was first
 * shown in this window it reads "a4sx" alone.
 */
import * as vscode from "vscode";
import type { AgentHostStatus } from "./agentHostStatus";
import type { CellsLoad } from "./cellsView";
import { isOpen } from "./agentHostStatus";

/** VS Code's own focus command of the Cells view (view id + ".focus"). */
export const CMD_FOCUS_CELLS = "a4sx.cells.focus";
export const STATUS_BAR_ID = "a4sx.cellsStatus";

export const STATUS_BAR_TEXTS = {
  name: "a4sx cells",
  bare: "$(vm) a4sx",
  none: "$(vm) a4sx: no cells here",
  cells: (n: number) => (n === 1 ? "1 cell" : `${n} cells`),
  text: (n: number, running: number, open: number) =>
    `$(vm) a4sx: ${STATUS_BAR_TEXTS.cells(n)}${running ? ` · ${running} running` : ""}${open ? ` · ${open} open` : ""}`,
  tipHead: "a4sx on this computer",
  tipNotRead: "The Cells view wasn't shown in this window yet: click to open it.",
  tipNoCells: "No cells are stored on this computer.",
  tipCells: (n: number, running: number, open: number) =>
    `Cells stored here: ${n} (${running} running${open ? `, ${open} open in the Agents window` : ""})`,
  tipHostOn: (address: string) => `Agent host: running on ${address}`,
  tipHostOff: "Agent host: not running",
  tipHostUnknown: "Agent host: not read yet (the Cells view reads it when This computer is shown)",
  tipClick: "Click to open the Cells view.",
};

export interface CellsSummary {
  cells: number;
  running: number;
  open: number;
  host?: { running: boolean; address?: string };
}

/** What the Cells view last read, as counts; undefined when it has no list (not read yet, no CLI, an error). */
export function cellsSummary(load: CellsLoad | undefined, host: AgentHostStatus | undefined): CellsSummary | undefined {
  if (load?.kind !== "ok") {
    return undefined;
  }
  return {
    cells: load.cells.length,
    running: load.cells.filter((c) => c.localState === "running").length,
    open: load.cells.filter((c) => isOpen(host, c)).length,
    host: host ? { running: host.running, address: host.address } : undefined,
  };
}

export function statusBarText(s: CellsSummary | undefined): string {
  const t = STATUS_BAR_TEXTS;
  return !s ? t.bare : s.cells === 0 ? t.none : t.text(s.cells, s.running, s.open);
}

/** Plain text (never markdown): counts and the agent host's address only, no name that came from a server. */
export function statusBarTooltip(s: CellsSummary | undefined): string {
  const t = STATUS_BAR_TEXTS;
  if (!s) {
    return [t.tipHead, t.tipNotRead].join("\n");
  }
  return [
    t.tipHead,
    s.cells === 0 ? t.tipNoCells : t.tipCells(s.cells, s.running, s.open),
    !s.host ? t.tipHostUnknown : s.host.running && s.host.address ? t.tipHostOn(s.host.address) : t.tipHostOff,
    t.tipClick,
  ].join("\n");
}

export interface SummarySource {
  readonly load: CellsLoad | undefined;
  readonly hostKnown: AgentHostStatus | undefined;
  onDidChangeSummary: vscode.Event<void>;
}

/** The status bar item, kept in step with the Cells view's own reads. Dispose it with the extension. */
export function cellsStatusBar(source: SummarySource): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(STATUS_BAR_ID, vscode.StatusBarAlignment.Left, 0);
  item.name = STATUS_BAR_TEXTS.name;
  item.command = CMD_FOCUS_CELLS;
  const draw = () => {
    const s = cellsSummary(source.load, source.hostKnown);
    item.text = statusBarText(s);
    item.tooltip = statusBarTooltip(s);
  };
  draw();
  item.show();
  const sub = source.onDidChangeSummary(draw);
  return { dispose: () => { sub.dispose(); item.dispose(); } };
}
