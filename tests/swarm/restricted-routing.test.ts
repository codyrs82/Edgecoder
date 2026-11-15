import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * Security research tier on the real coordinator app (Fastify inject): restricted models are hidden
 * from accounts without the entitlement, refused at submit without it, and run only on the
 * requester's own approved machine or a leased approved machine: never an open-pool agent, at
 * submit or at claim, including a subtask that reaches the queue without passing the gate
 * (gossip, replay). Suspension cancels a call in flight. Every call is logged.
 */

const MESH = "mesh-secret-restricted";
const PORTAL = "portal-secret-restricted";
const ADMIN = "admin-secret-restricted";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.47";
const SEC = "secmodel:7b";
const OPEN = "openmodel:1b";
let portal: Server;
let app: any;
let ctx: typeof import("../../src/swarm/coordinator/context.js");
const lab = createPeerKeys("agent-restricted-lab"); // the entitled organisation's own machine
const host = createPeerKeys("agent-restricted-host"); // an approved third-party host (leases)
const open = createPeerKeys("agent-restricted-open"); // an ordinary open-pool agent
type Ent = { accountId: string; kind: "security_research" | "security_research_host"; expiresAtMs: number | null; active: boolean };
const portalList: Ent[] = [];

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/internal/security-research/entitlements") return res.end(JSON.stringify({ entitlements: portalList.filter((e) => e.active) }));
      const body = raw ? JSON.parse(raw) : {};
      const allowed = req.url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN;
      res.end(JSON.stringify(allowed ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, {
    PORTAL_SERVICE_URL: `http://127.0.0.1:${(portal.address() as AddressInfo).port}`,
    MESH_AUTH_TOKEN: MESH,
    PORTAL_SERVICE_TOKEN: PORTAL,
    ADMIN_API_TOKEN: ADMIN,
    RESTRICTED_MODELS_JSON: JSON.stringify({ [SEC]: "security_research" }),
    RESTRICTED_MODEL_RATE_LIMIT_PER_MIN: "50",
  });
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ctx = await import("../../src/swarm/coordinator/context.js");
  await app.ready();
  for (const k of [lab, host, open]) await register(k, [SEC, OPEN]);
  const { grantCredits } = await import("../../src/credits/store.js");
  for (const k of [lab, open]) await grantCredits(k.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  for (const k of ["RESTRICTED_MODELS_JSON", "RESTRICTED_MODEL_RATE_LIMIT_PER_MIN", "ADMIN_API_TOKEN", "PORTAL_SERVICE_TOKEN"]) delete process.env[k];
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

/** Set an entitlement the way the portal does: in its list (what coordinators sync) and pushed at once. */
async function entitle(accountId: string, kind: Ent["kind"], active = true) {
  const i = portalList.findIndex((e) => e.accountId === accountId && e.kind === kind);
  if (i >= 0) portalList.splice(i, 1);
  const e: Ent = { accountId, kind, expiresAtMs: Date.now() + 86_400_000, active };
  portalList.push(e);
  const res = await app.inject({ method: "POST", url: "/account/restricted-access/update", headers: { "content-type": "application/json", "x-portal-service-token": PORTAL }, payload: JSON.stringify(e) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { ok: boolean; cancelled: number };
}

const pull = async (k: PeerKeys, optIn: boolean) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: 4, freeInferenceSlots: 4, ...(optIn ? { allowRestrictedModels: true } : {}) }, k)).json();
  return (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null;
};
const submit = (signer: PeerKeys, extra: Record<string, unknown>, model = SEC) =>
  post("/inference/submit", { taskId: `inf-${randomUUID()}`, submitterAccountId: signer.peerId, model, messages: [{ role: "user", content: "scan my own host" }], timeoutMs: 60_000, ...extra }, signer);
const models = async (viewer?: string) => {
  const res = await app.inject({ method: "GET", url: "/inference/models", headers: { "x-portal-service-token": PORTAL, ...(viewer ? { "x-edgecoder-account": viewer } : {}) } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().models as Array<{ model: string; restricted?: string }>;
};

describe("security research tier: restricted models", () => {
  test("hidden from listings for accounts without the entitlement; shown, marked, to entitled ones", async () => {
    expect((await models()).map((m) => m.model)).toEqual([OPEN]);
    expect((await models(open.peerId)).map((m) => m.model)).toEqual([OPEN]);
    await entitle(lab.peerId, "security_research");
    const seen = await models(lab.peerId);
    expect(seen.find((m) => m.model === SEC)).toMatchObject({ restricted: "security_research" });
    expect(seen.find((m) => m.model === OPEN)?.restricted).toBeUndefined();
    // The mesh token (operators, peers) names no account: still hidden.
    const mesh = await app.inject({ method: "GET", url: "/inference/models", headers: { "x-mesh-token": MESH } });
    expect(mesh.json().models.map((m: { model: string }) => m.model)).toEqual([OPEN]);
  });

  test("403 restricted_model without the entitlement, and for any network placement with it", async () => {
    const noEnt = await submit(open, { target: "mine" });
    expect(noEnt.statusCode).toBe(403);
    expect(noEnt.json()).toMatchObject({ error: "restricted_model", tier: "security_research" });
    const network = await submit(lab, { target: "network" });
    expect(network.statusCode).toBe(403);
    expect(network.json()).toMatchObject({ error: "restricted_model", reason: "reserved_placement_required" });
    // Code work naming a restricted model is always refused.
    const code = await post("/submit", { taskId: `t-${randomUUID()}`, prompt: "x", language: "python", snapshotRef: "a".repeat(40), submitterAccountId: lab.peerId, requestedModel: SEC }, lab);
    expect(code.statusCode).toBe(403);
    expect(code.json().error).toBe("restricted_model");
    // An open model is unaffected.
    const plain = await submit(open, { target: "mine" }, OPEN);
    expect(plain.statusCode).toBe(200);
    expect(await pull(open, false)).toBe(plain.json().subtaskId);
    await post("/inference/chunks", { subtaskId: plain.json().subtaskId, seq: 0, delta: "ok", done: true }, open);
    await post("/result", { subtaskId: plain.json().subtaskId, taskId: plain.json().taskId, agentId: open.peerId, ok: true, output: "ok", durationMs: 5, model: OPEN }, open);
  });

  test("host opt-in and host entitlement are both required; open-pool agents never claim", async () => {
    // The lab's machine has neither yet.
    const none = await submit(lab, { target: "mine" });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ error: "no_restricted_host" });
    // Opted in, no host entitlement: still refused.
    expect(await pull(lab, true)).toBeNull();
    expect((await submit(lab, { target: "mine" })).json().error).toBe("no_restricted_host");
    // Host entitlement too: accepted.
    await entitle(lab.peerId, "security_research_host");
    expect(await pull(lab, true)).toBeNull();
    const ok = await submit(lab, { target: "mine" });
    expect(ok.statusCode, ok.body).toBe(200);
    const subtaskId = ok.json().subtaskId as string;
    // An open-pool agent, even one opted in with a host entitlement of its own, never gets it.
    await entitle(open.peerId, "security_research_host");
    expect(await pull(open, true)).toBeNull();
    expect(await pull(host, false)).toBeNull();
    // The lab's own machine without its opt-in on this pull does not either.
    expect(await pull(lab, false)).toBeNull();
    expect(await pull(lab, true)).toBe(subtaskId);
    await post("/inference/chunks", { subtaskId, seq: 0, delta: "done", done: true, promptTokens: 12, outputTokens: 3 }, lab);
    await post("/result", { subtaskId, taskId: ok.json().taskId, agentId: lab.peerId, ok: true, output: "done", durationMs: 50, model: SEC }, lab);
  });

  test("a subtask that skipped the submit gate (gossiped, replayed, forged placement) is claimable by nobody", async () => {
    const forged = (meta: Record<string, unknown>) =>
      ctx.queue.enqueueSubtask({
        taskId: `gossip-${randomUUID()}`, kind: "inference", language: "python", input: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
        timeoutMs: 60_000, snapshotRef: "inference", requestedModel: SEC,
        projectMeta: { projectId: "gossip", resourceClass: "gpu", priority: 99, computeClass: "any", ...meta },
      });
    const a = forged({});
    const b = forged({ onlyAccountId: open.peerId });
    const c = forged({ onlyAccountId: lab.peerId });
    for (const k of [open, host, lab]) expect(await pull(k, true)).toBeNull();
    for (const s of [a, b, c]) {
      expect(ctx.queue.isUnclaimed(s.id)).toBe(true);
      ctx.queue.markRemoteClaimed(s.id);
    }
    // A code subtask naming no model runs on the agent's active model: an agent whose active model is restricted takes none.
    const code = ctx.queue.enqueueSubtask({
      taskId: `code-${randomUUID()}`, kind: "single_step", language: "python", input: "print(1)", timeoutMs: 60_000, snapshotRef: "x",
      projectMeta: { projectId: "code", resourceClass: "cpu", priority: 99, computeClass: "any" },
    });
    const { agentCapabilities } = await import("../../src/swarm/coordinator/agent-state.js");
    const cap = agentCapabilities.get(open.peerId)!;
    const before = cap.activeModel;
    cap.activeModel = SEC;
    expect(await pull(open, true)).toBeNull();
    cap.activeModel = before;
    ctx.queue.markRemoteClaimed(code.id);
  });

  test("a leased call runs only on the leased, approved host", async () => {
    const lease = {
      id: `lease-${randomUUID()}`, accountId: lab.peerId, agentId: host.peerId, agentAccountId: host.peerId, computeClass: "gpu", creditsPerSecond: 1,
      startMs: Date.now(), endMs: Date.now() + 600_000, ratePerSecondMsat: 1, prepaidMsat: 600, status: "active" as const,
    };
    ctx.reservations.add(lease);
    // The leased host has no host entitlement yet.
    expect(await pull(host, true)).toBeNull();
    expect((await submit(lab, { reservationId: lease.id })).json().error).toBe("no_restricted_host");
    await entitle(host.peerId, "security_research_host");
    expect(await pull(host, true)).toBeNull();
    const ok = await submit(lab, { reservationId: lease.id });
    expect(ok.statusCode, ok.body).toBe(200);
    const subtaskId = ok.json().subtaskId as string;
    expect(await pull(open, true)).toBeNull();
    expect(await pull(lab, true)).toBeNull();
    // Opt-in is per pull: without it the leased host does not take it.
    expect(await pull(host, false)).toBeNull();
    expect(await pull(host, true)).toBe(subtaskId);
    await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 7, outputTokens: 2 }, host);
    await post("/result", { subtaskId, taskId: ok.json().taskId, agentId: host.peerId, ok: true, output: "ok", durationMs: 50, model: SEC }, host);
    ctx.reservations.end(lease.id, Date.now(), "cancelled");
  });

  test("suspending the entitlement cancels a call in flight; the agent's later output is refused", async () => {
    const ok = await submit(lab, { target: "mine" });
    expect(ok.statusCode, ok.body).toBe(200);
    const { taskId, subtaskId } = ok.json();
    expect(await pull(lab, true)).toBe(subtaskId);
    const r = await entitle(lab.peerId, "security_research", false);
    expect(r.cancelled).toBe(1);
    const chunk = await post("/inference/chunks", { subtaskId, seq: 0, delta: "late", done: true }, lab);
    expect(chunk.statusCode).toBe(403);
    const stream = await post("/inference/stream", { taskId, subtaskId, after: 0, waitMs: 0 }, lab);
    expect(stream.body).toContain("restricted_access_suspended");
    // Suspended: hidden again and refused.
    expect((await models(lab.peerId)).map((m) => m.model)).not.toContain(SEC);
    expect((await submit(lab, { target: "mine" })).statusCode).toBe(403);
    await entitle(lab.peerId, "security_research");
  });

  test("best-fit auto never chooses a restricted model, for anyone, entitled or not", async () => {
    for (const signer of [lab, open]) {
      for (let i = 0; i < 3; i++) {
        const r = await submit(signer, {}, "auto");
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json().model).toBe(OPEN);
        const id = r.json().subtaskId as string;
        let taker: PeerKeys | undefined;
        for (const k of [lab, host, open]) if ((await pull(k, true)) === id) taker = k;
        expect(taker).toBeDefined();
        await post("/inference/chunks", { subtaskId: id, seq: 0, delta: "ok", done: true }, taker!);
        await post("/result", { subtaskId: id, taskId: r.json().taskId, agentId: taker!.peerId, ok: true, output: "ok", durationMs: 5, model: OPEN }, taker!);
      }
    }
    const { withoutRestrictedModels } = await import("../../src/swarm/coordinator/routing.js");
    const view = (models: string[], activeModel: string) => ({ agentId: "a", label: "a", coordinatorId: "c", local: true, computeClass: "gpu", tierWeight: 1, models, activeModel, slots: 1, freeSlots: 1, verified: false, rttMs: null, stale: false }) as never;
    expect(withoutRestrictedModels([view([SEC], SEC)])).toEqual([]);
    expect(withoutRestrictedModels([view([SEC, OPEN], SEC)])).toMatchObject([{ models: [OPEN], activeModel: null }]);
  });

  test("every call is logged (account, model, agent, times, tokens); prompts are not by default; admin only", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/restricted-models" })).statusCode).toBe(401);
    const res = await app.inject({ method: "GET", url: "/admin/restricted-models", headers: { "x-admin-token": ADMIN } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.models).toEqual([{ model: SEC, tier: "security_research" }]);
    expect(body.logPrompts).toBe(false);
    const own = body.recent.find((r: any) => r.agentId === lab.peerId && r.outcome === "ok");
    expect(own).toMatchObject({ accountId: lab.peerId, model: SEC, placement: "mine", hostAccountId: lab.peerId, promptTokens: 12, outputTokens: 3 });
    expect(own.submittedAtMs).toBeGreaterThan(0);
    expect(own.claimedAtMs).toBeGreaterThanOrEqual(own.submittedAtMs);
    expect(own.endedAtMs).toBeGreaterThanOrEqual(own.claimedAtMs);
    expect(body.recent.find((r: any) => r.agentId === host.peerId)).toMatchObject({ placement: "reserved", promptTokens: 7, outputTokens: 2 });
    expect(body.recent.some((r: any) => r.outcome === "cancelled_suspended")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("scan my own host");
    // Only the portal may push entitlement changes.
    const forged = await post("/account/restricted-access/update", { accountId: open.peerId, kind: "security_research", expiresAtMs: null, active: true }, open);
    expect(forged.statusCode).not.toBe(200);
  });
});
