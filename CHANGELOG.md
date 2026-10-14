# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0rc1] - unreleased

First release candidate.

### Added (synced with the hosted `/mcp` server)

- `search_sessions` takes a `harness` filter (`claude-code`, `codex-cli`, `gemini-cli`, `grok-build`,
  `opencode`, `unknown`; up to 5). Search and summary rows carry `harness` (`{id, version}`, the version
  only when it reads as one) and pass a listing's `labels` through; `resumable` is `false` for a
  session recorded with another harness. Library rows carry the harness id.
- `fetch_session_context` renders a session recorded with another harness from its stored canonical
  form (`canonical.json`, `a4sx.session/0.x`), with the harness's injected turns left out; an
  unsupported version falls back to the native file.
- `publish_session` accepts Codex CLI rollouts as well as Claude Code transcripts (the schema
  description says so, as on the hosted server).
- `acquire_session`: a listing whose session is sold on its own returns `payment_required` with the
  `member` to buy. An acquired result is framed like the other read results, with its next step on a
  hint line after the envelope.
- JSON read results are bounded to 64 KiB as sent (text plus structured copy); a page cut short is
  marked `truncated`, and `next_offset` resumes at the first row left out. Server hints (`next`,
  `next_offset`) move to one line after the closing delimiter, and the notice says so.
- `fetch_session_context` still loads a session when the library listing can't be read (it is then
  treated as another author's).
- Uploads ride out a busy server scrub pool (from the `a4sx` SDK).

### Added

- A local MCP server over stdio, started with `uvx a4sx-mcp` (or `python -m a4sx_mcp`), built on the
  official MCP Python SDK and the `a4sx` session SDK.
- Five tools with the same names, input schemas, annotations and limits as the hosted a4sx `/mcp`
  server: `search_sessions`, `get_session_summary`, `acquire_session`, `fetch_session_context` and
  `publish_session`.
- Sign-in reuse: the tools use the token stored by `a4sx login` for the configured server, and tell you
  to run `a4sx login` when it is missing or expired. Public search works without signing in.
- Safety rules carried over from the hosted server: `acquire_session` never buys (a paid listing returns
  `payment_required` with the price and listing URL), `publish_session` saves privately only, with a
  2 MiB cap, a local pre-scrub and an optional caller idempotency key.
- Local rate limits (240 calls, 20 acquires, 10 publishes per minute), configurable with
  `A4SX_MCP_*` variables.
- Logs on stderr with tool names, outcomes and durations only.
- `fetch_session_context` wraps all author-controlled content (title and turns) in a nonce-delimited
  untrusted envelope after a notice that is never truncated, caps the title to one 200-character
  line, neutralises delimiters and headings inside content, and reports `untrusted` and
  `acquired_from`.
- `publish_session` goes through the SDK's push (keeps the untrusted marker), accepts only Claude Code
  JSONL records, and scrubs `title` and `label`.
- Error codes, the overall rate limit (`-32029`, counted on every request) and the `too_large` message
  match the hosted server; remaining differences are listed in the README.
- Workflow actions are pinned to full commit SHAs.
- The untrusted framing matches the hosted server: every line break (lone CR, VT, FF, NEL, U+001C-U+001E,
  U+2028/2029) is normalised before neutralising, the notice discloses the escaping, and
  `search_sessions` / `get_session_summary` results are sanitised per field and wrapped in the same
  nonce envelope with a `notice` field.
