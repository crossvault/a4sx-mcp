// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Config for `vscode-test` (@vscode/test-cli): the integration tests in a real VS Code.
// The user-data dir lives under the temp dir: VS Code's IPC socket path inside it must stay
// under 107 characters, which a deep checkout path can exceed.
import { defineConfig } from "@vscode/test-cli";
import { tmpdir } from "node:os";
import { join } from "node:path";

const userData = process.env.A4SX_VSCODE_TEST_USER_DATA || join(tmpdir(), "a4sx-vscode-test-ud");

export default defineConfig({
  files: "out/test/integration/**/*.test.js",
  // A4SX_VSCODE_VERSION=1.101.0 checks the minimum version in package.json's engines.
  version: process.env.A4SX_VSCODE_VERSION || "stable",
  mocha: { ui: "tdd", timeout: 20000 },
  launchArgs: ["--disable-extensions", `--user-data-dir=${userData}`],
});
