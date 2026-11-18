// Cloud bot claims on a real Postgres from two portal machines at once (needs TEST_DATABASE_URL).
import pg from "pg";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgCloudBotStore, migrateCloudBots } from "../../src/portal/cloud-bots/store.js";
import { DEFAULT_LIMITS } from "../../src/portal/cloud-bots/types.js";

const PG_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!PG_URL)("cloud bots on Postgres", () => {
  it("a due schedule and a queued run are each claimed once across two machines", async () => {
    const schema = `cb_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = () => new pg.Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${schema}` });
    const pa = pool();
    const pb = pool();
    try {
      await migrateCloudBots(pa);
      const a = new PgCloudBotStore(pa);
      const b = new PgCloudBotStore(pb);
      const now = Date.now();
      const config = { color: "#6e56cf", web: false, schedule: { everyMinutes: 30 }, github: null, limits: DEFAULT_LIMITS };
      const { bot } = await a.createBot({ id: "cbot_1", userId: "u1", requestId: "r1", name: "A", role: "", instructions: "", compute: "auto", config, githubTokenSealed: "sealed", nextRunAtMs: now - 1, nextPollAtMs: null, nowMs: now });
      expect(bot.hasGithubToken).toBe(true);
      expect(JSON.stringify(bot)).not.toContain("sealed");
      expect((await a.createBot({ id: "cbot_x", userId: "u1", requestId: "r1", name: "A", role: "", instructions: "", compute: "auto", config, githubTokenSealed: null, nextRunAtMs: null, nextPollAtMs: null, nowMs: now })).created).toBe(false);
      const due = await Promise.all([a.claimDueSchedules(now, 10, () => now + 1_800_000), b.claimDueSchedules(now, 10, () => now + 1_800_000), a.claimDueSchedules(now, 10, () => now + 1_800_000)]);
      expect(due.flat()).toHaveLength(1);
      const q1 = await a.enqueueRun({ userId: "u1", botId: "cbot_1", trigger: "schedule", source: "", nowMs: now });
      const q2 = await b.enqueueRun({ userId: "u1", botId: "cbot_1", trigger: "message", source: "", nowMs: now });
      expect(q2.runId).toBe(q1.runId);
      const claimed = await Promise.all([a.claimRuns({ nowMs: now, leaseMs: 60_000, limit: 5, maxPerAccount: 2 }), b.claimRuns({ nowMs: now, leaseMs: 60_000, limit: 5, maxPerAccount: 2 })]);
      expect(claimed.flat()).toHaveLength(1);
      expect(await b.getBot("u2", "cbot_1")).toBeNull();
      expect(await a.deleteBot("u2", "cbot_1")).toBe(false);
    } finally {
      await pa.end();
      await pb.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
