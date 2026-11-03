import { describe, expect, it } from "vitest";
import { MemoryUsageStore, summarizeUsage, type UsageRecord } from "../../src/economy/usage.js";

const day = 86_400_000;
const now = Date.UTC(2026, 10, 3, 12);
const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  id: Math.random().toString(36), accountId: "a", atMs: now, kind: "inference", placement: "network", model: "qwen3.5:9b",
  computeClass: "gpu", source: "Claude Code", ok: true, durationMs: 4000, costMsat: 200, ...over,
});

describe("usage", () => {
  it("totals, splits by model/class/source/placement, and fills every day", () => {
    const s = summarizeUsage(
      [
        rec({ atMs: now - 2 * day, costMsat: 1000, promptTokens: 2400, outputTokens: 200 }),
        rec({ model: "qwen2.5-coder:1.5b", computeClass: "apple", source: "EdgeCoder chat", costMsat: 100 }),
        rec({ placement: "mine", costMsat: 0, ok: false }),
        rec({ atMs: now - 40 * day, costMsat: 99_999 }),
      ],
      now - 6 * day,
      now,
    );
    expect(s.totals).toEqual({ requests: 3, cSats: 1.1, seconds: 12, failed: 1, promptTokens: 2400, outputTokens: 200 });
    expect(s.byDay).toHaveLength(7);
    expect(s.byDay.at(-1)).toMatchObject({ requests: 2, cSats: 0.1 });
    expect(s.byDay.at(-3)).toMatchObject({ requests: 1, cSats: 1 });
    expect(s.byModel[0]).toMatchObject({ key: "qwen3.5:9b", requests: 2, cSats: 1, promptTokens: 2400, outputTokens: 200 });
    expect(s.bySource.map((x) => x.key)).toEqual(["Claude Code", "EdgeCoder chat"]);
    expect(s.byPlacement.map((x) => x.key)).toEqual(["network", "mine"]);
    expect(s.records[0].atMs).toBe(now);
  });

  it("keeps only the newest rows in memory and filters by account", () => {
    const store = new MemoryUsageStore(2);
    store.add(rec({ id: "1", atMs: 1 }));
    store.add(rec({ id: "2", atMs: 2 }));
    store.add(rec({ id: "3", atMs: 3, accountId: "b" }));
    expect(store.forAccount("a", 0).map((r) => r.id)).toEqual(["2"]);
  });
});
