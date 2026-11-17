// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.8.0: which Claude Code session does an editor tab show? The Claude Code extension gives no API for that. Its
// tab's label is the session's title, and Claude Code writes that title into the transcript (`custom-title` and
// `ai-title` records). So the tab is matched to the newest transcripts on this computer by title; when that names
// no single session, the user picks one. From a transcript its title records are read, from its last TAIL_BYTES;
// to show the user which session was matched, also its first prompt, from its first PROMPT_HEAD_BYTES, shortened
// to PROMPT_MAX characters. That is shown only to the user (a confirm, the session pick, the terminal's banner);
// the extension keeps and logs nothing of it, and it never reaches a command line. Pure Node, no vscode import.
import * as fs from "fs";
import * as path from "path";
import { claudeProjectsDir } from "./nativeSeed";

/** The view type of a Claude Code chat tab (the Claude Code extension's webview panel). */
export const CLAUDE_PANEL = "claudeVSCodePanel";
/** How much of a transcript's end is read to find its title. */
export const TAIL_BYTES = 512 * 1024;
/** How much of a transcript's start is read to find its first prompt. */
export const PROMPT_HEAD_BYTES = 64 * 1024;
/** The first prompt is shown shortened to this many characters. */
export const PROMPT_MAX = 120;
/** How many of the newest transcripts are looked at. */
export const RECENT_MAX = 80;

const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The part of a tab this module reads (a `vscode.Tab`). */
export interface TabLike {
  label: string;
  input?: unknown;
  /** The tab's group; only its column is read, to tell tabs apart in a pick. */
  group?: { viewColumn?: number };
}

/** The part of a tab group this module reads (a `vscode.TabGroup`). */
export interface TabGroupLike<T extends TabLike = TabLike> {
  tabs: readonly T[];
  activeTab?: T;
}

/** True for a Claude Code chat tab: a webview whose view type is, or ends with, CLAUDE_PANEL (VS Code prefixes it). */
export function isClaudeTab(tab: TabLike | undefined): boolean {
  const viewType = (tab?.input as { viewType?: unknown } | undefined)?.viewType;
  return typeof viewType === "string" && (viewType === CLAUDE_PANEL || viewType.endsWith(`-${CLAUDE_PANEL}`));
}

/** True for any webview tab (its input has a view type and no file). */
function isWebviewTab(tab: TabLike | undefined): boolean {
  const input = tab?.input as { viewType?: unknown; uri?: unknown } | undefined;
  return typeof input?.viewType === "string" && input.uri === undefined;
}

/** The `editorIndex` VS Code passes to a command run from a tab's context menu, or undefined. */
export function editorIndexOf(args: readonly unknown[]): number | undefined {
  for (const a of args) {
    const i = (a as { editorIndex?: unknown } | null | undefined)?.editorIndex;
    if (typeof i === "number" && Number.isInteger(i) && i >= 0) {
      return i;
    }
  }
  return undefined;
}

/**
 * What the resource VS Code passes first to a command run from a tab's context menu says about the clicked tab.
 * A webview tab's resource is `webview-panel:/webview-panel/webview-<view type>-<uuid>` since VS Code 1.106
 * (`webview-<uuid>` before, which names no view type). Webview tabs expose no resource to extensions, so this
 * tells only the kind of the clicked tab, not which one it is:
 * - "claude": a Claude Code tab;
 * - "webview": a webview of unknown view type (VS Code before 1.106);
 * - "other": not a Claude Code tab (a file, or another extension's webview);
 * - undefined: no resource was passed (the Command Palette).
 */
export function clickedKind(args: readonly unknown[]): "claude" | "webview" | "other" | undefined {
  const uri = args[0] as { scheme?: unknown; path?: unknown } | null | undefined;
  if (!uri || typeof uri !== "object" || typeof uri.scheme !== "string") {
    return undefined;
  }
  if (uri.scheme !== "webview-panel") {
    return "other";
  }
  const name = typeof uri.path === "string" ? uri.path.slice(uri.path.lastIndexOf("/") + 1) : "";
  if (name.startsWith(`webview-${CLAUDE_PANEL}-`)) {
    return "claude";
  }
  return /^webview-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name) ? "webview" : "other";
}

/**
 * one: the tab; ask: the clicked tab can't be told for sure, the user chooses among these; notClaude: the clicked
 * tab isn't a Claude Code tab; none: there is no Claude Code tab.
 */
export type TabChoice<T extends TabLike> = { kind: "one"; tab: T } | { kind: "ask"; tabs: T[] } | { kind: "notClaude" } | { kind: "none" };

/**
 * The Claude Code tab a command is about. Never a guess: a right-click doesn't make the tab's group active, and VS
 * Code passes the clicked tab's index in its group but not the group in a form extensions can look up. So from a
 * context menu, the candidates are the tabs at that index in every group, narrowed by what the passed resource
 * says (clickedKind). One candidate: that tab (notClaude when it isn't a Claude Code tab). Several: the user
 * chooses among the Claude Code ones. Without an index (the Command Palette): the active tab when it is a Claude
 * Code tab, else the only Claude Code tab; with several, the user chooses.
 */
export function chooseClaudeTab<T extends TabLike>(groups: readonly TabGroupLike<T>[], active: TabGroupLike<T> | undefined, editorIndex: number | undefined, clicked?: "claude" | "webview" | "other"): TabChoice<T> {
  const all = groups.flatMap((g) => g.tabs.filter((t) => isClaudeTab(t)));
  const anyOf = (tabs: T[]): TabChoice<T> => (tabs.length ? { kind: "ask", tabs } : { kind: "none" });
  if (clicked === "other") {
    return { kind: "notClaude" };
  }
  if (editorIndex !== undefined) {
    const at = groups.map((g) => g.tabs[editorIndex]).filter((t): t is T => !!t);
    const fits = at.filter((t) => (clicked === "claude" ? isClaudeTab(t) : clicked === "webview" ? isWebviewTab(t) : true));
    if (fits.length === 1) {
      return isClaudeTab(fits[0]) ? { kind: "one", tab: fits[0] } : { kind: "notClaude" };
    }
    if (fits.length === 0) {
      // The index names no such tab (the tabs moved meanwhile): every Claude Code tab is offered.
      return anyOf(all);
    }
    const claude = fits.filter((t) => isClaudeTab(t));
    return claude.length ? { kind: "ask", tabs: claude } : { kind: "notClaude" };
  }
  if (active?.activeTab && isClaudeTab(active.activeTab)) {
    return { kind: "one", tab: active.activeTab };
  }
  return all.length === 1 ? { kind: "one", tab: all[0] } : anyOf(all);
}

function clean(s: string): string {
  // C0 and C1 control characters (a terminal would act on them), then runs of white space
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

/** At most `max` characters (code points), with "…" when shortened. */
export function shorten(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max - 1).join("")}…` : s;
}

/**
 * The session's first prompt in the start of a transcript: the text of the first `user` record that is the
 * user's own typing (not a meta record, a tool result, or a wrapper such as `<command-name>` that Claude Code
 * writes for slash commands), cleaned and shortened to PROMPT_MAX characters.
 */
export function firstPrompt(head: string): string | undefined {
  for (const line of head.split(/\r?\n/).slice(0, 2000)) {
    if (!line.includes("\"user\"")) {
      continue;
    }
    let r: { type?: unknown; isMeta?: unknown; message?: { role?: unknown; content?: unknown } };
    try {
      r = JSON.parse(line);
    } catch {
      continue;   // a line cut at PROMPT_HEAD_BYTES, or not JSON
    }
    if (!r || r.type !== "user" || r.isMeta === true || r.message?.role !== "user") {
      continue;
    }
    const c = r.message.content;
    const text = typeof c === "string" ? c
      : Array.isArray(c) ? c.find((part) => part && part.type === "text" && typeof part.text === "string")?.text : undefined;
    const t = typeof text === "string" ? clean(text) : "";
    if (t && !/^<[a-z][a-z-]*>/i.test(t)) {
      return shorten(t, PROMPT_MAX);
    }
  }
  return undefined;
}

/** The first prompt of a transcript file (firstPrompt), or undefined when it has none or can't be read. */
export async function readFirstPrompt(file: string): Promise<string | undefined> {
  try {
    const fh = await fs.promises.open(file, "r");
    try {
      const buf = Buffer.alloc(PROMPT_HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, PROMPT_HEAD_BYTES, 0);
      return firstPrompt(buf.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * The session's title in the end of a transcript: its last `custom-title` (a rename), else its last `ai-title`.
 * Only lines that name one of the two record types are parsed.
 */
export function transcriptTitle(tail: string): string | undefined {
  let ai: string | undefined;
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const custom = line.includes("\"custom-title\"");
    if (!custom && (ai !== undefined || !line.includes("\"ai-title\""))) {
      continue;
    }
    try {
      const r = JSON.parse(line);
      if (r && r.type === "custom-title" && typeof r.customTitle === "string" && clean(r.customTitle)) {
        return Array.from(clean(r.customTitle)).slice(0, 200).join("");
      }
      if (r && r.type === "ai-title" && typeof r.aiTitle === "string" && clean(r.aiTitle) && ai === undefined) {
        ai = Array.from(clean(r.aiTitle)).slice(0, 200).join("");
      }
    } catch {
      // the line cut at TAIL_BYTES, or not JSON: the one before
    }
  }
  return ai;
}

/** True when a tab's label is this title: the same text, or the title's start when the label was shortened ("…"). */
export function labelMatches(label: string, title: string | undefined): boolean {
  if (!title) {
    return false;
  }
  const l = clean(label).toLowerCase();
  const t = clean(title).toLowerCase();
  if (!l) {
    return false;
  }
  if (l === t) {
    return true;
  }
  const cut = l.replace(/(…|\.\.\.)$/, "").trim();
  return cut !== l && cut.length >= 8 && t.startsWith(cut);
}

export interface RecentSession {
  sessionId: string;
  /** The folder under the projects dir (Claude Code's name for the folder the session ran in). */
  folder: string;
  /** The transcript: <projects dir>/<folder>/<session id>.jsonl. */
  file: string;
  mtime: number;
  title?: string;
  /** Its first prompt (firstPrompt), read only when the session is shown to the user. */
  firstPrompt?: string;
}

async function readTail(file: string, size: number): Promise<string> {
  const fh = await fs.promises.open(file, "r");
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, size - length);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** The newest Claude Code transcripts on this computer (at most `max`), newest first, each with its title when it has one. */
export async function recentSessions(projectsDir: string = claudeProjectsDir(), max: number = RECENT_MAX): Promise<RecentSession[]> {
  let folders: fs.Dirent[];
  try {
    folders = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: (RecentSession & { size: number })[] = [];
  for (const d of folders) {
    if (!d.isDirectory()) {
      continue;
    }
    let files: string[];
    try {
      files = await fs.promises.readdir(path.join(projectsDir, d.name));
    } catch {
      continue;
    }
    for (const f of files) {
      const m = UUID_FILE.exec(f);
      if (!m) {
        continue;
      }
      const file = path.join(projectsDir, d.name, f);
      try {
        const st = await fs.promises.stat(file);
        if (st.isFile() && st.size > 0) {
          found.push({ sessionId: m[1].toLowerCase(), folder: d.name, mtime: st.mtimeMs, file, size: st.size });
        }
      } catch {
        // gone meanwhile
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const out: RecentSession[] = [];
  for (const s of found.slice(0, Math.max(0, max))) {
    let title: string | undefined;
    try {
      title = transcriptTitle(await readTail(s.file, s.size));
    } catch {
      // unreadable: listed without a title
    }
    out.push({ sessionId: s.sessionId, folder: s.folder, file: s.file, mtime: s.mtime, ...(title ? { title } : {}) });
  }
  return out;
}

/** The sessions whose title is the tab's label (newest first). Exactly one names the tab's session. */
export function sessionsForLabel(label: string, sessions: readonly RecentSession[]): RecentSession[] {
  return sessions.filter((s) => labelMatches(label, s.title));
}

/** The slug localSession.findLocalSession takes: the id's first 12 letters and digits. */
export function slugOf(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
}
