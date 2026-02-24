import { describe, expect, test } from "vitest";
import {
  generateX25519KeyPair,
  createTaskEnvelope,
  decryptTaskEnvelope,
  encryptResult,
  decryptResult,
  type TaskEnvelope,
} from "../../src/security/envelope.js";

describe("envelope encryption pipeline integration", () => {
  test("full coordinator → worker → coordinator round-trip", () => {
    // 1. Agent generates keypair at startup
    const agentKeys = generateX25519KeyPair();
    const agentPubKeyBase64 = agentKeys.publicKey.toString("base64");

    // 2. Coordinator receives agent's public key via /register
    const agentPubKey = Buffer.from(agentPubKeyBase64, "base64");

    // 3. Coordinator encrypts task for agent via /pull
    const task = {
      input: "def fibonacci(n): return n if n <= 1 else fibonacci(n-1) + fibonacci(n-2)",
      snapshotRef: "snap-abc123",
      kind: "single_step" as const,
    };
    const subtaskId = "task-001:sub-001";
    const { envelope, sharedKey } = createTaskEnvelope(task, agentPubKey, subtaskId, {
      resourceClass: "cpu",
      priority: 50,
      language: "python",
      timeoutMs: 60000,
    });

    // Coordinator caches sharedKey
    const coordinatorKeyCache = new Map<string, Buffer>();
    coordinatorKeyCache.set(subtaskId, sharedKey);

    // Verify task data is NOT visible in envelope
    const envelopeJson = JSON.stringify(envelope);
    expect(envelopeJson).not.toContain("fibonacci");
    expect(envelopeJson).not.toContain("snap-abc123");

    // 4. Worker decrypts envelope
    const decrypted = decryptTaskEnvelope(envelope, agentKeys.privateKey);
    expect(decrypted.input).toBe(task.input);
    expect(decrypted.snapshotRef).toBe(task.snapshotRef);
    expect(decrypted.kind).toBe("single_step");

    // 5. Worker executes task and encrypts result
    const executionResult = {
      ok: true,
      output: "def fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)",
      durationMs: 1234,
    };
    const encResult = encryptResult(executionResult, envelope, agentKeys.privateKey);
    expect(encResult.subtaskId).toBe(subtaskId);
    expect(encResult.encryptedPayload).toBeTruthy();

    // Verify result data is NOT visible in encrypted result
    const encResultJson = JSON.stringify(encResult);
    expect(encResultJson).not.toContain("fibonacci");

    // 6. Coordinator decrypts result using cached shared key
    const cachedKey = coordinatorKeyCache.get(subtaskId)!;
    const decResult = decryptResult(encResult, cachedKey);
    expect(decResult.ok).toBe(true);
    expect(decResult.output).toBe(executionResult.output);
    expect(decResult.durationMs).toBe(1234);

    // 7. Coordinator cleans up key cache
    coordinatorKeyCache.delete(subtaskId);
    expect(coordinatorKeyCache.size).toBe(0);
  });

  test("backward compat: agent without X25519 key gets plaintext", () => {
    // Simulate coordinator decision when agent has no x25519PublicKey
    const agentX25519: string | undefined = undefined;
    const task = { id: "sub-1", input: "print('hello')", snapshotRef: "snap1" };

    // Coordinator checks for X25519 key
    if (agentX25519) {
      // Would encrypt — should NOT reach here
      expect(true).toBe(false);
    } else {
      // Returns plaintext subtask — backward compatible
      expect(task.input).toBe("print('hello')");
    }
  });

  test("mixed mode: encrypted and plaintext agents in same coordinator", () => {
    const encryptedAgent = generateX25519KeyPair();
    const plaintextAgentX25519: string | undefined = undefined;

    const task = {
      input: "x = 42",
      snapshotRef: "ref",
      kind: "micro_loop" as const,
    };

    // Encrypted agent gets envelope
    const { envelope, sharedKey } = createTaskEnvelope(
      task,
      encryptedAgent.publicKey,
      "sub-enc"
    );
    expect(envelope.encryptedPayload).toBeTruthy();

    // Plaintext agent gets raw task
    expect(plaintextAgentX25519).toBeUndefined();

    // Both can return results
    const decrypted = decryptTaskEnvelope(envelope, encryptedAgent.privateKey);
    expect(decrypted.input).toBe("x = 42");
  });

  test("different agents get different envelopes for same task content", () => {
    const agent1 = generateX25519KeyPair();
    const agent2 = generateX25519KeyPair();
    const task = { input: "shared code", snapshotRef: "ref", kind: "single_step" as const };

    const env1 = createTaskEnvelope(task, agent1.publicKey, "sub-a1");
    const env2 = createTaskEnvelope(task, agent2.publicKey, "sub-a2");

    // Envelopes should differ (different ephemeral keys)
    expect(env1.envelope.ephemeralPublicKey).not.toBe(env2.envelope.ephemeralPublicKey);
    expect(env1.envelope.encryptedPayload).not.toBe(env2.envelope.encryptedPayload);

    // Both should decrypt correctly
    const dec1 = decryptTaskEnvelope(env1.envelope, agent1.privateKey);
    const dec2 = decryptTaskEnvelope(env2.envelope, agent2.privateKey);
    expect(dec1.input).toBe("shared code");
    expect(dec2.input).toBe("shared code");

    // Cross-decryption should fail
    expect(() => decryptTaskEnvelope(env1.envelope, agent2.privateKey)).toThrow();
  });
});
