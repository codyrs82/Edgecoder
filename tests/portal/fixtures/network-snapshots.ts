import type { CoordinatorSnapshot } from "../../../src/portal/routes/network-admin.js";

/** Canned GET /admin/network answers for two coordinators (US and EU), used by the API test and the screenshots. */
type Agent = CoordinatorSnapshot["agents"][number];

const agent = (over: Partial<Agent> & { agentId: string }, nowMs: number): Agent => ({
  accountId: null, ownerEmail: null, os: "macos", clientType: "desktop", version: "1.8.2", mode: "swarm-only", provider: "ollama-local",
  countryCode: "US", vpnDetected: false, computeClass: "apple", tier: "t2", claimedTier: "t2", verification: "verified",
  modelsInstalled: ["qwen2.5-coder:7b"], modelsReported: true, activeModel: "qwen2.5-coder:7b", slots: 2, slotsReported: true,
  freeSlots: 2, contextWindow: 16384, claims: 0, inferenceClaims: 0, lastSeenMs: nowMs - 4_000, lastPullMs: nowMs - 4_000,
  connected: true, socketConnected: true, wake: true, reserved: false, blacklisted: false, blacklistReason: null, status: "idle",
  ...over
});

/** A wavy, plausible series of `n` buckets of `bucketMs` ending now. */
function series(nowMs: number, bucketMs: number, n: number, scale: number, seed: number, region: string) {
  const points = [];
  const end = Math.floor(nowMs / bucketMs) * bucketMs;
  for (let i = n - 1; i >= 0; i--) {
    const t = end - i * bucketMs;
    const w = Math.sin((i + seed) / 9) * 0.5 + 0.5;
    const w2 = Math.cos((i + seed * 3) / 5) * 0.5 + 0.5;
    const total = Math.round(6 * scale);
    const busy = Math.min(total, Math.round(total * (0.25 + 0.6 * w)));
    points.push({
      atMs: t, connectedAgents: Math.round(4 * scale), busyAgents: Math.min(Math.round(4 * scale), Math.round(busy / 1.5)), totalSlots: total, freeSlots: total - busy,
      queued: Math.round(3 * w2 * scale), claimed: busy, waitingInference: Math.round(1.5 * w2 * w * scale), started: Math.round(5 * w * scale), completed: Math.round(4.6 * w * scale),
      failed: 0, noCapacity: w2 > 0.95 ? 1 : 0, noAgentHasModel: 0,
      pickupP50: Math.round(180 + 220 * w2), pickupP90: Math.round(600 + 900 * w2 * w), ttftP50: Math.round(700 + 500 * w), ttftP90: Math.round(1600 + 1400 * w * w2),
      // Gaps over time (#336).
      unmetByModel: w2 > 0.8 ? { "deepseek-r1:70b": Math.round(3 * w2), ...(w > 0.7 ? { "llama3.1:8b": 1 } : {}) } : {},
      modelSlots: { "llama3.1:8b": { free: total - busy, total }, "qwen2.5-coder:7b": { free: Math.max(0, Math.round(2 * scale) - (w > 0.6 ? 2 : 0)), total: Math.round(2 * scale) } },
      saturatedModels: (total - busy === 0 ? 1 : 0) + (w > 0.6 ? 1 : 0),
      staleAgents: i % 40 < 6 ? 1 : 0,
      agentsByRegion: { [region]: Math.round(3 * scale), ...(scale >= 1 ? { sin: 1 } : {}) }
    });
  }
  return points;
}

export function cannedSnapshots(nowMs = Date.now(), range: "1h" | "6h" | "24h" = "1h"): { us: CoordinatorSnapshot; eu: CoordinatorSnapshot } {
  const bucketMs = range === "1h" ? 15_000 : range === "6h" ? 90_000 : 360_000;
  const us: CoordinatorSnapshot = {
    coordinator: { peerId: "coord-us", url: "https://coordinator.edgecoder.io", region: "iad", uptimeSeconds: 86_000, generatedAtMs: nowMs, samplesKept: 5760 },
    totals: { startedPerMin: 14.2, completedPerMin: 13.6 },
    agents: [
      agent({ agentId: "mac-studio-7f3a", accountId: "acct-u-alice", ownerEmail: "alice@example.com", slots: 4, freeSlots: 1, claims: 3, inferenceClaims: 3, status: "busy", modelsInstalled: ["qwen2.5-coder:7b", "llama3.1:8b"], contextWindow: 32768, tier: "t3" }, nowMs),
      agent({ agentId: "rtx4090-box-21", accountId: "acct-u-bob", region: "sin", computeClass: "gpu", tier: "t4", os: "linux", clientType: "worker", slots: 4, freeSlots: 4, modelsInstalled: ["qwen2.5-coder:32b", "llama3.1:8b"], activeModel: "qwen2.5-coder:32b" }, nowMs),
      agent({ agentId: "mbp-m3-carol", accountId: "acct-u-carol", slots: 2, freeSlots: 0, claims: 2, inferenceClaims: 2, status: "busy", countryCode: "CA", socketConnected: false }, nowMs),
      agent({ agentId: "old-laptop-9", accountId: "acct-u-bob", computeClass: "cpu", tier: "t1", verification: null, connected: false, socketConnected: false, status: "stale", freeSlots: 0, lastSeenMs: nowMs - 26 * 60_000 }, nowMs)
    ],
    queue: { queued: 6, claimed: 5, unclaimed: 1, waitingInference: 1, waitingByModel: [{ model: "qwen2.5-coder:7b", waiting: 1 }] },
    dispatch: { pickup: { count: 840, p50: 240, p90: 1180 }, nudges: 2210 },
    latency: { windowMs: 900_000, pickup: { count: 840, p50: 240, p90: 1180 }, ttft: { count: 120, p50: 820, p90: 2300 }, duration: { count: 118, p50: 6400, p90: 21000 } },
    models: [
      { model: "qwen2.5-coder:7b", agents: 2, idleAgents: 0, slots: 6, freeSlots: 1, waiting: 1, callsWindow: 150, completedWindow: 146, failedWindow: 1, calls24h: 9200, noAgentHasModel24h: 0, noCapacity24h: 3 },
      { model: "llama3.1:8b", agents: 2, idleAgents: 1, slots: 8, freeSlots: 5, waiting: 0, callsWindow: 40, completedWindow: 40, failedWindow: 0, calls24h: 2100, noAgentHasModel24h: 0, noCapacity24h: 0 },
      { model: "qwen2.5-coder:32b", agents: 1, idleAgents: 1, slots: 4, freeSlots: 4, waiting: 0, callsWindow: 12, completedWindow: 12, failedWindow: 0, calls24h: 640, noAgentHasModel24h: 0, noCapacity24h: 0 },
      { model: "deepseek-r1:70b", agents: 0, idleAgents: 0, slots: 0, freeSlots: 0, waiting: 0, callsWindow: 0, completedWindow: 0, failedWindow: 0, calls24h: 0, noAgentHasModel24h: 17, noCapacity24h: 0 }
    ],
    gaps: { windowMs: 3_600_000, missingModels: [{ model: "deepseek-r1:70b", noAgentHasModel: 9, noCapacity: 0 }, { model: "qwen2.5-coder:7b", noAgentHasModel: 0, noCapacity: 2 }], saturatedModels: [], staleAgents: [] },
    series: { range, bucketMs, points: series(nowMs, bucketMs, 240, 1, 0, "iad") }
  };
  const eu: CoordinatorSnapshot = {
    coordinator: { peerId: "coord-eu", url: "https://coordinator-eu.edgecoder.io", region: "ams", uptimeSeconds: 40_000, generatedAtMs: nowMs, samplesKept: 2660 },
    totals: { startedPerMin: 3.1, completedPerMin: 3.0 },
    agents: [
      agent({ agentId: "ryzen-eu-55", accountId: "acct-u-dora", computeClass: "gpu", tier: "t3", os: "windows", countryCode: "DE", slots: 2, freeSlots: 1, claims: 1, inferenceClaims: 1, status: "busy", modelsInstalled: ["llama3.1:8b"] }, nowMs),
      // An old entry for an agent that now works on the US coordinator: the merge keeps the newer one.
      agent({ agentId: "mac-studio-7f3a", accountId: "acct-u-alice", connected: false, status: "stale", lastSeenMs: nowMs - 3 * 3_600_000, freeSlots: 0 }, nowMs)
    ],
    queue: { queued: 1, claimed: 1, unclaimed: 0, waitingInference: 0, waitingByModel: [] },
    dispatch: { pickup: { count: 210, p50: 310, p90: 1650 }, nudges: 420 },
    latency: { windowMs: 900_000, pickup: { count: 210, p50: 310, p90: 1650 }, ttft: { count: 40, p50: 950, p90: 2800 }, duration: { count: 40, p50: 7000, p90: 18000 } },
    models: [{ model: "llama3.1:8b", agents: 1, idleAgents: 0, slots: 2, freeSlots: 1, waiting: 0, callsWindow: 45, completedWindow: 45, failedWindow: 0, calls24h: 3000, noAgentHasModel24h: 0, noCapacity24h: 0 }],
    gaps: { windowMs: 3_600_000, missingModels: [{ model: "deepseek-r1:70b", noAgentHasModel: 4, noCapacity: 0 }], saturatedModels: [], staleAgents: [] },
    series: { range, bucketMs, points: series(nowMs, bucketMs, 160, 0.4, 7, "ams") }
  };
  return { us, eu };
}
