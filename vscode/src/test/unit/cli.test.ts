// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findCli } from "../../cli";

describe("findCli", () => {
  let dir: string;
  let exe: string;
  let plain: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-vscode-test-"));
    exe = path.join(dir, "a4sx");
    fs.writeFileSync(exe, "#!/bin/sh\n");
    fs.chmodSync(exe, 0o755);
    plain = path.join(dir, "not-executable");
    fs.writeFileSync(plain, "");
    fs.chmodSync(plain, 0o644);
  });

  after(() => {
    fs.unlinkSync(exe);
    fs.unlinkSync(plain);
    fs.rmdirSync(dir);
  });

  it("finds a4sx on PATH", () => {
    assert.deepStrictEqual(findCli("", { pathEnv: `/nonexistent:${dir}`, platform: "linux" }), { found: true, path: exe });
  });

  it("reports not-on-path when PATH has no a4sx", () => {
    assert.deepStrictEqual(findCli(undefined, { pathEnv: "/nonexistent", platform: "linux" }), { found: false, reason: "not-on-path" });
  });

  it("reports not-on-path for an empty PATH", () => {
    assert.deepStrictEqual(findCli(undefined, { pathEnv: "", platform: "linux" }), { found: false, reason: "not-on-path" });
  });

  it("a configured path wins over PATH", () => {
    assert.deepStrictEqual(findCli(exe, { pathEnv: "", platform: "linux" }), { found: true, path: exe });
  });

  it("expands ~ in a configured path", () => {
    assert.deepStrictEqual(findCli("~/a4sx", { homeDir: dir, platform: "linux" }), { found: true, path: exe });
  });

  it("a configured path that is not executable is rejected, not silently replaced by PATH", () => {
    assert.deepStrictEqual(findCli(plain, { pathEnv: dir, platform: "linux" }), {
      found: false, reason: "configured-path-invalid", configured: plain,
    });
  });

  it("a configured directory is rejected", () => {
    assert.strictEqual(findCli(dir, { platform: "linux" }).found, false);
  });

  it("on Windows, tries PATHEXT extensions", () => {
    const winDir = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-vscode-win-"));
    const cmd = path.join(winDir, "a4sx.CMD");
    fs.writeFileSync(cmd, "");
    try {
      assert.deepStrictEqual(findCli("", { pathEnv: winDir, pathExt: ".EXE;.CMD", platform: "win32" }), { found: true, path: cmd });
    } finally {
      fs.unlinkSync(cmd);
      fs.rmdirSync(winDir);
    }
  });
});
