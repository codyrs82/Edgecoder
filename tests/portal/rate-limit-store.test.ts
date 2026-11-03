import { Writable } from "node:stream";
import Fastify from "fastify";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { RATE_LIMIT_SCHEMA_SQL, createPgRateLimitStore, type RateLimitPool } from "../../src/portal/rate-limit-store.js";
import { registerPortalSecurity, type PortalSecurityOptions } from "../../src/portal/security.js";

/** Emulates the store's upsert/cleanup statements in memory (one "database" shared by callers). */
class FakePool implements RateLimitPool {
  rows = new Map<string, { count: number; resetAtMs: number }>();
  async query(text: string, values: unknown[] = []) {
    const now = Date.now();
    if (text.includes("INSERT INTO portal_rate_limits")) {
      const [key, windowMs] = values as [string, number];
      const row = this.rows.get(key);
      const next = !row || row.resetAtMs <= now ? { count: 1, resetAtMs: now + windowMs } : { count: row.count + 1, resetAtMs: row.resetAtMs };
      this.rows.set(key, next);
      return { rows: [{ count: next.count, ttl_ms: String(Math.max(0, next.resetAtMs - now)) }] };
    }
    if (text.includes("DELETE FROM portal_rate_limits")) {
      let n = 0;
      for (const [k, r] of this.rows) {
        if (n >= Number(values[0])) break;
        if (r.resetAtMs <= now) {
          this.rows.delete(k);
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }
    throw new Error(`unexpected query: ${text}`);
  }
}

function incr(store: { incr: (...a: never[]) => void }, key: string, timeWindow = 60_000, max = 10) {
  return new Promise<{ current: number; ttl: number }>((resolve, reject) => {
    (store.incr as (k: string, cb: (e: Error | null, r?: { current: number; ttl: number }) => void, w: number, m: number) => void)(
      key,
      (err, res) => (err ? reject(err) : resolve(res!)),
      timeWindow,
      max
    );
  });
}

const route = (method: string, url: string) => ({ routeInfo: { method, url } }) as never;

function captureLogs() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(line));
      cb();
    },
  });
  return { lines, stream };
}

async function buildApp(opts: Partial<PortalSecurityOptions> = {}, stream?: Writable) {
  const app = Fastify({ trustProxy: false, logger: stream ? { level: "info", stream } : false });
  await registerPortalSecurity(app, { publicOrigin: "https://edgecoder.io", trustedOrigins: [], env: {}, ...opts });
  app.post("/auth/login", async () => ({ ok: true }));
  app.post("/wallet/send/mfa/start", async () => ({ ok: true }));
  await app.ready();
  return app;
}

const login = (app: Awaited<ReturnType<typeof buildApp>>, ip = "10.1.0.1") =>
  app.inject({ method: "POST", url: "/auth/login", remoteAddress: ip, payload: {} });

describe("shared rate-limit store (fake pool)", () => {
  it("two app instances sharing one store hit the limit together", async () => {
    const pool = new FakePool();
    const a = await buildApp({ rateLimitPool: pool });
    const b = await buildApp({ rateLimitPool: pool });
    try {
      for (let i = 0; i < 10; i++) expect((await login(i % 2 ? a : b)).statusCode).toBe(200);
      expect((await login(a)).statusCode).toBe(429);
      expect((await login(b)).statusCode).toBe(429);
      expect((await login(b, "10.1.0.2")).statusCode).toBe(200);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("keeps a separate counter per route", async () => {
    const pool = new FakePool();
    const app = await buildApp({ rateLimitPool: pool });
    try {
      for (let i = 0; i < 5; i++) {
        expect((await app.inject({ method: "POST", url: "/wallet/send/mfa/start", remoteAddress: "10.1.0.3", payload: {} })).statusCode).toBe(200);
      }
      expect((await app.inject({ method: "POST", url: "/wallet/send/mfa/start", remoteAddress: "10.1.0.3", payload: {} })).statusCode).toBe(429);
      expect((await login(app, "10.1.0.3")).statusCode).toBe(200);
      expect([...pool.rows.keys()].sort()).toEqual(["POST:/auth/login|10.1.0.3", "POST:/wallet/send/mfa/start|10.1.0.3"]);
    } finally {
      await app.close();
    }
  });
});

describe("shared rate-limit store: database down", () => {
  const warnings: unknown[] = [];
  const log = { warn: (obj: unknown) => void warnings.push(obj) };

  it("falls back to memory (still limiting) when the pool throws, and rate-limits the warning", async () => {
    warnings.length = 0;
    const pool: RateLimitPool = { query: async () => Promise.reject(new Error("connection refused")) };
    const { Store, stop } = createPgRateLimitStore(pool, { log, cleanupIntervalMs: 0 });
    const store = new Store({} as never).child(route("POST", "/auth/login"));
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await incr(store, "10.2.0.1"));
    expect(results.map((r) => r.current)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(results[0].ttl).toBeGreaterThan(59_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ err: "connection refused" });
    stop();
  });

  it("falls back after the timeout when the pool hangs", async () => {
    warnings.length = 0;
    const pool: RateLimitPool = { query: () => new Promise(() => {}) };
    const { Store, stop } = createPgRateLimitStore(pool, { log, timeoutMs: 50, cleanupIntervalMs: 0 });
    const store = new Store({} as never);
    const t0 = Date.now();
    expect((await incr(store, "10.2.0.2")).current).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await incr(store, "10.2.0.2")).current).toBe(2);
    expect(warnings).toHaveLength(1);
    stop();
  });

  it("an app whose database is down still returns 429 after the limit", async () => {
    const pool: RateLimitPool = { query: async () => Promise.reject(new Error("db down")) };
    const app = await buildApp({ rateLimitPool: pool });
    try {
      for (let i = 0; i < 10; i++) expect((await login(app, "10.2.0.3")).statusCode).toBe(200);
      expect((await login(app, "10.2.0.3")).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});

describe("rate-limit startup log", () => {
  const cases: Array<[string, Partial<PortalSecurityOptions>, string]> = [
    ["cloudflare + lock", { edge: "cloudflare", originLockToken: "lock", rateLimitPool: new FakePool() }, "rate-limit key: cf-connecting-ip (origin lock on); store: postgres"],
    ["fly", { env: { PORTAL_TRUST_FLY_CLIENT_IP: "true", FLY_APP_NAME: "edgecoder-portal" } }, "rate-limit key: fly-client-ip; store: memory"],
    ["cloudflare without lock", { edge: "cloudflare" }, "rate-limit key: socket address; store: memory"],
    ["default", {}, "rate-limit key: socket address; store: memory"],
  ];
  for (const [name, opts, expected] of cases) {
    it(`logs the key source and store once (${name})`, async () => {
      const { lines, stream } = captureLogs();
      const app = await buildApp(opts, stream);
      await app.close();
      const matching = lines.filter((l) => String(l.msg).startsWith("rate-limit key:"));
      expect(matching.map((l) => l.msg)).toEqual([expected]);
    });
  }
});

const PG_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!PG_URL)("shared rate-limit store against real Postgres", () => {
  const withPool = async (fn: (pool: pg.Pool) => Promise<void>) => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 10 });
    try {
      await pool.query(RATE_LIMIT_SCHEMA_SQL);
      await fn(pool);
    } finally {
      await pool.end();
    }
  };
  const ns = () => `t${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

  it("counts concurrent increments atomically", async () => {
    await withPool(async (pool) => {
      const { Store, stop } = createPgRateLimitStore(pool, { cleanupIntervalMs: 0, timeoutMs: 5000 });
      const store = new Store({} as never).child(route("POST", `/${ns()}`));
      const results = await Promise.all(Array.from({ length: 40 }, () => incr(store, "1.2.3.4")));
      expect(results.map((r) => r.current).sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      for (const r of results) expect(r.ttl).toBeGreaterThan(50_000);
      stop();
    });
  });

  it("resets the count once the window has passed", async () => {
    await withPool(async (pool) => {
      const { Store, stop } = createPgRateLimitStore(pool, { cleanupIntervalMs: 0, timeoutMs: 5000 });
      const store = new Store({} as never).child(route("POST", `/${ns()}`));
      expect((await incr(store, "k", 300)).current).toBe(1);
      expect((await incr(store, "k", 300)).current).toBe(2);
      await new Promise((r) => setTimeout(r, 400));
      const after = await incr(store, "k", 300);
      expect(after.current).toBe(1);
      expect(after.ttl).toBeGreaterThan(200);
      stop();
    });
  });

  it("namespaces keys per route via child()", async () => {
    await withPool(async (pool) => {
      const { Store, stop } = createPgRateLimitStore(pool, { cleanupIntervalMs: 0, timeoutMs: 5000 });
      const root = new Store({} as never);
      const id = ns();
      const login = root.child(route("POST", `/${id}/login`));
      const wallet = root.child(route("POST", `/${id}/wallet`));
      expect((await incr(login, "ip")).current).toBe(1);
      expect((await incr(login, "ip")).current).toBe(2);
      expect((await incr(wallet, "ip")).current).toBe(1);
      const rows = await pool.query(`SELECT key, count FROM portal_rate_limits WHERE key LIKE $1 ORDER BY key`, [`POST:/${id}/%`]);
      expect(rows.rows).toEqual([
        { key: `POST:/${id}/login|ip`, count: 2 },
        { key: `POST:/${id}/wallet|ip`, count: 1 },
      ]);
      stop();
    });
  });

  it("cleanup deletes expired rows in batches and keeps live ones", async () => {
    await withPool(async (pool) => {
      const id = ns();
      await pool.query(
        `INSERT INTO portal_rate_limits (key, count, reset_at)
         SELECT $1 || '|expired' || g, 1, now() - interval '1 minute' FROM generate_series(1, 5) g`,
        [id]
      );
      await pool.query(`INSERT INTO portal_rate_limits (key, count, reset_at) VALUES ($1, 1, now() + interval '1 minute')`, [`${id}|live`]);
      const { cleanupExpired, stop } = createPgRateLimitStore(pool, { cleanupIntervalMs: 0, cleanupBatch: 3 });
      let deleted = 0;
      for (let i = 0; i < 10; i++) {
        const n = await cleanupExpired();
        expect(n).toBeLessThanOrEqual(3);
        deleted += n;
        if (n === 0) break;
      }
      expect(deleted).toBeGreaterThanOrEqual(5);
      const left = await pool.query(`SELECT key FROM portal_rate_limits WHERE key LIKE $1`, [`${id}|%`]);
      expect(left.rows).toEqual([{ key: `${id}|live` }]);
      await pool.query(`DELETE FROM portal_rate_limits WHERE key LIKE $1`, [`${id}|%`]);
      stop();
    });
  });

  it("two app instances sharing the database hit the limit together", async () => {
    await withPool(async (pool) => {
      const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      await pool.query(`DELETE FROM portal_rate_limits WHERE key = $1`, [`POST:/auth/login|${ip}`]);
      const opts = { rateLimitPool: pool, rateLimitStoreOptions: { timeoutMs: 5000 } };
      const a = await buildApp(opts);
      const b = await buildApp(opts);
      try {
        for (let i = 0; i < 10; i++) expect((await login(i % 2 ? a : b, ip)).statusCode).toBe(200);
        expect((await login(a, ip)).statusCode).toBe(429);
        expect((await login(b, ip)).statusCode).toBe(429);
      } finally {
        await a.close();
        await b.close();
        await pool.query(`DELETE FROM portal_rate_limits WHERE key = $1`, [`POST:/auth/login|${ip}`]);
      }
    });
  });
});
