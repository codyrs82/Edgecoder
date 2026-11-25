import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import pg from "pg";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { PG_URL } from "../helpers/shared-pg.js";
import type { CreditTransaction } from "../../src/common/types.js";

/*
 * B2: the EU seed is ~90 ms from the database, so every round trip on a call's path costs that much.
 * - The reserve (billing row + reserve debit) is one round trip, with the same outcomes as
 *   insertTaskBilling + debitCredits (which took 7).
 * - The requester's last stream read answers once the call is priced, not after the ledger writes
 *   and the refund (which the result route finishes, and the billing restore covers on a crash).
 * Round trips are counted at pg.Client.prototype.query (every pool query goes through it).
 */

let roundTrips = 0;
/** Added to every round trip so the order of events matches a distant database (the EU seed's ~90 ms). */
let latencyMs = 0;
const LATENCY_MS = 20;
const realQuery = pg.Client.prototype.query;
(pg.Client.prototype as any).query = function (this: unknown, ...args: unknown[]) {
  roundTrips++;
  if (process.env.TRACE_RT && latencyMs) process.stderr.write(`RT ${roundTrips}: ${String((args[0] as any)?.text ?? args[0]).replace(/\s+/g, " ").slice(0, 110)}\n`);
  if (latencyMs === 0) return (realQuery as any).apply(this, args);
  if (typeof args[args.length - 1] === "function") {
    setTimeout(() => (realQuery as any).apply(this, args), latencyMs);
    return undefined;
  }
  return new Promise((resolve) => setTimeout(resolve, latencyMs)).then(() => (realQuery as any).apply(this, args));
};
async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; trips: number }> {
  const start = roundTrips;
  const value = await fn();
  return { value, trips: roundTrips - start };
}

const spend = (accountId: string, taskId: string, credits: number, txId = `debit:${taskId}`): CreditTransaction => ({ txId, accountId, type: "spend", credits, reason: "inference_reserve", relatedTaskId: taskId, timestampMs: Date.now() });

describe.skipIf(!PG_URL)("reserveTaskBillingDebit (two seeds, one database)", () => {
  test("same outcomes as insertTaskBilling + debitCredits, in one round trip instead of 7", async () => {
    const { twoCoordinatorsOneDatabase } = await import("../helpers/shared-pg.js");
    const db = await twoCoordinatorsOneDatabase();
    try {
      await db.a.persistCreditTransaction({ txId: randomUUID(), accountId: "acct", type: "earn", credits: 10, reason: "test_funding", timestampMs: 1 });
      await db.a.persistCreditTransaction({ txId: randomUUID(), accountId: "acct2", type: "earn", credits: 10, reason: "test_funding", timestampMs: 1 });
      const row = (taskId: string, over: Record<string, unknown> = {}) => ({ taskId, coordinatorId: "eu", accountId: "acct", kind: "inference" as const, perSubtaskReserveMsat: 3_000, createdAtMs: 5, ...over });
      await db.a.reserveTaskBillingDebit(row("warm"), spend("acct", "warm", 1)); // the pool's connection opened

      // Before: the two calls in order.
      const before = await counted(async () => {
        expect(await db.a.insertTaskBilling(row("old"))).toBe("inserted");
        return db.a.debitCredits(spend("acct", "old", 1));
      });
      expect(before.value.status).toBe("applied");
      // After: one statement batch.
      const after = await counted(() => db.a.reserveTaskBillingDebit(row("t1"), spend("acct", "t1", 3)));
      expect(after.value).toEqual({ billing: "inserted", debit: "applied", balance: 5 });
      expect(before.trips).toBe(7);
      expect(after.trips).toBe(1);
      process.stderr.write(`reserve round trips: before ${before.trips}, after ${after.trips}\n`);

      // A retry here: the row is ours, the debit already taken.
      expect(await db.a.reserveTaskBillingDebit(row("t1"), spend("acct", "t1", 3))).toMatchObject({ billing: "same", debit: "duplicate" });
      // The other seed, another kind or account: conflict, nothing debited.
      expect(await db.b.reserveTaskBillingDebit(row("t1", { coordinatorId: "us" }), spend("acct", "t1", 3, "debit:other"))).toMatchObject({ billing: "conflict", debit: "skipped" });
      expect(await db.a.reserveTaskBillingDebit(row("t1", { kind: "job" }), spend("acct", "t1", 3, "debit:other2"))).toMatchObject({ billing: "conflict", debit: "skipped" });
      expect(await db.a.reserveTaskBillingDebit(row("t1", { accountId: "acct2" }), spend("acct2", "t1", 3, "debit:other3"))).toMatchObject({ billing: "conflict", debit: "skipped" });
      // Short of cSats: nothing written, not even the billing row.
      expect(await db.a.reserveTaskBillingDebit(row("t2"), spend("acct", "t2", 50))).toEqual({ billing: "none", debit: "insufficient", balance: 5 });
      expect((await db.a.listOpenTaskBilling("eu")).map((r) => r.taskId).sort()).toEqual(["old", "t1", "warm"]);
      // A key already charged with no row (charged before rows existed): no row, nothing debited.
      await db.a.debitCredits(spend("acct", "t3", 1));
      expect(await db.a.reserveTaskBillingDebit(row("t3"), spend("acct", "t3", 1))).toMatchObject({ billing: "none", debit: "duplicate" });
      expect(await db.a.creditBalance("acct")).toBeCloseTo(4, 6);
      const spends = await db.poolA.query(`SELECT tx_id, credits::float AS c, reason, related_task_id FROM credit_transactions WHERE account_id = 'acct' AND tx_type = 'spend' ORDER BY tx_id`);
      expect(spends.rows).toEqual([
        { tx_id: "debit:old", c: 1, reason: "inference_reserve", related_task_id: "old" },
        { tx_id: "debit:t1", c: 3, reason: "inference_reserve", related_task_id: "t1" },
        { tx_id: "debit:t3", c: 1, reason: "inference_reserve", related_task_id: "t3" },
        { tx_id: "debit:warm", c: 1, reason: "inference_reserve", related_task_id: "warm" },
      ]);
      // Values are inlined as literals: quotes and backslashes stay data.
      const odd = `o'dd\; DROP TABLE task_billing; --`;
      expect(await db.a.reserveTaskBillingDebit(row(odd, { accountId: "acct2" }), spend("acct2", odd, 1, `debit:${odd}`))).toMatchObject({ billing: "inserted", debit: "applied" });
      expect((await db.poolA.query(`SELECT task_id FROM task_billing WHERE task_id = $1`, [odd])).rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  test("concurrent reserves on both seeds never overspend (the account lock serialises them)", async () => {
    const { twoCoordinatorsOneDatabase } = await import("../helpers/shared-pg.js");
    const db = await twoCoordinatorsOneDatabase();
    try {
      await db.a.persistCreditTransaction({ txId: randomUUID(), accountId: "buyer", type: "earn", credits: 5, reason: "test_funding", timestampMs: 1 });
      const tries = Array.from({ length: 12 }, (_, i) => {
        const store = i % 2 ? db.a : db.b;
        const taskId = `c${i}`;
        return store.reserveTaskBillingDebit({ taskId, coordinatorId: i % 2 ? "us" : "eu", accountId: "buyer", kind: "inference", perSubtaskReserveMsat: 1_000, createdAtMs: 1 }, spend("buyer", taskId, 1));
      });
      const out = await Promise.all(tries);
      expect(out.filter((o) => o.debit === "applied")).toHaveLength(5);
      expect(out.filter((o) => o.debit === "insufficient" && o.billing === "none")).toHaveLength(7);
      expect(await db.a.creditBalance("buyer")).toBeCloseTo(0, 6);
      const rows = await db.poolA.query(`SELECT count(*)::int AS n FROM task_billing`);
      expect(rows.rows[0].n).toBe(5);
    } finally {
      await db.close();
    }
  });
});

const MESH = "mesh-secret-roundtrips";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.71";
const MODEL = "qwen2.5-coder:1.5b";
const REPLY = "token ".repeat(1500);
let portal: Server;
let app: any;
const requester = createPeerKeys(`agent-rt-req-${randomUUID().slice(0, 8)}`);
const worker = createPeerKeys(`agent-rt-wrk-${randomUUID().slice(0, 8)}`);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

describe.skipIf(!PG_URL)("a model call's database round trips (coordinator on Postgres)", () => {
  beforeAll(async () => {
    portal = createServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)) || "{}");
      const allowed = req.url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(allowed ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
    await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
    process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
    process.env.MESH_AUTH_TOKEN = MESH;
    process.env.DATABASE_URL = PG_URL;
    process.env.COORDINATOR_PEER_ID = `coord-rt-${randomUUID().slice(0, 8)}`;
    process.env.RESULT_VERIFICATION_RATE = "0";
    delete process.env.MESH_PEER_ALLOWLIST;
    delete process.env.COORDINATOR_TRUST_PROXY;
    delete process.env.FLY_APP_NAME;
    const { PostgresStore } = await import("../../src/db/postgres.js");
    const store = new PostgresStore(new pg.Pool({ connectionString: PG_URL, max: 1 }));
    await store.migrate();
    await store.close();
    vi.resetModules();
    const { coordinatorServer } = await import("../../src/swarm/coordinator.js");
    await coordinatorServer.ready();
    app = coordinatorServer;
    for (const keys of [requester, worker]) {
      const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem, sandboxMode: "docker", installedModels: keys === worker ? [MODEL] : [] });
      const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
      const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
      expect(res.statusCode, res.body).toBe(200);
    }
    const { grantCredits } = await import("../../src/credits/store.js");
    await grantCredits(requester.peerId, 10_000, "test_funding");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => portal?.close(() => resolve()));
    delete process.env.DATABASE_URL;
    delete process.env.COORDINATOR_PEER_ID;
    delete process.env.RESULT_VERIFICATION_RATE;
  });

  async function balance(): Promise<number> {
    const { pgStore } = await import("../../src/db/store.js");
    return pgStore!.creditBalance(requester.peerId);
  }

  async function oneCall(): Promise<{ submitTrips: number; submitMs: number; replyTrips: number; replyMs: number; settleTrips: number; settleMs: number; reservedCSats: number; creditsSpent: number; before: number }> {
    const before = await balance();
    const taskId = `inf-${randomUUID()}`;
    const s0 = Date.now();
    const submit = await counted(() => post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, computeClass: "cpu", timeoutMs: 60_000, messages: [{ role: "user", content: "write ".repeat(4000) }] }, requester));
    const submitMs = Date.now() - s0;
    expect(submit.value.statusCode, submit.value.body).toBe(200);
    const pulled = await post("/pull", { agentId: worker.peerId }, worker);
    const st = pulled.json().subtask;
    expect(st?.taskId).toBe(taskId);
    await post("/inference/chunks", { subtaskId: st.id, seq: 0, delta: REPLY }, worker);
    await post("/inference/chunks", { subtaskId: st.id, seq: 1, delta: "", done: true, promptTokens: 6000, outputTokens: 1500 }, worker);
    // Host done: its result and the requester's last read go together, as in use.
    const start = roundTrips;
    const t0 = Date.now();
    let replyTrips = -1;
    let replyMs = -1;
    const reading = post("/inference/stream", { taskId, subtaskId: st.id, waitMs: 0 }, requester).then((r: any) => {
      replyTrips = roundTrips - start;
      replyMs = Date.now() - t0;
      return r;
    });
    const result = post("/result", { subtaskId: st.id, taskId, agentId: worker.peerId, ok: true, output: REPLY, durationMs: 500 }, worker).then((r: any) => r);
    const read = await reading;
    expect((await result).statusCode).toBe(200);
    const settleTrips = roundTrips - start;
    const settleMs = Date.now() - t0;
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ done: true });
    return { submitTrips: submit.trips, submitMs, replyTrips, replyMs, settleTrips, settleMs, reservedCSats: submit.value.json().reservedCSats, creditsSpent: read.json().creditsSpent, before };
  }

  test("reserve in one round trip; the reply does not wait for the ledger writes; the ledger is the same", async () => {
    await oneCall(); // warm (pool connections, caches)
    latencyMs = LATENCY_MS;
    const c = await oneCall().finally(() => (latencyMs = 0));
    process.stderr.write(`model call round trips (${LATENCY_MS} ms each): submit ${c.submitTrips} in ${c.submitMs} ms, result→reply ${c.replyTrips} issued, ${c.replyMs} ms; result→settled ${c.settleTrips} issued, ${c.settleMs} ms\n`);
    // The reply carries the call's cost, not its reserve.
    expect(c.creditsSpent).toBeGreaterThan(0);
    expect(c.creditsSpent).toBeLessThan(c.reservedCSats);
    // Fewer round trips before the reply than in all (the accrual and refund finish after it).
    expect(c.replyTrips).toBeLessThan(c.settleTrips);
    // Settled exactly: the requester paid the cost, the rest of the reserve came back.
    for (let i = 0; i < 50 && (await balance()) !== c.before - c.creditsSpent; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await balance()).toBeCloseTo(c.before - c.creditsSpent, 6);
    const { pgStore } = await import("../../src/db/store.js");
    const { identity } = await import("../../src/swarm/coordinator/context.js");
    expect(await pgStore!.listOpenTaskBilling(identity.peerId)).toEqual([]);
  });

  test("a submit short of cSats leaves no billing row", async () => {
    const taskId = `inf-${randomUUID()}`;
    const { pgStore } = await import("../../src/db/store.js");
    const { identity } = await import("../../src/swarm/coordinator/context.js");
    const poor = createPeerKeys(`agent-rt-poor-${randomUUID().slice(0, 8)}`);
    const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: poor.peerId, registrationToken: VALID_TOKEN, publicKeyPem: poor.publicKeyPem, sandboxMode: "docker", installedModels: [] });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: poor.privateKeyPem, agentId: poor.peerId }) as unknown as Record<string, string>;
    expect((await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload })).statusCode).toBe(200);
    const res = await post("/inference/submit", { taskId, submitterAccountId: poor.peerId, model: MODEL, computeClass: "cpu", timeoutMs: 60_000, messages: [{ role: "user", content: "hi" }] }, poor);
    expect(res.statusCode, res.body).toBe(402);
    expect((await pgStore!.listOpenTaskBilling(identity.peerId)).map((r) => r.taskId)).not.toContain(taskId);
  });
});
