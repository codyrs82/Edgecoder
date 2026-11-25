import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import pg from "pg";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { PG_URL } from "../helpers/shared-pg.js";

/*
 * Billing row uniqueness across the two seeds (one shared database). A task id is reserved once,
 * network-wide, whatever its kind: a code job on one seed and a model call on the other under the
 * same id must not both debit a reserve, and a restart restores (and refunds) only the reserve of
 * its own billing row's account and kind.
 */

const MESH = "mesh-secret-cross-seed";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.61";
const MODEL = "qwen2.5-coder:1.5b";
const OTHER_SEED = "coord-other-seed";
let portal: Server;
let inference: Server;
let app: any;
let pool: pg.Pool;
const requester = createPeerKeys(`agent-xseed-req-${randomUUID().slice(0, 8)}`);
const worker = createPeerKeys(`agent-xseed-wrk-${randomUUID().slice(0, 8)}`);

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

/** Reserve spends written under one task id, per reason. */
async function reserves(taskId: string): Promise<Record<string, number>> {
  const r = await pool.query(
    `SELECT reason, SUM(credits)::float AS credits FROM credit_transactions WHERE related_task_id = $1 AND tx_type = 'spend' AND reason IN ('task_reserve','inference_reserve') GROUP BY reason`,
    [taskId]
  );
  return Object.fromEntries(r.rows.map((x) => [x.reason, x.credits]));
}

async function refunded(taskId: string, accountId: string): Promise<number> {
  const { refundTxId } = await import("../../src/credits/store.js");
  const r = await pool.query(`SELECT COALESCE(SUM(credits),0)::float AS c FROM credit_transactions WHERE tx_id = $1 AND account_id = $2`, [refundTxId(taskId), accountId]);
  return r.rows[0].c;
}

describe.skipIf(!PG_URL)("one billing row per task id across both seeds", () => {
  beforeAll(async () => {
    portal = createServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)) || "{}");
      const allowed = req.url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(allowed ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
    inference = createServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)) || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ subtasks: [{ taskId: body.taskId, kind: "single_step", input: "print(1)", language: "python", timeoutMs: 30_000, snapshotRef: "commit:test" }] }));
    });
    for (const s of [portal, inference]) await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
    process.env.INFERENCE_URL = `http://127.0.0.1:${(inference.address() as AddressInfo).port}`;
    process.env.MESH_AUTH_TOKEN = MESH;
    // Run 5 prior speed off: completion admission is not what these test (start-eta.ts; tests/swarm/completion-run5.test.ts).
    process.env.INFERENCE_COMPLETION_PRIOR_SPEED = "off";
    process.env.DATABASE_URL = PG_URL;
    process.env.COORDINATOR_PEER_ID = `coord-xseed-${randomUUID().slice(0, 8)}`;
    process.env.RESULT_VERIFICATION_RATE = "0";
    delete process.env.MESH_PEER_ALLOWLIST;
    delete process.env.COORDINATOR_TRUST_PROXY;
    delete process.env.FLY_APP_NAME;
    pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
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
    await pool?.end();
    for (const s of [portal, inference]) await new Promise<void>((resolve) => s?.close(() => resolve()));
    delete process.env.DATABASE_URL;
    delete process.env.COORDINATOR_PEER_ID;
    delete process.env.RESULT_VERIFICATION_RATE;
  });

  /** What the other seed did first: its billing row and its reserve debit (same account). */
  async function billedOnOtherSeed(taskId: string, kind: "job" | "inference", credits: number) {
    const { pgStore } = await import("../../src/db/store.js");
    const { spendCredits, taskReserveKey } = await import("../../src/credits/store.js");
    expect(await pgStore!.insertTaskBilling({ taskId, coordinatorId: OTHER_SEED, accountId: requester.peerId, kind, perSubtaskReserveMsat: credits * 1000, createdAtMs: Date.now() })).toBe("inserted");
    await spendCredits(requester.peerId, credits, kind === "job" ? "task_reserve" : "inference_reserve", taskId, { idempotencyKey: taskReserveKey(taskId) });
  }

  test("a task id reserved as a model call on the other seed is refused as a code job here, before any debit", async () => {
    const taskId = randomUUID();
    await billedOnOtherSeed(taskId, "inference", 7);
    const res = await post("/submit", { taskId, prompt: "print 1", language: "python", submitterAccountId: requester.peerId, snapshotRef: "a".repeat(40), projectId: "p", resourceClass: "cpu", priority: 10 }, requester);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: "duplicate_task" });
    expect(await reserves(taskId)).toEqual({ inference_reserve: 7 });
  });

  test("a task id reserved as a code job on the other seed is refused as a model call here, before any debit", async () => {
    const taskId = randomUUID();
    await billedOnOtherSeed(taskId, "job", 5);
    const res = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, computeClass: "cpu", timeoutMs: 60_000, messages: [{ role: "user", content: "hi" }] }, requester);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: "duplicate_task" });
    expect(await reserves(taskId)).toEqual({ task_reserve: 5 });
  });

  test("a retry of the same task here is still one reserve; a fresh id goes through", async () => {
    const taskId = randomUUID();
    const body = { taskId, prompt: "print 1", language: "python", submitterAccountId: requester.peerId, snapshotRef: "a".repeat(40), projectId: "p", resourceClass: "cpu", priority: 10 };
    expect((await post("/submit", body, requester)).statusCode).toBe(200);
    expect((await post("/submit", body, requester)).statusCode).toBe(409);
    const r = await reserves(taskId);
    expect(Object.keys(r)).toEqual(["task_reserve"]);
  });

  test("restore counts only its row's own account and kind, and never refunds a task twice", async () => {
    const { pgStore } = await import("../../src/db/store.js");
    const { identity, taskBilling } = await import("../../src/swarm/coordinator/context.js");
    const { spendCredits, grantCreditsIdempotent, refundTxId } = await import("../../src/credits/store.js");
    const { restoreTaskBillingRows } = await import("../../src/swarm/coordinator/billing-restore.js");
    // Legacy rows (before the fix): one task id billed here as a job (5) and, under another key,
    // as a model call (9) on the other seed. Restoring the job row refunds the job reserve only.
    const mixed = randomUUID();
    expect(await pgStore!.insertTaskBilling({ taskId: mixed, coordinatorId: identity.peerId, accountId: requester.peerId, kind: "job", perSubtaskReserveMsat: 5_000, createdAtMs: Date.now() })).toBe("inserted");
    await spendCredits(requester.peerId, 5, "task_reserve", mixed, { idempotencyKey: `task_reserve:${mixed}` });
    await spendCredits(requester.peerId, 9, "inference_reserve", mixed, { idempotencyKey: `inference_reserve:${mixed}` });
    // A task whose refund was written but whose row was never marked settled (died in between).
    const done = randomUUID();
    await pgStore!.insertTaskBilling({ taskId: done, coordinatorId: identity.peerId, accountId: requester.peerId, kind: "inference", perSubtaskReserveMsat: 3_000, createdAtMs: Date.now() });
    await spendCredits(requester.peerId, 3, "inference_reserve", done, { idempotencyKey: `reserve:${done}` });
    await grantCreditsIdempotent(requester.peerId, 3, `task_submit_refund:${done}`, refundTxId(done));

    const rows = (await pgStore!.listOpenTaskBilling(identity.peerId)).filter((r) => r.taskId === mixed || r.taskId === done);
    expect(rows).toHaveLength(2);
    const totals = await pgStore!.taskLedgerTotals(rows.map((r) => ({ taskId: r.taskId, refundTxId: refundTxId(r.taskId), accountId: r.accountId, kind: r.kind })));
    expect(totals.get(mixed)).toEqual({ reservedMsat: 5_000, paidMsat: 0, refundedMsat: 0 });
    expect(totals.get(done)).toEqual({ reservedMsat: 3_000, paidMsat: 0, refundedMsat: 3_000 });

    const summary = await restoreTaskBillingRows(pgStore!, rows);
    expect(summary).toMatchObject({ resumed: 0, refunded: 2 });
    expect(await refunded(mixed, requester.peerId)).toBe(5);
    expect(await refunded(done, requester.peerId)).toBe(3);
    expect(taskBilling.has(done)).toBe(false);
    const open = (await pgStore!.listOpenTaskBilling(identity.peerId)).map((r) => r.taskId);
    expect(open).not.toContain(mixed);
    expect(open).not.toContain(done);
  });
});

describe.skipIf(!PG_URL)("PostgresStore task billing (two seeds, one database)", () => {
  test("insertTaskBilling: inserted, same on a retry, conflict for another seed, account or kind", async () => {
    const { twoCoordinatorsOneDatabase } = await import("../helpers/shared-pg.js");
    const db = await twoCoordinatorsOneDatabase();
    try {
      const row = { taskId: "t1", coordinatorId: "us", accountId: "acct", kind: "job" as const, perSubtaskReserveMsat: 1_000, createdAtMs: 1 };
      expect(await db.a.insertTaskBilling(row)).toBe("inserted");
      expect(await db.a.insertTaskBilling(row)).toBe("same");
      expect(await db.b.insertTaskBilling({ ...row, coordinatorId: "eu", kind: "inference" })).toBe("conflict");
      expect(await db.b.insertTaskBilling({ ...row, coordinatorId: "eu" })).toBe("conflict");
      expect(await db.a.insertTaskBilling({ ...row, kind: "inference" })).toBe("conflict");
      expect(await db.a.insertTaskBilling({ ...row, accountId: "other" })).toBe("conflict");
      // A seed never settles the other seed's row.
      await db.b.markTaskBillingSettled("t1", 2, "eu");
      expect((await db.a.listOpenTaskBilling("us")).map((r) => r.taskId)).toEqual(["t1"]);
      await db.a.markTaskBillingSettled("t1", 2, "us");
      expect(await db.a.listOpenTaskBilling("us")).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
