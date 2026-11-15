import { beforeAll, describe, expect, test } from "vitest";
import { classifyHardware, type HardwareProfile } from "../../src/economy/compute-classes.js";
import type { GpuChallenge } from "../../src/swarm/benchmark.js";
import { fakeModelOutput } from "./helpers/fake-model.js";

/*
 * Who may witness a GPU cross-check (pickBenchmarkWitness, src/swarm/coordinator/economy.ts):
 * a random eligible agent, on another account and another /24 (IPv4) or /48 (IPv6) than the
 * subject and every earlier witness, with a passed GPU challenge and a clean witness record.
 */

const MODEL = "qwen3.5:9b";
const RTX3060: HardwareProfile = { cpuCores: 8, ramGb: 32, platform: "linux", arch: "x64", cpuModel: "Intel i5", gpu: { vendor: "nvidia", model: "NVIDIA GeForce RTX 3060", vramGb: 8 } };
let economy: typeof import("../../src/swarm/coordinator/economy.js");
let state: typeof import("../../src/swarm/coordinator/agent-state.js");

beforeAll(async () => {
  process.env.MESH_AUTH_TOKEN = "mesh-secret-witness-pick";
  delete process.env.DATABASE_URL;
  await import("../../src/swarm/coordinator.js");
  economy = await import("../../src/swarm/coordinator/economy.js");
  state = await import("../../src/swarm/coordinator/agent-state.js");
}, 60_000);

/** An online agent running MODEL; `verified` passes a GPU challenge of its own (gpu.c8, its class base). */
function agent(id: string, opts: { ip: string; owner?: string; verified?: boolean; model?: string; nowMs: number }) {
  state.agentCapabilities.set(id, {
    os: "linux", version: "1", mode: "swarm-only", localModelEnabled: true, localModelProvider: "ollama-local", localModelCatalog: [MODEL],
    clientType: "test", swarmEnabled: true, ideEnabled: false, maxConcurrentTasks: 1, connectedPeers: new Set(), sandboxMode: "docker",
    computeClass: "gpu", lastSeenMs: opts.nowMs, sourceIp: opts.ip, activeModel: opts.model ?? MODEL, ...(opts.owner ? { ownerEmail: opts.owner } : {}),
  } as any);
  const v = economy.hardwareVerifier;
  v.register({ agentId: id, claimed: classifyHardware(RTX3060), profile: RTX3060, challengeKinds: ["gpu"], nowMs: opts.nowMs });
  if (!opts.verified) return;
  const c = v.nextChallenge(id, { nowMs: opts.nowMs, model: MODEL }) as GpuChallenge;
  const ms = Math.round(((512 * 5.4) / 200) * 1000);
  v.submit(id, { challengeId: c.challengeId, kind: "gpu", output: fakeModelOutput(c.nonce, c.lines), evalCount: 512, evalDurationMs: ms, elapsedMs: ms + 200 }, opts.nowMs + ms + 300);
  expect(v.get(id)?.status).toBe("verified");
}

describe("pickBenchmarkWitness", () => {
  test("only eligible agents, independent of the subject and of earlier witnesses by account and network", () => {
    const now = Date.now();
    const p = (id: string) => `wp-${id}`;
    agent(p("subject"), { ip: "198.51.100.10", owner: "subject@example.com", nowMs: now });
    agent(p("same-net"), { ip: "198.51.100.77", verified: true, nowMs: now }); // subject's /24
    agent(p("same-owner"), { ip: "192.0.2.5", owner: "subject@example.com", verified: true, nowMs: now });
    agent(p("unverified"), { ip: "203.0.113.5", nowMs: now }); // nothing proven
    agent(p("other-model"), { ip: "203.0.114.5", verified: true, model: "llama3:8b", nowMs: now });
    agent(p("v6-a"), { ip: "2001:db8:aaaa:1::1", verified: true, nowMs: now });
    agent(p("v6-b"), { ip: "2001:db8:aaaa:2::2", verified: true, nowMs: now }); // same /48 as v6-a
    agent(p("ok"), { ip: "203.0.115.5", verified: true, nowMs: now });
    const pickAll = (exclude: string[]) => {
      // Every candidate, whatever the draw.
      const all = new Set<string>();
      for (let i = 0; i < 64; i++) {
        const w = economy.pickBenchmarkWitness(p("subject"), MODEL, now + 20_000, exclude, (n) => i % n);
        if (w?.startsWith("wp-")) all.add(w);
      }
      return [...all].sort();
    };
    expect(pickAll([])).toEqual([p("ok"), p("v6-a"), p("v6-b")].sort());
    // An earlier witness excludes its own /48 (and account) too.
    expect(pickAll([p("v6-a")])).toEqual([p("ok")]);
    // A blacklisted agent never witnesses.
    state.blacklistByAgent.set(p("ok"), { agentId: p("ok"), reasonCode: "manual_review" } as any);
    try {
      expect(pickAll([p("v6-a")])).toEqual([]);
    } finally {
      state.blacklistByAgent.delete(p("ok"));
    }
    // Offline agents are skipped.
    state.agentCapabilities.get(p("ok"))!.lastSeenMs = now - 10 * 60_000;
    expect(pickAll([p("v6-a")])).toEqual([]);
  });
});
