// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.9.0: the Claude sessions of VS Code's Agents window, found on this computer. The Agents window runs Claude through
// VS Code's agent host, which loads the Claude Agent SDK (TypeScript) in process; the SDK runs the Claude Code program
// it bundles. That program files the session like any other: <Claude config dir>/projects/<folder>/<session id>.jsonl,
// the store `claude --resume <id>` reads, and the SDK marks its records `"entrypoint":"sdk-ts"`. VS Code gives
// extensions no stable API for those sessions (its session menus and lists are proposed API), so they are found by that
// mark. Other programs built on the TypeScript SDK write the same mark, so the list says "Agent SDK sessions" and the
// user confirms the one they mean. From a transcript only its start (entrypoint, folder, first prompt) and its title
// records are read; nothing is kept or logged. Pure Node, no vscode import.
import * as fs from "fs";
import { transcriptCwd } from "./localSession";
import { claudeProjectsDir } from "./nativeSeed";
import { firstPrompt, PROMPT_HEAD_BYTES, readTitle, RecentSession, listTranscripts } from "./tabSession";

/** The entrypoint the TypeScript Claude Agent SDK writes into its sessions' records (VS Code's agent host uses it). */
export const SDK_TS_ENTRYPOINT = "sdk-ts";
/** How many of the newest transcripts are looked at. */
export const AGENT_SCAN_MAX = 300;
/** How many Agent SDK sessions are listed at most. */
export const AGENT_LIST_MAX = 50;

/** The `entrypoint` of the first record in a transcript's head that names one, or undefined. */
export function transcriptEntrypoint(head: string): string | undefined {
  for (const line of head.split(/\r?\n/).slice(0, 200)) {
    if (!line.includes("\"entrypoint\"")) {
      continue;
    }
    try {
      const r = JSON.parse(line);
      if (r && typeof r.entrypoint === "string") {
        return r.entrypoint;
      }
    } catch {
      // a line cut at the head's end, or not JSON: the next one
    }
  }
  return undefined;
}

/** An Agent SDK session: a RecentSession with the folder it ran in, as its transcript names it. */
export interface AgentSession extends RecentSession {
  cwd?: string;
}

async function readHead(file: string): Promise<string> {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(PROMPT_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PROMPT_HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * The newest sessions of the TypeScript Agent SDK on this computer (the Agents window's Claude sessions among them),
 * newest first: at most `max`, from the newest `scan` transcripts. Each with its title, first prompt and folder when
 * its transcript has them.
 */
export async function agentSdkSessions(projectsDir: string = claudeProjectsDir(), max: number = AGENT_LIST_MAX, scan: number = AGENT_SCAN_MAX): Promise<AgentSession[]> {
  const out: AgentSession[] = [];
  for (const t of (await listTranscripts(projectsDir)).slice(0, Math.max(0, scan))) {
    if (out.length >= max) {
      break;
    }
    let head: string;
    try {
      head = await readHead(t.file);
    } catch {
      continue;
    }
    if (transcriptEntrypoint(head) !== SDK_TS_ENTRYPOINT) {
      continue;
    }
    const title = await readTitle(t);
    const prompt = firstPrompt(head);
    const cwd = transcriptCwd(head);
    out.push({ sessionId: t.sessionId, folder: t.folder, file: t.file, mtime: t.mtime, ...(title ? { title } : {}), ...(prompt ? { firstPrompt: prompt } : {}), ...(cwd ? { cwd } : {}) });
  }
  return out;
}
