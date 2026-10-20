// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { calls, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import type { CliLookup } from "../../cli";

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
const fakeContext = () => ({ subscriptions: [] as { dispose(): unknown }[] });
const found = (p: string) => (): CliLookup => ({ found: true, path: p });
const missing = (): CliLookup => ({ found: false, reason: "not-on-path" });

describe("activate: wiring", () => {
  beforeEach(resetCalls);

  it("registers both commands under the ids package.json contributes", () => {
    const ctx = fakeContext();
    ext.activate(ctx as any);
    const contributed = pkg.contributes.commands.map((c: { command: string }) => c.command).sort();
    assert.deepStrictEqual(contributed, [ext.CMD_OPEN_LIBRARY, ext.CMD_SAVE].sort());
    assert.deepStrictEqual([...calls.commands.keys()].sort(), contributed);
  });

  it("registers the MCP provider under the id package.json contributes", () => {
    ext.activate(fakeContext() as any);
    const ids = pkg.contributes.mcpServerDefinitionProviders.map((p: { id: string }) => p.id);
    assert.deepStrictEqual(ids, [ext.MCP_PROVIDER_ID]);
    assert.ok(calls.mcpProviders.has(ext.MCP_PROVIDER_ID));
  });

  it("an editor without the MCP provider API still gets both commands", () => {
    const vscodeFake = require("vscode");
    const saved = vscodeFake.lm;
    vscodeFake.lm = undefined;
    try {
      ext.activate(fakeContext() as any);
    } finally {
      vscodeFake.lm = saved;
    }
    assert.strictEqual(calls.mcpProviders.size, 0);
    assert.deepStrictEqual([...calls.commands.keys()].sort(), [ext.CMD_OPEN_LIBRARY, ext.CMD_SAVE].sort());
  });

  it("disposes everything it registered", () => {
    const ctx = fakeContext();
    ext.activate(ctx as any);
    ctx.subscriptions.forEach((d) => d.dispose());
    assert.strictEqual(calls.commands.size, 0);
    assert.strictEqual(calls.mcpProviders.size, 0);
  });

  it("the MCP provider offers the public and the library server, HTTP only, no headers/tokens", async () => {
    ext.activate(fakeContext() as any);
    const provider = calls.mcpProviders.get(ext.MCP_PROVIDER_ID);
    const defs = await provider.provideMcpServerDefinitions();
    assert.deepStrictEqual(
      defs.map((d: any) => [d.label, d.uri.toString()]),
      [["a4sx", "https://session-exchange.com/mcp"], ["a4sx library", "https://session-exchange.com/mcp/library"]],
    );
    for (const d of defs) {
      assert.deepStrictEqual(d.headers, {}, "no auth header: VS Code runs the sign-in");
    }
    const server = defs[1];
    assert.strictEqual(await provider.resolveMcpServerDefinition(server), server);
  });

  it("only cliPath is configurable, machine-scoped, no secret-shaped settings", () => {
    const props = Object.keys(pkg.contributes.configuration.properties);
    assert.deepStrictEqual(props, ["a4sx.cliPath"]);
    assert.strictEqual(pkg.contributes.configuration.properties["a4sx.cliPath"].scope, "machine");
  });

  it("the manifest names the Marketplace publisher and a PNG icon of at least 128x128", () => {
    assert.strictEqual(pkg.publisher, "crossvaultGmbH");
    const icon = fs.readFileSync(path.join(__dirname, "..", "..", "..", pkg.icon));
    assert.ok(icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "icon is a PNG");
    assert.ok(icon.readUInt32BE(16) >= 128 && icon.readUInt32BE(20) >= 128, "icon is at least 128x128");
  });

  it("the listing names the product a4sx and links only public places", () => {
    const listing = ["package.json", "README.md", "CHANGELOG.md"].map((f) =>
      fs.readFileSync(path.join(__dirname, "..", "..", "..", f), "utf8"));
    for (const text of listing) {
      for (const url of text.match(/https?:\/\/[^\s")\]]+/g) ?? []) {
        assert.ok(/^https:\/\/(session-exchange\.com|github\.com\/crossvault\/|code\.visualstudio\.com|modelcontextprotocol\.io)/.test(url),
          `unexpected link in public text: ${url}`);
      }
    }
    assert.ok(listing[1].includes("a4sx"), "README names the product");
  });
});

describe("a4sx.saveSession", () => {
  beforeEach(resetCalls);

  it("runs `a4sx push --latest` in a visible terminal, without a shell", async () => {
    await ext.saveSession(found("/usr/local/bin/a4sx"));
    assert.strictEqual(calls.terminals.length, 1);
    const t = calls.terminals[0];
    assert.deepStrictEqual(t.options, { name: ext.TERMINAL_NAME, shellPath: "/usr/local/bin/a4sx", shellArgs: ["push", "--latest"] });
    assert.ok(t.shown, "terminal is shown");
    assert.strictEqual(calls.errors.length, 0);
    assert.strictEqual(calls.opened.length, 0, "no browser, no network");
  });

  it("passes the a4sx.cliPath setting to the lookup", async () => {
    calls.config["a4sx.cliPath"] = "/opt/a4sx/bin/a4sx";
    let seen: string | undefined = "unset";
    await ext.saveSession((configured) => { seen = configured; return { found: true, path: configured! }; });
    assert.strictEqual(seen, "/opt/a4sx/bin/a4sx");
    assert.strictEqual(calls.terminals[0].options.shellPath, "/opt/a4sx/bin/a4sx");
  });

  it("CLI missing: shows an error with an install link, opens nothing until clicked, runs nothing", async () => {
    calls.nextErrorChoice = undefined;
    await ext.saveSession(missing);
    assert.strictEqual(calls.terminals.length, 0, "nothing is run or installed");
    assert.strictEqual(calls.errors.length, 1);
    assert.match(calls.errors[0].message, /a4sx command was not found on your PATH/);
    assert.deepStrictEqual(calls.errors[0].items, ["How to install"]);
    assert.deepStrictEqual(calls.opened, []);
  });

  it("CLI missing + 'How to install' clicked: opens the install guide on session-exchange.com", async () => {
    calls.nextErrorChoice = "How to install";
    await ext.saveSession(missing);
    assert.deepStrictEqual(calls.opened, ["https://session-exchange.com/guide/cli"]);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("an invalid a4sx.cliPath is named in the error", async () => {
    await ext.saveSession(() => ({ found: false, reason: "configured-path-invalid", configured: "/nope/a4sx" }));
    assert.match(calls.errors[0].message, /a4sx\.cliPath setting points to "\/nope\/a4sx"/);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("the registered command runs the real lookup", async () => {
    ext.activate(fakeContext() as any);
    calls.config["a4sx.cliPath"] = "/definitely/not/here/a4sx";
    await calls.commands.get(ext.CMD_SAVE)!();
    assert.strictEqual(calls.terminals.length, 0);
    assert.match(calls.errors[0].message, /not an executable file/);
  });
});

describe("a4sx.openLibrary", () => {
  beforeEach(resetCalls);

  it("opens the web library in the browser", async () => {
    ext.activate(fakeContext() as any);
    await calls.commands.get(ext.CMD_OPEN_LIBRARY)!();
    assert.deepStrictEqual(calls.opened, ["https://session-exchange.com/library"]);
    assert.strictEqual(calls.terminals.length, 0);
  });
});
