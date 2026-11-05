// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.5.0: cell and profile management, phase 1. The CLI JSON contract (CLI 0.25.0) and its version gate, the
// in-session refusal, the command builders (POSIX and Windows quoting), the Cells view grouped by mesh with
// the other machines' cells, Run as cell in terminal, and the Launch profiles view from the CLI. The CLI is a
// fake runner; nothing reaches a network or a shell.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import {
  cellLaunchArgs, cellRenameArgs, cellStopArgs, LocalCell, newCellRunArgs, resumeTail, runAsCellArgs,
} from "../../cells";
import {
  CELL_CMD_TEXTS, CellCommandDeps, CONSENT_KEY, copyCellLaunch, ensureCli, machineKey, renameCell, stopCell, typedCommand, validateNewCellName,
} from "../../cellCommands";
import {
  CELL_TEXTS, CellsProvider, CliOutput, CliResolution, LocalCellItem, MeshGroupItem, RemoteCellItem,
} from "../../cellsView";
import {
  cliGate, configAutoAllow, IN_SESSION_MESSAGE, insideMeshSession, MIN_JSON_CLI, parseCellsAnswer, parseCliError, parseCliVersion, parsePeersAnswer, parseProfilesAnswer,
  profileCopyArgs, profileDeleteArgs, profileSetDefaultArgs, versionAtLeast,
} from "../../cliJson";
import { findLocalSession, librarySlug, slugMatches, transcriptCwd } from "../../localSession";
import { projectDirName } from "../../nativeSeed";
import {
  CLI_PROFILE_CMD_TEXTS, deleteCliProfile, duplicateProfile, setDefaultProfile, validateOperator,
} from "../../profileCommands";
import { CLI_PROFILE_TEXTS, CliProfileItem, CliProfilesLoad, loadCliProfiles, ProfileDetailItem, profileDetails, ProfilesProvider } from "../../profilesView";

const profileDetailsFlags = (p: Parameters<typeof profileDetails>[0]) => profileDetails(p).find(([k]) => k === "Flags")![1];
import { cellChoices, runAsCell, RUN_AS_CELL_TEXTS, RunAsCellSession } from "../../runAsCell";
import { shownFlags } from "../../profilesView";
import { SessionItem } from "../../sessionsView";
import { commandLine } from "../../terminalCommand";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../../package.json");

const MESH = "msh_0123456789abcdef0123456789abcdef";
const MESH2 = "msh_fedcba9876543210fedcba9876543210";
const BASE = "https://session-exchange.com";
const CLI = "/opt/a4sx bin/a4sx";
const SID = "0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b";
const LIB_ID = "col-lib-0f1e2d3c4b5a";

const row = (o: Record<string, unknown>) => ({
  mesh_id: MESH, mesh_name: "Team mesh", instance_id: "ins_A1", profile: null, local: { state: "stored", pid: null }, registry: { state: "active" }, path: null,
  mesh_policy: "open", tags: [], ...o,
});

/** `a4sx mesh cells --json` as CLI 0.25.0 prints it. */
const V1_CELLS = {
  v: 1, default: "build",
  cells: [
    row({ name: "build", instance_id: "ins_A1", profile: "work", local: { state: "running", pid: 4242 }, path: "lan" }),
    row({ name: "docs", instance_id: "ins_D4", registry: { state: "reserved" } }),
    row({ name: "lab", mesh_id: MESH2, mesh_name: "Lab", instance_id: "ins_B2", mesh_policy: null, tags: ["x", 7] }),
    row({ name: "spare", mesh_id: null, mesh_name: null, instance_id: "ins_C3", mesh_policy: null, registry: { state: "unknown" } }),
  ],
};

/** `a4sx mesh peers <mesh> --json`. */
const V1_PEERS = {
  v: 1, mesh_id: MESH,
  peers: [
    { instance_id: "ins_A1", name: "build", aid: "build@team", tier: "sandbox", state: "online", own: true, tags: [] },
    { instance_id: "ins_Z9", name: "laptop-agent", aid: "laptop-agent@team", tier: "uid", state: "online", own: false },
    { instance_id: "ins_Y8", name: "desk-agent", aid: "desk-agent@team", tier: "sandbox", state: "offline", own: true },
    { instance_id: "ins_bad id", name: "x", own: false },
  ],
};

/** `a4sx profiles --json`. */
const V1_PROFILES = {
  v: 1, default: "work",
  profiles: [
    {
      id: "work", harness: "claude-code", model: "opus", base_url: "https://router.example.com/v1?k=1", operator: "team-a",
      header_names: ["X-Fleet-Operator", "Authorization"], flags: ["--verbose", "--api-key=sk-live-123"], env_keys: ["API_TIMEOUT_MS"], used_by_cells: 2,
    },
    { id: "lab", harness: null, model: null, base_url: null, operator: "bad op$", header_names: [], flags: [], env_keys: [], used_by_cells: 0 },
    { id: "BAD ID" },
  ],
};

const out = (stdout: unknown, code = 0, stderr = ""): CliOutput => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr });

interface Harness {
  deps: CellCommandDeps;
  runs: string[];
  provider: CellsProvider;
}

function harness(answers: Record<string, CliOutput> = {}, resolve: CliResolution = { kind: "found", path: CLI }, state = fakeMemento({ [CONSENT_KEY]: [machineKey()] })): Harness {
  const runs: string[] = [];
  const run = async (_cli: string, args: readonly string[]): Promise<CliOutput> => {
    const key = args.join(" ");
    runs.push(key);
    return answers[key] ?? (key === "--version" ? out("a4sx 0.25.0  (server 0.718.0)") : key === "mesh cells --json" ? out(V1_CELLS)
      : key === `mesh peers ${MESH} --json` ? out(V1_PEERS) : out(""));
  };
  const provider = new CellsProvider({ resolve: () => resolve, run, server: () => BASE, onState: () => undefined });
  const deps: CellCommandDeps = {
    state: state as any, cliDir: undefined, provider, resolve: () => resolve, run, server: () => BASE, defaultServer: BASE,
    folder: async () => "/w/proj", fetch: async () => { throw new Error("no network"); }, python: async () => ({ code: 1, stdout: "" }), terminals: new Set(),
  };
  return { deps, runs, provider };
}

async function localItems(h: Harness): Promise<LocalCellItem[]> {
  const all: LocalCellItem[] = [];
  for (const g of await h.provider.getChildren()) {
    if (g instanceof MeshGroupItem) {
      all.push(...((await h.provider.getChildren(g)).filter((i) => i instanceof LocalCellItem) as LocalCellItem[]));
    }
  }
  return all;
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  };
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.finally(restore) as unknown as T;
    }
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

describe("CLI JSON: `mesh cells --json` v1", () => {
  it("reads name, mesh, profile, local state and pid, registry, path, mesh policy; the answer's default marks its cell", () => {
    const a = parseCellsAnswer(JSON.stringify(V1_CELLS))!;
    assert.strictEqual(a.legacy, false);
    assert.deepStrictEqual(a.cells.map((c) => [c.name, c.meshId ?? null, c.launchProfile ?? null, c.localState, c.pid ?? null, c.registryState, c.path ?? null, c.meshPolicy, c.isDefault]), [
      ["build", MESH, "work", "running", 4242, "active", "lan", "open", true],
      ["docs", MESH, null, "stored", null, "reserved", null, "open", false],
      ["lab", MESH2, null, "stored", null, "active", null, null, false],
      ["spare", null, null, "stored", null, "unknown", null, null, false],
    ]);
  });

  it("the old row fields are read in v1 too: default, needs_approval, duplicate, created, base", () => {
    const a = parseCellsAnswer(JSON.stringify({ v: 1, default: null, cells: [
      row({ name: "a", default: true, needs_approval: true, duplicate: true, created: "2026-11-04T09:00:00Z", base: "staging.example.com" }),
      row({ name: "b", instance_id: "ins_B9" }),
    ] }))!;
    assert.deepStrictEqual([a.cells[0].isDefault, a.cells[0].needsApproval, a.cells[0].duplicate, a.cells[0].created, a.cells[0].server], [true, true, true, "2026-11-04", "https://staging.example.com"]);
    assert.deepStrictEqual([a.cells[1].isDefault, a.cells[1].needsApproval, a.cells[1].duplicate, a.cells[1].created, a.cells[1].server], [false, false, false, undefined, undefined]);
    const item = new LocalCellItem(a.cells[0], a.cells, BASE);
    assert.strictEqual(item.description, "default · staging.example.com · stored · registry active · waits for an admin · stored twice");
  });

  it("tags are read tolerantly (missing, empty, or with junk) and never break a row", () => {
    const a = parseCellsAnswer(JSON.stringify({ v: 1, default: null, cells: [row({ name: "a" }), row({ name: "b", tags: undefined }), row({ name: "c", tags: "x" }), row({ name: "d", tags: ["ok", 1, null, "\u202e"] })] }))!;
    assert.deepStrictEqual(a.cells.map((c) => c.tags), [[], [], [], ["ok"]]);
  });

  it("unknown words fall back safely; a row whose name or ids aren't the CLI's form is dropped", () => {
    const a = parseCellsAnswer(JSON.stringify({ v: 1, default: "x'; rm", cells: [
      row({ name: "ok", local: { state: "exploded", pid: "1" }, registry: { state: "weird" }, path: "carrier-pigeon", mesh_policy: "maybe" }),
      row({ name: "x'; rm -rf ~" }), row({ name: "y", mesh_id: "msh_$(id)" }), row({ name: "z", instance_id: "ins_a b" }), "row", null,
    ] }))!;
    assert.deepStrictEqual(a.cells.map((c) => [c.name, c.localState, c.pid ?? null, c.registryState, c.path ?? null, c.meshPolicy, c.isDefault]), [["ok", "stored", null, "unknown", null, null, false]]);
  });

  it("an older CLI's bare list is legacy; anything else (or an error object) is no answer", () => {
    assert.deepStrictEqual(parseCellsAnswer("[]"), { cells: [], legacy: true });
    for (const s of ["", "not json", "{}", "{\"v\":2,\"cells\":[]}", "{\"v\":1,\"error\":{\"code\":\"x\",\"message\":\"m\"}}"]) {
      assert.strictEqual(parseCellsAnswer(s), undefined, s);
    }
  });

  it("errors: `{v:1, error:{code, message}}`, the message on one line", () => {
    assert.deepStrictEqual(parseCliError(JSON.stringify({ v: 1, error: { code: "not_signed_in", message: "sign in first:\n run a4sx login" } })), { code: "not_signed_in", message: "sign in first: run a4sx login" });
    assert.strictEqual(parseCliError("{\"v\":1}"), undefined);
    assert.strictEqual(parseCliError("[]"), undefined);
  });
});

describe("CLI JSON: `mesh peers --json` and `profiles --json`", () => {
  it("peers: every cell with a valid id, `own` = the caller's account (not this computer); another mesh's answer is no answer", () => {
    assert.deepStrictEqual(parsePeersAnswer(JSON.stringify(V1_PEERS), MESH), [
      { instanceId: "ins_A1", name: "build", own: true, aid: "build@team", tier: "sandbox", state: "online", tags: [] },
      { instanceId: "ins_Z9", name: "laptop-agent", own: false, aid: "laptop-agent@team", tier: "uid", state: "online", tags: [] },
      { instanceId: "ins_Y8", name: "desk-agent", own: true, aid: "desk-agent@team", tier: "sandbox", state: "offline", tags: [] },
    ]);
    assert.strictEqual(parsePeersAnswer(JSON.stringify({ v: 1, mesh_id: MESH, peers: [{ instance_id: "ins_Q1", name: "q" }] }), MESH)![0].own, false, "no `own`: not yours");
    assert.strictEqual(parsePeersAnswer(JSON.stringify(V1_PEERS), MESH2), undefined);
    assert.strictEqual(parsePeersAnswer("[]", MESH), undefined);
  });

  it("profiles: header NAMES and env KEYS only; a bad operator or id is dropped; the default must be listed", () => {
    const a = parseProfilesAnswer(JSON.stringify(V1_PROFILES))!;
    assert.strictEqual(a.default, "work");
    assert.deepStrictEqual(a.profiles.map((p) => p.id), ["work", "lab"]);
    assert.deepStrictEqual(a.profiles[0].headerNames, ["X-Fleet-Operator", "Authorization"]);
    assert.strictEqual(a.profiles[0].operator, "team-a");
    assert.strictEqual(a.profiles[1].operator, undefined);
    assert.deepStrictEqual(a.profiles[0].envKeys, ["API_TIMEOUT_MS"]);
    assert.strictEqual(a.profiles[0].usedByCells, 2);
    assert.strictEqual(parseProfilesAnswer(JSON.stringify({ ...V1_PROFILES, default: "gone" }))!.default, undefined);
    assert.strictEqual(parseProfilesAnswer("{\"profiles\":[]}"), undefined);
  });
});

describe("version gate", () => {
  it("reads `a4sx --version`; 0.25.0 and newer pass, older is too old, no line is unknown", () => {
    assert.strictEqual(MIN_JSON_CLI, "0.25.0");
    assert.strictEqual(parseCliVersion("a4sx 0.24.2  (server 0.717.3)\n"), "0.24.2");
    assert.strictEqual(parseCliVersion("a4sx 0.25.10"), "0.25.10");
    assert.strictEqual(parseCliVersion("python: can't open file"), undefined);
    assert.strictEqual(parseCliVersion("a4sx 0.25.0.1"), undefined);
    assert.ok(versionAtLeast("0.25.0", "0.25.0") && versionAtLeast("0.25.1", "0.25.0") && versionAtLeast("1.0.0", "0.25.0"));
    assert.ok(!versionAtLeast("0.24.9", "0.25.0") && !versionAtLeast("0.3.0", "0.25.0"));
    assert.deepStrictEqual([cliGate("0.25.0"), cliGate("0.24.2"), cliGate(undefined)], ["ok", "too-old", "unknown"]);
  });

  it("Cells view: an older CLI is legacy even if its list parses (no peers, no Stop or Rename); --version is asked once", async () => {
    const h = harness({ "--version": out("a4sx 0.24.2  (server 0.717.3)") });
    const top = await h.provider.getChildren();
    assert.strictEqual(top[0].label, CELL_TEXTS.olderCli);
    assert.strictEqual(top[0].command?.command, "a4sx.updateCli");
    const cells = await localItems(h);
    assert.ok(cells.every((c) => c.contextValue!.endsWith(".legacy")));
    assert.ok(!h.runs.some((r) => r.startsWith("mesh peers")));
    await h.provider.refresh();
    assert.strictEqual(h.runs.filter((r) => r === "--version").length, 1, "cached until cleared");
    h.provider.versions.clear();
    await h.provider.refresh();
    assert.strictEqual(h.runs.filter((r) => r === "--version").length, 2);
  });

  it("Launch profiles: an older CLI isn't asked for `profiles --json`; an argparse refusal is too old; a JSON error is shown", async () => {
    const found = (): CliResolution => ({ kind: "found", path: CLI });
    const runs: string[] = [];
    const runner = (answers: Record<string, CliOutput>) => async (_c: string, args: readonly string[]) => {
      runs.push(args.join(" "));
      return answers[args.join(" ")] ?? out("");
    };
    assert.deepStrictEqual(await loadCliProfiles(found, runner({ "--version": out("a4sx 0.24.2") })), { kind: "too-old" });
    assert.deepStrictEqual(runs, ["--version"]);
    assert.deepStrictEqual(await loadCliProfiles(found, runner({ "profiles --json": out("", 2, "a4sx: error: unrecognized arguments: --json") })), { kind: "too-old" });
    assert.deepStrictEqual(await loadCliProfiles(found, runner({ "profiles --json": out({ v: 1, error: { code: "not_signed_in", message: "Run a4sx login first." } }, 1) })),
      { kind: "error", message: "Run a4sx login first." });
    assert.deepStrictEqual(await loadCliProfiles(found, runner({ "profiles --json": out("garbage") })), { kind: "error", message: CLI_PROFILE_TEXTS.cliFailed });
    const ok = await loadCliProfiles(found, runner({ "--version": out("a4sx 0.25.0"), "profiles --json": out(V1_PROFILES) }));
    assert.strictEqual(ok.kind, "ok");
    assert.deepStrictEqual(await loadCliProfiles(() => ({ kind: "in-session" }), runner({})), { kind: "unavailable" });
  });
});

describe("in-session refusal (A4SX_HARNESS=1 or A4SX_MESH_SESSION=1)", () => {
  beforeEach(resetCalls);

  it("detects either variable set to 1, nothing else", () => {
    assert.ok(insideMeshSession({ A4SX_HARNESS: "1" }));
    assert.ok(insideMeshSession({ A4SX_MESH_SESSION: "1" }));
    assert.ok(!insideMeshSession({}));
    assert.ok(!insideMeshSession({ A4SX_HARNESS: "0", A4SX_MESH_SESSION: "" }));
  });

  it("the CLI resolution says in-session first; the Cells view shows the message; a command shows it and runs nothing", async () => {
    assert.deepStrictEqual(ext.resolveCellsCli(() => ({ found: true, path: CLI }), { A4SX_MESH_SESSION: "1" }), { kind: "in-session" });
    assert.deepStrictEqual(ext.resolveCellsCli(() => ({ found: true, path: CLI }), {}), { kind: "found", path: CLI });
    const h = harness({}, { kind: "in-session" });
    const [m] = await h.provider.getChildren();
    assert.strictEqual(m.label, IN_SESSION_MESSAGE);
    assert.strictEqual(await ensureCli(h.deps), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [IN_SESSION_MESSAGE]);
    assert.strictEqual(await runAsCell(h.deps, { id: LIB_ID, findLocal: async () => undefined }), undefined);
    assert.deepStrictEqual(h.runs, []);
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("runCli refuses without starting anything; save, resume and profile terminals refuse with the message", async () => {
    await withEnv({ A4SX_HARNESS: "1" }, async () => {
      const r = await ext.runCli(process.execPath, ["-e", "process.stdout.write('ran')"]);
      assert.deepStrictEqual(r, { code: null, stdout: "", stderr: IN_SESSION_MESSAGE });
      assert.strictEqual(await ext.saveSession(() => ({ found: true, path: CLI })), undefined);
      assert.strictEqual(await ext.runProfileCli("work", () => ({ found: true, path: CLI })), undefined);
      assert.strictEqual(await ext.runSetDefaultCli("work", () => ({ found: true, path: CLI })), undefined);
      const item = new SessionItem({ id: LIB_ID });
      assert.strictEqual(await ext.resumeSession(item, () => ({ found: true, path: CLI }), async () => ({})), undefined);
    });
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), Array(4).fill(IN_SESSION_MESSAGE));
    // Outside a session the runner runs.
    assert.strictEqual((await ext.runCli(process.execPath, ["-e", "process.stdout.write('ran')"])).stdout, "ran");
  });
});

describe("command builders", () => {
  const cells = parseCellsAnswer(JSON.stringify(V1_CELLS))!.cells;
  const [build, docs, , spare] = cells;
  const shared: LocalCell[] = [...cells, { ...docs, meshId: MESH2, instanceId: "ins_E5" }];

  it("run as cell: --cell, the toggles, then `-- --resume ID` (local) or `--a4sx-session=ID` (library); --mesh only for a shared name", () => {
    assert.deepStrictEqual(runAsCellArgs(build, cells, { reduced: true, autoAllow: false }, { kind: "local", sessionId: SID }),
      ["launch", "--cell", "build", "--mesh-reduced-isolation", "--", "--resume", SID]);
    assert.deepStrictEqual(runAsCellArgs(build, cells, { reduced: false, autoAllow: true }, { kind: "library", id: LIB_ID }),
      ["launch", "--cell", "build", "--auto-allow-ipc-messages", `--a4sx-session=${LIB_ID}`]);
    assert.deepStrictEqual(runAsCellArgs(docs, shared, { reduced: true, autoAllow: true }, { kind: "local", sessionId: SID }),
      ["launch", "--cell", "docs", "--mesh", MESH, "--mesh-reduced-isolation", "--auto-allow-ipc-messages", "--", "--resume", SID]);
    assert.deepStrictEqual(newCellRunArgs({ reduced: true, autoAllow: false }, { kind: "local", sessionId: SID }), ["launch", "--new-cell", "--mesh-reduced-isolation", "--", "--resume", SID]);
    assert.deepStrictEqual(newCellRunArgs({ reduced: false, autoAllow: false }, { kind: "library", id: LIB_ID }), ["launch", "--new-cell", `--a4sx-session=${LIB_ID}`]);
  });

  it("a standalone cell, a bad session id or a hostile library id builds nothing", () => {
    assert.strictEqual(runAsCellArgs(spare, cells, { reduced: true, autoAllow: false }), undefined);
    assert.strictEqual(resumeTail({ kind: "local", sessionId: "../../etc" }), undefined);
    assert.strictEqual(resumeTail({ kind: "library", id: "x; rm -rf ~" }), undefined);
    assert.strictEqual(newCellRunArgs({ reduced: true, autoAllow: false }, { kind: "library", id: "$(id)" }), undefined);
    assert.deepStrictEqual(resumeTail(undefined), []);
  });

  it("rename and stop: `mesh cell rename OLD NEW`, `mesh cell stop NAME` (running here only); --mesh for a shared name", () => {
    assert.deepStrictEqual(cellRenameArgs(docs, cells, "notes"), ["mesh", "cell", "rename", "docs", "notes"]);
    assert.deepStrictEqual(cellRenameArgs(docs, shared, "notes"), ["mesh", "cell", "rename", "docs", "notes", "--mesh", MESH]);
    assert.strictEqual(cellRenameArgs(docs, cells, "Bad Name"), undefined);
    assert.strictEqual(cellRenameArgs(spare, cells, "spare-2"), undefined, "a standalone cell isn't renamed");
    assert.deepStrictEqual(cellStopArgs(build, cells), ["mesh", "cell", "stop", "build"]);
    assert.strictEqual(cellStopArgs(docs, cells), undefined, "not running");
    assert.strictEqual(validateNewCellName("build", docs, cells), CELL_CMD_TEXTS.renameTaken);
    assert.strictEqual(validateNewCellName("lab", docs, cells), undefined, "another mesh's name is fine");
    assert.strictEqual(validateNewCellName("-x", docs, cells), CELL_CMD_TEXTS.renameInvalid);
  });

  it("profiles: --copy SRC --name DST [--header X-Fleet-Operator=OP] [--force], --set-default, --delete; bad ids or operators build nothing", () => {
    assert.deepStrictEqual(profileCopyArgs("work", "work-2"), ["profile", "--copy", "work", "--name", "work-2"]);
    assert.deepStrictEqual(profileCopyArgs("work", "work-2", "team-b", true), ["profile", "--copy", "work", "--name", "work-2", "--header", "X-Fleet-Operator=team-b", "--force"]);
    assert.strictEqual(profileCopyArgs("work", "Work 2"), undefined);
    assert.strictEqual(profileCopyArgs("work", "w2", "a b"), undefined);
    assert.strictEqual(profileCopyArgs("work", "w2", "x=y;z"), undefined);
    assert.deepStrictEqual(profileSetDefaultArgs("lab"), ["profile", "--set-default", "lab"]);
    assert.deepStrictEqual(profileDeleteArgs("lab"), ["profile", "--delete", "lab"]);
    assert.strictEqual(profileDeleteArgs("--all"), undefined);
    assert.strictEqual(validateOperator(""), undefined);
    assert.strictEqual(validateOperator("bad op"), CLI_PROFILE_CMD_TEXTS.operatorInvalid);
  });

  it("quoting: bash and PowerShell type the same argv, `--` included; a Windows path runs with & in PowerShell", () => {
    const args = runAsCellArgs(build, cells, { reduced: true, autoAllow: true }, { kind: "local", sessionId: SID })!;
    assert.strictEqual(commandLine("a4sx", args, "posix"),
      `'a4sx' 'launch' '--cell' 'build' '--mesh-reduced-isolation' '--auto-allow-ipc-messages' '--' '--resume' '${SID}'`);
    assert.strictEqual(commandLine("C:\\Users\\O'Brien\\a4sx.cmd", args, "powershell"),
      `& 'C:\\Users\\O''Brien\\a4sx.cmd' 'launch' '--cell' 'build' '--mesh-reduced-isolation' '--auto-allow-ipc-messages' '--' '--resume' '${SID}'`);
    const lib = runAsCellArgs(build, cells, { reduced: false, autoAllow: false }, { kind: "library", id: LIB_ID })!;
    assert.strictEqual(commandLine("a4sx", lib, "cmd"), `"a4sx" "launch" "--cell" "build" "--a4sx-session=${LIB_ID}"`);
  });

  it("Copy launch command: the bare name when a4sx is on PATH, quoted for the default shell; POSIX when the shell is unknown", () => {
    const args = cellLaunchArgs(build, cells)!;
    assert.strictEqual(typedCommand("/usr/local/bin/a4sx", args, "/bin/zsh", "/usr/bin:/usr/local/bin", "linux"), "'a4sx' 'launch' '--cell' 'build' '--mesh-reduced-isolation'");
    assert.strictEqual(typedCommand("C:\\Tools\\a4sx.cmd", args, "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\Tools", "win32"),
      "& 'a4sx' 'launch' '--cell' 'build' '--mesh-reduced-isolation'");
    assert.strictEqual(typedCommand("/opt/a4sx/a4sx", args, undefined, "/usr/bin", "linux"), "'/opt/a4sx/a4sx' 'launch' '--cell' 'build' '--mesh-reduced-isolation'");
  });
});

describe("Cells view: grouped by mesh, with the other machines' cells", () => {
  beforeEach(resetCalls);

  it("one group per mesh with its policy (unknown when null), standalone last; no update line for a 0.25.0 CLI", async () => {
    const h = harness();
    const top = await h.provider.getChildren();
    assert.deepStrictEqual(top.map((g) => [g.label, g.description, g.contextValue]), [
      ["Lab", "policy: unknown · 1 cell here", "a4sx.cellMesh"],
      ["Team mesh", "policy: open · 2 cells here", "a4sx.cellMesh"],
      [CELL_TEXTS.standaloneGroup, "1 cell here", "a4sx.cellMesh.standalone"],
    ]);
  });

  it("a mesh's cells: profile, local state, registry, path; then the other machines' cells, read-only, read when the group opens", async () => {
    const h = harness();
    const top = await h.provider.getChildren();
    assert.ok(!h.runs.some((r) => r.startsWith("mesh peers")), "not before the group opens");
    const team = await h.provider.getChildren(top[1]);
    assert.deepStrictEqual(team.map((i) => [i.label, i.description, i.contextValue]), [
      ["build", "default · profile work · running · registry active · path lan", "a4sx.localCell.default.running"],
      ["docs", "stored · registry reserved", "a4sx.localCell"],
      ["desk-agent", "yours, on another machine · offline · sandbox", "a4sx.remoteCell"],
      ["laptop-agent", "on another machine · online · uid", "a4sx.remoteCell"],
    ]);
    assert.ok(team[2] instanceof RemoteCellItem && team[3] instanceof RemoteCellItem);
    assert.match(String(team[2].tooltip), /^Cell: desk-agent\nYours, on another machine: read-only here\./);
    assert.match(String(team[3].tooltip), /^Cell: laptop-agent\nOn another machine: read-only here\./);
    assert.ok(!team.some((i) => i instanceof RemoteCellItem && i.peer.instanceId === "ins_A1"), "your cell stored here is listed once, as local");
    assert.match(String(team[0].tooltip), /On this computer: running \(pid 4242\)\nRegistry: active\nPath: lan/);
    assert.match(String(team[1].tooltip), /Path: none/);
    assert.deepStrictEqual(h.runs, ["--version", "mesh cells --json", `mesh peers ${MESH} --json`]);
    await h.provider.getChildren(top[1]);
    assert.strictEqual(h.runs.length, 3, "peers are read once per refresh");
    const lab = await h.provider.getChildren(top[0]);
    assert.deepStrictEqual(lab.map((i) => i.label), ["lab", CELL_TEXTS.peersFailed], "an unreadable peers answer is one line");
  });

  it("the menus: Start on stored mesh cells, Stop only on running ones, Rename and Forget not on running or legacy ones", () => {
    const menu = pkg.contributes.menus["view/item/context"].filter((m: any) => m.when.startsWith("view == a4sx.cells"));
    const re = (cmd: string) => new RegExp(menu.find((m: any) => m.command === cmd && m.when.includes("=~")).when.match(/viewItem =~ \/(.*)\/$/)[1]);
    const ctxs = ["a4sx.localCell", "a4sx.localCell.default.running", "a4sx.localCell.standalone", "a4sx.localCell.legacy", "a4sx.localCell.default"];
    const table = Object.fromEntries(["a4sx.startCell", "a4sx.stopCell", "a4sx.renameCell", "a4sx.forgetCell", "a4sx.setDefaultCell", "a4sx.copyCellLaunch"]
      .map((c) => [c, ctxs.map((x) => re(c).test(x))]));
    assert.deepStrictEqual(table, {
      "a4sx.startCell": [true, false, false, true, true],
      "a4sx.stopCell": [false, true, false, false, false],
      "a4sx.renameCell": [true, false, false, false, true],
      "a4sx.forgetCell": [true, false, true, true, true],
      "a4sx.setDefaultCell": [true, false, true, true, false],
      "a4sx.copyCellLaunch": [true, true, false, true, true],
    });
    assert.ok(menu.some((m: any) => m.command === "a4sx.openCellOnWeb" && m.when === "view == a4sx.cells && viewItem == a4sx.cellMesh"));
    assert.ok(!menu.some((m: any) => m.when.includes("remoteCell")), "the other machines' cells have no actions");
    assert.strictEqual(pkg.contributes.commands.find((c: any) => c.command === "a4sx.openCellOnWeb").title, "Open mesh in browser");
  });

  it("Stop asks first, then `mesh cell stop`; Rename runs `mesh cell rename`; Copy launch command copies the typed line", async () => {
    const h = harness();
    const by = Object.fromEntries((await localItems(h)).map((i) => [i.cell.name, i]));
    const { build, docs } = by;
    assert.ok(!(await stopCell(h.deps, build)), "Cancel");
    calls.modalChoices.push(CELL_CMD_TEXTS.stop);
    assert.ok(await stopCell(h.deps, build));
    assert.deepStrictEqual(calls.modals.map((m) => m.message), [CELL_CMD_TEXTS.stopTitle("build"), CELL_CMD_TEXTS.stopTitle("build")]);
    assert.ok(!(await stopCell(h.deps, docs)), "not running: nothing to stop");
    calls.inputQueue.push("notes");
    assert.ok(await renameCell(h.deps, docs));
    calls.inputQueue.push("docs");
    assert.ok(!(await renameCell(h.deps, docs)), "unchanged");
    assert.deepStrictEqual(h.runs.filter((r) => r.startsWith("mesh cell ")), ["mesh cell stop build", "mesh cell rename docs notes"]);
    assert.deepStrictEqual(calls.infos, [CELL_CMD_TEXTS.stopped("build"), CELL_CMD_TEXTS.renamed("docs", "notes")]);
    calls.shell = "/bin/bash";
    const line = await copyCellLaunch(h.deps, build);
    assert.strictEqual(line, `'${CLI}' 'launch' '--cell' 'build' '--mesh-reduced-isolation'`);
    assert.strictEqual(calls.clipboard, line);
  });

  it("Rename isn't offered for a standalone cell: no box, nothing runs", async () => {
    const h = harness();
    const spare = (await localItems(h)).find((i) => i.cell.name === "spare")!;
    assert.strictEqual(spare.contextValue, "a4sx.localCell.standalone");
    assert.ok(!(await renameCell(h.deps, spare)));
    assert.strictEqual(calls.inputs.length, 0);
    assert.ok(!h.runs.some((r) => r.startsWith("mesh cell rename")));
  });

  it("a refusal shows the CLI's JSON message", async () => {
    const h = harness({ "mesh cell stop build": out({ v: 1, error: { code: "not_running", message: "The cell build isn't running here." } }, 1) });
    const build = (await localItems(h)).find((i) => i.cell.name === "build")!;
    calls.modalChoices.push(CELL_CMD_TEXTS.stop);
    assert.ok(!(await stopCell(h.deps, build)));
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [CELL_CMD_TEXTS.cliFailed("stop the cell", "The cell build isn't running here.")]);
  });
});

describe("Run as cell in terminal", () => {
  beforeEach(resetCalls);
  const local = (cwd = "/home/me/proj"): RunAsCellSession => ({ id: LIB_ID, findLocal: async () => ({ sessionId: SID, cwd }) });
  const library: RunAsCellSession = { id: LIB_ID, findLocal: async () => undefined };

  it("the pick: this computer's cells in a mesh (name · mesh · launch profile), default first, then New cell…", () => {
    const cells = parseCellsAnswer(JSON.stringify(V1_CELLS))!.cells;
    assert.deepStrictEqual(cellChoices(cells).map((c) => [c.label, c.description]), [
      ["$(debug-start) build", "Team mesh · profile work · default · running"],
      ["$(terminal) docs", "Team mesh · no launch profile"],
      ["$(terminal) lab", "Lab · no launch profile"],
      [RUN_AS_CELL_TEXTS.newCell, RUN_AS_CELL_TEXTS.newCellDetail],
    ]);
  });

  it("a local session: the cell, Keep my sign-in on by default, `-- --resume ID` in the session's own folder", async () => {
    const h = harness();
    calls.pickQueue.push(1, [0]);   // docs; the options as offered (Keep my sign-in on)
    const t = await runAsCell(h.deps, local());
    assert.ok(t);
    const opts = calls.quickPicks[1];
    assert.strictEqual(opts.options.canPickMany, true);
    assert.deepStrictEqual(opts.items.map((i: any) => [i.label, i.picked]), [[RUN_AS_CELL_TEXTS.keepSignIn, true], [RUN_AS_CELL_TEXTS.autoAllow, false]]);
    assert.strictEqual(calls.terminals[0].options.name, "a4sx: cell docs");
    assert.strictEqual(calls.terminals[0].options.cwd, "/home/me/proj");
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--cell' 'docs' '--mesh-reduced-isolation' '--' '--resume' '${SID}'\n`]);
    assert.ok(h.deps.terminals.has(t!));
  });

  it("a library-only session: `--a4sx-session=ID` in the workspace folder; New cell… runs --new-cell; PowerShell quoting", async () => {
    const h = harness();
    calls.shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    calls.pickQueue.push(3, [0]);
    await runAsCell(h.deps, library);
    assert.strictEqual(calls.terminals[0].options.name, CELL_CMD_TEXTS.newCellTerminal);
    assert.strictEqual(calls.terminals[0].options.cwd, "/w/proj");
    assert.deepStrictEqual(calls.terminals[0].sent, [`& '${CLI}' 'launch' '--new-cell' '--mesh-reduced-isolation' '--a4sx-session=${LIB_ID}'\n`]);
  });

  it("Deliver messages without asking: a warning first; Cancel starts nothing; accepting adds --auto-allow-ipc-messages", async () => {
    const h = harness();
    calls.pickQueue.push(0, [0, 1]);
    assert.strictEqual(await runAsCell(h.deps, library), undefined);
    assert.deepStrictEqual(calls.modals.map((m) => [m.kind, m.message, m.items]), [["warning", RUN_AS_CELL_TEXTS.autoAllowTitle, [RUN_AS_CELL_TEXTS.autoAllowAccept]]]);
    assert.strictEqual(calls.modals[0].detail, RUN_AS_CELL_TEXTS.autoAllowWarning);
    assert.strictEqual(calls.terminals.length, 0);
    calls.pickQueue.push(0, [1]);
    calls.modalChoices.push(RUN_AS_CELL_TEXTS.autoAllowAccept);
    await runAsCell(h.deps, local());
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--cell' 'build' '--auto-allow-ipc-messages' '--' '--resume' '${SID}'\n`]);
  });

  it("a library-only session with Keep my sign-in off: a warning first (the CLI can't seed without it); Cancel starts nothing", async () => {
    const h = harness();
    calls.pickQueue.push(0, []);
    assert.strictEqual(await runAsCell(h.deps, library), undefined);
    assert.deepStrictEqual(calls.modals.map((m) => [m.kind, m.message, m.items, m.detail]),
      [["warning", RUN_AS_CELL_TEXTS.seedSignInTitle, [RUN_AS_CELL_TEXTS.seedSignInAccept], RUN_AS_CELL_TEXTS.seedSignInDetail]]);
    assert.strictEqual(calls.terminals.length, 0);
    calls.pickQueue.push(3, []);
    calls.modalChoices.push(RUN_AS_CELL_TEXTS.seedSignInAccept);
    await runAsCell(h.deps, library);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${CLI}' 'launch' '--new-cell' '--mesh-reduced-isolation' '--a4sx-session=${LIB_ID}'\n`]);
    // A session on this computer needs no sign-in to resume: no warning.
    calls.pickQueue.push(0, []);
    await runAsCell(h.deps, local());
    assert.strictEqual(calls.modals.length, 2);
    assert.deepStrictEqual(calls.terminals[1].sent, [`'${CLI}' 'launch' '--cell' 'build' '--' '--resume' '${SID}'\n`]);
  });

  it("the CLI's config: `a4sx config show` turns the auto-allow toggle on and says where it comes from; off, the toggle names the config key", async () => {
    assert.strictEqual(configAutoAllow(JSON.stringify({ version: 1, ipc: { auto_allow_messages: true } })), true);
    assert.strictEqual(configAutoAllow(JSON.stringify({ version: 1 })), false);
    assert.strictEqual(configAutoAllow(""), undefined);
    const on = harness({ "config show": out({ version: 1, ipc: { auto_allow_messages: true } }) });
    calls.pickQueue.push(0, undefined);
    await runAsCell(on.deps, local());
    assert.ok(on.runs.includes("config show"));
    assert.deepStrictEqual(calls.quickPicks[1].items.map((i: any) => [i.picked, i.detail]), [
      [true, RUN_AS_CELL_TEXTS.keepSignInDetail], [true, RUN_AS_CELL_TEXTS.autoAllowFromConfig],
    ]);
    const off = harness({ "config show": out("", 1, "a4sx: no config at ~/.config/a4sx/config.json") });
    calls.pickQueue.push(0, undefined);
    await runAsCell(off.deps, local());
    assert.deepStrictEqual(calls.quickPicks[3].items.map((i: any) => [i.picked, i.detail]), [
      [true, RUN_AS_CELL_TEXTS.keepSignInDetail], [false, RUN_AS_CELL_TEXTS.autoAllowDetail],
    ]);
    assert.match(RUN_AS_CELL_TEXTS.autoAllowDetail, /ipc\.auto_allow_messages/);
  });

  it("Keep my sign-in asks the per-computer consent once; Esc in either pick starts nothing", async () => {
    const h = harness({}, { kind: "found", path: CLI }, fakeMemento());
    calls.pickQueue.push(0, [0]);
    await runAsCell(h.deps, local());
    assert.deepStrictEqual(calls.modals.map((m) => m.message), [CELL_CMD_TEXTS.consentTitle]);
    assert.strictEqual(calls.terminals.length, 0, "consent declined");
    calls.pickQueue.push(undefined);
    await runAsCell(h.deps, local());
    calls.pickQueue.push(0, undefined);
    await runAsCell(h.deps, local());
    assert.strictEqual(calls.terminals.length, 0);
  });

  it("an older CLI without `mesh cells` offers the update", async () => {
    const h = harness({ "mesh cells --json": out("", 2, "a4sx mesh: error: argument mesh_cmd: invalid choice: 'cells'") });
    calls.nextErrorChoice = CELL_TEXTS.updateCli;
    assert.strictEqual(await runAsCell(h.deps, library), undefined);
    assert.deepStrictEqual(calls.errors.map((e) => [e.message, e.items]), [[CELL_TEXTS.tooOld, [CELL_TEXTS.updateCli]]]);
    assert.deepStrictEqual(calls.executed.map((e) => e.id), ["a4sx.updateCli"]);
  });

  it("the menu item on My sessions, hidden from the palette", () => {
    const m = pkg.contributes.menus["view/item/context"].find((x: any) => x.command === "a4sx.runAsCell");
    assert.deepStrictEqual([m.when, m.group], ["view == a4sx.sessions && viewItem =~ /^a4sx\\.session(\\.filed)?$/", "1_session@3"]);
    assert.strictEqual(pkg.contributes.commands.find((c: any) => c.command === "a4sx.runAsCell").title, "Run as cell in terminal");
    for (const id of ["a4sx.runAsCell", "a4sx.stopCell", "a4sx.renameCell", "a4sx.copyCellLaunch", "a4sx.duplicateProfile", "a4sx.setDefaultProfile"]) {
      assert.ok(pkg.contributes.menus.commandPalette.some((x: any) => x.command === id && x.when === "false"), id);
    }
  });
});

describe("a saved session on this computer", () => {
  function tmp(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-local-")));
  }

  it("the slug: from sessions[0] (lib-…) or the id (col-lib-…); it matches the session id's first 12 letters and digits", () => {
    assert.strictEqual(librarySlug({ id: "x", sessions: ["lib-0f1e2d3c4b5a"] }), "0f1e2d3c4b5a");
    assert.strictEqual(librarySlug({ id: LIB_ID }), "0f1e2d3c4b5a");
    assert.strictEqual(librarySlug({ id: "col-other" }), undefined);
    assert.ok(slugMatches(SID, "0f1e2d3c4b5a"));
    assert.ok(!slugMatches(SID, "0f1e2d3c4b5b"));
    assert.strictEqual(transcriptCwd("{\"type\":\"summary\"}\n{\"cwd\":\"relative\"}\n{\"cwd\":\"/home/me/p\",\"sessionId\":\"x\"}\n", "linux"), "/home/me/p");
    assert.strictEqual(transcriptCwd("{\"cwd\":\"C:\\\\work\\\\p\"}", "win32"), "C:\\work\\p");
  });

  it("finds the newest transcript whose folder exists and is the one Claude Code files it under", async () => {
    const projects = tmp();
    const cwd = tmp();
    const dir = path.join(projects, projectDirName(cwd));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), `{"type":"summary"}\n{"cwd":${JSON.stringify(cwd)},"sessionId":"${SID}"}\n`);
    assert.deepStrictEqual(await findLocalSession("0f1e2d3c4b5a", projects), { sessionId: SID, cwd });
    assert.strictEqual(await findLocalSession("aaaaaaaaaaaa", projects), undefined);
    // Filed under another folder than its cwd: `--resume` there wouldn't find it.
    const other = path.join(projects, "-somewhere-else");
    fs.mkdirSync(other);
    const sid2 = "0f1e2d3c-4b5a-4000-8000-000000000000";
    fs.writeFileSync(path.join(other, `${sid2}.jsonl`), `{"cwd":${JSON.stringify(cwd)}}\n`);
    fs.utimesSync(path.join(other, `${sid2}.jsonl`), new Date(), new Date(Date.now() + 60_000));
    assert.deepStrictEqual(await findLocalSession("0f1e2d3c4b5a", projects), { sessionId: SID, cwd }, "the mismatched one is skipped");
    assert.strictEqual(await findLocalSession("0f1e2d3c4b5a", path.join(projects, "missing")), undefined);
  });

  it("the My sessions item's adapter finds it in the given projects folder", async () => {
    const projects = tmp();
    const s = ext.runAsCellSession(new SessionItem({ id: LIB_ID, sessions: ["lib-0f1e2d3c4b5a"] }), projects)!;
    assert.strictEqual(s.id, LIB_ID);
    assert.strictEqual(await s.findLocal(), undefined);
    assert.strictEqual(ext.runAsCellSession(undefined), undefined);
  });
});

describe("Launch profiles from the a4sx CLI", () => {
  beforeEach(resetCalls);

  function view(load: CliProfilesLoad): ProfilesProvider {
    return new ProfilesProvider({ token: async () => undefined }, () => { throw new Error("no server"); }, () => undefined, { load: async () => load });
  }

  it("a tree with the default first and marked; details: harness, model, base URL, operator, header NAMES, flags (masked), env KEYS, used by", async () => {
    const data = parseProfilesAnswer(JSON.stringify(V1_PROFILES))!;
    const v = view({ kind: "ok", data });
    const items = (await v.getChildren()) as CliProfileItem[];
    assert.deepStrictEqual(items.map((i) => [i.label, i.description, i.contextValue]), [
      ["work", "default · opus · https://router.example.com · operator team-a", "a4sx.cliProfile.default"],
      ["lab", "", "a4sx.cliProfile"],
    ]);
    const details = (await v.getChildren(items[0])) as ProfileDetailItem[];
    assert.deepStrictEqual(details.map((d) => [d.label, d.description]), [
      ["Harness", "claude-code"], ["Model", "opus"], ["Base URL", "https://router.example.com"], ["Router operator", "team-a"],
      ["Header names", "X-Fleet-Operator, Authorization"], ["Flags", "--verbose --api-key=••••"], ["Env keys", "API_TIMEOUT_MS"], ["Used by", "2 cells"],
    ]);
    const shown = JSON.stringify([items.map((i) => [i.description, i.tooltip]), details.map((d) => [d.description, d.tooltip])]);
    assert.ok(!shown.includes("sk-live-123") && !shown.includes("k=1"), "no credential, no query string");
    assert.deepStrictEqual((await v.getChildren(items[1])).map((d) => d.description), ["not set", "not set", "not set", "not set", "none", "none", "none", "no cells"]);
    assert.strictEqual(v.cliData, data);
  });

  it("an older CLI: the server's list (signed out: empty, so the welcome shows); the menus fit the CLI items", async () => {
    const v = view({ kind: "too-old" });
    assert.deepStrictEqual(await v.getChildren(), []);
    assert.strictEqual(v.cliData, undefined);
    const menu = pkg.contributes.menus["view/item/context"].filter((m: any) => m.when.startsWith("view == a4sx.profiles"));
    const has = (cmd: string, ctx: string) => menu.some((m: any) => m.command === cmd && (m.when.endsWith(`== ${ctx}`) || (m.when.includes("=~") && new RegExp(m.when.match(/viewItem =~ \/(.*)\/$/)[1]).test(ctx))));
    assert.deepStrictEqual(["a4sx.editProfile", "a4sx.duplicateProfile", "a4sx.setDefaultProfile", "a4sx.deleteProfile", "a4sx.changeDefaultElsewhere"].map((c) => [has(c, "a4sx.cliProfile"), has(c, "a4sx.cliProfile.default")]),
      [[true, true], [true, true], [true, false], [true, false], [false, false]]);
  });

  it("Duplicate: the copy's id and an optional operator, then `profile --copy`; an existing id asks before --force", async () => {
    const h = harness();
    const data = parseProfilesAnswer(JSON.stringify(V1_PROFILES))!;
    const v = view({ kind: "ok", data });
    const [work, lab] = (await v.getChildren()) as CliProfileItem[];
    const deps = { cells: h.deps, view: v };
    calls.inputQueue.push("work-eu", "team-eu");
    assert.ok(await duplicateProfile(deps, work));
    assert.match(calls.inputs[1].prompt, /Leave empty to keep "team-a"/);
    calls.inputQueue.push("work", "");
    calls.modalChoices.push(CLI_PROFILE_CMD_TEXTS.replace);
    assert.ok(await duplicateProfile(deps, lab));
    calls.inputQueue.push("x", "bad op");
    assert.ok(!(await duplicateProfile(deps, lab)), "a bad operator stops");
    assert.deepStrictEqual(h.runs.filter((r) => r.startsWith("profile")), [
      "profile --copy work --name work-eu --header X-Fleet-Operator=team-eu",
      "profile --copy lab --name work --force",
    ]);
    assert.deepStrictEqual(calls.modals.map((m) => m.message), [CLI_PROFILE_CMD_TEXTS.confirmReplace("work", "lab")]);
  });

  it("Set default and Delete run the CLI; Delete asks first and says how many cells use it; a refusal shows the CLI's message", async () => {
    const h = harness({ "profile --delete work": out({ v: 1, error: { code: "in_use", message: "2 cells use this profile." } }, 1) });
    const data = parseProfilesAnswer(JSON.stringify(V1_PROFILES))!;
    const v = view({ kind: "ok", data });
    const [work, lab] = (await v.getChildren()) as CliProfileItem[];
    const deps = { cells: h.deps, view: v };
    assert.ok(await setDefaultProfile(deps, lab));
    assert.ok(!(await deleteCliProfile(deps, lab)), "Cancel");
    calls.modalChoices.push("Delete");
    assert.ok(await deleteCliProfile(deps, lab));
    calls.modalChoices.push("Delete");
    assert.ok(!(await deleteCliProfile(deps, work)));
    assert.deepStrictEqual(calls.modals.map((m) => [m.message, m.detail]), [
      [CLI_PROFILE_CMD_TEXTS.confirmDelete("lab"), "Cells using it: 0"], [CLI_PROFILE_CMD_TEXTS.confirmDelete("lab"), "Cells using it: 0"],
      [CLI_PROFILE_CMD_TEXTS.confirmDelete("work"), "Cells using it: 2"],
    ]);
    assert.deepStrictEqual(h.runs.filter((r) => r.startsWith("profile")), ["profile --set-default lab", "profile --delete lab", "profile --delete work"]);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [CLI_PROFILE_CMD_TEXTS.failed("delete the launch profile", "2 cells use this profile.")]);
  });

  it("an unknown used_by_cells (null) is never 0: details say \"unknown\", Delete says \"Cells using it: unknown\"", async () => {
    const data = parseProfilesAnswer(JSON.stringify({ v: 1, default: null, profiles: [{ id: "solo", used_by_cells: null, header_names: [], flags: [], env_keys: [] }, { id: "zero", used_by_cells: 0 }] }))!;
    assert.deepStrictEqual(data.profiles.map((p) => p.usedByCells), [undefined, 0]);
    const v = view({ kind: "ok", data });
    const [solo] = (await v.getChildren()) as CliProfileItem[];
    assert.strictEqual((await v.getChildren(solo)).find((d) => d.label === "Used by")!.description, "unknown");
    const h = harness();
    await deleteCliProfile({ cells: h.deps, view: v }, solo);
    assert.deepStrictEqual(calls.modals.map((m) => m.detail), ["Cells using it: unknown"]);
    assert.strictEqual(h.runs.length, 0, "cancelled");
  });

  it("flags are masked by name too (--api-key, --token, *secret*, *password*, *auth* …), whatever the value looks like", () => {
    assert.deepStrictEqual(shownFlags([
      "--token", "abc", "--client-secret-file=/x/y", "--db-password", "hunter2", "--auth-header=X", "--no-auth", "--verbose",
      "--api-key=plain", "--model=opus", "--session-cookie", "c1", "<redacted>", "--temperature=0.2",
    ]), [
      "--token", "••••", "--client-secret-file=••••", "--db-password", "••••", "--auth-header=••••", "--no-auth", "--verbose",
      "--api-key=••••", "--model=opus", "--session-cookie", "••••", "<redacted>", "--temperature=0.2",
    ]);
    const p = parseProfilesAnswer(JSON.stringify({ v: 1, profiles: [{ id: "x", flags: ["--github-token=ghx_short", "--debug"] }] }))!.profiles[0];
    assert.strictEqual(profileDetailsFlags(p), "--github-token=•••• --debug");
  });
});
