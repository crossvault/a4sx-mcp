# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 crossVault GmbH
"""The context builder behind fetch_session_context."""

from __future__ import annotations

import json

from a4sx_mcp import context as ctx

from conftest import make_transcript
from stub_server import b64


def _lines(*rows) -> bytes:
    return "".join(json.dumps(r) + "\n" for r in rows).encode()


def test_harness_envelope_and_meta_are_dropped():
    raw = _lines(
        {"type": "user", "message": {"content": "<system-reminder>internal</system-reminder>"}},
        {"type": "user", "isMeta": True, "message": {"content": "meta"}},
        {"type": "summary", "summary": "x"},
        {"type": "user", "message": {"content": "real task"}},
        {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "hidden"},
                                                      {"type": "text", "text": "answer"}]}},
        "not an object",
    ) + b"garbage line\n"
    ts = ctx.turns(raw)
    assert [(t.role, t.text) for t in ts] == [("user", "real task"), ("assistant", "answer")]


def test_tool_stubs_only_when_asked():
    raw = _lines({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "running"},
        {"type": "tool_use", "name": "Bash", "input": {"command": "ls " + "x" * 1000}}]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "content": [{"type": "text", "text": "ok"}]}]}})
    assert [t.text for t in ctx.turns(raw)] == ["running"]
    with_tools = ctx.turns(raw, include_tools=True)
    assert with_tools[0].text.startswith("running\n[tool call: Bash ") and len(with_tools[0].text) < 330
    assert with_tools[1].text == "[tool result: ok]"


def test_clamp_tokens():
    assert ctx.clamp_tokens(1) == 500 and ctx.clamp_tokens(10**9) == 100_000 and ctx.clamp_tokens("x") == 8000


def test_build_keeps_first_and_last():
    b = ctx.build("T", make_transcript(100, words=50), max_tokens=500)
    assert b.truncated and len(b.text) <= 2000
    assert "turn0 " in b.text and "turn99 " in b.text and "omitted" in b.text


def test_build_empty():
    b = ctx.build("T", b"{}\n", max_tokens=500)
    assert b.total_turns == 0 and "no readable conversation turns" in b.text


def test_transcript_from_bundle_prefers_transcript_jsonl():
    bundle = {"members": [{"kind": "memory", "files": []}, {"kind": "session", "files": [
        {"path": "other.jsonl", "content_b64": b64(b"other")},
        {"path": "transcript.jsonl", "content_b64": b64(b"main")},
        {"path": "SESSION.md", "content_b64": b64(b"# md")}]}]}
    assert ctx.transcript_from_bundle(bundle) == (b"main", "# md")
    assert ctx.transcript_from_bundle({"members": []}) == (None, None)
