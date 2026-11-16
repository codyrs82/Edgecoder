import { describe, expect, it } from "vitest";
import { CapacityPlanner, pickWithAutoShare } from "../../scripts/loadgen/planner.mjs";
import { chooseBuyers } from "../../scripts/loadgen/money.mjs";
import { modelMix, rng } from "../../scripts/loadgen/workload.mjs";

/*
 * --auto-share: a share of the calls goes out as model "auto", so a load test exercises best-fit
 * routing and fills the Network page's "Routing decisions"; the rest name a model as before.
 */

const capacity = { models: { "qwen2.5-coder:7b": { slots: 20, classes: ["apple"] }, "qwen3-coder:30b": { slots: 10, classes: ["gpu"] }, "qwen2.5-coder:1.5b": { slots: 30, classes: ["cpu"] } } };

function share(autoShare: number, avoid: Set<string> | null = null, n = 4_000) {
  const p = new CapacityPlanner({ capacity, autoShare, oversub: 1.5 });
  const r = rng(7);
  let auto = 0;
  for (let i = 0; i < n; i++) if (pickWithAutoShare(p, modelMix(capacity, "chat"), r, avoid, autoShare)?.key === "auto") auto++;
  return auto / n;
}

describe("loadgen auto share", () => {
  it("sends about the given share as auto (default 0.5), none at 0, all at 1", () => {
    expect(share(0.5)).toBeGreaterThan(0.45);
    expect(share(0.5)).toBeLessThan(0.55);
    expect(share(0.2)).toBeGreaterThan(0.16);
    expect(share(0.2)).toBeLessThan(0.24);
    expect(share(0)).toBe(0);
    expect(share(1)).toBe(1);
  });

  it("the model mix itself no longer carries auto; the share decides", () => {
    expect(modelMix(capacity, "chat")).not.toHaveProperty("auto");
  });

  it("auto's in-flight cap follows the share of every slot (at least auto-slots)", () => {
    expect(new CapacityPlanner({ capacity, autoShare: 0.5, oversub: 1.5 }).netCap.auto).toBe(Math.ceil(60 * 1.5 * 0.5));
    expect(new CapacityPlanner({ capacity, autoShare: 0, autoSlots: 3 }).netCap.auto).toBe(3);
  });

  it("when auto has no room the call names a model, and the other way round", () => {
    const p = new CapacityPlanner({ capacity, autoShare: 1, autoSlots: 1 });
    p.netCap.auto = 1;
    p.start("auto");
    const m = pickWithAutoShare(p, modelMix(capacity, "chat"), rng(1), null, 1);
    expect(m?.key).not.toBe("auto");
    const none = new CapacityPlanner({ capacity: { models: {} }, autoShare: 0.5 });
    expect(pickWithAutoShare(none, {}, rng(1), null, 0.5)?.key).toBe("auto");
  });

  it("buyers that host agents may use auto (best fit leaves their own agents out); they still avoid their own models", () => {
    const snap = { accounts: { st1: { accountId: "a1", cSats: 5000 } }, hosts: { a1: { agents: 1, connected: 1, classes: ["cpu"], models: ["qwen2.5-coder:1.5b"] } } };
    const { avoid } = chooseBuyers(snap, { minBalance: 1000 });
    expect(avoid.st1).toEqual(["qwen2.5-coder:1.5b"]);
    expect(share(0.5, new Set(avoid.st1))).toBeGreaterThan(0.45);
  });
});
