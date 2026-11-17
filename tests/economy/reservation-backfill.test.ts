import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKFILL_CONFIG,
  backfillCallEligible,
  backfillConfigFromEnv,
  backfillGate,
  backfillSlotCap,
  capBackfillSplit,
  overrunBackfill,
  splitBackfillEarnings,
  type BackfillCandidate,
  type LeaseActivity,
} from "../../src/economy/reservation-backfill.js";
import { splitJobCost } from "../../src/economy/job-pricing.js";

// Reservation backfill rules (docs/reservation-backfill.md); the coordinator wiring is covered by
// tests/swarm/reservation-backfill-route.test.ts.

const cfg = DEFAULT_BACKFILL_CONFIG;
const idle = (over: Partial<LeaseActivity> = {}): LeaseActivity => ({ optedIn: true, healthy: true, leaseQueued: 0, leaseRunning: 0, backfillRunning: 0, slots: 1, ...over });
const call = (over: Partial<BackfillCandidate> = {}): BackfillCandidate => ({ kind: "inference", restricted: false, nwc: false, modelLoaded: true, tokensNeeded: 1_000, expectedSeconds: 3, ...over });

describe("reservation backfill: config", () => {
  it("defaults: on, opt-in by default, 50/50, 8192 tokens, 15 s, half the slots", () => {
    expect(backfillConfigFromEnv({})).toEqual({ enabled: true, defaultOn: true, holderShareBps: 5_000, maxTokens: 8_192, maxSeconds: 15, slotFraction: 0.5 });
  });

  it("reads RESERVATION_BACKFILL_*; an invalid value keeps its default", () => {
    expect(
      backfillConfigFromEnv({ RESERVATION_BACKFILL: "off", RESERVATION_BACKFILL_DEFAULT: "false", RESERVATION_BACKFILL_HOLDER_SHARE: "0.25", RESERVATION_BACKFILL_MAX_TOKENS: "4096", RESERVATION_BACKFILL_MAX_SECONDS: "10", RESERVATION_BACKFILL_SLOT_FRACTION: "0.75" })
    ).toEqual({ enabled: false, defaultOn: false, holderShareBps: 2_500, maxTokens: 4_096, maxSeconds: 10, slotFraction: 0.75 });
    expect(backfillConfigFromEnv({ RESERVATION_BACKFILL: "maybe", RESERVATION_BACKFILL_HOLDER_SHARE: "1.5", RESERVATION_BACKFILL_MAX_TOKENS: "10", RESERVATION_BACKFILL_MAX_SECONDS: "-1", RESERVATION_BACKFILL_SLOT_FRACTION: "x" })).toEqual(backfillConfigFromEnv({}));
    expect(backfillConfigFromEnv({ RESERVATION_BACKFILL_HOLDER_SHARE: "0" }).holderShareBps).toBe(0);
    expect(backfillConfigFromEnv({ RESERVATION_BACKFILL_HOLDER_SHARE: "1" }).holderShareBps).toBe(10_000);
  });
});

describe("reservation backfill: the split", () => {
  it("holder + host = agentMsat exactly, holder rounded down, for any cost, fee and share", () => {
    for (const cost of [0, 1, 2, 3, 7, 99, 1_000, 12_345, 987_654_321]) {
      for (const feeBps of [0, 500, 1_000]) {
        for (const share of [0, 1, 2_500, 3_333, 5_000, 9_999, 10_000]) {
          const { agentMsat, feeMsat } = splitJobCost(cost, feeBps);
          const { holderMsat, hostMsat } = splitBackfillEarnings(agentMsat, share);
          expect(holderMsat + hostMsat).toBe(agentMsat);
          expect(holderMsat + hostMsat + feeMsat).toBe(cost);
          expect(holderMsat).toBe(Math.floor((agentMsat * share) / 10_000));
          expect(Math.min(holderMsat, hostMsat)).toBeGreaterThanOrEqual(0);
        }
      }
    }
    expect(splitBackfillEarnings(9_500, 5_000)).toEqual({ holderMsat: 4_750, hostMsat: 4_750 });
    expect(splitBackfillEarnings(3, 5_000)).toEqual({ holderMsat: 1, hostMsat: 2 });
  });
});

describe("reservation backfill: slots", () => {
  it("half the slots, at least 1, and one always free on multi-slot agents", () => {
    expect([1, 2, 3, 4, 8, 16].map((n) => backfillSlotCap(n, 0.5))).toEqual([1, 1, 1, 2, 4, 8]);
    expect([1, 2, 4].map((n) => backfillSlotCap(n, 1))).toEqual([1, 1, 3]);
    expect(backfillSlotCap(8, 0)).toBe(0);
  });
});

describe("reservation backfill: eligibility and priority", () => {
  it("an idle, healthy, opted-in lease below its slot cap is open", () => {
    expect(backfillGate(idle(), cfg)).toEqual({ open: true });
    expect(backfillGate(idle({ slots: 4, backfillRunning: 1 }), cfg)).toEqual({ open: true });
  });

  it("opt-out and the kill switch close it", () => {
    expect(backfillGate(idle({ optedIn: false }), cfg)).toEqual({ open: false, reason: "not_opted_in" });
    expect(backfillGate(idle(), { ...cfg, enabled: false })).toEqual({ open: false, reason: "disabled" });
  });

  it("a queued or running lease job closes it (lease jobs first); so do ill health and the slot cap", () => {
    expect(backfillGate(idle({ leaseQueued: 1 }), cfg)).toEqual({ open: false, reason: "lease_job_waiting" });
    expect(backfillGate(idle({ leaseRunning: 1, slots: 8 }), cfg)).toEqual({ open: false, reason: "lease_job_running" });
    expect(backfillGate(idle({ healthy: false }), cfg)).toEqual({ open: false, reason: "unhealthy" });
    expect(backfillGate(idle({ slots: 1, backfillRunning: 1 }), cfg)).toEqual({ open: false, reason: "slot_cap" });
    expect(backfillGate(idle({ slots: 4, backfillRunning: 2 }), cfg)).toEqual({ open: false, reason: "slot_cap" });
  });

  it("only small, plain, already-loaded network model calls", () => {
    expect(backfillCallEligible(call(), cfg)).toEqual({ ok: true });
    expect(backfillCallEligible(call({ kind: "micro_loop" }), cfg)).toEqual({ ok: false, reason: "not_inference" });
    expect(backfillCallEligible(call({ reservationId: "r-other" }), cfg)).toEqual({ ok: false, reason: "lease_or_own_job" });
    expect(backfillCallEligible(call({ onlyAccountId: "acct" }), cfg)).toEqual({ ok: false, reason: "lease_or_own_job" });
    expect(backfillCallEligible(call({ restricted: true }), cfg)).toEqual({ ok: false, reason: "restricted" });
    expect(backfillCallEligible(call({ nwc: true }), cfg)).toEqual({ ok: false, reason: "nwc_billed" });
    expect(backfillCallEligible(call({ modelLoaded: false }), cfg)).toEqual({ ok: false, reason: "model_not_loaded" });
    expect(backfillCallEligible(call({ tokensNeeded: 8_193 }), cfg)).toEqual({ ok: false, reason: "too_many_tokens" });
    expect(backfillCallEligible(call({ tokensNeeded: Infinity }), cfg)).toEqual({ ok: false, reason: "too_many_tokens" });
    expect(backfillCallEligible(call({ expectedSeconds: 15.1 }), cfg)).toEqual({ ok: false, reason: "too_long" });
    expect(backfillCallEligible(call({ expectedSeconds: 15 }), cfg)).toEqual({ ok: true });
  });
});

describe("reservation backfill: preemption", () => {
  it("only calls past the cap, and only while a lease job waits", () => {
    const now = 100_000;
    const running = [{ id: "short", claimedAtMs: now - 5_000 }, { id: "long", claimedAtMs: now - 16_000 }];
    expect(overrunBackfill(running, 0, now, cfg)).toEqual([]);
    expect(overrunBackfill(running, 1, now, cfg).map((r) => r.id)).toEqual(["long"]);
  });
});

describe("reservation backfill: the holder's cap at the lease price", () => {
  it("below the cap the split is unchanged; at it the holder gets exactly the room; above it everything goes to the host", () => {
    expect(capBackfillSplit({ holderMsat: 400, hostMsat: 400 }, 0, 1_000)).toEqual({ holderMsat: 400, hostMsat: 400, cappedMsat: 0 });
    expect(capBackfillSplit({ holderMsat: 400, hostMsat: 400 }, 600, 1_000)).toEqual({ holderMsat: 400, hostMsat: 400, cappedMsat: 0 });
    expect(capBackfillSplit({ holderMsat: 400, hostMsat: 400 }, 700, 1_000)).toEqual({ holderMsat: 300, hostMsat: 500, cappedMsat: 100 });
    expect(capBackfillSplit({ holderMsat: 400, hostMsat: 400 }, 1_000, 1_000)).toEqual({ holderMsat: 0, hostMsat: 800, cappedMsat: 400 });
    expect(capBackfillSplit({ holderMsat: 400, hostMsat: 400 }, 5_000, 1_000)).toEqual({ holderMsat: 0, hostMsat: 800, cappedMsat: 400 });
    expect(capBackfillSplit({ holderMsat: 400, hostMsat: 400 }, 0, 0)).toEqual({ holderMsat: 0, hostMsat: 800, cappedMsat: 400 });
  });

  it("conserves holder + host for every input", () => {
    for (const holder of [0, 1, 7, 500]) for (const already of [0, 3, 499, 10_000]) for (const cap of [0, 1, 500, 20_000]) {
      const r = capBackfillSplit({ holderMsat: holder, hostMsat: 123 }, already, cap);
      expect(r.holderMsat + r.hostMsat).toBe(holder + 123);
      expect(r.holderMsat).toBeLessThanOrEqual(Math.max(0, cap - already));
    }
  });
});
