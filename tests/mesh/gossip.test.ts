import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { GossipMesh } from "../../src/mesh/gossip.js";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { signPeerRequest, verifyPeerRequest } from "../../src/mesh/peer-trust.js";

describe("mesh gossip", () => {
  it("tracks peers and tolerates unreachable peers", async () => {
    const mesh = new GossipMesh();
    mesh.addPeer({
      peerId: "peer-a",
      publicKeyPem: "pk",
      coordinatorUrl: "http://127.0.0.1:65534",
      networkMode: "public_mesh"
    });
    mesh.addPeer({
      peerId: "peer-b",
      publicKeyPem: "pk",
      coordinatorUrl: "http://127.0.0.1:65535",
      networkMode: "public_mesh"
    });
    mesh.removePeer("peer-b");
    expect(mesh.listPeers()).toHaveLength(1);

    const result = await mesh.broadcast({
      id: "m-1",
      type: "queue_summary",
      fromPeerId: "peer-a",
      issuedAtMs: Date.now(),
      ttlMs: 1000,
      payload: { queued: 1 },
      signature: "sig"
    });
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });

  it("signs each HTTP gossip request (broadcast and send) and keeps the mesh token", async () => {
    const self = createPeerKeys("coord-self");
    const got: Array<{ url: string; headers: IncomingHttpHeaders; raw: string }> = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        got.push({ url: req.url ?? "", headers: req.headers, raw });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const mesh = new GossipMesh();
      mesh.setMeshToken("tok");
      mesh.setRequestSigner((method, url, body) =>
        signPeerRequest({ peerId: self.peerId, privateKeyPem: self.privateKeyPem, publicKeyPem: self.publicKeyPem, method, url, body })
      );
      mesh.addPeer({ peerId: "peer-a", publicKeyPem: "pk", coordinatorUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, networkMode: "public_mesh" });
      const msg = { id: "m-2", type: "queue_summary" as const, fromPeerId: self.peerId, issuedAtMs: Date.now(), ttlMs: 1000, payload: { queued: 1 }, signature: "sig" };
      await mesh.broadcast(msg);
      await mesh.send("peer-a", { ...msg, id: "m-3" });
      expect(got).toHaveLength(2);
      const nonces = new Set<string>();
      for (const r of got) {
        expect(r.url).toBe("/mesh/ingest");
        expect(r.headers["x-mesh-token"]).toBe("tok");
        const d = await verifyPeerRequest({ headers: r.headers as Record<string, unknown>, method: "POST", path: r.url, rawBody: r.raw, trusted: (id, key) => id === self.peerId && key === self.publicKeyPem });
        expect(d).toMatchObject({ ok: true, peerId: self.peerId });
        nonces.add(String(r.headers["x-peer-nonce"]));
      }
      expect(nonces.size).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
