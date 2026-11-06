// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Installing the a4sx CLI into the extension's own storage, without a shell and without a PATH change:
// the CLI's files are downloaded from the a4sx server (the same files install.sh / install.ps1 fetch),
// each checked against the sha256 the server sends with it, and a small launcher next to them runs the
// CLI with a Python 3.10+ found on this machine. Nothing downloaded is ever piped into a shell, and a
// file whose hash doesn't match never replaces anything. Also: running the CLI with an argv array (the
// Windows .cmd launcher through cmd.exe, quoted), and finding the Claude Code extension's bundled `claude`.
// Pure Node, no vscode import.
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { quoteArg } from "./terminalCommand";

/** The CLI file and its sibling, as collector/routes/cli_install.py serves them (`/cli/<name>`). */
export const CLI_FILES: readonly { name: string; required: boolean }[] = [
  { name: "a4sx.py", required: true },
  // The ipc-proxy: optional, as in the installers. The CLI checks it against its own pin before use.
  { name: "ipc_proxy.py", required: false },
];
export const SHA_HEADER = "x-a4sx-sha256";
export const MIN_PYTHON = [3, 10] as const;
export const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
/** A download larger than this is refused (the CLI is about 1 MB). */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** True when `header` is a sha256 hex digest and the body hashes to it. */
export function hashMatches(data: Uint8Array, header: string | null | undefined): boolean {
  const want = (header ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(want) && sha256Hex(data) === want;
}

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponse>;

export class ProvisionError extends Error {
  constructor(message: string, public readonly kind: "network" | "hash" | "write" | "python" | "unsafe-path") {
    super(message);
  }
}

export const PROVISION_TEXTS = {
  network: (file: string, detail: string) => `Could not download ${file} from the a4sx server (${detail}).`,
  hash: (file: string) => `The downloaded ${file} doesn't match the checksum the a4sx server sent with it. Nothing was installed.`,
  write: (detail: string) => `Could not save the a4sx CLI in the extension's storage (${detail}).`,
  unsafePath: "The path of Python or of the extension's storage contains characters a launcher can't hold safely.",
  tooBig: (file: string) => `The downloaded ${file} is larger than expected. Nothing was installed.`,
};

function writeAtomic(target: string, data: Uint8Array, mode: number): void {
  const part = `${target}.${process.pid}.${Date.now()}.part`;
  fs.writeFileSync(part, data, { mode, flag: "wx" });
  try {
    fs.renameSync(part, target);
  } catch (e) {
    try {
      fs.unlinkSync(part);
    } catch {
      // already gone
    }
    throw e;
  }
}

/**
 * Downloads the CLI's files from `base` (an https origin) into `dir`. Every file is fetched and checked
 * first; only when all required ones match their x-a4sx-sha256 is anything written, each through a
 * temporary file and a rename. Resolves the CLI's version (`__version__`), or "?".
 */
export async function downloadCli(base: string, dir: string, fetchFn: Fetch, timeoutMs = 60_000): Promise<string> {
  const got: { name: string; data: Uint8Array }[] = [];
  for (const f of CLI_FILES) {
    let res: FetchResponse;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      res = await fetchFn(`${base}/cli/${f.name}`, { headers: { "user-agent": "a4sx-vscode" }, signal: ctl.signal });
      if (res.status !== 200) {
        clearTimeout(timer);
        if (!f.required) {
          continue;
        }
        throw new ProvisionError(PROVISION_TEXTS.network(f.name, `HTTP ${res.status}`), "network");
      }
      const data = new Uint8Array(await res.arrayBuffer());
      clearTimeout(timer);
      if (data.byteLength === 0 || data.byteLength > MAX_FILE_BYTES) {
        throw new ProvisionError(PROVISION_TEXTS.tooBig(f.name), "hash");
      }
      if (!hashMatches(data, res.headers.get(SHA_HEADER))) {
        throw new ProvisionError(PROVISION_TEXTS.hash(f.name), "hash");
      }
      got.push({ name: f.name, data });
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof ProvisionError) {
        throw e;
      }
      if (!f.required) {
        continue;
      }
      throw new ProvisionError(PROVISION_TEXTS.network(f.name, e instanceof Error ? e.message : String(e)), "network");
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const g of got) {
      writeAtomic(path.join(dir, g.name), g.data, 0o644);
    }
  } catch (e) {
    throw new ProvisionError(PROVISION_TEXTS.write(e instanceof Error ? e.message : String(e)), "write");
  }
  const cli = got.find((g) => g.name === CLI_FILES[0].name)!;
  const m = /^__version__\s*=\s*"([^"]{1,32})"/m.exec(Buffer.from(cli.data).toString("utf8"));
  return m ? m[1] : "?";
}

/** The launcher's file name: a .cmd on Windows (cmd.exe runs it), an sh script elsewhere. */
export function launcherName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "a4sx.cmd" : "a4sx";
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * The launcher's text: it runs `<python> <dir>/a4sx.py <args>`. Both paths are quoted for the launcher's
 * own language; undefined when a path can't be held safely (a `"` or `%` in a .cmd, a control character).
 */
export function launcherText(python: string, dir: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "win32") {
    const script = path.win32.join(dir, CLI_FILES[0].name);
    if ([python, script].some((p) => CONTROL.test(p) || /["%]/.test(p))) {
      return undefined;
    }
    // Inside "…" a .cmd file takes & | < > ^ literally; % is refused above, and delayed expansion is off.
    return `@echo off\r\n"${python}" "${script}" %*\r\n`;
  }
  const script = path.posix.join(dir, CLI_FILES[0].name);
  const py = quoteArg(python, "posix");
  const sc = quoteArg(script, "posix");
  if (!py || !sc) {
    return undefined;
  }
  return `#!/bin/sh\n# a4sx CLI launcher, written by the a4sx VS Code extension.\nexec ${py} ${sc} "$@"\n`;
}

export function writeLauncher(python: string, dir: string, platform: NodeJS.Platform = process.platform): string {
  const text = launcherText(python, dir, platform);
  if (!text) {
    throw new ProvisionError(PROVISION_TEXTS.unsafePath, "unsafe-path");
  }
  const target = path.join(dir, launcherName(platform));
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(target, Buffer.from(text, "utf8"), 0o755);
    if (platform !== "win32") {
      fs.chmodSync(target, 0o755);
    }
  } catch (e) {
    throw new ProvisionError(PROVISION_TEXTS.write(e instanceof Error ? e.message : String(e)), "write");
  }
  return target;
}

/** The installed launcher in `dir`, when the CLI file is there too. */
export function installedLauncher(dir: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!dir) {
    return undefined;
  }
  const launcher = path.join(dir, launcherName(platform));
  try {
    return fs.statSync(launcher).isFile() && fs.statSync(path.join(dir, CLI_FILES[0].name)).isFile() ? launcher : undefined;
  } catch {
    return undefined;
  }
}

// --- Python ---------------------------------------------------------------------------------------

/** Prints sys.executable when the interpreter is new enough, else nothing. */
export const PYTHON_PROBE = `import sys; print(sys.executable if sys.version_info >= (${MIN_PYTHON[0]}, ${MIN_PYTHON[1]}) else '')`;

/** Runs a program with an argv array (never a shell); resolves its exit code and stdout. */
export type Runner = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;

/**
 * The Python commands to try, as install.ps1 does on Windows: the py launcher, python, python3, then
 * the per-user folders a fresh `winget install Python.Python.3.1x` uses (the extension host's PATH
 * doesn't change until VS Code restarts), then the all-users folders in %ProgramFiles%; newest first in
 * each. Elsewhere python3, then python.
 */
export function pythonCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env, listDir: (d: string) => string[] = safeList): string[][] {
  if (platform !== "win32") {
    return [["python3"], ["python"]];
  }
  const out: string[][] = [["py", "-3"], ["python"], ["python3"]];
  const roots = [env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", "Python"), env.ProgramFiles];
  for (const root of roots) {
    if (root) {
      const dirs = listDir(root).filter((d) => /^Python3\d{1,2}$/i.test(d)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
      out.push(...dirs.map((d) => [path.win32.join(root, d, "python.exe")]));
    }
  }
  return out;
}

function safeList(d: string): string[] {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

/**
 * The Microsoft Store build of Python, by its real path (sys.executable), as install.ps1 and the CLI tell it:
 * it keeps what it writes under AppData in its own package folder, where Claude Code can't see it, so the
 * CLI refuses to run with it. An alias in WindowsApps that resolves elsewhere (e.g. the python.org install
 * manager's) is not the Store build.
 */
export const STORE_PYTHON = /\\(WindowsApps|Packages)\\PythonSoftwareFoundation\.Python\.[0-9]/i;

export function isStorePython(exe: string): boolean {
  return STORE_PYTHON.test(exe);
}

/** What the search found: a Python the CLI can use, only the Store build, or none at all. */
export type PythonSearch = { kind: "found"; exe: string } | { kind: "store-only"; exe: string } | { kind: "none" };

/**
 * The first Python 3.10+ that answers the probe and isn't the Store build: its sys.executable (an absolute
 * path, so the launcher doesn't depend on PATH). The Store's install stub fails the probe; a full Store
 * install answers it and is skipped by its path, and the search goes on.
 */
export async function searchPython(run: Runner, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, listDir?: (d: string) => string[]): Promise<PythonSearch> {
  let store: string | undefined;
  for (const [cmd, ...rest] of pythonCandidates(platform, env, listDir)) {
    let r: { code: number | null; stdout: string };
    try {
      r = await run(cmd, [...rest, "-c", PYTHON_PROBE], 15_000);
    } catch {
      continue;
    }
    const exe = r.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
    const isAbs = platform === "win32" ? path.win32.isAbsolute(exe) : path.posix.isAbsolute(exe);
    if (r.code === 0 && exe && isAbs && !CONTROL.test(exe)) {
      if (!isStorePython(exe)) {
        return { kind: "found", exe };
      }
      store ??= exe;
    }
  }
  return store ? { kind: "store-only", exe: store } : { kind: "none" };
}

/** searchPython's Python, or undefined (none, or only the Store build). */
export async function findPython(run: Runner, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, listDir?: (d: string) => string[]): Promise<string | undefined> {
  const r = await searchPython(run, platform, env, listDir);
  return r.kind === "found" ? r.exe : undefined;
}

/**
 * True when the extension's own launcher in `dir` runs a Store Python (written by 0.5.0 or older). Cheap:
 * it reads the launcher's few bytes, nothing is run.
 */
export function launcherUsesStorePython(dir: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  const launcher = installedLauncher(dir, platform);
  if (!launcher) {
    return false;
  }
  try {
    return isStorePython(fs.readFileSync(launcher, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Repairs the extension's own launcher when it runs a Store Python: rewrites it with the Python the search
 * finds. "ok": nothing to repair (no launcher, or a good one); "repaired"; else why it can't be: only the
 * Store build ("store-only") or no Python at all ("none"). Throws writeLauncher's ProvisionError when the
 * launcher can't be written; it then stays as it was.
 */
export async function repairLauncher(
  dir: string | undefined, run: Runner, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, listDir?: (d: string) => string[],
): Promise<"ok" | "repaired" | "store-only" | "none"> {
  if (!dir || !launcherUsesStorePython(dir, platform)) {
    return "ok";
  }
  const found = await searchPython(run, platform, env, listDir);
  if (found.kind !== "found") {
    return found.kind;
  }
  writeLauncher(found.exe, dir, platform);
  return "repaired";
}

export const WINGET_PYTHON_ARGS: readonly string[] = ["install", "Python.Python.3.12"];

// --- running the CLI without a shell --------------------------------------------------------------

export interface ExecSpec {
  file: string;
  args: string[];
  /** Windows only: pass `args` to cmd.exe exactly as built (they are quoted here). */
  verbatim: boolean;
}

/**
 * How to run `cli args` with child_process.execFile and no shell. A Windows .cmd/.bat (the launcher, or
 * an installed a4sx.cmd) can't be spawned directly (Node refuses since CVE-2024-27980), so it goes through
 * `cmd.exe /d /s /c "<quoted line>"`, every piece quoted for cmd; undefined when a piece can't be.
 */
export function execSpec(cli: string, args: readonly string[], platform: NodeJS.Platform = process.platform, comspec: string = process.env.ComSpec || "cmd.exe"): ExecSpec | undefined {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(cli)) {
    return { file: cli, args: [...args], verbatim: false };
  }
  const parts = [cli, ...args].map((a) => quoteArg(a, "cmd"));
  if (parts.some((p) => p === undefined)) {
    return undefined;
  }
  return { file: comspec, args: ["/d", "/s", "/c", `"${parts.join(" ")}"`], verbatim: true };
}

export function updateDue(last: unknown, now: number): boolean {
  return typeof last !== "number" || !Number.isFinite(last) || now - last >= UPDATE_EVERY_MS || last > now;
}

/** `a4sx update`, with `--base` only for a server other than the default (the CLI's own default). */
export function updateArgs(base: string, defaultBase: string): string[] {
  return base.replace(/\/+$/, "") === defaultBase.replace(/\/+$/, "") ? ["update"] : ["update", "--base", base];
}

// --- the Claude Code extension's bundled claude -------------------------------------------------

/**
 * The `claude` binary the Claude Code extension ships (`resources/native-binary/claude[.exe]`), when it is
 * there. Passed to the CLI as A4SX_CLAUDE, so a cell starts the same Claude Code the panel uses.
 */
export function bundledClaude(extensionPath: string | undefined, platform: NodeJS.Platform = process.platform, isFile: (p: string) => boolean = fileExists): string | undefined {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!extensionPath || !p.isAbsolute(extensionPath)) {
    return undefined;
  }
  const dir = p.join(extensionPath, "resources", "native-binary");
  const names = platform === "win32" ? ["claude.exe", "claude"] : ["claude"];
  for (const n of names) {
    const candidate = p.join(dir, n);
    if (!CONTROL.test(candidate) && isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
