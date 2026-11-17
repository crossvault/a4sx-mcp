// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.8.0: which Claude Code session does an editor tab show? The Claude Code extension gives no API for that. Its
// tab's label is the session's title, and Claude Code writes that title into the transcript (`custom-title` and
// `ai-title` records). So the tab is matched to the newest transcripts on this computer by title; when that names
// no single session, the user picks one. From a transcript its title records are read, from its last TAIL_BYTES;
// to show the user which session was matched, also its first prompt, from its first PROMPT_HEAD_BYTES, shortened
// to PROMPT_MAX characters. That is shown only to the user (a confirm, the session pick, the terminal's banner);
// the extension keeps and logs nothing of it, and it never reaches a command line. Pure Node, no vscode import.
// 0.9.1: the tab's label is what the Claude Code extension's webview sets with its own rule (Claude Code 2.1.x): the
// session's summary, cut to 24 characters plus "…" when longer than 25, or "Claude Code" while there is none. The
// summary is the title, an earlier generated title (a tab keeps the first one it got), or, before any title, the
// prompt. detectTabSession matches all three, and then narrows same-title sessions by what an open tab can show:
// a session that another open Claude Code tab already shows is not this one, and Claude Code's tabs show the
// sessions of the window's folders (and their .claude/worktrees). Only when that still leaves several, or none,
// the user picks.
import * as fs from "fs";
import * as path from "path";
import { claudeProjectsDir, projectDirName } from "./nativeSeed";

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
/** 0.9.1: how many of the newest transcripts of the window's folders are looked at as well (older than RECENT_MAX). */
export const WINDOW_RECENT_MAX = 120;
/** The label of a Claude Code tab whose session has no summary yet. */
export const DEFAULT_TAB_LABEL = "Claude Code";
/** The entrypoint Claude Code's VS Code extension starts its sessions with (each transcript record names it). */
export const VSCODE_ENTRYPOINT = "claude-vscode";

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

/** Every title in the end of a transcript (custom-title and ai-title records), newest first, without repeats. */
export function transcriptTitles(tail: string): string[] {
  const out: string[] = [];
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && out.length < 20; i--) {
    const line = lines[i];
    if (!line.includes("\"custom-title\"") && !line.includes("\"ai-title\"")) {
      continue;
    }
    try {
      const r = JSON.parse(line);
      const v = r && r.type === "custom-title" ? r.customTitle : r && r.type === "ai-title" ? r.aiTitle : undefined;
      const t = typeof v === "string" ? Array.from(clean(v)).slice(0, 200).join("") : "";
      if (t && !out.includes(t)) {
        out.push(t);
      }
    } catch {
      // the line cut at TAIL_BYTES, or not JSON
    }
  }
  return out;
}

/** The last prompt Claude Code noted in the end of a transcript (its `last-prompt` record), cleaned and shortened. */
export function transcriptLastPrompt(tail: string): string | undefined {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("\"last-prompt\"")) {
      continue;
    }
    try {
      const r = JSON.parse(lines[i]);
      if (r && r.type === "last-prompt" && typeof r.lastPrompt === "string" && clean(r.lastPrompt)) {
        return shorten(clean(r.lastPrompt), PROMPT_MAX);
      }
    } catch {
      // the line cut at TAIL_BYTES, or not JSON: the one before
    }
  }
  return undefined;
}

/** The entrypoint of the newest record in the end of a transcript that names one ("claude-vscode", "cli", …). */
export function transcriptEntrypoint(tail: string): string | undefined {
  const all = [...tail.matchAll(/"entrypoint"\s*:\s*"([a-z0-9-]{1,40})"/g)];
  return all.length ? all[all.length - 1][1] : undefined;
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
  /** 0.9.1: the titles it had before its title (newest first): a tab keeps the first generated title it got. */
  earlierTitles?: string[];
  /** 0.9.1: its last prompt (Claude Code's `last-prompt` record): a tab's label before the session has a title. */
  lastPrompt?: string;
  /** 0.9.1: the entrypoint of its newest record ("claude-vscode" for a session of Claude Code's VS Code extension). */
  entrypoint?: string;
  /** Its first prompt (firstPrompt), read only when the session is shown to the user or matched by its prompt. */
  firstPrompt?: string;
}

/** The last TAIL_BYTES of a transcript of `size` bytes. */
export async function readTail(file: string, size: number): Promise<string> {
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

/** A transcript file: <projects dir>/<folder>/<session id>.jsonl, with its size and when it was last written. */
export interface TranscriptFile {
  sessionId: string;
  folder: string;
  file: string;
  mtime: number;
  size: number;
}

/** Every non-empty Claude Code transcript under the projects dir, newest first. Only names and sizes are read. */
export async function listTranscripts(projectsDir: string = claudeProjectsDir()): Promise<TranscriptFile[]> {
  let folders: fs.Dirent[];
  try {
    folders = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: TranscriptFile[] = [];
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
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** A transcript's title (transcriptTitle of its tail), or undefined when it has none or can't be read. */
export async function readTitle(t: TranscriptFile): Promise<string | undefined> {
  try {
    return transcriptTitle(await readTail(t.file, t.size));
  } catch {
    return undefined;   // unreadable: listed without a title
  }
}

/** A transcript as a RecentSession: its title, earlier titles, last prompt and entrypoint, from its tail. */
export async function readRecent(t: TranscriptFile): Promise<RecentSession> {
  const s: RecentSession = { sessionId: t.sessionId, folder: t.folder, file: t.file, mtime: t.mtime };
  let tail: string;
  try {
    tail = await readTail(t.file, t.size);
  } catch {
    return s;   // unreadable: listed without a title
  }
  const title = transcriptTitle(tail);
  const earlier = transcriptTitles(tail).filter((x) => x !== title);
  const lastPrompt = transcriptLastPrompt(tail);
  const entrypoint = transcriptEntrypoint(tail);
  return { ...s, ...(title ? { title } : {}), ...(earlier.length ? { earlierTitles: earlier } : {}), ...(lastPrompt ? { lastPrompt } : {}), ...(entrypoint ? { entrypoint } : {}) };
}

/**
 * The folders under the projects dir that hold the sessions of these window folders: each one's own (projectDirName),
 * and the prefix of its Claude Code worktrees (<folder>/.claude/worktrees/<name>).
 */
export function windowFolderNames(cwds: readonly string[]): { exact: string[]; worktreePrefixes: string[] } {
  return {
    exact: cwds.map((c) => projectDirName(c)),
    worktreePrefixes: cwds.map((c) => `${projectDirName(path.join(c, ".claude", "worktrees"))}-`),
  };
}

/** True when a transcript's folder is one of the window's (windowFolderNames); case-insensitive off Linux. */
export function inWindowFolder(folder: string, names: { exact: readonly string[]; worktreePrefixes: readonly string[] } | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (!names) {
    return false;
  }
  const fold = (x: string) => (platform === "linux" ? x : x.toLowerCase());
  const f = fold(folder);
  return names.exact.some((n) => fold(n) === f) || names.worktreePrefixes.some((p) => f.startsWith(fold(p)) && f.length > p.length);
}

/**
 * The newest Claude Code transcripts on this computer (at most `max`), newest first, each with its title when it has
 * one. 0.9.1: with `window` (windowFolderNames), also the newest `windowMax` of the window's folders, older ones
 * included: a tab that has been idle a while can be older than the newest `max` of all.
 */
export async function recentSessions(projectsDir: string = claudeProjectsDir(), max: number = RECENT_MAX, window?: { exact: string[]; worktreePrefixes: string[] }, windowMax: number = WINDOW_RECENT_MAX): Promise<RecentSession[]> {
  const all = await listTranscripts(projectsDir);
  const newest = all.slice(0, Math.max(0, max));
  const picked = new Set(newest);
  if (window) {
    let n = 0;
    for (const t of all) {
      if (n >= windowMax) {
        break;
      }
      if (inWindowFolder(t.folder, window)) {
        n++;
        picked.add(t);
      }
    }
  }
  const out: RecentSession[] = [];
  for (const t of all.filter((x) => picked.has(x))) {
    out.push(await readRecent(t));
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

/** What an open Claude Code tab can be told apart by, beyond its label (detectTabSession). */
export interface DetectContext {
  /** The window's folders (windowFolderNames): Claude Code's tabs show the sessions of these. */
  window?: { exact: readonly string[]; worktreePrefixes: readonly string[] };
  /** The labels of the window's other Claude Code tabs: a session one of them shows is not this tab's. */
  otherLabels?: readonly string[];
  platform?: NodeJS.Platform;
}

/**
 * one: the tab's session, by its title ("title"), a title it had before ("earlierTitle"), or, for a session with no
 * title yet, its prompt ("prompt"). ask: it can't be told for sure; `matches` are the sessions the label names (none
 * for "noMatch" and "defaultTitle"), the likeliest first.
 */
export type Detection =
  | { kind: "one"; session: RecentSession; how: "title" | "earlierTitle" | "prompt" }
  | { kind: "ask"; why: "duplicate" | "noMatch" | "defaultTitle"; matches: RecentSession[] };

/**
 * The sessions a label names: by their title or a title they had before (a tab keeps the first generated title it
 * got, so both count: a session whose earlier title is the label is as likely as one whose title is); else, among
 * those with no title, by their first or last prompt.
 */
function labelHits(label: string, sessions: readonly RecentSession[]): { hits: RecentSession[]; how: "title" | "earlierTitle" | "prompt" } {
  const byTitle = sessions.filter((s) => labelMatches(label, s.title) || (s.earlierTitles ?? []).some((t) => labelMatches(label, t)));
  if (byTitle.length) {
    return { hits: byTitle, how: byTitle.length === 1 && !labelMatches(label, byTitle[0].title) ? "earlierTitle" : "title" };
  }
  return { hits: sessions.filter((s) => !s.title && (labelMatches(label, s.firstPrompt) || labelMatches(label, s.lastPrompt))), how: "prompt" };
}

/** `list` narrowed by `keep`, when that leaves any; else `list` as it was. */
function narrow<T>(list: T[], keep: (x: T) => boolean): T[] {
  const kept = list.filter(keep);
  return kept.length ? kept : list;
}

/**
 * The session an open Claude Code tab shows, from its label (see the header). Never a guess between sessions that
 * fit equally: several sessions with the label's title are narrowed only by what rules a session out as this tab's
 * (it isn't in one of the window's folders while others are; then, another open tab names it alone by its current
 * title); when more than one is left, or the two rules leave none, the user picks. `sessions` are newest first; prompts (firstPrompt) are needed only for sessions with
 * no title.
 */
export function detectTabSession(label: string, sessions: readonly RecentSession[], ctx: DetectContext = {}): Detection {
  if (clean(label) === DEFAULT_TAB_LABEL) {
    return { kind: "ask", why: "defaultTitle", matches: [] };
  }
  const { hits, how } = labelHits(label, sessions);
  if (hits.length === 0) {
    return { kind: "ask", why: "noMatch", matches: [] };
  }
  if (hits.length === 1) {
    return { kind: "one", session: hits[0], how };
  }
  const inWindow = (s: RecentSession) => inWindowFolder(s.folder, ctx.window, ctx.platform);
  // First the window's folders: when some matches are in them, the others can't be this tab's (all outside: all stay).
  const windowed = narrow(hits, inWindow);
  // Then a session another open tab names alone by its current title (among the window's, when it has some there) is
  // that tab's: Claude Code opens a session in one tab at most. This only removes candidates: when it removes them
  // all, the evidence conflicts and the user picks; an earlier title or a prompt never claims a session.
  const own = clean(label).toLowerCase();
  const claimed = new Set<RecentSession>();
  for (const other of ctx.otherLabels ?? []) {
    if (clean(other).toLowerCase() === own || clean(other) === DEFAULT_TAB_LABEL) {
      continue;
    }
    const theirs = narrow(sessions.filter((s) => labelMatches(other, s.title)), inWindow);
    if (theirs.length === 1) {
      claimed.add(theirs[0]);
    }
  }
  const left = windowed.filter((s) => !claimed.has(s));
  if (left.length === 1) {
    return { kind: "one", session: left[0], how };
  }
  if (left.length === 0) {
    return { kind: "ask", why: "duplicate", matches: [...windowed, ...hits.filter((s) => !windowed.includes(s))] };
  }
  return { kind: "ask", why: "duplicate", matches: [...left, ...hits.filter((s) => !left.includes(s))] };
}

/**
 * The order of the session pick: `first` (the label's matches), then the sessions of the window's folders, then
 * those of Claude Code's VS Code extension, then the rest; newest first within each.
 */
export function pickOrder(sessions: readonly RecentSession[], first: readonly RecentSession[], ctx: DetectContext = {}): RecentSession[] {
  const rank = (s: RecentSession) => (inWindowFolder(s.folder, ctx.window, ctx.platform) ? 0 : 2) + (s.entrypoint === VSCODE_ENTRYPOINT ? 0 : 1);
  const rest = sessions.filter((s) => !first.includes(s)).map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
  return [...first, ...rest];
}
