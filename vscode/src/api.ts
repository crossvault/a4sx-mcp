// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The few a4sx HTTP calls the sidebar makes. No vscode import, so it is unit-tested with a fake fetch.
// Error messages are fixed strings: they never echo a token or a raw server body.

export const DEFAULT_SERVER = "https://session-exchange.com";
const TIMEOUT_MS = 15_000;

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ status: number; json(): Promise<unknown> }>;

export type ApiErrorCode =
  | "bad-server-url" | "unreachable" | "unauthorized" | "busy" | "expired" | "too-many-tokens"
  | "bad-login-url" | "bad-response" | "http";

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string, public readonly status?: number) {
    super(message);
  }
}

export const MESSAGES = {
  badServerUrl: "The a4sx.serverUrl setting must be an HTTPS address.",
  unreachable: "Can't reach a4sx. Check your connection and the a4sx.serverUrl setting.",
  unauthorized: "Your a4sx sign-in is no longer valid. Sign in again.",
  busy: "a4sx is busy right now. Try again in a minute.",
  expired: "The sign-in link expired. Sign in again.",
  tooManyTokens: "You have too many active a4sx agent keys. Revoke one on the a4sx website under Account › Agent keys, then sign in again.",
  badLoginUrl: "a4sx sent a sign-in link for a different site, so the extension did not open it.",
  badResponse: "a4sx sent an answer this extension doesn't understand. Update the extension or try again later.",
  http: (status: number) => `a4sx answered with an error (HTTP ${status}). Try again later.`,
} as const;

/** The server origin from the a4sx.serverUrl setting: https only (plain http only for this machine). */
export function normalizeServerUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim() || DEFAULT_SERVER;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ApiError("bad-server-url", MESSAGES.badServerUrl);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) || u.username || u.password) {
    throw new ApiError("bad-server-url", MESSAGES.badServerUrl);
  }
  return u.origin;
}

export interface Client {
  base: string;
  fetch: FetchLike;
  userAgent: string;
}

async function call(c: Client, path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": c.userAgent };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let res: { status: number; json(): Promise<unknown> };
  try {
    res = await c.fetch(`${c.base}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError("unreachable", MESSAGES.unreachable);
  }
  let data: any = undefined;
  try {
    data = await res.json();
  } catch {
    // A body that isn't JSON is judged by its status below.
  }
  return { status: res.status, data };
}

function errorCode(data: any): string | undefined {
  return typeof data?.error?.code === "string" ? data.error.code : undefined;
}

function fail(status: number): never {
  if (status === 401) {
    throw new ApiError("unauthorized", MESSAGES.unauthorized, status);
  }
  if (status === 429 || status === 503) {
    throw new ApiError("busy", MESSAGES.busy, status);
  }
  throw new ApiError("http", MESSAGES.http(status), status);
}

export interface SessionRow {
  id: string;
  title?: string;
  label?: string;
  created_at?: string;
  updated_at?: string;
  tokens?: { current?: number; peak?: number };
  harness?: string;
  versions?: number;
}

export async function listSessions(c: Client, token: string): Promise<SessionRow[]> {
  const { status, data } = await call(c, "/library/sessions", { token });
  if (status !== 200) {
    fail(status);
  }
  if (!Array.isArray(data?.sessions)) {
    throw new ApiError("bad-response", MESSAGES.badResponse, status);
  }
  return data.sessions.filter((s: any) => typeof s?.id === "string" && s.id);
}

export interface ListingRow {
  id: string;
  title?: string;
  tenant?: string;
  abstract?: string;
  description?: string;
  price_cents?: number;
  currency?: string;
  harness?: string;
}

export async function discover(c: Client, query: string, limit = 25): Promise<ListingRow[]> {
  const qs = new URLSearchParams({ q: query, limit: String(limit) }).toString();
  const { status, data } = await call(c, `/memory/discover?${qs}`);
  if (status !== 200) {
    fail(status);
  }
  if (!Array.isArray(data?.items)) {
    throw new ApiError("bad-response", MESSAGES.badResponse, status);
  }
  return data.items.filter((i: any) => typeof i?.id === "string" && i.id);
}

export interface LoginStart {
  code: string;
  userCode: string;
  loginUrl: string;
  expiresIn: number;
}

export const LOGIN_SCOPES = ["library:read"];
export const LOGIN_LABEL = "a4sx for VS Code";

export async function startLogin(c: Client): Promise<LoginStart> {
  const { status, data } = await call(c, "/auth/cli/start", {
    method: "POST",
    body: { token_type: "library", scopes: LOGIN_SCOPES, label: LOGIN_LABEL },
  });
  if (status !== 200) {
    fail(status);
  }
  if (typeof data?.code !== "string" || typeof data?.login_url !== "string" || typeof data?.user_code !== "string") {
    throw new ApiError("bad-response", MESSAGES.badResponse, status);
  }
  let login: URL;
  try {
    login = new URL(data.login_url);
  } catch {
    throw new ApiError("bad-login-url", MESSAGES.badLoginUrl);
  }
  if (login.origin !== c.base) {
    throw new ApiError("bad-login-url", MESSAGES.badLoginUrl);
  }
  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 600;
  return { code: data.code, userCode: data.user_code, loginUrl: login.toString(), expiresIn };
}

export type PollResult =
  | { status: "pending" | "awaiting_approval" | "retry" }
  | { status: "ok"; token: string; tokenId?: string; scopes: string[]; expiresAt?: string };

export async function pollLogin(c: Client, code: string): Promise<PollResult> {
  let r: { status: number; data: any };
  try {
    r = await call(c, `/auth/cli/poll?code=${encodeURIComponent(code)}`);
  } catch {
    return { status: "retry" };
  }
  const { status, data } = r;
  if (status === 202) {
    return { status: data?.status === "awaiting_approval" ? "awaiting_approval" : "pending" };
  }
  if (status === 200) {
    if (data?.status !== "ok" || typeof data?.token !== "string" || !data.token) {
      throw new ApiError("bad-response", MESSAGES.badResponse, status);
    }
    return {
      status: "ok",
      token: data.token,
      tokenId: typeof data.token_id === "string" ? data.token_id : undefined,
      scopes: Array.isArray(data.scopes) ? data.scopes.filter((s: unknown) => typeof s === "string") : LOGIN_SCOPES,
      expiresAt: typeof data.expires_at === "string" ? data.expires_at : undefined,
    };
  }
  if (status === 404) {
    throw new ApiError("expired", MESSAGES.expired, status);
  }
  if (status === 429 && errorCode(data) === "too_many_tokens") {
    throw new ApiError("too-many-tokens", MESSAGES.tooManyTokens, status);
  }
  if (status === 429 || status >= 500) {
    return { status: "retry" };
  }
  fail(status);
}

export function sessionWebUrl(base: string, id: string): string {
  return `${base}/library/session/${encodeURIComponent(id)}`;
}

export function listingWebUrl(base: string, row: { id: string; tenant?: string }): string {
  const t = row.tenant && row.tenant !== "default" ? `?t=${encodeURIComponent(row.tenant)}` : "";
  return `${base}/marketplace/${encodeURIComponent(row.id)}${t}`;
}
