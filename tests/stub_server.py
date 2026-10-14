# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 crossVault GmbH
"""A small in-memory stand-in for the a4sx HTTP API, served on 127.0.0.1 for the tests.

It implements just the routes the five tools call, records every request, and lets a test queue
canned answers (``queue``) to simulate rate limits, deploys and failures. All data is synthetic.
"""

from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

# Assembled at runtime so no token-shaped literal sits in the source.
VALID_TOKEN = "-".join(["stub", "session", "token", "0001"])


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class Recorded:
    def __init__(self, method: str, path: str, query: Dict[str, str], headers: Dict[str, str], body: bytes):
        self.method, self.path, self.query, self.headers, self.body = method, path, query, headers, body

    @property
    def auth(self) -> Optional[str]:
        return self.headers.get("authorization")

    def __repr__(self) -> str:
        return f"<{self.method} {self.path} {self.query}>"


class Stub:
    def __init__(self) -> None:
        self.requests: List[Recorded] = []
        self.tokens = {VALID_TOKEN}
        self.rows: List[dict] = []
        self.transcripts: Dict[str, bytes] = {}
        self.listings: List[dict] = []
        self.entitled: set = set()
        self.memory_only: set = set()
        self.member_sold: Dict[str, dict] = {}   # listing id -> the member sold on its own (402 details)
        self.canonical: Dict[str, dict] = {}   # cid -> canonical.json of a session from another harness
        self.pushed: List[Recorded] = []
        self.idempotency: Dict[str, Tuple[int, dict]] = {}
        self._queued: List[Tuple[str, str, int, Any]] = []
        self._srv: Optional[ThreadingHTTPServer] = None

    # -- test helpers -------------------------------------------------------------------------------

    @property
    def base_url(self) -> str:
        assert self._srv is not None
        return f"http://127.0.0.1:{self._srv.server_address[1]}"

    def queue(self, method: str, path_prefix: str, status: int, body: Any = None) -> None:
        """The next matching request gets this answer instead of the normal route."""
        self._queued.append((method, path_prefix, status, body))

    def add_session(self, cid: str, transcript: bytes, **row: Any) -> dict:
        r = {"id": cid, "version": row.pop("version", "v1"), **row}
        self.rows.append(r)
        self.transcripts[cid] = transcript
        return r

    def calls(self, method: str, path: str) -> List[Recorded]:
        return [r for r in self.requests if r.method == method and r.path == path]

    # -- server -------------------------------------------------------------------------------------

    def start(self) -> "Stub":
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def _do(self):
                u = urlsplit(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                n = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(n) if n else b""
                rec = Recorded(self.command, u.path, q, {k.lower(): v for k, v in self.headers.items()}, body)
                stub.requests.append(rec)
                status, payload = stub.handle(rec)
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_DELETE = do_PUT = _do

        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self._srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        return self

    def stop(self) -> None:
        if self._srv:
            self._srv.shutdown()
            self._srv.server_close()

    # -- routes -------------------------------------------------------------------------------------

    def _authed(self, rec: Recorded) -> bool:
        a = rec.auth or ""
        return a.startswith("Bearer ") and a[7:] in self.tokens

    @staticmethod
    def _err(status: int, code: str, message: str, **details: Any):
        return status, {"error": {"code": code, "message": message, "details": details}}

    def handle(self, rec: Recorded):
        for i, (m, p, st, body) in enumerate(self._queued):
            if m == rec.method and rec.path.startswith(p):
                del self._queued[i]
                return st, body if body is not None else {}
        path, m = rec.path, rec.method
        if path.startswith("/billing"):
            raise AssertionError("a tool called a billing route")
        if path == "/memory/discover":
            if rec.auth:
                return self._err(403, "library_token_read_only", "public catalogue is read anonymously")
            q = rec.query.get("q", "").lower()
            items = [x for x in self.listings if q in json.dumps(x).lower()]
            if rec.query.get("harness"):
                want = set(rec.query["harness"].split(","))
                items = [x for x in items if (x.get("harness") or {}).get("id", "unknown") in want]
            lim, off = int(rec.query.get("limit", 10)), int(rec.query.get("offset", 0))
            page = items[off: off + lim]
            nxt = off + len(page) if off + len(page) < len(items) else None
            return 200, {"query": q, "items": page, "total": len(items), "next_offset": nxt}
        if path == "/memory/discover/item":
            it = next((x for x in self.listings if x["id"] == rec.query.get("id")), None)
            if it is None:
                return self._err(404, "collection_not_found", "unknown listing")
            return 200, {"item": it}
        # everything below needs a session
        if not self._authed(rec):
            return self._err(401, "auth_invalid", "Session unknown, revoked, or expired")
        if path == "/library/ensure" and m == "POST":
            return 200, {"ok": True}
        if path == "/library/sessions":
            return 200, {"sessions": self.rows}
        if path == "/library/fetch":
            cid = rec.query.get("cid", "")
            if cid not in self.transcripts:
                return self._err(404, "not_found", "no such session")
            if cid in self.canonical:   # another harness: native file + canonical.json, no transcript.jsonl
                files = [{"path": "native/codex-cli.jsonl", "content_b64": b64(self.transcripts[cid])},
                         {"path": "canonical.json", "content_b64": b64(json.dumps(self.canonical[cid]).encode())}]
            else:
                files = [{"path": "SESSION.md", "content_b64": b64(b"# x")},
                         {"path": "transcript.jsonl", "content_b64": b64(self.transcripts[cid])}]
            return 200, {"id": cid, "title": f"Title of {cid}", "version": rec.query.get("version") or "v1",
                         "members": [
                             {"kind": "memory", "id": "m1", "files": []},
                             {"kind": "session", "id": "s-" + cid, "files": files},
                         ]}
        if path.startswith("/library/acquire/") and m == "POST":
            lid = unquote(path[len("/library/acquire/"):])
            if lid in self.memory_only:
                return self._err(409, "memory_only", "reading material only")
            if lid in self.member_sold:
                return self._err(402, "payment_required", "the session is sold separately",
                                 member=self.member_sold[lid])
            if lid not in self.entitled:
                return self._err(402, "payment_required", "buy it first")
            cid = f"acq-{lid}"
            self.add_session(cid, b'{"type":"user","message":{"content":"acquired"}}\n',
                             acquired_from={"id": lid, "tenant": rec.query.get("tenant")})
            return 200, {"collection": cid, "version": "v1", "acquired_from": {"id": lid}}
        if path == "/library/push" and m == "POST":
            key = rec.headers.get("idempotency-key", "")
            if key in self.idempotency:
                return self.idempotency[key]
            self.pushed.append(rec)
            cid = (rec.query.get("label") or "session") + f"-{len(self.rows) + 1}"
            self.add_session(cid, rec.body, label=rec.query.get("label"), title=rec.query.get("title"))
            ans = (201, {"collection": cid, "version": "v1", "deduped": False, "redactions": 0,
                         "parent": rec.query.get("parent")})
            if key:
                self.idempotency[key] = ans
            return ans
        return self._err(404, "not_found", f"no route {m} {path}")
