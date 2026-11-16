// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Escalation routes.
 */
import { request } from "undici";
import { z } from "zod";
import { extractCode } from "../../../model/extract.js";
import type { EscalationRequest, EscalationResult } from "../../../escalation/types.js";
import { createEscalationResolverFromEnv } from "../../../escalation/server.js";
import type { CoordinatorApp } from "../app.js";
import { INFERENCE_AUTH_TOKEN } from "../context.js";
import { hasPortalServiceToken } from "../auth.js";

// --- Escalation: mesh-based hard task routing ---

const escalationStore = new Map<string, EscalationResult & { request: EscalationRequest }>();
const escalationResolver = createEscalationResolverFromEnv();

const escalationRequestSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  task: z.string().min(1),
  failedCode: z.string(),
  errorHistory: z.array(z.string()),
  language: z.enum(["python", "javascript"]),
  iterationsAttempted: z.number().int().min(1)
});

export function registerEscalationRoutes(app: CoordinatorApp): void {
  app.post("/escalate", async (req, reply) => {
    const body = escalationRequestSchema.parse(req.body);
    const taskId = body.taskId;

    escalationStore.set(taskId, {
      taskId,
      status: "processing",
      request: body
    });

    const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
    const coordinatorModel = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
    const useLocalOllama = process.env.LOCAL_MODEL_PROVIDER === "ollama-local";

    const errorContext = body.errorHistory.length > 0
      ? `\n\nPrevious errors:\n${body.errorHistory.join("\n")}`
      : "";

    const escalationPrompt = `You are a senior coding assistant. A smaller model failed to solve this task after multiple attempts.

Task: ${body.task}

Failed code:
${body.failedCode}
${errorContext}

Write correct, working ${body.language} code that solves the task. Output ONLY executable code, no markdown fences, no explanation.`;

    // Try local Ollama first (coordinator has Ollama co-located on Fly)
    if (useLocalOllama) {
      try {
        const ollamaRes = await request(`${ollamaHost}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: coordinatorModel, prompt: escalationPrompt, stream: false })
        });
        const payload = (await ollamaRes.body.json()) as { response?: string };
        const raw = payload.response ?? "";
        const improvedCode = raw ? extractCode(raw, body.language) : "";

        if (improvedCode) {
          const result: EscalationResult & { request: EscalationRequest } = {
            taskId,
            status: "completed",
            improvedCode,
            explanation: "Escalated to coordinator-local Ollama model.",
            resolvedByModel: coordinatorModel,
            request: body
          };
          escalationStore.set(taskId, result);
          return reply.send({
            taskId,
            status: "completed",
            improvedCode,
            explanation: result.explanation,
            resolvedByModel: coordinatorModel
          });
        }
      } catch {
        // Local Ollama failed, fall through to inference service
      }
    }

    // Fallback: forward to inference service
    const inferenceUrl = process.env.INFERENCE_URL ?? "http://127.0.0.1:4302";
    try {
      const escalateHeaders: Record<string, string> = { "content-type": "application/json" };
      if (INFERENCE_AUTH_TOKEN) {
        escalateHeaders["x-inference-token"] = INFERENCE_AUTH_TOKEN;
      }
      const inferRes = await request(`${inferenceUrl}/escalate`, {
        method: "POST",
        headers: escalateHeaders,
        body: JSON.stringify({
          task: body.task,
          failedCode: body.failedCode,
          errorHistory: body.errorHistory,
          language: body.language
        })
      });

      if (inferRes.statusCode >= 200 && inferRes.statusCode < 300) {
        const inferResult = (await inferRes.body.json()) as {
          improvedCode?: string;
          explanation?: string;
        };
        const result: EscalationResult & { request: EscalationRequest } = {
          taskId,
          status: "completed",
          improvedCode: inferResult.improvedCode,
          explanation: inferResult.explanation,
          resolvedByModel: "coordinator-inference",
          request: body
        };
        escalationStore.set(taskId, result);
        return reply.send({
          taskId,
          status: "completed",
          improvedCode: inferResult.improvedCode,
          explanation: inferResult.explanation
        });
      }

      // Inference service returned a non-2xx status — fall through to escalation resolver
    } catch {
      // Inference service unreachable — fall through to escalation resolver
    }

    // Fallback: escalation resolver (parent coordinator → cloud inference)
    try {
      const resolved = await escalationResolver.resolve(body);
      const storeEntry: EscalationResult & { request: EscalationRequest } = {
        ...resolved,
        request: body
      };
      escalationStore.set(taskId, storeEntry);
      return reply.send(resolved);
    } catch (resolveError) {
      escalationStore.set(taskId, { taskId, status: "failed", request: body });
      return reply.code(502).send({ taskId, status: "failed", error: String(resolveError) });
    }
  });

  app.get("/escalate/:taskId", async (req, reply) => {
    const params = z.object({ taskId: z.string() }).parse(req.params);
    const result = escalationStore.get(params.taskId);
    if (!result) return reply.code(404).send({ error: "escalation_not_found" });
    const { request: _req, ...rest } = result;
    return reply.send(rest);
  });

  /** Callback endpoint — the EscalationResolver posts resolved results here. */
  app.post("/escalate/:taskId/result", async (req, reply) => {
    const params = z.object({ taskId: z.string() }).parse(req.params);
    const resultBody = z.object({
      taskId: z.string(),
      status: z.enum(["pending", "processing", "completed", "failed"]),
      improvedCode: z.string().optional(),
      explanation: z.string().optional(),
      resolvedByAgentId: z.string().optional(),
      resolvedByModel: z.string().optional()
    }).parse(req.body);

    const existing = escalationStore.get(params.taskId);
    if (!existing) return reply.code(404).send({ error: "escalation_not_found" });
    if (resultBody.taskId !== params.taskId) return reply.code(400).send({ error: "task_id_mismatch" });
    // The resolver reports once; a settled result is changed only by the portal (a reviewer's decision).
    const settled = existing.status === "completed" || existing.status === "failed";
    if (settled && !hasPortalServiceToken(((req as any).headers ?? {}) as Record<string, unknown>)) {
      return reply.code(409).send({ error: "escalation_already_settled", status: existing.status });
    }

    escalationStore.set(params.taskId, {
      ...resultBody,
      request: existing.request
    });
    return reply.send({ ok: true });
  });
}
