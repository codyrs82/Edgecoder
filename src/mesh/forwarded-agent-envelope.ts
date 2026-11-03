// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * #122: end-to-end integrity for peer-forwarded /result.
 *
 * #118 checks a forwarded result against the *forwarding coordinator's* allowlisted key, so a
 * compromised allowlisted coordinator could still fabricate outputs for the origin's requesters.
 * The forwarding coordinator now also carries the agent's original signed /result request (the
 * five signature headers plus the exact body bytes) inside the coordinator-signed forward body.
 * The origin verifies the agent's own signature with a key it looks up itself (the shared
 * agent_signing_keys table both seeds write at /register, or its own registration of that agent),
 * never one supplied by the forwarder; checks the agent is not blacklisted mesh-wide (shared
 * blacklist_events); and checks the forwarded subtask/ok/output match what the agent signed.
 */

import { z } from "zod";
import { decryptResult } from "../security/envelope.js";
import { verifySignedRequest, type SignedHeaders } from "../security/request-signing.js";

export interface AgentResultEnvelope {
  v: 1;
  /** The agent's request-signature headers, as received. */
  headers: SignedHeaders;
  /** The exact bytes the agent POSTed to /result. */
  body: string;
  /**
   * Envelope-encrypted results only: the per-subtask key the forwarder derived when it handed the
   * task out, so the origin can decrypt the agent-signed ciphertext. AES-GCM authenticates it, so a
   * forwarder cannot pick a key that turns the agent's ciphertext into a different plaintext.
   */
  sharedKeyB64?: string;
}

const envelopeSchema = z.object({
  v: z.literal(1),
  headers: z.object({
    "x-agent-id": z.string().min(1),
    "x-timestamp-ms": z.string().min(1),
    "x-nonce": z.string().min(1),
    "x-body-sha256": z.string().min(1),
    "x-signature": z.string().min(1)
  }),
  body: z.string(),
  sharedKeyB64: z.string().optional()
});

export function buildAgentEnvelope(headers: SignedHeaders, rawBody: string, sharedKey?: Buffer): AgentResultEnvelope {
  return {
    v: 1,
    headers: {
      "x-agent-id": headers["x-agent-id"],
      "x-timestamp-ms": headers["x-timestamp-ms"],
      "x-nonce": headers["x-nonce"],
      "x-body-sha256": headers["x-body-sha256"],
      "x-signature": headers["x-signature"]
    },
    body: rawBody,
    ...(sharedKey ? { sharedKeyB64: sharedKey.toString("base64") } : {})
  };
}

/**
 * MESH_REQUIRE_AGENT_SIGNED_RESULTS: must a forwarded result that carries an output come with the
 * agent envelope? Default true in production (fail closed), false elsewhere. Set it to "false" in
 * production only while a rolling deploy still has seeds that forward without the envelope.
 */
export function requireAgentSignedForwards(env: NodeJS.ProcessEnv = process.env, production = env.NODE_ENV === "production"): boolean {
  const raw = (env.MESH_REQUIRE_AGENT_SIGNED_RESULTS ?? "").trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return production;
}

/** #50: a verification replica of `subtaskId` (verification.ts replicaId and its `:r` reassignments). */
export function isSameOrReplicaOf(signedSubtaskId: string, subtaskId: string): boolean {
  return signedSubtaskId === subtaskId || signedSubtaskId.startsWith(`${subtaskId}::verify:`);
}

export type AgentEnvelopeDecision =
  | { ok: true; mode: "agent_signed"; agentId: string }
  /** No envelope, ok:false and no output: a coordinator-generated failure (retry cap, unresolved verification, failed dependency). */
  | { ok: true; mode: "coordinator_failure" }
  /** No envelope while MESH_REQUIRE_AGENT_SIGNED_RESULTS is off (older forwarder). */
  | { ok: true; mode: "legacy_unenveloped" }
  | { ok: false; code: 400 | 401 | 403; error: string; agentId?: string };

export async function verifyForwardedAgentEnvelope(input: {
  result: { subtaskId: string; agentId: string; ok: boolean; output?: string };
  envelope: unknown;
  required: boolean;
  /** Agent signing keys the origin trusts for this agent id (never taken from the forward). */
  agentKeys: (agentId: string) => Promise<string[]>;
  /** Reason when the agent is blacklisted anywhere on the mesh, else null. */
  blacklisted: (agentId: string) => Promise<string | null>;
}): Promise<AgentEnvelopeDecision> {
  const { result } = input;
  if (input.envelope === undefined || input.envelope === null) {
    // A failure without output carries nothing a forwarder could fabricate for the requester.
    if (!result.ok && !result.output) return { ok: true, mode: "coordinator_failure" };
    return input.required ? { ok: false, code: 403, error: "agent_envelope_required" } : { ok: true, mode: "legacy_unenveloped" };
  }
  const parsed = envelopeSchema.safeParse(input.envelope);
  if (!parsed.success) return { ok: false, code: 400, error: "agent_envelope_invalid" };
  const env = parsed.data;
  const agentId = env.headers["x-agent-id"];

  const reason = await input.blacklisted(agentId);
  if (reason !== null) return { ok: false, code: 403, error: "agent_blacklisted", agentId };

  const keys = await input.agentKeys(agentId);
  if (keys.length === 0) return { ok: false, code: 403, error: "agent_key_unknown", agentId };
  const signatureValid = keys.some((publicKeyPem) => {
    try {
      // No skew bound: the result may be forwarded long after it was posted (verification hold).
      // Replay is bounded by the subtask binding below and the origin's single-use offer check.
      return verifySignedRequest({ method: "POST", path: "/result", headers: env.headers, publicKeyPem, maxSkewMs: Number.POSITIVE_INFINITY, rawBody: env.body }).valid;
    } catch {
      return false;
    }
  });
  if (!signatureValid) return { ok: false, code: 401, error: "agent_signature_invalid", agentId };

  let signed: Record<string, unknown>;
  try {
    const v = JSON.parse(env.body) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not_an_object");
    signed = v as Record<string, unknown>;
  } catch {
    return { ok: false, code: 400, error: "agent_envelope_invalid", agentId };
  }
  if (signed.agentId !== agentId) return { ok: false, code: 401, error: "agent_id_mismatch", agentId };
  const signedSubtaskId = typeof signed.subtaskId === "string" ? signed.subtaskId : "";
  if (!isSameOrReplicaOf(signedSubtaskId, result.subtaskId)) return { ok: false, code: 403, error: "agent_envelope_subtask_mismatch", agentId };
  // The original executor must be the agent the forward names; a replica winner (#50) may differ.
  if (signedSubtaskId === result.subtaskId && result.agentId !== agentId) return { ok: false, code: 403, error: "agent_id_mismatch", agentId };

  let signedOk: unknown = signed.ok;
  let signedOutput: unknown = signed.output;
  if (typeof signed.encryptedPayload === "string") {
    if (!env.sharedKeyB64) return { ok: false, code: 400, error: "agent_envelope_key_missing", agentId };
    try {
      const d = decryptResult(
        { subtaskId: signedSubtaskId, encryptedPayload: signed.encryptedPayload, nonce: String(signed.nonce), tag: String(signed.tag) },
        Buffer.from(env.sharedKeyB64, "base64")
      );
      signedOk = d.ok;
      signedOutput = d.output;
    } catch {
      return { ok: false, code: 401, error: "agent_envelope_decrypt_failed", agentId };
    }
  }
  if (signedOk !== result.ok || (typeof signedOutput === "string" ? signedOutput : "") !== (result.output ?? "")) {
    return { ok: false, code: 403, error: "agent_envelope_result_mismatch", agentId };
  }
  return { ok: true, mode: "agent_signed", agentId };
}
