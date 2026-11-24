import { describe, expect, it } from "vitest";
import { nextDayMs, nextMonthMs, SpendGuard, type SpendEvent, type SpendState } from "../../src/cloud-host/spend-guard.js";

/*
 * The cloud host's spend caps: an alert at 80 % of the daily / monthly cap (once per period), a
 * pause at 100 % that lifts when the UTC period ends, a pause after repeated auth failures that
 * lifts when the key works again, and totals that survive a restart.
 */

const T0 = Date.UTC(2026, 10, 23, 10, 0, 0); // 2026-11-23 10:00 UTC

function guard(opts: { now: { t: number }; daily?: number; monthly?: number; store?: { s?: SpendState } }) {
  const events: SpendEvent[] = [];
  const g = new SpendGuard(
    { dailyCapUsd: opts.daily ?? 200, monthlyCapUsd: opts.monthly ?? 2_000, alertAtPct: 0.8, authFailureLimit: 3 },
    { now: () => opts.now.t, notify: (e) => events.push(e), load: () => opts.store?.s, save: (s) => opts.store && (opts.store.s = structuredClone(s)) }
  );
  return { g, events };
}

describe("spend guard", () => {
  it("warns once at 80 % of the daily cap, pauses at 100 %, and resumes the next UTC day", () => {
    const now = { t: T0 };
    const { g, events } = guard({ now });
    g.record(150);
    expect(events).toEqual([]);
    g.record(15); // 165 >= 160
    expect(events).toEqual([{ kind: "warn", scope: "day", spentUsd: 165, capUsd: 200 }]);
    g.record(10);
    expect(events).toHaveLength(1); // no second warning the same day
    expect(g.canServe()).toBe(true);
    g.record(30); // 205
    expect(events.at(-1)).toEqual({ kind: "paused", reason: "daily_cap", spentUsd: 205, capUsd: 200, resumesAtMs: nextDayMs(now.t) });
    expect(g.canServe()).toBe(false);
    expect(g.pausedError()).toBe("cloud_capacity_paused: the daily cloud spend cap is reached; resumes at 2026-11-24T00:00:00.000Z");
    now.t = Date.UTC(2026, 10, 24, 0, 0, 1);
    expect(g.canServe()).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "resumed", reason: "daily_cap" });
    expect(g.status()).toMatchObject({ paused: false, dayUsd: 0, monthUsd: 205 });
    // A new day warns again.
    g.record(170);
    expect(events.at(-1)).toMatchObject({ kind: "warn", scope: "day" });
  });

  it("the monthly cap pauses across days until the next UTC month", () => {
    const now = { t: T0 };
    const { g, events } = guard({ now, daily: 1_000, monthly: 1_500 });
    g.record(900);
    now.t += 86_400_000;
    g.record(300); // month 1200 >= 80 % of 1500
    expect(events.at(-1)).toMatchObject({ kind: "warn", scope: "month", spentUsd: 1_200 });
    g.record(350); // month 1550
    expect(events.at(-1)).toMatchObject({ kind: "paused", reason: "monthly_cap", resumesAtMs: nextMonthMs(now.t) });
    now.t += 86_400_000; // a new day does not lift a monthly pause
    expect(g.canServe()).toBe(false);
    expect(g.pausedError()).toMatch(/monthly cloud spend cap is reached; resumes at 2026-12-01T00:00:00.000Z/);
    now.t = Date.UTC(2026, 11, 1, 0, 0, 1);
    expect(g.canServe()).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "resumed", reason: "monthly_cap" });
  });

  it("repeated auth failures pause until the key works again", () => {
    const now = { t: T0 };
    const { g, events } = guard({ now });
    g.noteAuthFailure();
    g.noteAuthFailure();
    expect(g.canServe()).toBe(true);
    g.noteAuthFailure();
    expect(events).toEqual([{ kind: "paused", reason: "auth", failures: 3 }]);
    expect(g.status()).toMatchObject({ paused: true, reason: "auth" });
    expect(g.pausedError()).toMatch(/^cloud_capacity_paused: the cloud provider is refusing the platform's API key/);
    g.noteAuthFailure(); // no second alert
    expect(events).toHaveLength(1);
    g.noteAuthOk();
    expect(g.canServe()).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "resumed", reason: "auth" });
  });

  it("a success between failures resets the count", () => {
    const { g, events } = guard({ now: { t: T0 } });
    g.noteAuthFailure();
    g.noteAuthFailure();
    g.noteAuthOk();
    g.noteAuthFailure();
    g.noteAuthFailure();
    expect(g.canServe()).toBe(true);
    expect(events).toEqual([]);
  });

  it("totals and sent alerts survive a restart; a stale stored period starts fresh", () => {
    const now = { t: T0 };
    const store: { s?: SpendState } = {};
    const a = guard({ now, store });
    a.g.record(170); // warned
    const b = guard({ now, store });
    expect(b.g.status()).toMatchObject({ dayUsd: 170, monthUsd: 170 });
    b.g.record(5);
    expect(b.events).toEqual([]); // already warned today, before the restart
    now.t = Date.UTC(2027, 0, 2);
    const c = guard({ now, store });
    expect(c.g.status()).toMatchObject({ dayUsd: 0, monthUsd: 0, paused: false });
  });

  it("ignores non-positive and non-finite amounts", () => {
    const { g } = guard({ now: { t: T0 } });
    g.record(-5);
    g.record(Number.NaN);
    g.record(0);
    expect(g.status()).toMatchObject({ dayUsd: 0, monthUsd: 0 });
  });
});
