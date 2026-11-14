import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * #162 / #117, against the real coordinator app (Fastify inject): a sampled result is held, its
 * replica is claimed through /pull and abandoned again and again. Each stall is penalized and
 * reassigned to an agent that hasn't abandoned it yet, until less than one claim window is left
 * before the overall deadline (which reassignment does not extend). At the deadline nobody is
 * paid, the requester gets a failure, and the submit charge is refunded.
 */

const VALID_TOKEN = "valid-registration-token";
const MESH = "mesh-secret-test";
const CLAIM_WINDOW_MS = 120_000;
const DEADLINE_MS = 600_000;
const T0 = 1_900_000_000_000;

let portal: Server;
let inference: Server;
let app: any;
let tick: () => Promise<void>;
let credits: typeof import("../../src/credits/store.js");

function stub(handler: (url: string, body: any) => unknown): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handler(req.url ?? "", raw ? JSON.parse(raw) : {})));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

beforeAll(async () => {
  // Only Date is faked (before the import, so the verifier's clock is the fake one): inject needs real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  portal = await stub((url, body) =>
    url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN
      ? { allowed: true, reason: "portal_validated", node: {} }
      : { allowed: false, reason: "invalid_token" }
  );
  inference = await stub((_url, body) => ({
    subtasks: [{ taskId: body.taskId, kind: "single_step", input: "print(6*7)", language: "python", timeoutMs: 3_600_000, snapshotRef: body.snapshotRef }]
  }));
  Object.assign(process.env, {
    PORTAL_SERVICE_URL: urlOf(portal),
    INFERENCE_URL: urlOf(inference),
    MESH_AUTH_TOKEN: MESH,
    REQUIRE_SIGNED_AGENT_REQUESTS: "false",
    RESULT_VERIFICATION_RATE: "1",
    RESULT_VERIFICATION_TIMEOUT_MS: String(DEADLINE_MS),
    RESULT_VERIFICATION_REPLICA_CLAIM_TIMEOUT_MS: String(CLAIM_WINDOW_MS),
    CLAIM_LEASE_LIVENESS_MS: "86400000",
    CLAIM_MAX_TIMEOUT_MS: "86400000"
  });
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.DATABASE_URL;
  credits = await import("../../src/credits/store.js");
  const mod = await import("../../src/swarm/coordinator.js");
  app = mod.coordinatorServer;
  tick = mod.runResultVerificationTick;
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  await new Promise<void>((resolve) => inference.close(() => resolve()));
  vi.useRealTimers();
});

async function register(agentId: string) {
  const keys = createPeerKeys(agentId);
  const payload = JSON.stringify({ agentId, os: "linux", version: "1", mode: "swarm-only", registrationToken: VALID_TOKEN, sandboxMode: "docker", publicKeyPem: keys.publicKeyPem });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: "203.0.113.9", headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

const post = (url: string, body: unknown) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json", "x-mesh-token": MESH }, payload: JSON.stringify(body) });

async function pull(agentId: string): Promise<{ id: string; taskId: string } | null> {
  const res = await post("/pull", { agentId });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().subtask ?? null;
}

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe("verification replica abandonment through /pull (#162, #117)", () => {
  test("stalled replicas are reassigned, excluding every abandoner, until the deadline; then nobody is paid and the requester is refunded", async () => {
    const agents = ["orig", "lazy1", "lazy2", "lazy3", "lazy4", "late"];
    for (const a of agents) await register(a);
    await credits.grantCredits("acct-requester", 1_000, "test_funding");
    const before = credits.creditEngine.balance("acct-requester");

    const submit = await post("/submit", {
      taskId: "task-verify-1",
      prompt: "compute 6*7",
      snapshotRef: "a".repeat(40),
      submitterAccountId: "acct-requester"
    });
    expect(submit.statusCode, submit.body).toBe(200);
    expect(credits.creditEngine.balance("acct-requester")).toBeLessThan(before);

    // The original runs and is held for verification (rate 1).
    const original = await pull("orig");
    expect(original).not.toBeNull();
    const held = await post("/result", { subtaskId: original!.id, taskId: original!.taskId, agentId: "orig", ok: true, output: "42", durationMs: 1000 });
    expect(held.json()).toMatchObject({ ok: true, held: true });

    // Four agents in turn claim the replica and never report. Stalls at +121s, +242s and +363s
    // leave more than one claim window before the 600s deadline and are reassigned; the stall
    // at +484s leaves 116s and is not.
    const abandoners: string[] = [];
    for (const lazy of ["lazy1", "lazy2", "lazy3", "lazy4"]) {
      for (const gone of abandoners) expect(await pull(gone), `${gone} is excluded`).toBeNull();
      const replica = await pull(lazy);
      expect(replica?.id, `${lazy} gets the replica`).toContain(`${original!.id}::verify:`);
      abandoners.push(lazy);
      advance(CLAIM_WINDOW_MS + 1_000);
      await tick();
    }
    // No replacement after the last stall, for anyone.
    expect(await pull("late")).toBeNull();
    for (const gone of abandoners) expect(await pull(gone)).toBeNull();

    // Before the deadline the result stays held.
    const poll = () => app.inject({ method: "GET", url: `/tasks/${original!.taskId}/subtasks/${original!.id}/result`, headers: { "x-mesh-token": MESH } });
    expect((await poll()).statusCode).toBe(404);

    advance(DEADLINE_MS); // well past startedAt + 600s
    await tick();
    const final = await poll();
    expect(final.statusCode).toBe(200);
    expect(final.json()).toMatchObject({ ok: false, error: "result_verification_unresolved", creditsSpent: 0 });
    // Refunded in full (nothing was used), and the original executor earned nothing.
    expect(credits.creditEngine.balance("acct-requester")).toBeCloseTo(before, 6);
    expect(credits.creditEngine.balance("orig")).toBe(0);
  }, 60_000);

  test("#105: results outvoted by a verified majority are strikes; the third blacklists the agent", async () => {
    for (const a of ["cheat", "honest1", "honest2"]) await register(a);
    for (let i = 0; i < 3; i += 1) {
      expect((await post("/submit", { taskId: `task-cheat-${i}`, prompt: "p", snapshotRef: "b".repeat(40), submitterAccountId: "acct-requester" })).statusCode).toBe(200);
      const original = await pull("cheat");
      expect(original?.taskId).toBe(`task-cheat-${i}`);
      await post("/result", { subtaskId: original!.id, taskId: original!.taskId, agentId: "cheat", ok: true, output: `fake-${i}`, durationMs: 1000 });
      for (const h of ["honest1", "honest2"]) {
        const replica = await pull(h);
        expect(replica?.id).toContain(`${original!.id}::verify:`);
        await post("/result", { subtaskId: replica!.id, taskId: replica!.taskId, agentId: h, ok: true, output: `42-${i}`, durationMs: 1000 });
      }
      const res = await app.inject({ method: "GET", url: `/tasks/${original!.taskId}/subtasks/${original!.id}/result`, headers: { "x-mesh-token": MESH } });
      expect(res.json()).toMatchObject({ ok: true, output: `42-${i}` });
      advance(1_000);
    }
    const blocked = await post("/pull", { agentId: "cheat" });
    expect(blocked.json()).toMatchObject({ subtask: null, blocked: true, reason: expect.stringContaining("VRF001") });
    expect((await post("/pull", { agentId: "honest1" })).json().blocked).toBeUndefined();
  }, 60_000);
});
