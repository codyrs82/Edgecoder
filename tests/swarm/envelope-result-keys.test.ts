import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTaskEnvelope, encryptResult, generateX25519KeyPair } from "../../src/security/envelope.js";
import { envelopeResultKeyCandidates, openEnvelopeResult } from "../../src/swarm/envelope-result-keys.js";

/*
 * Network run 17: the cached envelope key of a subtask belonged to the agent that claimed it last,
 * and an earlier claimant's valid result was checked against it (AES-GCM authentication failure).
 */

const root = randomBytes(32);
const sid = "bfaf8ebf-2410-47ad-a3bd-e58768a6d2cc";
const a = generateX25519KeyPair();
const b = generateX25519KeyPair();
const pubA = a.publicKey.toString("base64");

function claim(pub: Buffer) {
  return createTaskEnvelope({ input: "x", snapshotRef: "s", kind: "inference" }, pub, sid, {}, { rootSecret: root });
}

describe("envelope result keys", () => {
  it("another agent's cached key is not used; the submitter's key is re-derived and opens its result", () => {
    const envA = claim(a.publicKey);
    const envB = claim(b.publicKey);
    const enc = encryptResult({ ok: true, output: "from A", durationMs: 1 }, envA.envelope, a.privateKey);
    const cands = envelopeResultKeyCandidates({ cached: { key: envB.sharedKey, createdAtMs: 0, agentId: "B" }, subtaskId: sid, agentId: "A", agentX25519: pubA, rootSecret: root });
    expect(cands.map((c) => c.source)).toEqual(["rederived"]);
    const opened = openEnvelopeResult(enc, cands);
    expect(opened).toMatchObject({ ok: true, source: "rederived", result: { output: "from A" } });
  });

  it("the agent's own cached key comes first, and an equal re-derived key is not tried twice", () => {
    const envA = claim(a.publicKey);
    const cands = envelopeResultKeyCandidates({ cached: { key: envA.sharedKey, createdAtMs: 0, agentId: "A" }, subtaskId: sid, agentId: "A", agentX25519: pubA, rootSecret: root });
    expect(cands.map((c) => c.source)).toEqual(["cache"]);
    const enc = encryptResult({ ok: true, output: "from A", durationMs: 1 }, envA.envelope, a.privateKey);
    expect(openEnvelopeResult(enc, cands)).toMatchObject({ ok: true, source: "cache" });
  });

  it("a stale cached key for the same agent falls back to the re-derived one", () => {
    const envA = claim(a.publicKey);
    const cands = envelopeResultKeyCandidates({ cached: { key: randomBytes(32), createdAtMs: 0, agentId: "A" }, subtaskId: sid, agentId: "A", agentX25519: pubA, rootSecret: root });
    expect(cands.map((c) => c.source)).toEqual(["cache", "rederived"]);
    const enc = encryptResult({ ok: true, output: "from A", durationMs: 1 }, envA.envelope, a.privateKey);
    expect(openEnvelopeResult(enc, cands)).toMatchObject({ ok: true, source: "rederived" });
  });

  it("a result that authenticates under no key the submitter shares is refused", () => {
    const envA = claim(a.publicKey);
    // Sealed with another agent's private key: B cannot pass its result off as A's.
    const enc = encryptResult({ ok: true, output: "forged", durationMs: 1 }, envA.envelope, b.privateKey);
    const cands = envelopeResultKeyCandidates({ cached: { key: envA.sharedKey, createdAtMs: 0, agentId: "A" }, subtaskId: sid, agentId: "A", agentX25519: pubA, rootSecret: root });
    const opened = openEnvelopeResult(enc, cands);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error).toMatch(/authenticate/);
    // Tampered ciphertext under the right key is refused too.
    const good = encryptResult({ ok: true, output: "from A", durationMs: 1 }, envA.envelope, a.privateKey);
    const bytes = Buffer.from(good.encryptedPayload, "base64");
    bytes[0] ^= 1;
    expect(openEnvelopeResult({ ...good, encryptedPayload: bytes.toString("base64") }, cands).ok).toBe(false);
  });

  it("no key at all when nothing is cached for this agent and it has no registered key", () => {
    expect(envelopeResultKeyCandidates({ cached: { key: randomBytes(32), createdAtMs: 0, agentId: "B" }, subtaskId: sid, agentId: "A", rootSecret: root })).toEqual([]);
    expect(openEnvelopeResult({ subtaskId: sid, encryptedPayload: "", nonce: "00", tag: "00" }, [])).toMatchObject({ ok: false, tried: [] });
  });
});
