import pg from "pg";
import { describe, expect, it } from "vitest";
import { PortalStore } from "../../src/portal/store.js";

const PG_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!PG_URL)("withdraw challenges against real Postgres", () => {
  it("is single use and counts approved, unreleased withdrawals against the daily cap", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    try {
      const store = new PortalStore(pool);
      await store.migrate();
      const t = Date.now();
      const userId = `wd-${t}`;
      const since = t - 24 * 60 * 60 * 1000;
      const mk = (id: string, amountMsat: number) =>
        store.createWithdrawChallenge({ challengeId: `${id}-${t}`, userId, bolt11Hash: `hash-${id}`, amountMsat, emailCodeHash: "c", expiresAtMs: t + 600_000 });
      await mk("a", 3_000_000);
      await mk("b", 3_000_000);
      expect(await store.countWithdrawChallengesSince(userId, t - 1000)).toBe(2);

      const a = await store.consumeWithdrawChallenge(`a-${t}`);
      expect(a).toMatchObject({ userId, bolt11Hash: "hash-a", amountMsat: 3_000_000 });
      expect(await store.consumeWithdrawChallenge(`a-${t}`)).toBeNull();

      expect(await store.approveWithdrawChallenge({ challengeId: `a-${t}`, userId, capMsat: 5_000_000, sinceMs: since })).toBe(true);
      expect(await store.withdrawnMsatSince(userId, since)).toBe(3_000_000);
      expect(await store.approveWithdrawChallenge({ challengeId: `b-${t}`, userId, capMsat: 5_000_000, sinceMs: since })).toBe(false);

      await store.releaseWithdrawChallenge(`a-${t}`);
      expect(await store.withdrawnMsatSince(userId, since)).toBe(0);
      expect(await store.approveWithdrawChallenge({ challengeId: `b-${t}`, userId, capMsat: 5_000_000, sinceMs: since })).toBe(true);
      expect(await store.approveWithdrawChallenge({ challengeId: `b-${t}`, userId: "someone-else", capMsat: 0, sinceMs: since })).toBe(false);
      await pool.query(`DELETE FROM portal_withdraw_challenges WHERE user_id = $1`, [userId]);
    } finally {
      await pool.end();
    }
  });
});
