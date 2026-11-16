// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from "vitest";
import { createChatCapacityDirectory, type CapacityReport } from "../../src/portal/chat-capacity.js";

// Found on the live regtest network (2026-11-15): 24 concurrent API calls all went to the first
// coordinator while the other seed's agents sat idle. Inference runs where it is submitted, so the
// portal's pick is what spreads load.
const US = "https://us.example";
const EU = "https://eu.example";
const MODEL = "qwen2.5-coder:1.5b";

function directory(reports: Record<string, CapacityReport>) {
  return createChatCapacityDirectory({ candidates: async () => [US, EU], allowed: () => true, probe: async (url) => reports[url], ttlMs: 60_000 });
}
const report = (idle: number, waiting = 0): CapacityReport => ({ reachable: true, agentModels: [MODEL], modelLoad: { [MODEL]: { idle, waiting } } });

describe("load-aware coordinator pick for network calls", () => {
  it("prefers the coordinator with more free agents for the model", async () => {
    const d = directory({ [US]: report(1), [EU]: report(3) });
    expect((await d.pick({ kind: "network", model: MODEL })).url).toBe(EU);
  });

  it("counts waiting calls against idle agents", async () => {
    const d = directory({ [US]: report(4, 4), [EU]: report(2) });
    expect((await d.pick({ kind: "network", model: MODEL })).url).toBe(EU);
  });

  it("spreads a burst inside one report window instead of piling onto one seed", async () => {
    const d = directory({ [US]: report(7), [EU]: report(2) });
    const picks: string[] = [];
    for (let i = 0; i < 12; i++) picks.push((await d.pick({ kind: "network", model: MODEL })).url!);
    const eu = picks.filter((u) => u === EU).length;
    expect(picks.slice(0, 5).every((u) => u === US)).toBe(true);
    expect(eu).toBeGreaterThanOrEqual(3);
    expect(picks.filter((u) => u === US).length).toBeGreaterThan(eu);
  });

  it("keeps the configured order on a tie", async () => {
    const d = directory({ [US]: report(2), [EU]: report(2) });
    expect((await d.pick({ kind: "network", model: MODEL })).url).toBe(US);
  });

  it("skips a coordinator a call just failed on", async () => {
    const d = directory({ [US]: report(9), [EU]: report(1) });
    d.markFailed(US);
    expect((await d.pick({ kind: "network", model: MODEL })).url).toBe(EU);
  });

  it("falls back to the configured order when no coordinator reports load (older builds)", async () => {
    const d = directory({ [US]: { reachable: true, agentModels: [MODEL] }, [EU]: { reachable: true, agentModels: [MODEL] } });
    expect((await d.pick({ kind: "network", model: MODEL })).url).toBe(US);
  });

  it("does not send a call for a model to a coordinator whose agents lack it", async () => {
    const d = directory({ [US]: report(5), [EU]: { reachable: true, agentModels: ["other"], modelLoad: { other: { idle: 9, waiting: 0 } } } });
    expect((await d.pick({ kind: "network", model: MODEL })).url).toBe(US);
  });
  // Probe on the live regtest network (2026-11-15, after fast dispatch): every agent on both seeds
  // held one call, so both reported 0 idle agents; the tie went to whichever was listed first and the
  // 2-agent EU seed queued calls for 5 s (pickup p90) while the 7-agent US seed had free slots.
  const slots = (agents: number, idle: number, free: number, waiting = 0): CapacityReport => ({ reachable: true, agentModels: [MODEL], modelLoad: { [MODEL]: { agents, idle, free, waiting } } });

  it("compares free model slots, not idle agents, when the coordinator reports them", async () => {
    const d = directory({ [EU]: slots(2, 0, 1), [US]: slots(7, 0, 6) });
    const dEuFirst = createChatCapacityDirectory({ candidates: async () => [EU, US], allowed: () => true, probe: async (url) => (url === EU ? slots(2, 0, 1) : slots(7, 0, 6)), ttlMs: 60_000 });
    expect((await d.pick({ kind: "network", model: MODEL })).url).toBe(US);
    expect((await dEuFirst.pick({ kind: "network", model: MODEL })).url).toBe(US);
  });

  it("when both are full, sends the call to the coordinator with more agents, whatever the order", async () => {
    const d = createChatCapacityDirectory({ candidates: async () => [EU, US], allowed: () => true, probe: async (url) => (url === EU ? slots(2, 0, 0) : slots(7, 0, 0)), ttlMs: 60_000 });
    expect((await d.pick({ kind: "network", model: MODEL })).url).toBe(US);
  });

  it("spreads a burst by slots: the 7-agent seed takes most of 12 calls", async () => {
    const d = createChatCapacityDirectory({ candidates: async () => [EU, US], allowed: () => true, probe: async (url) => (url === EU ? slots(2, 2, 4) : slots(7, 7, 14)), ttlMs: 60_000 });
    const picks: string[] = [];
    for (let i = 0; i < 12; i++) picks.push((await d.pick({ kind: "network", model: MODEL })).url!);
    const eu = picks.filter((u) => u === EU).length;
    expect(eu).toBeLessThanOrEqual(3);
    expect(picks.slice(0, 8).every((u) => u === US)).toBe(true);
  });
  // Live probe after #287: under sustained load both seeds' counts went negative (calls sent since a
  // 15 s report were all still counted), and evening out the absolute backlog sent the 2-agent EU
  // seed about a third of all calls (pickup p50 1.8 s there, 0.2 s on the 7-agent US seed).
  it("when every coordinator is busy, shares calls in proportion to agents", async () => {
    let t = 0;
    const d = createChatCapacityDirectory({ candidates: async () => [EU, US], allowed: () => true, now: () => t, probe: async (url) => (url === EU ? slots(2, 0, 0, 4) : slots(7, 0, 0, 4)), ttlMs: 60_000 });
    const picks: string[] = [];
    for (let i = 0; i < 18; i++) picks.push((await d.pick({ kind: "network", model: MODEL })).url!);
    const eu = picks.filter((u) => u === EU).length;
    // 2 of 9 agents: about 2/9 of the calls (4 of 18), not half.
    expect(eu).toBeGreaterThanOrEqual(2);
    expect(eu).toBeLessThanOrEqual(5);
  });

  it("re-reads load after a couple of seconds, so finished calls stop counting", async () => {
    let t = 0;
    let usFree = 0;
    const d = createChatCapacityDirectory({ candidates: async () => [US, EU], allowed: () => true, now: () => t, probe: async (url) => (url === EU ? slots(2, 0, 3) : slots(7, 0, usFree)), ttlMs: 60_000 });
    expect((await d.pick({ kind: "network", model: MODEL })).url).toBe(EU);
    usFree = 10; // the US calls finished
    t += 2_500;
    expect((await d.pick({ kind: "network", model: MODEL })).url).toBe(US);
  });
});
