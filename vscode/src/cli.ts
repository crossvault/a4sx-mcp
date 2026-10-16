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

/**
 * Resolve the a4sx executable. A non-empty `configured` path (the `a4sx.cliPath` user setting) wins
 * and must point at an executable file; otherwise `a4sx` is looked up on PATH.
 */
export function findCli(configured: string | undefined, env: LookupEnv = {}): CliLookup {
  const platform = env.platform ?? process.platform;
  const home = env.homeDir ?? os.homedir();
  const want = (configured ?? "").trim();
  if (want) {
    const p = expandHome(want, home);
    return isExecutableFile(p, platform) ? { found: true, path: p } : { found: false, reason: "configured-path-invalid", configured: want };
  }
  const pathEnv = env.pathEnv ?? process.env.PATH ?? "";
  const exts = platform === "win32" ? ["", ...(env.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, CLI_NAME + ext);
      if (isExecutableFile(candidate, platform)) {
        return { found: true, path: candidate };
      }
    }
  }
  return { found: false, reason: "not-on-path" };
}
