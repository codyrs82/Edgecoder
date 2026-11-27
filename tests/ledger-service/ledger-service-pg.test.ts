import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { OrderingChain } from "../../src/ledger/chain.js";
import { reconcileLedger } from "../../src/ledger/reconcile.js";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { signPeerRequest } from "../../src/mesh/peer-trust.js";
import { publicKeyFingerprint } from "../../src/security/key-fingerprint.js";
import { installRawBodyCapture, rawBodyOf } from "../../src/security/request-signing.js";
import { signPortalRequest } from "../../src/security/service-request-signing.js";
import { hashResultOutput, signReceiptAsAgent } from "../../src/receipts/receipt.js";
import { splitJobCost } from "../../src/economy/job-pricing.js";
import type { RegistryEntry } from "../../src/discovery/registry.js";
import { LedgerService, registerLedgerServiceRoutes, type LedgerServiceConfig } from "../../src/ledger-service/server.js";
import { LedgerServiceClient, LedgerServiceError } from "../../src/ledger-service/client.js";
import { buyerProofFrom, splitRoutingFee } from "../../src/ledger-service/protocol.js";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";

/*
 * The ledger service (phase 4) on a real Postgres (CI's credits-pg job): outside coordinators
 * reserve, settle and refund through the seeds' API, signed with their own keys. Two seeds share the
 * database (db.a, db.b), as in production.
 */

const FEE_POOL = "network:fee_pool";
const FEE_BPS = 500;
const SEED_ID = "seed-a";
const OUTSIDE_URL = "https://outside.example";
const seedKeys = createPeerKeys(SEED_ID);
const portal = generateKeyPairSync("ed25519");

function entry(keys: { peerId: string; publicKeyPem: string }, o: { status?: RegistryEntry["status"]; billingEnabled?: boolean; operatorId?: string } = {}): RegistryEntry {
  return {
    peerId: keys.peerId,
    publicKeyFingerprint: publicKeyFingerprint(keys.publicKeyPem),
    urls: [OUTSIDE_URL],
    region: "eu",
    operator: { id: o.operatorId ?? `op-${keys.peerId}`, name: "Op", kind: "community" },
    admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
    admittedAtMs: 0,
    health: { status: "healthy", checkedAtMs: 0, latencyMs: 1 },
    status: o.status ?? "active",
    ...(o.billingEnabled === false ? {} : { billingEnabled: true })
  };
}

describe.skipIf(!PG_URL)("ledger service: outside coordinators bill through the seeds (Postgres)", () => {
  let db: SharedDb;
  const members = new Map<string, RegistryEntry>();
  const alerts: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const chain = new OrderingChain(SEED_ID, seedKeys.privateKeyPem);
  let config: LedgerServiceConfig;
  let nowMs = Date.now();
  const apps: FastifyInstance[] = [];
  let services: LedgerService[] = [];

  const verify = async () => reconcileLedger(await db.a.ledgerReconcileInput(FEE_POOL), { localCoordinatorIds: [SEED_ID], feePoolAccountId: FEE_POOL });
  const balance = async (account: string) =>
    Number((await db.poolA.query(`SELECT COALESCE(SUM(CASE WHEN tx_type = 'spend' THEN -credits ELSE credits END), 0)::text AS b FROM credit_transactions WHERE account_id = $1`, [account])).rows[0].b);
  const fund = (account: string, credits: number) => db.a.persistCreditTransaction({ txId: randomUUID(), accountId: account, type: "earn", credits, reason: "test_funding", timestampMs: Date.now() });

  /** One seed: a service over its own store, behind its own Fastify app. */
  async function seed(store: SharedDb["a"]): Promise<FastifyInstance> {
    const service = new LedgerService({
      store,
      config: new Proxy({} as LedgerServiceConfig, { get: (_t, k) => (config as unknown as Record<string | symbol, unknown>)[k] }),
      member: (peerId) => members.get(peerId) ?? null,
      portalKeys: () => [portal.publicKey],
      recordAccrual: async (r) => {
        const record = chain.append({ eventType: "earnings_accrual", taskId: r.taskId, subtaskId: r.subtaskId, actorId: r.hostAccountId, coordinatorId: SEED_ID, payloadJson: JSON.stringify(r.payload) });
        await store.persistLedgerRecord(record);
        if (await store.persistStatsLedgerRecord(record)) await store.incrementCoordinatorEarningsProjection({ accountId: r.hostAccountId, credits: Number(r.payload.credits), taskCountDelta: 1, updatedAtMs: Date.now() });
      },
      alert: (event, detail) => alerts.push({ event, detail }),
      now: () => nowMs
    });
    services.push(service);
    const app = Fastify();
    installRawBodyCapture(app);
    registerLedgerServiceRoutes(app as never, service, rawBodyOf);
    await app.ready();
    apps.push(app);
    return app;
  }

  /** The outside coordinator's client, its HTTP calls answered by `app`. */
  function client(keys: { peerId: string; publicKeyPem: string; privateKeyPem: string }, app: FastifyInstance): LedgerServiceClient {
    return new LedgerServiceClient({
      baseUrl: "https://coordinator.edgecoder.io",
      peerId: keys.peerId,
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
      fetchImpl: (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
        const r = await app.inject({ method: init.method as "POST", url: new URL(url).pathname, headers: init.headers, payload: init.body });
        return new Response(r.body, { status: r.statusCode, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch
    });
  }

  /** The portal's signed call to the outside coordinator for `account`, as it would arrive there. */
  function proof(account: string, audienceUrl = OUTSIDE_URL) {
    const body = JSON.stringify({ model: "m", taskId: randomUUID() });
    const headers = signPortalRequest({ key: portal.privateKey, url: `${audienceUrl}/inference/submit`, method: "POST", body, account });
    return buyerProofFrom({ method: "POST", url: "/inference/submit", headers: { ...headers, "x-edgecoder-account": account } })!;
  }

  const agent = createPeerKeys("agent-1");
  function receipt(taskId: string, subtaskId: string, agentKeys = agent) {
    const now = Date.now();
    return signReceiptAsAgent({ taskId, subtaskId, agentId: agentKeys.peerId, agentPublicKeyPem: agentKeys.publicKeyPem, startedAtMs: now - 1000, finishedAtMs: now, resultHash: hashResultOutput("out") }, agentKeys.privateKeyPem);
  }
  const settleBody = (taskId: string, subtaskId: string, baseCostMsat: number, extra: Record<string, unknown> = {}) => ({
    taskId, subtaskId, agentId: agent.peerId, hostAccountId: "host-1", baseCostMsat, overflowWantMsat: 0, resourceClass: "gpu" as const, durationMs: 1000, success: true, receipt: receipt(taskId, subtaskId), ...extra
  });

  let seedA: FastifyInstance;
  let seedB: FastifyInstance;
  const outside = createPeerKeys("outside-1");

  beforeAll(async () => {
    db = await twoCoordinatorsOneDatabase();
    seedA = await seed(db.a);
    seedB = await seed(db.b);
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    await db?.close();
  });
  beforeEach(() => {
    nowMs = Date.now();
    config = { enabled: true, feeBps: FEE_BPS, routingShareBps: 4000, caps: { maxOpenReserves: 100, maxOpenReserveMsat: 100_000_000, maxReserveMsatPerHour: 1_000_000_000 }, overflowMaxPct: 100, maxDisputes: 5, reserveTtlMs: 6 * 3_600_000 };
    members.clear();
    members.set(outside.peerId, entry(outside));
    alerts.length = 0;
  });

  it("reserve, settle and refund through the API; the fee is split 60/40 and the ledger verifies", async () => {
    await fund("buyer-1", 100);
    const c = client(outside, seedA);
    expect(await c.reserve({ taskId: "t1", accountId: "buyer-1", kind: "inference", msat: 20_000, idempotencyKey: "reserve:t1", buyerProof: proof("buyer-1") })).toEqual({ status: "inserted" });
    expect(await balance("buyer-1")).toBeCloseTo(80, 6);
    // Settled on the other seed: same database, same rules.
    const s = await client(outside, seedB).settle({ ...settleBody("t1", "s1", 12_000) });
    const split = splitJobCost(12_000, FEE_BPS);
    const routing = splitRoutingFee(split.feeMsat, 4000);
    expect(s).toMatchObject({ status: "settled", costMsat: 12_000, agentMsat: split.agentMsat, feeMsat: split.feeMsat, routingFeeMsat: routing.routingMsat });
    expect(routing.routingMsat).toBe(240); // 2 % of the call
    expect(routing.poolMsat).toBe(360); // 3 %
    const refunded = await c.refund("t1");
    expect(refunded).toMatchObject({ status: "refunded", refundMsat: 8_000 });
    expect(await balance("buyer-1")).toBeCloseTo(88, 6);
    expect(await balance("host-1")).toBeCloseTo(split.agentMsat / 1000, 6);
    expect(await balance(FEE_POOL)).toBeCloseTo(0.36, 6);
    expect(await balance(`acct-op-${outside.peerId}`)).toBeCloseTo(0.24, 6);
    const op = await db.poolA.query(`SELECT reason, related_task_id, msat::int AS msat FROM credit_transactions WHERE account_id = $1`, [`acct-op-${outside.peerId}`]);
    expect(op.rows).toEqual([{ reason: "routing_fee:t1", related_task_id: "t1", msat: 240 }]);
    const v = await verify();
    expect(v.discrepancies).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("idempotent: the same reserve key, settle and refund again move nothing", async () => {
    await fund("buyer-2", 100);
    const c = client(outside, seedA);
    await c.reserve({ taskId: "t2", accountId: "buyer-2", kind: "inference", msat: 10_000, idempotencyKey: "reserve:t2", buyerProof: proof("buyer-2") });
    await expect(c.reserve({ taskId: "t2", accountId: "buyer-2", kind: "inference", msat: 10_000, idempotencyKey: "reserve:t2" })).rejects.toMatchObject({ status: 409, error: "duplicate_reserve" });
    expect(await balance("buyer-2")).toBeCloseTo(90, 6);
    expect((await c.settle(settleBody("t2", "s2", 5_000))).status).toBe("settled");
    expect((await c.settle(settleBody("t2", "s2", 5_000))).status).toBe("duplicate");
    expect((await c.refund("t2")).refundMsat).toBe(5_000);
    expect(await c.refund("t2")).toMatchObject({ status: "already_closed", refundMsat: 5_000 });
    expect(await balance("buyer-2")).toBeCloseTo(95, 6);
    // A settle after the task closed is refused (a dispute, not a suspension).
    await expect(c.settle(settleBody("t2", "s2b", 1))).rejects.toMatchObject({ status: 409, error: "task_closed" });
    expect((await verify()).ok).toBe(true);
  });

  it("concurrent reserves against one balance never spend more than it holds", async () => {
    await fund("buyer-3", 1);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => client(outside, i % 2 ? seedA : seedB).reserve({ taskId: `t3-${i}`, accountId: "buyer-3", kind: "inference", msat: 300, idempotencyKey: `reserve:t3-${i}`, buyerProof: proof("buyer-3") }))
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(3);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 402, error: "insufficient_credits" });
    expect(await balance("buyer-3")).toBeCloseTo(0.1, 6);
    expect((await verify()).ok).toBe(true);
  });

  it("caps: open reserves and msat per hour", async () => {
    await fund("buyer-4", 100);
    const capped = createPeerKeys("outside-caps");
    members.set(capped.peerId, entry(capped));
    config.caps = { maxOpenReserves: 2, maxOpenReserveMsat: 100_000_000, maxReserveMsatPerHour: 25_000 };
    const c = client(capped, seedA);
    await c.reserve({ taskId: "t4a", accountId: "buyer-4", kind: "inference", msat: 10_000, idempotencyKey: "reserve:t4a", buyerProof: proof("buyer-4") });
    await c.reserve({ taskId: "t4b", accountId: "buyer-4", kind: "inference", msat: 10_000, idempotencyKey: "reserve:t4b", buyerProof: proof("buyer-4") });
    await expect(c.reserve({ taskId: "t4c", accountId: "buyer-4", kind: "inference", msat: 1_000, idempotencyKey: "reserve:t4c", buyerProof: proof("buyer-4") })).rejects.toMatchObject({ status: 429, error: "over_cap", body: { cap: "maxOpenReserves" } });
    await c.refund("t4a");
    await expect(c.reserve({ taskId: "t4d", accountId: "buyer-4", kind: "inference", msat: 10_000, idempotencyKey: "reserve:t4d", buyerProof: proof("buyer-4") })).rejects.toMatchObject({ status: 429, body: { cap: "maxReserveMsatPerHour" } });
    expect(await balance("buyer-4")).toBeCloseTo(90, 6);
  });

  it("a cost is capped at the reserve plus the overflow bound; past it is an anomaly that suspends billing", async () => {
    await fund("buyer-5", 100);
    const m = createPeerKeys("outside-over");
    members.set(m.peerId, entry(m));
    const c = client(m, seedA);
    // maxCSats ceiling far above the bound: the service keeps it at reserve + 100 %.
    await c.reserve({ taskId: "t5", accountId: "buyer-5", kind: "inference", msat: 10_000, idempotencyKey: "reserve:t5", overflowCapMsat: 1_000_000, buyerProof: proof("buyer-5") });
    const okSettle = await c.settle({ ...settleBody("t5", "s5a", 4_000) });
    expect(okSettle.status).toBe("settled");
    // The rest of the reserve plus overflow up to 2x the reserve in all.
    const over = await c.settle({ ...settleBody("t5", "s5b", 6_000), overflowWantMsat: 10_000 });
    expect(over).toMatchObject({ status: "settled", coveredMsat: 10_000, costMsat: 16_000 });
    await expect(c.settle({ ...settleBody("t5", "s5c", 0), overflowWantMsat: 1 + 1 })).rejects.toMatchObject({ status: 422, error: "over_overflow_cap" });
    expect(alerts.map((a) => a.event)).toContain("ledger_service_member_suspended");
    await expect(c.refund("t5")).rejects.toMatchObject({ status: 403, error: "billing_suspended" });
    const v = await verify();
    expect(v.discrepancies).toEqual([]);
  });

  it("a base cost above what the reserve holds is refused and suspends", async () => {
    await fund("buyer-6", 100);
    const m = createPeerKeys("outside-base");
    members.set(m.peerId, entry(m));
    const c = client(m, seedA);
    await c.reserve({ taskId: "t6", accountId: "buyer-6", kind: "inference", msat: 1_000, idempotencyKey: "reserve:t6", buyerProof: proof("buyer-6") });
    await expect(c.settle(settleBody("t6", "s6", 5_000))).rejects.toMatchObject({ status: 422, error: "over_reserve" });
    expect(await db.a.ledgerServiceMember(m.peerId)).toMatchObject({ suspendedReason: "anomaly:settle_over_reserve" });
    expect(await balance("host-1")).toBeGreaterThanOrEqual(0);
  });

  it("every settle needs the agent's signed claim: none, or a forged one, suspends billing", async () => {
    await fund("buyer-7", 100);
    const m = createPeerKeys("outside-receipt");
    members.set(m.peerId, entry(m));
    const c = client(m, seedA);
    await c.reserve({ taskId: "t7", accountId: "buyer-7", kind: "inference", msat: 5_000, idempotencyKey: "reserve:t7", buyerProof: proof("buyer-7") });
    const { receipt: _r, ...noReceipt } = settleBody("t7", "s7", 1_000);
    await expect(c.settle(noReceipt as never)).rejects.toMatchObject({ status: 403, error: "receipt_required" });
    expect(alerts).toEqual([expect.objectContaining({ event: "ledger_service_member_suspended", detail: expect.objectContaining({ kind: "settle_without_receipt" }) })]);
    await expect(c.settle(settleBody("t7", "s7", 1_000))).rejects.toMatchObject({ status: 403, error: "billing_suspended" });

    const m2 = createPeerKeys("outside-forged");
    members.set(m2.peerId, entry(m2));
    const c2 = client(m2, seedA);
    await c2.reserve({ taskId: "t7b", accountId: "buyer-7", kind: "inference", msat: 5_000, idempotencyKey: "reserve:t7b", buyerProof: proof("buyer-7") });
    const forged = { ...receipt("t7b", "s7b"), resultHash: hashResultOutput("other") };
    await expect(c2.settle({ ...settleBody("t7b", "s7b", 1_000), receipt: forged })).rejects.toMatchObject({ status: 403, error: "receipt_invalid" });
    expect(await db.a.ledgerServiceMember(m2.peerId)).toMatchObject({ suspendedReason: "anomaly:settle_receipt_invalid" });
  });

  it("repeated disputes suspend billing", async () => {
    const m = createPeerKeys("outside-disputes");
    members.set(m.peerId, entry(m));
    config.maxDisputes = 3;
    const c = client(m, seedA);
    for (let i = 0; i < 2; i++) await expect(c.refund(`nope-${i}`)).rejects.toMatchObject({ status: 404 });
    await expect(c.refund("nope-3")).rejects.toMatchObject({ status: 404 });
    expect(await db.a.ledgerServiceMember(m.peerId)).toMatchObject({ suspendedReason: "anomaly:repeated_disputes" });
  });

  it("the owner stops billing for a member at once and resumes it", async () => {
    await fund("buyer-8", 10);
    const m = createPeerKeys("outside-admin");
    members.set(m.peerId, entry(m));
    const c = client(m, seedA);
    await services[1].disableMember(m.peerId, "owner");
    await expect(c.reserve({ taskId: "t8", accountId: "buyer-8", kind: "inference", msat: 1_000, idempotencyKey: "reserve:t8", buyerProof: proof("buyer-8") })).rejects.toMatchObject({ status: 403, error: "billing_suspended" });
    await services[0].enableMember(m.peerId);
    expect(await c.reserve({ taskId: "t8", accountId: "buyer-8", kind: "inference", msat: 1_000, idempotencyKey: "reserve:t8", buyerProof: proof("buyer-8") })).toEqual({ status: "inserted" });
  });

  it("refuses a bad signature, a replayed request and an unlisted key", async () => {
    const body = JSON.stringify({ taskId: "t9" });
    const url = "https://coordinator.edgecoder.io/ledger/v1/refund";
    const headers = { "content-type": "application/json", ...signPeerRequest({ peerId: outside.peerId, privateKeyPem: outside.privateKeyPem, publicKeyPem: outside.publicKeyPem, method: "POST", url, body }) };
    const first = await seedA.inject({ method: "POST", url: "/ledger/v1/refund", headers, payload: body });
    expect(first.statusCode).toBe(404); // signed fine, nothing to refund
    const replay = await seedB.inject({ method: "POST", url: "/ledger/v1/refund", headers, payload: body });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: "peer_signature_replayed" });
    const fresh = { "content-type": "application/json", ...signPeerRequest({ peerId: outside.peerId, privateKeyPem: outside.privateKeyPem, publicKeyPem: outside.publicKeyPem, method: "POST", url, body }) };
    const tampered = await seedA.inject({ method: "POST", url: "/ledger/v1/refund", headers: fresh, payload: JSON.stringify({ taskId: "t9-other" }) });
    expect(tampered.statusCode).toBe(401);
    const stranger = createPeerKeys(outside.peerId); // same id, a key the registry does not list
    await expect(client(stranger, seedA).refund("t9")).rejects.toMatchObject({ status: 403 });
    const unsigned = await seedA.inject({ method: "POST", url: "/ledger/v1/refund", headers: { "content-type": "application/json" }, payload: body });
    expect(unsigned.statusCode).toBe(401);
  });

  it("refuses a member that is not active, or whose billing is not approved", async () => {
    const probation = createPeerKeys("outside-probation");
    members.set(probation.peerId, entry(probation, { status: "probation" }));
    await expect(client(probation, seedA).refund("x")).rejects.toMatchObject({ status: 403, error: "member_not_billable" });
    const noFlag = createPeerKeys("outside-noflag");
    members.set(noFlag.peerId, entry(noFlag, { billingEnabled: false }));
    await expect(client(noFlag, seedA).refund("x")).rejects.toMatchObject({ status: 403, error: "member_not_billable" });
    const suspended = createPeerKeys("outside-suspended");
    members.set(suspended.peerId, entry(suspended, { status: "suspended" }));
    await expect(client(suspended, seedA).refund("x")).rejects.toMatchObject({ status: 403 });
  });

  it("a new task needs the buyer's portal-signed request, for that account and this member, once", async () => {
    await fund("buyer-10", 10);
    const m = createPeerKeys("outside-proof");
    members.set(m.peerId, entry(m));
    const c = client(m, seedA);
    const base = { accountId: "buyer-10", kind: "inference" as const, msat: 1_000 };
    await expect(c.reserve({ ...base, taskId: "t10a", idempotencyKey: "reserve:t10a" })).rejects.toMatchObject({ status: 403, body: { reason: "buyer_proof_required" } });
    await expect(c.reserve({ ...base, taskId: "t10b", idempotencyKey: "reserve:t10b", buyerProof: proof("someone-else") })).rejects.toMatchObject({ status: 403, body: { reason: "buyer_account_mismatch" } });
    await expect(c.reserve({ ...base, taskId: "t10c", idempotencyKey: "reserve:t10c", buyerProof: proof("buyer-10", "https://other.example") })).rejects.toMatchObject({ status: 403, body: { reason: "portal_audience_mismatch" } });
    const p = proof("buyer-10");
    await c.reserve({ ...base, taskId: "t10d", idempotencyKey: "reserve:t10d", buyerProof: p });
    await expect(c.reserve({ ...base, taskId: "t10e", idempotencyKey: "reserve:t10e", buyerProof: p })).rejects.toMatchObject({ status: 403, body: { reason: "portal_signature_replayed" } });
    // A top-up of its own open task needs none.
    expect(await c.reserve({ ...base, taskId: "t10d", idempotencyKey: "task_reserve_topup:t10d" })).toEqual({ status: "same" });
    expect(await balance("buyer-10")).toBeCloseTo(8, 6);
  });

  it("another coordinator's task is off limits", async () => {
    await fund("buyer-11", 10);
    const a = createPeerKeys("outside-a");
    const b = createPeerKeys("outside-b");
    members.set(a.peerId, entry(a));
    members.set(b.peerId, entry(b));
    await client(a, seedA).reserve({ taskId: "t11", accountId: "buyer-11", kind: "inference", msat: 1_000, idempotencyKey: "reserve:t11", buyerProof: proof("buyer-11") });
    await expect(client(b, seedA).settle(settleBody("t11", "s11", 500))).rejects.toMatchObject({ status: 403, error: "not_your_task" });
    expect(await db.a.ledgerServiceMember(b.peerId)).toMatchObject({ suspendedReason: "anomaly:settle_not_your_task" });
  });

  it("the sweep closes a task its coordinator left open and refunds it", async () => {
    await fund("buyer-12", 10);
    const m = createPeerKeys("outside-sweep");
    members.set(m.peerId, entry(m));
    await client(m, seedA).reserve({ taskId: "t12", accountId: "buyer-12", kind: "inference", msat: 2_000, idempotencyKey: "reserve:t12", buyerProof: proof("buyer-12") });
    expect(await balance("buyer-12")).toBeCloseTo(8, 6);
    nowMs += config.reserveTtlMs + 1;
    expect(await services[0].sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(await balance("buyer-12")).toBeCloseTo(10, 6);
    expect((await verify()).ok).toBe(true);
  });

  it("disabled service refuses every call", async () => {
    config.enabled = false;
    await expect(client(outside, seedA).refund("x")).rejects.toBeInstanceOf(LedgerServiceError);
    await expect(client(outside, seedA).refund("x")).rejects.toMatchObject({ status: 503, error: "ledger_service_disabled" });
  });
});
