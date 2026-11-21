/** #2301 E4: one sign-in. Without the extension's own, My sessions lists the library through the a4sx CLI's. */
import * as assert from "assert";
import { resetCalls } from "../fakeVscode";
import { CLI_LIBRARY_TEXTS, cliLibrary, cliSignedIn, LIST_ARGS, parseCliLibrary, WHOAMI_ARGS } from "../../cliLibrary";
import { SessionsProvider } from "../../sessionsView";

const ok = (doc: unknown) => ({ code: 0, stdout: JSON.stringify(doc), stderr: "" });
const LIST = { v: 1, signed_in: true, sessions: [
  { id: "col-lib-a", label: "work", title: "Work", tags: ["label:work"], folder: "work/a4sx", tokens: { current: 42000, peak: null },
    harness: "claude-code", versions: 3, version: "v0.0.3", updated_at: "2026-11-21T18:00:00Z", sessions: ["lib-abc123def456"],
    visibility: "private", untrusted: false, licence: null },
  { id: "../evil", title: "dropped" },
] };

describe("#2301 E4: the library through the a4sx CLI", () => {
  beforeEach(resetCalls);

  it("reads whoami and list --json; keeps only checked rows", () => {
    assert.strictEqual(cliSignedIn(ok({ v: 1, signed_in: true, valid: true })), true);
    assert.strictEqual(cliSignedIn(ok({ v: 1, signed_in: true, valid: null })), true, "unchecked: still try");
    assert.strictEqual(cliSignedIn(ok({ v: 1, signed_in: true, valid: false })), false, "a refused sign-in: no");
    assert.strictEqual(cliSignedIn(ok({ v: 1, signed_in: false })), false);
    assert.strictEqual(cliSignedIn({ code: 2, stdout: "", stderr: "invalid choice: 'whoami'" }), false);
    const rows = parseCliLibrary(ok(LIST))!;
    assert.deepStrictEqual(rows.map((r) => r.id), ["col-lib-a"]);
    assert.deepStrictEqual(rows[0], { id: "col-lib-a", label: "work", title: "Work", tags: ["label:work"], folder: "work/a4sx",
      updated_at: "2026-11-21T18:00:00Z", tokens: { current: 42000, peak: undefined }, harness: "claude-code", versions: 3,
      version: "v0.0.3", sessions: ["lib-abc123def456"] });
    assert.strictEqual(parseCliLibrary(ok({ v: 1, error: { code: "signin_required" } })), undefined);
  });

  it("asks whoami first, then lists; signed out (or no CLI) lists nothing", async () => {
    const runs: string[] = [];
    const run = async (_c: string, a: readonly string[]) => {
      runs.push(a.join(" "));
      return a.join(" ") === WHOAMI_ARGS.join(" ") ? ok({ v: 1, signed_in: true, valid: true }) : ok(LIST);
    };
    assert.strictEqual((await cliLibrary("/opt/a4sx", run))!.length, 1);
    assert.deepStrictEqual(runs, [WHOAMI_ARGS.join(" "), LIST_ARGS.join(" ")]);
    assert.strictEqual(await cliLibrary(undefined, run), undefined);
    const out = async () => ok({ v: 1, signed_in: false });
    assert.strictEqual(await cliLibrary("/opt/a4sx", out), undefined);
  });

  it("My sessions without the extension's sign-in: the CLI's rows, and the view says so", async () => {
    const auth = { token: async () => undefined, clear: async () => undefined } as any;
    const states: string[] = [];
    const p = new SessionsProvider(auth, () => ({}) as any, (s) => states.push(s), () => undefined, async () => parseCliLibrary(ok(LIST)));
    const view: { message?: string } = {};
    p.view = view;
    const items = await p.getChildren();
    assert.ok(items.length >= 1 && p.listedViaCli);
    assert.strictEqual(view.message, CLI_LIBRARY_TEXTS.via);
    assert.deepStrictEqual(states, ["signed-out"], "the extension's own sign-in is still absent (actions ask for it)");
    const empty = new SessionsProvider(auth, () => ({}) as any, () => undefined, () => undefined, async () => []);
    const e = await empty.getChildren();
    assert.deepStrictEqual(e.map((i) => i.label), [CLI_LIBRARY_TEXTS.empty]);
    const none = new SessionsProvider(auth, () => ({}) as any, () => undefined, () => undefined, async () => undefined);
    assert.deepStrictEqual(await none.getChildren(), [], "no CLI sign-in: the welcome text offers the sign-in");
  });
});
