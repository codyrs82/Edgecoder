import { describe, expect, it } from "vitest";
import { buildLiabilitiesTree, verifyInclusion } from "../../src/ledger/liabilities-tree.js";

const accounts = Array.from({ length: 7 }, (_, i) => ({ accountId: `acct-${i}`, balanceMsat: (i + 1) * 1_000_000 }));

describe("liabilities Merkle sum tree", () => {
  it("the root sum is the total liability; negative balances count as 0", () => {
    const t = buildLiabilitiesTree([...accounts, { accountId: "neg", balanceMsat: -9_000 }]);
    expect(t.root.sumMsat).toBe(28_000_000n);
    expect(t.leafCount).toBe(8);
  });

  it("every account can verify its balance is included", () => {
    const t = buildLiabilitiesTree(accounts);
    for (const a of accounts) {
      const p = t.proofFor(a.accountId)!;
      expect(p.balanceMsat).toBe(BigInt(a.balanceMsat));
      expect(verifyInclusion(p, t.root)).toBe(true);
    }
    expect(t.proofFor("nobody")).toBeNull();
  });

  it("a changed balance, a wrong nonce, an understated sibling or a negative sibling fails", () => {
    const t = buildLiabilitiesTree(accounts);
    const p = t.proofFor("acct-3")!;
    expect(verifyInclusion({ ...p, balanceMsat: p.balanceMsat - 1n }, t.root)).toBe(false);
    expect(verifyInclusion({ ...p, nonce: "00".repeat(16) }, t.root)).toBe(false);
    const under = { ...p, path: p.path.map((s, i) => (i === 0 ? { ...s, sumMsat: s.sumMsat - 1n } : s)) };
    expect(verifyInclusion(under, t.root)).toBe(false);
    const neg = { ...p, path: p.path.map((s, i) => (i === 0 ? { ...s, sumMsat: -1n } : s)) };
    expect(verifyInclusion(neg, t.root)).toBe(false);
    // A root that publishes a smaller total than the tree it commits to fails too.
    expect(verifyInclusion(p, { ...t.root, sumMsat: t.root.sumMsat - 1n })).toBe(false);
  });

  it("the published root reveals no account id; nonces differ per snapshot", () => {
    const a = buildLiabilitiesTree(accounts);
    const b = buildLiabilitiesTree(accounts);
    expect(JSON.stringify({ hash: a.root.hash, sum: String(a.root.sumMsat) })).not.toContain("acct-");
    expect(a.root.hash).not.toBe(b.root.hash);
    expect(a.root.sumMsat).toBe(b.root.sumMsat);
  });

  it("empty and single-leaf trees work; duplicate accounts are refused", () => {
    expect(buildLiabilitiesTree([]).root.sumMsat).toBe(0n);
    const one = buildLiabilitiesTree([{ accountId: "x", balanceMsat: 5n }]);
    expect(verifyInclusion(one.proofFor("x")!, one.root)).toBe(true);
    expect(() => buildLiabilitiesTree([{ accountId: "x", balanceMsat: 1 }, { accountId: "x", balanceMsat: 2 }])).toThrow(/duplicate_account/);
  });
});
