import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { decryptTaskEnvelope, generateX25519KeyPair } from "../../src/security/envelope.js";
import { lanProof, lanProofWindow } from "../../src/swarm/lan-discovery.js";
import { inputDigest, replyDigest, TicketReplayCache, verifyTicket, type LanTicket } from "../../src/swarm/lan-direct.js";

/*
 * Cross-account LAN proximity and direct transfer on the real coordinator app (Fastify inject):
 * what a heartbeat registers, what the world view shows (no address anywhere; other accounts
 * masked), the routing preference for a LAN host, direct tickets (issue, claim, receipt) and that
 * a direct call is billed exactly like a coordinator-path one.
 */

const MESH = "mesh-secret-lan";
const PORTAL = "portal-secret-lan";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.80";
const MODEL = "lanmodel:32b";
/** Long enough that the call costs whole cSats (a 32B model, 2k prompt tokens, 3k reply tokens). */
const REPLY = "word ".repeat(700);
let portal: Server;
let app: any;
const R = createPeerKeys("agent-lan-requester"); // the desktop on the LAN (account R)
const H = createPeerKeys("agent-lan-host"); // someone else's machine on the same LAN (account H)
const F = createPeerKeys("agent-lan-far"); // a machine elsewhere
const hostEnvelope = generateX25519KeyPair();
const lan = (() => {
  const mk = () => ({ id: randomBytes(8).toString("hex"), key: randomBytes(32) });
  return { R: mk(), H: mk(), F: mk() };
})();
const proof = (k: { id: string; key: Buffer }, nowMs = Date.now()) => ({ id: k.id, p: lanProof(k.key, k.id, lanProofWindow(nowMs)), w: lanProofWindow(nowMs) });

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      const body = raw ? JSON.parse(raw) : {};
      const allowed = req.url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN;
      res.end(JSON.stringify(allowed ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, { PORTAL_SERVICE_URL: `http://127.0.0.1:${(portal.address() as AddressInfo).port}`, MESH_AUTH_TOKEN: MESH, PORTAL_SERVICE_TOKEN: PORTAL });
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  await register(R, [], undefined, ["192.168.1.10/24"]);
  await register(H, [MODEL], hostEnvelope.publicKey.toString("base64"), ["192.168.1.20/24"]);
  await register(F, [MODEL]);
  const { grantCredits } = await import("../../src/credits/store.js");
  await grantCredits(R.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.PORTAL_SERVICE_TOKEN;
});

async function register(keys: PeerKeys, installedModels: string[], x25519PublicKey?: string, lanAddresses?: string[]) {
  const payload = JSON.stringify({
    os: "macos", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem, sandboxMode: "none",
    ...(installedModels.length ? { installedModels } : {}), ...(x25519PublicKey ? { x25519PublicKey } : {}), ...(lanAddresses ? { lanAddresses } : {}),
  });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
}

function getSigned(url: string, signer: PeerKeys) {
  const signed = signRequest({ method: "GET", path: url, bodyHash: hashRequestBody(""), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "GET", url, remoteAddress: REMOTE, headers: signed });
}

const heartbeat = (k: PeerKeys, lanBody: unknown) => post("/heartbeat", { agentId: k.peerId, lan: lanBody }, k);

/** R sees H at 1.5 ms; both have direct transfer as given; F is not on the LAN. */
async function lanUp(direct: { R: boolean; H: boolean }) {
  expect((await heartbeat(H, { ids: [{ id: lan.H.id, key: lan.H.key.toString("base64") }], direct: direct.H, neighbours: [] })).statusCode).toBe(200);
  expect((await heartbeat(F, { ids: [{ id: lan.F.id, key: lan.F.key.toString("base64") }], neighbours: [] })).statusCode).toBe(200);
  expect((await heartbeat(R, { ids: [{ id: lan.R.id, key: lan.R.key.toString("base64") }], direct: direct.R, neighbours: [{ ...proof(lan.H), rttMs: 1.5 }] })).statusCode).toBe(200);
}

const messages = [{ role: "user", content: "hello from the LAN" }];
const submit = (extra: Record<string, unknown> = {}) => post("/inference/submit", { taskId: `inf-${randomUUID()}`, submitterAccountId: R.peerId, model: MODEL, messages, timeoutMs: 60_000, maxTokens: 4096, ...extra }, R);
const pullAs = async (k: PeerKeys, extra: Record<string, unknown> = {}) => (await post("/pull", { agentId: k.peerId, inferenceSlots: 2, freeInferenceSlots: 2, ...extra }, k)).json();
const pulledId = (r: { subtask?: { id: string } | null; envelope?: { subtaskId: string } }) => r.subtask?.id ?? r.envelope?.subtaskId ?? null;

async function finish(k: PeerKeys, sub: { taskId: string; subtaskId: string }, text: string) {
  expect((await post("/inference/chunks", { subtaskId: sub.subtaskId, seq: 0, delta: text, done: true, promptTokens: 2000, outputTokens: 3000 }, k)).statusCode).toBe(200);
  const res = await post("/result", { subtaskId: sub.subtaskId, taskId: sub.taskId, agentId: k.peerId, ok: true, output: text, durationMs: 1, model: MODEL }, k);
  expect(res.statusCode, res.body).toBe(200);
}

async function settle(sub: { taskId: string; subtaskId: string }) {
  const r = await post("/inference/stream", { taskId: sub.taskId, subtaskId: sub.subtaskId, after: 0, waitMs: 0 }, R);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { done: boolean; creditsSpent?: number; chunks: string[] };
}

describe("LAN proximity on the coordinator", () => {
  test("the world view marks H as Same network for R, masked; no address, key, proof or LAN id anywhere", async () => {
    await lanUp({ R: false, H: false });
    const res = await getSigned("/network/world", R);
    expect(res.statusCode, res.body).toBe(200);
    const world = res.json() as { agents: Array<Record<string, unknown>> };
    const near = world.agents.filter((a) => a.near);
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ mine: false, near: { rttMs: 1.5 } });
    expect(near[0].name).toBeUndefined();
    expect(String(near[0].label)).toMatch(/^[a-z]{3}-•••[0-9a-f]{4}$/);
    for (const s of [H.peerId, F.peerId, "192.168.1.20", "203.0.113.80", lan.H.id, lan.H.key.toString("base64"), "lanProofs", "lanReports"]) expect(res.body).not.toContain(s);
    // H asks too: it is R's neighbour as well (R reported it), and R stays masked to H.
    const fromH = (await getSigned("/network/world", H)).json() as { agents: Array<Record<string, unknown>> };
    expect(fromH.agents.filter((a) => a.near).map((a) => a.mine)).toEqual([false]);
    // The portal (no machine on any LAN) never gets `near`.
    const portalView = await app.inject({ method: "GET", url: `/network/world?accountId=${R.peerId}`, headers: { "x-portal-service-token": PORTAL } });
    expect(portalView.body).not.toContain('"near"');
  });

  test("peers get ids and proofs (mesh only) but never the keys", async () => {
    const res = await app.inject({ method: "GET", url: "/network/world/local", headers: { "x-mesh-token": MESH } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(lan.H.id);
    expect(res.body).not.toContain(lan.H.key.toString("base64"));
    expect(res.body).not.toContain("192.168.1.20/24".replace("/24", "\"")); // addresses only in the owner-only `lan`
  });

  test("a heartbeat with a forged neighbour proof is ignored; an unsigned one registers nothing", async () => {
    const res = await heartbeat(R, { ids: [{ id: lan.R.id, key: lan.R.key.toString("base64") }], neighbours: [{ id: lan.F.id, p: "0".repeat(16), w: lanProofWindow(Date.now()), rttMs: 1 }] });
    expect(res.statusCode).toBe(200);
    const world = (await getSigned("/network/world", R)).json() as { agents: Array<Record<string, unknown>> };
    expect(world.agents.some((a) => a.near)).toBe(false);
  });

  test("a named-model network call prefers the LAN host with a free slot (billed as usual)", async () => {
    await lanUp({ R: false, H: false });
    const sub = (await submit()).json();
    expect(sub.billing).toBe("per_second");
    expect(sub.lanDirect).toBeUndefined();
    // The far machine is turned away while the LAN host may take it.
    expect(pulledId(await pullAs(F))).toBeNull();
    expect(pulledId(await pullAs(H))).toBe(sub.subtaskId);
    await finish(H, sub, REPLY);
    expect((await settle(sub)).creditsSpent).toBeGreaterThan(0);
  });
});

describe("direct transfer tickets", () => {
  test("no ticket unless both machines opted in", async () => {
    await lanUp({ R: true, H: false });
    const a = (await submit({ lanDirect: { pub: generateX25519KeyPair().publicKey.toString("base64") } })).json();
    expect(a.lanDirect).toBeUndefined();
    await lanUp({ R: false, H: true });
    const b = (await submit({ lanDirect: { pub: generateX25519KeyPair().publicKey.toString("base64") } })).json();
    expect(b.lanDirect).toBeUndefined();
    // Clean up: H takes and finishes both.
    for (const s of [a, b]) {
      expect(pulledId(await pullAs(H))).toBe(s.subtaskId);
      await finish(H, s, "x");
    }
  });

  let ticketed: { taskId: string; subtaskId: string; lanDirect: { ticket: LanTicket } };
  test("both opted in: a ticket for H that verifies under H's LAN key, for this call's input only", async () => {
    await lanUp({ R: true, H: true });
    const pub = generateX25519KeyPair().publicKey.toString("base64");
    const res = await submit({ lanDirect: { pub } });
    expect(res.statusCode, res.body).toBe(200);
    ticketed = res.json();
    const t = ticketed.lanDirect.ticket;
    expect(t).toMatchObject({ hostAgentId: H.peerId, hostLanId: lan.H.id, requesterAgentId: R.peerId, requesterPub: pub, hostPub: hostEnvelope.publicKey.toString("base64"), subtaskId: ticketed.subtaskId, model: MODEL, maxTokens: 4096, inputSha256: inputDigest({ messages }) });
    expect(JSON.stringify(t)).not.toMatch(/192\.168|203\.0\.113/);
    expect(verifyTicket(t, { selfAgentId: H.peerId, keyFor: (id) => (id === lan.H.id ? lan.H.key : null), nowMs: Date.now(), replay: new TicketReplayCache() }).ok).toBe(true);
    expect(verifyTicket(t, { selfAgentId: F.peerId, keyFor: () => lan.F.key, nowMs: Date.now(), replay: new TicketReplayCache() }).ok).toBe(false);
  });

  test("only the ticketed host can claim it with lanSubtaskId; it gets the queued input", async () => {
    expect(await pullAs(F, { lanSubtaskId: ticketed.subtaskId })).toMatchObject({ subtask: null, lanClaim: "unavailable" });
    const got = await pullAs(H, { lanSubtaskId: ticketed.subtaskId });
    expect(pulledId(got)).toBe(ticketed.subtaskId);
    const input = JSON.parse(decryptTaskEnvelope(got.envelope, hostEnvelope.privateKey).input);
    expect(inputDigest({ messages: input.messages, tools: input.tools })).toBe(ticketed.lanDirect.ticket.inputSha256);
    // Claimed once: asking again is "unavailable".
    expect(await pullAs(H, { lanSubtaskId: ticketed.subtaskId })).toMatchObject({ lanClaim: "unavailable" });
  });

  test("billing parity: the direct call costs what the same call through the coordinator costs", async () => {
    await finish(H, ticketed, REPLY);
    const direct = await settle(ticketed);
    await lanUp({ R: false, H: false });
    const plain = (await submit()).json();
    expect(pulledId(await pullAs(H))).toBe(plain.subtaskId);
    await finish(H, plain, REPLY);
    const viaCoordinator = await settle(plain);
    expect(direct.creditsSpent).toBeGreaterThan(0);
    expect(direct.creditsSpent).toBe(viaCoordinator.creditsSpent);
    expect(direct.chunks.join("")).toBe(REPLY);
  });

  test("the requester's receipt: a match is recorded; a mismatch is counted and three stop H's tickets", async () => {
    const receipt = (text: string, sub = ticketed) => post("/inference/lan-receipt", { taskId: sub.taskId, subtaskId: sub.subtaskId, tid: sub.lanDirect.ticket.tid, replySha256: replyDigest(text), replyBytes: Buffer.byteLength(text) }, R);
    expect((await receipt(REPLY)).json()).toEqual({ ok: true, match: true });
    // Only the requester the ticket names may send it.
    const other = await post("/inference/lan-receipt", { taskId: ticketed.taskId, subtaskId: ticketed.subtaskId, tid: ticketed.lanDirect.ticket.tid, replySha256: replyDigest("x"), replyBytes: 1 }, F);
    expect(other.statusCode).toBe(403);
    for (let i = 0; i < 3; i++) expect((await receipt("something else")).json()).toEqual({ ok: true, match: false });
    await lanUp({ R: true, H: true });
    const after = (await submit({ lanDirect: { pub: generateX25519KeyPair().publicKey.toString("base64") } })).json();
    expect(after.lanDirect).toBeUndefined();
    expect(pulledId(await pullAs(H))).toBe(after.subtaskId);
    await finish(H, after, "x");
  });
});
