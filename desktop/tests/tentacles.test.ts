import { describe, expect, it } from "vitest";
import { applyTentacleEvent, callLines, emptyTentacles, statusLabel, whereOf, type TentacleItem } from "../src/lib/tentacles";

const t = (over: Partial<TentacleItem> = {}): TentacleItem => ({ id: "t1", task: "Tests for x", kind: "tests", readOnly: false, status: "queued", progress: "queued", createdAt: 1, cSats: 0, ...over });
const ev = (type: string, rest: Record<string, unknown>) => ({ seq: 1, type, ...rest });

describe("tentacle tree state", () => {
  it("folds started, progress and finished events", () => {
    let s = applyTentacleEvent(emptyTentacles(), ev("tentacle_started", { tentacle: t() }));
    s = applyTentacleEvent(s, ev("tentacle_progress", { id: "t1", status: "running", progress: "edit_file a.ts", cSats: 0.5, model: "auto" }));
    expect(s.items[0]).toMatchObject({ status: "running", progress: "edit_file a.ts", cSats: 0.5 });
    s = applyTentacleEvent(s, ev("tentacle_finished", { tentacle: t({ status: "passed", cSats: 1, merge: { state: "awaiting_approval" }, result: { model: "m", class: "gpu", summary: "", filesTouched: [], patch: "", attempts: 1 } }) }));
    expect(s.items).toHaveLength(1);
    expect(statusLabel(s.items[0])).toBe("passed · waiting for approval");
    expect(whereOf(s.items[0])).toBe("m on gpu");
    expect(s.spentCSats).toBe(1);
  });
});

describe("tentacle served lines (5)", () => {
  it("keeps each helper call's served line and the merged totals", () => {
    const served = { label: "lin-•••3f2a", own: false, computeClass: "gpu", tier: "gpu.dc40", hardware: "Datacenter GPU (gpu.dc40)", region: "ord", city: "Chicago", country: "US", promptTokens: 1200, outputTokens: 80 };
    let s = applyTentacleEvent(emptyTentacles(), ev("tentacle_started", { tentacle: t({ status: "running" }) }));
    s = applyTentacleEvent(s, ev("tentacle_usage", { id: "t1", call: { cSats: 1.2, model: "qwen3-coder:30b", served }, cSats: 1.2, spentCSats: 1.2 }));
    s = applyTentacleEvent(s, ev("tentacle_usage", { id: "t1", call: { cSats: 0.8, model: "qwen3-coder:30b", served: { ...served, promptTokens: 900, outputTokens: 20 } }, cSats: 2, spentCSats: 2 }));
    expect(s.items[0].cSats).toBe(2);
    expect(s.spentCSats).toBe(2);
    const lines = callLines(s.items[0]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("qwen3-coder:30b · Datacenter GPU (gpu.dc40) · Chicago · read 1.2k tok · wrote 80 tok · 1.2 cSats");
    s = applyTentacleEvent(s, ev("tentacle_totals", { totals: { line: "1 helper · 2 calls · 2.0 cSats" }, session: { line: "2 helpers · 3 calls · 2.5 cSats" } }));
    expect(s.totals).toEqual({ batch: "1 helper · 2 calls · 2.0 cSats", session: "2 helpers · 3 calls · 2.5 cSats" });
  });
});

describe("where each helper call ran (local first)", () => {
  it("leads each served line with this computer or the network", () => {
    const local = { label: "This computer", own: true, computeClass: "local", tier: null, hardware: "This computer", region: null, country: null, promptTokens: 900, outputTokens: 30 };
    const gpu = { label: "lin-•••3f2a", own: false, computeClass: "gpu", tier: "gpu.dc40", hardware: "Datacenter GPU (gpu.dc40)", region: "ord", city: "Chicago", country: "US", promptTokens: 1200, outputTokens: 80 };
    let s = applyTentacleEvent(emptyTentacles(), ev("tentacle_started", { tentacle: t({ status: "running" }) }));
    s = applyTentacleEvent(s, ev("tentacle_usage", { id: "t1", call: { cSats: 0, model: "qwen3.5:9b", place: "local", served: local }, cSats: 0, spentCSats: 0 }));
    s = applyTentacleEvent(s, ev("tentacle_usage", { id: "t1", call: { cSats: 1.2, model: "qwen3-coder:30b", place: "network", served: gpu }, cSats: 1.2, spentCSats: 1.2 }));
    const [a, b] = callLines(s.items[0]);
    expect(a).toMatch(/^this computer · qwen3\.5:9b · /);
    expect(a).toMatch(/free$/);
    expect(b).toMatch(/^network · qwen3-coder:30b · Datacenter GPU/);
  });
});
