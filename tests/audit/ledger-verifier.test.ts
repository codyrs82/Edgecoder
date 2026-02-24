import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { verifyLedgerChain } from "../../src/audit/ledger-verifier.js";

function makeHash(prevHash: string, payload: string): string {
  return createHash("sha256").update(prevHash + payload).digest("hex");
}

function buildChain(payloads: string[]) {
  const events = [];
  let prevHash = "0".repeat(64);
  for (let i = 0; i < payloads.length; i++) {
    const hash = makeHash(prevHash, payloads[i]);
    events.push({ sequence: i, hash, prevHash, payload: payloads[i] });
    prevHash = hash;
  }
  return events;
}

describe("ledger-verifier", () => {
  test("valid chain passes verification", () => {
    const chain = buildChain(["tx1", "tx2", "tx3"]);
    const result = verifyLedgerChain(chain);
    expect(result.valid).toBe(true);
  });

  test("empty chain is valid", () => {
    const result = verifyLedgerChain([]);
    expect(result.valid).toBe(true);
  });

  test("detects hash mismatch (tampered payload)", () => {
    const chain = buildChain(["tx1", "tx2", "tx3"]);
    chain[1].payload = "tampered";
    const result = verifyLedgerChain(chain);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
    expect(result.breakpoint).toBe(1);
  });

  test("detects sequence gap", () => {
    const chain = buildChain(["tx1", "tx2", "tx3"]);
    chain[2].sequence = 5; // gap: 1 -> 5
    const result = verifyLedgerChain(chain);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("sequence_gap");
    expect(result.breakpoint).toBe(5);
  });

  test("detects chain break (prevHash mismatch)", () => {
    const chain = buildChain(["tx1", "tx2", "tx3"]);
    // Recompute event 2 with a different prevHash but correct self-hash
    const fakePrevHash = "f".repeat(64);
    chain[2].prevHash = fakePrevHash;
    chain[2].hash = makeHash(fakePrevHash, chain[2].payload);
    const result = verifyLedgerChain(chain);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("chain_break");
    expect(result.breakpoint).toBe(2);
  });
});
