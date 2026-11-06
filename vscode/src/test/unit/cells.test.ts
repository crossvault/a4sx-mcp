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
import { calls, fakeMemento, fakeSecrets, resetCalls } from "../fakeVscode";
import * as ext from "../../extension";
import {
  cellDefaultArgs, cellForgetArgs, cellLaunchArgs, cellPageUrl, cellsListDir, CELLS_LIST_ARGS, LocalCell, localCellDescription, NEW_CELL_ARGS, parseCellsJson,
  serverOrigin, showText,
} from "../../cells";
import {
  CELL_CMD_TEXTS, CellCommandDeps, cliDetail, CONSENT_KEY, consentReducedIsolation, dailyUpdate, forgetCell, installCli, LAST_UPDATE_KEY, machineKey, newCell,
  openCellOnWeb, ownCliCheck, repairOnce, repairOwnCli, setDefaultCell, startCell,
} from "../../cellCommands";
import { IN_SESSION_MESSAGE } from "../../cliJson";
import { RESUME_TEXTS } from "../../resume";
import { SessionItem } from "../../sessionsView";
import { CELL_TEXTS, CellsLoad, CellsProvider, CliOutput, CliResolution, LocalCellItem, looksTooOld, MeshGroupItem } from "../../cellsView";
import {
  bundledClaude, CLI_FILES, downloadCli, execSpec, Fetch, findPython, hashMatches, installedLauncher, isStorePython, launcherName, launcherText, launcherNeedsRepair,
  ProvisionError, PROVISION_TEXTS, pythonCandidates, pythonFolders, repairLauncher, searchPython, sha256Hex, updateArgs, updateDue, UPDATE_EVERY_MS, writeLauncher,
} from "../../provision";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../../package.json");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscodeFake = require("vscode");

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

/** The Python probe's line: sys.executable, sys._base_executable, sys.base_prefix. */
const probeOut = (exe: string, base = exe, prefix = "") => `${JSON.stringify([exe, base, prefix])}\r\n`;

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
  it("Windows candidates: py -3, python, python3, then per-user installs, then %ProgramFiles%\\Python3*, newest first in each", () => {
    const dirs: Record<string, string[]> = {
      "C:\\L\\Programs\\Python": ["Python39", "Python312", "Python310", "Launcher", "Python313"],
      "C:\\Program Files": ["Python311", "Python314", "PythonSoftwareFoundation", "Common Files"],
    };
    const list = (d: string) => dirs[d] ?? [];
    assert.deepStrictEqual(pythonCandidates("win32", { LOCALAPPDATA: "C:\\L", ProgramFiles: "C:\\Program Files" }, list), [
      ["py", "-3"], ["python"], ["python3"],
      ["C:\\L\\Programs\\Python\\Python313\\python.exe"], ["C:\\L\\Programs\\Python\\Python312\\python.exe"],
      ["C:\\L\\Programs\\Python\\Python310\\python.exe"], ["C:\\L\\Programs\\Python\\Python39\\python.exe"],
      ["C:\\Program Files\\Python314\\python.exe"], ["C:\\Program Files\\Python311\\python.exe"],
    ]);
    assert.deepStrictEqual(pythonCandidates("win32", { ProgramFiles: "C:\\Program Files" }, list), [
      ["py", "-3"], ["python"], ["python3"], ["C:\\Program Files\\Python314\\python.exe"], ["C:\\Program Files\\Python311\\python.exe"],
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
      return { code: 0, stdout: probeOut("C:\\Py\\python.exe") };
    };
    assert.strictEqual(await findPython(run, "win32", {}, () => []), "C:\\Py\\python.exe");
    assert.deepStrictEqual(tried, [["py", "-3"], ["python"], ["python3"]]);
    const none = async () => { throw new Error("ENOENT"); };
    assert.strictEqual(await findPython(none, "linux"), undefined);
    assert.strictEqual(await findPython(async () => ({ code: 0, stdout: probeOut("python3") }), "linux"), undefined, "a relative path is no answer");
    assert.strictEqual(await findPython(async () => ({ code: 0, stdout: "/usr/bin/python3\n" }), "linux"), undefined, "a line that isn't the probe's JSON is no answer");
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

// --- 0.5.1: the Microsoft Store Python ----------------------------------------------------------

/** A full Store install's sys.executable, as `python` reported it on a Windows 11 box (CLI 0.25.0 refused it). */
const STORE_EXE = "C:\\Users\\kartan\\AppData\\Local\\Microsoft\\WindowsApps\\PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0\\python.exe";
const GOOD_EXE = "C:\\Users\\kartan\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";

/**
 * A Python runner: `answers[file]` is the probe's sys.executable ("" = too old: the probe prints nothing), or
 * { exe, base, prefix } (a venv), or { code } (a program that fails, like the Store's install stub, exit 9009);
 * a missing file throws (not installed).
 */
type PyAnswer = string | { exe?: string; base?: string; prefix?: string; code?: number };
function pythons(answers: Record<string, PyAnswer>, tried: string[] = []): CellCommandDeps["python"] {
  return async (file) => {
    tried.push(file);
    if (!(file in answers)) {
      throw new Error("ENOENT");
    }
    const a = answers[file];
    if (typeof a === "string") {
      return { code: 0, stdout: a ? probeOut(a) : "\r\n" };
    }
    return { code: a.code ?? 0, stdout: a.exe ? probeOut(a.exe, a.base, a.prefix) : "" };
  };
}

/** The extension's own copy with a launcher that runs `python` (Windows form). */
function ownCopy(python: string): string {
  const dir = path.join(tmpdir(), "cli");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a4sx.py"), "");
  writeLauncher(python, dir, "win32");
  return dir;
}

describe("0.5.1: the Microsoft Store Python", () => {
  beforeEach(resetCalls);

  it("the Store build is told by its real path, as install.ps1 and the CLI tell it", () => {
    for (const exe of [
      STORE_EXE,
      "C:\\Users\\k\\AppData\\Local\\Microsoft\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\\python.exe",
      "C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_3.12.2032.0_x64__qbz5n2kfra8p0\\python.exe",
      "C:\\Users\\k\\AppData\\Local\\Packages\\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\\LocalCache\\python.exe",
      "c:\\users\\k\\appdata\\local\\microsoft\\windowsapps\\pythonsoftwarefoundation.python.3.11_qbz5n2kfra8p0\\python.exe",
    ]) {
      assert.ok(isStorePython(exe), exe);
    }
    for (const exe of [
      "C:\\Python312\\python.exe", GOOD_EXE, "C:\\Program Files\\Python313\\python.exe",
      "C:\\Users\\k\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",          // the alias itself, before it resolves
      "C:\\Users\\k\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe",     // the python.org install manager
      "/usr/bin/python3",
    ]) {
      assert.ok(!isStorePython(exe), exe);
    }
  });

  it("findPython skips a full Store install and goes on down the candidates", async () => {
    const tried: string[] = [];
    const run = pythons({ python: STORE_EXE, python3: STORE_EXE, [GOOD_EXE]: GOOD_EXE }, tried);
    const env = { LOCALAPPDATA: "C:\\Users\\kartan\\AppData\\Local" };
    const list = (d: string) => (d.endsWith("Programs\\Python") ? ["Python312"] : []);
    assert.strictEqual(await findPython(run, "win32", env, list), GOOD_EXE);
    assert.deepStrictEqual(tried, ["py", "python", "python3", GOOD_EXE]);
    assert.deepStrictEqual(await searchPython(run, "win32", env, list), { kind: "found", exe: GOOD_EXE });
  });

  it("only the Store build: \"store-only\", not \"none\"; no Python at all: \"none\"", async () => {
    assert.deepStrictEqual(await searchPython(pythons({ python: STORE_EXE }), "win32", {}, () => []), { kind: "store-only", exe: STORE_EXE });
    assert.strictEqual(await findPython(pythons({ python: STORE_EXE }), "win32", {}, () => []), undefined);
    assert.deepStrictEqual(await searchPython(pythons({}), "win32", {}, () => []), { kind: "none" });
    assert.deepStrictEqual(await searchPython(pythons({ python: "" }), "win32", {}, () => []), { kind: "none" }, "too old is no Python");
  });

  it("the own launcher: a Store Python in it is seen from its text; repair rewrites it with a better Python", async () => {
    const dir = ownCopy(STORE_EXE);
    assert.ok(launcherNeedsRepair(dir, "win32"));
    assert.strictEqual(await repairLauncher(dir, pythons({ python: STORE_EXE, python3: GOOD_EXE }), "win32", {}, () => []), "repaired");
    assert.ok(!launcherNeedsRepair(dir, "win32"));
    assert.strictEqual(fs.readFileSync(path.join(dir, "a4sx.cmd"), "utf8"), launcherText(GOOD_EXE, dir, "win32"));
    const tried: string[] = [];
    assert.strictEqual(await repairLauncher(dir, pythons({ python: GOOD_EXE }, tried), "win32"), "ok");
    assert.deepStrictEqual(tried, [], "a good launcher runs nothing");
    assert.strictEqual(await repairLauncher(undefined, pythons({}), "win32"), "ok");
    assert.strictEqual(await repairLauncher(tmpdir(), pythons({}), "win32"), "ok", "no launcher: nothing to repair");
  });

  it("repair without a better Python leaves the launcher as it is and says why", async () => {
    const dir = ownCopy(STORE_EXE);
    const before = fs.readFileSync(path.join(dir, "a4sx.cmd"), "utf8");
    assert.strictEqual(await repairLauncher(dir, pythons({ python: STORE_EXE }), "win32", {}, () => []), "store-only");
    assert.strictEqual(await repairLauncher(dir, pythons({}), "win32", {}, () => []), "none");
    assert.strictEqual(fs.readFileSync(path.join(dir, "a4sx.cmd"), "utf8"), before);
  });

  it("Install a4sx CLI with only the Store Python: the Store message and the winget offer; nothing is downloaded", async () => {
    const seen: string[] = [];
    const h = harness({
      resolve: { kind: "no-cli" }, cliDir: tmpdir(), platform: "win32", python: pythons({ python: STORE_EXE }), fetch: async (u) => { seen.push(u); throw new Error("x"); },
    });
    calls.modalChoices.push(CELL_CMD_TEXTS.installPython);
    calls.shell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    assert.ok(!(await installCli(h.deps)));
    assert.deepStrictEqual(calls.modals.map((m) => [m.kind, m.message, m.items, m.detail]), [
      ["error", CELL_CMD_TEXTS.storePythonWin, [CELL_CMD_TEXTS.installPython], "winget install Python.Python.3.12"],
    ]);
    assert.deepStrictEqual(calls.terminals[0].sent, ["& 'winget' 'install' 'Python.Python.3.12'\n"]);
    assert.deepStrictEqual(seen, []);
  });

  it("Install a4sx CLI writes the better Python into the launcher, never the Store one", async () => {
    const dir = path.join(tmpdir(), "cli");
    const body = Buffer.from('__version__ = "0.25.0"\n');
    const fetch: Fetch = async (url) => {
      const ok = url.endsWith("/cli/a4sx.py");
      return {
        status: ok ? 200 : 404,
        headers: { get: (n: string) => (ok && n === "x-a4sx-sha256" ? sha256Hex(body) : null) },
        arrayBuffer: async () => (ok ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer : new ArrayBuffer(0)),
      };
    };
    const h = harness({ resolve: { kind: "no-cli" }, cliDir: dir, platform: "win32", fetch, python: pythons({ py: STORE_EXE, python: GOOD_EXE }) });
    assert.ok(await installCli(h.deps));
    assert.strictEqual(fs.readFileSync(path.join(dir, "a4sx.cmd"), "utf8"), launcherText(GOOD_EXE, dir, "win32"));
  });

  it("at activation: a Store launcher is rewritten silently when a better Python is there", async () => {
    const dir = ownCopy(STORE_EXE);
    const h = harness({ cliDir: dir, platform: "win32", python: pythons({ python: GOOD_EXE }) });
    assert.ok(await repairOwnCli(h.deps));
    assert.ok(!launcherNeedsRepair(dir, "win32"));
    assert.deepStrictEqual([calls.modals, calls.errors, calls.infos], [[], [], []], "silent");
    const still = harness({ cliDir: ownCopy(STORE_EXE), platform: "win32", python: pythons({ python: STORE_EXE }) });
    assert.ok(!(await repairOwnCli(still.deps)));
    assert.deepStrictEqual([calls.modals, calls.errors], [[], []], "no message at activation; the next CLI action says it");
  });

  it("before the own copy is used: repaired silently, then the cell starts", async () => {
    const dir = ownCopy(STORE_EXE);
    const launcher = installedLauncher(dir, "win32")!;
    const state = fakeMemento({ [CONSENT_KEY]: [machineKey()] });
    const h = harness({ resolve: { kind: "found", path: launcher }, cliDir: dir, platform: "win32", state, python: pythons({ python: STORE_EXE, python3: GOOD_EXE }) });
    assert.ok(await newCell(h.deps));
    assert.ok(!launcherNeedsRepair(dir, "win32"));
    assert.deepStrictEqual(calls.modals, []);
    assert.strictEqual(calls.terminals.length, 1);
  });

  it("before the own copy is used: only the Store Python left: the Store message with the winget offer; nothing starts", async () => {
    const dir = ownCopy(STORE_EXE);
    const launcher = installedLauncher(dir, "win32")!;
    const state = fakeMemento({ [CONSENT_KEY]: [machineKey()] });
    const h = harness({ resolve: { kind: "found", path: launcher }, cliDir: dir, platform: "win32", state, python: pythons({ python: STORE_EXE }) });
    assert.strictEqual(await newCell(h.deps), undefined);
    assert.deepStrictEqual(calls.modals.map((m) => [m.message, m.items]), [[CELL_CMD_TEXTS.storePythonWin, [CELL_CMD_TEXTS.installPython]]]);
    assert.strictEqual(calls.terminals.length, 0);
    const none = harness({ resolve: { kind: "found", path: launcher }, cliDir: dir, platform: "win32", state, python: pythons({}) });
    resetCalls();
    assert.strictEqual(await newCell(none.deps), undefined);
    assert.deepStrictEqual(calls.modals.map((m) => m.message), [CELL_CMD_TEXTS.noPythonWin], "no Python at all: the plain message");
  });

  it("a CLI that isn't the own copy is used as it is (its Python is the installer's business)", async () => {
    const dir = ownCopy(STORE_EXE);
    const state = fakeMemento({ [CONSENT_KEY]: [machineKey()] });
    const tried: string[] = [];
    const h = harness({ resolve: { kind: "found", path: "C:\\Users\\k\\AppData\\Local\\Programs\\a4sx\\a4sx.cmd" }, cliDir: dir, platform: "win32", state, python: pythons({}, tried) });
    assert.ok(await newCell(h.deps));
    assert.deepStrictEqual(tried, []);
  });

  it("the daily update skips a launcher that still runs a Store Python", async () => {
    const h = harness({ cliDir: ownCopy(STORE_EXE), platform: "win32", state: fakeMemento() });
    assert.ok(!(await dailyUpdate(h.deps, Date.parse("2026-11-06T12:00:00Z"))));
    assert.strictEqual(h.runs.length, 0);
  });
});

describe("0.5.1 review: paths, venvs, every Python on PATH, one repair at a time", () => {
  beforeEach(resetCalls);
  const VENV = "C:\\proj\\.venv\\Scripts\\python.exe";
  const STORE_PREFIX = "C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.Python.3.11_3.11.2544.0_x64__qbz5n2kfra8p0";

  it("on Windows only a drive or UNC path is a Python: an MSYS/Cygwin /usr/bin/python3 or a rooted \\foo is skipped", async () => {
    const tried: string[] = [];
    const run = pythons({ python: "/usr/bin/python3", python3: "\\usr\\bin\\python.exe", py: "\\\\srv\\tools\\py\\python.exe" }, tried);
    assert.strictEqual(await findPython(run, "win32", {}, () => []), "\\\\srv\\tools\\py\\python.exe", "a UNC share is fine");
    assert.deepStrictEqual(await searchPython(pythons({ python: "/usr/bin/python3", python3: "\\usr\\bin\\python.exe" }), "win32", {}, () => []), { kind: "none" });
    assert.deepStrictEqual(await searchPython(pythons({ python: "\\\\?\\C:\\Py\\python.exe" }), "win32", {}, () => []), { kind: "none" }, "no device paths");
    assert.strictEqual(await findPython(pythons({ python3: "/usr/bin/python3" }), "linux"), "/usr/bin/python3", "elsewhere POSIX paths as before");
  });

  it("a drive path with forward slashes (C:/msys64/…) is a Windows path: found, and a launcher holding it isn't repaired", async () => {
    const MINGW = "C:/msys64/mingw64/bin/python.exe";
    assert.strictEqual(await findPython(pythons({ python: MINGW }), "win32", {}, () => []), MINGW);
    const dir = ownCopy(MINGW);
    assert.ok(!launcherNeedsRepair(dir, "win32"));
    const tried: string[] = [];
    assert.strictEqual(await repairLauncher(dir, pythons({}, tried), "win32"), "ok");
    assert.deepStrictEqual(tried, []);
    assert.ok(launcherNeedsRepair(ownCopy("/c/msys64/mingw64/bin/python.exe"), "win32"), "an MSYS-style /c/… path still is");
  });

  it("each interpreter is probed once: a PATH entry that bare python already reported (any case) is skipped", async () => {
    const venvDir = "C:\\proj\\.venv\\Scripts";
    const have = new Set([`${venvDir}\\python.exe`, "C:\\Other\\python.exe"]);
    const tried: string[] = [];
    const run = pythons({ python: { exe: VENV, base: STORE_EXE }, [`${venvDir}\\python.exe`]: GOOD_EXE, "C:\\Other\\python.exe": { exe: "C:\\Other\\python.exe", base: STORE_EXE } }, tried);
    const env = { PATH: "c:\\PROJ\\.venv\\Scripts;C:\\Other" };
    assert.deepStrictEqual(await searchPython(run, "win32", env, () => [], (p) => have.has(p) || have.has(p.replace(/^c:\\PROJ/, "C:\\proj"))), { kind: "store-only", exe: VENV });
    assert.deepStrictEqual(tried, ["py", "python", "python3", "C:\\Other\\python.exe"], "the venv's python.exe was not probed a second time");
  });

  it("a venv built on the Store Python is the Store build too (by sys._base_executable, or sys.base_prefix)", async () => {
    assert.deepStrictEqual(await searchPython(pythons({ python: { exe: VENV, base: STORE_EXE } }), "win32", {}, () => []), { kind: "store-only", exe: VENV });
    assert.deepStrictEqual(await searchPython(pythons({ python: { exe: VENV, base: "", prefix: STORE_PREFIX } }), "win32", {}, () => []), { kind: "store-only", exe: VENV });
    assert.strictEqual(await findPython(pythons({ python: { exe: VENV, base: STORE_EXE }, python3: { exe: VENV, base: GOOD_EXE, prefix: "C:\\Py312" } }), "win32", {}, () => []), VENV,
      "a venv on another Python is fine");
  });

  it("the Store stub exits non-zero and is skipped; non-zero is never an answer, even with output", async () => {
    assert.deepStrictEqual(await searchPython(pythons({ py: { code: 9009 }, python: { code: 9009 }, python3: { code: 9009 } }), "win32", {}, () => []), { kind: "none" });
    assert.deepStrictEqual(await searchPython(pythons({ py: { code: 9009 }, python: STORE_EXE }), "win32", {}, () => []), { kind: "store-only", exe: STORE_EXE });
    assert.deepStrictEqual(await searchPython(pythons({ python: { code: 1, exe: GOOD_EXE } }), "win32", {}, () => []), { kind: "none" });
  });

  it("Python3* folders as install.ps1 globs them (Python312-32, Python313-arm64), newest first by version", () => {
    assert.deepStrictEqual(pythonFolders(["Python312-32", "Python313-arm64", "Python39", "Python312", "Python3", "Launcher", "Python310", "python314"]),
      ["python314", "Python313-arm64", "Python312", "Python312-32", "Python310", "Python39", "Python3"]);
  });

  it("every python.exe, then every python3.exe, in the PATH folders; quoted and duplicate folders handled, non-Windows paths ignored", () => {
    const have = new Set(["C:\\A\\python.exe", "C:\\C\\python.exe", "C:\\B\\python3.exe", "C:\\L\\Programs\\Python\\Python312\\python.exe", "/usr/bin/python.exe"]);
    const env = { PATH: "C:\\A;\"C:\\B\";;/usr/bin;C:\\C;c:\\a;C:\\L\\Programs\\Python\\Python312", LOCALAPPDATA: "C:\\L" };
    const list = (d: string) => (d === "C:\\L\\Programs\\Python" ? ["Python312"] : []);
    assert.deepStrictEqual(pythonCandidates("win32", env, list, (p) => have.has(p)), [
      ["py", "-3"], ["python"], ["python3"],
      ["C:\\A\\python.exe"], ["C:\\C\\python.exe"], ["C:\\L\\Programs\\Python\\Python312\\python.exe"], ["C:\\B\\python3.exe"],
    ]);
    assert.deepStrictEqual(pythonCandidates("win32", { Path: "C:\\A" }, () => [], (p) => have.has(p)).slice(3), [["C:\\A\\python.exe"]], "Path as Windows spells it");
  });

  it("a Store Python first on PATH no longer hides a good one further down", async () => {
    const have = new Set(["C:\\WA\\python.exe", "C:\\Good\\python.exe"]);
    const run = pythons({ python: STORE_EXE, "C:\\WA\\python.exe": STORE_EXE, "C:\\Good\\python.exe": "C:\\Good\\python.exe" });
    assert.deepStrictEqual(await searchPython(run, "win32", { PATH: "C:\\WA;C:\\Good" }, () => [], (p) => have.has(p)), { kind: "found", exe: "C:\\Good\\python.exe" });
  });

  it("an own launcher with an MSYS path is repaired too; one not in the launcher's own form is left alone", async () => {
    const dir = ownCopy("/usr/bin/python3");
    assert.ok(launcherNeedsRepair(dir, "win32"));
    assert.strictEqual(await repairLauncher(dir, pythons({ python: "/usr/bin/python3", python3: GOOD_EXE }), "win32", {}, () => []), "repaired");
    assert.strictEqual(fs.readFileSync(path.join(dir, "a4sx.cmd"), "utf8"), launcherText(GOOD_EXE, dir, "win32"));
    const custom = ownCopy(GOOD_EXE);
    fs.writeFileSync(path.join(custom, "a4sx.cmd"), "@echo off\r\nrem PythonSoftwareFoundation.Python.3.11 \\WindowsApps\\ my own\r\npython a4sx.py %*\r\n");
    assert.ok(!launcherNeedsRepair(custom, "win32"));
    assert.ok(!launcherNeedsRepair(dir, "linux"), "only the Windows launcher is checked");
  });

  it("one repair at a time: activation and an action share the search and the write", async () => {
    const dir = ownCopy(STORE_EXE);
    const tried: string[] = [];
    let repaired = 0;
    const h = harness({ cliDir: dir, platform: "win32", python: pythons({ python: GOOD_EXE }, tried) });
    h.deps.onRepaired = () => repaired++;
    const [a, b] = await Promise.all([repairOwnCli(h.deps), ownCliCheck(h.deps, installedLauncher(dir, "win32")!)]);
    assert.deepStrictEqual([a, b], [true, "ok"]);
    assert.strictEqual(tried.filter((f) => f === "python").length, 1, "one search");
    assert.strictEqual(repaired, 1);
    assert.strictEqual(await repairOnce(h.deps), "ok", "the next one starts fresh and finds nothing to do");
  });

  it("after an action-time repair, the CLI's version is asked again and the views read it again", async () => {
    const dir = ownCopy(STORE_EXE);
    const launcher = installedLauncher(dir, "win32")!;
    const state = fakeMemento({ [CONSENT_KEY]: [machineKey()] });
    let profiles = 0;
    const h = harness({ resolve: { kind: "found", path: launcher }, cliDir: dir, platform: "win32", state, python: pythons({ python: GOOD_EXE }) });
    h.deps.onRepaired = () => profiles++;
    await h.provider.getChildren();
    const versions = () => h.runs.filter((r) => r.args.join(" ") === "--version").length;
    assert.strictEqual(versions(), 1);
    assert.ok(await newCell(h.deps));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(versions(), 2, "the version cache was cleared and Cells read again");
    assert.strictEqual(profiles, 1, "Launch profiles read again");
  });

  it("a launcher that can't be rewritten: its error, nothing starts, the launcher stays", async () => {
    const dir = ownCopy(STORE_EXE);
    const before = fs.readFileSync(path.join(dir, "a4sx.cmd"), "utf8");
    const h = harness({ cliDir: dir, platform: "win32", python: pythons({ python: "C:\\100%\\python.exe" }) });
    assert.strictEqual(await ownCliCheck(h.deps, installedLauncher(dir, "win32")!), "stop");
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [PROVISION_TEXTS.unsafePath]);
    assert.strictEqual(fs.readFileSync(path.join(dir, "a4sx.cmd"), "utf8"), before);
  });

  it("the full Windows order: a4sx.cliPath, PATH, the installer's folder, then the extension's own copy", () => {
    const own = ownCopy(STORE_EXE);
    const onPath = tmpdir();
    const installer = tmpdir();
    const configured = path.join(tmpdir(), "a4sx.cmd");
    for (const f of [path.join(onPath, "a4sx.cmd"), path.join(installer, "a4sx.cmd"), configured]) {
      fs.writeFileSync(f, "@echo off\r\n");
    }
    // (the installer's folder is given here: on Windows it is %LOCALAPPDATA%\\Programs\\a4sx, which a Linux test can't join)
    const win = { platform: "win32" as const, pathExt: ".exe;.cmd", fallbackDirs: [installer] };
    assert.deepStrictEqual(ext.findCliOrOwn(configured, { ...win, pathEnv: onPath }, own), { found: true, path: configured });
    assert.deepStrictEqual(ext.findCliOrOwn("", { ...win, pathEnv: onPath }, own), { found: true, path: path.join(onPath, "a4sx.cmd") });
    assert.deepStrictEqual(ext.findCliOrOwn("", { ...win, pathEnv: "" }, own), { found: true, path: path.join(installer, "a4sx.cmd") });
    assert.deepStrictEqual(ext.findCliOrOwn("", { ...win, pathEnv: "", fallbackDirs: [] }, own), { found: true, path: path.join(own, "a4sx.cmd") });
    assert.deepStrictEqual(ext.findCliOrOwn("", { ...win, pathEnv: "", fallbackDirs: [] }, tmpdir()), { found: false, reason: "not-on-path" });
  });
});

describe("0.5.1 review: Resume in terminal with the own copy on a Store Python", () => {
  beforeEach(resetCalls);
  const session = new SessionItem({ id: "c-123", label: "my-base" });

  /** Activates with globalStorage in a temp folder, then makes the own copy's checks Windows ones. */
  async function activateOwn(python: CellCommandDeps["python"]): Promise<string> {
    const storage = tmpdir();
    ext.activate({ subscriptions: [], secrets: fakeSecrets(), globalState: fakeMemento(), globalStorageUri: vscodeFake.Uri.file(storage) } as any);
    await new Promise((r) => setImmediate(r));                 // the activation's own (POSIX) repair check is done
    const deps = ext.sidebar!.cellDeps;
    deps.platform = "win32";
    deps.python = python;
    fs.mkdirSync(path.join(storage, "cli"));
    fs.writeFileSync(path.join(storage, "cli", "a4sx.py"), "");
    writeLauncher(STORE_EXE, path.join(storage, "cli"), "win32");
    return installedLauncher(path.join(storage, "cli"), "win32")!;
  }

  it("inside an a4sx session the session stop comes first: no Python search, no offer", async () => {
    const tried: string[] = [];
    const launcher = await activateOwn(pythons({ python: STORE_EXE }, tried));
    const saved = process.env.A4SX_HARNESS;
    process.env.A4SX_HARNESS = "1";
    try {
      assert.strictEqual(await ext.resumeSession(session, () => ({ found: true, path: launcher }), async () => ({}), () => undefined), undefined);
    } finally {
      if (saved === undefined) {
        delete process.env.A4SX_HARNESS;
      } else {
        process.env.A4SX_HARNESS = saved;
      }
    }
    assert.deepStrictEqual(tried, []);
    assert.deepStrictEqual(calls.modals, []);
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [IN_SESSION_MESSAGE]);
  });

  it("only the Store Python, offer declined: as without a CLI (claude --resume); offer taken: stops there", async () => {
    const launcher = await activateOwn(pythons({ python: STORE_EXE }));
    let claudeLooked = 0;
    await ext.resumeSession(session, () => ({ found: true, path: launcher }), async () => ({}), () => { claudeLooked++; return undefined; });
    assert.deepStrictEqual(calls.modals.map((m) => m.message), [CELL_CMD_TEXTS.storePythonWin]);
    assert.strictEqual(claudeLooked, 1, "fell back to the CLI-free resume");
    assert.deepStrictEqual(calls.errors.map((e) => e.message), [RESUME_TEXTS.noClaude]);
    resetCalls();
    calls.modalChoices.push(CELL_CMD_TEXTS.installPython);
    claudeLooked = 0;
    assert.strictEqual(await ext.resumeSession(session, () => ({ found: true, path: launcher }), async () => ({}), () => { claudeLooked++; return undefined; }), undefined);
    assert.strictEqual(claudeLooked, 0);
    assert.deepStrictEqual(calls.terminals.map((t) => t.options.name), [CELL_CMD_TEXTS.pythonTerminal]);
  });

  it("Save this session with the own copy on a Store Python: repaired silently, then it runs", async () => {
    const launcher = await activateOwn(pythons({ python: GOOD_EXE }));
    const t = await ext.saveSession(() => ({ found: true, path: launcher }));
    assert.ok(t);
    assert.ok(!launcherNeedsRepair(path.dirname(launcher), "win32"));
    assert.deepStrictEqual(calls.modals, []);
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

/** The local cells under their mesh groups (0.5.0), in the CLI's order. */
async function items(h: Harness): Promise<LocalCellItem[]> {
  const out: LocalCellItem[] = [];
  for (const top of await h.provider.getChildren()) {
    if (top instanceof MeshGroupItem) {
      out.push(...((await h.provider.getChildren(top)).filter((i) => i instanceof LocalCellItem) as LocalCellItem[]));
    }
  }
  return out.sort((a, b) => h.provider.cells.indexOf(a.cell) - h.provider.cells.indexOf(b.cell));
}

describe("Cells view", () => {
  beforeEach(resetCalls);

  it("an older CLI's list: an update line, then the cells grouped by mesh (standalone last), default first; legacy contexts", async () => {
    const h = harness();
    const top = await h.provider.getChildren();
    assert.deepStrictEqual(h.runs, [{ cli: "/opt/a4sx bin/a4sx", args: ["--version"] }, { cli: "/opt/a4sx bin/a4sx", args: ["mesh", "cells", "--json"] }]);
    assert.deepStrictEqual(top.map((i) => [i.label, i.description, i.contextValue]), [
      [CELL_TEXTS.olderCli, undefined, undefined],
      ["Lab", "1 cell here", "a4sx.cellMesh"],
      ["Team mesh", "2 cells here", "a4sx.cellMesh"],
      [CELL_TEXTS.standaloneGroup, "1 cell here", "a4sx.cellMesh.standalone"],
    ]);
    assert.strictEqual(top[0].command?.command, "a4sx.updateCli");
    const team = await h.provider.getChildren(top[2]);
    assert.deepStrictEqual(team.map((i) => [i.label, i.description, i.contextValue]), [
      ["build", "default", "a4sx.localCell.default.legacy"],
      ["docs", "", "a4sx.localCell.legacy"],
    ]);
    assert.strictEqual(h.runs.length, 2, "no `mesh peers` for an older CLI");
    const list = await items(h);
    assert.deepStrictEqual(list.map((i) => [i.label, i.contextValue]), [
      ["build", "a4sx.localCell.default.legacy"], ["build", "a4sx.localCell.legacy"], ["spare", "a4sx.localCell.standalone.legacy"], ["docs", "a4sx.localCell.legacy"],
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
    assert.deepStrictEqual(e.states, [{ kind: "ok", cells: [], legacy: true }]);
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
    assert.deepStrictEqual(h.runs.map((r) => r.args.join(" ")), ["--version", "mesh cells --json", `mesh cell default build --mesh ${MESH2}`, "mesh cells --json"]);
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
    assert.strictEqual(h.runs.length, 2, "only the version and the list");
    calls.modalChoices.push(CELL_CMD_TEXTS.forget);
    assert.ok(await forgetCell(h.deps, list[3]));
    assert.deepStrictEqual(h.runs.map((r) => r.args.join(" ")).slice(2), ["mesh cell forget docs", "mesh cells --json"]);
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
    const python = async (_f: string, args: readonly string[]) => ({ code: 0, stdout: args.includes("-c") ? probeOut("/usr/bin/python3") : "" });
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
    const h2 = harness({ resolve: { kind: "no-cli" }, cliDir: dir, platform: "linux", fetch: bad, python: async () => ({ code: 0, stdout: probeOut("/usr/bin/python3") }) });
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
