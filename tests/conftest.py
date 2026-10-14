# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 crossVault GmbH
"""Every test runs offline and in a throwaway home.

- HOME and the a4sx config dir point into tmp_path;
- every A4SX_* variable from the outer environment is removed;
- any DNS lookup or connection to a non-loopback address fails the test.
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
from typing import List

import pytest

from stub_server import VALID_TOKEN, Stub

_real_getaddrinfo = socket.getaddrinfo
_real_connect = socket.socket.connect


def _loopback(host) -> bool:
    h = str(host or "").strip("[]").lower()
    if h == "localhost":
        return True
    try:
        return ipaddress.ip_address(h.split("%")[0]).is_loopback
    except ValueError:
        return False


def _guard_getaddrinfo(host, *a, **k):
    if not _loopback(host):
        raise AssertionError(f"test tried to resolve a non-loopback host: {host!r}")
    return _real_getaddrinfo(host, *a, **k)


def _guard_connect(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6) and not _loopback(address[0]):
        raise AssertionError(f"test tried to connect to a non-loopback address: {address!r}")
    return _real_connect(self, address)


@pytest.fixture(autouse=True)
def _offline_and_isolated(monkeypatch, tmp_path):
    for k in list(os.environ):
        if k.startswith("A4SX_") or k == "XDG_CONFIG_HOME":
            monkeypatch.delenv(k, raising=False)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("A4SX_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setattr(socket, "getaddrinfo", _guard_getaddrinfo)
    monkeypatch.setattr(socket.socket, "connect", _guard_connect)
    yield


@pytest.fixture
def stub():
    s = Stub().start()
    yield s
    s.stop()


@pytest.fixture
def anon_client(stub):
    """A client with no sign-in at all."""
    from a4sx.sdk import Client

    return Client(stub.base_url, sleep=lambda s: None)


@pytest.fixture
def client(stub):
    """A client signed in the way `a4sx login` leaves things: the token stored in the config dir."""
    from a4sx.config import save_token
    from a4sx.sdk import Client

    save_token(VALID_TOKEN, stub.base_url)
    return Client(stub.base_url, sleep=lambda s: None)


def make_transcript(n_turns: int = 2, words: int = 3, session_id: str = "11111111-2222-3333-4444-555555555555",
                    extra: List[dict] = ()) -> bytes:
    """A synthetic Claude Code transcript with alternating user / assistant turns."""
    rows = []
    for i in range(n_turns):
        role = "user" if i % 2 == 0 else "assistant"
        text = f"turn{i} " + " ".join(f"w{i}x{j}" for j in range(words))
        content = text if role == "user" else [{"type": "text", "text": text}]
        rows.append({"type": role, "sessionId": session_id, "uuid": f"u{i}",
                     "message": {"role": role, "content": content}})
    rows += list(extra)
    return "".join(json.dumps(r) + "\n" for r in rows).encode()
