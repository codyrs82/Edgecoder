// Two coordinators on one database, the production seed layout: each gets its own pg.Pool and
// PostgresStore over the same schema. A fresh schema per suite keeps "latest record" queries free of
// rows other test files write. Needs TEST_DATABASE_URL (CI's credits-pg job, or a local postgres).
import pg from "pg";
import { randomUUID } from "node:crypto";
import { PostgresStore, SCHEMA_SQL } from "../../src/db/postgres.js";

export const PG_URL = process.env.TEST_DATABASE_URL;

export interface SharedDb {
  a: PostgresStore;
  b: PostgresStore;
  poolA: pg.Pool;
  poolB: pg.Pool;
  close(): Promise<void>;
}

export async function twoCoordinatorsOneDatabase(): Promise<SharedDb> {
  if (!PG_URL) throw new Error("TEST_DATABASE_URL not set");
  const schema = `ls_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = () => new pg.Pool({ connectionString: PG_URL, max: 6, options: `-c search_path=${schema}` });
  const poolA = pool();
  const poolB = pool();
  await poolA.query(SCHEMA_SQL);
  return {
    a: new PostgresStore(poolA),
    b: new PostgresStore(poolB),
    poolA,
    poolB,
    async close() {
      await poolA.end();
      await poolB.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
      await admin.end();
    }
  };
}
