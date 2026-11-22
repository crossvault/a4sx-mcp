/** a4sx CLI `ended_why`: an agent host whose terminal went away (VS Code closed with it) says so on This computer. */
import * as assert from "assert";
import { AGENT_HOST_TEXTS, parseAgentHostStatus } from "../../agentHostStatus";
import { thisComputerChildren } from "../../cellsView";

const stopped = (extra: Record<string, unknown>) => parseAgentHostStatus(JSON.stringify({ running: false, open: [], ...extra }))!;

describe("agent host ended when its terminal or VS Code was closed", () => {
  it("reads ended_why \"terminal closed\" while the host doesn't run, and shows it on the host row", () => {
    const s = stopped({ ended_why: "terminal closed", stopped_at: "2026-11-22T19:00:00Z" });
    assert.strictEqual(s.endedWhy, "terminal closed");
    assert.strictEqual(String(thisComputerChildren(s)[0].label), "agent host ended when its terminal or VS Code was closed");
    assert.strictEqual(AGENT_HOST_TEXTS.endedClosed, "agent host ended when its terminal or VS Code was closed");
  });

  it("a closed host whose stop Windows cut short (no stop time) isn't also called an unclean end", () => {
    const s = stopped({ ended_why: "terminal closed", started_at: "2026-11-22T18:00:00Z" });
    const labels = thisComputerChildren(s).map((i) => String(i.label));
    assert.strictEqual(labels[0], AGENT_HOST_TEXTS.endedClosed);
    assert.ok(!labels.includes(AGENT_HOST_TEXTS.uncleanEnd), labels.join(" | "));
    const old = thisComputerChildren(stopped({ started_at: "2026-11-22T18:00:00Z" })).map((i) => String(i.label));
    assert.ok(old.includes(AGENT_HOST_TEXTS.uncleanEnd), "without a reason: as before");
  });

  it("without a known reason (an older CLI, null, anything else) the old text stays", () => {
    for (const extra of [{}, { ended_why: null }, { ended_why: "crashed" }, { ended_why: 1 }]) {
      const s = stopped(extra);
      assert.strictEqual(s.endedWhy, undefined, JSON.stringify(extra));
      assert.strictEqual(String(thisComputerChildren(s)[0].label), AGENT_HOST_TEXTS.stopped);
    }
  });

  it("a running host never shows it", () => {
    const s = parseAgentHostStatus(JSON.stringify({ running: true, address: "ws://127.0.0.1:8765/", open: [], ended_why: "terminal closed" }))!;
    assert.strictEqual(s.endedWhy, undefined);
    assert.match(String(thisComputerChildren(s)[0].label), /^agent host running/);
  });
});
