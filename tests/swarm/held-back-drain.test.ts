import { describe, expect, it } from "vitest";
import { agentHeldBack, clearHeldCounts, noteHeldCounts, PULL_STALE_MS } from "../../src/swarm/coordinator/start-eta.js";
import { noteAgentPull } from "../../src/swarm/coordinator/dispatch.js";
import { coordinatorDrain } from "../../src/swarm/coordinator/drain.js";

/*
 * A planned drain (src/mesh/drain-failover.ts): agents stop pulling the draining coordinator on
 * purpose and take new work from a peer while they finish the calls they hold here. Their silence
 * here must not make them "held back" (#577), which would take those calls back and lose the result.
 */
describe("held back while draining", () => {
  it("an agent that stopped pulling for the drain keeps the calls it holds", async () => {
    const agent = "agent-drain-held";
    const old = Date.now() - PULL_STALE_MS - 5_000;
    noteAgentPull(agent, { inferenceSlots: 2, freeInferenceSlots: 1, wake: false }, old);
    clearHeldCounts();
    noteHeldCounts(old);
    expect(agentHeldBack(agent, 1, old)).toBe(false); // what it holds was last seen then
    // Before the drain: an idle slot and no pull for > PULL_STALE_MS is a held-back host.
    expect(agentHeldBack(agent, 1)).toBe(true);
    void coordinatorDrain.run({
      drainMs: 60_000,
      pollMs: 1_000,
      busy: () => ({ claims: 1, accruals: 0 }),
      settle: async () => 0,
      sockets: () => [],
      frameFor: () => "",
      close: async () => undefined,
      exit: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
      sleep: () => new Promise(() => undefined)
    });
    expect(coordinatorDrain.draining).toBe(true);
    expect(agentHeldBack(agent, 1)).toBe(false);
  });
});
