import { describe, expect, it } from "vitest";
import { describeJob } from "../../src/inference-api/job-descriptor.js";
import { bestFit, complexityClassOf, routedLine, spillFloorB, requirementsFor, type AgentView, type NetworkView } from "../../src/swarm/coordinator/best-fit.js";
import { MULTI_FILE_REFACTOR, SIMPLE_QA, TOOLS } from "../helpers/job-fixtures.js";
import { agent } from "./helpers/best-fit-network.js";

/*
 * Network test run 2 (2026-11-24), B5 and complexity routing: Auto kept every call on the 2-slot Mac
 * with qwen2.5-coder:7b under load while the CPU fleet sat at <=25% and 82 calls timed out. Auto now
 * weighs free capacity across the whole pool (expand: spill within the call's complexity band as the
 * preferred models fill; contract: back once they have room), and sorts calls into simple /
 * standard / complex, sending complex ones to the GPU 30B or cloud models.
 */

const FLASH = "deepseek-v4.1-flash";
const GLM = "glm-5.3";

interface PoolOpts {
  mac7Free?: number;
  mac9Free?: number;
  gpuFree?: number;
  cloudUnhealthy?: boolean;
  noGpu?: boolean;
  waiting?: Record<string, number>;
}

/** Run 2's pool, plus Patrick's GPU host: 7 CPU 1.5b (Fly), a 2-slot Mac 7b, a 2-slot Mac 9b, the cloud host, a GPU 30b. */
function mixedPool(o: PoolOpts = {}): NetworkView {
  const cpus = ["iad", "lax", "sin", "gru", "jnb", "nrt", "syd"].map((r) => agent({ agentId: `ec-${r}`, computeClass: "cpu", models: ["qwen2.5-coder:1.5b"], slots: 2, freeSlots: 2, contextWindow: 8_192, tokensPerSec: 18 }));
  const agents: AgentView[] = [
    ...cpus,
    agent({ agentId: "mac-maw", computeClass: "apple", models: ["qwen2.5-coder:7b", "qwen2.5-coder:1.5b"], slots: 2, freeSlots: o.mac7Free ?? 2, contextWindow: 32_768, tokensPerSec: 25 }),
    agent({ agentId: "mac-crs", computeClass: "apple", models: ["qwen3.5:9b"], slots: 2, freeSlots: o.mac9Free ?? 2, contextWindow: 32_768, tokensPerSec: 20 }),
    agent({ agentId: "cloud-fireworks-1", computeClass: "cloud", models: [GLM, FLASH], slots: 16, freeSlots: o.cloudUnhealthy ? 0 : 16, contextWindow: 1_000_000, rttMs: 30, ...(o.cloudUnhealthy ? { unhealthy: true } : {}) }),
    ...(o.noGpu ? [] : [agent({ agentId: "amd-5700xt", computeClass: "gpu", models: ["qwen3-coder:30b"], slots: 1, freeSlots: o.gpuFree ?? 1, contextWindow: 32_768, tokensPerSec: 40, tierWeight: 2 })]),
  ];
  return { agents, pickupP50Ms: 250, waitingByModel: o.waiting ?? {}, btcUsd: 100_000 };
}

const chat = () => describeJob(SIMPLE_QA, {});
/** Run 2's agentic loadgen turn: 4 tools, ~140 code lines, ~2.5k tokens; complexity estimate 0.20. */
const agenticTurn = () => {
  const code = Array.from({ length: 140 }, (_, i) => `const v${i} = compute(${i});`).join("\n");
  return describeJob({ messages: [{ role: "user", content: `Refactor this helper so it is shorter.\n${code}` }], tools: TOOLS }, {});
};
const where = (r: ReturnType<typeof bestFit>) => `${r.chosen?.model}@${r.chosen?.computeClass}`;
const BIG = new Set(["qwen3-coder:30b@gpu", `${FLASH}@cloud`, `${GLM}@cloud`]);

describe("complexity classes", () => {
  it("a short question is simple; a multi-file refactor and an agentic tool-use turn over code are complex", () => {
    expect(complexityClassOf(chat()).cls).toBe("simple");
    expect(complexityClassOf(describeJob(MULTI_FILE_REFACTOR, {})).cls).toBe("complex");
    const turn = agenticTurn();
    expect(turn.complexity.score).toBeLessThan(0.5);
    expect(complexityClassOf(turn)).toEqual({ cls: "complex", why: "agentic tool-use turn" });
    // A complex call wants at least 14B (the GPU 30B or cloud tier).
    expect(requirementsFor(turn).minParamsB).toBeGreaterThanOrEqual(14);
  });

  it("long context and a large reply make non-light work complex; light work never is", () => {
    const long = describeJob({ messages: [{ role: "user", content: `Explain this code.\n${"let x = 1;\n".repeat(6_000)}` }] }, {});
    expect(long.contextTokens).toBeGreaterThanOrEqual(16_000);
    expect(complexityClassOf(long).cls).toBe("complex");
    expect(complexityClassOf(describeJob({ ...SIMPLE_QA, maxTokens: 12_000 }, {})).why).toMatch(/large reply/);
    expect(complexityClassOf(describeJob(SIMPLE_QA, { job: "classify", complexity: "very_high" })).cls).toBe("standard");
  });

  it("the spill band: simple to 1.5B, standard to half its floor (>= 3B), complex not below its floor", () => {
    const simple = chat();
    expect(spillFloorB(simple, requirementsFor(simple))).toBe(1.5);
    const std = describeJob(SIMPLE_QA, { job: "code_edit", complexity: "medium" });
    expect(complexityClassOf(std).cls).toBe("standard");
    expect(spillFloorB(std, requirementsFor(std))).toBe(3.5);
    const turn = agenticTurn();
    expect(spillFloorB(turn, requirementsFor(turn))).toBe(requirementsFor(turn).minParamsB);
  });
});

describe("Auto weighs free capacity across the pool (B5)", () => {
  it("idle: a simple call stays on a small network model, not the cloud or the GPU 30B", () => {
    const r = bestFit(chat(), mixedPool());
    expect(["qwen2.5-coder:7b@apple", "qwen3.5:9b@apple"]).toContain(where(r));
    expect(r.complexityClass).toBe("simple");
    expect(r.capacity).toBe("preferred");
  });

  it("expand: with both Macs full the call goes to free capacity elsewhere in the pool, never queued behind them", () => {
    const r = bestFit(chat(), mixedPool({ mac7Free: 0, mac9Free: 0 }));
    expect(r.chosen?.agentId).not.toMatch(/^mac-/);
    expect(r.chosen?.estimate.waitMs).toBeLessThan(1_000);
    // The full Macs are still listed, after the free candidates.
    const firstBusy = r.candidates.findIndex((c) => c.agentId.startsWith("mac-"));
    expect(firstBusy).toBeGreaterThan(0);
  });

  it("a burst placed on the Mac fills it before anyone pulls: queued calls count against its slots", () => {
    const r = bestFit(chat(), mixedPool({ mac9Free: 0, waiting: { "qwen2.5-coder:7b": 3 } }));
    expect(r.chosen?.model).not.toBe("qwen2.5-coder:7b");
  });

  it("the cloud host is one more machine in the pool: a simple call spills there when the network's preferred models are full", () => {
    const r = bestFit(chat(), mixedPool({ mac7Free: 0, mac9Free: 0, gpuFree: 0 }));
    expect(r.chosen?.computeClass).toBe("cloud");
    expect(r.chosen?.model).toBe(FLASH);
  });

  it("with the cloud host not taking work (circuit open), a simple call spills down to a free 1.5B CPU host and says so", () => {
    const r = bestFit(chat(), mixedPool({ mac7Free: 0, mac9Free: 0, gpuFree: 0, cloudUnhealthy: true }));
    expect(where(r)).toBe("qwen2.5-coder:1.5b@cpu");
    expect(r.chosen?.spill).toBe(true);
    expect(r.capacity).toBe("spill");
    expect(r.reason).toMatch(/spilled: every model ≥ 3B is full; simple band ≥ 1.5B/);
    expect(routedLine(r)).toMatch(/^routed to qwen2.5-coder:1.5b on cpu because/);
  });

  it("contract: once the Mac has a free slot again, calls go back to it", () => {
    expect(bestFit(chat(), mixedPool({ mac7Free: 0, mac9Free: 0, gpuFree: 0, cloudUnhealthy: true })).chosen?.computeClass).toBe("cpu");
    const back = bestFit(chat(), mixedPool({ mac7Free: 1, mac9Free: 0, gpuFree: 0, cloudUnhealthy: true }));
    expect(where(back)).toBe("qwen2.5-coder:7b@apple");
    expect(back.capacity).toBe("preferred");
    expect(back.chosen?.spill).toBeFalsy();
  });

  it("an unhealthy host is not chosen while a healthy one fits, even with free slots reported", () => {
    const view = mixedPool({ mac7Free: 0, mac9Free: 0, gpuFree: 0 });
    view.agents.find((a) => a.agentId === "cloud-fireworks-1")!.unhealthy = true;
    view.agents.find((a) => a.agentId === "cloud-fireworks-1")!.freeSlots = 16;
    expect(bestFit(chat(), view).chosen?.computeClass).not.toBe("cloud");
  });
});

describe("complex calls go to the GPU 30B or cloud tier", () => {
  it("a multi-file refactor and an agentic turn go to a big model, never a CPU or a Mac, while one is free", () => {
    for (const job of [describeJob(MULTI_FILE_REFACTOR, {}), agenticTurn()]) {
      const r = bestFit(job, mixedPool());
      expect(BIG.has(where(r)), `${job.job}: ${where(r)}`).toBe(true);
      expect(r.complexityClass).toBe("complex");
    }
  });

  it("the GPU 30B full: the agentic turn expands to the cloud host", () => {
    const r = bestFit(agenticTurn(), mixedPool({ gpuFree: 0 }));
    expect(r.chosen?.computeClass).toBe("cloud");
  });

  it("no GPU and the cloud host down: the biggest available model, and the decision says it is below the floor", () => {
    const r = bestFit(agenticTurn(), mixedPool({ noGpu: true, cloudUnhealthy: true }));
    expect(r.chosen?.model).toBe("qwen3.5:9b");
    expect(r.chosen?.belowFloor).toBe(true);
    expect(r.reason).toMatch(/nothing ≥ 14B is available; complex call \(agentic tool-use turn\) on a smaller model/);
    // Never silently down to a 1.5B CPU model.
    expect(r.candidates.some((c) => c.computeClass === "cpu")).toBe(false);
  });

  it("does not spill a complex call down to a small free model while the big ones are full", () => {
    const r = bestFit(agenticTurn(), mixedPool({ gpuFree: 0, cloudUnhealthy: true }));
    expect(r.chosen?.model).toBe("qwen3-coder:30b");
    expect(r.capacity).toBe("queued");
  });
});
