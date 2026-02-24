import { describe, expect, test } from "vitest";
import {
  generateX25519KeyPair,
  createTaskEnvelope,
  decryptTaskEnvelope,
  encryptResult,
  decryptResult,
} from "../../src/security/envelope.js";

describe("envelope encryption", () => {
  test("generateX25519KeyPair returns valid keypair", () => {
    const kp = generateX25519KeyPair();
    expect(kp.publicKey).toBeInstanceOf(Buffer);
    expect(kp.privateKey).toBeInstanceOf(Buffer);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  test("createTaskEnvelope encrypts and decryptTaskEnvelope recovers", () => {
    const agentKeys = generateX25519KeyPair();
    const task = {
      input: "def hello(): return 'world'",
      snapshotRef: "abc123",
      kind: "micro_loop" as const,
    };

    const { envelope } = createTaskEnvelope(task, agentKeys.publicKey, "subtask-1");
    expect(envelope.subtaskId).toBe("subtask-1");
    expect(envelope.encryptedPayload).toBeTruthy();
    expect(envelope.ephemeralPublicKey).toBeTruthy();
    expect(envelope.nonce).toBeTruthy();
    expect(envelope.tag).toBeTruthy();
    // Plaintext should NOT appear in envelope
    expect(JSON.stringify(envelope)).not.toContain("def hello");

    const decrypted = decryptTaskEnvelope(envelope, agentKeys.privateKey);
    expect(decrypted.input).toBe(task.input);
    expect(decrypted.snapshotRef).toBe(task.snapshotRef);
    expect(decrypted.kind).toBe("micro_loop");
  });

  test("decryption with wrong key fails", () => {
    const agentKeys = generateX25519KeyPair();
    const wrongKeys = generateX25519KeyPair();
    const task = { input: "print('hi')", snapshotRef: "ref1", kind: "single_step" as const };

    const { envelope } = createTaskEnvelope(task, agentKeys.publicKey, "subtask-2");
    expect(() => decryptTaskEnvelope(envelope, wrongKeys.privateKey)).toThrow();
  });

  test("result encryption round-trips via shared key", () => {
    const agentKeys = generateX25519KeyPair();
    const task = { input: "x = 1", snapshotRef: "r", kind: "micro_loop" as const };
    const { envelope, sharedKey } = createTaskEnvelope(task, agentKeys.publicKey, "subtask-3");

    const result = { ok: true, output: "success", durationMs: 42 };
    const encResult = encryptResult(result, envelope, agentKeys.privateKey);
    expect(encResult.encryptedPayload).toBeTruthy();

    const decResult = decryptResult(encResult, sharedKey);
    expect(decResult.ok).toBe(true);
    expect(decResult.output).toBe("success");
    expect(decResult.durationMs).toBe(42);
  });

  test("envelope metadata is unencrypted", () => {
    const agentKeys = generateX25519KeyPair();
    const task = { input: "secret code", snapshotRef: "s", kind: "micro_loop" as const };
    const { envelope } = createTaskEnvelope(task, agentKeys.publicKey, "sub-4", {
      resourceClass: "gpu",
      priority: 5,
      language: "python",
      timeoutMs: 30000,
    });
    expect(envelope.metadata.resourceClass).toBe("gpu");
    expect(envelope.metadata.priority).toBe(5);
    expect(envelope.metadata.language).toBe("python");
    expect(envelope.metadata.timeoutMs).toBe(30000);
  });
});
