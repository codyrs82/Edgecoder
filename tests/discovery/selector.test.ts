import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { applyStickiness, createCoordinatorSelector, probeCoordinator, rankCoordinators, type FetchLike } from "../../src/discovery/selector.js";
import { publicKeyFingerprint, type CoordinatorCandidate } from "../../src/discovery/types.js";

interface FakeNode {
  latencyMs?: number;
  down?: boolean;
  healthOk?: boolean;
  queued?: number;
  agents?: number;
  capacity?: number | "unauthorized";
  price?: number;
  hang?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fake fetch over a map of coordinators. /health/runtime takes the node's latency in real time
 * (so parallel probes measure it independently); `clock.offset` fast-forwards the selector's clock for ttl tests.
 */
function fakeFetch(nodes: Record<string, FakeNode>, clock: { offset: number }, calls: string[] = []): { fetch: FetchLike; now: () => number; calls: string[] } {
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    const base = Object.keys(nodes).find((b) => url.startsWith(`${b}/`));
    const node = base ? nodes[base] : undefined;
    if (!node || node.down) throw new Error("ECONNREFUSED");
    const path = url.slice(base!.length);
    if (node.hang) {
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    if (path === "/health/runtime") {
      await sleep(node.latencyMs ?? 5);
      return { status: node.healthOk === false ? 503 : 200, json: async () => ({ ok: node.healthOk !== false, coordinator: { queued: node.queued ?? 0, agents: node.agents ?? 1, results: 0 } }) };
    }
    if (path === "/capacity") {
      if (node.capacity === "unauthorized" || !init.headers["x-mesh-token"]) return { status: 401, json: async () => ({ error: "mesh_unauthorized" }) };
      return { status: 200, json: async () => ({ totals: { agentsConnected: node.agents ?? 1, totalCapacity: node.capacity ?? 4 }, agents: [] }) };
    }
    if (path.startsWith("/economy/market/book")) {
      if (!init.headers["x-mesh-token"] && !init.headers["x-portal-service-token"]) return { status: 401, json: async () => ({}) };
      const cls = new URL(url).searchParams.get("computeClass");
      return { status: 200, json: async () => ({ books: [{ computeClass: cls, clearingMsatPerCredit: node.price ?? 1000, midMsatPerCredit: node.price ?? 1000 }] }) };
    }
    return { status: 404, json: async () => ({}) };
  };
  return { fetch, now: () => Date.now() + clock.offset, calls };
}

const cand = (url: string, extra: Partial<CoordinatorCandidate> = {}): CoordinatorCandidate => ({ url, source: "static", ...extra });

describe("probeCoordinator", () => {
  it("measures latency and reads queue, capacity and price with a token", async () => {
    const f = fakeFetch({ "https://a": { latencyMs: 60, queued: 2, capacity: 8, price: 900 } }, { offset: 0 });
    const p = await probeCoordinator("https://a/", { fetch: f.fetch, now: f.now, meshToken: "t", computeClass: "gpu.c8" });
    expect(p).toMatchObject({ healthy: true, queued: 2, agents: 1, capacity: 8, priceMsatPerCredit: 900 });
    expect(p.latencyMs).toBeGreaterThanOrEqual(55);
    expect(p.latencyMs).toBeLessThan(500);
    expect(f.calls.some((u) => u.includes("computeClass=gpu.c8"))).toBe(true);
  });

  it("defaults to the cpu market and matches a legacy class id against the mapped book", async () => {
    const calls: string[] = [];
    const f = fakeFetch({ "https://a": { price: 900 } }, { offset: 0 }, calls);
    await probeCoordinator("https://a/", { fetch: f.fetch, now: f.now, meshToken: "t" });
    expect(calls.some((u) => u.includes("computeClass=cpu") && !u.includes("cpu.std"))).toBe(true);
    // A new coordinator answers ?computeClass=gpu.c8 with the gpu book (and may list others first).
    const mapped: FetchLike = async (url) =>
      url.endsWith("/health/runtime")
        ? { status: 200, json: async () => ({ ok: true, coordinator: { queued: 0, agents: 1 } }) }
        : url.includes("/economy/market/book")
          ? { status: 200, json: async () => ({ books: [{ computeClass: "cpu", clearingMsatPerCredit: 9 }, { computeClass: "gpu", clearingMsatPerCredit: 33 }] }) }
          : { status: 404, json: async () => ({}) };
    expect((await probeCoordinator("https://b", { fetch: mapped, meshToken: "t", computeClass: "gpu.c8" })).priceMsatPerCredit).toBe(33);
  });

  it("works without a token (capacity/price unknown) and reports unreachable or unhealthy nodes", async () => {
    const f = fakeFetch({ "https://a": { queued: 1 }, "https://b": { down: true }, "https://c": { healthOk: false } }, { offset: 0 });
    expect(await probeCoordinator("https://a", { fetch: f.fetch, now: f.now })).toMatchObject({ healthy: true, queued: 1, capacity: null, priceMsatPerCredit: null });
    expect(await probeCoordinator("https://b", { fetch: f.fetch, now: f.now })).toMatchObject({ healthy: false, error: "unreachable" });
    expect(await probeCoordinator("https://c", { fetch: f.fetch, now: f.now })).toMatchObject({ healthy: false, error: "health_503" });
    expect(f.calls.filter((u) => u.includes("/economy/market/book"))).toHaveLength(0);
  });

  it("aborts hung probes after the timeout", async () => {
    const f = fakeFetch({ "https://hang": { hang: true } }, { offset: 0 });
    const p = await probeCoordinator("https://hang", { fetch: f.fetch, now: f.now, timeoutMs: 30 });
    expect(p.healthy).toBe(false);
  });
});

describe("rankCoordinators", () => {
  it("ranks healthy nodes by latency, load and price and puts unhealthy ones last", async () => {
    const f = fakeFetch(
      {
        "https://fast": { latencyMs: 5, queued: 0, capacity: 8, price: 1000 },
        "https://slow": { latencyMs: 120, queued: 0, capacity: 8, price: 1000 },
        "https://busy": { latencyMs: 5, queued: 8, capacity: 8, price: 1000 },
        "https://pricey": { latencyMs: 5, queued: 0, capacity: 8, price: 4000 },
        "https://down": { down: true }
      },
      { offset: 0 }
    );
    const ranked = await rankCoordinators({
      candidates: ["https://down", "https://pricey", "https://busy", "https://slow", "https://fast"].map((u) => cand(u)),
      fetch: f.fetch,
      now: f.now,
      meshToken: "t",
      latencyCeilingMs: 200
    });
    expect(ranked.map((r) => r.url)).toEqual(["https://fast", "https://pricey", "https://slow", "https://busy", "https://down"]);
    expect(ranked[0].score).toBeGreaterThan(0.9);
    expect(ranked.at(-1)).toMatchObject({ healthy: false, score: 0, error: "unreachable" });
    expect(ranked.find((r) => r.url === "https://busy")?.components.load).toBe(0);
    expect(ranked.find((r) => r.url === "https://pricey")?.components.price).toBe(0.25);
  });

  it("probes all candidates in parallel", async () => {
    const f = fakeFetch({ "https://a": { latencyMs: 20 }, "https://b": { latencyMs: 20 } }, { offset: 0 });
    let maxInFlight = 0;
    let inFlight = 0;
    const counting: FetchLike = async (url, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await f.fetch(url, init);
      } finally {
        inFlight -= 1;
      }
    };
    await rankCoordinators({ candidates: [cand("https://a"), cand("https://b")], fetch: counting, now: f.now });
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it("boosts pinned keys and peerIds only when pins are configured", async () => {
    const keys = createPeerKeys("pinned-coord");
    const f = fakeFetch({ "https://a": { latencyMs: 5 }, "https://b": { latencyMs: 5 } }, { offset: 0 });
    const candidates = [cand("https://a"), cand("https://b", { peerId: keys.peerId, publicKeyPem: keys.publicKeyPem })];
    const neutral = await rankCoordinators({ candidates, fetch: f.fetch, now: f.now });
    expect(Math.abs(neutral[0].score - neutral[1].score)).toBeLessThan(0.05);
    expect(neutral.every((r) => !r.pinned)).toBe(true);
    const byFingerprint = await rankCoordinators({ candidates, fetch: f.fetch, now: f.now, pinnedKeys: [publicKeyFingerprint(keys.publicKeyPem)] });
    expect(byFingerprint[0]).toMatchObject({ url: "https://b", pinned: true });
    expect(byFingerprint[0].score).toBeGreaterThan(byFingerprint[1].score + 0.1);
    const byPeer = await rankCoordinators({ candidates, fetch: f.fetch, now: f.now, pinnedPeerIds: [keys.peerId] });
    expect(byPeer[0].url).toBe("https://b");
  });
});

describe("stickiness", () => {
  const ranked = (scores: Record<string, number>) =>
    Object.entries(scores)
      .map(([url, score]) => ({ url, source: "static" as const, healthy: score > 0, latencyMs: 10, queued: 0, capacity: 1, agents: 1, priceMsatPerCredit: null, pinned: false, score, components: { latency: 1, load: 1, price: 0.5, pinned: 0 } }))
      .sort((a, b) => b.score - a.score);

  it("keeps the current coordinator unless a candidate wins by the margin", () => {
    expect(applyStickiness(ranked({ "https://a": 0.8, "https://b": 0.9 }), "https://a")?.url).toBe("https://a");
    expect(applyStickiness(ranked({ "https://a": 0.6, "https://b": 0.9 }), "https://a")?.url).toBe("https://b");
    expect(applyStickiness(ranked({ "https://a": 0.8, "https://b": 0.9 }), "https://a", 0.05)?.url).toBe("https://b");
    expect(applyStickiness(ranked({ "https://a": 0.8, "https://b": 0.9 }), "https://a/")?.url).toBe("https://a");
  });

  it("falls over when the current coordinator is unhealthy or unknown, and returns null when nothing is healthy", () => {
    expect(applyStickiness(ranked({ "https://a": 0, "https://b": 0.5 }), "https://a")?.url).toBe("https://b");
    expect(applyStickiness(ranked({ "https://b": 0.5 }), "https://zzz")?.url).toBe("https://b");
    expect(applyStickiness(ranked({ "https://b": 0.5 }), undefined)?.url).toBe("https://b");
    expect(applyStickiness(ranked({ "https://a": 0, "https://b": 0 }), "https://a")).toBeNull();
  });
});

describe("createCoordinatorSelector", () => {
  it("caches rankings for the ttl, shares in-flight probes and applies stickiness across calls", async () => {
    const clock = { offset: 0 };
    const nodes: Record<string, FakeNode> = { "https://a": { latencyMs: 5 }, "https://b": { latencyMs: 80 } };
    const f = fakeFetch(nodes, clock);
    const selector = createCoordinatorSelector({ fetch: f.fetch, now: f.now, ttlMs: 60_000, stickinessMargin: 0.2, latencyCeilingMs: 200 });
    const candidates = [cand("https://a"), cand("https://b")];
    const [first, second] = await Promise.all([selector.select(candidates), selector.select(candidates)]);
    expect(first?.url).toBe("https://a");
    expect(second?.url).toBe("https://a");
    const healthCalls = () => f.calls.filter((u) => u.endsWith("/health/runtime")).length;
    expect(healthCalls()).toBe(2);
    // Within the ttl: no re-probe.
    clock.offset += 30_000;
    expect((await selector.select(candidates))?.url).toBe("https://a");
    expect(healthCalls()).toBe(2);
    // After the ttl, b is now much faster and a is slow: b wins by well over the 20% margin.
    clock.offset += 31_000;
    nodes["https://a"].latencyMs = 180;
    nodes["https://b"].latencyMs = 5;
    const third = await selector.select(candidates);
    expect(healthCalls()).toBe(4);
    expect(third?.url).toBe("https://b");
    expect(selector.current()).toBe("https://b");
    // Invalidate + b goes down: falls over immediately.
    selector.invalidate();
    nodes["https://b"].down = true;
    expect((await selector.select(candidates))?.url).toBe("https://a");
  });
});
