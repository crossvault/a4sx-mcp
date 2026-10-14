# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through GitHub's **"Report a vulnerability"** button on this repository's Security tab
(private vulnerability reporting), or by e-mail to **info@session-exchange.com**.

Please include the affected version or commit, the MCP client you used, a description, and a minimal
reproduction with synthetic data only: never send a real transcript, token or key. We aim to acknowledge
reports within 5 working days and to agree on a disclosure timeline with you.

## Scope

In scope (this repository, the `a4sx-mcp` server):

- the a4sx token: logged, written to stdout or stderr, included in a tool result or error, or sent to a
  host other than the server that issued it;
- tool arguments, results or transcript text appearing in the server's log output;
- a tool doing more than it documents: `acquire_session` causing a purchase or calling a billing route,
  `publish_session` saving anything other than privately, a read-only tool changing data;
- the size and rate limits being bypassable through this server;
- session content that escapes the untrusted envelope of `fetch_session_context`, appears before or
  removes its notice, or fakes a turn heading;
- input that makes the server crash, hang, or use excessive CPU or memory.

Out of scope:

- the `a4sx` SDK and CLI (token storage, the pre-scrub rules): report those to
  [crossvault/a4sx](https://github.com/crossvault/a4sx) or the same e-mail address;
- the hosted service at session-exchange.com, including its remote `/mcp` endpoint. Report problems with
  it to the same address; they are handled, but not in this repository;
- names, e-mail addresses, IP addresses or paths left in an uploaded transcript. The pre-scrub is
  documented not to remove them; it is a backstop, not a guarantee;
- planted instructions in a session from another author that stay inside the envelope (prompt
  injection through loaded context in general).
  Loaded sessions are marked as reference material, but treat sessions from others as untrusted input
  and keep your client's tool-approval prompts on.

## Supported versions

Only the latest release receives fixes.
