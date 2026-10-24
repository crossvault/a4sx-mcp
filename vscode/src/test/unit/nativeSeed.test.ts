// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The CLI-free seed (nativeSeed.ts): Claude Code 2.1.x's project-folder rule, the CLI's transcript
// rules (cli/amdx.py), symlinked folders, the streamed atomic write, and memory on a large transcript.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  claudeProjectsDir, claudeStringHash, cliConfigDir, projectDirName, resolvedCwd, rewriteLine, SeedError, seedTranscript, writeAtomic,
} from "../../nativeSeed";
import { harnessId, otherHarness } from "../../api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-seed-"));
}

function rmTree(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isDirectory()) {
      rmTree(p);
    } else {
      fs.unlinkSync(p);
    }
  }
  fs.rmdirSync(dir);
}

const transcript = [
  JSON.stringify({ type: "summary", summary: "x" }),
  JSON.stringify({ type: "user", sessionId: "base-sid_1", cwd: "/w", message: { content: "hi \u00e9 \ud83d\ude00" } }),
  "",
  "not json at all",
  JSON.stringify({ type: "assistant", sessionId: "base-sid_1", message: { content: [{ text: "ok", sessionId: "nested-stays" }] } }),
  "   ",
].join("\n");

/** Seeds into a fresh temp home and returns the written records and the new id. */
async function seedInto(home: string, text: string, cwd = "/w/proj", chunk?: number) {
  const env = { CLAUDE_CONFIG_DIR: path.join(home, "claude-cfg") };
  const id = await seedTranscript(b64(text), { cwd, env, home }, { cid: "c-1", version: "v3" }, { chunk });
  const file = path.join(home, "claude-cfg", "projects", projectDirName(await resolvedCwd(cwd)), `${id}.jsonl`);
  return { id, file, recs: fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}

describe("native seed: Claude Code's project folder name (2.1.x)", () => {
  it("every non-alphanumeric UTF-16 unit becomes '-' (the CLI's own examples still hold)", () => {
    assert.strictEqual(projectDirName("/root/workspace/agent-mdx/.claude/worktrees/x"), "-root-workspace-agent-mdx--claude-worktrees-x");
    assert.strictEqual(projectDirName("/a/b.c_d e"), "-a-b-c-d-e");
    assert.strictEqual(projectDirName("C:\\Users\\me\\My Proj"), "C--Users-me-My-Proj");
  });

  it("a character outside the BMP gives two dashes (the reviewer's example)", () => {
    assert.strictEqual(projectDirName("/home/zoë/😀x"), "-home-zo----x");
  });

  it("over 200 characters: cut to 200, then '-' and the base-36 hash of the full path", () => {
    const long = `/${"a".repeat(250)}`;
    assert.strictEqual(claudeStringHash(long), -931632369, "the same 32-bit string hash Claude Code uses");
    assert.strictEqual(projectDirName(long), `-${"a".repeat(199)}-feo44x`);
    const emoji = `/home/dev/${"x".repeat(195)}/😀`;
    assert.strictEqual(projectDirName(emoji), `${"-home-dev-"}${"x".repeat(190)}-cvfe0l`);
    const exactly200 = `/${"b".repeat(199)}`;
    assert.strictEqual(projectDirName(exactly200), `-${"b".repeat(199)}`, "200 characters stay as they are");
  });

  it("the projects folder honours CLAUDE_CONFIG_DIR, else ~/.claude", () => {
    assert.strictEqual(claudeProjectsDir({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u"), path.join("/cfg", "projects"));
    assert.strictEqual(claudeProjectsDir({}, "/home/u"), path.join("/home/u", ".claude", "projects"));
  });

  it("the CLI's config folder: ~/.config/a4sx, or the older ~/.config/agent-mdx when only that exists", () => {
    const home = tmpdir();
    try {
      assert.strictEqual(cliConfigDir(home), path.join(home, ".config", "a4sx"));
      fs.mkdirSync(path.join(home, ".config", "agent-mdx"), { recursive: true });
      assert.strictEqual(cliConfigDir(home), path.join(home, ".config", "agent-mdx"));
      fs.mkdirSync(path.join(home, ".config", "a4sx"));
      assert.strictEqual(cliConfigDir(home), path.join(home, ".config", "a4sx"));
    } finally {
      rmTree(home);
    }
  });

  (process.platform === "win32" ? it.skip : it)("a folder reached through a symlink is named by its real path, like Claude Code's process.cwd()", async () => {
    const home = tmpdir();
    try {
      const real = path.join(home, "real", "proj");
      fs.mkdirSync(real, { recursive: true });
      fs.symlinkSync(path.join(home, "real"), path.join(home, "link"));
      const viaLink = path.join(home, "link", "proj");
      const realPath = fs.realpathSync.native(real);
      assert.strictEqual(await resolvedCwd(viaLink), realPath);
      const env = { CLAUDE_CONFIG_DIR: path.join(home, "claude-cfg") };
      const id = await seedTranscript(b64(transcript), { cwd: viaLink, env, home }, { cid: "c" });
      const projects = fs.readdirSync(path.join(home, "claude-cfg", "projects"));
      assert.deepStrictEqual(projects, [projectDirName(realPath)], "the real path, not the link");
      assert.ok(!projects[0].includes("-link-"));
      assert.ok(fs.existsSync(path.join(home, "claude-cfg", "projects", projects[0], `${id}.jsonl`)));
      assert.strictEqual(await resolvedCwd(path.join(home, "missing")), path.join(home, "missing"), "unresolvable: as given");
    } finally {
      rmTree(home);
    }
  });
});

describe("native seed: the transcript", () => {
  it("rewrites only the top-level sessionId of every record; drops blank and unparsable lines like the CLI", async () => {
    const home = tmpdir();
    try {
      const { id, recs } = await seedInto(home, transcript, "/w/proj", 4);   // tiny slices: lines and UTF-8 split across them
      assert.match(id, UUID);
      assert.strictEqual(recs.length, 3);
      assert.deepStrictEqual(recs[0], { type: "summary", summary: "x" }, "a record without sessionId is unchanged");
      assert.strictEqual(recs[1].sessionId, id);
      assert.strictEqual(recs[1].message.content, "hi \u00e9 \ud83d\ude00", "multi-byte characters survive slicing");
      assert.strictEqual(recs[2].sessionId, id);
      assert.strictEqual(recs[2].message.content[0].sessionId, "nested-stays");
      assert.strictEqual(rewriteLine("  ", "n"), undefined);
      assert.strictEqual(rewriteLine("{bad", "n"), undefined);
      assert.strictEqual(rewriteLine('{"sessionId":"x","a":1}', "n"), '{"sessionId":"n","a":1}');
    } finally {
      rmTree(home);
    }
  });

  it("the transcript's own sessionId: the first truthy one, checked with the CLI's 0.10.77 rule; a bad one writes nothing", async () => {
    for (const bad of ["../x", "a/b", "-lead", "x".repeat(129), "a b", 7]) {
      const home = tmpdir();
      try {
        await assert.rejects(seedInto(home, JSON.stringify({ sessionId: bad })), (e: any) => e instanceof SeedError && e.code === "bad-session-id", String(bad));
        const dir = path.join(home, "claude-cfg", "projects", "-w-proj");
        assert.deepStrictEqual(fs.readdirSync(dir), [], "no transcript and no temp file left");
      } finally {
        rmTree(home);
      }
    }
    const home = tmpdir();
    try {
      await assert.rejects(seedInto(home, "{}\n[]\nnope\n"), (e: any) => e.code === "no-session-id");
      const { recs } = await seedInto(home, [JSON.stringify({ sessionId: {} }), JSON.stringify({ sessionId: "good-1" })].join("\n"));
      assert.strictEqual(recs.length, 2, "an empty {} is falsy for the CLI: the next id names the transcript");
    } finally {
      rmTree(home);
    }
  });

  it("seeds into <CLAUDE_CONFIG_DIR>/projects/<name>/<uuid4>.jsonl, plus the CLI's lineage sidecar", async () => {
    const home = tmpdir();
    try {
      const { id, file } = await seedInto(home, transcript, "/w/my proj");
      assert.strictEqual(path.basename(path.dirname(file)), "-w-my-proj");
      const lineage = JSON.parse(fs.readFileSync(path.join(home, ".config", "a4sx", "lineage", `${id}.json`), "utf8"));
      assert.deepStrictEqual(lineage, { parent_cid: "c-1", parent_version: "v3", base_internal: "base-sid_1" });
      const again = await seedInto(home, transcript, "/w/my proj");
      assert.notStrictEqual(again.id, id, "a fresh id every time");
    } finally {
      rmTree(home);
    }
  });

  it("a cancel stops it and leaves no file", async () => {
    const home = tmpdir();
    try {
      const abort = new AbortController();
      abort.abort();
      const env = { CLAUDE_CONFIG_DIR: path.join(home, "cfg") };
      await assert.rejects(seedTranscript(b64(transcript), { cwd: "/w", env, home }, { cid: "c" }, { signal: abort.signal, chunk: 8 }),
        (e: any) => e.code === "cancelled");
      assert.deepStrictEqual(fs.readdirSync(path.join(home, "cfg", "projects", "-w")), []);
    } finally {
      rmTree(home);
    }
  });

  (process.platform === "win32" ? it.skip : it)("writes atomically: mode 600, no temp file left, an existing file is replaced whole", async () => {
    const dir = tmpdir();
    try {
      const dest = path.join(dir, "s.jsonl");
      await writeAtomic(dest, "a\n");
      assert.strictEqual(fs.readFileSync(dest, "utf8"), "a\n");
      assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o600);
      await writeAtomic(dest, async (write) => { await write("b"); await write("\n"); });
      assert.strictEqual(fs.readFileSync(dest, "utf8"), "b\n");
      assert.deepStrictEqual(fs.readdirSync(dir), ["s.jsonl"]);
      await assert.rejects(writeAtomic(path.join(dir, "missing", "x.jsonl"), "c"));
      await assert.rejects(writeAtomic(dest, async () => { throw new Error("boom"); }));
      assert.deepStrictEqual(fs.readdirSync(dir), ["s.jsonl"], "a failed write leaves nothing behind");
      assert.strictEqual(fs.readFileSync(dest, "utf8"), "b\n", "and the old file stays");
    } finally {
      rmTree(dir);
    }
  });

  it("a large transcript is streamed: progress, yields, and memory well under a decoded copy plus its rewrite", async function () {
    this.timeout(60_000);
    const home = tmpdir();
    try {
      const line = JSON.stringify({ type: "assistant", sessionId: "big-1", message: { content: "y".repeat(2000) } });
      const lines = 15_000;   // ~30 MB decoded, ~40 MB as base64
      const big = b64(Array.from({ length: lines }, () => line).join("\n"));
      global.gc?.();
      const before = process.memoryUsage();
      let peak = 0;
      let ticks = 0;
      const timer = setInterval(() => {
        ticks++;
        const m = process.memoryUsage();
        peak = Math.max(peak, m.heapUsed + m.external + m.arrayBuffers - (before.heapUsed + before.external + before.arrayBuffers));
      }, 1);
      const shares: number[] = [];
      const env = { CLAUDE_CONFIG_DIR: path.join(home, "cfg") };
      let id: string;
      try {
        id = await seedTranscript(big, { cwd: "/w/big", env, home }, { cid: "c" }, { progress: (s) => shares.push(s) });
      } finally {
        clearInterval(timer);
      }
      const decodedBytes = (big.length * 3) / 4;
      assert.ok(shares.length >= 20 && shares[shares.length - 1] === 1, "progress in steps");
      assert.ok(ticks > 10, "the event loop kept running");
      // Holding the decoded text, its lines, the rewritten lines and the joined result (0.3.1's first
      // cut) needs about 4x the decoded size on top of the base64; streaming needs a few MB of slices.
      assert.ok(peak < decodedBytes, `peak extra memory ${Math.round(peak / 1e6)} MB < decoded ${Math.round(decodedBytes / 1e6)} MB`);
      const out = fs.readFileSync(path.join(home, "cfg", "projects", "-w-big", `${id}.jsonl`), "utf8");
      assert.strictEqual(out.split("\n").length - 1, lines);
    } finally {
      rmTree(home);
    }
  });

  it("harness checks match the CLI's _refuse_other_harness", () => {
    assert.strictEqual(harnessId({ id: " Claude-Code ", version: "1" }), "claude-code");
    assert.strictEqual(harnessId(undefined), "unknown");
    assert.strictEqual(otherHarness("claude-code"), false);
    assert.strictEqual(otherHarness("unknown", ["transcript.jsonl"]), false);
    assert.strictEqual(otherHarness("codex-cli"), true);
    assert.strictEqual(otherHarness(undefined, ["native/codex-cli.jsonl"]), true);
    assert.strictEqual(otherHarness(undefined, ["native/claude-code.jsonl"]), false);
  });
});

describe("finding claude (no a4sx CLI)", () => {
  (process.platform === "win32" ? it.skip : it)("PATH first, then the a4sx fallbacks and ~/.claude/local, on the extension host", async () => {
    const { findClaude, claudeFallbackDirs } = await import("../../cli");
    const home = tmpdir();
    try {
      assert.deepStrictEqual(claudeFallbackDirs("linux", "/h"), ["/h/.local/bin", "/usr/local/bin", "/opt/homebrew/bin", "/h/.claude/local"]);
      assert.deepStrictEqual(claudeFallbackDirs("win32", "C:\\Users\\me"), ["C:\\Users\\me\\.local\\bin"], "the native Windows installer's folder");
      const local = path.join(home, ".claude", "local");
      fs.mkdirSync(local, { recursive: true });
      const exe = path.join(local, "claude");
      fs.writeFileSync(exe, "#!/bin/sh\n");
      fs.chmodSync(exe, 0o755);
      assert.strictEqual(findClaude({ pathEnv: "", homeDir: home, fallbackDirs: [local] }), exe);
      assert.strictEqual(findClaude({ pathEnv: "", homeDir: home, fallbackDirs: [] }), undefined);
      fs.chmodSync(exe, 0o644);
      assert.strictEqual(findClaude({ pathEnv: local, homeDir: home, fallbackDirs: [] }), undefined, "not executable: not found");
    } finally {
      rmTree(home);
    }
  });

  it("on Windows, claude.cmd / claude.exe win over npm's extensionless sh shim", async () => {
    const { findClaude } = await import("../../cli");
    const dir = tmpdir();
    try {
      for (const f of ["claude", "claude.cmd", "claude.ps1"]) {
        fs.writeFileSync(path.join(dir, f), "x");
      }
      assert.strictEqual(findClaude({ platform: "win32", pathEnv: dir, pathExt: ".com;.exe;.bat;.cmd", homeDir: dir, fallbackDirs: [] }), path.join(dir, "claude.cmd"));
      fs.writeFileSync(path.join(dir, "claude.exe"), "x");
      assert.strictEqual(findClaude({ platform: "win32", pathEnv: dir, pathExt: ".com;.exe;.bat;.cmd", homeDir: dir, fallbackDirs: [] }), path.join(dir, "claude.exe"));
      fs.unlinkSync(path.join(dir, "claude.exe"));
      fs.unlinkSync(path.join(dir, "claude.cmd"));
      assert.strictEqual(findClaude({ platform: "win32", pathEnv: dir, pathExt: ".com;.exe;.bat;.cmd", homeDir: dir, fallbackDirs: [] }), path.join(dir, "claude"), "the bare name only as a last resort");
    } finally {
      rmTree(dir);
    }
  });
});
