// Copyright (c) 2025 EdgeCoder, LLC
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
});
