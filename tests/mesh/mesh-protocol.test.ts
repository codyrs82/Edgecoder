import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { MeshProtocol } from "../../src/mesh/protocol.js";

describe("mesh protocol", () => {
  it("accepts signed messages and rejects replay", () => {
    const keys = createPeerKeys("peer-a");
    const protocol = new MeshProtocol();
    const msg = protocol.createMessage(
      "queue_summary",
      keys.peerId,
      { queueDepth: 3 },
      keys.privateKeyPem
    );

    expect(protocol.validateMessage(msg, keys.publicKeyPem).ok).toBe(true);
    expect(protocol.validateMessage(msg, keys.publicKeyPem)).toEqual({
      ok: false,
      reason: "duplicate_message"
    });
  });

  it("rejects expired messages", () => {
    const keys = createPeerKeys("peer-a");
    const protocol = new MeshProtocol();
    const msg = protocol.createMessage("task_offer", keys.peerId, { taskId: "t-1" }, keys.privateKeyPem, 1);
    msg.issuedAtMs = Date.now() - 10_000;
    expect(protocol.validateMessage(msg, keys.publicKeyPem).reason).toBe("message_expired");
  });
});
