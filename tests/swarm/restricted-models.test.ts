import { describe, expect, it } from "vitest";
import {
  EntitlementBook,
  RestrictedCallLog,
  RestrictedCatalog,
  RestrictedRateLimiter,
  hostKindFor,
  normalizeModelTag,
  parseRestrictedModels,
  type RestrictedCallEvent
} from "../../src/swarm/restricted-models.js";
import { coordinatorConfigSchema } from "../../src/swarm/coordinator-config.js";

describe("RESTRICTED_MODELS_JSON", () => {
  it("is empty by default and maps normalised tags to a known tier", () => {
    expect(parseRestrictedModels(undefined).size).toBe(0);
    expect(parseRestrictedModels("  ").size).toBe(0);
    const m = parseRestrictedModels(JSON.stringify({ "Sec-Model": "security_research", "lab/sec:7b": "security_research" }));
    expect([...m.keys()].sort()).toEqual(["lab/sec:7b", "sec-model:latest"]);
    const c = new RestrictedCatalog(m);
    expect(c.tierOf("sec-model")).toBe("security_research");
    expect(c.tierOf("SEC-MODEL:latest")).toBe("security_research");
    expect(c.tierOf("sec-model:13b")).toBeUndefined();
    expect(c.tierOf(undefined)).toBeUndefined();
    expect(normalizeModelTag("host:5000/ns/m")).toBe("host:5000/ns/m:latest");
  });

  it("refuses anything it cannot read, so a restricted model is never served as an open one", () => {
    expect(() => parseRestrictedModels("[1]")).toThrow();
    expect(() => parseRestrictedModels("{nope")).toThrow();
    expect(() => parseRestrictedModels(JSON.stringify({ m: "unfiltered" }))).toThrow(/unknown tier/);
    expect(coordinatorConfigSchema.safeParse({ RESTRICTED_MODELS_JSON: "{bad" }).success).toBe(false);
    const ok = coordinatorConfigSchema.safeParse({ RESTRICTED_MODELS_JSON: JSON.stringify({ m: "security_research" }) });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.RESTRICTED_MODEL_LOG_PROMPTS).toBe(false);
  });
});

describe("EntitlementBook", () => {
  it("honours only active, unexpired entitlements the portal confirmed recently (fails closed)", () => {
    const b = new EntitlementBook(60_000);
    b.replaceAll([{ accountId: "a", kind: "security_research", expiresAtMs: 10_000, active: true }], 0);
    expect(b.valid("a", "security_research", 1)).toBe(true);
    expect(b.valid("a", hostKindFor("security_research"), 1)).toBe(false);
    expect(b.valid("b", "security_research", 1)).toBe(false);
    expect(b.valid(undefined, "security_research", 1)).toBe(false);
    expect(b.valid("a", "security_research", 10_000)).toBe(false); // expired
    b.replaceAll([{ accountId: "a", kind: "security_research", expiresAtMs: null, active: true }], 0);
    expect(b.valid("a", "security_research", 60_000)).toBe(true);
    expect(b.valid("a", "security_research", 60_001)).toBe(false); // stale: the portal has not confirmed it
    b.apply({ accountId: "a", kind: "security_research", expiresAtMs: null, active: true }, 60_001);
    expect(b.valid("a", "security_research", 60_002)).toBe(true);
    b.apply({ accountId: "a", kind: "security_research", expiresAtMs: null, active: false }, 60_003);
    expect(b.valid("a", "security_research", 60_004)).toBe(false);
  });
});

describe("RestrictedRateLimiter", () => {
  it("allows N calls per account per window", () => {
    const r = new RestrictedRateLimiter(2, 1_000);
    expect([r.take("a", 0), r.take("a", 1), r.take("a", 2), r.take("b", 2)]).toEqual([true, true, false, true]);
    expect(r.take("a", 1_001)).toBe(true);
  });
});

describe("RestrictedCallLog", () => {
  it("records submit, claim and end once, with token counts, to the sink", () => {
    const events: RestrictedCallEvent[] = [];
    const log = new RestrictedCallLog((e) => events.push(e), 2);
    log.submitted({ subtaskId: "s1", taskId: "t1", accountId: "a", model: "m", tier: "security_research", placement: "mine", submittedAtMs: 1 });
    log.claimed("s1", "agent-1", "a", 2);
    expect(log.get("s1")).toMatchObject({ agentId: "agent-1", claimedAtMs: 2 });
    expect(log.ended("s1", "ok", { promptTokens: 10, outputTokens: 4 }, 3)).toMatchObject({ outcome: "ok", endedAtMs: 3, promptTokens: 10 });
    expect(log.ended("s1", "failed", {}, 4)).toBeUndefined();
    expect(log.get("s1")).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["submitted", "claimed", "ended"]);
    expect(events[2].record).toMatchObject({ accountId: "a", model: "m", agentId: "agent-1", outputTokens: 4 });
    expect(log.recent()).toHaveLength(1);
  });
});
