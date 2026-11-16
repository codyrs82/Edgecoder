import { describe, expect, test } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import {
  createTaskEnvelope,
  decryptResult,
  decryptTaskEnvelope,
  encryptResult,
  envelopeRootSecretFromPem,
  generateX25519KeyPair,
  rederiveEnvelopeSharedKey
} from "../../src/security/envelope.js";
import { carriesUserData, envelopePolicyAllows } from "../../src/swarm/envelope-policy.js";

/*
 * Restart-safe envelope keys: the coordinator's ephemeral key per subtask is derived from its
 * identity key (COORDINATOR_PRIVATE_KEY_PEM), so a new process with the same key opens results for
 * subtasks claimed by the old one. The agent side and the wire format are unchanged.
 */
describe("envelope keys across a coordinator restart", () => {
  const identity = createPeerKeys("coord-envelope");
  const agent = generateX25519KeyPair();
  const task = { input: "secret input", snapshotRef: "snap-1", kind: "python" };

  test("a restarted coordinator with the same identity key re-derives the shared key and opens the result", () => {
    const before = envelopeRootSecretFromPem(identity.privateKeyPem);
    const { envelope, sharedKey } = createTaskEnvelope(task, agent.publicKey, "sub-1", {}, { rootSecret: before });
    // An agent built before this change decrypts it as always.
    expect(decryptTaskEnvelope(envelope, agent.privateKey)).toEqual(task);
    const enc = encryptResult({ ok: true, output: "answer", durationMs: 5 }, envelope, agent.privateKey);

    // New process: nothing in memory but the PEM.
    const after = envelopeRootSecretFromPem(identity.privateKeyPem);
    const key = rederiveEnvelopeSharedKey(after, "sub-1", agent.publicKey);
    expect(key.equals(sharedKey)).toBe(true);
    expect(decryptResult(enc, key)).toEqual({ ok: true, output: "answer", durationMs: 5 });
  });

  test("another coordinator key, subtask or agent key derives a different key", () => {
    const root = envelopeRootSecretFromPem(identity.privateKeyPem);
    const { sharedKey } = createTaskEnvelope(task, agent.publicKey, "sub-2", {}, { rootSecret: root });
    const otherRoot = envelopeRootSecretFromPem(createPeerKeys("coord-other").privateKeyPem);
    expect(rederiveEnvelopeSharedKey(otherRoot, "sub-2", agent.publicKey).equals(sharedKey)).toBe(false);
    expect(rederiveEnvelopeSharedKey(root, "sub-3", agent.publicKey).equals(sharedKey)).toBe(false);
    expect(rederiveEnvelopeSharedKey(root, "sub-2", generateX25519KeyPair().publicKey).equals(sharedKey)).toBe(false);
  });

  test("an invalid agent key is an error, not a fallback", () => {
    const root = envelopeRootSecretFromPem(identity.privateKeyPem);
    expect(() => createTaskEnvelope(task, Buffer.alloc(16, 1), "sub-4", {}, { rootSecret: root })).toThrow();
  });
});

describe("envelope policy", () => {
  const withData = { input: "x", snapshotRef: "" };
  test("off: every agent may claim", () => {
    expect(envelopePolicyAllows(undefined, withData, false)).toBe(true);
    expect(envelopePolicyAllows({}, withData, false)).toBe(true);
  });
  test("on: an agent without a key gets no user data", () => {
    expect(envelopePolicyAllows({}, withData, true)).toBe(false);
    expect(envelopePolicyAllows({ x25519PublicKey: "abc" }, withData, true)).toBe(true);
    expect(envelopePolicyAllows({}, { input: "", snapshotRef: "" }, true)).toBe(true);
    expect(carriesUserData({ input: "", snapshotRef: "snap" })).toBe(true);
  });
});
