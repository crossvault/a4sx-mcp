// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
/**
 * #2301 E2: the agent host on this computer, from `a4sx agent-host status --json` (CLI 0.40+): whether it runs and
 * where, which cells are open in the Agents window, whether VS Code is set up for it, and its last error. Only what
 * the Cells view shows; never the token (the CLI never prints it).
 */
import { CELL_NAME, showText } from "./cells";

export const AGENT_HOST_STATUS_ARGS = ["agent-host", "status", "--json"] as const;
export const AGENT_HOST_START_ARGS = ["agent-host"] as const;
export const AGENT_HOST_SETUP_ARGS = ["agent-host", "setup-vscode"] as const;
/** a4sx #2326 (CLI 0.59.15): the same stop as Ctrl-C in the host's terminal, asked from here. */
export const AGENT_HOST_STOP_ARGS = ["agent-host", "stop"] as const;

export interface AgentHostStatus {
  running: boolean;
  /** ws://127.0.0.1:8765/ while it runs. */
  address?: string;
  /** The cells open in the Agents window now: the CLI writes "name (mesh)", or "name (plain)" for a plain session. */
  open: { name: string; mesh: string }[];
  /** Per editor (code, code-insiders, …): "ok" or what is wrong; undefined when setup-vscode never ran. */
  editors?: Record<string, string>;
  lastError?: { at?: string; text: string };
  /** CLI 0.40.1+: false while the host process runs but didn't answer the CLI's probe in time (null/absent: unknown). */
  answering?: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The status answer, or undefined when it isn't one (an older CLI, an error). */
export function parseAgentHostStatus(stdout: string): AgentHostStatus | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isObject(raw) || typeof raw.running !== "boolean") {
    return undefined;
  }
  const address = typeof raw.address === "string" && /^ws:\/\/[A-Za-z0-9.:[\]-]{1,80}\/?$/.test(raw.address) ? raw.address : undefined;
  const open: { name: string; mesh: string }[] = [];
  for (const e of Array.isArray(raw.open) ? raw.open.slice(0, 64) : []) {
    const m = typeof e === "string" ? /^(\S{1,64}) \((.{1,128})\)$/.exec(e) : null;
    if (m && CELL_NAME.test(m[1]) && m[2] !== "plain" && showText(m[2], 128) === m[2]) {
      open.push({ name: m[1], mesh: m[2] });
    }
  }
  let editors: Record<string, string> | undefined;
  const vs = isObject(raw.vscode) && isObject(raw.vscode.editors) ? raw.vscode.editors : undefined;
  if (vs) {
    editors = {};
    for (const [k, v] of Object.entries(vs)) {
      if (/^[a-z][a-z0-9-]{0,31}$/.test(k) && typeof v === "string" && /^[a-z_]{1,32}$/.test(v)) {
        editors[k] = v;
      }
    }
  }
  const e = isObject(raw.last_error) ? raw.last_error : undefined;
  const text = e ? showText(e.text, 300) : undefined;
  const at = e ? showText(e.at, 40) : undefined;
  const running = raw.running && !!address;   // running without an address it can name: not shown as running
  return { running, address: running ? address : undefined, open: running ? open : [], editors,
    lastError: text ? { at, text } : undefined, ...(running && typeof raw.answering === "boolean" ? { answering: raw.answering } : {}) };
}

/** Whether `cell` is one of the open ones: its name, and its mesh by name or id (the CLI's "name (mesh)"). */
export function isOpen(s: { open: { name: string; mesh: string }[] } | undefined, cell: { name: string; meshId?: string; meshName?: string }): boolean {
  return !!s && s.open.some((o) => o.name === cell.name && (o.mesh === cell.meshName || o.mesh === cell.meshId
    || (o.mesh === "standalone" && !cell.meshId)));
}

/**
 * cell01 (Windows): Ctrl+C on a host started through the a4sx.cmd launcher asks "Terminate batch job (Y/N)?". The
 * launcher the CLI writes is one line, `@"<python>" "<script>" %*`: started as python with the script instead,
 * Ctrl+C just stops the host. undefined when `cli` is no such launcher (then the CLI itself is started).
 */
export function directLaunch(cli: string, read: (p: string) => string | undefined, exists: (p: string) => boolean,
  platform: NodeJS.Platform = process.platform): { exe: string; pre: string[] } | undefined {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(cli)) {
    return undefined;
  }
  const text = read(cli);
  // the CLI's launcher (`@"py" "script" %*`) or the extension's own (provision.ts: `@echo off` and `"py" "script" %*`)
  const body = text?.trim().replace(/^@echo off\s*\r?\n/i, "@");
  const m = body ? /^@"([^"\r\n]+)"\s+"([^"\r\n]+)"\s+%\*\s*$/.exec(body) : null;
  if (!m || !/^[A-Za-z]:\\/.test(m[1]) || !/^[A-Za-z]:\\/.test(m[2]) || !exists(m[1]) || !exists(m[2])) {
    return undefined;
  }
  return { exe: m[1], pre: [m[2]] };
}

/** True when the CLI has no `agent-host status` (argparse's "invalid choice"). */
export function lacksAgentHost(stderr: string): boolean {
  return /invalid choice|unrecognized arguments/.test(stderr);
}

/** The CLI's editor key (setup-vscode) for VS Code's own uriScheme. */
const EDITOR_OF_SCHEME: Record<string, string> = { vscode: "stable", "vscode-insiders": "insiders", vscodium: "vscodium", "code-oss": "oss" };

/**
 * True when the Agents window is set up for the agent host: for a known editor (by `uriScheme`), its own entry; for an
 * unknown one (or no scheme given), every editor setup-vscode set up still points at the host.
 */
export function agentsWindowSetUp(s: AgentHostStatus, uriScheme?: string): boolean {
  const eds = s.editors ?? {};
  const mine = uriScheme ? EDITOR_OF_SCHEME[uriScheme] : undefined;
  if (mine) {   // review: a known editor that setup-vscode didn't set up is not set up
    return eds[mine] === "ok";
  }
  const states = Object.values(eds);
  return states.length > 0 && states.every((x) => x === "ok");
}

export const AGENT_HOST_TEXTS = {
  node: "This computer",
  unknown: "agent host: this a4sx CLI has no `agent-host status`; update a4sx to see it here",
  notJson: "its answer wasn't the JSON this extension reads",
  failed: (why: string) => `agent host: \`a4sx agent-host status\` failed: ${why}`,
  running: (address: string) => `agent host running · ${address.replace(/^ws:\/\//, "").replace(/\/$/, "")}`,
  stopped: "agent host not running",
  runningTooltip: (address: string) => `The a4sx agent host runs on this computer at ${address}. VS Code's Agents window reaches your cells through it.`,
  stoppedTooltip: "The a4sx agent host doesn't run on this computer, so VS Code's Agents window can't reach your cells. Start it in a terminal: it runs until you stop it (Ctrl+C) or close that terminal.",
  start: "Start agent host",
  stop: "Stop agent host",
  stopTooltip: "Runs `a4sx agent-host stop`: the same stop as Ctrl+C in the host's terminal. It tells the Agents window first, then ends the cells it started.",
  stopping: "Stopping the a4sx agent host (it tells the Agents window first and ends the cells it started)…",
  stopDone: "a4sx agent host stopped. Start it again to use your cells in the Agents window.",
  stopNeedsUpdate: "This a4sx CLI can't stop the agent host from here (that needs CLI 0.59.15 or newer). Update a4sx, or stop it with Ctrl+C in its terminal \"a4sx: agent host\"; nothing was stopped.",
  stopWhat: "stop the agent host",
  stopNoAnswer: "`a4sx agent-host stop` didn't finish within 45 seconds. If it got as far as asking, the agent host may still stop; This computer shows when it has, and Ctrl+C in its terminal \"a4sx: agent host\" stops it at once.",
  stopAsk: (names: string[], plain = 0) => {
    const what = [...names.map((n) => `«${n}»`), ...(plain ? [plain === 1 ? "1 plain conversation" : `${plain} plain conversations`] : [])];
    return `Stop the a4sx agent host? ${what.join(", ")} ${what.length === 1 && !(names.length === 0 && plain > 1) ? "ends" : "end"} (VS Code is told first).`;
  },
  stopIt: "Stop it",
  stopNotRunning: "The a4sx agent host wasn't running, so there was nothing to stop.",
  setup: "Set up the Agents window",
  setupTooltip: "Runs `a4sx agent-host setup-vscode` in a terminal: it points VS Code's Agents window at the agent host on this computer, says what it changed, and starts the agent host there when it isn't running.",
  openMark: "open in the Agents window",
  openTooltip: "Open in VS Code's Agents window now.",
  // cell01: the row is cut at the default width: a short label, the whole text in its tooltip
  lastError: (text: string) => `Last error: ${text.length > 48 ? `${text.slice(0, 47)}…` : text}`,
  lastErrorTooltip: (text: string, at?: string) => `Last error of the agent host${at ? ` (${at})` : ""}: ${text}`,
  startTerminal: "a4sx: agent host",
  setupTerminal: "a4sx: set up the Agents window",
};
