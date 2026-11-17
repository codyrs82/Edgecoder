import { describe, expect, it } from "vitest";
import { callsTools, FALLBACK_NOTE, planRoutes, routeFromModelId, routeLabel } from "../../src/inference-api/auto-route.js";
import { DEFAULT_QUALITY_FLOOR, fitScore, paramsB, qualityFloorFromEnv, rankRoutes, routeModelId, sizeWorkload, type RouteInputs } from "../../src/inference-api/auto-route.js";

const light = sizeWorkload({ messages: [{ role: "user", content: "what does git rebase do?" }] }, DEFAULT_QUALITY_FLOOR);
const heavy = sizeWorkload({ messages: [{ role: "user", content: "fix the bug" }], tools: [{ type: "function", function: { name: "Edit" } }] }, DEFAULT_QUALITY_FLOOR);
/** The pre-floor behaviour (any model from 1B for chat), for the tests that are about placement, not size. */
const lightNoFloor = sizeWorkload({ messages: [{ role: "user", content: "what does git rebase do?" }] }, { chatB: 1, codingB: 6 });

const prices = { cpu: 0.009, apple: 0.052, gpu: 0.043, "gpu.dc": 0.304 };
const base: RouteInputs = { localModels: [], myModels: [], leases: [], networkModels: [], classPrice: prices };

describe("auto routing", () => {
  it("sizes the job: tools or a long prompt is agent work", () => {
    expect(light.heavy).toBe(false);
    expect(heavy.heavy).toBe(true);
    expect(sizeWorkload({ messages: [{ role: "user", content: "x".repeat(30_000) }] }).heavy).toBe(true);
  });

  it("reads model sizes from tags", () => {
    expect(paramsB("qwen2.5-coder:1.5b")).toBe(1.5);
    expect(paramsB("qwen3-coder:30b")).toBe(30);
    expect(paramsB("qwen2.5-coder:latest")).toBe(7);
    // A tag without a size: the catalog's total parameter count, not the 7B default.
    expect(paramsB("qwen3-coder-next:latest")).toBe(80);
    expect(paramsB("qwen3-coder-next")).toBe(80);
  });

  it("uses the smallest model that meets the floor for quick tasks and capable coders for agent work", () => {
    expect(fitScore("qwen2.5-coder:0.5b", lightNoFloor)).toBe(-1);
    expect(fitScore("qwen2.5-coder:1.5b", lightNoFloor)).toBeGreaterThan(fitScore("qwen3.5:9b", lightNoFloor));
    // The default floor: a 1.5B or 3B model never answers a chat question on Auto.
    expect(fitScore("qwen2.5-coder:1.5b", light)).toBe(-1);
    expect(fitScore("llama3.2:3b", light)).toBe(-1);
    expect(fitScore("qwen2.5-coder:7b", light)).toBeGreaterThan(fitScore("qwen3.5:9b", light));
    expect(fitScore("qwen2.5-coder:1.5b", heavy)).toBe(-1);
    expect(fitScore("qwen2.5-coder:14b", heavy)).toBeGreaterThan(fitScore("qwen3.5:9b", heavy));
    expect(fitScore("nomic-embed-text", light)).toBe(-1);
  });

  it("prefers prepaid, then free, then the cheapest network class for the job", () => {
    const routes = rankRoutes(heavy, {
      ...base,
      leases: [{ id: "r1", computeClass: "gpu", models: ["qwen2.5-coder:14b"] }],
      localModels: ["qwen3.5:9b"],
      myModels: ["qwen2.5-coder:7b"],
      networkModels: [{ model: "qwen2.5-coder:14b", classes: ["cpu", "apple", "gpu", "gpu.dc"] }],
    });
    expect(routes.map((r) => r.placement)).toEqual(["reserved", "local", "mine", "network", "network", "network"]);
    // Per-token prices are the same on every class, so the fastest comes first; CPU is skipped for agent work.
    expect(routes.filter((r) => r.placement === "network").map((r) => r.computeClass)).toEqual(["gpu.dc", "gpu", "apple"]);
    expect(routeModelId(routes[0])).toBe("reserved/r1/qwen2.5-coder:14b");
  });

  it("sends a quick task to the network when nothing free fits, CPU allowed after faster classes", () => {
    const routes = rankRoutes(lightNoFloor, { ...base, localModels: ["qwen2.5-coder:0.5b"], networkModels: [{ model: "qwen2.5-coder:1.5b", classes: ["cpu", "gpu"] }] });
    expect(routes.map((r) => `${r.placement}:${r.computeClass ?? ""}`)).toEqual(["network:gpu", "network:cpu"]);
    expect(routeModelId(routes[0])).toBe("network/qwen2.5-coder:1.5b@gpu");
  });

  it("returns nothing when no model anywhere fits", () => {
    expect(rankRoutes(heavy, { ...base, localModels: ["qwen2.5-coder:1.5b"] })).toEqual([]);
  });
});

describe("Auto quality floor", () => {
  const explain = (floor = DEFAULT_QUALITY_FLOOR) => sizeWorkload({ messages: [{ role: "user", content: "Explain how this code works" }] }, floor);

  it("a chat question skips tiny models and takes the cheapest model that meets the floor", () => {
    const inp: RouteInputs = { ...base, localModels: ["qwen2.5-coder:1.5b", "llama3.2:3b", "qwen2.5-coder:7b", "qwen2.5-coder:14b"] };
    expect(explain().minParamsB).toBe(7);
    expect(rankRoutes(explain(), inp)[0]).toMatchObject({ placement: "local", model: "qwen2.5-coder:7b" });
  });

  it("free still beats paid among models that meet the floor; a tiny free model loses to a fitting network one", () => {
    const net = [{ model: "qwen2.5-coder:7b", classes: ["gpu"], cSatsPerMTokens: { input: 100, output: 400 } }];
    expect(planRoutes(explain(), { ...base, balanceCSats: 100, localModels: ["qwen3.5:9b"], networkModels: net }, "auto")[0].placement).toBe("local");
    const routes = planRoutes(explain(), { ...base, balanceCSats: 100, localModels: ["qwen2.5-coder:1.5b"], networkModels: net }, "auto");
    expect(routes.map((r) => `${r.placement}:${r.model}${r.fallback ? ":fallback" : ""}`)).toEqual(["network:qwen2.5-coder:7b", "local:qwen2.5-coder:1.5b:fallback"]);
  });

  it("with nothing that meets the floor, the biggest free model still answers (marked as a fallback)", () => {
    const routes = planRoutes(explain(), { ...base, localModels: ["qwen2.5-coder:1.5b", "llama3.2:3b"] }, "auto");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ placement: "local", model: "llama3.2:3b", fallback: true });
  });

  it("is configurable per caller and from the environment", () => {
    const inp: RouteInputs = { ...base, localModels: ["llama3.2:3b", "qwen2.5-coder:14b"] };
    expect(rankRoutes(explain({ chatB: 3, codingB: 7 }), inp)[0].model).toBe("llama3.2:3b");
    expect(rankRoutes(explain({ chatB: 13, codingB: 13 }), inp)[0].model).toBe("qwen2.5-coder:14b");
    expect(qualityFloorFromEnv({})).toEqual(DEFAULT_QUALITY_FLOOR);
    expect(qualityFloorFromEnv({ EDGECODER_AUTO_MIN_CHAT_B: "3", EDGECODER_AUTO_MIN_CODING_B: "14" })).toEqual({ chatB: 3, codingB: 14 });
    expect(qualityFloorFromEnv({ EDGECODER_AUTO_MIN_CHAT_B: "lots", EDGECODER_AUTO_MIN_CODING_B: "" })).toEqual(DEFAULT_QUALITY_FLOOR);
  });

  it("an explicit model choice is untouched by the floor", () => {
    expect(planRoutes(explain(), { ...base, localModels: ["qwen2.5-coder:7b"] }, "model", { model: "qwen2.5-coder:1.5b" })).toEqual([
      expect.objectContaining({ placement: "local", model: "qwen2.5-coder:1.5b" }),
    ]);
    expect(planRoutes(explain(), { ...base }, "model", { model: "qwen2.5-coder:1.5b" })[0].fallback).toBeUndefined();
  });
});

import { autoBackend } from "../../src/inference-api/backends.js";
import { ChatBackendError, type ChatBackend, type ChatPiece } from "../../src/inference-api/types.js";

describe("auto backend", () => {
  const inputs = async (): Promise<RouteInputs> => ({ ...base, localModels: ["qwen2.5-coder:7b"], networkModels: [{ model: "qwen2.5-coder:7b", classes: ["gpu"] }] });
  const collect = async (b: ChatBackend) => {
    const out: ChatPiece[] = [];
    for await (const p of b({ messages: [{ role: "user", content: "hi" }] })) out.push(p);
    return out;
  };

  it("falls through to the next place when one can't start, and says where it ran", async () => {
    const tried: string[] = [];
    const b = autoBackend({
      inputs,
      run: (r) =>
        async function* () {
          tried.push(r.placement);
          if (r.placement === "local") throw new ChatBackendError("Ollama isn't running", 503);
          yield { delta: "ok" };
          yield { done: true, cSatsSpent: 0.1 };
        },
    });
    const out = await collect(b);
    expect(tried).toEqual(["local", "network"]);
    expect(out[1]).toMatchObject({ done: true, cSatsSpent: 0.1, where: expect.stringContaining("network gpu") });
  });

  it("explains when no model fits anywhere", async () => {
    const b = autoBackend({ inputs: async () => base, run: () => async function* () {} });
    await expect(collect(b)).rejects.toThrow(/No model fits this request/);
  });
});

describe("compute policies", () => {
  const net = [{ model: "qwen2.5-coder:14b", classes: ["gpu"], cSatsPerMTokens: { input: 100, output: 400 } }];
  const harry: RouteInputs = { ...base, localModels: ["qwen2.5-coder:1.5b"], networkModels: net };
  const where = (rs: ReturnType<typeof planRoutes>) => rs.map((r) => `${r.placement}:${r.model}${r.fallback ? ":fallback" : ""}`);

  it("Harry's case: heavy work, only a 1.5B locally and 0 cSats falls back to the small local model", () => {
    const routes = planRoutes(heavy, { ...harry, balanceCSats: 0 }, "auto");
    expect(where(routes)).toEqual(["local:qwen2.5-coder:1.5b:fallback"]);
    expect(routes[0].reason).toContain(FALLBACK_NOTE);
    expect(where(planRoutes(heavy, { ...harry, balanceCSats: 0 }, "local_first"))).toEqual(["local:qwen2.5-coder:1.5b:fallback"]);
  });

  it("with cSats, the network comes before the small fallback; the fallback stays last", () => {
    expect(where(planRoutes(heavy, { ...harry, balanceCSats: 500 }, "auto"))).toEqual(["network:qwen2.5-coder:14b", "local:qwen2.5-coder:1.5b:fallback"]);
  });

  it("caps the network at the budget left: a spent or too-small budget skips it", () => {
    expect(where(planRoutes(heavy, { ...harry, balanceCSats: 500 }, "local_first", { allowanceCSats: 0 }))).toEqual(["local:qwen2.5-coder:1.5b:fallback"]);
    // The call could set aside ~0.8 cSats (2,048 output tokens at 400/M); 0.1 left isn't enough.
    expect(where(planRoutes(heavy, { ...harry, balanceCSats: 500 }, "local_first", { allowanceCSats: 0.1 }))).toEqual(["local:qwen2.5-coder:1.5b:fallback"]);
    expect(where(planRoutes(heavy, { ...harry, balanceCSats: 500 }, "local_first", { allowanceCSats: 5 }))[0]).toBe("network:qwen2.5-coder:14b");
    // The balance caps it too, even with no budget limit.
    expect(where(planRoutes(heavy, { ...harry, balanceCSats: 0.2 }, "auto"))).toEqual(["local:qwen2.5-coder:1.5b:fallback"]);
  });

  it("Local first: this computer, your machines, a reservation, then the network", () => {
    const inp: RouteInputs = { ...base, balanceCSats: 100, localModels: ["qwen3.5:9b"], myModels: ["qwen2.5-coder:7b"], leases: [{ id: "r1", computeClass: "gpu", models: ["qwen2.5-coder:14b"] }], networkModels: net };
    expect(planRoutes(heavy, inp, "local_first").map((r) => r.placement)).toEqual(["local", "mine", "reserved", "network"]);
    expect(planRoutes(heavy, inp, "auto").map((r) => r.placement)).toEqual(["reserved", "local", "mine", "network"]);
  });

  it("a bot's agent floor (agentMinParamsB) puts a capable model ahead of a 7B on this computer; the 7B stays the last resort", () => {
    const inp: RouteInputs = { ...base, balanceCSats: 100, localModels: ["qwen2.5-coder:7b"], networkModels: [...net, { model: "qwen3-coder:30b", classes: ["gpu"], cSatsPerMTokens: { input: 100, output: 400 } }] };
    // Without it, the free 7B wins.
    expect(where(planRoutes(heavy, inp, "local_first"))[0]).toBe("local:qwen2.5-coder:7b");
    for (const policy of ["local_first", "auto"] as const) {
      const routes = where(planRoutes(heavy, inp, policy, { agentMinParamsB: 14, allowanceCSats: 50 }));
      expect(routes[0]).toMatch(/^network:/);
      expect(routes.at(-1)).toBe("local:qwen2.5-coder:7b:fallback");
    }
    // A capable free model still comes first.
    expect(where(planRoutes(heavy, { ...inp, myModels: ["qwen2.5-coder:14b"] }, "local_first", { agentMinParamsB: 14 }))[0]).toBe("mine:qwen2.5-coder:14b");
    // Budget spent: the 7B on this computer does it (its text tool calls still run).
    expect(where(planRoutes(heavy, inp, "local_first", { agentMinParamsB: 14, allowanceCSats: 0 }))).toEqual(["local:qwen2.5-coder:7b:fallback"]);
    // Light work and "This computer only" are unaffected.
    expect(where(planRoutes({ ...heavy, heavy: false, needsTools: false, minParamsB: 7 }, inp, "local_first", { agentMinParamsB: 14 }))[0]).toBe("local:qwen2.5-coder:7b");
    expect(where(planRoutes(heavy, inp, "local_only", { agentMinParamsB: 14 }))).toEqual(["local:qwen2.5-coder:7b"]);
  });

  it("a bot's agent step on the 7B fallback says why the bigger model wasn't used (balance 0, no network model that size)", () => {
    // Harry's case: Auto, 0 cSats, the network's biggest model is 9B; the bot's 7B ran with no reason given.
    const inp: RouteInputs = { ...base, balanceCSats: 0, localModels: ["qwen2.5-coder:7b"], networkModels: net };
    const [r] = planRoutes(heavy, inp, "auto", { agentMinParamsB: 14, allowanceCSats: 100 });
    expect(r).toMatchObject({ model: "qwen2.5-coder:7b", fallback: true });
    expect(r.why).toBe("agent work wants ≥14B; this computer has ≤7B; a larger model wasn't available (balance 0)");
    const [spent] = planRoutes(heavy, { ...inp, balanceCSats: 500 }, "auto", { agentMinParamsB: 14, allowanceCSats: 0 });
    expect(spent.why).toMatch(/a larger model wasn't available \((today's budget is spent|no network model that size)\)$/);
  });

  it("This computer only never uses the network or your other machines", () => {
    const inp: RouteInputs = { ...harry, balanceCSats: 1_000, myModels: ["qwen2.5-coder:14b"] };
    expect(where(planRoutes(heavy, inp, "local_only"))).toEqual(["local:qwen2.5-coder:1.5b:fallback"]);
    expect(planRoutes(heavy, { ...inp, localModels: [] }, "local_only")).toEqual([]);
    expect(planRoutes(light, inp, "local_only").every((r) => r.placement === "local")).toBe(true);
  });

  it("My machines only: this computer and your machines, free, never the network", () => {
    const inp: RouteInputs = { ...base, balanceCSats: 1_000, localModels: ["qwen2.5-coder:1.5b"], myModels: ["qwen2.5-coder:7b"], networkModels: net };
    expect(where(planRoutes(heavy, inp, "mine_only"))).toEqual(["mine:qwen2.5-coder:7b"]);
    expect(where(planRoutes(heavy, { ...inp, myModels: [] }, "mine_only"))).toEqual(["local:qwen2.5-coder:1.5b:fallback"]);
  });

  it("A specific model runs only there; a network model needs the cSats", () => {
    expect(where(planRoutes(heavy, harry, "model", { model: "qwen2.5-coder:1.5b" }))).toEqual(["local:qwen2.5-coder:1.5b"]);
    expect(planRoutes(heavy, { ...harry, balanceCSats: 50 }, "model", { model: "network/qwen2.5-coder:14b@gpu" })[0]).toMatchObject({ placement: "network", computeClass: "gpu" });
    expect(planRoutes(heavy, { ...harry, balanceCSats: 0 }, "model", { model: "network/qwen2.5-coder:14b@gpu" })).toEqual([]);
    expect(planRoutes(heavy, { ...harry, balanceCSats: 50 }, "model", { model: "network/qwen2.5-coder:14b", allowanceCSats: 0 })).toEqual([]);
  });

  it("reads model ids back into routes and labels where they ran", () => {
    expect(routeFromModelId("mine/qwen3.5:9b")).toMatchObject({ placement: "mine", model: "qwen3.5:9b" });
    expect(routeFromModelId("reserved/r1/qwen3.5:9b")).toMatchObject({ placement: "reserved", reservationId: "r1", model: "qwen3.5:9b" });
    expect(routeFromModelId("network/qwen3.5:9b")).toMatchObject({ placement: "network", model: "qwen3.5:9b", computeClass: "any" });
    expect(routeFromModelId("network/qwen3.5:9b@gpu.dc")).toMatchObject({ model: "qwen3.5:9b", computeClass: "gpu.dc" });
    expect(routeLabel(routeFromModelId("qwen2.5-coder:1.5b")!)).toBe("This computer · qwen2.5-coder:1.5b");
    expect(routeLabel(routeFromModelId("network/qwen3.5:9b@gpu")!)).toBe("Network GPU · qwen3.5:9b");
  });

  it("agent work skips local catalog models without tool calling; unknown models keep today's behaviour", () => {
    expect(callsTools("deepseek-r1:70b")).toBe(false);
    expect(callsTools("qwen2.5-coder:7b")).toBe(true);
    expect(callsTools("some-custom-model:13b")).toBe(true);
    expect(rankRoutes(heavy, { ...base, localModels: ["deepseek-r1:70b", "qwen3.5:9b"] })[0].model).toBe("qwen3.5:9b");
    expect(rankRoutes(heavy, { ...base, localModels: ["some-custom-model:13b"] })[0].model).toBe("some-custom-model:13b");
  });
});

describe("auto backend affordability", () => {
  const agentTurn = { messages: [{ role: "user" as const, content: "fix it" }], tools: [{ type: "function" as const, function: { name: "Edit" } }] };

  it("falls back to the small local model when the network says there aren't enough cSats", async () => {
    const tried: string[] = [];
    const b = autoBackend({
      inputs: async () => ({ ...base, localModels: ["qwen2.5-coder:1.5b"], networkModels: [{ model: "qwen2.5-coder:14b", classes: ["gpu"] }] }),
      run: (r) =>
        async function* () {
          tried.push(`${r.placement}${r.fallback ? ":fallback" : ""}`);
          if (r.placement === "network") throw new ChatBackendError("Not enough cSats for this request.", 402);
          yield { delta: "ok" };
          yield { done: true, cSatsSpent: 0 };
        },
    });
    const out: ChatPiece[] = [];
    for await (const p of b(agentTurn)) out.push(p);
    expect(tried).toEqual(["network", "local:fallback"]);
    expect(out[1]).toMatchObject({ done: true, cSatsSpent: 0, where: expect.stringContaining(FALLBACK_NOTE) });
  });

  it("fails clearly only when nothing at all can run", async () => {
    const b = autoBackend({ inputs: async () => ({ ...base, balanceCSats: 0, networkModels: [{ model: "qwen2.5-coder:14b", classes: ["gpu"] }] }), run: () => async function* () {} });
    await expect(b(agentTurn).next()).rejects.toThrow(/no model is installed on this computer or your machines.*you have no cSats/);
    const local = autoBackend({ inputs: async () => base, run: () => async function* () {}, policy: "local_only" });
    await expect(local({ messages: [{ role: "user", content: "hi" }] }).next()).rejects.toThrow(/No model is installed on this computer/);
  });
});
