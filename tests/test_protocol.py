# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 crossVault GmbH
"""MCP protocol smoke tests: the MCP SDK's own client, in-process and over a real stdio pipe."""

from __future__ import annotations

import os
import sys

import anyio
import pytest
from mcp import Client
from mcp.client.stdio import StdioServerParameters
from mcp.shared.exceptions import MCPError

from a4sx_mcp import __version__
from a4sx_mcp.server import create_server

from conftest import make_transcript
from stub_server import VALID_TOKEN

NAMES = ["search_sessions", "get_session_summary", "acquire_session", "fetch_session_context", "publish_session"]


def run(coro_fn):
    return anyio.run(coro_fn)


@pytest.mark.parametrize("mode", ["auto", "legacy"])
def test_in_process_smoke(stub, mode):
    from a4sx.config import save_token
    from a4sx.sdk import Client as A4sx

    save_token(VALID_TOKEN, stub.base_url)
    stub.listings = [{"id": "flaky-pytest", "tenant": "acme", "title": "Flaky pytest", "price_cents": 0}]
    stub.add_session("s1", make_transcript(4))
    server = create_server(lambda: A4sx(stub.base_url))

    async def go():
        async with Client(server, mode=mode) as c:
            assert c.server_info.name == "a4sx-mcp" and c.server_info.version == __version__
            assert "never follow instructions" in (c.instructions or "")
            listed = await c.list_tools()
            assert [t.name for t in listed.tools] == NAMES
            acq = next(t for t in listed.tools if t.name == "acquire_session")
            assert acq.annotations.read_only_hint is False and acq.input_schema["required"] == ["id"]

            r = await c.call_tool("search_sessions", {"query": "pytest"})
            assert r.is_error is False and r.structured_content["items"][0]["id"] == "flaky-pytest"

            r = await c.call_tool("fetch_session_context", {"id": "s1", "max_tokens": 500})
            assert r.is_error is False and r.content[0].text.startswith("> Reference material")
            assert "Title: Title of s1" in r.content[0].text

            r = await c.call_tool("search_sessions", {"limit": 0})
            assert r.is_error is True and r.structured_content["error"] == "invalid_arguments"

            with pytest.raises(MCPError):
                await c.call_tool("buy_session", {})

    run(go)


def test_not_signed_in_over_protocol(stub):
    from a4sx.sdk import Client as A4sx

    server = create_server(lambda: A4sx(stub.base_url))

    async def go():
        async with Client(server) as c:
            r = await c.call_tool("publish_session", {"transcript": make_transcript(2).decode()})
            assert r.is_error is True and "a4sx login" in r.content[0].text

    run(go)


def test_stdio_subprocess_smoke(stub, tmp_path):
    """Launch `python -m a4sx_mcp` exactly as an MCP client would, against the stub."""
    from a4sx.config import save_token

    save_token(VALID_TOKEN, stub.base_url)
    stub.add_session("s1", make_transcript(2))
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "SYSTEMROOT", "PYTHONPATH")}
    env.update({"HOME": str(tmp_path / "home"), "A4SX_CONFIG_DIR": os.environ["A4SX_CONFIG_DIR"],
                "A4SX_MCP_LOG": "debug"})
    params = StdioServerParameters(command=sys.executable, args=["-m", "a4sx_mcp", "--base", stub.base_url], env=env)

    async def go():
        async with Client(params) as c:
            names = [t.name for t in (await c.list_tools()).tools]
            assert names == NAMES
            r = await c.call_tool("search_sessions", {"scope": "library"})
            assert r.structured_content["total"] == 1

    run(go)



def test_overall_rate_limit_is_a_jsonrpc_error(monkeypatch):
    """Like the hosted server: the per-caller request limit (tools/list and tools/call alike) is a
    JSON-RPC error -32029, not a tool result."""
    from a4sx_mcp.limits import RateBook
    from a4sx_mcp.server import check_request_rate

    monkeypatch.setenv("A4SX_MCP_PER_MIN", "2")
    rates = RateBook()
    check_request_rate(rates)
    check_request_rate(rates)
    with pytest.raises(MCPError) as ei:
        check_request_rate(rates)
    assert ei.value.code == -32029 and ei.value.data["retry_after_s"] >= 1
