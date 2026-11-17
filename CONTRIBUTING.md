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
a manual run, and only after the owner approves the `marketplace` environment (repository admins can skip
that approval unless the environment's *Allow administrators to bypass configured protection rules* is
turned off). One approval releases both registries' jobs, and both publish the same `.vsix`. Branch
pushes and pull requests never package or publish it.

### Open VSX

The workflow publishes to Open VSX with [trusted publishing](https://github.com/eclipse/openvsx/wiki/Trusted-Publishing):
GitHub's OIDC ID token is exchanged for a publishing token that is valid for a few minutes. No Open VSX
token is stored in this repository. Open VSX lets a trusted publisher be registered only by an *owner* of
the namespace and only for an extension that already has a version, so the owner sets it up once:

1. Create an Eclipse Foundation account at https://accounts.eclipse.org/user/register and enter, in its
   *GitHub Username* field, the GitHub account you sign in to Open VSX with.
2. Sign in at https://open-vsx.org with that GitHub account (account icon, top right).
3. Sign the Eclipse Foundation Open VSX Publisher Agreement: on
   https://open-vsx.org/user-settings/profile click *Log in with Eclipse*, then *Show Publisher
   Agreement*, read it and click *Agree*.
4. Create a temporary access token in *Settings → Access Tokens* (https://open-vsx.org/user-settings/tokens):
   *Generate New Token*, describe it (for example "a4sx bootstrap"), *Generate Token*, and copy it. It is
   needed only for steps 5 and 6, and is never added to GitHub.
5. Create the namespace and publish the first version (0.8.0) with that token, locally. Use the exact
   `.vsix` that the `vscode-v0.8.0` run published to the Marketplace (its sha256 is in that run's log;
   the artifact is kept until 2027-02-15),
   the ovsx pinned in `vscode/package-lock.json`, and pass the token through the environment so it stays
   out of the shell history and the process list:

   ```sh
   cd vscode && npm ci --ignore-scripts
   gh run download 43994223063 -R crossvault/a4sx-mcp -n vsix -D "$HOME/a4sx-vsix"
   sha256sum "$HOME/a4sx-vsix/a4sx-0.8.0.vsix"
   # must print 16a01dc23608775c5252f80fd38f543e1eeca7c319a44f8c50f3201706ee6cfc
   read -rs OVSX_PAT && export OVSX_PAT     # paste the token; it is not echoed
   npx --no-install ovsx create-namespace crossvaultGmbH   # exactly this case, as in package.json
   npx --no-install ovsx publish --packagePath "$HOME/a4sx-vsix/a4sx-0.8.0.vsix"
   unset OVSX_PAT
   ```

6. Become owner of the namespace. Creating it makes you only a *contributor*. Claim ownership with a
   public issue at https://github.com/EclipseFdn/open-vsx.org/issues/new/choose (process:
   https://github.com/eclipse/openvsx/wiki/Namespace-Access) and wait until it is granted; the namespace
   then shows as verified.
7. Register the trusted publisher: *Settings → Trusted Publishers*
   (https://open-vsx.org/user-settings/trusted-publishers), namespace `crossvaultGmbH`, extension `a4sx`,
   provider GitHub Actions, with exactly:
   - Organization or user name: `crossvault`
   - Repository name: `a4sx-mcp`
   - Workflow filename: `vscode-publish.yml`
   - Environment name: `marketplace` (required here: Open VSX trusts any ref that runs the workflow file
     otherwise; the environment adds the owner approval and the `main` / `vscode-v*` ref policy)
8. Delete the temporary token in *Settings → Access Tokens*.

Open VSX deletes the registration if its author stops being an owner of the namespace; register it again
then.

Check the setup with a manual run of *VS Code extension publish* on `main` with `mode: verify`,
`target: openvsx`: it runs ovsx's token exchange and publishes nothing. Until step 7 is done, the Open VSX
job fails with a message saying so; it never skips silently. Until then, release with a tag as usual and
expect only that job to fail, or start manual runs with `target: marketplace`.

A `vscode-v*` tag always publishes to both registries, from one `.vsix`. If only the Open VSX job of such a
run fails, fix the cause and use *Re-run failed jobs* on that run (possible for 30 days): it publishes the
same `.vsix` artifact. Otherwise, to publish a version that is already on the Marketplace to Open VSX
only, start the workflow on that version's `vscode-v<version>` tag with `mode: publish`,
`target: openvsx` (the Marketplace refuses a version it already has). The workflow refuses a
single-registry publish from any other ref, so the `.vsix` is always rebuilt from the released sources.

## AI-assisted contributions

You may use AI tools. You are still the author: you must understand and be able to explain every line,
the DCO sign-off is yours, and the tests must pass. Say in the pull request if a substantial part was
generated. Unreviewed bulk changes will be closed.

## Security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).
