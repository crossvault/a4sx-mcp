// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defaultFallbackDirs, findCli } from "../../cli";

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
    assert.deepStrictEqual(findCli(undefined, { pathEnv: "/nonexistent", platform: "linux", fallbackDirs: [] }), { found: false, reason: "not-on-path" });
  });

  it("reports not-on-path for an empty PATH", () => {
    assert.deepStrictEqual(findCli(undefined, { pathEnv: "", platform: "linux", fallbackDirs: [] }), { found: false, reason: "not-on-path" });
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

  describe("fallback directories (a VS Code started from the dock has a short PATH)", () => {
    let home: string;
    let homeExe: string;
    let other: string;
    let otherExe: string;

    before(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-vscode-home-"));
      fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
      homeExe = path.join(home, ".local", "bin", "a4sx");
      fs.writeFileSync(homeExe, "#!/bin/sh\n");
      fs.chmodSync(homeExe, 0o755);
      other = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-vscode-other-"));
      otherExe = path.join(other, "a4sx");
      fs.writeFileSync(otherExe, "#!/bin/sh\n");
      fs.chmodSync(otherExe, 0o755);
    });

    after(() => {
      fs.unlinkSync(homeExe);
      fs.rmdirSync(path.join(home, ".local", "bin"));
      fs.rmdirSync(path.join(home, ".local"));
      fs.rmdirSync(home);
      fs.unlinkSync(otherExe);
      fs.rmdirSync(other);
    });

    it("the defaults are ~/.local/bin, /usr/local/bin, /opt/homebrew/bin; none on Windows", () => {
      assert.deepStrictEqual(defaultFallbackDirs("darwin", "/Users/u"), ["/Users/u/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"]);
      assert.deepStrictEqual(defaultFallbackDirs("linux", "/home/u"), ["/home/u/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"]);
      assert.deepStrictEqual(defaultFallbackDirs("win32", "C:\\Users\\u"), []);
    });

    it("finds a4sx in ~/.local/bin when PATH lacks it", () => {
      assert.deepStrictEqual(findCli("", { pathEnv: "/nonexistent", homeDir: home, platform: "linux" }), { found: true, path: homeExe });
    });

    it("a4sx on PATH wins over the fallback directories", () => {
      assert.deepStrictEqual(findCli("", { pathEnv: other, homeDir: home, platform: "linux" }), { found: true, path: otherExe });
    });

    it("tries the fallback directories in order, skipping ones without an executable a4sx", () => {
      assert.deepStrictEqual(findCli("", { pathEnv: "", platform: "darwin", fallbackDirs: ["/nonexistent", dir, other] }), { found: true, path: exe });
      const noExec = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-vscode-noexec-"));
      const noExecFile = path.join(noExec, "a4sx");
      fs.writeFileSync(noExecFile, "");
      fs.chmodSync(noExecFile, 0o644);
      try {
        assert.deepStrictEqual(findCli("", { pathEnv: "", platform: "darwin", fallbackDirs: [noExec, other] }), { found: true, path: otherExe });
      } finally {
        fs.unlinkSync(noExecFile);
        fs.rmdirSync(noExec);
      }
    });

    it("a configured path still wins over PATH and the fallbacks", () => {
      assert.deepStrictEqual(findCli(exe, { pathEnv: other, homeDir: home, platform: "linux" }), { found: true, path: exe });
    });

    it("an invalid configured path is still reported, not replaced by a fallback", () => {
      assert.deepStrictEqual(findCli(plain, { pathEnv: "", homeDir: home, platform: "linux" }), {
        found: false, reason: "configured-path-invalid", configured: plain,
      });
    });

    it("on Windows, the POSIX fallback directories are not used", () => {
      assert.deepStrictEqual(findCli("", { pathEnv: "", pathExt: ".EXE", homeDir: home, platform: "win32" }), { found: false, reason: "not-on-path" });
    });
  });
});
