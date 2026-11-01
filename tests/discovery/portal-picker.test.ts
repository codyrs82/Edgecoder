import { describe, expect, it } from "vitest";
import { createCoordinatorPicker, pickerModeFromEnv, pickerSourcesFromEnv } from "../../src/portal/coordinator-discovery.js";
import type { FetchLike } from "../../src/discovery/selector.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeFetch(nodes: Record<string, { latencyMs?: number; down?: boolean }>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const node = nodes[u.host];
    if (!node || node.down) throw new Error("down");
    if (u.pathname === "/health/runtime") {
      await sleep(node.latencyMs ?? 5);
      return { status: 200, json: async () => ({ ok: true, coordinator: { queued: 0, agents: 1 } }) };
    }
    return { status: 401, json: async () => ({}) };
  };
  return { fetch, calls };
}

describe("portal picker modes", () => {
  it("defaults to the ordered picker; PORTAL_DISCOVERY=selector opts in", () => {
    expect(pickerModeFromEnv({})).toBe("ordered");
    expect(pickerModeFromEnv({ PORTAL_DISCOVERY: "Selector" })).toBe("selector");
    expect(pickerModeFromEnv({ PORTAL_DISCOVERY: "ordered" })).toBe("ordered");
    expect(pickerSourcesFromEnv({})).toEqual({ dns: false, nostr: false });
    expect(pickerSourcesFromEnv({ PORTAL_DISCOVERY_SOURCES: "static, dns ,nostr" })).toEqual({ dns: true, nostr: true });
  });

  it("ordered mode is unchanged: first healthy URL in order, even when a later one is faster", async () => {
    const probed: string[] = [];
    const pick = createCoordinatorPicker({
      urls: ["https://slow", "https://fast"],
      probe: async (url) => {
        probed.push(url);
        return true;
      },
      env: {}
    });
    expect(await pick()).toBe("https://slow");
    expect(probed).toEqual(["https://slow"]);
  });

  it("selector mode picks the best-scoring static URL, caches it and is sticky", async () => {
    const nodes = { slow: { latencyMs: 150 }, fast: { latencyMs: 5 } };
    const f = fakeFetch(nodes);
    let now = 0;
    const pick = createCoordinatorPicker({
      urls: ["https://slow", "https://fast"],
      probe: async () => {
        throw new Error("ordered probe must not be used in selector mode");
      },
      env: { PORTAL_DISCOVERY: "selector" },
      ttlMs: 60_000,
      now: () => Date.now() + now,
      selector: { fetch: f.fetch, timeoutMs: 1000 }
    });
    const [a, b] = await Promise.all([pick(), pick()]);
    expect(a).toBe("https://fast");
    expect(b).toBe("https://fast");
    expect(f.calls.filter((u) => u.endsWith("/health/runtime"))).toHaveLength(2);
    now += 10_000;
    expect(await pick()).toBe("https://fast");
    expect(f.calls.filter((u) => u.endsWith("/health/runtime"))).toHaveLength(2);
    // After the ttl both are equally fast: stickiness keeps the current one.
    now += 60_000;
    nodes.slow.latencyMs = 5;
    expect(await pick()).toBe("https://fast");
    expect(f.calls.filter((u) => u.endsWith("/health/runtime"))).toHaveLength(4);
  });

  it("selector mode caches a 'none healthy' result for the negative ttl", async () => {
    const f = fakeFetch({ a: { down: true } });
    let now = 0;
    const pick = createCoordinatorPicker({
      urls: ["https://a"],
      probe: async () => false,
      mode: "selector",
      env: {},
      negativeTtlMs: 5000,
      now: () => Date.now() + now,
      selector: { fetch: f.fetch, timeoutMs: 200 }
    });
    expect(await pick()).toBeNull();
    const probes = f.calls.length;
    expect(await pick()).toBeNull();
    expect(f.calls.length).toBe(probes);
    now += 6000;
    expect(await pick()).toBeNull();
    expect(f.calls.length).toBeGreaterThan(probes);
  });
});
