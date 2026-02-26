import Fastify from "fastify";
import { createHash } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import { verifyPayload } from "../mesh/peer.js";
import { extractCode } from "../model/extract.js";
import { decomposePrompt, reflectPrompt } from "../model/prompts.js";
import { buildModelSwapRoutes } from "../model/swap-routes.js";
import { buildDashboardRoutes } from "./dashboard.js";

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

const metrics = {
  decomposeRequests: 0,
  decomposeSuccesses: 0,
  decomposeModelCalls: 0,
  decomposeFallbacks: 0,
  escalateRequests: 0,
  escalateSuccesses: 0,
  escalateFailures: 0,
  totalLatencyMs: 0,
};

export function parseDecomposition(
  raw: string,
  parsed: { taskId: string; prompt: string; language: string; snapshotRef: string },
): Array<{
  taskId: string;
  kind: "micro_loop";
  input: string;
  language: string;
  timeoutMs: number;
  snapshotRef: string;
}> {
  try {
    // Strip markdown fences if present
    let cleaned = raw.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    const items = JSON.parse(cleaned) as Array<{ input: string; language?: string }>;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Not an array or empty");
    }

    return items.slice(0, 10).map((item) => {
      const input = typeof item.input === "string" ? item.input : String(item.input ?? "");
      const timeoutMs = Math.min(5000 + Math.floor(input.length / 50) * 1000, 60_000);
      return {
        taskId: parsed.taskId,
        kind: "micro_loop" as const,
        input,
        language: item.language ?? parsed.language,
        timeoutMs,
        snapshotRef: parsed.snapshotRef,
      };
    });
  } catch {
    // Fallback: single subtask with original prompt
    return [
      {
        taskId: parsed.taskId,
        kind: "micro_loop" as const,
        input: parsed.prompt,
        language: parsed.language,
        timeoutMs: 30_000,
        snapshotRef: parsed.snapshotRef,
      },
    ];
  }
}

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
  if (req.url === "/health" || req.url === "/metrics" || req.url.startsWith("/dashboard")) return;
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
  const startMs = Date.now();
  metrics.decomposeRequests++;
  const parsed = decomposeSchema.parse(req.body);
  const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const model = process.env.OLLAMA_COORDINATOR_MODEL ?? "qwen2.5:7b";

  const prompt = decomposePrompt(parsed.prompt);

  try {
    metrics.decomposeModelCalls++;
    const ollamaRes = await request(`${ollamaHost}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      headersTimeout: 120_000,
      bodyTimeout: 0,
    });

    const payload = (await ollamaRes.body.json()) as { response?: string };
    const raw = payload.response ?? "";

    const subtasks = parseDecomposition(raw, parsed);
    metrics.decomposeSuccesses++;
    metrics.totalLatencyMs += Date.now() - startMs;
    return reply.send({ subtasks });
  } catch {
    metrics.decomposeFallbacks++;
    metrics.totalLatencyMs += Date.now() - startMs;
    return reply.send({
      subtasks: [{
        taskId: parsed.taskId,
        kind: "micro_loop" as const,
        input: parsed.prompt,
        language: parsed.language,
        timeoutMs: 30_000,
        snapshotRef: parsed.snapshotRef,
      }]
    });
  }
});

const escalateSchema = z.object({
  task: z.string().min(1),
  failedCode: z.string(),
  errorHistory: z.array(z.string()),
  language: z.enum(["python", "javascript"])
});

app.post("/escalate", async (req, reply) => {
  const startMs = Date.now();
  metrics.escalateRequests++;
  const body = escalateSchema.parse(req.body);
  const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const model = process.env.OLLAMA_COORDINATOR_MODEL ?? "qwen2.5:7b";

  const errorContext = body.errorHistory.length > 0
    ? body.errorHistory.join("\n")
    : "";

  const prompt = reflectPrompt(body.task, body.failedCode, errorContext);

  try {
    const ollamaRes = await request(`${ollamaHost}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      headersTimeout: 120_000,
      bodyTimeout: 0,
    });

    const payload = (await ollamaRes.body.json()) as { response?: string };
    const raw = payload.response ?? "";
    const improvedCode = raw ? extractCode(raw, body.language) : "";

    metrics.escalateSuccesses++;
    metrics.totalLatencyMs += Date.now() - startMs;
    return reply.send({
      improvedCode,
      explanation: "Escalated to larger model for improved solution."
    });
  } catch (error) {
    metrics.escalateFailures++;
    metrics.totalLatencyMs += Date.now() - startMs;
    return reply.code(502).send({
      improvedCode: "",
      explanation: `Escalation inference failed: ${String(error)}`
    });
  }
});

app.get("/health", async () => ({ ok: true }));

app.get("/metrics", async () => ({ ...metrics }));

const modelSwapState = {
  activeModel: process.env.OLLAMA_MODEL ?? "qwen2.5:7b",
  activeModelParamSize: 0,
};
buildModelSwapRoutes(app, modelSwapState);
buildDashboardRoutes(app, modelSwapState, metrics);

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen({ port: 4302, host: "0.0.0.0" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app as inferenceService };
