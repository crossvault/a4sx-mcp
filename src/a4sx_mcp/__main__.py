# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 crossVault GmbH
"""``a4sx-mcp`` / ``python -m a4sx_mcp``: start the stdio MCP server."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import List, Optional

from . import __version__


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(
        prog="a4sx-mcp",
        description="Local MCP server (stdio) for the a4sx session library. Sign in first with `a4sx login`.",
        epilog="Environment: A4SX_BASE (server), A4SX_SESSION + A4SX_SESSION_BASE (token instead of the stored login), "
               "A4SX_CONFIG_DIR, A4SX_MCP_LOG (warning|info|debug), A4SX_MCP_* limits (see README).",
    )
    p.add_argument("--version", action="version", version=f"a4sx-mcp {__version__}")
    p.add_argument("--base", metavar="URL", help="a4sx server (default: the one `a4sx login` used, "
                                                  "else https://session-exchange.com)")
    args = p.parse_args(argv)

    level = getattr(logging, (os.environ.get("A4SX_MCP_LOG") or "warning").upper(), logging.WARNING)
    logging.basicConfig(stream=sys.stderr, level=level, format="a4sx-mcp %(levelname)s %(message)s")
    # Our own lines carry tool names and outcomes only; keep library chatter (which may describe
    # request content at debug level) out of the log regardless of the level asked for.
    for name in ("mcp", "mcp_types", "httpx", "anyio"):
        logging.getLogger(name).setLevel(max(level, logging.WARNING))

    import anyio
    from a4sx.sdk import Client

    from .server import create_server, serve_stdio

    try:
        base = Client(args.base).base_url  # validates the URL (https, or http for loopback only)
    except ValueError as e:
        p.error(str(e))
    anyio.run(serve_stdio, create_server(lambda: Client(base)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
