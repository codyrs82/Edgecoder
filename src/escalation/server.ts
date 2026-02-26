/**
 * EscalationResolver — processes escalation requests through a resolution
 * waterfall when a local agent or swarm cannot handle a task.
 *
 * Resolution order:
 *   1. Parent coordinator — forward the escalation to a higher-tier coordinator
 *      that may have more capable models or additional swarm capacity.
 *   2. Cloud inference   — fall back to a hosted cloud inference endpoint
 *      for tasks that exceed the capacity of the local mesh.
 *
 * The resolver supports configurable timeouts, retries with exponential
 * backoff, and an optional result callback that posts the resolution back
 * to the originating coordinator so polling clients get updated immediately.
 */

import { randomUUID } from "node:crypto";
import { request } from "undici";
import { EscalationRequest, EscalationResult, HumanEscalation } from "./types.js";
import { extractCode } from "../model/extract.js";
import { sanitizeEscalation } from "./client.js";
import { createHumanEscalation } from "./human-store.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EscalationResolverConfig {
  /** URL of a parent coordinator to try first (optional). */
  parentCoordinatorUrl?: string;
  /** Mesh auth token for authenticating with the parent coordinator. */
  parentMeshToken?: string;
  /** URL of a cloud inference service to fall back to (optional). */
  cloudInferenceUrl?: string;
  /** Auth token for the cloud inference service. */
  cloudInferenceToken?: string;
  /** Per-request timeout in milliseconds. Default: 30 000 */
  requestTimeoutMs?: number;
  /** Maximum number of retry attempts per backend. Default: 2 */
  maxRetries?: number;
  /** Base delay for exponential backoff in milliseconds. Default: 1 000 */
  retryBaseDelayMs?: number;
  /** Optional callback URL — the resolver POSTs the result here on completion. */
  callbackUrl?: string;
  /** Auth token sent with the callback request. */
  callbackToken?: string;
}

const DEFAULTS = {
  requestTimeoutMs: 30_000,
  maxRetries: 2,
  retryBaseDelayMs: 1_000,
} as const;

// ---------------------------------------------------------------------------
// EscalationResolver
// ---------------------------------------------------------------------------

export class EscalationResolver {
  private readonly cfg: Required<
    Pick<EscalationResolverConfig, "requestTimeoutMs" | "maxRetries" | "retryBaseDelayMs">
  > &
    EscalationResolverConfig;

  constructor(cfg: EscalationResolverConfig = {}) {
    this.cfg = {
      requestTimeoutMs: cfg.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
      maxRetries: cfg.maxRetries ?? DEFAULTS.maxRetries,
      retryBaseDelayMs: cfg.retryBaseDelayMs ?? DEFAULTS.retryBaseDelayMs,
      ...cfg,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Attempt to resolve an escalation request. Tries the parent coordinator
   * first, then falls back to the cloud inference endpoint. Returns the
   * result and, if a callbackUrl is configured, posts it back to the
   * originating coordinator.
   */
  async resolve(req: EscalationRequest): Promise<EscalationResult> {
    const safe = sanitizeEscalation(req);
    const automatedAttempts: string[] = [];

    // 1. Parent coordinator
    if (this.cfg.parentCoordinatorUrl) {
      automatedAttempts.push("parent-coordinator");
      try {
        const result = await this.tryParentCoordinator(safe);
        if (result.status === "completed") {
          await this.notifyCallback(result);
          return result;
        }
      } catch (err) {
        console.warn(
          `[escalation-resolver] parent coordinator failed for ${req.taskId}:`,
          String(err)
        );
      }
    }

    // 2. Cloud inference
    if (this.cfg.cloudInferenceUrl) {
      automatedAttempts.push("cloud-inference");
      try {
        const result = await this.tryCloudInference(safe);
        if (result.status === "completed") {
          await this.notifyCallback(result);
          return result;
        }
      } catch (err) {
        console.warn(
          `[escalation-resolver] cloud inference failed for ${req.taskId}:`,
          String(err)
        );
      }
    }

    // All automated backends failed or were not configured — create a
    // human escalation entry so a human operator can provide context or
    // directly edit the code.
    const escalationId = randomUUID();
    const now = Date.now();
    const humanEntry: HumanEscalation = {
      escalationId,
      taskId: req.taskId,
      agentId: req.agentId,
      task: req.task,
      failedCode: req.failedCode,
      errorHistory: req.errorHistory,
      language: req.language,
      iterationsAttempted: req.iterationsAttempted,
      automatedAttempts,
      status: "pending_human",
      createdAtMs: now,
      updatedAtMs: now,
    };
    createHumanEscalation(humanEntry);

    const pendingHuman: EscalationResult = {
      taskId: req.taskId,
      status: "pending_human",
      escalationId,
      explanation: "All automated escalation backends exhausted. Awaiting human input.",
    };
    await this.notifyCallback(pendingHuman);
    return pendingHuman;
  }

  // -------------------------------------------------------------------------
  // Parent coordinator
  // -------------------------------------------------------------------------

  private async tryParentCoordinator(req: EscalationRequest): Promise<EscalationResult> {
    const url = `${this.cfg.parentCoordinatorUrl!.replace(/\/$/, "")}/escalate`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.parentMeshToken) {
      headers["x-mesh-token"] = this.cfg.parentMeshToken;
    }

    return this.withRetry(async () => {
      const res = await request(url, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
        headersTimeout: this.cfg.requestTimeoutMs,
        bodyTimeout: this.cfg.requestTimeoutMs,
      });

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const errBody = await res.body.text();
        throw new Error(`Parent coordinator responded ${res.statusCode}: ${errBody}`);
      }

      const payload = (await res.body.json()) as EscalationResult;
      return {
        taskId: req.taskId,
        status: payload.status,
        improvedCode: payload.improvedCode,
        explanation: payload.explanation,
        resolvedByAgentId: payload.resolvedByAgentId,
        resolvedByModel: payload.resolvedByModel ?? "parent-coordinator",
      };
    });
  }

  // -------------------------------------------------------------------------
  // Cloud inference
  // -------------------------------------------------------------------------

  private async tryCloudInference(req: EscalationRequest): Promise<EscalationResult> {
    const baseUrl = this.cfg.cloudInferenceUrl!.replace(/\/$/, "");
    const url = `${baseUrl}/escalate`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.cloudInferenceToken) {
      headers["x-inference-token"] = this.cfg.cloudInferenceToken;
    }

    return this.withRetry(async () => {
      const res = await request(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          task: req.task,
          failedCode: req.failedCode,
          errorHistory: req.errorHistory,
          language: req.language,
        }),
        headersTimeout: this.cfg.requestTimeoutMs,
        bodyTimeout: this.cfg.requestTimeoutMs,
      });

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const errBody = await res.body.text();
        throw new Error(`Cloud inference responded ${res.statusCode}: ${errBody}`);
      }

      const payload = (await res.body.json()) as {
        improvedCode?: string;
        explanation?: string;
        rawResponse?: string;
      };

      // The cloud endpoint may return raw model output that needs code extraction
      let improvedCode = payload.improvedCode;
      if (!improvedCode && payload.rawResponse) {
        improvedCode = extractCode(payload.rawResponse, req.language);
      }

      return {
        taskId: req.taskId,
        status: improvedCode ? "completed" : "failed",
        improvedCode,
        explanation: payload.explanation ?? "Resolved via cloud inference.",
        resolvedByModel: "cloud-inference",
      } satisfies EscalationResult;
    });
  }

  // -------------------------------------------------------------------------
  // Result callback
  // -------------------------------------------------------------------------

  /**
   * POST the resolution result back to the originating coordinator so that
   * polling clients see the update immediately.
   */
  private async notifyCallback(result: EscalationResult): Promise<void> {
    if (!this.cfg.callbackUrl) return;

    const url = `${this.cfg.callbackUrl.replace(/\/$/, "")}/escalate/${result.taskId}/result`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.callbackToken) {
      headers["x-mesh-token"] = this.cfg.callbackToken;
    }

    try {
      const res = await request(url, {
        method: "POST",
        headers,
        body: JSON.stringify(result),
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });
      // Drain body to prevent socket leaks
      await res.body.text();
    } catch (err) {
      // Callback failures are non-fatal — the result is still returned
      // to the caller and stored in the escalation store.
      console.warn(
        `[escalation-resolver] callback notification failed for ${result.taskId}:`,
        String(err)
      );
    }
  }

  // -------------------------------------------------------------------------
  // Retry helper with exponential backoff
  // -------------------------------------------------------------------------

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.cfg.maxRetries) {
          const delay = this.cfg.retryBaseDelayMs * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }
}

// ---------------------------------------------------------------------------
// Factory — reads config from environment variables
// ---------------------------------------------------------------------------

export function createEscalationResolverFromEnv(): EscalationResolver {
  return new EscalationResolver({
    parentCoordinatorUrl: process.env.PARENT_COORDINATOR_URL,
    parentMeshToken: process.env.PARENT_MESH_TOKEN ?? process.env.MESH_AUTH_TOKEN,
    cloudInferenceUrl: process.env.CLOUD_INFERENCE_URL,
    cloudInferenceToken: process.env.CLOUD_INFERENCE_TOKEN ?? process.env.INFERENCE_AUTH_TOKEN,
    requestTimeoutMs: process.env.ESCALATION_TIMEOUT_MS
      ? parseInt(process.env.ESCALATION_TIMEOUT_MS, 10)
      : undefined,
    maxRetries: process.env.ESCALATION_MAX_RETRIES
      ? parseInt(process.env.ESCALATION_MAX_RETRIES, 10)
      : undefined,
    retryBaseDelayMs: process.env.ESCALATION_RETRY_BASE_DELAY_MS
      ? parseInt(process.env.ESCALATION_RETRY_BASE_DELAY_MS, 10)
      : undefined,
    callbackUrl: process.env.ESCALATION_CALLBACK_URL,
    callbackToken: process.env.ESCALATION_CALLBACK_TOKEN ?? process.env.MESH_AUTH_TOKEN,
  });
}
