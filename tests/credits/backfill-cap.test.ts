import { beforeAll, describe, expect, it } from "vitest";

/*
 * Reservation backfill (docs/reservation-backfill.md): the holder's total backfill credit on one
 * lease never exceeds the lease price, even with several accruals settling at once; past the cap
 * the holder's share goes to the host and holder + host + fee is still the cost to the msat.
 * In-memory ledger (no DATABASE_URL); on Postgres the same read-and-write runs under a per-lease
 * advisory lock in the accrual's transaction (PostgresStore.persistContributionWithCredit).
 */

let store: typeof import("../../src/credits/store.js");
beforeAll(async () => {
  delete process.env.DATABASE_URL;
  store = await import("../../src/credits/store.js");
});

const report = (id: string) => ({
  reportId: `result:${id}`, agentId: "host-acct", sourceAgentId: "agent-1", taskId: `task-${id}`, resourceClass: "gpu" as const,
  cpuSeconds: 0, gpuSeconds: 1, success: true, qualityScore: 1, timestampMs: Date.now(), hardwareWeight: 1,
});

async function accrue(lease: string, holder: string, id: string, agentMsat: number, capMsat: number) {
  const holderMsat = Math.floor(agentMsat / 2);
  const bf: { reservationId: string; holderAccountId: string; holderMsat: number; hostMsat: number; holderCapMsat: number; cappedMsat?: number } = {
    reservationId: lease, holderAccountId: holder, holderMsat, hostMsat: agentMsat - holderMsat, holderCapMsat: capMsat,
  };
  const tx = await store.accruePricedJob(report(id), { agentMsat, feeMsat: 100 }, bf);
  return { tx, bf };
}
const holderTotal = (holder: string, lease: string) =>
  store.creditEngine.history(holder).filter((t) => t.reason === `reservation_backfill_holder:${lease}`).reduce((n, t) => n + (t.msat ?? 0), 0);
const rowsOf = (id: string, account: string) => store.creditEngine.history(account).filter((t) => t.relatedTaskId === `task-${id}`);

describe("backfill holder cap", () => {
  it("below the cap: the normal split", async () => {
    const { bf } = await accrue("L-below", "holder-below", "below-1", 1_000, 10_000);
    expect(bf).toMatchObject({ holderMsat: 500, hostMsat: 500, cappedMsat: 0 });
    expect(holderTotal("holder-below", "L-below")).toBe(500);
  });

  it("exactly at the cap: the holder reaches it, nothing moves to the host", async () => {
    await accrue("L-at", "holder-at", "at-1", 1_000, 1_000);
    const { bf } = await accrue("L-at", "holder-at", "at-2", 1_000, 1_000);
    expect(bf).toMatchObject({ holderMsat: 500, hostMsat: 500, cappedMsat: 0 });
    expect(holderTotal("holder-at", "L-at")).toBe(1_000);
    // One more: all of the holder's share goes to the host, and no holder row is written.
    const third = await accrue("L-at", "holder-at", "at-3", 1_000, 1_000);
    expect(third.bf).toMatchObject({ holderMsat: 0, hostMsat: 1_000, cappedMsat: 500 });
    expect(rowsOf("at-3", "holder-at")).toEqual([]);
    expect(rowsOf("at-3", "host-acct").map((t) => [t.reason, t.msat])).toEqual([["reservation_backfill_host:L-at", 1_000]]);
  });

  it("above the cap across many concurrent accruals: the holder gets exactly the cap, conserved per call", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => accrue("L-race", "holder-race", `race-${i}`, 999, 3_000)));
    expect(holderTotal("holder-race", "L-race")).toBe(3_000);
    for (const [i, r] of results.entries()) {
      expect(r.bf.holderMsat + r.bf.hostMsat).toBe(999);
      const holderRow = rowsOf(`race-${i}`, "holder-race")[0]?.msat ?? 0;
      const hostRow = rowsOf(`race-${i}`, "host-acct")[0]?.msat ?? 0;
      expect(holderRow + hostRow).toBe(999);
      expect(holderRow).toBe(r.bf.holderMsat);
    }
    expect(results.reduce((n, r) => n + (r.bf.cappedMsat ?? 0), 0)).toBe(20 * 499 - 3_000);
  });

  it("the cap is per lease: another lease of the same holder has its own room", async () => {
    await accrue("L-a", "holder-two", "two-1", 1_000, 500);
    const { bf } = await accrue("L-b", "holder-two", "two-2", 1_000, 500);
    expect(bf).toMatchObject({ holderMsat: 500, cappedMsat: 0 });
  });
});
