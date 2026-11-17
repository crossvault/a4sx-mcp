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

The extension is published as `crossvaultGmbH.a4sx` to the Visual Studio Marketplace and to
[Open VSX](https://open-vsx.org) by `.github/workflows/vscode-publish.yml`, only from a `vscode-v*` tag or
a manual run, and only after the owner approves the `marketplace` environment. One approval releases both
registries' jobs, and both publish the same `.vsix`. Branch pushes and pull requests never package or
publish it.

### Open VSX

Open VSX needs an access token. One-time setup by the owner:

1. Create an Eclipse Foundation account at https://accounts.eclipse.org/user/register and enter, in its
   *GitHub Username* field, the GitHub account you sign in to Open VSX with.
2. Sign in at https://open-vsx.org with that GitHub account (account icon, top right).
3. Sign the Eclipse Foundation Open VSX Publisher Agreement: on
   https://open-vsx.org/user-settings/profile click *Log in with Eclipse*, then *Show Publisher
   Agreement*, read it and click *Agree*.
4. Create an access token in *Settings → Access Tokens* (https://open-vsx.org/user-settings/tokens):
   *Generate New Token*, describe it (for example "a4sx-mcp GitHub Actions"), *Generate Token*, and copy
   it; it is shown only once.
5. Create the namespace once, locally, from any directory (the workflow does not create it):

   ```sh
   npx ovsx@1.3.0 create-namespace crossvaultGmbH -p <token>
   ```

6. Add the token as the secret `OVSX_PAT` of the `marketplace` environment: repository *Settings →
   Environments → marketplace → Environment secrets → Add environment secret*.
7. Optional: to have the namespace shown as verified, claim its ownership with a public issue at
   https://github.com/EclipseFdn/open-vsx.org/issues/new/choose (see
   https://github.com/eclipse/openvsx/wiki/Namespace-Access).

Check the setup with a manual run of *VS Code extension publish* on `main` with `mode: verify`,
`target: openvsx`; it runs `ovsx verify-pat crossvaultGmbH` and publishes nothing. If `OVSX_PAT` is missing
the Open VSX job fails and says so; it never skips silently.

To publish a version that is already on the Marketplace to Open VSX only, run the workflow on `main` with
`mode: publish`, `target: openvsx` (the Marketplace refuses a version it already has). A `vscode-v*` tag
always publishes to both.

## AI-assisted contributions

You may use AI tools. You are still the author: you must understand and be able to explain every line,
the DCO sign-off is yours, and the tests must pass. Say in the pull request if a substantial part was
generated. Unreviewed bulk changes will be closed.

## Security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).
