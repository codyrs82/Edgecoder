import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { hashResultOutput, receiptLeafHash, signReceiptAsAgent, verifyReceipt, type WorkReceipt } from "../../src/receipts/receipt.js";
import { issueReceiptForAccrual } from "../../src/receipts/issue.js";
import { normalizeComputeClass } from "../../src/economy/compute-classes.js";

/**
 * A receipt countersigned under the nine-class model (computeClass "gpu.c24"), frozen byte for
 * byte. It is part of a Bitcoin-anchored Merkle epoch, so it must keep verifying and keep its leaf
 * hash forever: the four-class refactor maps legacy ids where they are read, never in the receipt.
 */
const LEGACY_RECEIPT: WorkReceipt = {
  "receiptId": "cbced796ff786cc425ff227ca0becc3712836e339ef3889e8fe78ad299372e23",
  "taskId": "task-legacy",
  "subtaskId": "sub-legacy",
  "agentId": "agent-legacy",
  "agentPublicKeyPem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAKhizZVGDQQMNITM33CRB6UvZWg38zrpn8nm8xeeuj0g=\n-----END PUBLIC KEY-----\n",
  "coordinatorId": "coord-legacy",
  "coordinatorPublicKeyPem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA079rjIax02uHVGNcFdAlBgagpuFJFdrH16GWXgu86AQ=\n-----END PUBLIC KEY-----\n",
  "computeClass": "gpu.c24",
  "credits": 49.6,
  "msat": 434000,
  "msatPerCredit": 8750,
  "startedAtMs": 1761955200000,
  "finishedAtMs": 1761955212400,
  "resultHash": "2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df",
  "agentSignature": "Fdr4nEJzjXh9CJ6YOiAFha4Irywe2SroT0/JMaCaO3lQD8bRLt55j6opVTjXmSGTMV8e4yetf/q4LeSj4MbFAA==",
  "coordinatorSignature": "CcrcQBXhQIIzXuC3Y0vPDh+4l9pqif7bqo7BrxPq+lVWiLhbMINI3P/Fi7fQjSF6T5wL9jN00WBb3qwBVbYdBg=="
};
const LEGACY_LEAF = "15b577a72ce9d37ee0e989d8c072661ba749538c5ecf8d9f61b0a864adfad5ae";

describe("work receipts across the four-class refactor", () => {
  it("a frozen receipt with a legacy class id verifies unchanged and keeps its Merkle leaf", () => {
    expect(LEGACY_RECEIPT.computeClass).toBe("gpu.c24");
    expect(verifyReceipt(LEGACY_RECEIPT)).toEqual({ ok: true });
    expect(receiptLeafHash(LEGACY_RECEIPT)).toBe(LEGACY_LEAF);
    // Readers aggregate it under the current class without touching it.
    expect(normalizeComputeClass(LEGACY_RECEIPT.computeClass)).toBe("gpu");
    expect(LEGACY_RECEIPT.computeClass).toBe("gpu.c24");
  });

  it("rewriting the class id of a signed receipt would break it (so it is never done)", () => {
    const rewritten = { ...LEGACY_RECEIPT, computeClass: "gpu" };
    expect(verifyReceipt(rewritten).ok).toBe(false);
  });

  it("new receipts carry the current class id and the valuation price", () => {
    const agent = createPeerKeys("agent-new");
    const coordinator = createPeerKeys("coord-new");
    const claim = signReceiptAsAgent(
      { taskId: "t", subtaskId: "s", agentId: agent.peerId, agentPublicKeyPem: agent.publicKeyPem, startedAtMs: 1, finishedAtMs: 2, resultHash: hashResultOutput("out") },
      agent.privateKeyPem
    );
    const outcome = issueReceiptForAccrual({
      claim,
      result: { taskId: "t", subtaskId: "s", agentId: agent.peerId, output: "out" },
      registeredAgentPublicKeyPem: agent.publicKeyPem,
      coordinator: { coordinatorId: coordinator.peerId, publicKeyPem: coordinator.publicKeyPem, privateKeyPem: coordinator.privateKeyPem },
      computeClass: "gpu.dc",
      credits: 2.9,
      msatPerCredit: 233
    });
    expect(outcome.receipt).not.toBeNull();
    expect(outcome.receipt!).toMatchObject({ computeClass: "gpu.dc", credits: 2.9, msatPerCredit: 233, msat: 676 });
    expect(verifyReceipt(outcome.receipt!)).toEqual({ ok: true });
  });
});
