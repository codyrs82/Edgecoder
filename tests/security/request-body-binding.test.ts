import { generateKeyPairSync } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  hashRequestBody,
  installRawBodyCapture,
  rawBodyOf,
  signRequest,
  verifySignedRequest
} from "../../src/security/request-signing.js";
import { FallbackNonceStore, InMemoryNonceStore, effectiveNonceTtlMs, verifyNonce } from "../../src/security/nonce-verifier.js";
import { PostgresStore, SCHEMA_SQL } from "../../src/db/postgres.js";
import { unsignedRequestDecision } from "../../src/swarm/result-integrity.js";

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string
  };
}

function sign(path: string, raw: string, k: ReturnType<typeof keys>, agentId = "agent-1") {
  return signRequest({ method: "POST", path, bodyHash: hashRequestBody(raw), privateKeyPem: k.privateKeyPem, agentId });
}

describe("request signing binds the raw body (pentest #4)", () => {
  it("accepts the exact bytes that were hashed", () => {
    const k = keys();
    const raw = JSON.stringify({ agentId: "agent-1", n: 1 });
    const headers = sign("/pull", raw, k);
    const r = verifySignedRequest({ method: "POST", path: "/pull", headers, publicKeyPem: k.publicKeyPem, maxSkewMs: 60_000, rawBody: raw });
    expect(r).toMatchObject({ valid: true, agentId: "agent-1" });
  });

  it("rejects a captured signature replayed with a different body", () => {
    const k = keys();
    const headers = sign("/result", JSON.stringify({ subtaskId: "s1", ok: false }), k);
    const swapped = JSON.stringify({ subtaskId: "s1", ok: true });
    const r = verifySignedRequest({ method: "POST", path: "/result", headers, publicKeyPem: k.publicKeyPem, maxSkewMs: 60_000, rawBody: swapped });
    expect(r).toMatchObject({ valid: false, reason: "body_hash_mismatch" });
  });

  it("re-serialization is not the same as the raw bytes (whitespace / key order count)", () => {
    const k = keys();
    const raw = '{ "b": 2, "a": 1 }';
    const headers = sign("/pull", raw, k);
    const reserialized = JSON.stringify(JSON.parse(raw));
    expect(verifySignedRequest({ method: "POST", path: "/pull", headers, publicKeyPem: k.publicKeyPem, maxSkewMs: 60_000, rawBody: raw }).valid).toBe(true);
    expect(verifySignedRequest({ method: "POST", path: "/pull", headers, publicKeyPem: k.publicKeyPem, maxSkewMs: 60_000, rawBody: reserialized }).reason).toBe("body_hash_mismatch");
  });

  it("an absent body hashes as the empty string; omitting rawBody keeps the old header-only check", () => {
    const k = keys();
    const headers = sign("/heartbeat", "", k);
    expect(verifySignedRequest({ method: "POST", path: "/heartbeat", headers, publicKeyPem: k.publicKeyPem, maxSkewMs: 60_000, rawBody: null }).valid).toBe(true);
    const other = sign("/heartbeat", "{}", k);
    expect(verifySignedRequest({ method: "POST", path: "/heartbeat", headers: other, publicKeyPem: k.publicKeyPem, maxSkewMs: 60_000 }).valid).toBe(true);
  });

  it("a tampered declared hash breaks the signature itself", () => {
    const k = keys();
    const raw = JSON.stringify({ a: 1 });
    const headers = { ...sign("/pull", raw, k), "x-body-sha256": hashRequestBody('{"a":2}') };
    const r = verifySignedRequest({ method: "POST", path: "/pull", headers, publicKeyPem: k.publicKeyPem, maxSkewMs: 60_000, rawBody: '{"a":2}' });
    expect(r).toMatchObject({ valid: false, reason: "invalid_signature" });
  });

  it("Fastify raw-body capture hands the verifier the bytes on the wire (agent-style JSON.stringify body)", async () => {
    const k = keys();
    const app = Fastify();
    installRawBodyCapture(app);
    app.post("/pull", async (req) => {
      const r = verifySignedRequest({ method: "POST", path: "/pull", headers: req.headers as never, publicKeyPem: k.publicKeyPem, maxSkewMs: 60_000, rawBody: rawBodyOf(req) });
      return { valid: r.valid, reason: r.reason ?? null, parsed: req.body };
    });
    try {
      const payload = JSON.stringify({ agentId: "agent-1", note: "héllo ☃" });
      const ok = await app.inject({ method: "POST", url: "/pull", headers: { "content-type": "application/json", ...sign("/pull", payload, k) }, payload });
      expect(ok.json()).toMatchObject({ valid: true, parsed: { agentId: "agent-1" } });
      const tampered = await app.inject({
        method: "POST",
        url: "/pull",
        headers: { "content-type": "application/json", ...sign("/pull", payload, k) },
        payload: JSON.stringify({ agentId: "agent-2", note: "héllo ☃" })
      });
      expect(tampered.json()).toMatchObject({ valid: false, reason: "body_hash_mismatch" });
    } finally {
      await app.close();
    }
  });
});

describe("unsigned agent requests", () => {
  it("signed-only routes reject unsigned callers whatever the policy (/benchmark/response)", () => {
    expect(unsignedRequestDecision({ requireSignedPolicy: false, requireSigned: true })).toBe("rejected");
    expect(unsignedRequestDecision({ requireSignedPolicy: true, requireSigned: true, allowUnsigned: true })).toBe("rejected");
  });

  it("other routes follow REQUIRE_SIGNED_AGENT_REQUESTS, with allowUnsigned for routes that have their own auth", () => {
    expect(unsignedRequestDecision({ requireSignedPolicy: true })).toBe("rejected");
    expect(unsignedRequestDecision({ requireSignedPolicy: false })).toBeNull();
    expect(unsignedRequestDecision({ requireSignedPolicy: true, allowUnsigned: true })).toBeNull();
  });
});

describe("nonce store (pentest #5)", () => {
  it("keeps a nonce at least twice the skew window, whatever the TTL", () => {
    expect(effectiveNonceTtlMs(10_000, 120_000)).toBeGreaterThan(240_000);
    expect(effectiveNonceTtlMs(600_000, 120_000)).toBe(600_000);
  });

  it("uses the atomic insertIfAbsent when the store has it", async () => {
    const calls: string[] = [];
    const store = {
      seen: new Set<string>(),
      async exists() { calls.push("exists"); return false; },
      async insert() { calls.push("insert"); },
      async insertIfAbsent(n: string) { calls.push("insertIfAbsent"); if (this.seen.has(n)) return false; this.seen.add(n); return true; },
      async prune() {}
    };
    const p = { nonce: "n1", sourceId: "a", timestampMs: Date.now(), maxSkewMs: 60_000 };
    expect(await verifyNonce(store, p)).toEqual({ valid: true });
    expect(await verifyNonce(store, p)).toEqual({ valid: false, reason: "replay" });
    expect(calls).toEqual(["insertIfAbsent", "insertIfAbsent"]);
  });

  it("a non-numeric timestamp is a skew failure, not a pass", async () => {
    const r = await verifyNonce(new InMemoryNonceStore(), { nonce: "x", sourceId: "a", timestampMs: Number("nope"), maxSkewMs: 60_000 });
    expect(r).toEqual({ valid: false, reason: "timestamp_skew" });
  });

  it("in memory: an expired nonce no longer counts even before prune", async () => {
    const s = new InMemoryNonceStore();
    await s.insert("old", "a", Date.now() - 1);
    expect(await s.exists("old")).toBe(false);
    expect(await s.insertIfAbsent("old", "a", Date.now() + 60_000)).toBe(true);
    expect(await s.insertIfAbsent("old", "a", Date.now() + 60_000)).toBe(false);
  });

  it("two coordinators sharing one durable store: a replay to the other instance is refused", async () => {
    const shared = new InMemoryNonceStore(); // stands in for request_nonces
    const seedA = new FallbackNonceStore(shared);
    const seedB = new FallbackNonceStore(shared);
    const p = { nonce: "n-shared", sourceId: "agent-1", timestampMs: Date.now(), maxSkewMs: 60_000 };
    expect(await verifyNonce(seedA, p)).toEqual({ valid: true });
    expect(await verifyNonce(seedB, p)).toEqual({ valid: false, reason: "replay" });
  });

  it("survives a restart: a fresh process on the same durable store still refuses the nonce", async () => {
    const durable = new InMemoryNonceStore();
    const p = { nonce: "n-restart", sourceId: "agent-1", timestampMs: Date.now(), maxSkewMs: 60_000 };
    expect(await verifyNonce(new FallbackNonceStore(durable), p)).toEqual({ valid: true });
    expect(await verifyNonce(new FallbackNonceStore(durable), p)).toEqual({ valid: false, reason: "replay" });
  });

  it("falls back to memory when the database errors (reported once), still catching local replays", async () => {
    const errors: unknown[] = [];
    const broken = {
      async exists(): Promise<boolean> { throw new Error("db down"); },
      async insert() { throw new Error("db down"); },
      async insertIfAbsent(): Promise<boolean> { throw new Error("db down"); },
      async prune() { throw new Error("db down"); }
    };
    const s = new FallbackNonceStore(broken, (e) => errors.push(e));
    const p = { nonce: "n-down", sourceId: "agent-1", timestampMs: Date.now(), maxSkewMs: 60_000 };
    expect(await verifyNonce(s, p)).toEqual({ valid: true });
    expect(await verifyNonce(s, p)).toEqual({ valid: false, reason: "replay" });
    await s.prune();
    expect(errors).toHaveLength(1);
  });
});

// Real Postgres (CI sets TEST_DATABASE_URL): the primary key is the atomic replay check across pool connections.
const PG_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("PostgresNonceStore against real Postgres", () => {
  it("exactly one of many concurrent inserts of a nonce wins; expired rows are reusable and pruned", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 10 });
    try {
      await pool.query(SCHEMA_SQL);
      const store = new PostgresStore(pool).nonceStore();
      const nonce = `n-${Math.random()}`;
      const wins = await Promise.all(Array.from({ length: 20 }, () => store.insertIfAbsent(nonce, "agent-1", Date.now() + 60_000)));
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(await store.exists(nonce)).toBe(true);
      const old = `old-${Math.random()}`;
      await store.insert(old, "agent-1", Date.now() - 1);
      expect(await store.insertIfAbsent(old, "agent-1", Date.now() + 60_000)).toBe(true);
      const stale = `stale-${Math.random()}`;
      await store.insert(stale, "agent-1", Date.now() - 1);
      await store.prune();
      const left = await pool.query("SELECT 1 FROM request_nonces WHERE nonce = $1", [stale]);
      expect(left.rowCount).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
