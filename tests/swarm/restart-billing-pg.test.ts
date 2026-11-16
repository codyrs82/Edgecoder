import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import pg from "pg";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { PG_URL } from "../helpers/shared-pg.js";

/*
 * Stress finding 2: a coordinator restart lost its queued and running subtasks and their billing, so
 * the requester's reserve stayed spent forever. Here one coordinator process takes three tasks, is
 * "restarted" (closed, modules reloaded on the same database) and restores its billing:
 * - a running subtask keeps its claimant, whose result is then accepted and the task settles exactly;
 * - a queued subtask is claimable again and settles exactly;
 * - a task that cannot be resumed (cut off before it was split) is refunded in full.
 */

const MESH = "mesh-secret-restart";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.60";
let portal: Server;
let inference: Server;
let app: any;
let pool: pg.Pool;
const requester = createPeerKeys(`agent-restart-req-${randomUUID().slice(0, 8)}`);
const worker = createPeerKeys(`agent-restart-wrk-${randomUUID().slice(0, 8)}`);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}

function post(url: string, body: unknown, signer?: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signer
    ? (signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>)
    : {};
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

async function boot(): Promise<any> {
  vi.resetModules();
  const { coordinatorServer } = await import("../../src/swarm/coordinator.js");
  await coordinatorServer.ready();
  app = coordinatorServer;
  for (const keys of [requester, worker]) {
    const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem, sandboxMode: "docker" });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
    expect(res.statusCode, res.body).toBe(200);
  }
  return coordinatorServer;
}

/** Per task: reserved − paid (work + fee) − refunded, in cSats (0 once settled). */
async function retained(taskId: string): Promise<{ reserved: number; paid: number; refunded: number; retained: number }> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(credits) FILTER (WHERE tx_type='spend' AND reason='task_reserve' AND related_task_id=$1),0)::float AS reserved,
            COALESCE(SUM(credits) FILTER (WHERE tx_type='earn' AND related_task_id=$1 AND (reason='compute_contribution' OR reason='network_fee:'||$1)),0)::float AS paid,
            COALESCE(SUM(credits) FILTER (WHERE tx_type='earn' AND reason='task_submit_refund:'||$1),0)::float AS refunded
       FROM credit_transactions WHERE related_task_id=$1 OR reason='task_submit_refund:'||$1`,
    [taskId]
  );
  const { reserved, paid, refunded } = r.rows[0];
  return { reserved, paid, refunded, retained: Math.round((reserved - paid - refunded) * 1000) / 1000 || 0 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!PG_URL)("a coordinator restart resumes or refunds what it billed", () => {
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
    process.env.DATABASE_URL = PG_URL;
    process.env.COORDINATOR_PEER_ID = `coord-restart-${randomUUID().slice(0, 8)}`;
    process.env.RESULT_VERIFICATION_RATE = "0";
    delete process.env.MESH_PEER_ALLOWLIST;
    delete process.env.COORDINATOR_TRUST_PROXY;
    delete process.env.FLY_APP_NAME;
    pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    const { PostgresStore } = await import("../../src/db/postgres.js");
    const store = new PostgresStore(new pg.Pool({ connectionString: PG_URL, max: 1 }));
    await store.migrate();
    await store.close();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    for (const s of [portal, inference]) await new Promise<void>((resolve) => s.close(() => resolve()));
    delete process.env.DATABASE_URL;
    delete process.env.COORDINATOR_PEER_ID;
    delete process.env.RESULT_VERIFICATION_RATE;
  });

  test("running and queued subtasks resume with their billing; an unsplit task is refunded", async () => {
    await boot();
    const { grantCredits } = await import("../../src/credits/store.js");
    await grantCredits(requester.peerId, 1_000, "test_funding");
    const submit = async (taskId: string) => {
      const res = await post("/submit", { taskId, prompt: "print 1", language: "python", submitterAccountId: requester.peerId, snapshotRef: "a".repeat(40), projectId: "p", resourceClass: "cpu", priority: 10 }, requester);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().subtasks[0] as string;
    };
    const running = randomUUID();
    const queued = randomUUID();
    const runningSub = await submit(running);
    const pulled = (await post("/pull", { agentId: worker.peerId }, worker)).json().subtask;
    expect(pulled?.id).toBe(runningSub);
    const queuedSub = await submit(queued);
    // A task cut off before it was split: billed and debited, no subtasks recorded.
    const unsplit = randomUUID();
    {
      const { pgStore } = await import("../../src/db/store.js");
      const { identity } = await import("../../src/swarm/coordinator/context.js");
      const { spendCredits } = await import("../../src/credits/store.js");
      await pgStore!.insertTaskBilling({ taskId: unsplit, coordinatorId: identity.peerId, accountId: requester.peerId, kind: "job", perSubtaskReserveMsat: 5_334, createdAtMs: Date.now() });
      await spendCredits(requester.peerId, 5.334, "task_reserve", unsplit, { idempotencyKey: `task_reserve:${unsplit}` });
    }
    // Queue writes are fire-and-forget: wait for exactly those before the "restart".
    await (await import("../../src/swarm/coordinator/context.js")).queue.writesSettled();
    for (const t of [running, queued, unsplit]) expect((await retained(t)).retained).toBeGreaterThan(0);

    // ── restart ──
    await app.close();
    await boot();
    const { pgStore } = await import("../../src/db/store.js");
    const { restoreTaskBilling } = await import("../../src/swarm/coordinator/billing-restore.js");
    const summary = await restoreTaskBilling(pgStore!);
    expect(summary).toMatchObject({ resumed: 2, refunded: 1, subtasksRestored: 2 });

    // The unsplit task got its whole reserve back.
    expect(await retained(unsplit)).toMatchObject({ paid: 0, retained: 0 });
    // The running subtask's claimant reports and is paid; the task settles exactly.
    await sleep(1_200);
    const res = await post("/result", { subtaskId: runningSub, taskId: running, agentId: worker.peerId, ok: true, output: "1\n", durationMs: 1_000 }, worker);
    expect(res.statusCode, res.body).toBe(200);
    // The queued one is claimable again.
    const again = (await post("/pull", { agentId: worker.peerId }, worker)).json().subtask;
    expect(again?.id).toBe(queuedSub);
    await sleep(1_200);
    expect((await post("/result", { subtaskId: queuedSub, taskId: queued, agentId: worker.peerId, ok: true, output: "1\n", durationMs: 1_000 }, worker)).statusCode).toBe(200);
    await (await import("../../src/swarm/coordinator/context.js")).queue.writesSettled();
    for (const t of [running, queued]) {
      const r = await retained(t);
      expect(r.paid).toBeGreaterThan(0);
      expect(r.retained).toBe(0);
    }
    // Settled rows are not restored again.
    expect(await restoreTaskBilling(pgStore!)).toMatchObject({ resumed: 0, refunded: 0 });
  }, 60_000);
});
