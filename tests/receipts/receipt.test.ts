import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import {
  EMPTY_MERKLE_ROOT,
  canonicalJson,
  countersignAsCoordinator,
  deriveReceiptId,
  hashResultOutput,
  merkleProof,
  merkleProofForLeaf,
  merkleRoot,
  receiptLeafHash,
  sha256Hex,
  signReceiptAsAgent,
  verifyAgentClaim,
  verifyMerkleProof,
  verifyReceipt,
  type WorkReceipt
} from "../../src/receipts/receipt.js";

const agent = createPeerKeys("agent-1");
const coordinator = createPeerKeys("coord-1");

export function makeReceipt(overrides: Partial<{ subtaskId: string; credits: number; output: string }> = {}): WorkReceipt {
  const output = overrides.output ?? "hello world";
  const claim = signReceiptAsAgent(
    {
      taskId: "task-1",
      subtaskId: overrides.subtaskId ?? "sub-1",
      agentId: agent.peerId,
      agentPublicKeyPem: agent.publicKeyPem,
      startedAtMs: 1_000,
      finishedAtMs: 2_500,
      resultHash: hashResultOutput(output)
    },
    agent.privateKeyPem
  );
  return countersignAsCoordinator(
    claim,
    {
      coordinatorId: coordinator.peerId,
      coordinatorPublicKeyPem: coordinator.publicKeyPem,
      computeClass: "cpu",
      credits: overrides.credits ?? 1.5,
      msat: 45_000,
      msatPerCredit: 30_000
    },
    coordinator.privateKeyPem
  );
}

/** Re-derive receiptId after tampering so only the signature check can catch it. */
function withRecomputedId(receipt: WorkReceipt): WorkReceipt {
  const { receiptId: _id, coordinatorSignature: _sig, ...body } = receipt;
  return { ...receipt, receiptId: deriveReceiptId(body) };
}

describe("work receipts: sign / verify / tamper", () => {
  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("agent claim verifies and the countersigned receipt verifies with both keys", () => {
    const receipt = makeReceipt();
    expect(verifyAgentClaim(receipt)).toBe(true);
    expect(verifyReceipt(receipt)).toEqual({ ok: true });
    expect(receipt.receiptId).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.agentId).toBe("agent-1");
    expect(receipt.coordinatorId).toBe("coord-1");
  });

  it("receiptId is deterministic for the same signed body", () => {
    const a = makeReceipt();
    const { receiptId, coordinatorSignature: _s, ...body } = a;
    expect(deriveReceiptId(body)).toBe(receiptId);
  });

  it("countersigning refuses a claim whose agent signature is invalid", () => {
    const claim = signReceiptAsAgent(
      {
        taskId: "t",
        subtaskId: "s",
        agentId: agent.peerId,
        agentPublicKeyPem: agent.publicKeyPem,
        startedAtMs: 1,
        finishedAtMs: 2,
        resultHash: hashResultOutput("x")
      },
      agent.privateKeyPem
    );
    const forged = { ...claim, resultHash: hashResultOutput("y") };
    expect(() =>
      countersignAsCoordinator(
        forged,
        { coordinatorId: "c", coordinatorPublicKeyPem: coordinator.publicKeyPem, computeClass: "cpu", credits: 1, msat: 1, msatPerCredit: 1 },
        coordinator.privateKeyPem
      )
    ).toThrow("receipt_agent_signature_invalid");
  });

  it("tampering with credits is caught by the receiptId and then by the coordinator signature", () => {
    const receipt = makeReceipt();
    const tampered = { ...receipt, credits: receipt.credits * 10 };
    expect(verifyReceipt(tampered)).toEqual({ ok: false, reason: "receipt_id_mismatch" });
    expect(verifyReceipt(withRecomputedId(tampered))).toEqual({ ok: false, reason: "coordinator_signature_invalid" });
  });

  it("tampering with an agent-signed field is caught by the agent signature", () => {
    const receipt = makeReceipt();
    const tampered = withRecomputedId({ ...receipt, resultHash: hashResultOutput("other output") });
    expect(verifyReceipt(tampered)).toEqual({ ok: false, reason: "agent_signature_invalid" });
  });

  it("swapping the coordinator key fails verification", () => {
    const other = createPeerKeys("coord-2");
    const receipt = makeReceipt();
    const tampered = withRecomputedId({ ...receipt, coordinatorPublicKeyPem: other.publicKeyPem });
    expect(verifyReceipt(tampered)).toEqual({ ok: false, reason: "coordinator_signature_invalid" });
  });

  it("rejects malformed and nonsensical receipts", () => {
    expect(verifyReceipt({} as WorkReceipt)).toEqual({ ok: false, reason: "malformed" });
    const receipt = makeReceipt();
    expect(verifyReceipt({ ...receipt, resultHash: "zz" })).toEqual({ ok: false, reason: "result_hash_invalid" });
    expect(verifyReceipt({ ...receipt, credits: -1 })).toEqual({ ok: false, reason: "negative_amount" });
    expect(verifyReceipt({ ...receipt, finishedAtMs: receipt.startedAtMs - 1 })).toEqual({ ok: false, reason: "time_range_invalid" });
  });

  it("PEM line endings do not change the leaf hash", () => {
    const receipt = makeReceipt();
    const crlf = { ...receipt, agentPublicKeyPem: receipt.agentPublicKeyPem.replace(/\n/g, "\r\n") };
    expect(verifyReceipt(crlf)).toEqual({ ok: true });
    expect(receiptLeafHash(crlf)).toBe(receiptLeafHash(receipt));
  });
});

describe("merkle tree", () => {
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => sha256Hex(`leaf-${i}`));

  it("empty and single-leaf roots", () => {
    expect(merkleRoot([])).toBe(EMPTY_MERKLE_ROOT);
    const [one] = leaves(1);
    expect(merkleRoot([one])).toBe(one);
    expect(verifyMerkleProof(one, merkleProof([one], 0), one)).toBe(true);
  });

  it("root is independent of leaf order and duplicates", () => {
    const l = leaves(6);
    const shuffled = [l[3], l[0], l[5], l[1], l[4], l[2], l[0]];
    expect(merkleRoot(shuffled)).toBe(merkleRoot(l));
  });

  it("inclusion proofs verify for every index, including odd leaf counts", () => {
    for (const n of [2, 3, 4, 5, 7, 8, 9, 16, 17]) {
      const l = leaves(n);
      const root = merkleRoot(l);
      for (let i = 0; i < n; i += 1) {
        const proof = merkleProof(l, i);
        expect(verifyMerkleProof(l[i], proof, root), `n=${n} i=${i}`).toBe(true);
        expect(proof.length).toBe(Math.ceil(Math.log2(n)));
      }
    }
  });

  it("proof fails for a different leaf, a tampered sibling or a different root", () => {
    const l = leaves(5);
    const root = merkleRoot(l);
    const proof = merkleProofForLeaf(l, l[2]);
    expect(verifyMerkleProof(sha256Hex("not-a-member"), proof, root)).toBe(false);
    expect(verifyMerkleProof(l[2], proof, merkleRoot(leaves(4)))).toBe(false);
    const tampered = proof.map((step, i) => (i === 0 ? { ...step, hash: sha256Hex("x") } : step));
    expect(verifyMerkleProof(l[2], tampered, root)).toBe(false);
    expect(verifyMerkleProof(l[2], proof.map((s) => ({ ...s, position: s.position === "left" ? "right" : "left" } as const)), root)).toBe(
      proof.length === 0
    );
  });

  it("rejects non-sha256 leaves and out-of-range indexes", () => {
    expect(() => merkleRoot(["abc"])).toThrow(/merkle_leaf_not_sha256_hex/);
    expect(() => merkleProof(leaves(3), 3)).toThrow("merkle_index_out_of_range");
    expect(() => merkleProofForLeaf(leaves(3), sha256Hex("nope"))).toThrow("merkle_leaf_not_found");
    expect(verifyMerkleProof("zz", [], "zz")).toBe(false);
  });

  it("receipt leaves roll up into a verifiable root", () => {
    const receipts = [makeReceipt({ subtaskId: "a" }), makeReceipt({ subtaskId: "b" }), makeReceipt({ subtaskId: "c" })];
    const l = receipts.map(receiptLeafHash);
    const root = merkleRoot(l);
    const proof = merkleProofForLeaf(l, receiptLeafHash(receipts[1]));
    expect(verifyMerkleProof(receiptLeafHash(receipts[1]), proof, root)).toBe(true);
  });
});
