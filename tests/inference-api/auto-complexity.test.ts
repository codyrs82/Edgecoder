import { describe, expect, it } from "vitest";
import {
  ComplexityWindow,
  DEFAULT_COMPLEXITY_FLOORS,
  DEFAULT_QUALITY_FLOOR,
  FALLBACK_NOTE,
  autoPolicyFromEnv,
  complexityFloorsFromEnv,
  complexityWindowFromEnv,
  fitScore,
  planRoutes,
  routeSummary,
  sizeWorkload,
  type RouteInputs,
} from "../../src/inference-api/auto-route.js";
import { autoBackend } from "../../src/inference-api/backends.js";
import type { ComplexityLevel } from "../../src/inference-api/job-complexity.js";
import type { RoutingHints } from "../../src/inference-api/job-descriptor.js";
import type { ChatBackend, ChatPiece, ChatRequest } from "../../src/inference-api/types.js";

const SCORE: Record<ComplexityLevel, number> = { low: 0.15, medium: 0.4, high: 0.65, very_high: 0.9 };
const agentStep = { messages: [{ role: "user" as const, content: "fix the bug" }], tools: [{ type: "function" as const, function: { name: "Edit" } }] };
const step = (level: ComplexityLevel, req: Pick<ChatRequest, "messages" | "tools"> = agentStep) =>
  sizeWorkload(req, DEFAULT_QUALITY_FLOOR, { level, score: SCORE[level] }, DEFAULT_COMPLEXITY_FLOORS);

const price = { input: 100, output: 400 };
const base: RouteInputs = { localModels: [], myModels: [], leases: [], networkModels: [], classPrice: { cpu: 0.009, apple: 0.052, gpu: 0.043, "gpu.dc": 0.304 } };
const net30 = [{ model: "qwen3-coder:30b", classes: ["gpu"], cSatsPerMTokens: price }];
const where = (rs: ReturnType<typeof planRoutes>) => rs.map((r) => `${r.placement}:${r.model}${r.fallback ? ":fallback" : ""}`);

describe("complexity-aware Auto: sizing", () => {
  it("maps each level to a minimum model size (low keeps the quality floor)", () => {
    expect(step("low").complexity).toEqual({ level: "low", score: 0.15 });
    expect(step("medium").complexity).toMatchObject({ minB: 14, coderMinB: 7 });
    expect(step("high").complexity).toMatchObject({ minB: 30 });
    expect(step("very_high").complexity).toMatchObject({ minB: 30, reasoningCoder: true });
    // Without a complexity, nothing changes.
    expect(sizeWorkload(agentStep, DEFAULT_QUALITY_FLOOR).complexity).toBeUndefined();
  });

  it("medium: ~14B, or a 7B+ coder for a tool step; high: ~30B (MoE by total params)", () => {
    expect(fitScore("qwen2.5-coder:7b", step("medium"))).toBeGreaterThan(0);
    expect(fitScore("qwen3.5:9b", step("medium"))).toBe(-1);
    // A medium question without tools wants the 14B even from a coder.
    expect(fitScore("qwen2.5-coder:7b", step("medium", { messages: [{ role: "user", content: "explain" }] }))).toBe(-1);
    expect(fitScore("qwen2.5-coder:14b", step("high"))).toBe(-1);
    expect(fitScore("qwen3-coder:30b", step("high"))).toBeGreaterThan(0);
  });

  it("very high wants a coder or reasoning model when the catalog knows it", () => {
    expect(fitScore("qwen3-coder:30b", step("very_high"))).toBeGreaterThan(0);
    expect(fitScore("qwen3.5:35b", step("very_high"))).toBeGreaterThan(0); // thinking
    expect(fitScore("llama3.3:70b", step("very_high"))).toBe(-1); // tools only, not a coder
    expect(fitScore("some-custom-model:34b", step("very_high"))).toBeGreaterThan(0); // unknown: size alone
  });

  it("thresholds, window and policy come from the environment", () => {
    expect(complexityFloorsFromEnv({})).toEqual(DEFAULT_COMPLEXITY_FLOORS);
    expect(complexityFloorsFromEnv({ EDGECODER_AUTO_MEDIUM_MIN_B: "9", EDGECODER_AUTO_HIGH_MIN_B: "24", EDGECODER_AUTO_VERY_HIGH_MIN_B: "x", EDGECODER_AUTO_MEDIUM_CODER_MIN_B: "" })).toEqual({ mediumB: 9, mediumCoderB: 7, highB: 24, veryHighB: 30 });
    expect(complexityWindowFromEnv({})).toBe(3);
    expect(complexityWindowFromEnv({ EDGECODER_AUTO_COMPLEXITY_WINDOW: "1" })).toBe(1);
    expect(complexityWindowFromEnv({ EDGECODER_AUTO_COMPLEXITY_WINDOW: "0" })).toBe(1);
    expect(autoPolicyFromEnv({})).toBe("auto");
    expect(autoPolicyFromEnv({ EDGECODER_AUTO_POLICY: "mine-only" })).toBe("mine_only");
    expect(autoPolicyFromEnv({ EDGECODER_AUTO_POLICY: "model" })).toBe("auto");
  });
});

describe("complexity-aware Auto: ranking", () => {
  const inp = (localModels: string[], extra: Partial<RouteInputs> = {}): RouteInputs => ({ ...base, balanceCSats: 500, localModels, networkModels: net30, ...extra });

  it("a low-complexity step stays on this computer's 7B", () => {
    const routes = planRoutes(step("low"), inp(["qwen2.5-coder:7b"]), "auto");
    expect(where(routes)[0]).toBe("local:qwen2.5-coder:7b");
    expect(routes[0].reason).toBe("this computer (free) · qwen2.5-coder:7b for agent work — low complexity, fits locally");
    expect(routes[0].why).toBeUndefined();
  });

  it("a high-complexity step with only a 14B here goes to the network, and says why", () => {
    const routes = planRoutes(step("high"), inp(["qwen2.5-coder:14b"]), "auto");
    expect(where(routes)).toEqual(["network:qwen3-coder:30b", "local:qwen2.5-coder:14b:fallback"]);
    expect(routes[0].reason).toContain("— high complexity");
    expect(routes[0].why).toBe("high complexity, needs ≥30B; this computer has ≤14B");
    // The fallback behind it, should the network refuse.
    expect(routes[1].why).toBe("high-complexity step; a larger model wasn't available (the network couldn't take it)");
    expect(routes[1].reason).toContain(FALLBACK_NOTE);
  });

  it("a high-complexity step with a 30B here stays here", () => {
    const routes = planRoutes(step("high"), inp(["qwen2.5-coder:14b", "qwen3-coder:30b"]), "auto");
    expect(where(routes)[0]).toBe("local:qwen3-coder:30b");
    expect(routes[0].reason).toBe("this computer (free) · qwen3-coder:30b for agent work — high complexity, fits locally");
    // Your machines count as free too.
    expect(where(planRoutes(step("high"), inp(["qwen2.5-coder:14b"], { myModels: ["qwen3-coder:30b"] }), "local_first"))[0]).toBe("mine:qwen3-coder:30b");
  });

  it("medium: a 7B coder does a tool step locally; a 9B general model sends it to the network", () => {
    expect(where(planRoutes(step("medium"), inp(["qwen2.5-coder:7b"]), "auto"))[0]).toBe("local:qwen2.5-coder:7b");
    const routes = planRoutes(step("medium"), inp(["qwen3.5:9b"]), "auto");
    expect(where(routes)[0]).toBe("network:qwen3-coder:30b");
    expect(routes[0].why).toBe("medium complexity, needs ≥14B; this computer has ≤9B");
  });

  it("when the network can't take it, the biggest free model does it as a fallback, with the reason", () => {
    const cases: Array<[RouteInputs, Parameters<typeof planRoutes>[3], string]> = [
      [inp(["qwen2.5-coder:14b"], { balanceCSats: 0 }), {}, "balance 0"],
      [inp(["qwen2.5-coder:14b"], { networkModels: [], balanceCSats: undefined }), {}, "not connected to the network"],
      [inp(["qwen2.5-coder:14b"]), { allowanceCSats: 0 }, "today's budget is spent"],
      [inp(["qwen2.5-coder:14b"], { networkModels: [{ model: "qwen2.5-coder:14b", classes: ["gpu"], cSatsPerMTokens: price }] }), {}, "no network model that size"],
    ];
    for (const [i, opts, why] of cases) {
      const routes = planRoutes(step("high"), i, "auto", opts);
      expect(where(routes), why).toEqual(["local:qwen2.5-coder:14b:fallback"]);
      expect(routes[0].why).toBe(`high-complexity step; a larger model wasn't available (${why})`);
    }
  });

  it("the fallback is the biggest free model, wherever it is", () => {
    const routes = planRoutes(step("high"), inp(["qwen2.5-coder:7b"], { balanceCSats: 0, myModels: ["qwen2.5-coder:14b"] }), "auto");
    expect(where(routes)).toEqual(["mine:qwen2.5-coder:14b:fallback", "local:qwen2.5-coder:7b:fallback"]);
  });

  it("free-only policies never use the network, however hard the step", () => {
    for (const [policy, why] of [["local_only", "this computer only"], ["mine_only", "free machines only"]] as const) {
      const routes = planRoutes(step("very_high"), inp(["qwen2.5-coder:14b"]), policy);
      expect(routes.every((r) => r.placement !== "network"), policy).toBe(true);
      expect(where(routes)).toEqual(["local:qwen2.5-coder:14b:fallback"]);
      expect(routes[0].why).toBe(`very-high-complexity step; a larger model wasn't available (${why})`);
    }
    // A free model that fits is used as usual.
    expect(where(planRoutes(step("high"), inp(["qwen3-coder:30b"]), "mine_only"))).toEqual(["local:qwen3-coder:30b"]);
  });

  it("a pinned model ignores complexity", () => {
    expect(where(planRoutes(step("very_high"), inp([]), "model", { model: "qwen2.5-coder:7b" }))).toEqual(["local:qwen2.5-coder:7b"]);
  });

  it("the route summary carries the label, reason, why, complexity and fallback for the UI", () => {
    const [r] = planRoutes(step("high"), inp(["qwen2.5-coder:14b"], { balanceCSats: 0 }), "auto");
    expect(routeSummary({ ...r, complexity: "high" })).toEqual({
      label: "This computer · qwen2.5-coder:14b",
      placement: "local",
      model: "qwen2.5-coder:14b",
      reason: `this computer · qwen2.5-coder:14b · ${FALLBACK_NOTE}`,
      why: "high-complexity step; a larger model wasn't available (balance 0)",
      complexity: "high",
      fallback: true,
    });
  });
});

describe("complexity-aware Auto: hysteresis", () => {
  it("a session counts the hardest of its last few steps; harder takes effect at once", () => {
    const w = new ComplexityWindow(3);
    expect(w.push({ level: "low", score: 0.1 })).toMatchObject({ level: "low", held: false });
    expect(w.push({ level: "high", score: 0.6 })).toMatchObject({ level: "high", held: false });
    expect(w.push({ level: "low", score: 0.1 })).toMatchObject({ level: "high", score: 0.6, held: true });
    expect(w.push({ level: "low", score: 0.1 })).toMatchObject({ level: "high", held: true });
    expect(w.push({ level: "low", score: 0.1 })).toMatchObject({ level: "low", held: false });
    // A window of 1 is off.
    const off = new ComplexityWindow(1);
    off.push({ level: "high", score: 0.6 });
    expect(off.push({ level: "low", score: 0.1 })).toMatchObject({ level: "low" });
  });
});

describe("complexity-aware Auto: the backend", () => {
  const inputs = async (): Promise<RouteInputs> => ({ ...base, balanceCSats: 500, localModels: ["qwen2.5-coder:14b"], networkModels: net30 });
  const harness = () => {
    const ran: string[] = [];
    const hints: RoutingHints[] = [];
    const routes: Array<{ complexity?: string; why?: string }> = [];
    const ok = (label: string): ChatBackend =>
      async function* () {
        ran.push(label);
        yield { delta: "ok" };
        yield { done: true, cSatsSpent: 0 };
      };
    return {
      ran,
      hints,
      routes,
      run: (r: { placement: string; model: string }) => ok(`${r.placement}:${r.model}`),
      networkBestFit: (h: RoutingHints) => {
        hints.push(h);
        return ok("best-fit");
      },
      onRoute: (r: { complexity?: string; why?: string }) => routes.push({ complexity: r.complexity, why: r.why }),
    };
  };
  const collect = async (b: ChatBackend, req: ChatRequest) => {
    const out: ChatPiece[] = [];
    for await (const p of b(req)) out.push(p);
    return out;
  };

  it("estimates each step once and hands the network's best fit the same complexity", async () => {
    const h = harness();
    const b = autoBackend({ inputs, run: h.run, networkBestFit: h.networkBestFit, onRoute: h.onRoute, complexityWindow: 1 });
    const out = await collect(b, { ...agentStep, hints: { complexity: "high" } });
    expect(h.ran).toEqual(["best-fit"]);
    expect(h.hints[0].complexity).toBe(0.65);
    expect(h.routes[0]).toEqual({ complexity: "high", why: "high complexity, needs ≥30B; this computer has ≤14B" });
    expect(out.at(-1)).toMatchObject({ done: true, where: expect.stringContaining("(high complexity, needs ≥30B; this computer has ≤14B)") });
    // A low step runs here.
    await collect(b, { ...agentStep, hints: { complexity: "low" } });
    expect(h.ran).toEqual(["best-fit", "local:qwen2.5-coder:14b"]);
  });

  it("a caller's estimate (req.complexity) is used as is", async () => {
    const h = harness();
    const b = autoBackend({ inputs, run: h.run, networkBestFit: h.networkBestFit });
    await collect(b, { ...agentStep, complexity: { level: "very_high", score: 0.8, estimated: 0.8, floor: 0, signals: [] } });
    expect(h.hints[0].complexity).toBe(0.8);
  });

  it("doesn't flap: after a hard step, the next easy steps of the turn stay on the network", async () => {
    const h = harness();
    const b = autoBackend({ inputs, run: h.run, networkBestFit: h.networkBestFit, complexityWindow: 3 });
    for (const level of ["high", "low", "low", "low"] as const) await collect(b, { ...agentStep, hints: { complexity: level } });
    expect(h.ran).toEqual(["best-fit", "best-fit", "best-fit", "local:qwen2.5-coder:14b"]);
    // Sessions keep their own windows.
    await collect(b, { ...agentStep, hints: { complexity: "high", sessionId: "a" } });
    await collect(b, { ...agentStep, hints: { complexity: "low", sessionId: "b" } });
    expect(h.ran.at(-1)).toBe("local:qwen2.5-coder:14b");
  });

  it("a shared backend only remembers sessions that say who they are", async () => {
    const h = harness();
    const b = autoBackend({ inputs, run: h.run, networkBestFit: h.networkBestFit, hysteresis: "session" });
    await collect(b, { ...agentStep, hints: { complexity: "high" } });
    await collect(b, { ...agentStep, hints: { complexity: "low" } });
    expect(h.ran).toEqual(["best-fit", "local:qwen2.5-coder:14b"]);
  });

  it("free machines only: a hard step runs on the biggest free model and never reaches best fit", async () => {
    const h = harness();
    const b = autoBackend({ inputs, run: h.run, networkBestFit: h.networkBestFit, onRoute: h.onRoute, policy: "mine_only" });
    await collect(b, { ...agentStep, hints: { complexity: "high" } });
    expect(h.ran).toEqual(["local:qwen2.5-coder:14b"]);
    expect(h.routes[0].why).toBe("high-complexity step; a larger model wasn't available (free machines only)");
  });
});

import { botComputeChat, routeChoiceNote } from "../../src/apps/ide/bots.js";
import type { IdeStreamEvent } from "../../src/apps/ide/tool-types.js";

describe("complexity-aware Auto: what a bot run shows", () => {
  it("the route status event carries the reason and complexity; the run note and usage say why", async () => {
    const events: IdeStreamEvent[] = [];
    const ran: string[] = [];
    const ok = (label: string): ChatBackend =>
      async function* () {
        ran.push(label);
        yield { delta: "ok" };
        yield { done: true, cSatsSpent: 0.2 };
      };
    const chat = botComputeChat(
      { bot: { name: "Harry", compute: { policy: "auto" } } as never, sendEvent: (e) => events.push(e), signal: new AbortController().signal, budgetLeft: () => 100 },
      (policy, plan, onRoute) => {
        const inner = autoBackend({
          inputs: async () => ({ ...base, balanceCSats: 500, localModels: ["qwen2.5-coder:14b"], networkModels: net30 }),
          run: (r) => ok(`${r.placement}:${r.model}`),
          networkBestFit: () => ok("best-fit"),
          policy,
          plan,
          onRoute,
        });
        // This step is a hard one.
        return (req, signal) => inner({ ...req, hints: { ...req.hints, complexity: "high" } }, signal);
      },
    );
    await chat({ messages: [{ role: "user", content: "refactor it" }], tools: [{ type: "function", function: { name: "Edit" } }] });
    expect(ran).toEqual(["best-fit"]);
    const status = events.find((e) => e.type === "status") as Extract<IdeStreamEvent, { type: "status" }>;
    expect(status.note).toBe("Auto → network best fit (high complexity, needs ≥30B; this computer has ≤14B)");
    expect(status.route).toMatchObject({ label: "Network · best fit", placement: "network", complexity: "high", why: "high complexity, needs ≥30B; this computer has ≤14B" });
    expect(status.route?.reason).toContain("high complexity");
    const usage = events.find((e) => e.type === "usage") as Extract<IdeStreamEvent, { type: "usage" }>;
    expect(usage).toMatchObject({ where: "Network · best fit", reason: expect.stringContaining("(high complexity, needs ≥30B; this computer has ≤14B)") });
  });

  it("routeChoiceNote names a complexity fallback", () => {
    expect(routeChoiceNote({ placement: "local", model: "qwen2.5-coder:14b", cSatsPerSecond: 0, reason: "", fallback: true, why: "high-complexity step; a larger model wasn't available (balance 0)" }, "local_first")).toBe(
      "Local first → qwen2.5-coder:14b on this computer (high-complexity step; a larger model wasn't available (balance 0))",
    );
  });
});
