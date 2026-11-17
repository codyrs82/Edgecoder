// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Liabilities Merkle sum tree (docs/decentralization.md, "Proof of reserves", next step).
 * NOT WIRED to any route yet: a library and its tests, so the published proof format can be
 * reviewed before EdgeCoder commits to it.
 *
 * Each node carries a hash and the sum of the balances below it. The root's sum is the total
 * liability; its hash commits to every balance. An account gets its leaf nonce and the sibling
 * path, and checks (1) its own balance is a leaf, (2) every sum on the way up is the sum of its
 * children and never negative, (3) the path ends at the published root. A balance left out or
 * understated would make the published total smaller than what the accounts that check see,
 * which is caught as soon as any one of them checks.
 *
 * Privacy: a leaf hash commits to the account id with a per-snapshot random nonce that only the
 * account receives, so the published tree reveals neither ids nor which leaf is whose. Sibling
 * sums do reveal the sizes of neighbouring subtrees; leaves are ordered by hash (effectively
 * random each snapshot) so they don't map to accounts. Splitting large balances into several
 * leaves (a common refinement) is left for when this is published.
 */
import { createHash, randomBytes } from "node:crypto";

export interface LiabilityLeafInput {
  accountId: string;
  /** Balance owed, in msat (negative balances count as 0). */
  balanceMsat: number | bigint;
}

export interface SumNode {
  hash: string;
  sumMsat: bigint;
}

export interface InclusionProof {
  accountId: string;
  balanceMsat: bigint;
  nonce: string;
  /** Siblings from the leaf up; `side` is where the sibling sits. */
  path: Array<{ hash: string; sumMsat: bigint; side: "left" | "right" }>;
}

export interface LiabilitiesTree {
  root: SumNode;
  leafCount: number;
  proofFor(accountId: string): InclusionProof | null;
}

const sha256 = (...parts: Array<string | Buffer>): string => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
};

function u64(n: bigint): Buffer {
  if (n < 0n || n >= 1n << 64n) throw new Error("sum_out_of_range");
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
}

export function leafHash(accountId: string, balanceMsat: bigint, nonce: string): string {
  return sha256("ec-por-leaf\0", Buffer.from(nonce, "hex"), accountId, "\0", u64(balanceMsat));
}

export function parentNode(left: SumNode, right: SumNode): SumNode {
  const sumMsat = left.sumMsat + right.sumMsat;
  return { hash: sha256("ec-por-node\0", Buffer.from(left.hash, "hex"), u64(left.sumMsat), Buffer.from(right.hash, "hex"), u64(right.sumMsat)), sumMsat };
}

const PAD: SumNode = { hash: sha256("ec-por-pad"), sumMsat: 0n };

export function buildLiabilitiesTree(inputs: LiabilityLeafInput[], nonceFor: (accountId: string) => string = () => randomBytes(16).toString("hex")): LiabilitiesTree {
  const seen = new Set<string>();
  const leaves = inputs.map((i) => {
    if (seen.has(i.accountId)) throw new Error(`duplicate_account:${i.accountId}`);
    seen.add(i.accountId);
    const raw = BigInt(i.balanceMsat);
    const balanceMsat = raw < 0n ? 0n : raw;
    const nonce = nonceFor(i.accountId);
    return { accountId: i.accountId, balanceMsat, nonce, node: { hash: leafHash(i.accountId, balanceMsat, nonce), sumMsat: balanceMsat } };
  });
  leaves.sort((a, b) => (a.node.hash < b.node.hash ? -1 : a.node.hash > b.node.hash ? 1 : 0));
  const levels: SumNode[][] = [leaves.length ? leaves.map((l) => l.node) : [PAD]];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: SumNode[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(parentNode(cur[i], cur[i + 1] ?? PAD));
    levels.push(next);
  }
  const index = new Map(leaves.map((l, i) => [l.accountId, i]));
  return {
    root: levels[levels.length - 1][0],
    leafCount: leaves.length,
    proofFor(accountId) {
      const at = index.get(accountId);
      if (at === undefined) return null;
      const leaf = leaves[at];
      const path: InclusionProof["path"] = [];
      let i = at;
      for (let d = 0; d < levels.length - 1; d++) {
        const sibling = levels[d][i ^ 1] ?? PAD;
        path.push({ hash: sibling.hash, sumMsat: sibling.sumMsat, side: i % 2 === 0 ? "right" : "left" });
        i >>= 1;
      }
      return { accountId, balanceMsat: leaf.balanceMsat, nonce: leaf.nonce, path };
    }
  };
}

/** What an account runs on its own: true when its balance is included under the published root. */
export function verifyInclusion(proof: InclusionProof, root: SumNode): boolean {
  try {
    if (proof.balanceMsat < 0n) return false;
    let node: SumNode = { hash: leafHash(proof.accountId, proof.balanceMsat, proof.nonce), sumMsat: proof.balanceMsat };
    for (const s of proof.path) {
      if (s.sumMsat < 0n || !/^[0-9a-f]{64}$/.test(s.hash)) return false;
      node = s.side === "right" ? parentNode(node, s) : parentNode(s, node);
    }
    return node.hash === root.hash && node.sumMsat === root.sumMsat;
  } catch {
    return false;
  }
}
