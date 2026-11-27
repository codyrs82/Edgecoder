import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { MeshProtocol } from "../../src/mesh/protocol.js";
import { signMeshWsBind } from "../../src/mesh/ws-auth.js";
import { publicKeyFingerprint, signForwardedResult, signPeerRequest, signRegistration, verifyPeerRequest } from "../../src/mesh/peer-trust.js";

/*
 * Signed peer requests with MESH_TOKEN_REQUIRED_FOR_PEERS=false (real coordinator app, Fastify
 * inject, a stand-in peer coordinator on a local HTTP server): a peer route takes either the mesh
 * token or a request signed by an allowlisted peer key; outbound peer calls are signed and still
 * carry the token while one is configured.
 */

const MESH = "mesh-secret-signed-peers";
const ADMIN = "admin-secret-signed-peers";
const REMOTE = "203.0.113.70";
const A = createPeerKeys("coord-signed-a");
const B = createPeerKeys("coord-signed-b");
const STRANGER = createPeerKeys("coord-signed-stranger");
const proto = new MeshProtocol();
let fakePeer: Server;
let fakePeerUrl = "";
let app: any;

/** Requests the stand-in peer (coord-signed-a) received from the coordinator under test. */
const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; raw: string }> = [];

beforeAll(async () => {
  fakePeer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, raw });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/identity") {
        return res.end(JSON.stringify({ peerId: A.peerId, publicKeyPem: A.publicKeyPem, coordinatorUrl: fakePeerUrl, networkMode: "public_mesh" }));
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => fakePeer.listen(0, "127.0.0.1", resolve));
  fakePeerUrl = `http://127.0.0.1:${(fakePeer.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.ADMIN_API_TOKEN = ADMIN;
  process.env.ADMIN_ALLOWED_CIDRS = `${REMOTE}/32`;
  process.env.MESH_TOKEN_REQUIRED_FOR_PEERS = "false";
  process.env.MESH_PEER_ALLOWLIST = [
    `${A.peerId}:${publicKeyFingerprint(A.publicKeyPem)}@${fakePeerUrl}`,
    `${B.peerId}:${publicKeyFingerprint(B.publicKeyPem)}@https://b.invalid`
  ].join(",");
  process.env.COORDINATOR_BOOTSTRAP_URLS = fakePeerUrl;
  delete process.env.PORTAL_SERVICE_URL;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => fakePeer.close(() => resolve()));
  for (const k of ["MESH_PEER_ALLOWLIST", "MESH_TOKEN_REQUIRED_FOR_PEERS", "COORDINATOR_BOOTSTRAP_URLS", "ADMIN_ALLOWED_CIDRS"]) delete process.env[k];
});

beforeEach(() => {
  seen.length = 0;
});

/** A request signed as peer `keys` (no mesh token unless `token`). */
function signed(method: "GET" | "POST", url: string, opts: { keys?: PeerKeys; body?: unknown; token?: boolean; nowMs?: number; signBody?: string; headers?: Record<string, string> } = {}) {
  const keys = opts.keys ?? A;
  const payload = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const sig = signPeerRequest({ peerId: keys.peerId, privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem, method, url, body: opts.signBody ?? payload ?? "", nowMs: opts.nowMs });
  return app.inject({
    method,
    url,
    remoteAddress: REMOTE,
    headers: { ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...(opts.token ? { "x-mesh-token": MESH } : {}), ...(opts.headers ?? {}), ...sig },
    ...(payload !== undefined ? { payload } : {})
  });
}

const regFields = (keys: PeerKeys, url: string) => ({ peerId: keys.peerId, publicKeyPem: keys.publicKeyPem, coordinatorUrl: url, networkMode: "public_mesh" as const, role: "coordinator" as const });

async function registerA() {
  const fields = regFields(A, fakePeerUrl);
  const res = await signed("POST", "/mesh/register-peer", { body: { ...fields, ...signRegistration(fields, A.privateKeyPem) } });
  expect(res.statusCode, res.body).toBe(200);
}

/** The coordinator under test, for checking what it signed. */
async function selfIdentity(): Promise<{ peerId: string; publicKeyPem: string }> {
  return (await app.inject({ method: "GET", url: "/identity" })).json();
}

async function expectSignedByCoordinator(r: { method: string; url: string; headers: IncomingHttpHeaders; raw: string }) {
  const self = await selfIdentity();
  expect(r.headers["x-mesh-token"]).toBe(MESH); // still sent while configured
  const decision = await verifyPeerRequest({
    headers: r.headers as Record<string, unknown>,
    method: r.method,
    path: r.url,
    rawBody: r.raw,
    trusted: (id, key) => id === self.peerId && key === self.publicKeyPem
  });
  expect(decision).toMatchObject({ ok: true, peerId: self.peerId });
}

describe("inbound: token or signature (flag off)", () => {
  test("token-only is still accepted", async () => {
    const res = await app.inject({ method: "GET", url: "/network/world/local", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
    expect(res.statusCode).toBe(200);
  });

  test("signature-only is accepted on peer routes", async () => {
    expect((await signed("GET", "/network/world/local")).statusCode).toBe(200);
    expect((await signed("GET", "/receipts/since?cursor=&limit=5")).statusCode).toBe(200);
    expect((await signed("GET", "/stats/ledger/head")).statusCode).toBe(200);
    expect((await signed("GET", "/mesh/capabilities")).statusCode).toBe(200);
  });

  test("token plus a valid signature is accepted", async () => {
    expect((await signed("GET", "/network/world/local", { token: true })).statusCode).toBe(200);
  });

  test("signature-only is refused for a key that is not allowlisted", async () => {
    const res = await signed("GET", "/network/world/local", { keys: STRANGER });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("mesh_unauthorized");
  });

  test("signature-only is refused off the peer routes (agents and operator routes are unchanged)", async () => {
    expect((await signed("GET", "/mesh/peers")).statusCode).toBe(401);
    expect((await signed("POST", "/economy/price/consensus", { body: { cpuCapacity: 1, gpuCapacity: 0, queuedTasks: 0, activeAgents: 1 } })).statusCode).toBe(401);
  });

  test("an expired signature is refused", async () => {
    expect((await signed("GET", "/network/world/local", { nowMs: Date.now() - 10 * 60_000 })).statusCode).toBe(401);
  });

  test("a replayed signed request is refused", async () => {
    const sig = signPeerRequest({ peerId: A.peerId, privateKeyPem: A.privateKeyPem, publicKeyPem: A.publicKeyPem, method: "GET", url: "/network/world/local" });
    const send = () => app.inject({ method: "GET", url: "/network/world/local", remoteAddress: REMOTE, headers: sig });
    expect((await send()).statusCode).toBe(200);
    const again = await send();
    expect(again.statusCode).toBe(409);
    expect(again.json().reason).toBe("peer_signature_replayed");
  });

  test("a signature over another body is refused, even next to a valid token", async () => {
    const res = await signed("POST", "/receipts/replicate", { body: { receipts: [] }, signBody: JSON.stringify({ receipts: ["x"] }), token: true });
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe("peer_body_mismatch");
  });

  test("a token request with a signature by a key this coordinator does not trust goes on as token-only", async () => {
    expect((await signed("GET", "/network/world/local", { keys: STRANGER, token: true })).statusCode).toBe(200);
  });
});

describe("register-peer and gossip by signature alone", () => {
  test("an allowlisted peer registers with a signed request and no token", async () => {
    await registerA();
    const peers = (await app.inject({ method: "GET", url: "/mesh/peers", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } })).json().peers;
    expect(peers.some((p: { peerId: string }) => p.peerId === A.peerId)).toBe(true);
  });

  test("a signed request registers its own peer id only", async () => {
    const fields = regFields(B, "https://b.invalid");
    const res = await signed("POST", "/mesh/register-peer", { keys: A, body: { ...fields, ...signRegistration(fields, B.privateKeyPem) } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("peer_id_mismatch");
  });

  test("the registration proof is still required", async () => {
    const res = await signed("POST", "/mesh/register-peer", { body: regFields(A, fakePeerUrl) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("peer_signature_required");
  });

  test("a non-allowlisted peer cannot register by signature", async () => {
    const fields = regFields(STRANGER, "https://s.invalid");
    expect((await signed("POST", "/mesh/register-peer", { keys: STRANGER, body: { ...fields, ...signRegistration(fields, STRANGER.privateKeyPem) } })).statusCode).toBe(401);
  });

  test("gossip from a registered peer is ingested by signature alone", async () => {
    await registerA();
    const msg = proto.createMessage("capability_summary" as any, A.peerId, { models: [] }, A.privateKeyPem, 60_000);
    const res = await signed("POST", "/mesh/ingest", { body: msg });
    expect(res.statusCode, res.body).toBe(200);
  });

  test("a forwarded /result signed by the peer reaches the forward checks without a token", async () => {
    await registerA();
    const json = JSON.stringify({ subtaskId: "never-offered", taskId: "t", agentId: "agent-x", ok: true, output: "1", durationMs: 10 });
    const res = await signed("POST", "/result", { body: json, headers: signForwardedResult(A.peerId, A.privateKeyPem, json) });
    // Past the gate and classified as a peer forward; refused only because it was never offered.
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("subtask_not_offered");
  });

  test("/mesh/ws: a registered peer binds with its signed bind and no token; unsigned is refused", async () => {
    await registerA();
    const closeCode = (ws: any) =>
      new Promise<number | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 300);
        ws.on("close", (code: number) => {
          clearTimeout(t);
          resolve(code);
        });
      });
    const ok = await app.injectWS(`/mesh/ws?peerId=${A.peerId}`, { headers: signMeshWsBind(A.peerId, A.privateKeyPem) });
    expect(await closeCode(ok)).toBeNull();
    ok.terminate();
    const unsigned = await app.injectWS(`/mesh/ws?peerId=${A.peerId}`, {});
    expect(await closeCode(unsigned)).toBe(4001);
  });
});

describe("outbound peer calls are signed and still carry the token", () => {
  test("bootstrap registration (peers.ts)", async () => {
    const { bootstrapPeerMesh } = await import("../../src/swarm/coordinator/peers.js");
    await bootstrapPeerMesh();
    const reg = seen.find((r) => r.url === "/mesh/register-peer");
    expect(reg).toBeTruthy();
    await expectSignedByCoordinator(reg!);
  });

  test("price quotes for consensus (routes/pricing.ts)", async () => {
    await registerA();
    await app.inject({
      method: "POST",
      url: "/economy/price/consensus",
      remoteAddress: REMOTE,
      headers: { "content-type": "application/json", "x-mesh-token": MESH, "x-admin-token": ADMIN },
      payload: JSON.stringify({ cpuCapacity: 1, gpuCapacity: 0, queuedTasks: 0, activeAgents: 1 })
    });
    const quote = seen.find((r) => r.url.startsWith("/economy/price/quote"));
    expect(quote).toBeTruthy();
    await expectSignedByCoordinator(quote!);
  });

  test("peer world views (routes/network-world.ts)", async () => {
    const { setWorldPeerFetch } = await import("../../src/swarm/coordinator/routes/network-world.js");
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    setWorldPeerFetch(async (url, headers) => {
      calls.push({ url, headers });
      return { status: 503, json: null };
    });
    try {
      await app.inject({ method: "GET", url: "/network/world", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
      const call = calls.find((c) => c.url === `${fakePeerUrl}/network/world/local`);
      expect(call).toBeTruthy();
      await expectSignedByCoordinator({ method: "GET", url: "/network/world/local", headers: call!.headers, raw: "" });
    } finally {
      setWorldPeerFetch(null);
    }
  });
});
