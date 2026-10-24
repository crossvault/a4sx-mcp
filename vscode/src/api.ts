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
  | "bad-login-url" | "bad-response" | "http"
  | "bad-scopes" | "insufficient-scope" | "not-supported" | "rejected" | "profile-limit" | "not-found"
  | "cancelled" | "not-claude-code" | "no-transcript"
  | "credential-in-profile" | "hidden-bound-to-host" | "base-url-needs-signin" | "permission-flag-needs-signin" | "needs-signin" | "conflict";

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status?: number,
    /** For "insufficient-scope": the scope the server says the route needs. */
    public readonly requiredScope?: string,
  ) {
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
  needsScope: (scope: string) => `This needs the a4sx permission ${scope}.`,
  profilesNotSupported: "Launch profiles need a newer a4sx server.",
  foldersNotSupported: "Folders need a newer a4sx server.",
  profileRejected: "a4sx did not accept this launch profile.",
  credentialInProfile: "Keep keys out of launch profiles. Use a4sx launch --set-api-key instead.",
  needsSignin: "This setting can only be changed with the a4sx CLI or on the website.",
  baseUrlNeedsSignin: "The server address can only be changed with the a4sx CLI or on the website.",
  permissionFlagNeedsSignin: "Turning off permission prompts can only be done with the a4sx CLI or on the website.",
  hiddenBoundToHost: "This profile's hidden settings belong to its current address. Change the address with the a4sx CLI or on the website.",
  folderRejected: "a4sx did not accept this folder name.",
  profileLimit: "You have the maximum number of launch profiles. Delete one first.",
  profileGone: "This launch profile no longer exists. Refresh the list.",
  sessionGone: "This session no longer exists. Refresh the list.",
  noTranscript: "This saved session has no transcript to resume.",
  notClaudeCode: "Only Claude Code sessions can be resumed.",
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

async function call(
  c: Client, path: string, opts: { method?: string; token?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ status: number; data: any }> {
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
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS)])
        : AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
  } catch {
    if (opts.signal?.aborted) {
      throw new ApiError("cancelled", MESSAGES.unreachable);
    }
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
  tags?: string[];
  /** One folder path such as "work/a4sx", or null when unfiled. Servers before folders send no key at all. */
  folder?: string | null;
  created_at?: string;
  updated_at?: string;
  tokens?: { current?: number; peak?: number };
  harness?: string | { id?: string };
  versions?: number;
  version?: string;
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

export const SCOPE_READ = "library:read";
export const SCOPE_ORGANIZE = "library:organize";
export const SCOPE_PROFILES_READ = "profiles:read";
export const SCOPE_PROFILES_WRITE = "profiles:write";
/** What sign-in asks for. `profiles:write` is asked for separately, the first time a profile is changed. */
export const LOGIN_SCOPES = [SCOPE_READ, SCOPE_PROFILES_READ, SCOPE_ORGANIZE];
/** What sign-in falls back to when the server does not offer the newer scopes. */
export const LEGACY_LOGIN_SCOPES = [SCOPE_READ];
export const LOGIN_LABEL = "a4sx for VS Code";

export async function startLogin(c: Client, scopes: readonly string[] = LOGIN_SCOPES): Promise<LoginStart> {
  const { status, data } = await call(c, "/auth/cli/start", {
    method: "POST",
    body: { token_type: "library", scopes: [...scopes], label: LOGIN_LABEL },
  });
  if (status === 400 && errorCode(data) === "bad_scopes") {
    // A server that doesn't offer one of these scopes yet.
    throw new ApiError("bad-scopes", MESSAGES.badResponse, status);
  }
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
  | { status: "ok"; token: string; tokenId?: string; scopes?: string[]; expiresAt?: string };

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
      scopes: Array.isArray(data.scopes) ? data.scopes.filter((s: unknown) => typeof s === "string") : undefined,
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

/**
 * The refusals of a route that a scoped key may lack, or that an older server doesn't have:
 * a 403 naming `required_scope` is "insufficient-scope" (the caller can offer a new sign-in);
 * any other 401/403, and a 404/405 for the route itself, mean the server doesn't offer it yet.
 */
function scopedFail(status: number, data: any, notSupported: string): never {
  const code = errorCode(data);
  const need = data?.error?.details?.required_scope;
  if (status === 403 && code === "insufficient_scope" && typeof need === "string" && need) {
    throw new ApiError("insufficient-scope", MESSAGES.needsScope(need), status, need);
  }
  if (status === 401 || status === 403 || status === 405 || (status === 404 && code !== "no_such_profile")) {
    throw new ApiError("not-supported", notSupported, status);
  }
  fail(status);
}

/** The non-secret fields of a launch profile. The server never stores an API key in one. */
export interface Profile {
  name?: string;
  harness?: string;
  model?: string;
  base_url?: string;
  flags?: string[];
  /** Newer servers: how many credential-like header entries and flags were left out of this answer. */
  hidden_fields?: number;
  [field: string]: unknown;
}

/** Stands for a hidden value on screen; it is never sent. */
export const MASK = "••••";
const SERVER_MESSAGE_MAX = 200;

/**
 * A server refusal's text, shown as sent but on one short line. If it is missing, or contains any
 * value that was submitted, `fallback` is used instead, so a key is never echoed.
 */
export function serverLine(data: any, submitted: readonly string[], fallback: string): string {
  const raw = data?.error?.message;
  if (typeof raw !== "string") {
    return fallback;
  }
  let line = raw.split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
  if (!line || submitted.some((v) => v.length >= 4 && raw.includes(v))) {
    return fallback;
  }
  if (line.length > SERVER_MESSAGE_MAX) {
    line = `${line.slice(0, SERVER_MESSAGE_MAX - 1)}…`;
  }
  return line;
}

/** Every string value a profile body carries (flags, header values, fields), for the echo check. */
function submittedValues(p: Profile): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      out.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(p);
  return out;
}

export interface ProfilesState {
  profiles: [string, Profile][];
  default: string | null;
}

/** A write's reply: the list, or undefined for a bare `{"ok": true, ...}` (a key that may write but not read). */
function writeReply(status: number, data: any): ProfilesState | undefined {
  if (data && data.ok === true && !("profiles" in data)) {
    return undefined;
  }
  return profilesState(status, data);
}

function profilesState(status: number, data: any): ProfilesState {
  if (!data || typeof data.profiles !== "object" || data.profiles === null || Array.isArray(data.profiles)) {
    throw new ApiError("bad-response", MESSAGES.badResponse, status);
  }
  const profiles = Object.entries(data.profiles as Record<string, unknown>)
    .filter(([id, p]) => PROFILE_ID.test(id) && typeof p === "object" && p !== null && !Array.isArray(p)) as [string, Profile][];
  const def = typeof data.default === "string" && profiles.some(([id]) => id === data.default) ? data.default : null;
  return { profiles, default: def };
}

/** The server's rule for a profile id. */
export const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export async function listProfiles(c: Client, token: string): Promise<ProfilesState> {
  const { status, data } = await call(c, "/library/profiles", { token });
  if (status !== 200) {
    scopedFail(status, data, MESSAGES.profilesNotSupported);
  }
  return profilesState(status, data);
}

function profileWriteFail(status: number, data: any, submitted: readonly string[] = []): never {
  const code = errorCode(data);
  if (status === 400 && code === "credential_in_profile") {
    throw new ApiError("credential-in-profile", serverLine(data, submitted, MESSAGES.credentialInProfile), status);
  }
  if (status === 409 && code === "needs_signin") {
    throw new ApiError("needs-signin", serverLine(data, submitted, MESSAGES.needsSignin), status);
  }
  if (status === 409 && code === "base_url_needs_signin") {
    throw new ApiError("base-url-needs-signin", serverLine(data, submitted, MESSAGES.baseUrlNeedsSignin), status);
  }
  if (status === 409 && code === "permission_flag_needs_signin") {
    throw new ApiError("permission-flag-needs-signin", serverLine(data, submitted, MESSAGES.permissionFlagNeedsSignin), status);
  }
  if (status === 409 && code === "hidden_fields_bound_to_host") {
    throw new ApiError("hidden-bound-to-host", serverLine(data, submitted, MESSAGES.hiddenBoundToHost), status);
  }
  if (status === 429 && code === "profile_limit") {
    throw new ApiError("profile-limit", serverLine(data, submitted, MESSAGES.profileLimit), status);
  }
  if (status === 404 && code === "no_such_profile") {
    throw new ApiError("not-found", MESSAGES.profileGone, status);
  }
  // Any other refusal: the server's own line (a key may change less than an account can).
  if (status === 409) {
    throw new ApiError("conflict", serverLine(data, submitted, MESSAGES.needsSignin), status);
  }
  if (status === 400) {
    throw new ApiError("rejected", serverLine(data, submitted, MESSAGES.profileRejected), status);
  }
  scopedFail(status, data, MESSAGES.profilesNotSupported);
}

function profilePath(id: string, suffix = ""): string {
  if (!PROFILE_ID.test(id)) {
    throw new ApiError("rejected", MESSAGES.profileRejected);
  }
  return `/library/profiles/${encodeURIComponent(id)}${suffix}`;
}

export async function putProfile(c: Client, token: string, id: string, profile: Profile): Promise<ProfilesState | undefined> {
  // `hidden_fields` is the server's count, not a field; the server keeps the hidden entries itself.
  const { hidden_fields: _hidden, ...body } = profile;
  const values = submittedValues(body);
  if (values.some((v) => v.includes(MASK))) {
    throw new ApiError("rejected", MESSAGES.profileRejected);   // a masked value is never written back
  }
  const { status, data } = await call(c, profilePath(id), { method: "PUT", token, body });
  if (status !== 200) {
    profileWriteFail(status, data, values);
  }
  return writeReply(status, data);
}

export async function deleteProfile(c: Client, token: string, id: string): Promise<ProfilesState | undefined> {
  const { status, data } = await call(c, profilePath(id), { method: "DELETE", token });
  if (status !== 200) {
    profileWriteFail(status, data);
  }
  return writeReply(status, data);
}

/** Files a saved session in `folder`, or takes it out of its folder (null). */
export async function setSessionFolder(c: Client, token: string, id: string, folder: string | null): Promise<void> {
  const { status, data } = await call(c, `/library/session/${encodeURIComponent(id)}/meta`, { method: "POST", token, body: { folder } });
  if (status === 200) {
    return;
  }
  if (status === 400) {
    throw new ApiError("rejected", MESSAGES.folderRejected, status);
  }
  if (status === 404) {
    // The meta route exists on every server, so a 404 is about the session.
    throw new ApiError("not-found", MESSAGES.sessionGone, status);
  }
  scopedFail(status, data, MESSAGES.foldersNotSupported);
}

/** Sign-out and step-up never wait longer than this for the revoke call. */
export const REVOKE_TIMEOUT_MS = 5_000;

export type RevokeResult = "revoked" | "unsupported" | "failed";

/**
 * Revokes the calling library key (`POST /library/keys/self/revoke`), best-effort: never throws.
 * "unsupported" is a server without the route (404/405); "failed" is any other answer or no answer.
 */
export async function revokeKey(c: Client, token: string): Promise<RevokeResult> {
  try {
    const { status, data } = await call(c, "/library/keys/self/revoke", { method: "POST", token, timeoutMs: REVOKE_TIMEOUT_MS });
    if (status === 200 && data?.status === "revoked") {
      return "revoked";
    }
    return status === 404 || status === 405 ? "unsupported" : "failed";
  } catch {
    return "failed";
  }
}

/** A harness id from the server (`"claude-code"` or `{id, version}`); "unknown" when never identified. */
export function harnessId(value: unknown): string {
  const hid = value && typeof value === "object" ? (value as { id?: unknown }).id : value;
  return typeof hid === "string" && hid.trim() ? hid.trim().toLowerCase() : "unknown";
}

/**
 * True when a saved session was recorded with a harness other than Claude Code (the CLI's
 * _refuse_other_harness): the server's label, or, when that is "unknown", a `native/<harness>.<ext>` file.
 */
export function otherHarness(value: unknown, files: readonly unknown[] = []): boolean {
  let hid = harnessId(value);
  if (hid === "unknown") {
    const p = files.find((f): f is string => typeof f === "string" && f.startsWith("native/") && !f.startsWith("native/claude-code."));
    if (p) {
      hid = p.slice("native/".length).replace(/\.[^.]*$/, "") || "unknown";
    }
  }
  return hid !== "claude-code" && hid !== "unknown";
}

/** Downloading a large transcript may take a while. */
export const FETCH_TIMEOUT_MS = 120_000;

/**
 * The latest transcript of one of your saved sessions, as the CLI fetches it for `launch`:
 * GET /library/fetch?cid=, the first session member, its first `.jsonl` file.
 */
export async function fetchTranscript(c: Client, token: string, cid: string, signal?: AbortSignal): Promise<string> {
  const { status, data } = await call(c, `/library/fetch?cid=${encodeURIComponent(cid)}`, { token, timeoutMs: FETCH_TIMEOUT_MS, signal });
  if (status === 404) {
    throw new ApiError("not-found", MESSAGES.sessionGone, status);
  }
  if (status !== 200) {
    fail(status);
  }
  const members = Array.isArray(data?.members) ? data.members : [];
  const session = members.find((m: any) => m && m.kind === "session");
  const files: any[] = Array.isArray(session?.files) ? session.files.filter((f: any) => f && typeof f === "object") : [];
  if (otherHarness(data?.harness, files.map((f) => f.path))) {
    throw new ApiError("not-claude-code", MESSAGES.notClaudeCode, status);
  }
  const tf = files.find((f) => typeof f.path === "string" && f.path.endsWith(".jsonl") && typeof f.content_b64 === "string");
  if (!session || !tf) {
    throw new ApiError("no-transcript", MESSAGES.noTranscript, status);
  }
  return Buffer.from(tf.content_b64, "base64").toString("utf8");
}
