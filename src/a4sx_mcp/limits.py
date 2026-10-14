# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 crossVault GmbH
"""Size and rate limits. The defaults are the hosted ``/mcp`` server's.

| limit                                  | default       | override                          |
|----------------------------------------|---------------|-----------------------------------|
| publish_session transcript size        | 2 MiB         | ``A4SX_MCP_MAX_PUBLISH_BYTES``    |
| tool calls per minute (all tools)      | 240           | ``A4SX_MCP_PER_MIN``              |
| acquire_session calls per minute       | 20            | ``A4SX_MCP_ACQUIRE_PER_MIN``      |
| publish_session calls per minute       | 10            | ``A4SX_MCP_PUBLISH_PER_MIN``      |

The rate limits here count calls made through this process (a sliding 60-second window). The a4sx
server applies its own limits on top; ``0`` turns a local limit off, never the server's.
"""

from __future__ import annotations

import os
import threading
import time
from collections import deque
from typing import Callable, Deque, Dict

DEFAULT_MAX_PUBLISH_BYTES = 2 * 1024 * 1024
WINDOW_S = 60
DEFAULT_LIMITS = {"any": 240, "acquire": 20, "publish": 10}
LIMIT_ENV = {"any": "A4SX_MCP_PER_MIN", "acquire": "A4SX_MCP_ACQUIRE_PER_MIN", "publish": "A4SX_MCP_PUBLISH_PER_MIN"}


def _env_int(name: str, default: int, minimum: int) -> int:
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except ValueError:
        return default


def max_publish_bytes() -> int:
    return _env_int("A4SX_MCP_MAX_PUBLISH_BYTES", DEFAULT_MAX_PUBLISH_BYTES, 1)


def limit(kind: str) -> int:
    return _env_int(LIMIT_ENV[kind], DEFAULT_LIMITS[kind], 0)


class RateBook:
    """Sliding-window call counters, one per rate class."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._hits: Dict[str, Deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, kind: str) -> int:
        """0 = allowed (and counted); otherwise the seconds to wait."""
        n = limit(kind)
        if not n:
            return 0
        now = self._clock()
        with self._lock:
            q = self._hits.setdefault(kind, deque())
            while q and q[0] <= now - WINDOW_S:
                q.popleft()
            if len(q) >= n:
                return max(1, int(q[0] + WINDOW_S - now + 0.999))
            q.append(now)
            return 0
