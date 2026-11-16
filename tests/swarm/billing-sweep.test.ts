import { describe, expect, it } from "vitest";
import { idleTaskBilling, sweepStaleTaskBilling, TASK_BILLING_IDLE_SWEEP_MS, TASK_BILLING_SWEEP_MIN_AGE_MS, type BillingSweepStore, type OpenTaskBillingRow } from "../../src/swarm/billing-sweep.js";

// Live regtest finding (2026-11-15): a deploy replaced the US seed while model calls were in
// flight. Billing is restored only at startup, and calls the outgoing instance had accepted after
// the incoming one restored stayed open: 10 reserves (up to 106 cSats each) were held until the
// next restart, about 9 minutes later. A periodic sweep now resumes or refunds open billing rows
// of this coordinator that no live process holds, under a lock so instances never sweep together.

const row = (taskId: string, createdAtMs: number): OpenTaskBillingRow => ({ taskId, accountId: "acct", kind: "inference", perSubtaskReserveMsat: 1000, subtaskIds: null, createdAtMs });

function store(rows: OpenTaskBillingRow[]) {
  let locked = false;
  const s: BillingSweepStore & { lock(): void; unlock(): void; asked: string[] } = {
    asked: [],
    lock: () => { locked = true; },
    unlock: () => { locked = false; },
    async listOpenTaskBilling(coordinatorId) { s.asked.push(coordinatorId); return rows; },
    async withTaskBillingSweepLock(_coordinatorId, fn) {
      if (locked) return { acquired: false };
      locked = true;
      try { return { acquired: true, value: await fn() }; } finally { locked = false; }
    }
  };
  return s;
}

describe("periodic task billing sweep", () => {
  const now = 10_000_000_000;
  it("restores only old rows that no live process holds", async () => {
    const st = store([row("old-orphan", now - TASK_BILLING_SWEEP_MIN_AGE_MS - 1), row("young", now - 60_000), row("old-live", now - 2 * TASK_BILLING_SWEEP_MIN_AGE_MS)]);
    const restored: string[][] = [];
    const r = await sweepStaleTaskBilling({ store: st, coordinatorId: "coord-a", isLive: (id) => id === "old-live", restore: async (rows) => { restored.push(rows.map((x) => x.taskId)); return { resumed: 0, refunded: rows.length, subtasksRestored: 0 }; }, nowMs: now });
    expect(restored).toEqual([["old-orphan"]]);
    expect(r).toMatchObject({ swept: 1, summary: { refunded: 1 } });
    expect(st.asked).toEqual(["coord-a"]);
  });

  it("skips when another process holds the sweep lock, and does nothing when nothing is stale", async () => {
    const st = store([row("old", 0)]);
    st.lock();
    let called = false;
    expect(await sweepStaleTaskBilling({ store: st, coordinatorId: "c", isLive: () => false, restore: async () => { called = true; return { resumed: 0, refunded: 0, subtasksRestored: 0 }; }, nowMs: now })).toEqual({ skipped: "locked", swept: 0 });
    expect(called).toBe(false);
    st.unlock();
    const fresh = store([row("young", now - 1000)]);
    expect(await sweepStaleTaskBilling({ store: fresh, coordinatorId: "c", isLive: () => false, restore: async () => { called = true; return { resumed: 0, refunded: 0, subtasksRestored: 0 }; }, nowMs: now })).toEqual({ swept: 0 });
    expect(called).toBe(false);
  });

  it("two sweeps at once: one restores, the other is turned away by the lock", async () => {
    const st = store([row("old", 0)]);
    let restores = 0;
    const restore = async (rows: OpenTaskBillingRow[]) => { restores++; await new Promise((r) => setTimeout(r, 10)); return { resumed: 0, refunded: rows.length, subtasksRestored: 0 }; };
    const [a, b] = await Promise.all([
      sweepStaleTaskBilling({ store: st, coordinatorId: "c", isLive: () => false, restore, nowMs: now }),
      sweepStaleTaskBilling({ store: st, coordinatorId: "c", isLive: () => false, restore, nowMs: now })
    ]);
    expect(restores).toBe(1);
    expect([a.skipped, b.skipped].filter(Boolean)).toEqual(["locked"]);
  });
});

// The #303 sweep skips anything this process holds in memory, so a reserve the process itself never
// settled (st1: a stuck 750-cSat model-call reserve) stayed held. The idle sweep settles those.
describe("idle in-memory billing sweep", () => {
  it("returns entries idle on two sweeps at least TASK_BILLING_IDLE_SWEEP_MS apart; busy entries reset", () => {
    const since = new Map<string, number>();
    const busy = new Set(["running"]);
    const run = (ids: string[], nowMs: number) => idleTaskBilling({ taskIds: ids, isBusy: (id) => busy.has(id), idleSince: since, nowMs });
    expect(run(["orphan", "running", "flaky"], 0)).toEqual([]);
    busy.add("flaky"); // had work again: its idle clock restarts
    expect(run(["orphan", "running", "flaky"], TASK_BILLING_IDLE_SWEEP_MS - 1)).toEqual([]);
    busy.delete("flaky");
    expect(run(["orphan", "running", "flaky"], TASK_BILLING_IDLE_SWEEP_MS)).toEqual(["orphan"]);
    expect(run(["orphan", "running", "flaky"], 2 * TASK_BILLING_IDLE_SWEEP_MS)).toEqual(["orphan", "flaky"]);
    // Settled entries leave the map.
    expect(run(["running"], 3 * TASK_BILLING_IDLE_SWEEP_MS)).toEqual([]);
    expect([...since.keys()]).toEqual([]);
  });
});
