// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Runs inside a real VS Code (via `npm run test:integration`, @vscode/test-cli + @vscode/test-electron).
// It downloads a VS Code build and needs a display (use xvfb-run on a headless Linux box).
import * as assert from "assert";
import * as vscode from "vscode";

suite("a4sx extension (in VS Code)", () => {
  test("activates and registers both commands", async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "a4sx");
    assert.ok(ext, "extension is loaded");
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("a4sx.saveSession"));
    assert.ok(commands.includes("a4sx.openLibrary"));
  });
});
