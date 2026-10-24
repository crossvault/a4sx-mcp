// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Finding the user's installed a4sx CLI. Pure Node (no vscode import) so it is unit-testable.
// Nothing here downloads or installs anything: a missing CLI is reported, never fixed silently.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const CLI_NAME = "a4sx";

export type CliLookup =
  | { found: true; path: string }
  | { found: false; reason: "not-on-path" }
  | { found: false; reason: "configured-path-invalid"; configured: string };

export interface LookupEnv {
  /** The PATH value to search (process.env.PATH by default). */
  pathEnv?: string;
  /** The PATHEXT value (Windows only). */
  pathExt?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Directories tried after PATH (defaultFallbackDirs() by default). */
  fallbackDirs?: string[];
}

/**
 * Where the a4sx installer puts the CLI. A VS Code started from the dock or a menu often has a PATH
 * without these (the installer adds `~/.local/bin` only in the shell's rc file), so they are tried
 * after PATH. None on Windows. `home` is the home directory of the host the extension runs on: in a
 * remote window (SSH, WSL, containers) that is the remote user's home on the remote host.
 */
export function defaultFallbackDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === "win32") {
    return [];
  }
  return [path.join(home, ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin"];
}

function isExecutableFile(p: string, platform: NodeJS.Platform): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) {
      return false;
    }
    if (platform === "win32") {
      return true;
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(p: string, home: string): string {
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(home, p.slice(2));
  }
  return p;
}

/** Finds `name` on PATH, then in the fallback directories. */
function findOnPath(name: string, env: LookupEnv, platform: NodeJS.Platform, fallback: string[]): string | undefined {
  const pathEnv = env.pathEnv ?? process.env.PATH ?? "";
  const exts = platform === "win32" ? ["", ...(env.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of [...pathEnv.split(sep), ...fallback]) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate, platform)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Resolve the a4sx executable. A non-empty `configured` path (the `a4sx.cliPath` user setting) wins
 * and must point at an executable file; otherwise `a4sx` is looked up on PATH, then in the fallback
 * directories.
 */
export function findCli(configured: string | undefined, env: LookupEnv = {}): CliLookup {
  const platform = env.platform ?? process.platform;
  const home = env.homeDir ?? os.homedir();
  const want = (configured ?? "").trim();
  if (want) {
    const p = expandHome(want, home);
    return isExecutableFile(p, platform) ? { found: true, path: p } : { found: false, reason: "configured-path-invalid", configured: want };
  }
  const found = findOnPath(CLI_NAME, env, platform, env.fallbackDirs ?? defaultFallbackDirs(platform, home));
  return found ? { found: true, path: found } : { found: false, reason: "not-on-path" };
}

export const CLAUDE_NAME = "claude";

/**
 * Where Claude Code's own installers put `claude`, tried after PATH: the a4sx fallbacks plus
 * `~/.claude/local` (Claude Code's local install). None on Windows besides PATH.
 */
export function claudeFallbackDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === "win32") {
    return [];
  }
  return [...defaultFallbackDirs(platform, home), path.join(home, ".claude", "local")];
}

/** The `claude` command (Claude Code's CLI), found like a4sx: PATH, then the common install folders. */
export function findClaude(env: LookupEnv = {}): string | undefined {
  const platform = env.platform ?? process.platform;
  const home = env.homeDir ?? os.homedir();
  return findOnPath(CLAUDE_NAME, env, platform, env.fallbackDirs ?? claudeFallbackDirs(platform, home));
}
