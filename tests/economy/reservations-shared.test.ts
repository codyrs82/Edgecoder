import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ReservationBook,
  claimReservationEnd,
  dueReservations,
  syncReservations,
  type Reservation,
  type SharedReservationStore
} from "../../src/economy/reservations.js";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";

// Two seeds (US, EU) each hold a ReservationBook. A lease made on one must be known to the other,
// must not be ended "agent_offline" by the seed the agent isn't connected to, and is settled once.

const lease = (over: Partial<Reservation> = {}): Reservation => ({
  id: `res-${randomUUID()}`, accountId: "acct-req", agentId: "gpu-on-us", agentAccountId: "acct-owner", computeClass: "gpu",
  creditsPerSecond: 2, startMs: 0, endMs: 3_600_000, ratePerSecondMsat: 100, prepaidMsat: 360_000, status: "active", ...over,
});

function memoryStore(): SharedReservationStore & { rows: Map<string, Reservation>; seen: Map<string, number> } {
  const rows = new Map<string, Reservation>();
  const seen = new Map<string, number>();
  return {
    rows,
    seen,
    async listReservations() { return [...rows.values()].map((r) => ({ ...r })); },
    async getReservation(id) { const r = rows.get(id); return r ? { ...r } : null; },
    async endReservationIfActive(ended) {
      const cur = rows.get(ended.id);
      if (cur && cur.status !== "active") return false;
      rows.set(ended.id, { ...ended });
      return true;
    },
    async agentLastSeenMs(ids) { return new Map(ids.filter((id) => seen.has(id)).map((id) => [id, seen.get(id)!])); },
  };
}

describe("reservations shared between coordinators", () => {
  it("the seed without the agent uses the shared heartbeat instead of ending the lease as offline", async () => {
    const store = memoryStore();
    const us = new ReservationBook();
    const eu = new ReservationBook();
    const r = lease();
    us.add(r);
    store.rows.set(r.id, { ...r });
    await syncReservations(eu, store);
    expect(eu.get(r.id)?.status).toBe("active");

    store.seen.set("gpu-on-us", 290_000); // heartbeats recorded by US
    const euDue = await dueReservations(eu, store, 300_000, () => undefined); // EU never saw the agent
    expect(euDue).toEqual([]);
    // Before: EU's own registry had no heartbeat, so the lease was "agent_offline" at once.
    expect(eu.due(300_000, () => undefined).map((d) => d.reason)).toEqual(["agent_offline"]);
  });

  it("only one seed wins the end; the other takes the stored copy", async () => {
    const store = memoryStore();
    const us = new ReservationBook();
    const eu = new ReservationBook();
    const r = lease();
    store.rows.set(r.id, { ...r });
    await syncReservations(us, store);
    await syncReservations(eu, store);

    const [a, b] = await Promise.all([
      claimReservationEnd(us, store, r.id, 3_600_000, "expired"),
      claimReservationEnd(eu, store, r.id, 1_200_000, "cancelled"),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(us.get(r.id)).toEqual(store.rows.get(r.id));
    expect(eu.get(r.id)).toEqual(store.rows.get(r.id));
    expect(us.isHeld("gpu-on-us", 1000)).toBe(false);
  });

  it("a store error leaves the lease active so the next tick retries", async () => {
    const store = memoryStore();
    const book = new ReservationBook();
    const r = lease();
    book.add(r);
    store.endReservationIfActive = async () => { throw new Error("db_down"); };
    await expect(claimReservationEnd(book, store, r.id, 10_000, "cancelled")).rejects.toThrow("db_down");
    expect(book.get(r.id)?.status).toBe("active");
  });
});

describe.skipIf(!PG_URL)("reservations on one Postgres shared by two coordinators", () => {
  let db: SharedDb;
  beforeAll(async () => { db = await twoCoordinatorsOneDatabase(); });
  afterAll(async () => { await db?.close(); });

  it("a lease made on US is visible on EU, kept alive by US heartbeats, and ended exactly once", async () => {
    const us = new ReservationBook();
    const eu = new ReservationBook();
    const now = Date.now();
    const r = lease({ startMs: now, endMs: now + 3_600_000 });
    us.add(r);
    await db.a.upsertReservation(r);
    await db.a.upsertAgent({ agentId: "gpu-on-us", os: "linux", version: "1", mode: "swarm-only", localModelEnabled: true, lastSeenMs: now });

    await syncReservations(eu, db.b);
    expect(eu.get(r.id)?.status).toBe("active");
    expect(await dueReservations(eu, db.b, now + 30_000, () => undefined)).toEqual([]);

    // Both seeds race to end it (US: expired timer, EU: the requester cancels through the portal).
    const results = await Promise.all([
      claimReservationEnd(us, db.a, r.id, now + 3_600_000, "expired"),
      claimReservationEnd(eu, db.b, r.id, now + 600_000, "cancelled"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await db.a.getReservation(r.id);
    expect(stored?.status).toBe("ended");
    expect(us.get(r.id)).toEqual(stored);
    expect(eu.get(r.id)).toEqual(stored);
    expect(await db.b.endReservationIfActive({ ...stored!, endReason: "agent_offline" })).toBe(false);
  });
});
