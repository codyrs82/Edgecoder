import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";

/*
 * Token padding on network model calls (real coordinator app, Fastify inject):
 * - a call with no maxTokens gets the default output cap, and an agent is never paid for output
 *   past a call's cap, whatever it streams or reports;
 * - a reply that turns into repeated filler is billed for its clean prefix only (the rest of the
 *   reserve goes back to the requester), and a pattern of such replies is a behaviour strike.
 */

const MESH = "mesh-secret-padding";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.46";
const MODEL = "qwen-pad:7b";
let portal: Server;
let app: any;
let autoBlacklister: { getStrikeCount: (id: string) => number };
const requester = createPeerKeys("agent-padding-requester");
const worker = createPeerKeys("agent-padding-worker");

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
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  delete process.env.INFERENCE_DEFAULT_MAX_TOKENS;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ({ autoBlacklister } = await import("../../src/swarm/coordinator/agent-state.js"));
  await app.ready();
  for (const keys of [requester, worker]) {
    const payload = JSON.stringify({
      os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
      sandboxMode: "docker", installedModels: keys === worker ? [MODEL] : [],
    });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
    expect(res.statusCode).toBe(200);
  }
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

async function accrualsFor(subtaskId: string): Promise<any[]> {
  const snap = (await app.inject({ method: "GET", url: "/ledger/snapshot", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } })).json();
  return snap.records.filter((r: any) => r.eventType === "earnings_accrual" && r.subtaskId === subtaskId).map((r: any) => JSON.parse(r.payloadJson));
}

/** Varied, honest-looking text of about `chars` characters. */
function varied(chars: number): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += `Line ${i}: ${randomUUID().slice(0, 8)} checks ${randomUUID().slice(0, 6)} before it returns.\n`;
  return s.slice(0, chars);
}

/**
 * One whole call: submit (with `extra`), the worker claims it, streams `reply` reporting
 * `outputTokens`, posts its result, and the requester reads the end of the stream.
 */
async function call(reply: string, outputTokens: number, extra: Record<string, unknown> = {}) {
  const taskId = `inf-${randomUUID()}`;
  const balanceBefore = creditEngine.balance(requester.peerId);
  const sub = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "write it" }], timeoutMs: 60_000, ...extra }, requester);
  expect(sub.statusCode, sub.body).toBe(200);
  const pulled = (await post("/pull", { agentId: worker.peerId }, worker)).json();
  const st = pulled.subtask;
  expect(st?.taskId).toBe(taskId);
  expect((await post("/inference/chunks", { subtaskId: st.id, seq: 0, delta: reply, done: true, promptTokens: 10, outputTokens }, worker)).statusCode).toBe(200);
  const reading = post("/inference/stream", { taskId, subtaskId: st.id, waitMs: 0 }, requester).then((r: unknown) => r);
  await new Promise((r) => setTimeout(r, 50));
  const res = await post("/result", { subtaskId: st.id, taskId, agentId: worker.peerId, ok: true, output: reply, durationMs: 2_000, model: MODEL }, worker);
  expect(res.statusCode, res.body).toBe(200);
  const read: any = (await reading as any).json();
  const [acc] = await accrualsFor(st.id);
  return { st, read, acc, charged: balanceBefore - creditEngine.balance(requester.peerId), input: JSON.parse(st.input) };
}

describe("output cap", () => {
  test("a call with no maxTokens gets the default cap, and output past it is not billed", async () => {
    const { input, read } = await call(varied(60_000), 50_000);
    expect(input.maxTokens).toBe(4096);
    expect(read.outputTokens).toBe(4096 + 64);
  });

  test("a call's own maxTokens is kept and bounds the bill the same way", async () => {
    const { input, read } = await call(varied(20_000), 9_000, { maxTokens: 1_000 });
    expect(input.maxTokens).toBe(1_000);
    expect(read.outputTokens).toBe(1_064);
  });
});

describe("degenerate replies", () => {
  test("a padded reply is billed for its clean prefix only; an honest reply of the same size in full", async () => {
    const clean = varied(4_000);
    const padded = `${clean}\n${"I hope this helps! ".repeat(1_100)}`;
    const honest = varied(padded.length);
    const h = await call(honest, 6_000, { maxTokens: 32_768 });
    const p = await call(padded, 6_000, { maxTokens: 32_768 });
    expect(h.read.outputTokens).toBe(6_000);
    // About 4,000 of ~24,900 bytes are clean: ~16% of the reported tokens are billed.
    expect(p.read.outputTokens).toBeGreaterThan(800);
    expect(p.read.outputTokens).toBeLessThan(1_200);
    // The agent is paid less and the requester charged less: the rest of the reserve came back.
    expect(p.acc.costMsat).toBeLessThan(h.acc.costMsat / 3);
    expect(p.charged).toBeCloseTo(p.acc.costMsat / 1000, 2);
    // The requester still got the whole reply it was sent.
    expect(p.read.chunks.join("")).toBe(padded);
  });

  test("a pattern of padded replies is a behaviour strike; one loop now and then is not", async () => {
    const strikesBefore = autoBlacklister.getStrikeCount(worker.peerId);
    // Up to here this agent sent one padded reply among several honest ones: no strike.
    expect(strikesBefore).toBe(0);
    const pad = () => `${varied(3_000)}\n${"lorem ipsum dolor ".repeat(800)}`;
    await call(pad(), 4_000);
    // 2 padded of 5 calls in the window: not yet a pattern.
    expect(autoBlacklister.getStrikeCount(worker.peerId)).toBe(0);
    // 3 of 6: at least three, and half of its calls. Each further padded reply is a strike.
    await call(pad(), 4_000);
    expect(autoBlacklister.getStrikeCount(worker.peerId)).toBe(1);
    await call(pad(), 4_000);
    expect(autoBlacklister.getStrikeCount(worker.peerId)).toBe(2);
  });
});
