import { describe, expect, it } from "vitest";
import { describeJob } from "../../src/inference-api/job-descriptor.js";
import { bestFit, bestFitConfigFromEnv, DEFAULT_BEST_FIT_CONFIG, type NetworkView } from "../../src/swarm/coordinator/best-fit.js";
import { SIMPLE_QA, MULTI_FILE_REFACTOR } from "../helpers/job-fixtures.js";
import { agent, currentNetwork } from "./helpers/best-fit-network.js";

/*
 * The LAN proximity bonus in best fit (#311): a host on the requester's own LAN (measured by the
 * agents, any account) wins between near equals; a far better fit elsewhere still wins.
 */
// routing.ts imports the coordinator's context (it boots the app); its one pure helper is checked
// through best fit here, and the coordinator tests (lan-coordinator.test.ts) run withLanRtt live.
function withLan(view: NetworkView, lan: Record<string, number>): NetworkView {
  return { ...view, agents: view.agents.map((a) => (a.agentId in lan ? { ...a, lanRttMs: lan[a.agentId] } : a)) };
}

describe("best fit: LAN proximity bonus", () => {
  it("between two equal Macs, the one on the requester's LAN wins, and the reason says so", () => {
    const base: NetworkView = { ...currentNetwork(), agents: [
      agent({ agentId: "macA", computeClass: "apple", models: ["qwen2.5-coder:7b"], tokensPerSec: 22, contextWindow: 32_768 }),
      agent({ agentId: "macB", computeClass: "apple", models: ["qwen2.5-coder:7b"], tokensPerSec: 22, contextWindow: 32_768 }),
    ] };
    const job = describeJob(SIMPLE_QA, {});
    expect(bestFit(job, base).chosen?.agentId).toBe("macA"); // tie: first
    const r = bestFit(job, withLan(base, { macB: 1.2 }));
    expect(r.chosen?.agentId).toBe("macB");
    expect(r.chosen?.lanRttMs).toBe(1.2);
    expect(r.chosen!.score).toBeCloseTo(bestFit(job, base).chosen!.score + DEFAULT_BEST_FIT_CONFIG.lanBonus, 3);
  });

  it("it is a bonus, not a filter: a much better fit elsewhere still wins", () => {
    // A refactor wants the 30B coder; a 1.5b CPU agent next door does not take it.
    const r = bestFit(describeJob(MULTI_FILE_REFACTOR, {}), withLan(currentNetwork(), { cpu1: 0.8, cpu2: 0.9 }));
    expect(r.chosen?.model).toBe("qwen3-coder:30b");
    expect(r.chosen?.lanRttMs).toBeUndefined();
  });

  it("the bonus is set by BEST_FIT_LAN_BONUS (0 turns it off)", () => {
    expect(bestFitConfigFromEnv({}).lanBonus).toBe(0.05);
    expect(bestFitConfigFromEnv({ BEST_FIT_LAN_BONUS: "0.2" }).lanBonus).toBe(0.2);
    expect(bestFitConfigFromEnv({ BEST_FIT_LAN_BONUS: "7" }).lanBonus).toBe(0.05);
    const base: NetworkView = { ...currentNetwork(), agents: [
      agent({ agentId: "macA", computeClass: "apple", models: ["qwen2.5-coder:7b"], tokensPerSec: 22, contextWindow: 32_768 }),
      agent({ agentId: "macB", computeClass: "apple", models: ["qwen2.5-coder:7b"], tokensPerSec: 22, contextWindow: 32_768 }),
    ] };
    const off = bestFit(describeJob(SIMPLE_QA, {}), withLan(base, { macB: 1 }), { ...DEFAULT_BEST_FIT_CONFIG, lanBonus: 0 });
    expect(off.chosen?.agentId).toBe("macA");
  });
});
