// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Sign-in for the sidebar: the same browser device-login as `a4sx login`, collecting a scoped,
// read-only library token. The token lives only in VS Code's secret storage, bound to the server
// it was issued by; it is never written to settings, logs or messages.
import * as vscode from "vscode";
import { ApiError, Client, MESSAGES, pollLogin, startLogin } from "./api";

export const AUTH_ID = "a4sx";
export const AUTH_LABEL = "a4sx";
export const SECRET_KEY = "a4sx.auth";
/** The poll interval of `a4sx login`; tests shorten it. */
export const timing = { pollMs: 2000 };

interface Stored {
  token: string;
  server: string;
  id: string;
  scopes: string[];
  expiresAt?: string;
}

export interface LoginHooks {
  open(url: string): Promise<unknown>;
  report(message: string): void;
  cancelled(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const STEP_BROWSER = (userCode: string) => `Finish signing in in your browser. Check that it shows the code ${userCode}.`;
export const STEP_CONFIRM = (userCode: string) => `Confirm the code ${userCode} in your browser.`;

export class LoginCancelled extends Error {}

/** Runs the device login against `client.base` and returns the collected token. */
export async function deviceLogin(client: Client, hooks: LoginHooks): Promise<Stored> {
  const start = await startLogin(client);
  hooks.report(STEP_BROWSER(start.userCode));
  await hooks.open(start.loginUrl);
  const deadline = hooks.now() + start.expiresIn * 1000;
  while (hooks.now() < deadline) {
    if (hooks.cancelled()) {
      throw new LoginCancelled();
    }
    await hooks.sleep(timing.pollMs);
    if (hooks.cancelled()) {
      throw new LoginCancelled();
    }
    const r = await pollLogin(client, start.code);
    if (r.status === "ok") {
      return { token: r.token, server: client.base, id: r.tokenId ?? "a4sx", scopes: r.scopes, expiresAt: r.expiresAt };
    }
    if (r.status === "awaiting_approval") {
      hooks.report(STEP_CONFIRM(start.userCode));
    }
  }
  throw new ApiError("expired", MESSAGES.expired);
}

export class A4sxAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.changed.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly client: () => Client,
    private readonly login: (client: Client) => Promise<Stored>,
  ) {}

  private async read(): Promise<Stored | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      const s = JSON.parse(raw) as Stored;
      return typeof s.token === "string" && typeof s.server === "string" ? s : undefined;
    } catch {
      return undefined;
    }
  }

  private toSession(s: Stored): vscode.AuthenticationSession {
    return { id: s.id, accessToken: s.token, account: { id: s.id, label: new URL(s.server).host }, scopes: s.scopes };
  }

  /** The stored sign-in, if it was issued by the current server and has not expired. */
  async current(): Promise<Stored | undefined> {
    const s = await this.read();
    if (!s) {
      return undefined;
    }
    let base: string;
    try {
      base = this.client().base;
    } catch {
      return undefined;
    }
    if (s.server !== base) {
      return undefined;
    }
    if (s.expiresAt && Date.parse(s.expiresAt) <= Date.now()) {
      await this.clear();
      return undefined;
    }
    return s;
  }

  async token(): Promise<string | undefined> {
    return (await this.current())?.token;
  }

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    const s = await this.current();
    return s ? [this.toSession(s)] : [];
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    const stored = await this.login(this.client());
    const old = await this.read();
    await this.secrets.store(SECRET_KEY, JSON.stringify(stored));
    const session = this.toSession(stored);
    this.changed.fire({ added: [session], removed: old ? [this.toSession(old)] : [], changed: [] });
    return session;
  }

  async removeSession(): Promise<void> {
    await this.clear();
  }

  /** Forgets the token on this machine (sign-out, or a 401 from the server). */
  async clear(): Promise<void> {
    const old = await this.read();
    await this.secrets.delete(SECRET_KEY);
    if (old) {
      this.changed.fire({ added: [], removed: [this.toSession(old)], changed: [] });
    }
  }

  /** Another window signed in or out: pass it on. */
  notifyExternalChange(): void {
    this.changed.fire({ added: [], removed: [], changed: [] });
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** The real login: a cancellable progress notification around `deviceLogin`. */
export function vscodeLogin(client: Client): Promise<Stored> {
  return Promise.resolve(vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Signing in to a4sx", cancellable: true },
    (progress, cancel) => deviceLogin(client, {
      open: (url) => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))),
      report: (message) => progress.report({ message }),
      cancelled: () => cancel.isCancellationRequested,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    }),
  ));
}
