import { describe, expect, test } from "vitest";
import { createPeerKeys, verifyPayload } from "../../src/mesh/peer.js";
import { createTreasuryPolicy, signKeyCustodyEvent } from "../../src/economy/treasury.js";

describe("treasury policy and custody events", () => {
  test("creates draft policy with quorum metadata", () => {
    const policy = createTreasuryPolicy({
      treasuryAccountId: "treasury-main",
      multisigDescriptor: "wsh(sortedmulti(2,[fingera/48h/0h/0h]xpubA/*,[fingerb/48h/0h/0h]xpubB/*))",
      quorumThreshold: 2,
      totalCustodians: 3,
      approvedCoordinatorIds: ["coord-a", "coord-b"],
      keyRotationDays: 90
    });
    expect(policy.status).toBe("draft");
    expect(policy.quorumThreshold).toBe(2);
    expect(policy.totalCustodians).toBe(3);
  });

  test("signs custody events verifiably", () => {
    const keys = createPeerKeys("coord-a");
    const event = signKeyCustodyEvent({
      policyId: "policy-1",
      actorId: "coord-a",
      action: "rotate_key",
      details: "rotate shard 2",
      privateKeyPem: keys.privateKeyPem
    });
    const payload = JSON.stringify({
      policyId: event.policyId,
      actorId: event.actorId,
      action: event.action,
      details: event.details,
      createdAtMs: event.createdAtMs
    });
    expect(verifyPayload(payload, event.signature, keys.publicKeyPem)).toBe(true);
  });
});
