import { describe, expect, it } from "vitest";
import { budgetState, cSatsPerMillionTokens, monthToDate, usageCsv } from "../src/lib/usage-view";

describe("usage view", () => {
  it("warns near and over the monthly budget", () => {
    expect(budgetState(50, null).level).toBe("none");
    expect(budgetState(50, 100)).toEqual({ level: "ok", percent: 50 });
    expect(budgetState(85, 100).level).toBe("near");
    expect(budgetState(120, 100).level).toBe("over");
  });

  it("adds up this month only", () => {
    expect(monthToDate([{ day: "2026-10-31", cSats: 9 }, { day: "2026-11-01", cSats: 1.5 }, { day: "2026-11-02", cSats: 2 }], new Date(2026, 10, 2))).toBe(3.5);
  });

  it("prices a million tokens at the real rate", () => {
    expect(cSatsPerMillionTokens({ cSats: 2.7, promptTokens: 0, outputTokens: 1000 })).toBe(2700);
    expect(cSatsPerMillionTokens({ cSats: 1, promptTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it("exports CSV with quoting", () => {
    const csv = usageCsv([{ id: "1", atMs: Date.UTC(2026, 10, 2), kind: "inference", placement: "network", model: "m", computeClass: "gpu", source: 'Claude "Code"', ok: true, durationMs: 1500, costMsat: 420, promptTokens: 10, outputTokens: 5 }]);
    expect(csv.split("\n")[1]).toBe('2026-11-02T00:00:00.000Z,inference,network,gpu,m,"Claude ""Code""",,true,1.5,10,5,0.420');
  });
});
