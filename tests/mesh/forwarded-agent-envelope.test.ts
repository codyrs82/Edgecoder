import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  buildAgentEnvelope,
  isSameOrReplicaOf,
  requireAgentSignedForwards,
  verifyForwardedAgentEnvelope
} from "../../src/mesh/forwarded-agent-envelope.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { createTaskEnvelope, encryptResult, generateX25519KeyPair } from "../../src/security/envelope.js";

// #122: the origin of a forwarded result checks the agent's own signature, not just the forwarder's.

const agentKeys = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
};
const alice = agentKeys();

/** What the agent POSTs to the executing coordinator's /result, and the envelope that coordinator builds. */
function agentPost(body: Record<string, unknown>, keys = alice, agentId = "agent-a", sharedKey?: Buffer) {
  const raw = JSON.stringify(body);
  const headers = signRequest({ method: "POST", path: "/result", bodyHash: hashRequestBody(raw), privateKeyPem: keys.privateKeyPem, agentId });
  return buildAgentEnvelope(headers, raw, sharedKey);
}

const plain = { subtaskId: "sub-1", taskId: "task-1", agentId: "agent-a", ok: true, output: "def f(): return 1", durationMs: 10 };

function check(over: { result?: Partial<typeof plain>; envelope?: unknown; required?: boolean; keys?: Record<string, string[]>; blacklist?: Record<string, string> } = {}) {
  return verifyForwardedAgentEnvelope({
    result: { ...plain, ...over.result },
    envelope: "envelope" in over ? over.envelope : agentPost(plain),
    required: over.required ?? true,
    agentKeys: async (id) => (over.keys ?? { "agent-a": [alice.publicKeyPem] })[id] ?? [],
    blacklisted: async (id) => (over.blacklist ?? {})[id] ?? null
  });
}

describe("verifyForwardedAgentEnvelope", () => {
  it("accepts a result that matches what the agent signed", async () => {
    expect(await check()).toEqual({ ok: true, mode: "agent_signed", agentId: "agent-a" });
  });

  it("rejects a forwarder that changed the output, the ok flag or the subtask", async () => {
    expect(await check({ result: { output: "rm -rf /" } })).toMatchObject({ ok: false, code: 403, error: "agent_envelope_result_mismatch" });
    expect(await check({ result: { ok: false } })).toMatchObject({ ok: false, error: "agent_envelope_result_mismatch" });
    expect(await check({ result: { subtaskId: "sub-2" } })).toMatchObject({ ok: false, error: "agent_envelope_subtask_mismatch" });
  });

  it("rejects a forwarder that edited the signed body or signed it with a key of its own", async () => {
    const env = agentPost(plain);
    const edited = { ...env, body: env.body.replace("return 1", "return 2") };
    expect(await check({ envelope: edited, result: { output: "def f(): return 2" } })).toMatchObject({ ok: false, code: 401, error: "agent_signature_invalid" });
    // A key the forwarder made up is never looked up: the origin only trusts keys it holds.
    const mallory = agentKeys();
    expect(await check({ envelope: agentPost(plain, mallory) })).toMatchObject({ ok: false, code: 401, error: "agent_signature_invalid" });
  });

  it("rejects an agent the origin has no key for, and a blacklisted agent", async () => {
    expect(await check({ keys: {} })).toMatchObject({ ok: false, code: 403, error: "agent_key_unknown" });
    expect(await check({ blacklist: { "agent-a": "fraud" } })).toMatchObject({ ok: false, code: 403, error: "agent_blacklisted" });
  });

  it("accepts any key the agent registered (key rotation)", async () => {
    const old = agentKeys();
    expect(await check({ envelope: agentPost(plain, old), keys: { "agent-a": [alice.publicKeyPem, old.publicKeyPem] } })).toMatchObject({ ok: true });
  });

  it("rejects a forward naming a different agent than the one that signed", async () => {
    expect(await check({ result: { agentId: "agent-b" } })).toMatchObject({ ok: false, error: "agent_id_mismatch" });
    // Signed by agent-a's key but the body claims agent-b.
    const env = agentPost({ ...plain, agentId: "agent-b" });
    expect(await check({ envelope: env, result: { agentId: "agent-b" } })).toMatchObject({ ok: false, error: "agent_id_mismatch" });
  });

  it("accepts the signature of a verification replica winner (#50)", async () => {
    const bob = agentKeys();
    const env = agentPost({ ...plain, subtaskId: "sub-1::verify:1", agentId: "agent-b" }, bob, "agent-b");
    const keys = { "agent-a": [alice.publicKeyPem], "agent-b": [bob.publicKeyPem] };
    expect(await check({ envelope: env, keys })).toEqual({ ok: true, mode: "agent_signed", agentId: "agent-b" });
    expect(isSameOrReplicaOf("sub-1::verify:2:r", "sub-1")).toBe(true);
    expect(isSameOrReplicaOf("sub-10", "sub-1")).toBe(false);
  });

  it("decrypts an envelope-encrypted result with the forwarded key and checks its output", async () => {
    const agentX = generateX25519KeyPair();
    const { envelope: task, sharedKey } = createTaskEnvelope({ input: "x", snapshotRef: "s", kind: "python" }, agentX.publicKey, "sub-1");
    const enc = encryptResult({ ok: true, output: plain.output, durationMs: 10 }, task, agentX.privateKey);
    const body = { ...enc, taskId: "task-1", agentId: "agent-a" };
    expect(await check({ envelope: agentPost(body, alice, "agent-a", sharedKey) })).toMatchObject({ ok: true, mode: "agent_signed" });
    expect(await check({ envelope: agentPost(body, alice, "agent-a", sharedKey), result: { output: "forged" } })).toMatchObject({ ok: false, error: "agent_envelope_result_mismatch" });
    expect(await check({ envelope: agentPost(body) })).toMatchObject({ ok: false, error: "agent_envelope_key_missing" });
    const wrongKey = Buffer.alloc(32, 7);
    expect(await check({ envelope: agentPost(body, alice, "agent-a", wrongKey) })).toMatchObject({ ok: false, error: "agent_envelope_decrypt_failed" });
  });

  it("without an envelope: fails closed when required, legacy accept when not; coordinator failures always pass", async () => {
    expect(await check({ envelope: undefined })).toMatchObject({ ok: false, code: 403, error: "agent_envelope_required" });
    expect(await check({ envelope: undefined, required: false })).toEqual({ ok: true, mode: "legacy_unenveloped" });
    expect(await check({ envelope: undefined, result: { ok: false, output: "", agentId: "coordinator" } })).toEqual({ ok: true, mode: "coordinator_failure" });
    // A failure that carries output is not coordinator-generated: it needs the agent's signature.
    expect(await check({ envelope: undefined, result: { ok: false, output: "partial" } })).toMatchObject({ ok: false });
    expect(await check({ envelope: { v: 1, headers: {} } })).toMatchObject({ ok: false, code: 400, error: "agent_envelope_invalid" });
  });
});

describe("requireAgentSignedForwards", () => {
  it("defaults to fail closed in production only, and the flag overrides both ways", () => {
    expect(requireAgentSignedForwards({}, true)).toBe(true);
    expect(requireAgentSignedForwards({}, false)).toBe(false);
    expect(requireAgentSignedForwards({ MESH_REQUIRE_AGENT_SIGNED_RESULTS: "false" }, true)).toBe(false);
    expect(requireAgentSignedForwards({ MESH_REQUIRE_AGENT_SIGNED_RESULTS: "true" }, false)).toBe(true);
    expect(requireAgentSignedForwards({ NODE_ENV: "production" })).toBe(true);
  });
});
