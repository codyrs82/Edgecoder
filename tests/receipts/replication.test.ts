import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createPeerKeys, signPayload } from "../../src/mesh/peer.js";
import { closeEpoch } from "../../src/receipts/epochs.js";
import {
  countersignAsCoordinator,
  deriveReceiptId,
  hashResultOutput,
  signReceiptAsAgent,
  verifyMerkleProof,
  type WorkReceipt
} from "../../src/receipts/receipt.js";
import {
  acceptReceipts,
  registerReceiptRoutes,
  startReceiptReplication,
  verifyReceiptPage,
  type ReplicationFetch,
  type SignedReceiptPage
} from "../../src/receipts/replication.js";
import { MemoryReceiptStore } from "../../src/receipts/store.js";

const MESH_TOKEN = "mesh-secret";
const agent = createPeerKeys("agent-1");
const coordA = createPeerKeys("coord-a");
const coordB = createPeerKeys("coord-b");
const rogue = createPeerKeys("coord-rogue");
const knownKeys = new Map([
  [coordA.peerId, coordA.publicKeyPem],
  [coordB.peerId, coordB.publicKeyPem]
]);

function receiptFrom(coord: typeof coordA, subtaskId: string, finishedAtMs = 2_000): WorkReceipt {
  const claim = signReceiptAsAgent(
    {
      taskId: "task",
      subtaskId,
      agentId: agent.peerId,
      agentPublicKeyPem: agent.publicKeyPem,
      startedAtMs: finishedAtMs - 500,
      finishedAtMs,
      resultHash: hashResultOutput(subtaskId)
    },
    agent.privateKeyPem
  );
  return countersignAsCoordinator(
    claim,
    { coordinatorId: coord.peerId, coordinatorPublicKeyPem: coord.publicKeyPem, computeClass: "cpu", credits: 2, msat: 60_000, msatPerCredit: 30_000 },
    coord.privateKeyPem
  );
}

function forge(receipt: WorkReceipt): WorkReceipt {
  const { receiptId: _id, coordinatorSignature: _sig, ...body } = { ...receipt, credits: 999 };
  return { ...receipt, credits: 999, receiptId: deriveReceiptId(body) };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function coordinatorApp(coord: typeof coordA, store: MemoryReceiptStore): FastifyInstance {
  const app = Fastify();
  registerReceiptRoutes(app, {
    store,
    coordinatorId: coord.peerId,
    requireMeshToken: (req, reply) => {
      if (req.headers["x-mesh-token"] === MESH_TOKEN) return true;
      reply.code(401);
      return false;
    },
    sign: (payload) => signPayload(payload, coord.privateKeyPem),
    coordinatorPublicKeyFor: (id) => knownKeys.get(id) ?? null,
    now: () => 10_000
  });
  apps.push(app);
  return app;
}

const auth = { "x-mesh-token": MESH_TOKEN };

describe("receipt routes", () => {
  it("requires the mesh token", async () => {
    const app = coordinatorApp(coordA, new MemoryReceiptStore());
    expect((await app.inject({ method: "GET", url: "/receipts/since" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/receipts/replicate", payload: { receipts: [] } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/receipts/epochs/latest" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/receipts/abc" })).statusCode).toBe(401);
  });

  it("POST /receipts/replicate accepts valid receipts once and rejects forged ones", async () => {
    const store = new MemoryReceiptStore();
    const app = coordinatorApp(coordA, store);
    const valid = [receiptFrom(coordB, "b1"), receiptFrom(coordB, "b2")];
    const forged = forge(receiptFrom(coordB, "b3"));
    const fromRogue = receiptFrom(rogue, "r1");
    const badSig = { ...valid[0], receiptId: "0".repeat(64) };

    const res = await app.inject({
      method: "POST",
      url: "/receipts/replicate",
      headers: auth,
      payload: { receipts: [...valid, forged, fromRogue, badSig, { nonsense: true }] }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(2);
    expect(body.duplicates).toBe(0);
    expect(body.rejected).toEqual([
      { receiptId: forged.receiptId, reason: "coordinator_signature_invalid" },
      { receiptId: fromRogue.receiptId, reason: "coordinator_unknown" },
      { receiptId: badSig.receiptId, reason: "receipt_id_mismatch" },
      { receiptId: null, reason: "malformed" }
    ]);
    expect(store.size()).toBe(2);

    const again = await app.inject({ method: "POST", url: "/receipts/replicate", headers: auth, payload: { receipts: valid } });
    expect(again.json()).toMatchObject({ accepted: 0, duplicates: 2, rejected: [] });
    expect(store.size()).toBe(2);
  });

  it("rejects a receipt whose coordinator key differs from the one the mesh knows", async () => {
    const store = new MemoryReceiptStore();
    const impostor = createPeerKeys(coordB.peerId); // same id, different key
    const r = receiptFrom(impostor, "imp");
    const result = await acceptReceipts(store, [r], { coordinatorPublicKeyFor: (id) => knownKeys.get(id) ?? null });
    expect(result.rejected).toEqual([{ receiptId: r.receiptId, reason: "coordinator_key_mismatch" }]);
  });

  it("GET /receipts/since returns signed, cursor-paginated pages", async () => {
    const store = new MemoryReceiptStore();
    const app = coordinatorApp(coordA, store);
    const receipts = [receiptFrom(coordA, "a1"), receiptFrom(coordA, "a2"), receiptFrom(coordA, "a3")];
    for (const r of receipts) await store.append(r);

    const p1 = (await app.inject({ method: "GET", url: "/receipts/since?limit=2", headers: auth })).json() as SignedReceiptPage;
    expect(p1.coordinatorId).toBe(coordA.peerId);
    expect(p1.receipts.map((r) => r.receiptId)).toEqual([receipts[0].receiptId, receipts[1].receiptId]);
    expect(p1.nextCursor).toBe("2");
    expect(verifyReceiptPage(p1, coordA.publicKeyPem)).toBe(true);
    expect(verifyReceiptPage(p1, coordB.publicKeyPem)).toBe(false);
    expect(verifyReceiptPage({ ...p1, receipts: [] }, coordA.publicKeyPem)).toBe(false);

    const p2 = (await app.inject({ method: "GET", url: `/receipts/since?cursor=${p1.nextCursor}&limit=2`, headers: auth })).json() as SignedReceiptPage;
    expect(p2.receipts.map((r) => r.receiptId)).toEqual([receipts[2].receiptId]);
    expect(p2.nextCursor).toBe("3");

    const p3 = (await app.inject({ method: "GET", url: `/receipts/since?cursor=3`, headers: auth })).json() as SignedReceiptPage;
    expect(p3.receipts).toEqual([]);
    expect(p3.nextCursor).toBe("3");
  });

  it("GET /receipts/:id returns the receipt and, once closed, a proof that verifies against the latest epoch", async () => {
    const store = new MemoryReceiptStore();
    const app = coordinatorApp(coordA, store);
    const r = receiptFrom(coordA, "proof-me");
    await store.append(r);
    expect((await app.inject({ method: "GET", url: "/receipts/missing", headers: auth })).statusCode).toBe(404);
    let res = (await app.inject({ method: "GET", url: `/receipts/${r.receiptId}`, headers: auth })).json();
    expect(res.receipt.receiptId).toBe(r.receiptId);
    expect(res.proof).toBeNull();

    await closeEpoch(store, { coordinatorId: coordA.peerId, coordinatorPrivateKeyPem: coordA.privateKeyPem, untilMs: 5_000 });
    res = (await app.inject({ method: "GET", url: `/receipts/${r.receiptId}`, headers: auth })).json();
    const latest = (await app.inject({ method: "GET", url: "/receipts/epochs/latest", headers: auth })).json();
    expect(latest.epoch.count).toBe(1);
    expect(res.proof.epochId).toBe(latest.epoch.epochId);
    expect(verifyMerkleProof(res.proof.leaf, res.proof.proof, latest.epoch.merkleRoot)).toBe(true);
  });
});

describe("startReceiptReplication", () => {
  function fetchVia(app: FastifyInstance): ReplicationFetch {
    return async (url, init) => {
      const u = new URL(url);
      const res = await app.inject({ method: "GET", url: u.pathname + u.search, headers: init?.headers ?? {} });
      return { ok: res.statusCode < 300, status: res.statusCode, json: async () => res.json() };
    };
  }

  it("pulls every page from a peer, verifies it and stores only valid receipts", async () => {
    const storeA = new MemoryReceiptStore();
    const appA = coordinatorApp(coordA, storeA);
    const mine = Array.from({ length: 5 }, (_, i) => receiptFrom(coordA, `a${i}`));
    for (const r of mine) await storeA.append(r);
    // A also holds a receipt it replicated from B earlier, plus a forged one it should never have accepted
    // (simulating a compromised or buggy peer): the puller must still verify.
    await storeA.append(receiptFrom(coordB, "via-a"));
    await storeA.append(forge(receiptFrom(coordA, "forged")));

    const storeB = new MemoryReceiptStore();
    const handle = startReceiptReplication({
      peers: () => [{ peerId: coordA.peerId, coordinatorUrl: "http://coord-a.test/", publicKeyPem: coordA.publicKeyPem }],
      store: storeB,
      intervalMs: 60_000,
      fetch: fetchVia(appA),
      selfId: coordB.peerId,
      meshToken: MESH_TOKEN,
      pageLimit: 2,
      coordinatorPublicKeyFor: (id) => knownKeys.get(id) ?? null
    });
    try {
      const outcomes = await handle.pullOnce();
      expect(outcomes).toEqual([{ peerId: coordA.peerId, accepted: 6, duplicates: 0, rejected: 1 }]);
      expect(storeB.size()).toBe(6);
      expect(handle.cursorFor(coordA.peerId)).toBe("7");

      // Nothing new: cursor holds, nothing re-accepted.
      expect(await handle.pullOnce()).toEqual([{ peerId: coordA.peerId, accepted: 0, duplicates: 0, rejected: 0 }]);
      expect(handle.cursorFor(coordA.peerId)).toBe("7");

      // New receipt on A shows up on the next pull.
      await storeA.append(receiptFrom(coordA, "late"));
      expect((await handle.pullOnce())[0].accepted).toBe(1);
      expect(storeB.size()).toBe(7);
    } finally {
      handle.stop();
    }
  });

  it("ignores pages whose signature does not match the peer's pinned key or that claim another coordinator", async () => {
    const storeA = new MemoryReceiptStore();
    const appA = coordinatorApp(coordA, storeA);
    await storeA.append(receiptFrom(coordA, "a1"));
    const storeB = new MemoryReceiptStore();
    const wrongKey = startReceiptReplication({
      peers: () => [{ peerId: coordA.peerId, coordinatorUrl: "http://coord-a.test", publicKeyPem: rogue.publicKeyPem }],
      store: storeB,
      intervalMs: 60_000,
      fetch: fetchVia(appA),
      meshToken: MESH_TOKEN
    });
    try {
      expect((await wrongKey.pullOnce())[0]).toMatchObject({ accepted: 0, error: "page_signature_invalid" });
      expect(storeB.size()).toBe(0);
    } finally {
      wrongKey.stop();
    }

    const wrongId = startReceiptReplication({
      peers: () => [{ peerId: coordB.peerId, coordinatorUrl: "http://coord-a.test", publicKeyPem: coordA.publicKeyPem }],
      store: storeB,
      intervalMs: 60_000,
      fetch: fetchVia(appA),
      meshToken: MESH_TOKEN
    });
    try {
      expect((await wrongId.pullOnce())[0]).toMatchObject({ accepted: 0, error: "page_coordinator_mismatch" });
    } finally {
      wrongId.stop();
    }
  });

  it("reports HTTP and transport errors without throwing", async () => {
    const storeB = new MemoryReceiptStore();
    const handle = startReceiptReplication({
      peers: () => [
        { peerId: "p1", coordinatorUrl: "http://p1.test", publicKeyPem: coordA.publicKeyPem },
        { peerId: "p2", coordinatorUrl: "http://p2.test", publicKeyPem: coordA.publicKeyPem },
        { peerId: coordB.peerId, coordinatorUrl: "http://self.test", publicKeyPem: coordB.publicKeyPem }
      ],
      store: storeB,
      intervalMs: 60_000,
      selfId: coordB.peerId,
      fetch: async (url) => {
        if (url.startsWith("http://p1")) return { ok: false, status: 503, json: async () => ({}) };
        throw new Error("ECONNREFUSED");
      }
    });
    try {
      const out = await handle.pullOnce();
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ peerId: "p1", error: "http_503" });
      expect(out[1].error).toContain("ECONNREFUSED");
    } finally {
      handle.stop();
    }
  });
});
