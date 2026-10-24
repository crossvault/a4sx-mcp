// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The CLI-free seed (nativeSeed.ts) against the a4sx CLI's own rules and examples (cli/amdx.py).
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  claudeProjectsDir, cliConfigDir, internalSessionId, projectDirName, rewriteTranscript, SeedError, seedTranscript, writeAtomic,
} from "../../nativeSeed";
import { harnessId, otherHarness } from "../../api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-seed-"));
}

function rmTree(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
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

describe("native seed: Claude Code's project folder name (cli/amdx.py _project_dir_name)", () => {
  it("matches the CLI's own examples", () => {
    // tests/test_cli_base_and_paths.py and the function's docstring
    assert.strictEqual(projectDirName("/root/workspace/agent-mdx/.claude/worktrees/x"), "-root-workspace-agent-mdx--claude-worktrees-x");
    assert.strictEqual(projectDirName("/a/b.c_d e"), "-a-b-c-d-e");
    assert.strictEqual(projectDirName("/a/b.c_d"), "-a-b-c-d");
  });

  it("replaces every non-alphanumeric character, per code point, like Python's re.sub on a str", () => {
    assert.strictEqual(projectDirName("C:\\Users\\me\\My Proj"), "C--Users-me-My-Proj", "Windows paths: the CLI applies the same rule");
    assert.strictEqual(projectDirName("/home/zoë/😀x"), "-home-zo---x", "one dash per character (ë, /, 😀), even outside the BMP");
    assert.strictEqual(projectDirName("/a/B9"), "-a-B9");
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
});

describe("native seed: the transcript", () => {
  it("the internal sessionId is the first one named, checked with the CLI's 0.10.77 rule", () => {
    assert.strictEqual(internalSessionId(transcript), "base-sid_1");
    for (const bad of ["../x", "a/b", "-lead", "x".repeat(129), "a b"]) {
      assert.throws(() => internalSessionId(JSON.stringify({ sessionId: bad })), (e: any) => e instanceof SeedError && e.code === "bad-session-id", bad);
    }
    assert.throws(() => internalSessionId(JSON.stringify({ sessionId: 7 })), (e: any) => e.code === "bad-session-id");
    assert.throws(() => internalSessionId("{}\n[]\nnope\n"), (e: any) => e.code === "no-session-id");
  });

  it("rewrites only the top-level sessionId of every record; drops blank and unparsable lines like the CLI", async () => {
    const out = await rewriteTranscript(transcript, "11111111-2222-4333-8444-555555555555", { chunk: 1 });
    const lines = out.split("\n");
    assert.strictEqual(lines.pop(), "", "ends with a newline");
    const recs = lines.map((l) => JSON.parse(l));
    assert.strictEqual(recs.length, 3);
    assert.deepStrictEqual(recs[0], { type: "summary", summary: "x" }, "a record without sessionId is unchanged");
    assert.strictEqual(recs[1].sessionId, "11111111-2222-4333-8444-555555555555");
    assert.strictEqual(recs[1].message.content, "hi \u00e9 \ud83d\ude00");
    assert.strictEqual(recs[2].message.content[0].sessionId, "nested-stays");
  });

  it("yields while it works on a large transcript and reports progress; a cancel stops it", async () => {
    const big = Array.from({ length: 20_000 }, (_v, i) => JSON.stringify({ sessionId: "s", i })).join("\n");
    const shares: number[] = [];
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    try {
      await rewriteTranscript(big, "n", { progress: (s) => shares.push(s), chunk: 1000 });
    } finally {
      clearInterval(timer);
    }
    assert.ok(shares.length >= 20 && shares[shares.length - 1] === 1);
    assert.ok(ticks > 0, "the event loop ran in between");
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(rewriteTranscript(big, "n", { signal: abort.signal, chunk: 1000 }), (e: any) => e.code === "cancelled");
  });

  (process.platform === "win32" ? it.skip : it)("writes atomically: mode 600, no temp file left, an existing file is replaced whole", async () => {
    const dir = tmpdir();
    try {
      const dest = path.join(dir, "s.jsonl");
      await writeAtomic(dest, "a\n");
      assert.strictEqual(fs.readFileSync(dest, "utf8"), "a\n");
      assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o600);
      await writeAtomic(dest, "b\n");
      assert.strictEqual(fs.readFileSync(dest, "utf8"), "b\n");
      assert.deepStrictEqual(fs.readdirSync(dir), ["s.jsonl"]);
      await assert.rejects(writeAtomic(path.join(dir, "missing", "x.jsonl"), "c"));
      assert.deepStrictEqual(fs.readdirSync(dir), ["s.jsonl"], "a failed write leaves nothing behind");
    } finally {
      rmTree(dir);
    }
  });

  it("seeds into <CLAUDE_CONFIG_DIR>/projects/<projectDirName(cwd)>/<uuid4>.jsonl, plus the CLI's lineage sidecar", async () => {
    const home = tmpdir();
    try {
      const env = { CLAUDE_CONFIG_DIR: path.join(home, "claude-cfg") };
      const id = await seedTranscript(transcript, { cwd: "/w/my proj", env, home }, { cid: "c-1", version: "v3" });
      assert.match(id, UUID);
      const file = path.join(home, "claude-cfg", "projects", "-w-my-proj", `${id}.jsonl`);
      const recs = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepStrictEqual(recs.filter((r) => "sessionId" in r).map((r) => r.sessionId), [id, id]);
      const lineage = JSON.parse(fs.readFileSync(path.join(home, ".config", "a4sx", "lineage", `${id}.json`), "utf8"));
      assert.deepStrictEqual(lineage, { parent_cid: "c-1", parent_version: "v3", base_internal: "base-sid_1" });
      const again = await seedTranscript(transcript, { cwd: "/w/my proj", env, home }, { cid: "c-1" });
      assert.notStrictEqual(again, id, "a fresh id every time");
    } finally {
      rmTree(home);
    }
  });

  it("a transcript with a bad internal id writes nothing", async () => {
    const home = tmpdir();
    try {
      await assert.rejects(seedTranscript(JSON.stringify({ sessionId: "../../etc" }), { cwd: "/w", env: {}, home }, { cid: "c" }),
        (e: any) => e.code === "bad-session-id");
      assert.deepStrictEqual(fs.readdirSync(home), []);
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-claude-"));
    try {
      assert.deepStrictEqual(claudeFallbackDirs("linux", "/h"), ["/h/.local/bin", "/usr/local/bin", "/opt/homebrew/bin", "/h/.claude/local"]);
      assert.deepStrictEqual(claudeFallbackDirs("win32", "C:\\h"), []);
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
});
