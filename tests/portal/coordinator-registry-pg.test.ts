// Registry members and the audit chain on a real Postgres (needs TEST_DATABASE_URL).
import pg from "pg";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgRegistryStore, migrateCoordinatorRegistry, verifyAuditChain, type StoredMember } from "../../src/portal/coordinator-registry-store.js";

const PG_URL = process.env.TEST_DATABASE_URL;

function member(nodeId: string, over: Partial<StoredMember> = {}): StoredMember {
  return {
    nodeId,
    keyFingerprints: ["a".repeat(64)],
    urls: ["https://c.example"],
    region: "sin",
    operatorUserId: "user-op",
    operatorName: "Op",
    operatorKind: "community",
    contact: "ops@example.org",
    admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
    createdAtMs: 1,
    admittedAtMs: null,
    status: "pending",
    probationStartedAtMs: null,
    cleanDays: 0,
    cleanDayKey: null,
    cleanDayDirty: false,
    identityFailingSinceMs: null,
    suspensionReason: null,
    updatedAtMs: 1,
    ...over
  };
}

describe.skipIf(!PG_URL)("coordinator registry on Postgres", () => {
  it("migrates idempotently, stores members, and keeps an append-only hash-chained audit", async () => {
    const schema = `reg_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${schema}` });
    try {
      await migrateCoordinatorRegistry(pool);
      await migrateCoordinatorRegistry(pool); // again: no error, nothing duplicated
      // portal machines starting together
      await Promise.all([migrateCoordinatorRegistry(pool), migrateCoordinatorRegistry(pool), migrateCoordinatorRegistry(pool)]);
      const triggers = await pool.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'portal_registry_audit'::regclass AND NOT tgisinternal`);
      expect(triggers.rows[0].n).toBe(1);

      const a = new PgRegistryStore(pool);
      const b = new PgRegistryStore(pool);
      await a.transact("community-1", () => ({ member: member("community-1"), audit: { atMs: 1, actorUserId: "user-op", action: "applied", nodeId: "community-1", detail: { urls: ["https://c.example"], z: 1, a: 2 } } }));
      // two machines writing at once still form one chain
      await Promise.all([
        a.transact("community-1", (cur) => ({ member: { ...cur!, status: "probation", probationStartedAtMs: 2, updatedAtMs: 2 }, audit: { atMs: 2, actorUserId: "owner", action: "approved", nodeId: "community-1", detail: {} } })),
        b.transact("community-2", () => ({ member: member("community-2", { keyFingerprints: ["b".repeat(64), "c".repeat(64)] }), audit: { atMs: 2, actorUserId: "user-op", action: "applied", nodeId: "community-2", detail: {} } }))
      ]);
      const got = await b.getMember("community-1");
      expect(got).toMatchObject({ status: "probation", probationStartedAtMs: 2, keyFingerprints: ["a".repeat(64)], admission: { publishedKey: true }, cleanDayKey: null });
      expect((await a.listMembers()).map((m) => m.nodeId).sort()).toEqual(["community-1", "community-2"]);
      expect((await a.getMember("community-2"))!.keyFingerprints).toEqual(["b".repeat(64), "c".repeat(64)]);
      // a decision of "no change" writes nothing
      await a.transact("community-1", () => ({ member: null }));

      const audit = await a.listAudit();
      expect(audit).toHaveLength(3);
      expect(verifyAuditChain(audit)).toEqual({ ok: true, length: 3 });
      expect((await a.listAudit(1))[0].seq).toBe(audit[2].seq);
      await expect(pool.query(`UPDATE portal_registry_audit SET action = 'x'`)).rejects.toThrow(/append-only/);
      await expect(pool.query(`DELETE FROM portal_registry_audit`)).rejects.toThrow(/append-only/);
      // a failing decision rolls back
      await expect(a.transact("community-1", () => { throw new Error("boom"); })).rejects.toThrow("boom");
      expect(await a.listAudit()).toHaveLength(3);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
