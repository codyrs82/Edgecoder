import { describe, expect, it } from "vitest";
import { ReservationBook, reservationPriceMsat, reservationUsage, type Reservation } from "../../src/economy/reservations.js";

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
