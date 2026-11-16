// Unit tests for the load generator's sustained-load control (planner.mjs RateGovernor, fatalStop),
// its coding workload mix (workload.mjs) and the money report math (money.mjs).
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { CapacityPlanner, RateGovernor, fatalStop } from "../../scripts/loadgen/planner.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { buildSchedule, codingContext, paramsB } from "../../scripts/loadgen/profiles.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { codegenSize, codegenTask, modelMix, rng } from "../../scripts/loadgen/workload.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { chargesFrom, chooseBuyers, hostingFrom, moneyReport } from "../../scripts/loadgen/money.mjs";

const clock = (t0 = 1_000_000) => {
  let t = t0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

describe("rate governor: hold, don't stop", () => {
  it("steps down to the last clean rate on a breach and holds it as the ceiling for later stages", () => {
    const c = clock();
    const g = new RateGovernor({ mode: "schedule", maxRate: 4, breach: { errorRate: 0.1, minCalls: 20 }, now: c.now });
    expect(g.setStage(0.5)).toBe(0.5);
    expect(g.observe({ calls: 30, failures: 1 })).toBeNull(); // clean window at 0.5
    expect(g.setStage(1)).toBe(1);
    c.advance(10_000);
    const ev = g.observe({ calls: 30, failures: 6 }); // 20% > 10%
    expect(ev).toMatchObject({ action: "backoff", from: 1, rate: 0.5, ceiling: 0.5 });
    // Later, higher stages hold the sustainable rate instead of climbing (or stopping).
    expect(g.setStage(2)).toBe(0.5);
    expect(g.setStage(4)).toBe(0.5);
  });

  it("steps down again on another breach, one step per window, never below minRate", () => {
    const c = clock();
    const g = new RateGovernor({ mode: "schedule", maxRate: 4, minRate: 0.1, now: c.now });
    g.setStage(1);
    expect(g.observe({ calls: 40, failures: 20 })?.rate).toBeCloseTo(0.7);
    c.advance(10_000);
    expect(g.observe({ calls: 40, failures: 20 })).toBeNull(); // within 30 s of the last step
    for (let i = 0; i < 20; i++) { c.advance(31_000); g.observe({ calls: 40, failures: 20 }); }
    expect(g.rate).toBe(0.1);
    expect(g.breaches).toBeGreaterThan(5);
  });

  it("ignores windows with too few calls and relaxes a ceiling after 10 clean minutes", () => {
    const c = clock();
    const g = new RateGovernor({ mode: "schedule", maxRate: 4, now: c.now });
    g.setStage(2);
    expect(g.observe({ calls: 5, failures: 5 })).toBeNull();
    g.observe({ calls: 40, failures: 20 });
    expect(g.ceiling).toBeCloseTo(1.4);
    c.advance(601_000);
    g.observe({ calls: 40, failures: 0 });
    expect(g.ceiling).toBeCloseTo(1.54);
  });

  it("sustain: probes up x1.5 while utilization is low, holds inside 70-85%, nudges down above", () => {
    const c = clock();
    const g = new RateGovernor({ mode: "adaptive", maxRate: 4, startRate: 0.25, target: [0.7, 0.85], probeEverySec: 60, adjustEverySec: 120, now: c.now });
    const minute = (util: number) => { for (let i = 0; i < 60; i++) g.sample(util); c.advance(60_000); return g.observe({ calls: 30, failures: 0 }); };
    expect(minute(0.2)).toMatchObject({ action: "probe_up", rate: 0.375 });
    expect(minute(0.4)?.rate).toBeCloseTo(0.5625);
    expect(minute(0.78)).toMatchObject({ action: "hold" });
    expect(g.phase).toBe("hold");
    // In hold, adjustments come every 2 minutes and are gentle.
    expect(minute(0.95)).toBeNull();
    expect(minute(0.95)).toMatchObject({ action: "nudge_down" });
    expect(g.rate).toBeCloseTo(0.5625 * 0.85);
    // The adaptive rate ignores the schedule's stage rate.
    expect(g.setStage(16)).toBeCloseTo(0.5625 * 0.85);
  });

  it("sustain never probes past the cap", () => {
    const c = clock();
    const g = new RateGovernor({ mode: "adaptive", maxRate: 1, startRate: 0.8, now: c.now });
    for (let i = 0; i < 5; i++) { g.sample(0.1); c.advance(61_000); g.observe({ calls: 30, failures: 0 }); }
    expect(g.rate).toBe(1);
  });

  it("stops only for real failure: auth, or the coordinator down for two minutes", () => {
    expect(fatalStop({ calls: 40, errors: { no_capacity: 20, over_capacity: 10, timeout: 5, stream_error: 5 } }).stop).toBeNull();
    expect(fatalStop({ calls: 6, errors: { auth_error: 4 } }).stop).toBe("auth_failed");
    let down = 0;
    for (let i = 0; i < 11; i++) {
      const f = fatalStop({ calls: 10, errors: { network_error: 6, http_502: 4 } }, down);
      expect(f.stop).toBeNull();
      down = f.downTicks;
    }
    expect(fatalStop({ calls: 10, errors: { network_error: 10 } }, down).stop).toBe("coordinator_down");
    // One good window resets the count.
    expect(fatalStop({ calls: 10, errors: { network_error: 2 } }, down).downTicks).toBe(0);
  });

  it("builds sustain as 5-minute segments at the cap for --duration", () => {
    const s = buildSchedule("sustain", { durationSec: 3600, maxRate: 8, rate: 2 });
    expect(s.adaptive).toBe(true);
    expect(s.stages).toHaveLength(12);
    expect(s.stages.every((x: { rate: number }) => x.rate === 8)).toBe(true);
    expect(s.startRate).toBe(2);
    expect(s.durationSec).toBe(3600);
  });
});

describe("coding workload mix", () => {
  const capacity = {
    models: {
      "qwen2.5-coder:1.5b": { slots: 18, freeSlots: 18, classes: ["cpu", "apple"] },
      "qwen2.5-coder:7b": { slots: 2, freeSlots: 2, classes: ["apple"] },
      "qwen3.5:9b": { slots: 2, freeSlots: 2, classes: ["apple"] },
      "deepseek-r1:14b": { slots: 2, freeSlots: 2, classes: ["apple"] },
      "qwen3-coder:30b": { slots: 2, freeSlots: 2, classes: ["gpu.dc"] },
      "nomic-embed-text:latest": { slots: 4, freeSlots: 4, classes: ["cpu"] },
    },
  };

  it("weights 7b and up fully, small models lightly, and leaves out embeddings", () => {
    const m = modelMix(capacity, "codegen");
    expect(m["network/qwen3-coder:30b"]).toBe(1);
    expect(m["network/deepseek-r1:14b"]).toBe(1);
    expect(m["network/qwen2.5-coder:1.5b"]).toBeLessThan(0.1);
    expect(m["network/nomic-embed-text:latest"]).toBeUndefined();
    expect(modelMix(null, "codegen", { x: 1 })).toEqual({ x: 1 });
  });

  it("spreads codegen calls over the 7b-30b models in proportion to their free slots", () => {
    const p = new CapacityPlanner({ capacity, oversub: 1.5 });
    const r = rng(42);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const o = p.pick(modelMix(capacity, "codegen"), r);
      counts[o.key] = (counts[o.key] ?? 0) + 1;
    }
    const big = ["qwen2.5-coder:7b", "qwen3.5:9b", "deepseek-r1:14b", "qwen3-coder:30b"].map((k) => counts[k] ?? 0);
    const bigShare = big.reduce((a, b) => a + b, 0) / 4000;
    expect(bigShare).toBeGreaterThan(0.75); // the 1.5b fleet (27 in-flight allowance) gets the rest
    for (const n of big) expect(n / big.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.2); // equal slots, about equal share
  });

  it("never picks a model the buyer's own agents hold", () => {
    const p = new CapacityPlanner({ capacity });
    const r = rng(7);
    const avoid = new Set(["qwen2.5-coder:1.5b", "auto"]);
    for (let i = 0; i < 500; i++) expect(avoid.has(p.pick(modelMix(capacity, "chat"), r, avoid).key)).toBe(false);
  });

  it("sizes codegen calls by model: long for 7b+, short for small or CPU-only models", () => {
    expect(codegenSize("qwen3-coder:30b", capacity)).toEqual({ contextTokens: 3000, maxTokens: 640 });
    expect(codegenSize("qwen2.5-coder:7b", capacity)).toEqual({ contextTokens: 2000, maxTokens: 512 });
    expect(codegenSize("qwen2.5-coder:1.5b", capacity).maxTokens).toBe(256);
    expect(codegenSize("qwen2.5-coder:7b", { models: { "qwen2.5-coder:7b": { slots: 1, classes: ["cpu"] } } }).maxTokens).toBe(256);
    expect(paramsB("deepseek-r1:14b")).toBe(14);
    expect(codingContext("network/qwen3-coder:30b")).toBe(20_000);
  });

  it("makes a large, checkable codegen prompt", () => {
    const t = codegenTask(rng(3), 5, 2000);
    expect(t.contextTokens).toBeGreaterThan(1800);
    const name = /`(\w+Batch5)\(/.exec(t.messages[1].content)![1];
    const needle = /calls `(\w+)`/.exec(t.messages[1].content)![1];
    expect(t.ok(`export function ${name}(items, limit) { return items.map(${needle}); }`)).toBe(true);
    expect(t.ok("I cannot help")).toBe(false);
  });
});

describe("money report", () => {
  const acct = (accountId: string, cSats: number, earnedSats = 0) => ({ accountId, cSats, earnedSats });
  const host = (models: string[], cls = "cpu") => ({ agents: 1, connected: 1, classes: [cls], models });

  it("balances: buyer debit = host credits + 5% fee", () => {
    const before = { atMs: 1, accounts: { st11: acct("a11", 1000), st1: acct("a1", 100), st2: acct("a2", 100) }, hosts: { a1: host(["m:7b"]), a2: host(["m:14b"]) } };
    const after = { atMs: 2, accounts: { st11: acct("a11", 900), st1: acct("a1", 157), st2: acct("a2", 138) }, hosts: before.hosts };
    const charges = { st11: { calls: 10, ok: 10, cSats: 100, byModel: { "network/m:7b": { calls: 6, cSats: 60 }, "network/m:14b": { calls: 4, cSats: 40 } }, ownCalls: 0, ownCSats: 0, servedSeen: 0 } };
    const m = moneyReport({ before, after, charges });
    expect(m.totals).toMatchObject({ buyerDebits: 100, perCallCharges: 100, hostCreditsReadable: 95, impliedFee: 5, selfDealt: 0, movedBetweenAccounts: 100 });
    expect(m.conservation.ok).toBe(true);
    expect(m.flags).toEqual([]);
  });

  it("flags a gap: reserves still held by a buyer", () => {
    const before = { atMs: 1, accounts: { st11: acct("a11", 1000), st1: acct("a1", 0) }, hosts: { a1: host(["m:7b"]) } };
    const after = { atMs: 2, accounts: { st11: acct("a11", 880), st1: acct("a1", 95) }, hosts: before.hosts };
    const charges = { st11: { calls: 10, ok: 10, cSats: 100, byModel: { "network/m:7b": { calls: 10, cSats: 100 } } } };
    const m = moneyReport({ before, after, charges });
    expect(m.buyers[0].reserveGap).toBe(20);
    expect(m.flags.map((f: { kind: string }) => f.kind)).toEqual(expect.arrayContaining(["buyer_debit_exceeds_charges", "conservation_gap"]));
    expect(m.conservation.gap).toBeCloseTo(19);
  });

  it("splits an account that both buys and hosts, and counts self-dealing on its own models", () => {
    // st9 buys 50 (10 of it on 1.5b, which its own agent holds) and earns 9.5 + 19 as a host.
    const before = { atMs: 1, accounts: { st9: acct("a9", 1000), st10: acct("a10", 500) }, hosts: { a9: host(["m:1.5b"]), a10: host(["m:30b"], "gpu.dc") } };
    const charges = {
      st9: { calls: 5, ok: 5, cSats: 50, byModel: { "network/m:30b": { calls: 4, cSats: 40 }, "network/m:1.5b": { calls: 1, cSats: 10 } } },
      st10: { calls: 4, ok: 4, cSats: 20, byModel: { "network/m:1.5b": { calls: 4, cSats: 20 } } },
    };
    // st9: -50 + 9.5 (own 1.5b) + 19 (st10's 1.5b); st10: -20 + 38 (st9's 30b).
    const after = { atMs: 2, accounts: { st9: acct("a9", 978.5), st10: acct("a10", 518) }, hosts: before.hosts };
    const m = moneyReport({ before, after, charges });
    const st9 = m.buyers.find((b: { name: string }) => b.name === "st9");
    expect(st9).toMatchObject({ alsoHosts: true, debit: 50, creditAsHost: 28.5, selfDealt: 10, selfDealtExact: false });
    expect(m.totals).toMatchObject({ buyerDebits: 70, hostCreditsReadable: 66.5, impliedFee: 3.5, selfDealt: 10, selfDealtNetCost: 0.5, movedBetweenAccounts: 60 });
    expect(m.conservation.ok).toBe(true);
  });

  it("uses served.own when replies carry it", () => {
    const before = { atMs: 1, accounts: { st9: acct("a9", 1000) }, hosts: { a9: host(["m:1.5b"]) } };
    const after = { atMs: 2, accounts: { st9: acct("a9", 999.5) }, hosts: before.hosts };
    const charges = { st9: { calls: 2, ok: 2, cSats: 10, byModel: { "network/m:1.5b": { calls: 2, cSats: 10 } }, ownCalls: 1, ownCSats: 10, servedSeen: 2 } };
    const m = moneyReport({ before, after, charges });
    expect(m.buyers[0]).toMatchObject({ selfDealt: 10, selfDealtExact: true, creditAsHost: 9.5 });
  });

  it("attributes the remainder to hosts without a key, and flags it only when negative", () => {
    const before = { atMs: 1, accounts: { st9: acct("a9", 1000), st10: acct("a10", 0) }, hosts: { a10: host(["m:30b"], "gpu.dc"), owner: host(["m:7b"], "apple") } };
    const after = { atMs: 2, accounts: { st9: acct("a9", 900), st10: acct("a10", 38) }, hosts: before.hosts };
    const charges = { st9: { calls: 8, ok: 8, cSats: 100, byModel: { "network/m:30b": { calls: 4, cSats: 40 }, "network/m:7b": { calls: 4, cSats: 60 } } } };
    const m = moneyReport({ before, after, charges });
    expect(m.unreadableHosts[0]).toMatchObject({ accountId: "owner", couldServe: true });
    expect(m.totals.impliedUnreadableHostCredits).toBe(57);
    expect(m.conservation.ok).toBe(true);
    const greedy = moneyReport({ before, after: { ...after, accounts: { ...after.accounts, st10: acct("a10", 120) } }, charges });
    expect(greedy.conservation.ok).toBe(false);
  });

  it("merges per-buyer charges across machines and picks buyers that host nothing", () => {
    const c = chargesFrom([
      { users: [{ name: "st9", money: { calls: 2, ok: 2, cSats: 1.5, byModel: { a: { calls: 2, cSats: 1.5 } } } }] },
      { users: [{ name: "st9", money: { calls: 1, ok: 0, cSats: 0, byModel: { a: { calls: 1, cSats: 0 } } } }, { name: "st1" }] },
    ]);
    expect(c).toEqual({ st9: { calls: 3, ok: 2, cSats: 1.5, byModel: { a: { calls: 3, cSats: 1.5 } }, ownCalls: 0, ownCSats: 0, servedSeen: 0 } });
    const hosts = hostingFrom([{ agents: [{ agentId: "x", accountId: "a1", connected: true, computeClass: "cpu", modelsInstalled: ["m:1.5b"] }, { agentId: "x", accountId: "a1", connected: true }] }, null]);
    expect(hosts.a1).toEqual({ agents: 1, connected: 1, classes: ["cpu"], models: ["m:1.5b"] });
    const snap = { accounts: { st1: acct("a1", 5000), st11: acct("a11", 5000), st12: acct("a12", 10) }, hosts };
    expect(chooseBuyers(snap, { minBalance: 1000 }).buyers).toEqual(["st11"]);
    const all = chooseBuyers({ accounts: { st1: acct("a1", 5000) }, hosts }, { minBalance: 1000 });
    expect(all).toMatchObject({ buyers: ["st1"], avoid: { st1: ["m:1.5b"] } });
    expect(chooseBuyers(snap, { buyers: ["st1"] }).avoid).toEqual({ st1: ["m:1.5b"] });
  });
});

describe("slot utilization", () => {
  it("counts a machine's shared slots once across the models it holds", () => {
    const capacity = {
      models: { "a:7b": { slots: 4, classes: ["apple"] }, "b:14b": { slots: 4, classes: ["apple"] }, "c:30b": { slots: 1, classes: ["gpu.dc"] } },
      classes: { apple: { slots: 4 }, "gpu.dc": { slots: 1 } },
    };
    const p = new CapacityPlanner({ capacity });
    expect(p.utilization()).toBe(0);
    p.start("a:7b"); p.start("a:7b"); p.start("b:14b"); p.start("c:30b");
    expect(p.utilization()).toBeCloseTo(4 / 5); // 5 real slots, not 9
    expect(p.utilization(["c:30b"])).toBe(1);
    expect(new CapacityPlanner({ capacity }).utilization(["nothing"])).toBeNull();
  });
});
