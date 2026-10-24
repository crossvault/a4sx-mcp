// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The command line typed into a normal terminal (the user's default shell, with its PATH, $SHELL and
// profile) for the resume terminals. Claude Code exits on its first run when started without a shell
// (0.3.1). Every piece is validated by the caller; here each one is quoted for the detected shell, and
// anything the shell can't take safely gives undefined, so the caller falls back to the shell-less spawn.
// Pure Node, no vscode import.
import * as path from "path";

export type ShellKind = "posix" | "fish" | "powershell" | "cmd";

/** The kind of the default shell (vscode.env.shell); undefined when it is unknown. */
export function shellKind(shell: string | undefined): ShellKind | undefined {
  if (!shell) {
    return undefined;
  }
  const base = shell.replace(/\\/g, "/").split("/").pop()!.toLowerCase().replace(/\.exe$/, "");
  if (["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"].includes(base)) {
    return "posix";
  }
  if (base === "fish") {
    return "fish";
  }
  if (base === "pwsh" || base === "powershell") {
    return "powershell";
  }
  if (base === "cmd") {
    return "cmd";
  }
  return undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

/** One argument quoted for the shell, or undefined when it can't be passed safely there. */
export function quoteArg(arg: string, kind: ShellKind): string | undefined {
  if (CONTROL.test(arg)) {
    return undefined;
  }
  switch (kind) {
    case "posix":
      // '…' takes everything literally; a ' ends the quote, is escaped, and the quote reopens.
      return `'${arg.replace(/'/g, "'\\''")}'`;
    case "fish":
      // fish reads \\ and \' inside '…' as escapes.
      return `'${arg.replace(/[\\']/g, (c) => `\\${c}`)}'`;
    case "powershell":
      // In a single-quoted PowerShell string only a single quote is special, written twice; PowerShell
      // also takes the typographic single quotes (U+2018-U+201B) as one.
      return `'${arg.replace(/['\u2018\u2019\u201a\u201b]/g, (c) => c + c)}'`;
    case "cmd":
      // cmd.exe has no full quoting: refuse anything it would still expand inside "…".
      return /["%^!&|<>]/.test(arg) ? undefined : `"${arg}"`;
  }
}

/** The whole command line, or undefined when any piece can't be passed safely. */
export function commandLine(exe: string, args: readonly string[], kind: ShellKind): string | undefined {
  const parts = [exe, ...args].map((a) => quoteArg(a, kind));
  if (parts.some((p) => p === undefined)) {
    return undefined;
  }
  // PowerShell runs a quoted program only with the call operator.
  return kind === "powershell" ? `& ${parts.join(" ")}` : parts.join(" ");
}

/**
 * The program as typed: the bare name when it was found in a PATH folder (the shell then finds it
 * the same way), else its absolute path (a fallback folder such as ~/.claude/local).
 */
export function programName(found: string, name: string, pathEnv: string = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform): string {
  const sep = platform === "win32" ? ";" : ":";
  const p = platform === "win32" ? path.win32 : path.posix;
  const dir = p.dirname(found);
  const base = p.basename(found).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
  const norm = (d: string) => (platform === "win32" ? d.toLowerCase() : d).replace(/[\\/]+$/, "");
  const onPath = pathEnv.split(sep).filter(Boolean).some((d) => norm(d) === norm(dir));
  return onPath && base === name ? name : found;
}

/** A saved session's id as the CLI resolves it in `--a4sx-session=` (never the free-text label). */
export const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
