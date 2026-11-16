import { EventEmitter } from "node:events";
import pg from "pg";
import { describe, expect, test } from "vitest";
import { attachPoolErrorListener, createPgPool, PG_POOL_DEFAULTS, pgPoolConfigFromEnv, pgPoolErrorCount } from "../../src/db/pool.js";

/*
 * A pooled connection that drops while idle (database restart, failover) makes pg emit "error" on
 * the pool. With no listener that is an uncaught exception and the process exits; every pool is
 * now built with a listener that logs it, and the pool replaces the client.
 */

/** Stands in for pg.Client: connects at once, so the pool holds a real idle client without a database. */
class FakeClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  connect(cb: (err?: Error) => void) {
    setImmediate(() => cb());
  }
  query() {
    return Promise.resolve({ rows: [] });
  }
  end(cb?: () => void) {
    this._ending = true;
    this.emit("end");
    cb?.();
    return Promise.resolve();
  }
}

async function idleClient(pool: pg.Pool): Promise<FakeClient> {
  const client = await pool.connect();
  client.release();
  expect(pool.idleCount).toBe(1);
  return client as unknown as FakeClient;
}

describe("Postgres pool error handling", () => {
  test("without a listener, an idle client's error would throw (the crash this fixes)", async () => {
    const pool = new pg.Pool({ Client: FakeClient as unknown as typeof pg.Client });
    const client = await idleClient(pool);
    expect(() => client.emit("error", new Error("terminating connection due to administrator command"))).toThrow(/terminating connection/);
    await pool.end();
  });

  test("with the listener, the error is logged, the broken client is dropped and the pool keeps working", async () => {
    const pool = attachPoolErrorListener(new pg.Pool({ Client: FakeClient as unknown as typeof pg.Client }), "test");
    const before = pgPoolErrorCount();
    const client = await idleClient(pool);
    expect(() => client.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(pgPoolErrorCount()).toBe(before + 1);
    expect(pool.idleCount).toBe(0);
    // A new connection is made on the next use.
    const again = await pool.connect();
    expect(again).not.toBe(client);
    again.release();
    await pool.end();
  });

  test("timeouts and size default to bounded values and follow the environment", () => {
    expect(pgPoolConfigFromEnv({})).toEqual({
      max: PG_POOL_DEFAULTS.max,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000
    });
    expect(pgPoolConfigFromEnv({ PG_POOL_MAX: "25", PG_CONNECT_TIMEOUT_MS: "2000", PG_IDLE_TIMEOUT_MS: "10000", PG_STATEMENT_TIMEOUT_MS: "60000" })).toEqual({
      max: 25,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 60_000
    });
    // 0 leaves the server's statement_timeout alone; nonsense falls back to the default.
    expect(pgPoolConfigFromEnv({ PG_STATEMENT_TIMEOUT_MS: "0" }).statement_timeout).toBeUndefined();
    expect(pgPoolConfigFromEnv({ PG_POOL_MAX: "0" }).max).toBe(PG_POOL_DEFAULTS.max);
  });

  test("createPgPool applies the settings and the listener", async () => {
    const pool = createPgPool("postgres://u:p@127.0.0.1:1/db", "test", { PG_POOL_MAX: "3" });
    expect(pool.options.max).toBe(3);
    expect(pool.options.connectionTimeoutMillis).toBe(5_000);
    expect(pool.listenerCount("error")).toBe(1);
    await pool.end();
  });
});
