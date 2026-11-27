import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { splitJobCost } from "../../src/economy/job-pricing.js";
import { memberBillable } from "../../src/discovery/registry.js";
import { reconcileLedger, type ReconcileInput } from "../../src/ledger/reconcile.js";
import { buyerProofFrom, operatorAccountId, splitRoutingFee } from "../../src/ledger-service/protocol.js";
import { LedgerServiceClient, LedgerServiceError, ledgerServiceUrlFromEnv } from "../../src/ledger-service/client.js";
import { accruePricedJobWithOverflow, DuplicateDebitError, refundTaskReserve, remoteLedger, reserveTaskCredits, setRemoteLedger, topUpTaskReserve } from "../../src/credits/store.js";
import { signPortalRequest } from "../../src/security/service-request-signing.js";

describe("routing share of the network fee", () => {
  it("40 % of the 5 % fee is 2 % of the call, rounded down; the pool keeps the rest", () => {
    const { feeMsat } = splitJobCost(100_000, 500);
    expect(feeMsat).toBe(5_000);
    expect(splitRoutingFee(feeMsat, 4000)).toEqual({ routingMsat: 2_000, poolMsat: 3_000 });
    expect(splitRoutingFee(7, 4000)).toEqual({ routingMsat: 2, poolMsat: 5 });
    expect(splitRoutingFee(1_000, 0)).toEqual({ routingMsat: 0, poolMsat: 1_000 });
    expect(splitRoutingFee(1_000, 20_000)).toEqual({ routingMsat: 1_000, poolMsat: 0 });
    expect(operatorAccountId("u1")).toBe("acct-u1");
  });

  it("billable only when community, active and approved", () => {
    const op = { kind: "community" as const };
    expect(memberBillable({ operator: op, status: "active", billingEnabled: true })).toBe(true);
    expect(memberBillable({ operator: op, status: "probation", billingEnabled: true })).toBe(false);
    expect(memberBillable({ operator: op, status: "active" })).toBe(false);
    expect(memberBillable({ operator: op, status: "suspended", billingEnabled: true })).toBe(false);
    expect(memberBillable({ operator: { kind: "edgecoder" }, status: "active", billingEnabled: true })).toBe(false);
  });
});

describe("reconcile: routing-share rows", () => {
  const base = (routingMsat: number | null, poolMsat: number): ReconcileInput => {
    const split = splitJobCost(10_000, 500);
    return {
      balances: [],
      reports: [{ reportId: "result:s1", accountId: "host", taskId: "t1" }],
      accrualRecords: [{ id: "r1", subtaskId: "s1", taskId: "t1", actorId: "host", coordinatorId: "seed", payload: { accountId: "host", credits: split.agentMsat / 1000, msat: split.agentMsat, costMsat: 10_000, feeMsat: split.feeMsat, routingFeeMsat: 200, networkFeeBps: 500, feeRounding: "nearest", pricingBasis: "ledger_service" } }],
      earnRows: [{ accountId: "host", taskId: "t1", rows: 1, credits: split.agentMsat / 1000, msat: split.agentMsat, msatRows: 1 }],
      feeRows: [{ taskId: "t1", rows: 1, msat: poolMsat }],
      routingRows: routingMsat === null ? [] : [{ taskId: "t1", rows: 1, msat: routingMsat }],
      projections: [{ accountId: "host", totalCredits: split.agentMsat / 1000 }],
      reservations: [],
      chain: { records: 0, forks: [], duplicateHashes: [], sequenceBreaks: [], gaps: 0 }
    };
  };

  it("pool rows are the fee less the routing share, and the routing rows match", () => {
    expect(reconcileLedger(base(200, 300)).ok).toBe(true);
  });

  it("a missing or wrong routing row, or a pool that kept it all, is a mismatch", () => {
    expect(reconcileLedger(base(null, 300)).byKind.routing_fee_mismatch).toBe(1);
    expect(reconcileLedger(base(250, 300)).byKind.routing_fee_mismatch).toBe(1);
    expect(reconcileLedger(base(200, 500)).byKind.fee_mismatch).toBe(1);
  });
});

describe("ledger service client", () => {
  afterEach(() => setRemoteLedger(null));

  it("bills through LEDGER_SERVICE_URL, or the platform URL in production without a database", () => {
    const platform = "https://platform.example";
    expect(ledgerServiceUrlFromEnv({ LEDGER_SERVICE_URL: "https://seed.example" }, platform)).toBe("https://seed.example");
    expect(ledgerServiceUrlFromEnv({ NODE_ENV: "production" }, platform)).toBe(platform);
    expect(ledgerServiceUrlFromEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://x" }, platform)).toBeNull();
    expect(ledgerServiceUrlFromEnv({}, platform)).toBeNull();
  });

  it("forwards the portal's signed request as the buyer's proof", () => {
    const key = generateKeyPairSync("ed25519").privateKey;
    const headers = signPortalRequest({ key, url: "https://o.example/inference/submit", method: "POST", body: "{}", account: "acct-1" });
    const p = buyerProofFrom({ method: "post", url: "/inference/submit", headers: { ...headers, "x-edgecoder-account": "acct-1", "x-other": "y" } });
    expect(p).toMatchObject({ method: "POST", path: "/inference/submit", headers: { "x-edgecoder-account": "acct-1" } });
    expect(Object.keys(p!.headers)).not.toContain("x-other");
    expect(buyerProofFrom({ method: "POST", url: "/x", headers: {} })).toBeNull();
  });

  function fakeClient(answer: (path: string, body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }) {
    const calls: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const keys = generateKeyPairSync("ed25519");
    const client = new LedgerServiceClient({
      baseUrl: "https://seed.example/",
      peerId: "outside-1",
      privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      fetchImpl: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(init.body);
        calls.push({ path, body, headers: init.headers });
        const a = answer(path, body);
        return new Response(JSON.stringify(a.body), { status: a.status });
      }) as unknown as typeof fetch
    });
    return { client, calls };
  }

  it("routes reserve, top-up, settle and refund through the service once installed", async () => {
    const { client, calls } = fakeClient((path) => {
      if (path.endsWith("/reserve")) return { status: 200, body: { status: "inserted" } };
      if (path.endsWith("/settle")) return { status: 200, body: { status: "settled", costMsat: 1_000, coveredMsat: 0, agentMsat: 950, feeMsat: 50, routingFeeMsat: 20, credits: 0.95 } };
      return { status: 200, body: { status: "refunded", refundMsat: 0 } };
    });
    setRemoteLedger(client);
    expect(remoteLedger()).toBe(client);
    const row = { taskId: "t1", coordinatorId: "outside-1", accountId: "buyer", kind: "inference" as const, perSubtaskReserveMsat: 2_000, createdAtMs: 1 };
    expect(await reserveTaskCredits(row, 2, "inference_reserve", { idempotencyKey: "reserve:t1", reserveMsat: 2_000, overflowCapMsat: Number.MAX_SAFE_INTEGER })).toBe("inserted");
    expect(calls[0]).toMatchObject({ path: "/ledger/v1/reserve", body: { taskId: "t1", accountId: "buyer", msat: 2_000, idempotencyKey: "reserve:t1" } });
    expect(calls[0].headers["x-peer-id"] ?? Object.values(calls[0].headers).join(" ")).toContain("outside-1");
    await topUpTaskReserve({ taskId: "t1", accountId: "buyer", kind: "job", perSubtaskReserveMsat: 2_000 }, 4_000, "task_reserve", "task_reserve_topup:t1");
    expect(calls[1].body).toMatchObject({ msat: 4_000, idempotencyKey: "task_reserve_topup:t1" });
    const report = { reportId: "result:s1", agentId: "host", taskId: "t1", resourceClass: "gpu" as const, cpuSeconds: 0, gpuSeconds: 1, success: true, qualityScore: 1, timestampMs: 1 };
    // No agent claim: nothing is settled (and nothing is sent).
    expect(await accruePricedJobWithOverflow(report, { baseCostMsat: 1_000, feeBps: 500 }, undefined, { subtaskId: "s1", agentId: "a1", durationMs: 1000 })).toBeNull();
    expect(calls).toHaveLength(2);
    const claim = { taskId: "t1", subtaskId: "s1", agentId: "a1", agentPublicKeyPem: "k", startedAtMs: 0, finishedAtMs: 1, resultHash: "0".repeat(64), agentSignature: "sig" };
    const r = await accruePricedJobWithOverflow(report, { baseCostMsat: 1_000, feeBps: 500 }, undefined, { subtaskId: "s1", agentId: "a1", durationMs: 1000, receipt: claim });
    expect(r).toMatchObject({ costMsat: 1_000, agentMsat: 950, feeMsat: 50, tx: { accountId: "host", msat: 950 } });
    expect(calls[2]).toMatchObject({ path: "/ledger/v1/settle", body: { taskId: "t1", subtaskId: "s1", hostAccountId: "host", baseCostMsat: 1_000, receipt: claim } });
    await refundTaskReserve("buyer", "t1", 1_000);
    expect(calls[3]).toMatchObject({ path: "/ledger/v1/refund", body: { taskId: "t1" } });
  });

  it("maps refusals to the errors local billing throws", async () => {
    const answers: Record<string, { status: number; body: Record<string, unknown> }> = {
      a: { status: 402, body: { error: "insufficient_credits" } },
      b: { status: 409, body: { error: "duplicate_reserve" } },
      c: { status: 403, body: { error: "billing_suspended" } }
    };
    const { client } = fakeClient((_p, body) => answers[String(body.taskId)]);
    setRemoteLedger(client);
    const row = (taskId: string) => ({ taskId, coordinatorId: "o", accountId: "buyer", kind: "inference" as const, perSubtaskReserveMsat: 1, createdAtMs: 1 });
    await expect(reserveTaskCredits(row("a"), 1, "inference_reserve", { idempotencyKey: "reserve:a" })).rejects.toThrow(/^insufficient_credits/);
    await expect(reserveTaskCredits(row("b"), 1, "inference_reserve", { idempotencyKey: "reserve:b" })).rejects.toBeInstanceOf(DuplicateDebitError);
    await expect(reserveTaskCredits(row("c"), 1, "inference_reserve", { idempotencyKey: "reserve:c" })).rejects.toBeInstanceOf(LedgerServiceError);
  });
});
