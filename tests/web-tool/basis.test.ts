import { describe, expect, it } from "vitest";
import { freeWebUsageRecord, ownMachineBasis } from "../../src/web-tool/basis.js";
import { summarizeUsage, type UsageRecord } from "../../src/economy/usage.js";

// Free web on your own machine (docs/web-tool.md): who may claim it on the coordinator, and how free
// calls are kept (counted, no cSats).

describe("ownMachineBasis", () => {
  it("the portal's claim stands (it resolved the compute itself)", () => {
    expect(ownMachineBasis({ accountId: "acct-u1", via: "portal" }, true)).toEqual({ ownMachine: true });
  });

  it("no claim, no basis", () => {
    expect(ownMachineBasis({ accountId: "acct-u1", via: "portal" }, undefined)).toEqual({});
    expect(ownMachineBasis({ accountId: "acct-u1", via: "agent", agentId: "a1", ownerAccountId: "acct-u1" }, false)).toEqual({});
  });

  it("a signed agent linked to the billed account may claim it (the desktop's local model)", () => {
    expect(ownMachineBasis({ accountId: "acct-u1", via: "agent", agentId: "a1", ownerAccountId: "acct-u1" }, true)).toEqual({ ownMachine: true, agentId: "a1" });
  });

  it("an agent from another account, or one linked to no account, can't claim free", () => {
    expect(ownMachineBasis({ accountId: "acct-u1", via: "agent", agentId: "a2", ownerAccountId: "acct-other" }, true)).toEqual({});
    // Unlinked: billed to the agent id itself, no owner.
    expect(ownMachineBasis({ accountId: "a3", via: "agent", agentId: "a3", ownerAccountId: null }, true)).toEqual({});
  });
});

describe("free web usage records", () => {
  it("one record per account per day per coordinator, no cSats; the usage summary counts them apart from requests", () => {
    const rec = freeWebUsageRecord("acct-u1", { day: "2026-11-17", searches: 3, reads: 2 }, "coord-1", Date.UTC(2026, 10, 17, 12));
    expect(rec).toMatchObject({ id: "webfree:coord-1:acct-u1:2026-11-17", kind: "web", placement: "mine", costMsat: 0, webFree: { searches: 3, reads: 2 } });
    const call: UsageRecord = { id: "t1", accountId: "acct-u1", atMs: Date.UTC(2026, 10, 17, 11), kind: "inference", placement: "network", ok: true, durationMs: 1000, costMsat: 500 };
    const s = summarizeUsage([rec, call], Date.UTC(2026, 10, 16), Date.UTC(2026, 10, 17, 13));
    expect(s.totals.requests).toBe(1);
    expect(s.records.map((r) => r.id)).toEqual(["t1"]);
    expect(s.webFree).toEqual({ searches: 3, reads: 2 });
  });
});
