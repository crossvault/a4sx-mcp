# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 crossVault GmbH
"""The five a4sx tools, implemented on :class:`a4sx.sdk.Client`.

Names, input schemas, annotations and limits are the same as the hosted ``/mcp`` server's, so a
prompt or an agent that works against one works against the other.

| tool                   | needs sign-in | a4sx API route(s)                                 |
|------------------------|---------------|---------------------------------------------------|
| search_sessions        | library only  | GET /memory/discover (anonymous), GET /library/sessions |
| get_session_summary    | library only  | GET /memory/discover/item (anonymous), GET /library/sessions |
| acquire_session        | yes           | POST /library/acquire/{id} (never a billing route) |
| fetch_session_context  | yes           | GET /library/fetch                                |
| publish_session        | yes           | POST /library/ensure, POST /library/push          |

Safety rules carried over from the hosted server:

- ``acquire_session`` never buys. A paid listing you have no purchase or grant for comes back as
  ``status=payment_required`` with the price and the listing URL; the account holder buys it in the
  web app.
- ``publish_session`` only ever saves privately (``visibility`` accepts only ``"private"``). Listing a
  session publicly is a separate, reviewed step in the web app. Only Claude Code or Codex CLI JSONL is
  accepted; the transcript, title and label are pre-scrubbed on this machine and scrubbed again by the
  server; the SDK's untrusted-content marker is kept.
- Only Claude Code sessions can be resumed today: search and summary rows say ``resumable: false`` for a
  session recorded with another harness, and carry its ``harness``.
- ``fetch_session_context`` renders everything the author controls inside a nonce-delimited untrusted
  envelope (see :mod:`a4sx_mcp.context`).
- Size and rate limits as below (see :mod:`a4sx_mcp.limits`).

The public catalogue is always read anonymously, so a public search returns the same vetted set for
everyone and never sends your token.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import quote

from a4sx.scrub import scrub_text
from a4sx.sdk import (
    HARNESS_NAMES,
    ApiError,
    Client,
    MemoryOnly,
    NetworkError,
    NotLoggedIn,
    PaymentRequired,
    harness_id,
    row_is_untrusted,
)
from jsonschema import Draft202012Validator

from . import context as ctx
from .limits import max_publish_bytes

LOGIN_HINT = "Run `a4sx login` in a terminal (with the same --base as this MCP server, if you set one), then retry."
# Codes with which the API refuses the credential itself (the hosted server maps these the same way).
_CREDENTIAL_CODES = ("library_token_read_only", "insufficient_scope", "not_logged_in", "auth_invalid",
                     "forbidden_role", "auth_missing")

_ID = {"type": "string", "minLength": 1, "maxLength": 200, "pattern": r"^[A-Za-z0-9][A-Za-z0-9._:@-]*$"}
_TENANT = {"type": "string", "maxLength": 64, "pattern": r"^[a-z0-9-]*$",
           "description": "Owning workspace of a marketplace listing (from search results). Optional."}
_VERSION = {"type": "string", "maxLength": 64, "pattern": r"^[A-Za-z0-9._-]*$"}
_SOURCE = {"type": "string", "enum": ["marketplace", "library"]}


class ToolError(Exception):
    """A tool EXECUTION error (MCP ``isError: true``): the model can read it and correct itself."""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


@dataclass
class ToolResult:
    structured: dict
    text: str | None = None  # defaults to the JSON of `structured`
    is_error: bool = False

    def payload_text(self) -> str:
        return self.text if self.text is not None else json.dumps(self.structured, ensure_ascii=False)


Handler = Callable[[Client, dict], ToolResult]


@dataclass
class Tool:
    name: str
    title: str
    description: str
    input_schema: dict
    handler: Handler
    annotations: dict = field(default_factory=dict)
    rate_class: str = "read"  # read | acquire | publish

    def validate(self, args: Any) -> dict:
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise ToolError("invalid_arguments", "arguments must be an object")
        errs = sorted(Draft202012Validator(self.input_schema).iter_errors(args), key=lambda e: list(e.path))
        if errs:
            e = errs[0]
            where = ".".join(str(p) for p in e.path) or "arguments"
            raise ToolError("invalid_arguments", f"{where}: {e.message}")
        return args


# --- helpers -------------------------------------------------------------------------------------


def _listing_url(client: Client, cid: str, tenant: str | None) -> str:
    url = f"{client.base_url}/marketplace/{quote(cid, safe='')}"
    return f"{url}?t={quote(tenant, safe='')}" if tenant else url


def _trim(s: Any, n: int) -> str:
    s = str(s or "")
    return s if len(s) <= n else s[: n - 1] + "…"


def _sdk_error(e: Exception, what: str) -> ToolError:
    """Map an SDK exception to a tool error the model can act on. Never includes a token, and never
    lists the other servers you are signed in to."""
    if isinstance(e, NotLoggedIn):
        return ToolError("not_signed_in", f"{what}: not signed in to a4sx on this server. {LOGIN_HINT}")
    if isinstance(e, NetworkError):
        return ToolError("network_error", f"{what}: {e}")
    if isinstance(e, ApiError):
        if e.status in (401, 403) and (e.session_ended or e.code in _CREDENTIAL_CODES):
            return ToolError("credential_not_accepted",
                             f"{what}: the server did not accept your a4sx sign-in ({e.code or e.status}); it may "
                             f"have expired or been revoked. {LOGIN_HINT}", status=e.status)
        if e.status == 429:
            return ToolError("rate_limited", f"{what}: too many requests; wait and retry",
                             retry_after_s=e.details.get("retry_after_s"))
        if e.status == 404:
            return ToolError("not_found", f"{what}: {e.message or 'not found'}")
        return ToolError(e.code or "http_error", f"{what}: {e.message or 'HTTP ' + str(e.status)}", status=e.status)
    raise e


# Every author-controlled field of a read-tool result is bounded here, per field, before it reaches
# the model (one line, neutralised, capped). Anything not named gets the sanitize() default (500).
# Same caps as the hosted server.
_ROW_CAPS = {"title": ctx.TITLE_CHARS, "label": 64, "author": 64, "author_handle": 64, "owner": 64,
             "display_name": 64, "tenant": 64, "id": 200, "cid": 200, "version": 64, "currency": 8,
             "tags": 64, "name": 200, "description": 300, "abstract": 400, "summary": 400, "notes": 500,
             "listing_url": 600}
_SUMMARY_CAPS = {**_ROW_CAPS, "description": 2000, "abstract": 2000}


#: A page of `items` is never cut by sanitize's per-list cap (the schema allows `limit` up to 50);
#: only the overall result budget can shorten it, and then `next_offset` resumes after the last kept row.
_PAGE_MAX_ITEMS = 50


def _payload_bytes(r: ToolResult) -> int:
    """UTF-8 bytes of a tool result as sent: the text form plus the `structuredContent` copy."""
    return (len((r.text or "").encode("utf-8"))
            + len(json.dumps(r.structured, ensure_ascii=False).encode("utf-8")))


def _frame(out: dict, caps: dict[str, int], other_author: bool, offset: int | None,
           nbytes: int, next_hint: str | None = None) -> ToolResult:
    b = ctx.Budget(nbytes)
    b.spend(len(ctx.NOTICE.encode("utf-8")) + 16)
    rest = {k: v for k, v in out.items() if k != "items"}
    clean = {"notice": ctx.NOTICE, **ctx.sanitize(rest, caps=caps, budget=b)}
    if "items" in out:
        page = list(out.get("items") or [])[:_PAGE_MAX_ITEMS]
        kept: list = []
        for row in page:                 # each row keeps the usual 20-item cap on its own lists
            if b.left <= 0:
                b.cut = True
                break
            was_cut = b.cut
            clean_row = ctx.sanitize(row, caps=caps, budget=b, _depth=2)
            if b.cut and not was_cut and kept:
                break                    # cut partway: left out whole, so next_offset resumes AT it
            kept.append(clean_row)
        if offset is not None and len(kept) < len(page):
            clean["next_offset"] = offset + len(kept)
        clean["items"] = kept
    if b.cut:
        clean["truncated"] = True
    # structuredContent keeps every field in place; the text form takes the server hints (`next`,
    # `next_offset`) out of the envelope and puts only static texts and integers on a line after its
    # END delimiter; a last page has no hint line.
    inner, hints = ctx.split_hints(clean, next_hint=next_hint)
    return ToolResult(clean, text=ctx.envelope_json(inner, other_author=other_author, hints=hints))


def _untrusted(out: dict, *, caps: dict[str, int] = _ROW_CAPS, other_author: bool = True,
               offset: int | None = None, next_hint: str | None = None) -> ToolResult:
    """A read-tool result that carries author-written text: sanitised per field and bounded overall;
    the notice leads the structured content; the text form is the preamble-first, nonce-delimited
    envelope, with the server hints (`ctx.HINT_KEYS`) on a line after it.

    The bound is on the response as sent (`ctx.RESULT_MAX_BYTES` of UTF-8: the framed text PLUS the
    `structuredContent` copy of the same JSON), measured after framing. If it cut anything,
    `truncated` is true; a page row cut partway is left out whole, and for a page (`offset` given)
    `next_offset` points at the first row that was left out. Same framing as the hosted server."""
    cap = ctx.RESULT_MAX_BYTES
    nbytes = (cap - 1024) // 2           # the JSON goes out twice; 1 KiB for preamble and delimiters
    res = _frame(out, caps, other_author, offset, nbytes, next_hint)
    while _payload_bytes(res) > cap and nbytes > 0:
        nbytes -= (_payload_bytes(res) - cap) // 2 + 256
        res = _frame(out, caps, other_author, offset, max(0, nbytes), next_hint)
    return res


def _other_author(client: Client, row: dict | None, rows: list[dict]) -> bool:
    """The SDK's marker: the row or an ancestor was acquired from another author, or this machine
    marked it untrusted. Unknown row: fail closed (True)."""
    if not isinstance(row, dict):
        return True
    return row_is_untrusted(row, rows, client.base_url)


#: A harness version is shown only when it reads as one ("0.130.2", "2.1.3-beta.1"); free text never.
_VER_OK = re.compile(r"^\d{1,9}(\.\d{1,9}){0,3}([-+][0-9A-Za-z.]{1,32})?$")
_HARNESS_FILTER_VALUES = tuple(sorted(HARNESS_NAMES)) + ("unknown",)


def _harness_field(value: Any) -> dict:
    """``{id, version}`` as listings carry it: a known id, else ``unknown`` with no version. Never
    defaults to claude-code."""
    hid = harness_id(value)
    if hid not in HARNESS_NAMES:
        return {"id": "unknown", "version": None}
    ver = value.get("version") if isinstance(value, dict) else None
    return {"id": hid, "version": ver if isinstance(ver, str) and _VER_OK.match(ver) else None}


def _other_harness(value: Any) -> bool:
    hid = harness_id(value)
    return hid in HARNESS_NAMES and hid != "claude-code"


def _market_row(client: Client, r: dict) -> dict:
    cents = int(r.get("price_cents") or 0)
    return {"source": "marketplace", "id": r.get("id"), "tenant": r.get("tenant"),
            "version": r.get("version"), "title": r.get("title"),
            "description": _trim(r.get("description"), 300), "abstract": _trim(r.get("abstract"), 400),
            "tags": (r.get("tags") or [])[:12], "author": r.get("author_handle") or r.get("owner"),
            "price_cents": cents, "currency": r.get("currency"), "free": cents == 0,
            # resumable only where resume ships: never a session recorded with another harness
            "resumable": bool(r.get("has_transcript")) and not _other_harness(r.get("harness")),
            "harness": _harness_field(r.get("harness")),
            **({"labels": r["labels"]} if isinstance(r.get("labels"), dict) else {}),
            "listing_url": _listing_url(client, str(r.get("id") or ""), r.get("tenant"))}


def _library_row(r: dict) -> dict:
    return {"source": "library", "id": r.get("id"), "title": r.get("title"), "label": r.get("label"),
            "description": _trim(r.get("description"), 300), "summary": _trim(r.get("summary"), 400),
            "tags": (r.get("tags") or [])[:12], "updated_at": r.get("updated_at"),
            "versions": r.get("versions"), "tokens": r.get("tokens"),
            "acquired_from": r.get("acquired_from"), "parent": r.get("parent"),
            "harness": r.get("harness") or "unknown"}   # the recording harness id


def _library_rows(client: Client) -> list[dict]:
    try:
        return client.list_sessions()
    except (NotLoggedIn, NetworkError, ApiError) as e:
        raise _sdk_error(e, "list your library") from None


# --- search_sessions -----------------------------------------------------------------------------

SEARCH_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "query": {"type": "string", "maxLength": 200, "description": "Free-text search. Empty = browse."},
        "scope": {"type": "string", "enum": ["public", "library"], "default": "public",
                  "description": "`public`: vetted marketplace listings (no sign-in needed). "
                                 "`library`: your own saved sessions (needs library:read)."},
        "tags": {"type": "array", "items": {"type": "string", "maxLength": 64}, "maxItems": 10},
        "sort": {"type": "string", "enum": ["relevance", "imports", "rating", "recent"], "default": "relevance"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
        "offset": {"type": "integer", "minimum": 0, "maximum": 10000, "default": 0},
        "harness": {"type": "array", "maxItems": 5,
                    "items": {"type": "string", "enum": list(_HARNESS_FILTER_VALUES)},
                    "description": "Only sessions recorded with these harnesses (claude-code, codex-cli, "
                                   "gemini-cli, opencode, grok-build; unknown = not identified). Only Claude Code "
                                   "sessions can be resumed today; the others are view & buy."},
    },
}


def search_sessions(client: Client, a: dict) -> ToolResult:
    scope = a.get("scope") or "public"
    q = (a.get("query") or "").strip()
    limit, offset = int(a.get("limit") or 10), int(a.get("offset") or 0)
    tags = list(a.get("tags") or [])
    try:
        r = client.search(q, scope=scope, tags=tags, sort=a.get("sort") or "relevance", limit=limit, offset=offset,
                          harness=list(a.get("harness") or []))
    except (NotLoggedIn, NetworkError, ApiError) as e:
        raise _sdk_error(e, "list your library" if scope == "library" else "search") from None
    out = {"scope": scope, "query": q, "total": r.get("total"), "next_offset": r.get("next_offset")}
    if scope == "library":
        lib = r.get("items") or []
        try:
            all_rows = client.list_sessions()  # the parent chain may run through rows outside this page
        except (NotLoggedIn, NetworkError, ApiError) as e:
            raise _sdk_error(e, "list your library") from None
        untrusted = any(_other_author(client, x, all_rows) for x in lib)
        return _untrusted({**out, "items": [_library_row(x) for x in lib]}, other_author=untrusted, offset=offset)
    items = [_market_row(client, x) for x in r.get("items") or [] if isinstance(x, dict)]
    return _untrusted({**out, "total": r.get("total", len(items)), "items": items}, offset=offset)


# --- get_session_summary -------------------------------------------------------------------------

SUMMARY_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["id"],
    "properties": {"id": _ID, "source": {**_SOURCE, "default": "marketplace"}, "tenant": _TENANT},
}


def get_session_summary(client: Client, a: dict) -> ToolResult:
    sid = a["id"]
    if (a.get("source") or "marketplace") == "library":
        lib = _library_rows(client)
        row = next((r for r in lib if r.get("id") == sid), None)
        if row is None:
            raise ToolError("not_found", f"no saved session {sid!r} in your library")
        return _untrusted({**_library_row(row), "sessions": row.get("sessions"), "created_at": row.get("created_at")},
                          caps=_SUMMARY_CAPS, other_author=_other_author(client, row, lib))
    try:
        r = client.get_listing(sid, a.get("tenant") or None)
    except (NetworkError, ApiError) as e:
        raise _sdk_error(e, "summary") from None
    out = _market_row(client, r)
    out.update({
        "description": _trim(r.get("description"), 2000), "abstract": _trim(r.get("abstract"), 2000),
        "outline": (r.get("outline") or [])[:12],
        "members": [{"id": m.get("id"), "kind": m.get("kind"), "title": m.get("title"),
                     "abstract": _trim(m.get("abstract"), 400)} for m in (r.get("members") or [])[:20]
                    if isinstance(m, dict)],
        "depth": r.get("sf_depth") or {}, "stats": r.get("stats") or {},
        "latest_release": r.get("latest_release"), "provenance": r.get("provenance"),
        "author_claims": r.get("author_claims"), "created_at": r.get("created_at"),
        "deprecated": bool(r.get("deprecated")),
    })
    return _untrusted(out, caps=_SUMMARY_CAPS)


# --- acquire_session -----------------------------------------------------------------------------

ACQUIRE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["id"],
    "properties": {"id": {**_ID, "description": "Marketplace listing id (from search_sessions)."},
                   "tenant": _TENANT, "version": {**_VERSION, "default": "latest"}},
}

PAYMENT_MESSAGE = ("This listing is paid and your account has no purchase or grant for it. a4sx never buys "
                   "on your behalf: the account holder buys it on the listing page, then calls "
                   "acquire_session again.")
MEMBER_PAYMENT_MESSAGE = ("The session in this listing is sold separately and your account has no purchase or "
                          "grant for it. a4sx never buys on your behalf: the account holder buys it, then calls "
                          "acquire_session again.")


def acquire_session(client: Client, a: dict) -> ToolResult:
    sid, tenant = a["id"], a.get("tenant") or None
    try:
        b = client.acquire(sid, tenant, a.get("version") or "latest")
    except PaymentRequired as e:
        # Never buy. Say what is required, from the public listing (anonymous read: price only).
        try:
            r = client.get_listing(sid, tenant)
        except (NetworkError, ApiError):
            r = {}
        owner_tenant = r.get("tenant") or tenant
        cents, cur = int(r.get("price_cents") or 0), r.get("currency")
        member = e.details.get("member")
        if isinstance(member, dict) and member.get("id"):
            # the listing's session is sold on its own (the listing itself may be free)
            return ToolResult({
                "status": "payment_required", "id": sid, "tenant": owner_tenant,
                "member": {"kind": str(member.get("kind") or "session")[:16],
                           "id": ctx.one_line(member.get("id"), 200)},
                "listing_url": _listing_url(client, sid, owner_tenant), "message": MEMBER_PAYMENT_MESSAGE,
            })
        return ToolResult({
            "status": "payment_required", "id": sid, "tenant": owner_tenant,
            "price_cents": cents or None, "currency": cur if cents else None,
            "listing_url": _listing_url(client, sid, owner_tenant), "message": PAYMENT_MESSAGE,
        })
    except MemoryOnly:
        return ToolResult({"status": "not_a_session", "id": sid,
                           "message": "This listing is reading material (memories only, no session), "
                                      "so there is nothing to acquire as a base."}, is_error=True)
    except (NotLoggedIn, NetworkError, ApiError) as e:
        raise _sdk_error(e, "acquire") from None
    lib_id = b.get("collection") or b.get("id")
    # Framed like the other read results: the ids and acquired_from name another author's listing, so
    # the notice leads and the text form is the envelope.
    return _untrusted({"status": "acquired", "library_id": lib_id, "version": b.get("version"),
                       "acquired_from": b.get("acquired_from"), "visibility": "private",
                       "next": f"fetch_session_context with id={lib_id}"},
                      next_hint=ctx.STATIC_HINTS["acquired"])


# --- fetch_session_context -----------------------------------------------------------------------

FETCH_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["id"],
    "properties": {
        "id": {**_ID, "description": "Library id: one of your saved sessions, or the library_id "
                                     "acquire_session returned for a marketplace listing."},
        "version": _VERSION,
        "max_tokens": {"type": "integer", "minimum": ctx.MIN_TOKENS, "maximum": ctx.MAX_TOKENS,
                       "default": ctx.DEFAULT_TOKENS,
                       "description": "Context budget. Long sessions keep the opening request and the "
                                      "newest turns that fit; the middle is elided."},
        "include_tool_calls": {"type": "boolean", "default": False,
                               "description": "Add one-line stubs for tool calls and results."},
    },
}


def fetch_session_context(client: Client, a: dict) -> ToolResult:
    sid = a["id"]
    try:
        status, bundle = client.request("GET", "/library/fetch", params={"cid": sid, "version": a.get("version")},
                                        token=client.require_token())
        if status != 200:
            raise ApiError(status, bundle, "fetch")
    except (NotLoggedIn, NetworkError, ApiError) as e:
        raise _sdk_error(e, "fetch") from None
    try:
        rows = client.list_sessions()
    except (NotLoggedIn, NetworkError, ApiError):
        rows = []   # whose content it is can't be checked: treated as another author's below
    bundle = bundle if isinstance(bundle, dict) else {}
    raw, _md = ctx.transcript_from_bundle(bundle)
    if raw is None:
        raise ToolError("no_transcript", f"{sid!r} has no session transcript to load")
    # Someone else's content? The SDK's marker (acquired_from on the row or an ancestor, or the local
    # untrusted registry). A row we cannot see is treated as someone else's.
    lib_id = bundle.get("id") or sid
    row = next((r for r in rows if r.get("id") == lib_id), None)
    other = _other_author(client, row, rows)
    acquired_from = (row or {}).get("acquired_from")
    title = str(bundle.get("title") or sid)
    max_tokens = ctx.clamp_tokens(a.get("max_tokens", ctx.DEFAULT_TOKENS))
    b = ctx.build(title, raw, max_tokens=max_tokens, include_tools=bool(a.get("include_tool_calls")),
                  other_author=other)
    # The text form IS the envelope (preamble first, every author byte inside); the structured copy
    # leads with the notice and carries only the capped, one-line, neutralised title.
    meta = {"notice": ctx.NOTICE, "status": "ok", "id": ctx.one_line(lib_id, 200), "source": "library",
            "untrusted": other, "acquired_from": ctx.sanitize(acquired_from, caps=_ROW_CAPS),
            "version": ctx.sanitize(bundle.get("version"), default=64),
            "title": ctx.one_line_title(title), "max_tokens": max_tokens,
            "approx_tokens": b.approx_tokens, "truncated": b.truncated, "turns_total": b.total_turns,
            "turns_included": b.kept_turns}
    return ToolResult({**meta, "context": b.text}, text=b.text)


# --- publish_session -----------------------------------------------------------------------------

PUBLISH_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["transcript"],
    "properties": {
        "transcript": {"type": "string", "minLength": 2,
                       "description": "The session transcript as JSONL (Claude Code or Codex CLI format; "
                                      "detected automatically)."},
        "content_sha256": {"type": "string", "pattern": "^[0-9a-fA-F]{64}$",
                           "description": "Hex SHA-256 of the transcript's UTF-8 bytes; checked."},
        "title": {"type": "string", "maxLength": 200},
        "label": {"type": "string", "maxLength": 64},
        "parent": {**_ID, "description": "Library id this session continues from (lineage)."},
        "visibility": {"type": "string", "enum": ["private"], "default": "private",
                       "description": "Always private. Listing publicly is a separate step in the web app."},
        "client_scrubbed": {"type": "boolean", "description": "The client scrubbed before sending. "
                                                              "The server scrubs again regardless."},
        "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 128, "pattern": r"^[\x21-\x7e]+$"},
    },
}


def check_transcript(data: bytes) -> None:
    """Accept only a session transcript: every non-blank line a JSON object with a string ``type``, and
    either a Claude Code session (a user or assistant record with a ``message`` and a ``sessionId`` or
    ``uuid``) or a Codex CLI rollout (the first record is ``session_meta`` with a ``payload`` object).
    This stops a model from uploading an arbitrary file (a key, a ``.env``, source code) as a
    "transcript". The server checks the format again."""
    has_turn = False
    first: dict | None = None
    for i, ln in enumerate(data.splitlines(), 1):
        if not ln.strip():
            continue
        try:
            obj = json.loads(ln)
        except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
            obj = None
        if not isinstance(obj, dict) or not isinstance(obj.get("type"), str):
            raise ToolError("not_a_transcript", f"line {i} is not a session JSONL record (a JSON object "
                                                "with a type); transcript must be a session transcript")
        if first is None:
            first = obj
        if (obj["type"] in ("user", "assistant") and isinstance(obj.get("message"), dict)
                and (obj.get("sessionId") or obj.get("uuid"))):
            has_turn = True
    codex = first is not None and first.get("type") == "session_meta" and isinstance(first.get("payload"), dict)
    if not (has_turn or codex):
        raise ToolError("not_a_transcript", "transcript is neither a Claude Code session (no user or assistant "
                                            "record with a sessionId or uuid) nor a Codex CLI session (no "
                                            "session_meta record first)")


def _scrubbed(value: Any) -> tuple[str | None, int]:
    if not value:
        return None, 0
    out, counts = scrub_text(str(value))
    return out, sum(counts.values())


def _with_idempotency_key(client: Client, key: str) -> Client:
    """A copy of ``client`` whose pushes carry the caller's ``Idempotency-Key`` (the SDK picks a fresh
    one per push otherwise). Per call, so concurrent tool calls never share it."""
    keyed = copy.copy(client)
    send = client.request

    def request(method: str, path: str, **kw: Any):
        if path == "/library/push":
            kw["headers"] = {**(kw.get("headers") or {}), "Idempotency-Key": key}
        return send(method, path, **kw)

    keyed.request = request  # type: ignore[method-assign]
    return keyed


def publish_session(client: Client, a: dict) -> ToolResult:
    data = a["transcript"].encode("utf-8")
    cap = max_publish_bytes()
    if len(data) > cap:
        raise ToolError("too_large", f"transcript is {len(data)} bytes; this server takes up to {cap} "
                                     "over MCP. Use the a4sx CLI or plugin helper mode for larger sessions.")
    sha = hashlib.sha256(data).hexdigest()
    if a.get("content_sha256") and a["content_sha256"].lower() != sha:
        raise ToolError("content_sha_mismatch", "content_sha256 does not match the transcript (truncated?)")
    check_transcript(data)
    # Title and label travel as query parameters: scrub them like the body.
    title, n_title = _scrubbed(a.get("title"))
    label, n_label = _scrubbed(a.get("label"))
    pusher = _with_idempotency_key(client, a["idempotency_key"]) if a.get("idempotency_key") else client
    try:
        client.ensure_library()
        # The SDK's push: client-side pre-scrub, retries with one idempotency key, and the untrusted
        # marker (kept when the parent, or the session this one was resumed from, holds someone else's
        # content). The server scrubs again before anything is stored.
        res = pusher.push(data, title=title, label=label, parent=a.get("parent"), lineage=True)
    except (NotLoggedIn, NetworkError, ApiError) as e:
        raise _sdk_error(e, "publish") from None
    b = res.response
    return ToolResult({"status": "saved", "visibility": "private", "library_id": b.get("collection"),
                       "version": b.get("version"), "deduped": bool(b.get("deduped")),
                       "server_redactions": b.get("redactions"),
                       "client_redactions": {"lines_changed": res.scrub.lines_changed, "rules": dict(res.scrub.rules),
                                             "title_and_label": n_title + n_label},
                       "untrusted": bool(res.untrusted), "parent": b.get("parent") or res.parent,
                       "next": "It is in your private library. Listing it publicly is a separate, "
                               "reviewed step in the a4sx web app."})


# --- registry ------------------------------------------------------------------------------------

_RO = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}

TOOLS: tuple[Tool, ...] = (
    Tool("search_sessions", "Search sessions",
         "Search vetted, published coding-agent sessions on a4sx (reviewed marketplace listings), or "
         "your own saved sessions with scope=library. Returns ids to use with the other tools.",
         SEARCH_SCHEMA, search_sessions, _RO),
    Tool("get_session_summary", "Session summary",
         "Describe one session before using it: what it did, outline, price, and whether you already "
         "have access. source=marketplace (default) or library.",
         SUMMARY_SCHEMA, get_session_summary, _RO),
    Tool("acquire_session", "Acquire session",
         "Add a marketplace session you are entitled to (free, bought, or granted) to your private "
         "library. Never buys anything: for a paid listing it returns status=payment_required with "
         "the price and the listing URL.",
         ACQUIRE_SCHEMA, acquire_session,
         {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
         rate_class="acquire"),
    Tool("fetch_session_context", "Load session as context",
         "Load a session from your library (saved, or added with acquire_session) as starting "
         "context for this conversation, sized to max_tokens.",
         FETCH_SCHEMA, fetch_session_context, _RO),
    Tool("publish_session", "Save session to library",
         "Save a session transcript (JSONL) to your private a4sx library. The server scrubs token-"
         "shaped secrets before storing. Private: it is never listed publicly by this tool.",
         PUBLISH_SCHEMA, publish_session,
         {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False},
         rate_class="publish"),
)
BY_NAME: dict[str, Tool] = {t.name: t for t in TOOLS}
