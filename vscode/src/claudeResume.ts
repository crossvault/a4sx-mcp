// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The Claude Code extension's resume link. The session is copied into Claude Code's history first
// (nativeSeed.ts); then this link opens it. Pure, no vscode import, so it is unit-testable.

export const CLAUDE_EXTENSION_ID = "anthropic.claude-code";

/** The canonical 8-4-4-4-12 hex form, nothing before or after it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A session id that may go into the link: exactly one UUID (surrounding whitespace allowed), or undefined. */
export function parseSessionId(text: string): string | undefined {
  const s = text.trim();
  return UUID.test(s) ? s : undefined;
}

/** `<scheme>://anthropic.claude-code/open?session=<id>`: the Claude Code extension's resume link. */
export function claudeResumeUri(uriScheme: string, sessionId: string): string {
  return `${uriScheme}://${CLAUDE_EXTENSION_ID}/open?session=${encodeURIComponent(sessionId)}`;
}
