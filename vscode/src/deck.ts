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
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export const CMD_OPEN_DECK = "a4sx.openDeck";
/** deck.py as bundled (a4sx-herdr-plugin 0.5.0); a file that isn't this one is not started. */
export const DECK_SHA256 = "220088e0079fc8c9a1630e4305e514f1e2d563490e73ab5dc7d018fab37fbf0b";
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
  tooMany: `The deck asked for more than ${DECK_MAX_PER_MINUTE} terminals within a minute, so this one wasn't opened.`,
  logOpened: (time: string, label: string, cwd: string, args: readonly string[]) => `${time} deck: opened «${label}» in ${cwd}: a4sx ${args.join(" ")}`,
  logRefused: (time: string, why: string) => `${time} deck: refused ${why}`,
};

// --- the check (the same shapes as deck.py's vscode_request_args) ----------------------------------

const CELL = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const SAVED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLAGS = ["--cell", "--new-session", "--a4sx-session"];
/** The flag sets of `a4sx launch` the deck sends, sorted and joined. */
const SHAPES = new Set(["--cell", "--cell --new-session", "--a4sx-session --cell", "--a4sx-session"]);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

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

/** One request file's text, checked: its nonce, a plain label, an existing absolute folder and a start on the allow-list. */
export function checkDeckRequest(
  text: string, nonce: string, isDir: (p: string) => boolean = isDirectory, platform: NodeJS.Platform = process.platform,
): DeckCheck {
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
  const abs = platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (!args || typeof label !== "string" || !label || label.length > 40 || CONTROL.test(label)
      || typeof cwd !== "string" || cwd.length > 4096 || CONTROL.test(cwd) || !abs(cwd) || !isDir(cwd)) {
    return { ok: false, why: shownWhat(r.args) };
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
      const st = fs.lstatSync(p);
      if (st.isFile() && st.size <= DECK_MAX_REQUEST_BYTES && (uid === undefined || st.uid === uid)) {
        text = fs.readFileSync(p, "utf8");
      }
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

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
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
export function deckEnv(channel: string, nonce: string, cli: string, env: NodeJS.ProcessEnv = process.env): Record<string, string | null> {
  const out: Record<string, string | null> = {
    A4SX_DECK_HOST: "vscode", A4SX_DECK_CHANNEL: channel, A4SX_DECK_NONCE: nonce,
    HERDR_SOCKET_PATH: null, HERDR_PANE_ID: null,
  };
  const key = pathKey(env);
  out[key] = path.dirname(cli) + path.delimiter + (env[key] ?? "");
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
  tmpdir?: string;
}

export class Deck {
  terminal: vscode.Terminal | undefined;
  private dir: string | undefined;
  private nonce = "";
  private watcher: fs.FSWatcher | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly limit = new RateLimit();

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
    const dir = fs.mkdtempSync(path.join(this.deps.tmpdir ?? os.tmpdir(), "a4sx-deck-"));   // 0700
    this.dir = dir;
    this.nonce = crypto.randomBytes(16).toString("hex");
    const location = (vscode as { TerminalLocation?: { Editor: number } }).TerminalLocation;
    this.terminal = vscode.window.createTerminal({
      name: DECK_TEXTS.terminal, shellPath: python, shellArgs: ["-I", file], cwd: os.homedir(),
      env: deckEnv(dir, this.nonce, cli), isTransient: true, ...(location ? { location: location.Editor } : {}),
    } as vscode.TerminalOptions);
    this.terminal.show();
    try {
      this.watcher = fs.watch(dir, () => this.drain());
      this.watcher.on("error", () => undefined);
    } catch {
      // the scan below still finds them
    }
    this.timer = setInterval(() => this.drain(), DECK_SCAN_MS);
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
    const time = () => new Date(this.deps.now?.() ?? Date.now()).toISOString().slice(0, 19) + "Z";
    for (const text of takeRequests(dir)) {
      if (dir !== this.dir) {
        return;
      }
      const c = checkDeckRequest(text, this.nonce, undefined, this.deps.platform);
      if (!c.ok) {
        this.deps.log(DECK_TEXTS.logRefused(time(), c.why));
        void vscode.window.showWarningMessage(DECK_TEXTS.refused(c.why));
        continue;
      }
      if (!this.limit.allow(this.deps.now?.() ?? Date.now())) {
        this.deps.log(DECK_TEXTS.logRefused(time(), `«${c.req.label}»: ${DECK_TEXTS.tooMany}`));
        void vscode.window.showWarningMessage(DECK_TEXTS.tooMany);
        continue;
      }
      this.deps.log(DECK_TEXTS.logOpened(time(), c.req.label, c.req.cwd, c.req.args));
      try {
        await this.deps.start(c.req);
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

  dispose(): void {
    this.close();
  }
}
