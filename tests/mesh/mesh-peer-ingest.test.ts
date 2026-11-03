import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { MeshPeer } from "../../src/mesh/mesh-peer.js";
import { MeshProtocol } from "../../src/mesh/protocol.js";

function agent() {
  return new MeshPeer({ peerId: "agent-x", keys: createPeerKeys("agent-x"), publicUrl: "http://127.0.0.1:0", networkMode: "public_mesh", role: "agent", bootstrapUrls: [] });
}

describe("MeshPeer.handleIngest", () => {
  it("drops messages from senders not in the peer table", async () => {
    const peer = agent();
    let handled = 0;
    peer.on("task_offer", async () => {
      handled++;
    });
    const stranger = createPeerKeys("stranger");
    const msg = new MeshProtocol().createMessage("task_offer", "stranger", { subtaskId: "s", taskId: "t", input: "x" }, stranger.privateKeyPem, 30_000);
    expect(await peer.handleIngest(msg)).toEqual({ ok: false, reason: "unknown_sender" });
    expect(handled).toBe(0);
  });

  it("dispatches signed messages from known peers and rejects a wrong key", async () => {
    const peer = agent();
    let handled = 0;
    peer.on("task_offer", async () => {
      handled++;
    });
    const known = createPeerKeys("coord-1");
    peer.addPeer({ peerId: "coord-1", publicKeyPem: known.publicKeyPem, coordinatorUrl: "https://c.example", networkMode: "public_mesh" }, "coordinator");
    const proto = new MeshProtocol();
    expect((await peer.handleIngest(proto.createMessage("task_offer", "coord-1", { a: 1 }, known.privateKeyPem, 30_000))).ok).toBe(true);
    expect(handled).toBe(1);
    const forger = createPeerKeys("forger");
    expect((await peer.handleIngest(proto.createMessage("task_offer", "coord-1", { a: 2 }, forger.privateKeyPem, 30_000))).ok).toBe(false);
    expect(handled).toBe(1);
  });
});
