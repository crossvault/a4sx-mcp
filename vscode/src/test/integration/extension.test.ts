// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Runs inside a real VS Code (via `npm run test:integration`, @vscode/test-cli + @vscode/test-electron).
// It downloads a VS Code build and needs a display (use xvfb-run on a headless Linux box).
import * as assert from "assert";
import * as vscode from "vscode";

suite("a4sx extension (in VS Code)", () => {
  test("activates and registers every command", async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "a4sx");
    assert.ok(ext, "extension is loaded");
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["a4sx.saveSession", "a4sx.openLibrary", "a4sx.signIn", "a4sx.signOut", "a4sx.refreshSessions",
      "a4sx.resumeSession", "a4sx.openSessionOnWeb", "a4sx.copySessionId", "a4sx.searchMarketplace", "a4sx.openListing"]) {
      assert.ok(commands.includes(id), id);
    }
  });

  test("the sidebar views open, and signed out there is no a4sx session", async () => {
    await vscode.commands.executeCommand("a4sx.sessions.focus");
    await vscode.commands.executeCommand("a4sx.marketplace.focus");
    const session = await vscode.authentication.getSession("a4sx", [], { silent: true });
    assert.strictEqual(session, undefined);
  });
});
