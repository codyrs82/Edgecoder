import Fastify from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { verifyPayload } from "../mesh/peer.js";

const app = Fastify({ logger: true });
const INFERENCE_AUTH_TOKEN = process.env.INFERENCE_AUTH_TOKEN ?? "";
const INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS =
  process.env.INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS === "true";
const INFERENCE_MAX_SIGNATURE_SKEW_MS = Number(process.env.INFERENCE_MAX_SIGNATURE_SKEW_MS ?? "120000");
const INFERENCE_NONCE_TTL_MS = Number(process.env.INFERENCE_NONCE_TTL_MS ?? "300000");
const INFERENCE_COORDINATOR_PEER_ID = process.env.INFERENCE_COORDINATOR_PEER_ID ?? "";
const INFERENCE_COORDINATOR_PUBLIC_KEY_PEM = process.env.INFERENCE_COORDINATOR_PUBLIC_KEY_PEM ?? "";
const INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON = process.env.INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON ?? "";
const seenInferenceNonces = new Map<string, number>();

function loadTrustedCoordinatorKeys(): Map<string, string> {
  const out = new Map<string, string>();
  if (INFERENCE_COORDINATOR_PEER_ID && INFERENCE_COORDINATOR_PUBLIC_KEY_PEM) {
    out.set(INFERENCE_COORDINATOR_PEER_ID, INFERENCE_COORDINATOR_PUBLIC_KEY_PEM);
  }
  if (INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON) {
    try {
      const parsed = JSON.parse(INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON) as Record<string, string>;
      for (const [peerId, key] of Object.entries(parsed)) {
        if (peerId && key) out.set(peerId, key);
      }
    } catch {
      app.log.warn("Invalid INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON; ignoring.");
    }
  }
  return out;
}

const trustedCoordinatorKeys = loadTrustedCoordinatorKeys();

app.addHook("preHandler", async (req, reply) => {
  if (req.url === "/health") return;
  if (INFERENCE_AUTH_TOKEN) {
    const token = req.headers["x-inference-token"];
    if (typeof token !== "string" || token !== INFERENCE_AUTH_TOKEN) {
      return reply.code(401).send({ error: "inference_unauthorized" });
    }
  }

  const signatureRequired = INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS || trustedCoordinatorKeys.size > 0;
  if (!signatureRequired) return;

  const peerId = req.headers["x-coordinator-peer-id"];
  const timestampHeader = req.headers["x-inference-timestamp-ms"];
  const nonce = req.headers["x-inference-nonce"];
  const claimedBodySha256 = req.headers["x-inference-body-sha256"];
  const signature = req.headers["x-inference-signature"];

  if (
    typeof peerId !== "string" ||
    typeof timestampHeader !== "string" ||
    typeof nonce !== "string" ||
    typeof claimedBodySha256 !== "string" ||
    typeof signature !== "string"
  ) {
    return reply.code(401).send({ error: "inference_signature_missing" });
  }

  const trustedKey = trustedCoordinatorKeys.get(peerId);
  if (!trustedKey) {
    return reply.code(401).send({ error: "inference_signature_untrusted_peer" });
  }

  const timestampMs = Number(timestampHeader);
  if (!Number.isFinite(timestampMs)) {
    return reply.code(401).send({ error: "inference_signature_invalid_timestamp" });
  }

  const now = Date.now();
  if (Math.abs(now - timestampMs) > INFERENCE_MAX_SIGNATURE_SKEW_MS) {
    return reply.code(401).send({ error: "inference_signature_expired" });
  }

  const existingNonce = seenInferenceNonces.get(nonce);
  if (existingNonce && now - existingNonce < INFERENCE_NONCE_TTL_MS) {
    return reply.code(401).send({ error: "inference_signature_replay" });
  }

  const computedBodySha256 = createHash("sha256").update(JSON.stringify(req.body ?? {})).digest("hex");
  if (computedBodySha256 !== claimedBodySha256) {
    return reply.code(401).send({ error: "inference_signature_body_mismatch" });
  }

  const payload = JSON.stringify({
    peerId,
    method: req.method,
    path: req.url.split("?")[0],
    timestampMs,
    nonce,
    bodySha256: claimedBodySha256
  });
  if (!verifyPayload(payload, signature, trustedKey)) {
    return reply.code(401).send({ error: "inference_signature_invalid" });
  }

  seenInferenceNonces.set(nonce, now);
  for (const [knownNonce, seenAt] of seenInferenceNonces.entries()) {
    if (now - seenAt > INFERENCE_NONCE_TTL_MS) {
      seenInferenceNonces.delete(knownNonce);
    }
  }
});

const decomposeSchema = z.object({
  taskId: z.string(),
  prompt: z.string().min(1),
  snapshotRef: z.string().min(1),
  language: z.enum(["python", "javascript"]).default("python")
});

app.post("/decompose", async (req, reply) => {
  const parsed = decomposeSchema.parse(req.body);
  const chunks = parsed.prompt
    .split(/[.?!]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);

  const subtasks = chunks.map((chunk, idx) => ({
    taskId: parsed.taskId,
    kind: "micro_loop" as const,
    input: chunk,
    language: parsed.language,
    timeoutMs: 4000 + idx * 1000,
    snapshotRef: parsed.snapshotRef
  }));

  return reply.send({ subtasks });
});

app.get("/health", async () => ({ ok: true }));

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen({ port: 4302, host: "0.0.0.0" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app as inferenceService };
