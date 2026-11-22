/**
 * #2309 (cell01, during a deploy): My sessions and Launch profiles kept "a4sx is busy right now…" for minutes, and
 * Cells kept "Could not read the cells on other machines": no retry. A busy answer is read again by itself, by the
 * server's Retry-After or a growing wait, and the message goes once a read works.
 */
import * as assert from "assert";
import * as api from "../../api";
import { BUSY_BACKOFF_MS, BusyRetry } from "../../busyRetry";
import { SessionsProvider } from "../../sessionsView";
import { CellsProvider, CliOutput } from "../../cellsView";

const BASE = "https://session-exchange.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("#2309: busy answers are read again by themselves", () => {
  it("BusyRetry: the growing waits, Retry-After first, settled stops it, a cap gives up", async () => {
    assert.deepStrictEqual(BUSY_BACKOFF_MS, [5_000, 10_000, 20_000, 40_000, 60_000]);
    let n = 0;
    const r = new BusyRetry(() => { n++; }, [5, 10], 3);
    r.busy();
    assert.ok(r.pending);
    await sleep(20);
    assert.strictEqual(n, 1);
    r.busy();
    r.busy();   // a second busy answer before the timer: one timer, not two
    await sleep(30);
    assert.strictEqual(n, 2);
    r.busy();   // the 4th: over the cap of 3, given up
    assert.ok(!r.pending);
    r.settled();
    r.busy(1_500);   // Retry-After 1.5 s wins over the 5 ms step
    await sleep(30);
    assert.strictEqual(n, 2, "waits for Retry-After");
    r.settled();
    assert.ok(!r.pending, "a good read stops it");
    r.dispose();
  });

  it("Retry-After: seconds or an HTTP date, capped at 5 minutes; garbage is none", () => {
    const now = Date.parse("2026-11-22T06:00:00Z");
    assert.strictEqual(api.retryAfterToMs("30", now), 30_000);
    assert.strictEqual(api.retryAfterToMs("Sun, 22 Nov 2026 06:01:00 GMT", now), 60_000);
    assert.strictEqual(api.retryAfterToMs("99999", now), 300_000);
    assert.strictEqual(api.retryAfterToMs("soon", now), undefined);
    assert.strictEqual(api.retryAfterToMs(undefined, now), undefined);
  });

  it("My sessions: a 503 is a busy error with the server's Retry-After, and the view retries until a read works", async () => {
    let calls = 0;
    const fetch: api.FetchLike = async () => {
      calls++;
      return calls === 1
        ? { status: 503, headers: { get: (h: string) => (h === "retry-after" ? "2" : null) }, json: async () => ({}) } as any
        : { status: 200, json: async () => ({ sessions: [{ id: "col-1" }] }) };
    };
    const client: api.Client = { base: BASE, fetch, userAgent: "a4sx-vscode" };
    await assert.rejects(api.listSessions(client, "tok"), (e: any) => e.code === "busy" && e.retryAfterMs === 2_000);
    calls = 0;
    const p = new SessionsProvider({ token: async () => "tok", clear: async () => undefined }, () => client, () => undefined);
    const first = await p.getChildren();
    assert.ok(String(first[0]?.label).includes("busy"));
    assert.ok(p.busy.pending, "a retry is planned");
    await p.getChildren();   // what the retry's refresh does
    assert.ok(!p.busy.pending, "the read worked: no more retries");
    p.dispose();
  });

  it("Cells: a failed read of the other machines' cells is read again, and not kept until a Refresh", async () => {
    const MESH = "msh_0123456789abcdef0123456789abcdef";
    let fails = true;
    const run = async (_c: string, args: readonly string[]): Promise<CliOutput> => (args[0] === "mesh" && args[1] === "peers"
      ? (fails ? { code: 1, stdout: "", stderr: "a4sx: the server is busy\n" }
        : { code: 0, stdout: JSON.stringify({ v: 1, mesh_id: MESH, peers: [] }), stderr: "" })
      : { code: 0, stdout: "", stderr: "" });
    const p = new CellsProvider({ resolve: () => ({ kind: "found", path: "/x/a4sx" }), run, server: () => BASE, onState: () => undefined });
    assert.strictEqual((await (p as any).peersOf(MESH)).kind, "error");
    assert.ok(p.peersRetry.pending, "a retry is planned");
    assert.ok(!(p as any).peers.has(MESH), "the failure isn't kept");
    fails = false;
    assert.strictEqual((await (p as any).peersOf(MESH)).kind, "ok");
    assert.ok(!p.peersRetry.pending);
    p.dispose();
  });
});
