// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
/**
 * "Open deck" (a4sx 11-21 backlog): the herdr plugin's deck, deck.py (bundled, pinned by its sha256), in one VS Code
 * terminal. The deck's cell starts come back as request files in a private folder made for that one terminal. Each
 * one is checked here again (the deck's own check doesn't count) and opened as a VS Code terminal named after it,
 * and each one is a line in Output → a4sx.
 *
 * A forged request is possible: a program of the same user can read the deck's environment, and so its nonce. The
 * allow-list is why that is harmless: a forged request can only start a stored cell or a saved conversation, in a
 * folder, visibly. Nothing on it deletes, signs in or changes a mesh.
 *
 * Why no question before each start (coordinator, 11-26): a process of the same user that can run programs itself can
 * run `a4sx launch` in any folder without the deck, so the channel gives it nothing but visibility. That rests on a
 * condition, checked against the CLI's cell settings (cli/amdx.py, the cell's "sandbox" block): a cell's sandboxed
 * commands can't write into VS Code's globalStorage, where the channel folders are. The sandbox writes only inside the
 * cell's folder and a4sx adds no write root, so this holds unless the cell's folder holds globalStorage (the home
 * folder itself, ~/.config, %APPDATA%). The deck never starts a cell there: deckFolderOk refuses the channels' folder
 * and every folder above it (review). Claude Code's Write and Edit tools outside the folder go through the person's
 * permission mode (and a4sx's ask hook). If a cell's sandbox ever can write there, ask before each start instead.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export const CMD_OPEN_DECK = "a4sx.openDeck";
/** deck.py as bundled (a4sx-herdr-plugin 0.5.0); a file that isn't this one is not started. */
export const DECK_SHA256 = "2512e29b96cfba7ebd4c5426dc622df22855690a546c8b44d0d4b194ff384582";
export const DECK_FILE = path.join("deck", "deck.py");
/** At most this many terminals for the deck in a minute. */
export const DECK_MAX_PER_MINUTE = 10;
/** A request file larger than this is not read. */
export const DECK_MAX_REQUEST_BYTES = 16 * 1024;
/** How often the channel folder is looked at besides its watch (a missed event costs at most this). */
export const DECK_SCAN_MS = 1500;

export const DECK_TEXTS = {
  terminal: "a4sx deck",
  requestTerminal: (label: string) => `a4sx: ${label}`,
  whatDeck: "the deck",
  noPython: "Python 3 isn't found here, and the deck needs it. Install Python 3, then open the deck again.",
  changed: "The deck that comes with the a4sx extension was changed on this computer, so it wasn't started. Reinstall the a4sx extension.",
  refused: (what: string) => `The deck asked for something the extension doesn't run, so nothing was started: ${what}.`,
  unreadable: "a request it can't read",
  outsideHome: "a4sx launch in a folder outside your home folder and this window's workspace folders (or one every user can write to)",
  tooMany: `The deck asked for more than ${DECK_MAX_PER_MINUTE} terminals within a minute, so this one wasn't opened.`,
  logOpened: (time: string, label: string) => `${time} deck: opened the terminal «a4sx: ${label}»`,
  logRefused: (time: string, why: string) => `${time} deck: refused ${why}`,
  logAccepted: (time: string, label: string, cwd: string, args: readonly string[]) => `${time} deck: accepted «${label}» in ${cwd}: a4sx ${args.join(" ")}`,
  logNotOpened: (time: string, label: string) => `${time} deck: «${label}» was not opened (the message before says why)`,
};

// --- the check (the same shapes as deck.py's vscode_request_args) ----------------------------------

const CELL = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const SAVED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLAGS = ["--cell", "--new-session", "--a4sx-session"];
/** The flag sets of `a4sx launch` the deck sends, sorted and joined. */
const SHAPES = new Set(["--cell", "--cell --new-session", "--a4sx-session --cell", "--a4sx-session"]);
/** A terminal's name: plain ASCII (review: no right-to-left or zero-width characters that would show another name). */
const LABEL = /^[\x20-\x7e]{1,40}$/;
/** A folder: no control, format, line-separator or private-use characters (deck.py's vscode_plain_folder refuses the same). */
const FOLDER_BAD = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}]/u;

/** The arguments when they are a start the deck may ask for: `launch` with --cell [<cell>], --new-session, --a4sx-session <saved>. */
export function deckLaunchArgs(args: unknown): string[] | undefined {
  if (!Array.isArray(args) || args.length < 2 || args.length > 5 || args[0] !== "launch") {
    return undefined;
  }
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== "string" || seen.has(a) || !FLAGS.includes(a)) {
      return undefined;
    }
    seen.add(a);
    const next = args[i + 1];
    if (a === "--cell" && typeof next === "string" && !next.startsWith("-")) {
      if (!CELL.test(next)) {
        return undefined;
      }
      i++;
    } else if (a === "--a4sx-session") {
      if (typeof next !== "string" || !SAVED.test(next)) {
        return undefined;
      }
      i++;
    }
  }
  return SHAPES.has([...seen].sort().join(" ")) ? [...(args as string[])] : undefined;
}

export interface DeckRequest { label: string; cwd: string; args: string[] }
export type DeckCheck = { ok: true; req: DeckRequest } | { ok: false; why: string };

function sameNonce(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** What a refusal shows of the request: `a4sx <its first argument>`, short and plain. */
function shownWhat(args: unknown): string {
  const first = Array.isArray(args) && typeof args[0] === "string" ? args[0] : "";
  const plain = first.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
  return plain ? `a4sx ${plain}` : DECK_TEXTS.unreadable;
}

export interface DeckWhere {
  platform?: NodeJS.Platform;
  /** The home folder a start's folder may be in (default: this user's). */
  home?: string;
  /** The window's workspace folders, which a start's folder may be in too (the person chose them). */
  folders?: readonly string[];
  /** The decks' channel folder: never a start's folder, nor inside one (a cell's sandbox could write into it). */
  channelRoot?: string;
}

/**
 * Review (a forged request picks the folder too): a start's folder is an existing folder inside the home folder or a
 * workspace folder (links resolved), that other users can't write to, and on Windows not on a network share. deck.py's
 * vscode_folder_ok is the same check, so the deck shows such a start as a command instead of asking.
 *
 * The check and the start's terminal are apart in time (the CLI check and a consent dialog may come between): a process
 * of the same user could swap the folder for a link meanwhile. Under this module's threat model that gains it nothing,
 * as it can run `a4sx launch` there itself.
 */
export function deckFolderOk(cwd: string, where: DeckWhere = {}): boolean {
  const platform = where.platform ?? process.platform;
  const abs = platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (cwd.length > 4096 || FOLDER_BAD.test(cwd) || !abs(cwd) || (platform === "win32" && /^[\\/]{2}/.test(cwd))) {
    return false;
  }
  try {
    const real = fs.realpathSync(cwd);
    const st = fs.statSync(real);
    if (!st.isDirectory() || (platform !== "win32" && (st.mode & 0o002) !== 0)) {
      return false;
    }
    if (where.channelRoot) {
      try {
        const up = path.relative(real, fs.realpathSync(where.channelRoot));
        if (up === "" || (up !== ".." && !up.startsWith(".." + path.sep) && !path.isAbsolute(up))) {
          return false;   // the channels' folder is this folder or inside it
        }
      } catch {
        // not made yet: nothing of ours in it
      }
    }
    const inside = (root: string) => {
      try {
        const rel = path.relative(fs.realpathSync(root), real);
        return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
      } catch {
        return false;
      }
    };
    return [where.home ?? os.homedir(), ...(where.folders ?? [])].some(inside);
  } catch {
    return false;
  }
}

/** One request file's text, checked: its nonce, a plain label, a folder deckFolderOk takes and a start on the allow-list. */
export function checkDeckRequest(text: string, nonce: string, where: DeckWhere = {}): DeckCheck {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, why: DECK_TEXTS.unreadable };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return { ok: false, why: DECK_TEXTS.unreadable };
  }
  const r = v as Record<string, unknown>;
  if (r.v !== 1 || typeof r.nonce !== "string" || !nonce || !sameNonce(r.nonce, nonce)) {
    return { ok: false, why: DECK_TEXTS.unreadable };
  }
  const args = deckLaunchArgs(r.args);
  const label = r.label;
  const cwd = r.cwd;
  if (!args || typeof label !== "string" || !LABEL.test(label) || typeof cwd !== "string") {
    return { ok: false, why: shownWhat(r.args) };
  }
  if (!deckFolderOk(cwd, where)) {
    return { ok: false, why: DECK_TEXTS.outsideHome };
  }
  return { ok: true, req: { label, cwd, args } };
}

/** At most `max` in any `windowMs`. */
export class RateLimit {
  private times: number[] = [];
  constructor(private readonly max = DECK_MAX_PER_MINUTE, private readonly windowMs = 60_000) {}
  allow(now: number): boolean {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.max) {
      return false;
    }
    this.times.push(now);
    return true;
  }
}

const REQUEST_NAME = /^req-\d{1,25}-\d{1,10}\.json$/;

/**
 * The request files in `dir`, oldest first, each read once and deleted. A file that isn't a plain file of this user,
 * or is too large, is deleted unread and counts as "" (unreadable). The deck's half-written files (a leading dot) wait.
 */
export function takeRequests(dir: string, uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => REQUEST_NAME.test(n)).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const p = path.join(dir, n);
    let text = "";
    try {
      text = readRequest(p, uid);
    } catch {
      continue;   // gone already
    }
    try {
      fs.unlinkSync(p);
    } catch {
      continue;   // not deleted: not taken (another reader has it)
    }
    out.push(text);
  }
  return out;
}

/**
 * Review (a file swapped after a check): opened once, never following a link and never waiting (a FIFO would block
 * the extension host), then checked on the open file: a plain file of this user, at most DECK_MAX_REQUEST_BYTES.
 * "" when it isn't one. Throws when it is gone.
 */
function readRequest(p: string, uid: number | undefined): string {
  const c = fs.constants;
  const flags = process.platform === "win32" ? c.O_RDONLY : c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(p, flags);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw e;
    }
    return "";   // a link (ELOOP), or anything else it can't open plainly
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > DECK_MAX_REQUEST_BYTES || (uid !== undefined && st.uid !== uid)) {
      return "";
    }
    const buf = Buffer.alloc(DECK_MAX_REQUEST_BYTES + 1);
    let n = 0;
    for (let got = -1; got !== 0 && n < buf.length;) {
      got = fs.readSync(fd, buf, n, buf.length - n, null);
      n += got;
    }
    return n > DECK_MAX_REQUEST_BYTES ? "" : buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function sha256File(p: string): string | undefined {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return undefined;
  }
}

/** The PATH key of this environment (on Windows it may be Path). */
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * The deck terminal's environment: the channel, the nonce, the a4sx CLI the extension uses (its folder first on PATH,
 * and its a4sx.py when there is one beside it), and herdr's variables removed (VS Code started from a herdr pane passes
 * them on; the deck would think it is in herdr).
 */
export function deckEnv(
  channel: string, nonce: string, cli: string, env: NodeJS.ProcessEnv = process.env, folders: readonly string[] = [], root = "",
): Record<string, string | null> {
  const out: Record<string, string | null> = {
    A4SX_DECK_HOST: "vscode", A4SX_DECK_CHANNEL: channel, A4SX_DECK_NONCE: nonce,
    HERDR_SOCKET_PATH: null, HERDR_PANE_ID: null,
    ...(folders.length ? { A4SX_DECK_FOLDERS: JSON.stringify(folders) } : {}),   // review: a ':' can be in a path
    ...(root ? { A4SX_DECK_ROOT: root } : {}),
  };
  if (path.isAbsolute(cli)) {   // review: a relative a4sx.cliPath would be a relative PATH entry
    const key = pathKey(env);
    out[key] = path.dirname(cli) + path.delimiter + (env[key] ?? "");
  }
  const py = path.join(path.dirname(cli), "a4sx.py");
  try {
    if (fs.statSync(py).isFile()) {
      out.DECK_A4SX_PY = py;
    }
  } catch {
    // no a4sx.py beside it: the deck finds the CLI on PATH
  }
  return out;
}

// --- the deck terminal ------------------------------------------------------------------------------

export interface DeckDeps {
  extensionPath: string;
  /** Asked first: false when the window isn't trusted (the user was told). */
  trusted(): Promise<boolean>;
  /** An absolute Python 3.10+, or undefined. */
  python(): Promise<string | undefined>;
  /** The a4sx CLI, or undefined (the user was told why). */
  cli(): Promise<string | undefined>;
  /** Opens the terminal of an accepted request. */
  start(req: DeckRequest): Promise<unknown>;
  log(line: string): void;
  platform?: NodeJS.Platform;
  now?(): number;
  /** Where the deck's private folders are made (the extension's own storage; default the temp folder). */
  channelRoot?: string;
  /** The home folder a start's folder may be in (tests). */
  home?: string;
  /** The window's workspace folders (file system paths). Read again for each request; the deck has them as they were when
   * it opened, so a folder added later is shown there as a command until the deck is opened again (review, a nit). */
  folders?(): readonly string[];
}

/** A deck's channel folder carries the pid of the extension host that made it (every window has its own host). */
const CHANNEL_NAME = /^a4sx-deck-(\d{1,10})-[A-Za-z0-9]{6}$/;

function hostAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";   // EPERM: it runs, as someone else
  }
}

/**
 * Follow-up (b): the folders of decks whose extension host is gone (a crash of VS Code), at activation. Review: the
 * storage folder is shared by every window, so another window's live deck is never touched: only a folder whose host's
 * pid no longer runs goes.
 */
export function removeStaleChannels(root: string | undefined, alive: (pid: number) => boolean = hostAlive): number {
  if (!root) {
    return 0;
  }
  let n = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = CHANNEL_NAME.exec(name);
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) {
      continue;
    }
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      n++;
    } catch {
      // the next activation tries again
    }
  }
  return n;
}

/** Review: a deck left from before an extension host restart has a dead folder; it is closed, not left as a second deck. */
export function closeStaleDecks(terminals: readonly vscode.Terminal[] = vscode.window.terminals ?? []): number {
  let n = 0;
  for (const t of terminals) {
    const env = (t.creationOptions as vscode.TerminalOptions | undefined)?.env;
    if (env && env.A4SX_DECK_HOST === "vscode" && env.A4SX_DECK_CHANNEL) {
      t.dispose();
      n++;
    }
  }
  return n;
}

export class Deck {
  terminal: vscode.Terminal | undefined;
  private dir: string | undefined;
  private nonce = "";
  private watcher: fs.FSWatcher | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly limit = new RateLimit();
  /** Review: refusals are logged each, but shown at most once a minute. */
  private readonly refusalToasts = new RateLimit(1);

  constructor(private readonly deps: DeckDeps) {}

  /** Opens the deck, or shows the one that is open (never a second deck: it would poll the server too). */
  async open(): Promise<vscode.Terminal | undefined> {
    if (this.terminal && this.terminal.exitStatus === undefined) {
      this.terminal.show();
      return this.terminal;
    }
    this.close();
    if (!(await this.deps.trusted())) {
      return undefined;
    }
    const file = path.join(this.deps.extensionPath, DECK_FILE);
    if (sha256File(file) !== DECK_SHA256) {
      void vscode.window.showErrorMessage(DECK_TEXTS.changed);
      return undefined;
    }
    const cli = await this.deps.cli();   // first: in a remote window it says why nothing runs here
    if (!cli) {
      return undefined;
    }
    const python = await this.deps.python();
    if (!python) {
      void vscode.window.showErrorMessage(DECK_TEXTS.noPython);
      return undefined;
    }
    if (this.terminal && this.terminal.exitStatus === undefined) {   // a second press while the first one asked
      this.terminal.show();
      return this.terminal;
    }
    const root = this.deps.channelRoot ?? os.tmpdir();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(root, `a4sx-deck-${process.pid}-`));   // 0700
    this.dir = dir;
    this.nonce = crypto.randomBytes(16).toString("hex");
    const location = (vscode as { TerminalLocation?: { Editor: number } }).TerminalLocation;
    this.terminal = vscode.window.createTerminal({
      name: DECK_TEXTS.terminal, shellPath: python, shellArgs: ["-I", file], cwd: os.homedir(),
      env: deckEnv(dir, this.nonce, cli, process.env, this.deps.folders?.() ?? [], root), isTransient: true, ...(location ? { location: location.Editor } : {}),
    } as vscode.TerminalOptions);
    this.terminal.show();
    try {
      this.watcher = fs.watch(dir, () => this.drain());
      this.watcher.on("error", () => undefined);
    } catch {
      // the scan below still finds them
    }
    this.timer = setInterval(() => {
      if (this.terminal && this.terminal.exitStatus !== undefined) {   // review: the deck ended (q), its tab stays
        this.close();
        return;
      }
      void this.drain();
    }, DECK_SCAN_MS);
    (this.timer as { unref?: () => void }).unref?.();
    return this.terminal;
  }

  /** VS Code closed a terminal: when it is the deck's, its folder goes. */
  closed(t: vscode.Terminal): void {
    if (t === this.terminal) {
      this.close();
    }
  }

  /** Requests are handled one at a time, in order. */
  drain(): Promise<void> {
    this.chain = this.chain.then(() => this.handle()).catch(() => undefined);
    return this.chain;
  }

  private async handle(): Promise<void> {
    const dir = this.dir;
    if (!dir) {
      return;
    }
    const now = () => this.deps.now?.() ?? Date.now();
    const time = () => new Date(now()).toISOString().slice(0, 19) + "Z";
    const nonce = this.nonce;
    for (const text of takeRequests(dir)) {
      if (dir !== this.dir) {
        return;   // the deck closed while a start ran: the rest of this batch is dropped with its folder
      }
      const c = checkDeckRequest(text, nonce, {
        platform: this.deps.platform, home: this.deps.home, folders: this.deps.folders?.(), channelRoot: this.deps.channelRoot ?? os.tmpdir(),
      });
      const say = (line: string, toast: string) => {
        this.deps.log(line);
        if (this.refusalToasts.allow(now())) {
          void vscode.window.showWarningMessage(toast);
        }
      };
      if (!c.ok) {
        say(DECK_TEXTS.logRefused(time(), c.why), DECK_TEXTS.refused(c.why));
        continue;
      }
      if (!this.limit.allow(now())) {
        say(DECK_TEXTS.logRefused(time(), `«${c.req.label}»: ${DECK_TEXTS.tooMany}`), DECK_TEXTS.tooMany);
        continue;
      }
      this.deps.log(DECK_TEXTS.logAccepted(time(), c.req.label, c.req.cwd, c.req.args));
      try {
        const opened = await this.deps.start(c.req);
        this.deps.log(opened ? DECK_TEXTS.logOpened(time(), c.req.label) : DECK_TEXTS.logNotOpened(time(), c.req.label));
      } catch (e) {
        this.deps.log(`${time()} deck: «${c.req.label}» didn't start: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private close(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = undefined;
    if (this.dir) {
      try {
        fs.rmSync(this.dir, { recursive: true, force: true });
      } catch {
        // a temp folder; the system clears it
      }
    }
    this.dir = undefined;
    this.nonce = "";
    this.terminal = undefined;
  }

  /** The extension stops (an update, a restart of its host): the deck goes with it, never left without its folder. */
  dispose(): void {
    const t = this.terminal;
    this.close();
    t?.dispose();
  }
}
