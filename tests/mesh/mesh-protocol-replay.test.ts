import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { MAX_MESSAGE_TTL_MS, MeshProtocol } from "../../src/mesh/protocol.js";

const keys = createPeerKeys("peer-a");
const YEAR_MS = 365 * 24 * 3600_000;

describe("mesh protocol replay window", () => {
  it("caps a sender-chosen ttlMs", () => {
    let now = 1_000_000_000;
    const clock = () => now;
    const msg = new MeshProtocol(clock).createMessage("queue_summary", keys.peerId, {}, keys.privateKeyPem, YEAR_MS);
    now += MAX_MESSAGE_TTL_MS + 1;
    expect(new MeshProtocol(clock).validateMessage(msg, keys.publicKeyPem).reason).toBe("message_expired");
    now -= 2;
    expect(new MeshProtocol(clock).validateMessage(msg, keys.publicKeyPem).ok).toBe(true);
  });

  it("rejects messages issued far in the future", () => {
    const now = 1_000_000_000;
    const msg = new MeshProtocol(() => now + 10 * 60_000).createMessage("queue_summary", keys.peerId, {}, keys.privateKeyPem);
    expect(new MeshProtocol(() => now).validateMessage(msg, keys.publicKeyPem).reason).toBe("message_from_future");
  });

  it("never evicts an unexpired id, so a replay inside the TTL is still caught", () => {
    let now = 1_000_000_000;
    const clock = () => now;
    const sender = new MeshProtocol(clock);
    const receiver = new MeshProtocol(clock, 3);
    const send = (n: number) => sender.createMessage("queue_summary", keys.peerId, { n }, keys.privateKeyPem, 30_000);

    const first = send(0);
    expect(receiver.validateMessage(first, keys.publicKeyPem).ok).toBe(true);
    expect(receiver.validateMessage(send(1), keys.publicKeyPem).ok).toBe(true);
    expect(receiver.validateMessage(send(2), keys.publicKeyPem).ok).toBe(true);
    // Full of unexpired ids: a new message is refused instead of evicting `first`.
    expect(receiver.validateMessage(send(3), keys.publicKeyPem).reason).toBe("replay_cache_full");
    expect(receiver.validateMessage(first, keys.publicKeyPem).reason).toBe("duplicate_message");

    // After the TTL the old ids are pruned and new messages fit again.
    now += 31_000;
    expect(receiver.validateMessage(send(4), keys.publicKeyPem).ok).toBe(true);
  });
});
