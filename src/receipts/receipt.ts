// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";
import { signPayload, verifyPayload } from "../mesh/peer.js";

/*
 * Architecture step 2: signed work receipts.
 *
 * A receipt is a two-party attestation that one agent executed one subtask and was
 * credited for it by one coordinator:
 *   1. The agent signs a *claim* when it posts the result (what it ran, when, and the
 *      hash of the output it produced). Credits are not known to the agent yet.
 *   2. The coordinator fills in the economic fields (compute class, credits, msat) after a
 *      successful accrual and countersigns the whole receipt, agent signature included.
 *
 * Receipts are hashed into per-coordinator Merkle trees (see epochs.ts) whose roots are
 * anchored on Bitcoin, so any holder of a receipt plus an inclusion proof can show that
 * the work was credited before the anchoring block, without trusting the coordinator.
 *
 * Canonical serialization is JSON with lexicographically sorted keys and no whitespace,
 * so every implementation signs and hashes the same bytes.
 */

export interface WorkReceipt {
  /** sha256 of the coordinator-signed body (minus receiptId): deterministic, so replication is idempotent. */
  receiptId: string;
  taskId: string;
  subtaskId: string;
  agentId: string;
  agentPublicKeyPem: string;
  coordinatorId: string;
  coordinatorPublicKeyPem: string;
  /**
   * Class the credits were valued in. Free string inside the signed body, never rewritten:
   * receipts issued since the four-class model carry cpu | apple | gpu | gpu.dc; earlier ones
   * carry the resource class ("cpu" | "gpu") they were priced as. Readers that aggregate by
   * class map legacy ids with normalizeComputeClass (src/economy/compute-classes.ts); note an
   * old "gpu" receipt means resource class gpu (any GPU or Apple silicon), not the consumer-GPU class.
   */
  computeClass: string;
  credits: number;
  /** Millisatoshi value of the credits at the price epoch in force when they accrued. */
  msat: number;
  msatPerCredit: number;
  startedAtMs: number;
  finishedAtMs: number;
  /** sha256 hex of the result output the agent reported. */
  resultHash: string;
  agentSignature: string;
  coordinatorSignature: string;
}

/** The part of a receipt the agent signs when it posts a result (credits are unknown then). */
export interface AgentReceiptClaim {
  taskId: string;
  subtaskId: string;
  agentId: string;
  agentPublicKeyPem: string;
  startedAtMs: number;
  finishedAtMs: number;
  resultHash: string;
}

export interface SignedAgentReceiptClaim extends AgentReceiptClaim {
  agentSignature: string;
}

const AGENT_CLAIM_KEYS: Array<keyof AgentReceiptClaim> = [
  "taskId",
  "subtaskId",
  "agentId",
  "agentPublicKeyPem",
  "startedAtMs",
  "finishedAtMs",
  "resultHash"
];

type CoordinatorBodyKey = keyof Omit<WorkReceipt, "receiptId" | "coordinatorSignature">;
const COORDINATOR_BODY_KEYS: CoordinatorBodyKey[] = [
  "taskId",
  "subtaskId",
  "agentId",
  "agentPublicKeyPem",
  "coordinatorId",
  "coordinatorPublicKeyPem",
  "computeClass",
  "credits",
  "msat",
  "msatPerCredit",
  "startedAtMs",
  "finishedAtMs",
  "resultHash",
  "agentSignature"
];

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with sorted keys at every level, no whitespace; `undefined` values are dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = obj[key];
  return out;
}

/** PEM text normalized so the same key always hashes/compares identically. */
export function normalizePem(pem: string): string {
  return pem.replace(/\r\n/g, "\n").trim() + "\n";
}

/** Bytes the agent signs. */
export function canonicalAgentClaim(claim: AgentReceiptClaim): string {
  return canonicalJson({ ...pick(claim, AGENT_CLAIM_KEYS), agentPublicKeyPem: normalizePem(claim.agentPublicKeyPem) });
}

/** Bytes the coordinator signs: every field but receiptId and coordinatorSignature. */
export function canonicalCoordinatorBody(receipt: Omit<WorkReceipt, "receiptId" | "coordinatorSignature">): string {
  return canonicalJson({
    ...pick(receipt, COORDINATOR_BODY_KEYS),
    agentPublicKeyPem: normalizePem(receipt.agentPublicKeyPem),
    coordinatorPublicKeyPem: normalizePem(receipt.coordinatorPublicKeyPem)
  });
}

/** Canonical form of the complete receipt (both signatures). This is what a Merkle leaf commits to. */
export function canonicalReceipt(receipt: WorkReceipt): string {
  return canonicalJson({
    ...receipt,
    agentPublicKeyPem: normalizePem(receipt.agentPublicKeyPem),
    coordinatorPublicKeyPem: normalizePem(receipt.coordinatorPublicKeyPem)
  });
}

export function deriveReceiptId(receipt: Omit<WorkReceipt, "receiptId" | "coordinatorSignature">): string {
  return sha256Hex(canonicalCoordinatorBody(receipt));
}

/** Merkle leaf for a receipt: sha256 of its canonical form (signatures included). */
export function receiptLeafHash(receipt: WorkReceipt): string {
  return sha256Hex(canonicalReceipt(receipt));
}

export function hashResultOutput(output: string): string {
  return sha256Hex(output);
}

/** Step 1: the agent signs its claim when posting a result. */
export function signReceiptAsAgent(claim: AgentReceiptClaim, agentPrivateKeyPem: string): SignedAgentReceiptClaim {
  const agentSignature = signPayload(canonicalAgentClaim(claim), agentPrivateKeyPem);
  return { ...pick(claim, AGENT_CLAIM_KEYS), agentSignature };
}

export function verifyAgentClaim(claim: SignedAgentReceiptClaim): boolean {
  if (!claim || typeof claim.agentSignature !== "string") return false;
  return verifyPayload(canonicalAgentClaim(claim), claim.agentSignature, claim.agentPublicKeyPem);
}

export interface CoordinatorReceiptFields {
  coordinatorId: string;
  coordinatorPublicKeyPem: string;
  computeClass: string;
  credits: number;
  msat: number;
  msatPerCredit: number;
}

/**
 * Step 2: the coordinator completes and countersigns the receipt after accrual.
 * Throws when the agent's signature does not verify: a coordinator never attests to a
 * claim the agent did not make.
 */
export function countersignAsCoordinator(
  claim: SignedAgentReceiptClaim,
  fields: CoordinatorReceiptFields,
  coordinatorPrivateKeyPem: string
): WorkReceipt {
  if (!verifyAgentClaim(claim)) throw new Error("receipt_agent_signature_invalid");
  const body: Omit<WorkReceipt, "receiptId" | "coordinatorSignature"> = {
    taskId: claim.taskId,
    subtaskId: claim.subtaskId,
    agentId: claim.agentId,
    agentPublicKeyPem: normalizePem(claim.agentPublicKeyPem),
    coordinatorId: fields.coordinatorId,
    coordinatorPublicKeyPem: normalizePem(fields.coordinatorPublicKeyPem),
    computeClass: fields.computeClass,
    credits: fields.credits,
    msat: fields.msat,
    msatPerCredit: fields.msatPerCredit,
    startedAtMs: claim.startedAtMs,
    finishedAtMs: claim.finishedAtMs,
    resultHash: claim.resultHash,
    agentSignature: claim.agentSignature
  };
  const canonical = canonicalCoordinatorBody(body);
  return {
    receiptId: sha256Hex(canonical),
    ...body,
    coordinatorSignature: signPayload(canonical, coordinatorPrivateKeyPem)
  };
}

export type ReceiptVerification = { ok: true } | { ok: false; reason: string };

const HEX64 = /^[0-9a-f]{64}$/;

/** Structural check used before signature verification (replication accepts untrusted JSON). */
export function isWorkReceiptShape(value: unknown): value is WorkReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const str = (k: string) => typeof r[k] === "string" && (r[k] as string).length > 0;
  const num = (k: string) => typeof r[k] === "number" && Number.isFinite(r[k] as number);
  return (
    str("receiptId") && str("taskId") && str("subtaskId") && str("agentId") && str("agentPublicKeyPem") &&
    str("coordinatorId") && str("coordinatorPublicKeyPem") && str("computeClass") &&
    num("credits") && num("msat") && num("msatPerCredit") && num("startedAtMs") && num("finishedAtMs") &&
    str("resultHash") && str("agentSignature") && str("coordinatorSignature")
  );
}

/** Verify both signatures, the derived receiptId and basic field sanity. */
export function verifyReceipt(receipt: WorkReceipt): ReceiptVerification {
  if (!isWorkReceiptShape(receipt)) return { ok: false, reason: "malformed" };
  if (!HEX64.test(receipt.resultHash)) return { ok: false, reason: "result_hash_invalid" };
  if (receipt.credits < 0 || receipt.msat < 0 || receipt.msatPerCredit < 0) return { ok: false, reason: "negative_amount" };
  if (receipt.finishedAtMs < receipt.startedAtMs) return { ok: false, reason: "time_range_invalid" };
  const { receiptId, coordinatorSignature, ...body } = receipt;
  if (deriveReceiptId(body) !== receiptId) return { ok: false, reason: "receipt_id_mismatch" };
  if (!verifyAgentClaim(receipt)) return { ok: false, reason: "agent_signature_invalid" };
  if (!verifyPayload(canonicalCoordinatorBody(body), coordinatorSignature, receipt.coordinatorPublicKeyPem)) {
    return { ok: false, reason: "coordinator_signature_invalid" };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/*  Merkle tree: sha256, leaves sorted, odd level duplicates the last  */
/*  node, interior nodes are domain-separated from leaves.            */
/* ------------------------------------------------------------------ */

export const EMPTY_MERKLE_ROOT = sha256Hex("edgecoder:receipts:empty");

export interface MerkleProofStep {
  hash: string;
  /** Which side the sibling sits on when hashing up. */
  position: "left" | "right";
}

export type MerkleProof = MerkleProofStep[];

function assertLeaf(leaf: string): void {
  if (!HEX64.test(leaf)) throw new Error(`merkle_leaf_not_sha256_hex:${leaf.slice(0, 16)}`);
}

export function merkleNodeHash(left: string, right: string): string {
  return createHash("sha256")
    .update(Buffer.from([0x01]))
    .update(Buffer.from(left, "hex"))
    .update(Buffer.from(right, "hex"))
    .digest("hex");
}

/** Leaves normalized: lowercased, deduplicated and sorted, so order of insertion never changes the root. */
export function sortedLeaves(leaves: string[]): string[] {
  const set = new Set<string>();
  for (const leaf of leaves) {
    const lower = leaf.toLowerCase();
    assertLeaf(lower);
    set.add(lower);
  }
  return [...set].sort();
}

function levelsFromSorted(sorted: string[]): string[][] {
  const levels: string[][] = [sorted];
  let level = sorted;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(merkleNodeHash(left, right));
    }
    levels.push(next);
    level = next;
  }
  return levels;
}

export function merkleRoot(leaves: string[]): string {
  const sorted = sortedLeaves(leaves);
  if (sorted.length === 0) return EMPTY_MERKLE_ROOT;
  const levels = levelsFromSorted(sorted);
  return levels[levels.length - 1][0];
}

/**
 * Inclusion proof for `leaves[index]` (index into the caller's array; the tree itself is
 * built over the sorted, deduplicated leaves).
 */
export function merkleProof(leaves: string[], index: number): MerkleProof {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error("merkle_index_out_of_range");
  return merkleProofForLeaf(leaves, leaves[index]);
}

export function merkleProofForLeaf(leaves: string[], leaf: string): MerkleProof {
  const sorted = sortedLeaves(leaves);
  let pos = sorted.indexOf(leaf.toLowerCase());
  if (pos < 0) throw new Error("merkle_leaf_not_found");
  const levels = levelsFromSorted(sorted);
  const proof: MerkleProof = [];
  for (let depth = 0; depth < levels.length - 1; depth += 1) {
    const level = levels[depth];
    const isLeft = pos % 2 === 0;
    const siblingIndex = isLeft ? pos + 1 : pos - 1;
    const sibling = siblingIndex < level.length ? level[siblingIndex] : level[pos];
    proof.push({ hash: sibling, position: isLeft ? "right" : "left" });
    pos = Math.floor(pos / 2);
  }
  return proof;
}

export function verifyMerkleProof(leaf: string, proof: MerkleProof, root: string): boolean {
  if (!HEX64.test(leaf.toLowerCase()) || !HEX64.test(root.toLowerCase())) return false;
  if (!Array.isArray(proof)) return false;
  let hash = leaf.toLowerCase();
  for (const step of proof) {
    if (!step || !HEX64.test(String(step.hash).toLowerCase())) return false;
    const sibling = step.hash.toLowerCase();
    hash = step.position === "left" ? merkleNodeHash(sibling, hash) : merkleNodeHash(hash, sibling);
  }
  return hash === root.toLowerCase();
}
