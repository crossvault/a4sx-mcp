# a4sx-mcp

A local [MCP](https://modelcontextprotocol.io) server for [a4sx](https://session-exchange.com), the
library and marketplace for coding-agent sessions. It gives any MCP client (Claude Code, Claude
Desktop, Cursor, VS Code, ...) five tools to find a saved session, load it as context, and save the
current one, using the sign-in of the `a4sx` command-line tool.

It runs on your machine over stdio. Your a4sx token stays in the a4sx config directory and is only
ever sent to the server that issued it: pointing the server elsewhere with `--base` never sends it a
token from another server.

## Tools

The names, input schemas and limits are the same as the hosted a4sx MCP server's.

| Tool | What it does | Sign-in |
|---|---|---|
| `search_sessions` | Search vetted public sessions (`scope=public`, default), or your own saved ones (`scope=library`); `harness` keeps only sessions recorded with the given harnesses | library scope only |
| `get_session_summary` | Describe one session before using it: outline, members, price, provenance | library source only |
| `acquire_session` | Copy a marketplace session you are entitled to (free, bought or granted) into your private library | yes |
| `fetch_session_context` | Load a session from your library as starting context, cut to `max_tokens` (500 to 100,000; default 8,000) | yes |
| `publish_session` | Save a transcript (JSONL) to your private library | yes |

Safety rules:

- **`acquire_session` never buys.** For a paid listing you have no purchase or grant for, it returns
  `status: "payment_required"` with the price and the listing URL (or, when the listing's session is
  sold on its own, the `member` to buy). You buy it yourself in the web app, then ask again.
- **Harnesses.** Claude Code, Codex CLI and Grok Build sessions are listed and loaded alike; only Claude
  Code sessions can be resumed today. Every search and summary row carries the `harness` it was
  recorded with (`{id, version}`; `unknown` when not identified), and `resumable` is `false` for a
  session recorded with another harness. `fetch_session_context` renders such a session from its
  stored canonical form.
- **`publish_session` only saves privately.** `visibility` accepts only `"private"`; listing a session
  publicly is a separate, reviewed step in the web app. It accepts only Claude Code or Codex CLI JSONL
  (every line a record with a `type`; a Claude Code user or assistant turn with a session id, or a Codex
  CLI `session_meta` record first), so it can't be used to upload an arbitrary file. The transcript, its title and its label are pre-scrubbed on your machine
  (the `a4sx` SDK's rules) and scrubbed again by the server. Scrubbing removes token-shaped secrets; it
  is a backstop, not a guarantee, and it does not remove names, paths or e-mail addresses. A session
  that continues someone else's (its `parent`, or the session it was resumed from, was acquired) stays
  marked as untrusted (`untrusted: true`).
- **Neither tool asks for confirmation inside the protocol.** Like the hosted server, it relies on the
  rules above and on the tool annotations: `acquire_session` and `publish_session` are marked
  `readOnlyHint: false`, so clients that ask before a tool runs (Claude Code does by default) can
  ask you, and you should not auto-approve them. The three read tools are marked read-only.
- **Loaded sessions are reference material**, not instructions. `fetch_session_context` always starts
  with a notice saying so, then wraps everything the session's author controls (title and turns) in
  `<<<A4SX_UNTRUSTED_SESSION nonce=…>>>` … `<<<END_A4SX_UNTRUSTED_SESSION nonce=…>>>` with a random
  nonce. Inside it, every kind of line break is normalised to `\n`, `<<<`/`>>>` become `‹‹‹`/`›››`
  and a leading `#` becomes `\#` (the notice says so), so content can't close the envelope or fake a
  `### User` heading. The title is one line of at most 200 characters, and cutting to `max_tokens`
  never removes the notice or the closing line. `search_sessions` and `get_session_summary` results are
  framed the same way: a notice first, then the JSON inside the envelope, with every author-written
  string on one line, neutralised and capped per field, and the whole result bounded to 64 KiB (a
  page cut short says `truncated: true`, and `next_offset` resumes at the first row left out). Server
  guidance (`next`, `next_offset`) goes on one line after the closing delimiter, never inside the
  envelope, and carries only fixed texts and numbers. A session with another author's content gets
  `untrusted: true` and a stronger notice. Look-alike characters (full-width `＜`/`＃`, zero-width
  spaces) are left as they are: they cannot close the envelope, because the closing line needs the
  random nonce, but a model may still be misled by them. This lowers the risk of prompt injection but
  cannot rule it out: keep tool approval on.
- **Limits:** transcripts up to 2 MiB per `publish_session` call (use `a4sx push` for larger ones);
  per process, at most 240 requests (`tools/list` and `tools/call`), 20 acquires and 10 publishes per
  minute. The a4sx server enforces its own limits as well.

## Quickstart

You need [uv](https://docs.astral.sh/uv/) (for `uvx`) and an a4sx account.

1. Sign in once with the `a4sx` CLI. The MCP server reuses that sign-in:

   ```sh
   uvx a4sx login
   ```

   Searching public sessions works without signing in. If a tool needs your account and you are not
   signed in (or the sign-in expired), it returns an error telling you to run `a4sx login`.

2. Add the server to your client.

### Claude Code

```sh
claude mcp add a4sx -- uvx a4sx-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "a4sx": { "command": "uvx", "args": ["a4sx-mcp"] }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "a4sx": { "command": "uvx", "args": ["a4sx-mcp"] }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` in your workspace (or run **MCP: Add Server** from the command palette):

```json
{
  "servers": {
    "a4sx": { "type": "stdio", "command": "uvx", "args": ["a4sx-mcp"] }
  }
}
```

### Try it

Ask your agent, for example: *"Search a4sx for sessions about flaky pytest fixtures and summarise the
best one"*, or *"Load my a4sx session `my-refactor` as context"*.

## Configuration

Everything is optional. Don't put your token into an MCP client config file: sign in with
`a4sx login` instead, which stores it with mode 0600.

| Setting | Meaning |
|---|---|
| `--base URL` / `A4SX_BASE` | The a4sx server. Default: the one you signed in to, else `https://session-exchange.com`. Plain `http` is refused except for `localhost`. |
| `A4SX_SESSION`, `A4SX_SESSION_BASE` | A token to use instead of the stored sign-in (for CI), and the server it belongs to (default `https://session-exchange.com`). |
| `A4SX_CONFIG_DIR` | Where the `a4sx` CLI keeps its sign-in (default `~/.config/a4sx`, `%APPDATA%\a4sx` on Windows). |
| `A4SX_MCP_LOG` | `warning` (default), `info` or `debug`. Logs go to stderr and contain tool names, outcomes and durations only: never arguments, transcripts or tokens. |
| `A4SX_MCP_MAX_PUBLISH_BYTES` | Lower or raise the 2 MiB `publish_session` cap (the server may still refuse larger uploads). |
| `A4SX_MCP_PER_MIN`, `A4SX_MCP_ACQUIRE_PER_MIN`, `A4SX_MCP_PUBLISH_PER_MIN` | Local rate limits (240, 20, 10 per minute). `0` turns a local limit off. |

## Local server or remote `/mcp`?

a4sx also runs a hosted MCP server at `https://session-exchange.com/mcp`, with browser sign-in over
OAuth (scopes such as `library:read`); public search there works without signing in. Clients that
support remote MCP servers with OAuth can connect to it directly and need nothing installed:

```sh
claude mcp add --transport http a4sx https://session-exchange.com/mcp
```

This package is the option for clients without remote OAuth support, and for setups that already use
`a4sx login`. Both expose the five session tools below; the hosted server lists further tools of its
own (for example, starting a purchase for the account holder to confirm), which this package does not
have.

Same in both:
- the five session tools' names, input schemas (including the `harness` filter), annotations, and the
  server instructions;
- the untrusted framing: the text of `fetch_session_context` (notice, nonce envelope, line-break
  normalisation, escaping, per-field caps, sizing, canonical sessions of other harnesses) and the JSON
  envelope, `notice` field, per-field caps, 64 KiB result bound and hint line of `search_sessions`,
  `get_session_summary` and `acquire_session`;
- the result fields (plus the local extras listed below);
- the error codes `invalid_arguments`, `credential_not_accepted`, `rate_limited`, `not_found`,
  `too_large`, `content_sha_mismatch`, `not_a_transcript` and `no_transcript`;
- JSON-RPC error `-32029` when the overall request limit is exceeded.

Differences of this local server:

- **Sign-in.** It uses your `a4sx login` session, so it can do everything your account can in your own
  library. The hosted server takes scoped, short-lived OAuth tokens (`library:read`, `library:acquire`,
  `library:publish`) per client. With no sign-in at all, local tools return `not_signed_in`; the hosted
  server answers with an OAuth challenge instead. The `credential_not_accepted` message says to run
  `a4sx login` rather than to get a scoped token.
- **Rate limits.** They are counted per process, not per account. There is no failed-sign-in limit,
  because there is no sign-in step here. `retry_after_s` comes from the API's error body, not from the
  `Retry-After` header.
- **`untrusted`.** Besides `acquired_from` on the row and its parents (which is all the hosted server
  checks), it also uses this machine's record of untrusted sessions from the `a4sx` SDK. A session
  missing from your library listing counts as untrusted in both.
- **`publish_session`:**
  - Every upload carries an idempotency key: yours if you pass `idempotency_key`, else a fresh one.
    The hosted server sends a key only if you pass one.
  - Uploads are retried twice, with that same key, on network errors, 429 and 502-504; when the
    server is busy scrubbing other uploads, up to 6 attempts, each after the wait it asks for.
  - The body, title and label are pre-scrubbed locally, so the `X-Content-SHA256` sent to the API
    covers the scrubbed bytes.
  - The content check is stricter: every line must be a JSON record with a `type`, and the file a
    Claude Code or Codex CLI session.
  - `parent` is resolved like the CLI resolves names (exact id, then label, then a unique part of the
    title or id). The hosted server passes it through verbatim.
  - Without `parent`, a transcript you resumed with `a4sx resume` gets its parent edge from the SDK's
    local lineage record. The hosted server records no edge.
  - The result has extra `client_redactions` and `untrusted` fields.
- **`payment_required`.** The price comes from the public listing; the hosted server reads its pricing
  store.
- **Server name.** It is `a4sx-mcp` in the MCP handshake (hosted: `com.session-exchange/sessions`).

## Development

```sh
git clone https://github.com/crossvault/a4sx-mcp && cd a4sx-mcp
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
pytest -q          # offline: the tools run against a local stub server
ruff check . && reuse lint
```

The tests never touch the network: tool tests run against `tests/stub_server.py` on 127.0.0.1, the
protocol test uses the MCP SDK's in-process client, and a guard fails any test that resolves or
connects to a non-loopback address. See [CONTRIBUTING.md](CONTRIBUTING.md).

## About

`a4sx-mcp` is made by crossVault GmbH, the company behind **a4sx**
([session-exchange.com](https://session-exchange.com)), a library and marketplace for coding-agent
sessions. It is a thin client: the tools call the public a4sx API through the open-source
[`a4sx`](https://github.com/crossvault/a4sx) SDK, and the hosted service is not part of this
repository. You need an a4sx account for everything except public search. It is open source so you
can check exactly what it sends before you connect it to your agent. Parts of this project were
developed with AI assistance (Claude).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

Apache-2.0, see [LICENSE](LICENSE). Copyright 2026 crossVault GmbH.
