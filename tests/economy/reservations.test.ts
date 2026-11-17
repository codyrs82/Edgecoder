import { describe, expect, it } from "vitest";
import { ReservationBook, dueReservations, offlineEndMs, reservationPriceMsat, reservationUsage, type Reservation } from "../../src/economy/reservations.js";

const base = (over: Partial<Reservation> = {}): Reservation => ({
  id: "r1", accountId: "acct", agentId: "gpu-1", agentAccountId: "owner", computeClass: "gpu", creditsPerSecond: 2,
  startMs: 0, endMs: 600_000, ratePerSecondMsat: 100, prepaidMsat: 60_000, status: "active", ...over,
});

describe("reservations", () => {
  it("prices every held second up front", () => {
    expect(reservationPriceMsat(10, 100)).toBe(60_000);
  });

  it("charges only the time held and refunds the rest", () => {
    expect(reservationUsage(base(), 150_000)).toEqual({ usedMsat: 15_000, refundMsat: 45_000 });
    expect(reservationUsage(base(), 9_999_999)).toEqual({ usedMsat: 60_000, refundMsat: 0 });
  });

  it("holds the agent only while active", () => {
    const book = new ReservationBook();
    book.add(base());
    expect(book.isHeld("gpu-1", 1000)).toBe(true);
    expect(book.isHeld("gpu-1", 600_000)).toBe(false);
    expect(book.isHeld("gpu-2", 1000)).toBe(false);
  });

  it("ends leases that ran out or whose agent went offline, once", () => {
    const book = new ReservationBook();
    book.add(base());
    book.add(base({ id: "r2", agentId: "gpu-2" }));
    const seen = (id: string) => (id === "gpu-1" ? 290_000 : 0);
    const due = book.due(300_000, seen);
    expect(due.map((d) => [d.r.id, d.reason])).toEqual([["r2", "agent_offline"]]);
    const ended = book.end("r2", 300_000, "agent_offline")!;
    expect(ended).toMatchObject({ status: "ended", usedMsat: 30_000, refundMsat: 30_000 });
    expect(book.end("r2", 400_000, "cancelled")).toBeUndefined();
    expect(book.due(700_000, () => 699_000).map((d) => [d.r.id, d.reason])).toEqual([["r1", "expired"]]);
    expect(book.end("r1", 900_000, "expired")).toMatchObject({ usedMsat: 60_000, refundMsat: 0, endedAtMs: 600_000 });
  });

  it("lists an account's leases newest first", () => {
    const book = new ReservationBook();
    book.add(base({ id: "a", startMs: 1 }));
    book.add(base({ id: "b", startMs: 2 }));
    book.add(base({ id: "c", accountId: "other" }));
    expect(book.listForAccount("acct", 10).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("offline leases are billed to the agent's last heartbeat", () => {
  // 10 min lease at 100 msat/s, started at 0.
  it("offline at 30 s, noticed at 160 s: billed 30 s, the rest refunded", () => {
    const book = new ReservationBook();
    book.add(base());
    const due = book.due(160_000, () => 30_000);
    expect(due.map((d) => [d.r.id, d.reason, d.atMs])).toEqual([["r1", "agent_offline", 30_000]]);
    const ended = book.end("r1", due[0].atMs, "agent_offline")!;
    expect(ended).toMatchObject({ endedAtMs: 30_000, usedMsat: 3_000, refundMsat: 57_000 });
  });

  it("clamped to the lease: last seen before it started bills nothing; an expired lease bills to its end", () => {
    expect(offlineEndMs(base({ startMs: 50_000 }), 10_000, 300_000)).toBe(50_000);
    expect(offlineEndMs(base(), 900_000, 900_000)).toBe(600_000);
    const book = new ReservationBook();
    book.add(base());
    expect(book.due(700_000, () => 650_000)).toEqual([expect.objectContaining({ reason: "expired", atMs: 600_000 })]);
  });

  it("no last-seen time known (unseen, or 0 after a clean goodbye): falls back to when it was noticed", () => {
    expect(offlineEndMs(base(), undefined, 160_000)).toBe(160_000);
    expect(offlineEndMs(base(), 0, 160_000)).toBe(160_000);
    const book = new ReservationBook();
    book.add(base());
    expect(book.due(160_000, () => undefined)[0].atMs).toBe(160_000);
  });

  it("the shared store's newer heartbeat wins over this coordinator's view", async () => {
    const book = new ReservationBook();
    book.add(base());
    const store = { listReservations: async () => [], getReservation: async () => null, endReservationIfActive: async () => true, agentLastSeenMs: async () => new Map([["gpu-1", 45_000]]) };
    const due = await dueReservations(book, store, 200_000, () => 20_000);
    expect(due.map((d) => d.atMs)).toEqual([45_000]);
  });
});
