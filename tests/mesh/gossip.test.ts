import { describe, expect, it } from "vitest";
import { GossipMesh } from "../../src/mesh/gossip.js";

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
});
