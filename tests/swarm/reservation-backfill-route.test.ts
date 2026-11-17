import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import type { Reservation } from "../../src/economy/reservations.js";

/*
 * Reservation backfill on the real coordinator app (Fastify inject), docs/reservation-backfill.md:
 * an idle reserved agent whose lease opted in takes small network calls; the lease's own jobs go
 * first; backfill holds at most its slot cap; a backfill call past its cap while a lease job waits
 * is handed to another agent (no charge, the reserved agent's pieces are refused); its pay is split
 * holder/host to the msat; a lease that did not opt in behaves exactly as before; and no lease job
 * ever reaches another agent.
 */

const MESH = "mesh-secret-backfill";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.48";
const MODEL = "qwen-backfill:32b";
let portal: Server;
let app: any;
let ctx: typeof import("../../src/swarm/coordinator/context.js");
let store: typeof import("../../src/credits/store.js");
let backfill: typeof import("../../src/swarm/coordinator/backfill.js");
const requester = createPeerKeys("agent-backfill-requester"); // submits network calls
const holder = createPeerKeys("agent-backfill-holder"); // holds the lease
const reserved = createPeerKeys("agent-backfill-reserved"); // the leased machine
const other = createPeerKeys("agent-backfill-other"); // an ordinary network agent

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const allowed = req.url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(allowed ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.RESULT_VERIFICATION_RATE = "0";
  // A 32B model on a CPU agent is slow: allow it as backfill here (the size rules have unit tests).
  process.env.RESERVATION_BACKFILL_MAX_SECONDS = "300";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ctx = await import("../../src/swarm/coordinator/context.js");
  store = await import("../../src/credits/store.js");
  backfill = await import("../../src/swarm/coordinator/backfill.js");
  await app.ready();
  await register(requester, []);
  await register(holder, []);
  for (const k of [reserved, other]) await register(k, [MODEL]);
  for (const k of [requester, holder]) await store.grantCredits(k.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  delete process.env.RESULT_VERIFICATION_RATE;
  delete process.env.RESERVATION_BACKFILL_MAX_SECONDS;
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

async function register(keys: PeerKeys, installedModels: string[]) {
  const payload = JSON.stringify({
    os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
    sandboxMode: "docker", installedModels,
  });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pull(k: PeerKeys, slots = 1, free = slots): Promise<{ id: string; input?: string } | null> {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: slots, freeInferenceSlots: free }, k)).json();
  if (r.subtask) return { id: r.subtask.id, input: r.subtask.input };
  return r.envelope ? { id: r.envelope.subtaskId } : null;
}
async function submit(from: PeerKeys, extra: Record<string, unknown> = {}, content = "hi") {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: from.peerId, model: MODEL, messages: [{ role: "user", content }], maxTokens: 64, timeoutMs: 120_000, ...extra }, from);
  expect(r.statusCode, r.body).toBe(200);
  return { taskId, subtaskId: r.json().subtaskId as string };
}
async function finish(k: PeerKeys, c: { taskId: string; subtaskId: string }) {
  await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 20, outputTokens: 30 }, k);
  return post("/result", { subtaskId: c.subtaskId, taskId: c.taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 1_000, model: MODEL }, k);
}
function lease(over: Partial<Reservation> = {}): Reservation {
  const r: Reservation = {
    id: `res-${randomUUID()}`, accountId: holder.peerId, agentId: reserved.peerId, agentAccountId: reserved.peerId, computeClass: "cpu", creditsPerSecond: 1,
    model: MODEL, startMs: Date.now() - 1_000, endMs: Date.now() + 600_000, ratePerSecondMsat: 1, prepaidMsat: 600, status: "active", ...over,
  };
  ctx.reservations.add(r);
  return r;
}
function endLease(r: Reservation) {
  ctx.reservations.put({ ...r, status: "ended", endedAtMs: Date.now(), endReason: "cancelled" });
}
/** Take whatever is queued off the board (so one test's leftovers don't feed the next). */
function drain(ids: string[]) {
  for (const id of ids) ctx.queue.markRemoteClaimed(id);
}

describe("reservation backfill", () => {
  test("opt-out: a lease that did not opt in takes only its own jobs, as before", async () => {
    const r = lease({ backfill: false });
    const net = await submit(requester);
    expect(await pull(reserved)).toBeNull();
    // Its own job still runs on it, and only on it.
    const own = await submit(holder, { reservationId: r.id });
    expect(await pull(other)).toEqual(expect.objectContaining({ id: net.subtaskId }));
    expect(await pull(other)).toBeNull();
    expect((await pull(reserved))?.id).toBe(own.subtaskId);
    await finish(other, net);
    await finish(reserved, own);
    endLease(r);
  });

  test("eligibility: an idle opted-in lease takes a small network call, not a big one", async () => {
    const r = lease({ backfill: true });
    const big = await submit(requester, { maxTokens: 16_000 }, "x".repeat(3_000));
    expect(await pull(reserved)).toBeNull();
    const small = await submit(requester);
    const got = await pull(reserved);
    expect(got?.id).toBe(small.subtaskId);
    // A network call: its input is the requester's, nothing of the lease's.
    expect(got?.input ?? "").not.toContain(r.id);
    drain([big.subtaskId]);
    const res = await finish(reserved, small);
    expect(res.statusCode, res.body).toBe(200);
    endLease(r);
  });

  test("billing: the submitter pays the normal price; host-side pay is split holder/host to the msat", async () => {
    const r = lease({ backfill: true });
    const reqBefore = store.creditEngine.balance(requester.peerId);
    const c = await submit(requester);
    expect((await pull(reserved))?.id).toBe(c.subtaskId);
    // A real reply (so the call costs more than a few msat and both shares are non-zero).
    const reply = Array.from({ length: 1_500 }, (_, i) => `w${(i * 7919) % 10_007}`).join(" ");
    await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 0, delta: reply, done: true, promptTokens: 400, outputTokens: 2_000 }, reserved);
    const fr = await post("/result", { subtaskId: c.subtaskId, taskId: c.taskId, agentId: reserved.peerId, ok: true, output: reply, durationMs: 12_000, model: MODEL }, reserved);
    expect(fr.statusCode, fr.body).toBe(200);
    const rows = async () => {
      const byReason = (acct: string, prefix: string) => store.creditEngine.history(acct).filter((t) => t.type === "earn" && t.relatedTaskId === c.taskId && t.reason.startsWith(prefix));
      return { holder: byReason(holder.peerId, "reservation_backfill_holder:"), host: byReason(reserved.peerId, "reservation_backfill_host:"), fee: byReason(store.NETWORK_FEE_POOL_ACCOUNT, "network_fee:") };
    };
    const end = Date.now() + 5_000;
    while ((await rows()).holder.length === 0 && Date.now() < end) await sleep(20);
    const { holder: h, host, fee } = await rows();
    expect(h).toHaveLength(1);
    expect(host).toHaveLength(1);
    expect(fee).toHaveLength(1);
    expect(h[0].reason).toBe(`reservation_backfill_holder:${r.id}`);
    // No compute_contribution row for the host on this call: its pay is the backfill_host row.
    expect(store.creditEngine.history(reserved.peerId).filter((t) => t.relatedTaskId === c.taskId && t.reason === "compute_contribution")).toEqual([]);
    const agentMsat = (h[0].msat ?? 0) + (host[0].msat ?? 0);
    expect(h[0].msat).toBe(Math.floor(agentMsat / 2));
    // Conservation: what the submitter was charged = holder + host + network fee.
    const charged = Math.round((reqBefore - store.creditEngine.balance(requester.peerId)) * 1000);
    expect(agentMsat + (fee[0].msat ?? 0)).toBe(charged);
    // The lease itself is untouched.
    expect(ctx.reservations.get(r.id)).toMatchObject({ prepaidMsat: 600, status: "active" });
    // The lease API shows it.
    const stats = await backfill.backfillStats(ctx.reservations.get(r.id)!);
    expect(stats).toMatchObject({ enabled: true, jobs: 1, holderMsat: h[0].msat });
    endLease(r);
  });

  test("priority: a waiting lease job is handed out first, and no backfill starts while it waits or runs", async () => {
    const r = lease({ backfill: true });
    const net = await submit(requester);
    const own = await submit(holder, { reservationId: r.id });
    expect((await pull(reserved, 4))?.id).toBe(own.subtaskId);
    // The lease job runs: no backfill alongside it, though slots are free.
    expect(await pull(reserved, 4)).toBeNull();
    await finish(reserved, own);
    // Idle again: now the network call.
    expect((await pull(reserved, 4))?.id).toBe(net.subtaskId);
    await finish(reserved, net);
    endLease(r);
  });

  test("slot cap: backfill holds at most half the slots; a lease job takes a free slot at once", async () => {
    const r = lease({ backfill: true });
    const a = await submit(requester);
    const b = await submit(requester);
    const c = await submit(requester);
    const first = await pull(reserved, 4);
    const second = await pull(reserved, 4, 3);
    expect([first?.id, second?.id].sort()).toEqual([a.subtaskId, b.subtaskId].sort());
    // 4 slots, cap 2: the third waits for another agent.
    expect(await pull(reserved, 4, 2)).toBeNull();
    const own = await submit(holder, { reservationId: r.id });
    expect((await pull(reserved, 4, 2))?.id).toBe(own.subtaskId);
    expect((await pull(other))?.id).toBe(c.subtaskId);
    for (const x of [a, b]) await finish(reserved, x);
    await finish(reserved, own);
    await finish(other, c);
    endLease(r);
  });

  test("preemption: past its cap with a lease job waiting, a backfill call that streamed nothing goes elsewhere, uncharged", async () => {
    const r = lease({ backfill: true });
    const net = await submit(requester);
    expect((await pull(reserved))?.id).toBe(net.subtaskId);
    const own = await submit(holder, { reservationId: r.id });
    // Single slot, holding the backfill call: the lease job waits.
    expect(await pull(reserved, 1, 0)).toBeNull();
    // Nothing overran yet.
    expect(await backfill.preemptOverrunBackfill(Date.now())).toEqual([]);
    // The cap is 300 s in this file; a 5 s cap here keeps the call's own deadline far off.
    const cap = backfill.backfillConfig.maxSeconds;
    backfill.backfillConfig.maxSeconds = 5;
    try {
      expect(await backfill.preemptOverrunBackfill(Date.now() + 6_000)).toEqual([net.subtaskId]);
    } finally {
      backfill.backfillConfig.maxSeconds = cap;
    }
    // The reserved agent's pieces are refused (its runner stops), and the lease job is its next.
    expect((await post("/inference/chunks", { subtaskId: net.subtaskId, seq: 0, delta: "late", done: false }, reserved)).statusCode).toBe(403);
    expect((await pull(reserved, 1, 1))?.id).toBe(own.subtaskId);
    // Another agent runs the call; only that run is paid.
    expect((await pull(other))?.id).toBe(net.subtaskId);
    await finish(other, net);
    await finish(reserved, own);
    const end = Date.now() + 5_000;
    const paid = () => store.creditEngine.history(other.peerId).filter((t) => t.relatedTaskId === net.taskId && t.type === "earn");
    while (paid().length === 0 && Date.now() < end) await sleep(20);
    expect(paid().map((t) => t.reason)).toEqual(["compute_contribution"]);
    expect(store.creditEngine.history(holder.peerId).filter((t) => t.relatedTaskId === net.taskId)).toEqual([]);
    // The holder's wait behind backfill is measured (one lease job arrived while backfill ran).
    const st = await backfill.backfillStats(ctx.reservations.get(r.id)!);
    expect(st).toMatchObject({ preempted: 1, holderWait: { samples: 1 } });
    expect(st.holderWait.maxMs).toBeGreaterThanOrEqual(0);
    endLease(r);
  });

  test("no leakage: a lease job never reaches another agent, and another lease's job never runs as backfill", async () => {
    const r = lease({ backfill: true });
    const otherLease = lease({ backfill: true, agentId: other.peerId, agentAccountId: other.peerId });
    const own = await submit(holder, { reservationId: otherLease.id });
    // The reserved agent is idle and opted in, but another lease's job is not network work.
    expect(await pull(reserved)).toBeNull();
    expect((await pull(other))?.id).toBe(own.subtaskId);
    await finish(other, own);
    endLease(otherLease);
    endLease(r);
  });

  test("the lease API: opt in at creation and toggle; the list shows backfill stats", async () => {
    const r = lease({ backfill: false });
    const toggled = await post("/account/reservations/backfill", { reservationId: r.id, enabled: true }, holder);
    expect(toggled.statusCode, toggled.body).toBe(200);
    expect(toggled.json().reservation).toMatchObject({ id: r.id, backfill: true, backfillStats: { jobs: 0, earnedCSats: 0, holderShare: 0.5 } });
    expect(ctx.reservations.get(r.id)?.backfill).toBe(true);
    // Not the holder's: unknown.
    expect((await post("/account/reservations/backfill", { reservationId: r.id, enabled: false }, requester)).statusCode).toBe(404);
    const list = (await post("/account/reservations/list", {}, holder)).json();
    expect(list.reservations.find((x: any) => x.id === r.id)).toMatchObject({ backfill: true, backfillStats: expect.objectContaining({ jobs: 0 }) });
    expect(list).toMatchObject({ backfillShare: 0.5, backfillDefault: true });
    endLease(r);
    expect((await post("/account/reservations/backfill", { reservationId: r.id, enabled: false }, holder)).statusCode).toBe(409);
  });
});
