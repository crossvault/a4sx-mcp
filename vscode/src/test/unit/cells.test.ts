// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// 0.4.0: the "Cells" view (the cells the a4sx CLI stored on this machine), its actions, and installing
// the CLI into the extension's storage. The CLI is a fake runner here; nothing reaches a network or a shell
// except the one test that runs the real launcher with the real sh and python3.
import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { calls, fakeMemento, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import {
  cellDefaultArgs, cellForgetArgs, cellLaunchArgs, cellPageUrl, cellsListDir, CELLS_LIST_ARGS, LocalCell, localCellDescription, NEW_CELL_ARGS, parseCellsJson,
  serverOrigin, showText,
} from "../../cells";
import {
  CELL_CMD_TEXTS, CellCommandDeps, cliDetail, CONSENT_KEY, consentReducedIsolation, dailyUpdate, forgetCell, installCli, LAST_UPDATE_KEY, newCell, openCellOnWeb,
  setDefaultCell, startCell,
} from "../../cellCommands";
import { CELL_TEXTS, CellsLoad, CellsProvider, CliOutput, CliResolution, LocalCellItem, looksTooOld } from "../../cellsView";
import {
  bundledClaude, CLI_FILES, downloadCli, execSpec, Fetch, findPython, hashMatches, installedLauncher, launcherName, launcherText, ProvisionError, pythonCandidates,
  sha256Hex, updateArgs, updateDue, UPDATE_EVERY_MS, writeLauncher,
} from "../../provision";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../../package.json");

const MESH = "msh_0123456789abcdef0123456789abcdef";
const MESH2 = "msh_fedcba9876543210fedcba9876543210";
const BASE = "https://session-exchange.com";

/** `a4sx mesh cells --json` as CLI 0.21.1 prints it (cmd_mesh_cells). */
const CLI_ANSWER = [
  { mesh_id: MESH, mesh_name: "Team mesh", name: "build", instance_id: "ins_A1", created: "2026-11-01T10:00:00Z", standalone: false, default: true, needs_approval: false, duplicate: false },
  { mesh_id: MESH2, mesh_name: "Lab", name: "build", instance_id: "ins_B2", created: "2026-11-02T08:00:00Z", standalone: false, default: false, needs_approval: true, duplicate: false },
  { mesh_id: null, mesh_name: null, name: "spare", instance_id: "ins_C3", created: null, standalone: true, default: false, needs_approval: false, duplicate: false },
  { mesh_id: MESH, mesh_name: "Team mesh", name: "docs", instance_id: "ins_D4", created: "2026-11-02T09:00:00Z", standalone: false, default: false, needs_approval: false, duplicate: false },
];

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a4sx-cells-test-"));
}

describe("cells: reading `a4sx mesh cells --json`", () => {
  it("parses the CLI's answer: name, mesh, default, approval; a standalone cell has no mesh", () => {
    const cells = parseCellsJson(JSON.stringify(CLI_ANSWER))!;
    assert.strictEqual(cells.length, 4);
    assert.deepStrictEqual(cells[0], { name: "build", instanceId: "ins_A1", meshId: MESH, meshName: "Team mesh", isDefault: true, needsApproval: false, duplicate: false, created: "2026-11-01" });
    assert.strictEqual(cells[1].needsApproval, true);
    assert.deepStrictEqual(cells[2], { name: "spare", instanceId: "ins_C3", isDefault: false, needsApproval: false, duplicate: false });
  });

  it("a row whose name, mesh id or instance id isn't the CLI's own form is dropped; other rows stay", () => {
    const bad = [
      { ...CLI_ANSWER[0], name: "x'; rm -rf ~" }, { ...CLI_ANSWER[0], name: "-lead" }, { ...CLI_ANSWER[0], name: "UPPER" },
      { ...CLI_ANSWER[0], mesh_id: "msh_$(id)" }, { ...CLI_ANSWER[0], mesh_id: 7 }, { ...CLI_ANSWER[0], instance_id: "ins_a b" },
      { ...CLI_ANSWER[0], instance_id: undefined }, "row", null, [1],
    ];
    const cells = parseCellsJson(JSON.stringify([...bad, CLI_ANSWER[3]]))!;
    assert.deepStrictEqual(cells.map((c) => c.name), ["docs"]);
  });

  it("anything that isn't the JSON list is no answer (an older CLI's text, a broken line)", () => {
    for (const out of ["", "  (no cells are stored on this host; …)", "{\"cells\": []}", "[", "null"]) {
      assert.strictEqual(parseCellsJson(out), undefined, out);
    }
    assert.deepStrictEqual(parseCellsJson("[]\n"), []);
  });

  it("mesh names are shown on one line without hidden characters, and cut", () => {
    assert.strictEqual(showText("a\u202eb\nc\u200bd"), "a b c d");
    assert.strictEqual(showText("x".repeat(80))!.length, 64);
    assert.strictEqual(showText("  "), undefined);
  });

  it("a newer CLI's `base` and launch profile are read (the status word `server` of --refresh is not a server)", () => {
    const [c] = parseCellsJson(JSON.stringify([{ ...CLI_ANSWER[0], base: "staging.example.com", launch_profile: "work", server: "ok" }]))!;
    assert.strictEqual(c.server, "https://staging.example.com");
    assert.strictEqual(c.launchProfile, "work");
    assert.strictEqual(serverOrigin("https://a.example.com:8443/"), "https://a.example.com:8443");
    for (const bad of ["http://a.example.com", "a.example.com/x", "a.example.com;id", "", 3]) {
      assert.strictEqual(serverOrigin(bad), undefined, String(bad));
    }
    const [d] = parseCellsJson(JSON.stringify([{ ...CLI_ANSWER[0], base: "evil.example.com/x", launch_profile: "Bad Profile" }]))!;
    assert.strictEqual(d.server, undefined);
    assert.strictEqual(d.launchProfile, undefined);
  });

  it("description: default, mesh name (or standalone), another server, profile, approval", () => {
    const cells = parseCellsJson(JSON.stringify([...CLI_ANSWER, { ...CLI_ANSWER[3], name: "far", instance_id: "ins_E5", base: "other.example.com", launch_profile: "p1" }]))!;
    assert.strictEqual(localCellDescription(cells[0], BASE), "default · Team mesh");
    assert.strictEqual(localCellDescription(cells[1], BASE), "Lab · waits for an admin");
    assert.strictEqual(localCellDescription(cells[2], BASE), "standalone");
    assert.strictEqual(localCellDescription(cells[4], BASE), "Team mesh · other.example.com · profile p1");
  });

  it("the cell list's folder: XDG_STATE_HOME, else ~/.local/state; on Windows XDG_STATE_HOME, else %LOCALAPPDATA%", () => {
    assert.strictEqual(cellsListDir({}, "linux", "/home/u"), "/home/u/.local/state/a4sx");
    assert.strictEqual(cellsListDir({ XDG_STATE_HOME: "/s" }, "linux", "/home/u"), "/s/a4sx");
    assert.strictEqual(cellsListDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32", "C:\\Users\\me"), "C:\\Users\\me\\AppData\\Local\\a4sx");
    assert.strictEqual(cellsListDir({}, "win32", "C:\\Users\\me"), undefined);
  });
});

describe("cells: the CLI commands", () => {
  const cells = parseCellsJson(JSON.stringify(CLI_ANSWER))!;

  it("start: `launch --cell NAME --mesh-reduced-isolation`; --mesh only when another cell shares the name", () => {
    assert.deepStrictEqual(cellLaunchArgs(cells[3], cells), ["launch", "--cell", "docs", "--mesh-reduced-isolation"]);
    assert.deepStrictEqual(cellLaunchArgs(cells[0], cells), ["launch", "--cell", "build", "--mesh", MESH, "--mesh-reduced-isolation"]);
    assert.deepStrictEqual(cellLaunchArgs(cells[1], cells), ["launch", "--cell", "build", "--mesh", MESH2, "--mesh-reduced-isolation"]);
  });

  it("a standalone cell isn't started (it must be added to a mesh first)", () => {
    assert.strictEqual(cellLaunchArgs(cells[2], cells), undefined);
  });

  it("new cell, list, default and forget", () => {
    assert.deepStrictEqual(NEW_CELL_ARGS, ["launch", "--new-cell", "--mesh-reduced-isolation"]);
    assert.deepStrictEqual(CELLS_LIST_ARGS, ["mesh", "cells", "--json"]);
    assert.deepStrictEqual(cellDefaultArgs(cells[3], cells), ["mesh", "cell", "default", "docs"]);
    assert.deepStrictEqual(cellDefaultArgs(cells[1], cells), ["mesh", "cell", "default", "build", "--mesh", MESH2]);
    assert.deepStrictEqual(cellForgetArgs(cells[2], cells), ["mesh", "cell", "forget", "spare"]);
    const twins: LocalCell[] = [cells[2], { ...cells[2], instanceId: "ins_Z9", meshId: MESH }];
    assert.deepStrictEqual(cellForgetArgs(twins[0], twins), ["mesh", "cell", "forget", "spare", "--mesh", "standalone"]);
  });

  it("a cell that was changed after parsing to something invalid builds no command", () => {
    const evil = { ...cells[3], name: "a b" };
    assert.strictEqual(cellLaunchArgs(evil, [evil]), undefined);
    assert.strictEqual(cellForgetArgs(evil, [evil]), undefined);
    assert.strictEqual(cellDefaultArgs({ ...cells[3], meshId: "msh_;id" }, cells), undefined);
  });

  it("the page: the mesh's page, or the meshes page for a standalone cell; the cell's own server wins", () => {
    assert.strictEqual(cellPageUrl(`${BASE}/`, cells[0]), `${BASE}/meshes/m/${MESH}`);
    assert.strictEqual(cellPageUrl(BASE, cells[2]), `${BASE}/meshes`);
    assert.strictEqual(cellPageUrl(BASE, { ...cells[0], server: "https://other.example.com" }), `https://other.example.com/meshes/m/${MESH}`);
  });

  it("the CLI's error line is shown without its prefix, on one line", () => {
    assert.strictEqual(cliDetail("note: x\na4sx: no cell named «x» is stored on this host. `a4sx mesh cells` lists them\n"),
      "no cell named «x» is stored on this host. `a4sx mesh cells` lists them");
    assert.strictEqual(cliDetail(""), undefined);
  });

  it("an argparse refusal means the CLI is too old for `mesh cells`", () => {
    assert.ok(looksTooOld({ code: 2, stdout: "", stderr: "a4sx mesh: error: argument mesh_cmd: invalid choice: 'cells'" }));
    assert.ok(!looksTooOld({ code: 1, stdout: "", stderr: "boom" }));
  });
});

describe("provisioning: download, sha256, launcher", () => {
  const CLI_BODY = Buffer.from('#!/usr/bin/env python3\n__version__ = "0.21.1"   # CLI version\nprint("hi")\n');
  const IPC_BODY = Buffer.from("# ipc proxy\n");

  function server(files: Record<string, { body: Buffer; sha?: string; status?: number }>): { fetch: Fetch; seen: string[] } {
    const seen: string[] = [];
    const fetch: Fetch = async (url) => {
      seen.push(url);
      const name = url.split("/").pop()!;
      const f = files[name];
      if (!f) {
        return { status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return {
        status: f.status ?? 200,
        headers: { get: (h: string) => (h.toLowerCase() === "x-a4sx-sha256" ? f.sha ?? sha256Hex(f.body) : null) },
        arrayBuffer: async () => f.body.buffer.slice(f.body.byteOffset, f.body.byteOffset + f.body.byteLength) as ArrayBuffer,
      };
    };
    return { fetch, seen };
  }

  it("the files are the ones the installers fetch: a4sx.py (required) and ipc_proxy.py (optional)", () => {
    assert.deepStrictEqual(CLI_FILES, [{ name: "a4sx.py", required: true }, { name: "ipc_proxy.py", required: false }]);
  });

  it("hashMatches: only a 64-hex header equal to the body's sha256", () => {
    const body = Buffer.from("abc");
    const sha = sha256Hex(body);
    assert.ok(hashMatches(body, sha));
    assert.ok(hashMatches(body, ` ${sha.toUpperCase()} `));
    for (const h of [null, undefined, "", "x".repeat(64), sha.slice(1), sha256Hex(Buffer.from("abd"))]) {
      assert.ok(!hashMatches(body, h), String(h));
    }
  });

  it("downloads both files from the configured server, checks them, writes them; resolves the version", async () => {
    const dir = path.join(tmpdir(), "cli");
    const s = server({ "a4sx.py": { body: CLI_BODY }, "ipc_proxy.py": { body: IPC_BODY } });
    assert.strictEqual(await downloadCli("https://a4sx.example.org", dir, s.fetch), "0.21.1");
    assert.deepStrictEqual(s.seen, ["https://a4sx.example.org/cli/a4sx.py", "https://a4sx.example.org/cli/ipc_proxy.py"]);
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, "a4sx.py")), CLI_BODY);
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, "ipc_proxy.py")), IPC_BODY);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["a4sx.py", "ipc_proxy.py"], "no .part file left");
  });

  it("a hash mismatch on any file installs nothing, and an existing copy stays", async () => {
    const dir = path.join(tmpdir(), "cli");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a4sx.py"), "old");
    const cases: Record<string, { body: Buffer; sha?: string }>[] = [
      { "a4sx.py": { body: CLI_BODY, sha: sha256Hex(Buffer.from("other")) }, "ipc_proxy.py": { body: IPC_BODY } },
      { "a4sx.py": { body: CLI_BODY }, "ipc_proxy.py": { body: IPC_BODY, sha: "0".repeat(64) } },
      { "a4sx.py": { body: CLI_BODY, sha: "" } },
    ];
    for (const files of cases) {
      await assert.rejects(downloadCli(BASE, dir, server(files).fetch), (e: unknown) => e instanceof ProvisionError && e.kind === "hash");
      assert.strictEqual(fs.readFileSync(path.join(dir, "a4sx.py"), "utf8"), "old");
      assert.deepStrictEqual(fs.readdirSync(dir), ["a4sx.py"]);
    }
  });

  it("a missing ipc_proxy.py is fine (the CLI fetches it on first use); a missing a4sx.py is an error", async () => {
    const dir = path.join(tmpdir(), "cli");
    assert.strictEqual(await downloadCli(BASE, dir, server({ "a4sx.py": { body: CLI_BODY } }).fetch), "0.21.1");
    assert.deepStrictEqual(fs.readdirSync(dir), ["a4sx.py"]);
    await assert.rejects(downloadCli(BASE, tmpdir(), server({}).fetch), (e: unknown) => e instanceof ProvisionError && e.kind === "network" && /HTTP 404/.test(e.message));
    const offline: Fetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
    await assert.rejects(downloadCli(BASE, tmpdir(), offline), /ENOTFOUND/);
  });

  it("POSIX launcher: the python and script paths quoted; the real sh passes every argument through", function () {
    if (process.platform === "win32") {
      this.skip();
    }
    const dir = path.join(tmpdir(), "it's a dir $(id)");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a4sx.py"), "import sys, json\nprint(json.dumps(sys.argv[1:]))\n");
    const launcher = writeLauncher("/usr/bin/python3", dir, "linux");
    assert.strictEqual(path.basename(launcher), "a4sx");
    assert.strictEqual(installedLauncher(dir, "linux"), launcher);
    assert.ok(fs.statSync(launcher).mode & 0o100);
    const args = ["launch", "--cell", "build", "it's", "$(echo PWNED)", "a b"];
    if (fs.existsSync("/usr/bin/python3")) {
      assert.deepStrictEqual(JSON.parse(execFileSync(launcher, args, { encoding: "utf8" })), args);
    }
  });

  it("Windows launcher: a .cmd with both paths in double quotes; a path with \" or % is refused", () => {
    const py = "C:\\Users\\Jo Doe\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";
    const dir = "C:\\Users\\Jo Doe\\AppData\\Roaming\\Code\\User\\globalStorage\\crossvaultgmbh.a4sx\\cli";
    assert.strictEqual(launcherName("win32"), "a4sx.cmd");
    assert.strictEqual(launcherText(py, dir, "win32"), `@echo off\r\n"${py}" "${dir}\\a4sx.py" %*\r\n`);
    assert.strictEqual(launcherText("C:\\P%PATH%\\python.exe", dir, "win32"), undefined);
    assert.strictEqual(launcherText(py, "C:\\a\"b", "win32"), undefined);
    assert.strictEqual(launcherText("/usr/bin/python3\n", "/x", "linux"), undefined);
  });

  it("Windows: a .cmd runs through cmd.exe /d /s /c with every piece quoted; anything cmd would expand is refused", () => {
    const cli = "C:\\Users\\Jo Doe\\AppData\\Roaming\\Code\\User\\globalStorage\\crossvaultgmbh.a4sx\\cli\\a4sx.cmd";
    assert.deepStrictEqual(execSpec(cli, ["mesh", "cells", "--json"], "win32", "C:\\WINDOWS\\system32\\cmd.exe"), {
      file: "C:\\WINDOWS\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", `""${cli}" "mesh" "cells" "--json""`],
      verbatim: true,
    });
    assert.strictEqual(execSpec(cli, ["mesh", "cell", "forget", "a&b"], "win32"), undefined);
    assert.strictEqual(execSpec("C:\\100%\\a4sx.cmd", ["update"], "win32"), undefined);
    assert.deepStrictEqual(execSpec("C:\\Programs\\a4sx.exe", ["update"], "win32"), { file: "C:\\Programs\\a4sx.exe", args: ["update"], verbatim: false });
    assert.deepStrictEqual(execSpec("/home/u/a4sx", ["update"], "linux"), { file: "/home/u/a4sx", args: ["update"], verbatim: false });
  });
});

describe("provisioning: Python, updates, the bundled claude", () => {
  it("Windows candidates: py -3, python, python3, then per-user installs, newest first", () => {
    const list = () => ["Python39", "Python312", "Python310", "Launcher", "Python313"];
    assert.deepStrictEqual(pythonCandidates("win32", { LOCALAPPDATA: "C:\\L" }, list), [
      ["py", "-3"], ["python"], ["python3"],
      ["C:\\L\\Programs\\Python\\Python313\\python.exe"], ["C:\\L\\Programs\\Python\\Python312\\python.exe"],
      ["C:\\L\\Programs\\Python\\Python310\\python.exe"], ["C:\\L\\Programs\\Python\\Python39\\python.exe"],
    ]);
    assert.deepStrictEqual(pythonCandidates("linux"), [["python3"], ["python"]]);
  });

  it("findPython: the first 3.10+ that answers the probe; the Store stub and old versions are skipped", async () => {
    const tried: string[][] = [];
    const run = async (file: string, args: readonly string[]) => {
      tried.push([file, ...args.slice(0, -2)]);
      if (file === "py") {
        return { code: 9009, stdout: "" };                 // the Store stub / no launcher
      }
      if (file === "python") {
        return { code: 0, stdout: "" };                    // 3.9: the probe prints nothing
      }
      return { code: 0, stdout: "C:\\Py\\python.exe\r\n" };
    };
    assert.strictEqual(await findPython(run, "win32", {}, () => []), "C:\\Py\\python.exe");
    assert.deepStrictEqual(tried, [["py", "-3"], ["python"], ["python3"]]);
    const none = async () => { throw new Error("ENOENT"); };
    assert.strictEqual(await findPython(none, "linux"), undefined);
    assert.strictEqual(await findPython(async () => ({ code: 0, stdout: "python3" }), "linux"), undefined, "a relative path is no answer");
  });

  it("updates: once a day; --base only for a server other than the default", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    assert.ok(updateDue(undefined, now));
    assert.ok(updateDue(now - UPDATE_EVERY_MS, now));
    assert.ok(!updateDue(now - 1000, now));
    assert.ok(updateDue(now + 60_000, now), "a clock that went back");
    assert.deepStrictEqual(updateArgs(`${BASE}/`, BASE), ["update"]);
    assert.deepStrictEqual(updateArgs("https://a4sx.example.org", BASE), ["update", "--base", "https://a4sx.example.org"]);
  });

  it("the bundled claude: resources/native-binary/claude (claude.exe on Windows), when it is there", () => {
    const have = new Set(["/ext/cc/resources/native-binary/claude", "C:\\ext\\cc\\resources\\native-binary\\claude.exe"]);
    assert.strictEqual(bundledClaude("/ext/cc", "linux", (p) => have.has(p)), "/ext/cc/resources/native-binary/claude");
    assert.strictEqual(bundledClaude("C:\\ext\\cc", "win32", (p) => have.has(p)), "C:\\ext\\cc\\resources\\native-binary\\claude.exe");
    assert.strictEqual(bundledClaude("/ext/other", "linux", (p) => have.has(p)), undefined);
    assert.strictEqual(bundledClaude(undefined, "linux"), undefined);
    assert.strictEqual(bundledClaude("ext/cc", "linux", () => true), undefined);          // a relative extension path is never used
    assert.strictEqual(bundledClaude("ext\\cc", "win32", () => true), undefined);
  });
});

// --- the view and its actions -------------------------------------------------------------------

interface Harness {
  deps: CellCommandDeps;
  runs: { cli: string; args: string[] }[];
  provider: CellsProvider;
  states: CellsLoad[];
}

function harness(opts: {
  resolve?: CliResolution; answers?: Record<string, CliOutput>; cliDir?: string; fetch?: Fetch; python?: CellCommandDeps["python"]; platform?: NodeJS.Platform;
  state?: ReturnType<typeof fakeMemento>;
} = {}): Harness {
  const runs: { cli: string; args: string[] }[] = [];
  const states: CellsLoad[] = [];
  let resolution: CliResolution = opts.resolve ?? { kind: "found", path: "/opt/a4sx bin/a4sx" };
  const run = async (cli: string, args: readonly string[]): Promise<CliOutput> => {
    runs.push({ cli, args: [...args] });
    return opts.answers?.[args.join(" ")] ?? { code: 0, stdout: args.join(" ") === CELLS_LIST_ARGS.join(" ") ? JSON.stringify(CLI_ANSWER) : "", stderr: "" };
  };
  const provider = new CellsProvider({ resolve: () => resolution, run, server: () => BASE, onState: (l) => states.push(l) });
  const deps: CellCommandDeps = {
    state: (opts.state ?? fakeMemento()) as any,
    cliDir: opts.cliDir,
    provider,
    resolve: () => {
      const r = resolution;
      if (r.kind === "no-cli" && opts.cliDir && installedLauncher(opts.cliDir, opts.platform ?? process.platform)) {
        resolution = { kind: "found", path: installedLauncher(opts.cliDir, opts.platform ?? process.platform)! };
        return resolution;
      }
      return r;
    },
    run,
    server: () => BASE,
    defaultServer: BASE,
    folder: async () => "/w/proj",
    fetch: opts.fetch ?? (async () => { throw new Error("no network in tests"); }),
    python: opts.python ?? (async () => ({ code: 1, stdout: "" })),
    platform: opts.platform,
    terminals: new Set(),
  };
  return { deps, runs, provider, states };
}

async function items(h: Harness): Promise<LocalCellItem[]> {
  return (await h.provider.getChildren()) as LocalCellItem[];
}

describe("Cells view", () => {
  beforeEach(resetCalls);

  it("lists the stored cells, the default first, with contextValues for the actions", async () => {
    const h = harness();
    const list = await items(h);
    assert.deepStrictEqual(h.runs, [{ cli: "/opt/a4sx bin/a4sx", args: ["mesh", "cells", "--json"] }]);
    assert.deepStrictEqual(list.map((i) => [i.label, i.description, i.contextValue]), [
      ["build", "default · Team mesh", "a4sx.localCell.default"],
      ["build", "Lab · waits for an admin", "a4sx.localCell"],
      ["spare", "standalone", "a4sx.localCell.standalone"],
      ["docs", "Team mesh", "a4sx.localCell"],
    ]);
    assert.strictEqual(new Set(list.map((i) => i.id)).size, 4, "unique ids");
    assert.match(String(list[0].tooltip), /Server: session-exchange\.com/);
  });

  it("no CLI: no items (the welcome text offers the install); empty list: the empty welcome", async () => {
    const h = harness({ resolve: { kind: "no-cli" } });
    assert.deepStrictEqual(await h.provider.getChildren(), []);
    assert.strictEqual(h.runs.length, 0);
    assert.deepStrictEqual(h.states, [{ kind: "no-cli" }]);
    const e = harness({ answers: { "mesh cells --json": { code: 0, stdout: "[]", stderr: "" } } });
    assert.deepStrictEqual(await e.provider.getChildren(), []);
    assert.deepStrictEqual(e.states, [{ kind: "ok", cells: [] }]);
  });

  it("an older CLI says so and offers the update; a failed read offers Refresh and the update", async () => {
    const old = harness({ answers: { "mesh cells --json": { code: 2, stdout: "", stderr: "error: argument mesh_cmd: invalid choice: 'cells'" } } });
    const [m] = await old.provider.getChildren();
    assert.deepStrictEqual([m.label, m.command?.command], [CELL_TEXTS.tooOld, "a4sx.updateCli"]);
    const bad = harness({ answers: { "mesh cells --json": { code: 0, stdout: "not json", stderr: "" } } });
    const two = await bad.provider.getChildren();
    assert.deepStrictEqual(two.map((i) => [i.label, i.command?.command]), [[CELL_TEXTS.listFailed, "a4sx.refreshCells"], [CELL_TEXTS.updateCli, "a4sx.updateCli"]]);
  });

  it("an invalid a4sx.cliPath, and a remote window with a local extension, show one line each", async () => {
    assert.strictEqual((await harness({ resolve: { kind: "bad-config" } }).provider.getChildren())[0].label, CELL_TEXTS.badConfig);
    assert.strictEqual((await harness({ resolve: { kind: "remote-local" } }).provider.getChildren())[0].label, CELL_TEXTS.remoteLocal);
  });
});

describe("Cells: actions", () => {
  beforeEach(resetCalls);

  it("Start in terminal: the reduced-isolation consent once per machine, then the launch in the workspace folder", async () => {
    const state = fakeMemento();
    const h = harness({ state });
    const list = await items(h);
    calls.modalChoices.push(CELL_CMD_TEXTS.consentAccept);
    const t = await startCell(h.deps, list[3]);
    assert.ok(t);
    assert.deepStrictEqual(calls.modals.map((m) => [m.kind, m.message, m.items]), [["warning", CELL_CMD_TEXTS.consentTitle, [CELL_CMD_TEXTS.consentAccept]]]);
    assert.match(calls.modals[0].detail!, /read and use the a4sx sign-ins and keys saved on this computer/);
    assert.strictEqual(calls.terminals[0].options.name, "a4sx: cell docs");
    assert.strictEqual(calls.terminals[0].options.cwd, "/w/proj");
    assert.deepStrictEqual(calls.terminals[0].sent, ["'/opt/a4sx bin/a4sx' 'launch' '--cell' 'docs' '--mesh-reduced-isolation'\n"]);
    assert.ok(h.deps.terminals.has(t!));
    // The second start asks nothing.
    await startCell(h.deps, list[0]);
    assert.strictEqual(calls.modals.length, 1);
    assert.deepStrictEqual(calls.terminals[1].sent, [`'/opt/a4sx bin/a4sx' 'launch' '--cell' 'build' '--mesh' '${MESH}' '--mesh-reduced-isolation'\n`]);
    assert.strictEqual((state.data_.get(CONSENT_KEY) as string[]).length, 1);
  });

  it("declining the consent starts nothing and remembers nothing; another machine is asked again", async () => {
    const state = fakeMemento();
    const h = harness({ state });
    const list = await items(h);
    await startCell(h.deps, list[3]);
    assert.strictEqual(calls.terminals.length, 0);
    assert.strictEqual(state.data_.get(CONSENT_KEY), undefined);
    calls.modalChoices.push(CELL_CMD_TEXTS.consentAccept);
    assert.ok(await consentReducedIsolation(state as any, "machine-a"));
    assert.ok(await consentReducedIsolation(state as any, "machine-a"));
    assert.ok(!(await consentReducedIsolation(state as any, "machine-b")));
    assert.strictEqual(calls.modals.length, 3);
  });

  it("the terminal gets A4SX_CLAUDE = the Claude Code extension's bundled claude, and nothing else", async () => {
    const dir = tmpdir();
    const bin = path.join(dir, "resources", "native-binary");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, process.platform === "win32" ? "claude.exe" : "claude"), "");
    calls.extensions.add("anthropic.claude-code");
    calls.extensionPaths.set("anthropic.claude-code", dir);
    const saved = process.env.A4SX_CLAUDE;
    delete process.env.A4SX_CLAUDE;
    try {
      const h = harness({ state: fakeMemento({ [CONSENT_KEY]: [require("../../cellCommands").machineKey()] }) });
      await newCell(h.deps);
      assert.deepStrictEqual(calls.terminals[0].options.env, { A4SX_CLAUDE: path.join(bin, process.platform === "win32" ? "claude.exe" : "claude") });
      assert.deepStrictEqual(calls.terminals[0].sent, ["'/opt/a4sx bin/a4sx' 'launch' '--new-cell' '--mesh-reduced-isolation'\n"]);
      process.env.A4SX_CLAUDE = "/my/claude";
      await newCell(h.deps);
      assert.strictEqual(calls.terminals[1].options.env, undefined, "the user's own A4SX_CLAUDE wins");
    } finally {
      if (saved === undefined) {
        delete process.env.A4SX_CLAUDE;
      } else {
        process.env.A4SX_CLAUDE = saved;
      }
    }
  });

  it("Windows paths: PowerShell runs the launcher with & and single quotes; cmd with double quotes", async () => {
    const cli = "C:\\Users\\Jo Doe\\AppData\\Roaming\\Code\\User\\globalStorage\\crossvaultgmbh.a4sx\\cli\\a4sx.cmd";
    for (const [shell, want] of [
      ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", `& '${cli}' 'launch' '--cell' 'docs' '--mesh-reduced-isolation'\n`],
      ["C:\\WINDOWS\\System32\\cmd.exe", `"${cli}" "launch" "--cell" "docs" "--mesh-reduced-isolation"\n`],
    ]) {
      resetCalls();
      calls.shell = shell;
      const h = harness({ resolve: { kind: "found", path: cli }, state: fakeMemento({ [CONSENT_KEY]: [require("../../cellCommands").machineKey()] }) });
      await startCell(h.deps, (await items(h))[3]);
      assert.deepStrictEqual(calls.terminals[0].sent, [want], shell);
    }
  });

  it("a standalone cell isn't started: the message offers its page", async () => {
    const h = harness();
    calls.nextInfoChoice = CELL_CMD_TEXTS.openInBrowser;
    await startCell(h.deps, (await items(h))[2]);
    assert.strictEqual(calls.terminals.length, 0);
    assert.deepStrictEqual(calls.opened, [`${BASE}/meshes`]);
  });

  it("Set as default runs `mesh cell default`, then reads the list again", async () => {
    const h = harness();
    const list = await items(h);
    assert.ok(await setDefaultCell(h.deps, list[1]));
    assert.deepStrictEqual(h.runs.map((r) => r.args.join(" ")), ["mesh cells --json", `mesh cell default build --mesh ${MESH2}`, "mesh cells --json"]);
    assert.deepStrictEqual(calls.infos, [CELL_CMD_TEXTS.nowDefault("build")]);
  });

  it("a refusal shows the CLI's own line", async () => {
    const h = harness({ answers: { "mesh cell default docs": { code: 1, stdout: "", stderr: "a4sx: could not write the cell list (disk full)\n" } } });
    assert.ok(!(await setDefaultCell(h.deps, (await items(h))[3])));
    assert.deepStrictEqual(calls.errors.map((e) => e.message), ["Could not make it the default: could not write the cell list (disk full)"]);
  });

  it("Forget asks first; Cancel runs nothing; Forget runs `mesh cell forget` and reads the list again", async () => {
    const h = harness();
    const list = await items(h);
    assert.ok(!(await forgetCell(h.deps, list[3])));
    assert.deepStrictEqual(calls.modals.map((m) => [m.message, m.items, m.detail]), [[CELL_CMD_TEXTS.forgetTitle("docs"), [CELL_CMD_TEXTS.forget], CELL_CMD_TEXTS.forgetDetail]]);
    assert.strictEqual(h.runs.length, 1);
    calls.modalChoices.push(CELL_CMD_TEXTS.forget);
    assert.ok(await forgetCell(h.deps, list[3]));
    assert.deepStrictEqual(h.runs.map((r) => r.args.join(" ")).slice(1), ["mesh cell forget docs", "mesh cells --json"]);
  });

  it("Open in browser: the mesh's page on the configured server", async () => {
    const h = harness();
    await openCellOnWeb(h.deps, (await items(h))[0]);
    assert.deepStrictEqual(calls.opened, [`${BASE}/meshes/m/${MESH}`]);
  });

  it("the commands without an item (palette) do nothing", async () => {
    const h = harness();
    for (const f of [startCell, setDefaultCell, forgetCell, openCellOnWeb]) {
      await (f as (d: CellCommandDeps, i: undefined) => Promise<unknown>)(h.deps, undefined);
    }
    assert.deepStrictEqual([calls.terminals.length, calls.modals.length, calls.opened.length, h.runs.length], [0, 0, 0, 0]);
  });
});

describe("Cells: installing the CLI", () => {
  beforeEach(resetCalls);
  const CLI_BODY = Buffer.from('__version__ = "0.21.1"\nimport sys, json\nprint(json.dumps(sys.argv[1:]))\n');
  const fetch: Fetch = async (url) => {
    const body = url.endsWith("/cli/a4sx.py") ? CLI_BODY : undefined;
    return {
      status: body ? 200 : 404,
      headers: { get: (h: string) => (body && h === "x-a4sx-sha256" ? sha256Hex(body) : null) },
      arrayBuffer: async () => (body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer : new ArrayBuffer(0)),
    };
  };

  it("New cell without a CLI offers the install; it finds Python, downloads, checks, writes the launcher, then starts", async () => {
    const dir = path.join(tmpdir(), "cli");
    const state = fakeMemento({ [CONSENT_KEY]: [require("../../cellCommands").machineKey()] });
    const python = async (_f: string, args: readonly string[]) => ({ code: 0, stdout: args.includes("-c") ? "/usr/bin/python3\n" : "" });
    const h = harness({ resolve: { kind: "no-cli" }, cliDir: dir, fetch, python, state, platform: "linux" });
    calls.modalChoices.push(CELL_CMD_TEXTS.installCli);
    const t = await newCell(h.deps);
    assert.ok(t);
    assert.deepStrictEqual(calls.modals.map((m) => [m.message, m.items]), [[CELL_CMD_TEXTS.noCli, [CELL_CMD_TEXTS.installCli]]]);
    assert.ok(calls.infos.includes(CELL_CMD_TEXTS.installed("0.21.1")));
    const launcher = path.join(dir, "a4sx");
    assert.strictEqual(fs.readFileSync(launcher, "utf8"), `#!/bin/sh\n# a4sx CLI launcher, written by the a4sx VS Code extension.\nexec '/usr/bin/python3' '${dir}/a4sx.py' "$@"\n`);
    assert.deepStrictEqual(calls.terminals[0].sent, [`'${launcher}' 'launch' '--new-cell' '--mesh-reduced-isolation'\n`]);
    assert.strictEqual(typeof state.data_.get(LAST_UPDATE_KEY), "number");
  });

  it("no Python on Windows: a modal offers `winget install Python.Python.3.12` in a terminal; nothing is downloaded", async () => {
    const seen: string[] = [];
    const h = harness({ resolve: { kind: "no-cli" }, cliDir: tmpdir(), platform: "win32", fetch: async (u) => { seen.push(u); throw new Error("x"); } });
    calls.modalChoices.push(CELL_CMD_TEXTS.installPython);
    calls.shell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    assert.ok(!(await installCli(h.deps)));
    assert.deepStrictEqual(calls.modals.map((m) => [m.kind, m.message, m.items]), [["error", CELL_CMD_TEXTS.noPythonWin, [CELL_CMD_TEXTS.installPython]]]);
    assert.deepStrictEqual(calls.terminals[0].sent, ["& 'winget' 'install' 'Python.Python.3.12'\n"]);
    assert.deepStrictEqual(seen, []);
  });

  it("no Python elsewhere: a message with the download page; a hash mismatch: the error, no launcher", async () => {
    const h = harness({ resolve: { kind: "no-cli" }, cliDir: tmpdir(), platform: "linux" });
    calls.nextErrorChoice = CELL_CMD_TEXTS.howToInstall;
    assert.ok(!(await installCli(h.deps)));
    assert.deepStrictEqual(calls.opened, ["https://www.python.org/downloads/"]);
    resetCalls();
    const dir = path.join(tmpdir(), "cli");
    const bad: Fetch = async () => ({ status: 200, headers: { get: () => "0".repeat(64) }, arrayBuffer: async () => new ArrayBuffer(4) });
    const h2 = harness({ resolve: { kind: "no-cli" }, cliDir: dir, platform: "linux", fetch: bad, python: async () => ({ code: 0, stdout: "/usr/bin/python3" }) });
    assert.ok(!(await installCli(h2.deps)));
    assert.match(calls.errors[0].message, /doesn't match the checksum/);
    assert.strictEqual(fs.existsSync(path.join(dir, "a4sx")), false);
  });

  it("the daily update: `a4sx update` for the extension's own copy, silently, at most once a day", async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "a4sx.py"), "");
    writeLauncher("/usr/bin/python3", dir, "linux");
    const state = fakeMemento();
    const h = harness({ cliDir: dir, state, platform: "linux" });
    const now = Date.parse("2026-11-02T12:00:00Z");
    assert.ok(await dailyUpdate(h.deps, now));
    assert.deepStrictEqual(h.runs, [{ cli: path.join(dir, "a4sx"), args: ["update"] }]);
    assert.ok(!(await dailyUpdate(h.deps, now + 3600_000)));
    assert.strictEqual(h.runs.length, 1);
    assert.deepStrictEqual([calls.infos, calls.errors, calls.terminals], [[], [], []], "silent");
    const none = harness({ cliDir: tmpdir(), state: fakeMemento() });
    assert.ok(!(await dailyUpdate(none.deps, now)));
    assert.strictEqual(none.runs.length, 0, "a CLI the user installed elsewhere is theirs to update");
  });
});

describe("Cells: manifest and wiring", () => {
  beforeEach(resetCalls);

  it("the Cells view comes before Meshes and is always shown; item commands are hidden from the palette", () => {
    const ids = pkg.contributes.views.a4sx.map((v: any) => v.id);
    assert.ok(ids.indexOf("a4sx.cells") < ids.indexOf("a4sx.meshes"));
    assert.strictEqual(pkg.contributes.views.a4sx.find((v: any) => v.id === "a4sx.cells").when, undefined);
    for (const id of ["a4sx.startCell", "a4sx.setDefaultCell", "a4sx.forgetCell", "a4sx.openCellOnWeb"]) {
      assert.ok(pkg.contributes.menus.commandPalette.some((m: any) => m.command === id && m.when === "false"), id);
    }
    const welcome = pkg.contributes.viewsWelcome.filter((w: any) => w.view === "a4sx.cells");
    assert.deepStrictEqual(welcome.map((w: any) => w.when), ["a4sx.cellsNoCli", "a4sx.cellsEmpty && !a4sx.cellsNoCli"]);
    assert.match(welcome[0].contents, /\(command:a4sx\.installCli\)/);
  });

  it("Start is offered on a cell in a mesh, Set as default on one that isn't the default", () => {
    const menu = pkg.contributes.menus["view/item/context"];
    const when = (cmd: string) => new RegExp(menu.find((m: any) => m.command === cmd).when.match(/viewItem =~ \/(.*)\/$/)[1]);
    const start = when("a4sx.startCell");
    const def = when("a4sx.setDefaultCell");
    assert.deepStrictEqual(["a4sx.localCell", "a4sx.localCell.default", "a4sx.localCell.standalone", "a4sx.localCell.standalone.default"].map((c) => [start.test(c), def.test(c)]),
      [[true, true], [true, false], [false, true], [false, false]]);
  });

  it("activate registers the view; a missing CLI sets the welcome's context key", async () => {
    const ctx = { subscriptions: [] as { dispose(): unknown }[], secrets: (await import("../fakeVscode")).fakeSecrets(), globalState: fakeMemento() };
    calls.config["a4sx.cliPath"] = "/nonexistent/a4sx";
    ext.activate(ctx as any);
    assert.ok(calls.treeProviders.has(ext.VIEW_CELLS));
    await (calls.treeProviders.get(ext.VIEW_CELLS) as CellsProvider).getChildren();
    assert.strictEqual(calls.context["a4sx.cellsNoCli"], false);
    assert.strictEqual(ext.resolveCellsCli(() => ({ found: false, reason: "not-on-path" })).kind, "no-cli");
    assert.strictEqual(ext.resolveCellsCli(() => ({ found: false, reason: "configured-path-invalid", configured: "x" })).kind, "bad-config");
  });
});
