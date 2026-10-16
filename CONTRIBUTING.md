# Contributing

Thanks for helping. Bug reports, fixes and reports of MCP clients that behave differently are all
welcome.

## Developer Certificate of Origin (DCO)

Every commit must be signed off under the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
The sign-off certifies that you wrote the change, or otherwise have the right to submit it under this
project's licence (Apache-2.0).

Add it with `git commit -s`, which appends a line using your git name and email:

```
Signed-off-by: Your Name <you@example.com>
```

A DCO check runs on every pull request. To fix a missing sign-off on your last commit, run
`git commit --amend -s` and force-push your branch. For several commits, run
`git rebase --signoff main`. We don't use a CLA.

## Pull requests

- Keep each pull request to one change, with a test.
- Tests never touch the network: tool tests run against the local stub server in
  `tests/stub_server.py`, protocol tests use the MCP SDK's in-process client (and one real stdio
  subprocess against the stub), and a guard fails any test that opens a non-loopback connection. Use
  synthetic transcripts and token-shaped strings assembled at runtime, never real ones.
- Before pushing, run `ruff check .`, `reuse lint` and `pytest -q`; CI runs the same on Python 3.10-3.13.
- The tool names, input schemas, annotations and limits mirror the hosted a4sx `/mcp` server. Changing
  any of them is a compatibility change: open an issue first.
- Behaviour that is not MCP-specific (talking to the a4sx API, scrubbing, sign-in) belongs in the
  [`a4sx`](https://github.com/crossvault/a4sx) SDK, not here.
- Never log tool arguments, results, transcript text or tokens.
- New source files start with the SPDX header:

  ```python
  # SPDX-License-Identifier: Apache-2.0
  # Copyright 2026 crossVault GmbH
  ```

  If you prefer to keep your own copyright line, add it below; the sign-off is what matters.

## VS Code extension

The extension lives in `vscode/` (TypeScript, Node.js 22). Before pushing a change to it, run
`npm install`, `npm run compile` and `npm test` in that directory; CI runs the same. Don't commit
`node_modules/`, `out/` or `.vsix` files.

The `publisher` in `vscode/package.json` is a placeholder (`a4sx`) until the Visual Studio Marketplace
publisher id is set. Nothing in this repository packages or publishes the extension.

## AI-assisted contributions

You may use AI tools. You are still the author: you must understand and be able to explain every line,
the DCO sign-off is yours, and the tests must pass. Say in the pull request if a substantial part was
generated. Unreviewed bulk changes will be closed.

## Security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).
