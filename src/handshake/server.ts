// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { verifySignedRequest, type SignedHeaders } from "../security/request-signing.js";
import { log } from "../common/logger.js";
import type { QueueReasonCode } from "../common/types.js";

// ---------------------------------------------------------------------------
// Cloud Model Provider Interface
// ---------------------------------------------------------------------------

/**
 * Abstract interface for the cloud model that processes handshake tasks.
 * Implementations may call OpenAI, Anthropic, a self-hosted model, or the
 * coordinator's inference service.
 */
export interface CloudModelProvider {
  execute(params: CloudModelRequest): Promise<CloudModelResponse>;
}

export interface CloudModelRequest {
  sessionId: string;
  task: string;
  snippet?: string;
  error?: string;
  queueReason: QueueReasonCode;
}

export interface CloudModelResponse {
  revisedPlan?: string;
  codeDiff?: string;
  improvedCode?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Session Types & State Machine
// ---------------------------------------------------------------------------

export type HandshakePhase =
  | "handshake"
  | "negotiate"
  | "execute"
  | "result"
  | "expired"
  | "failed";

export interface HandshakeSession {
  sessionId: string;
  agentId: string;
  phase: HandshakePhase;
  task: string;
  snippet?: string;
  error?: string;
  queueReason: QueueReasonCode;
  cloudResponse?: CloudModelResponse;
  createdAtMs: number;
  updatedAtMs: number;
  failureReason?: string;
}

// ---------------------------------------------------------------------------
// Session Store
// ---------------------------------------------------------------------------

export class SessionStore {
  private readonly sessions = new Map<string, HandshakeSession>();
  private readonly byAgent = new Map<string, Set<string>>();

  get(sessionId: string): HandshakeSession | undefined {
    return this.sessions.get(sessionId);
  }

  set(session: HandshakeSession): void {
    this.sessions.set(session.sessionId, session);
    let agentSet = this.byAgent.get(session.agentId);
    if (!agentSet) {
      agentSet = new Set();
      this.byAgent.set(session.agentId, agentSet);
    }
    agentSet.add(session.sessionId);
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    const agentSet = this.byAgent.get(session.agentId);
    if (agentSet) {
      agentSet.delete(sessionId);
      if (agentSet.size === 0) this.byAgent.delete(session.agentId);
    }
    return true;
  }

  activeCountForAgent(agentId: string): number {
    const agentSet = this.byAgent.get(agentId);
    if (!agentSet) return 0;
    let count = 0;
    for (const sid of agentSet) {
      const s = this.sessions.get(sid);
      if (s && s.phase !== "expired" && s.phase !== "failed" && s.phase !== "result") {
        count++;
      }
    }
    return count;
  }

  allSessions(): IterableIterator<HandshakeSession> {
    return this.sessions.values();
  }

  get size(): number {
    return this.sessions.size;
  }
}

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const QueueReasonCodeSchema = z.enum([
  "outside_subset",
  "timeout",
  "model_limit",
  "manual",
]);

const ReviewRequestSchema = z.object({
  task: z.string().min(1),
  snippet: z.string().optional(),
  error: z.string().optional(),
  queueReason: QueueReasonCodeSchema,
});

const NegotiateRequestSchema = z.object({
  sessionId: z.string().uuid(),
  accept: z.boolean(),
});

// ---------------------------------------------------------------------------
// Server Configuration
// ---------------------------------------------------------------------------

export interface HandshakeServerConfig {
  /** Cloud model provider for executing tasks */
  cloudModel: CloudModelProvider;
  /** Session timeout in ms. Default: 5 minutes */
  sessionTimeoutMs?: number;
  /** Cleanup sweep interval in ms. Default: 60 seconds */
  cleanupIntervalMs?: number;
  /** Max concurrent active sessions per agent. Default: 5 */
  maxSessionsPerAgent?: number;
  /** Max timestamp skew for request signing verification. Default: 120 seconds */
  maxSkewMs?: number;
  /**
   * Public key resolver: given an agentId, return the PEM-encoded public key.
   * Required for request signing verification.
   */
  resolvePublicKey: (agentId: string) => string | undefined;
}

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

/**
 * Registers the handshake protocol routes on a Fastify instance.
 *
 * Routes:
 *   POST /review      — initiate a handshake session (handshake phase)
 *   POST /negotiate    — accept or reject the session (negotiate phase)
 *   GET  /result/:id   — poll for the cloud model result
 *   GET  /session/:id  — get session status
 *
 * Returns a cleanup function that should be called on server close
 * to stop the stale-session sweeper.
 */
export function registerHandshakeRoutes(
  app: FastifyInstance,
  config: HandshakeServerConfig
): { store: SessionStore; stopCleanup: () => void } {
  const {
    cloudModel,
    sessionTimeoutMs = 5 * 60 * 1000,
    cleanupIntervalMs = 60 * 1000,
    maxSessionsPerAgent = 5,
    maxSkewMs = 120_000,
    resolvePublicKey,
  } = config;

  const store = new SessionStore();

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function verifyAgent(
    req: FastifyRequest,
    reply: FastifyReply,
    routePath: string
  ): string | null {
    const agentId = (req.headers as Record<string, string>)["x-agent-id"];
    if (!agentId) {
      reply.status(401).send({ error: "missing_agent_id" });
      return null;
    }

    const publicKey = resolvePublicKey(agentId);
    if (!publicKey) {
      reply.status(403).send({ error: "unknown_agent" });
      return null;
    }

    const bodyHash = (req.headers as Record<string, string>)["x-body-sha256"] ?? "";
    const signed: SignedHeaders = {
      "x-agent-id": agentId,
      "x-timestamp-ms": (req.headers as Record<string, string>)["x-timestamp-ms"] ?? "",
      "x-nonce": (req.headers as Record<string, string>)["x-nonce"] ?? "",
      "x-body-sha256": bodyHash,
      "x-signature": (req.headers as Record<string, string>)["x-signature"] ?? "",
    };

    const result = verifySignedRequest({
      method: req.method,
      path: routePath,
      headers: signed,
      publicKeyPem: publicKey,
      maxSkewMs,
    });

    if (!result.valid) {
      reply.status(401).send({ error: "invalid_signature", reason: result.reason });
      return null;
    }

    return agentId;
  }

  function bodyHashMatches(req: FastifyRequest): boolean {
    const declaredHash = (req.headers as Record<string, string>)["x-body-sha256"];
    if (!declaredHash) return false;
    const rawBody = JSON.stringify(req.body);
    const computed = createHash("sha256").update(rawBody).digest("hex");
    return computed === declaredHash;
  }

  // -----------------------------------------------------------------------
  // POST /review — handshake phase: create session
  // -----------------------------------------------------------------------

  app.post("/review", async (req, reply) => {
    const agentId = verifyAgent(req, reply, "/review");
    if (!agentId) return; // reply already sent

    // Validate body hash
    if (!bodyHashMatches(req)) {
      return reply.status(400).send({ error: "body_hash_mismatch" });
    }

    // Parse and validate body
    const parseResult = ReviewRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "validation_error",
        details: parseResult.error.issues,
      });
    }

    // Enforce per-agent session limit
    if (store.activeCountForAgent(agentId) >= maxSessionsPerAgent) {
      return reply.status(429).send({ error: "too_many_sessions" });
    }

    const { task, snippet, error, queueReason } = parseResult.data;
    const now = Date.now();
    const session: HandshakeSession = {
      sessionId: randomUUID(),
      agentId,
      phase: "handshake",
      task,
      snippet,
      error,
      queueReason,
      createdAtMs: now,
      updatedAtMs: now,
    };

    store.set(session);

    log.info("handshake session created", {
      sessionId: session.sessionId,
      agentId,
      queueReason,
    });

    return reply.status(201).send({ reviewId: session.sessionId, phase: session.phase });
  });

  // -----------------------------------------------------------------------
  // POST /negotiate — negotiate phase: agent accepts or rejects
  // -----------------------------------------------------------------------

  app.post("/negotiate", async (req, reply) => {
    const agentId = verifyAgent(req, reply, "/negotiate");
    if (!agentId) return;

    if (!bodyHashMatches(req)) {
      return reply.status(400).send({ error: "body_hash_mismatch" });
    }

    const parseResult = NegotiateRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "validation_error",
        details: parseResult.error.issues,
      });
    }

    const { sessionId, accept } = parseResult.data;
    const session = store.get(sessionId);

    if (!session) {
      return reply.status(404).send({ error: "session_not_found" });
    }

    if (session.agentId !== agentId) {
      return reply.status(403).send({ error: "session_owner_mismatch" });
    }

    if (session.phase !== "handshake") {
      return reply.status(409).send({
        error: "invalid_phase_transition",
        currentPhase: session.phase,
      });
    }

    if (!accept) {
      session.phase = "failed";
      session.failureReason = "agent_rejected";
      session.updatedAtMs = Date.now();
      store.set(session);
      log.info("handshake session rejected by agent", { sessionId, agentId });
      return reply.send({ sessionId, phase: session.phase });
    }

    // Move to negotiate, then immediately kick off execute
    session.phase = "negotiate";
    session.updatedAtMs = Date.now();
    store.set(session);

    // Transition to execute phase and invoke cloud model asynchronously
    session.phase = "execute";
    session.updatedAtMs = Date.now();
    store.set(session);

    log.info("handshake session executing", { sessionId, agentId });

    // Fire-and-forget cloud model execution
    executeCloudModel(session, cloudModel, store).catch((err) => {
      log.error("cloud model execution failed", {
        sessionId,
        error: String(err),
      });
    });

    return reply.send({ sessionId, phase: session.phase });
  });

  // -----------------------------------------------------------------------
  // GET /result/:id — poll for result
  // -----------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/result/:id", async (req, reply) => {
    const agentId = verifyAgent(req, reply, `/result/${req.params.id}`);
    if (!agentId) return;

    const session = store.get(req.params.id);
    if (!session) {
      return reply.status(404).send({ error: "session_not_found" });
    }

    if (session.agentId !== agentId) {
      return reply.status(403).send({ error: "session_owner_mismatch" });
    }

    if (session.phase === "result") {
      return reply.send({
        sessionId: session.sessionId,
        phase: session.phase,
        result: session.cloudResponse,
      });
    }

    if (session.phase === "failed" || session.phase === "expired") {
      return reply.send({
        sessionId: session.sessionId,
        phase: session.phase,
        failureReason: session.failureReason,
      });
    }

    // Still in progress
    return reply.status(202).send({
      sessionId: session.sessionId,
      phase: session.phase,
    });
  });

  // -----------------------------------------------------------------------
  // GET /session/:id — session status
  // -----------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/session/:id", async (req, reply) => {
    const agentId = verifyAgent(req, reply, `/session/${req.params.id}`);
    if (!agentId) return;

    const session = store.get(req.params.id);
    if (!session) {
      return reply.status(404).send({ error: "session_not_found" });
    }

    if (session.agentId !== agentId) {
      return reply.status(403).send({ error: "session_owner_mismatch" });
    }

    return reply.send({
      sessionId: session.sessionId,
      agentId: session.agentId,
      phase: session.phase,
      queueReason: session.queueReason,
      createdAtMs: session.createdAtMs,
      updatedAtMs: session.updatedAtMs,
      failureReason: session.failureReason,
    });
  });

  // -----------------------------------------------------------------------
  // Stale session cleanup
  // -----------------------------------------------------------------------

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const session of store.allSessions()) {
      if (
        session.phase !== "result" &&
        session.phase !== "failed" &&
        session.phase !== "expired" &&
        now - session.updatedAtMs > sessionTimeoutMs
      ) {
        session.phase = "expired";
        session.failureReason = "session_timeout";
        session.updatedAtMs = now;
        store.set(session);
        log.warn("handshake session expired", {
          sessionId: session.sessionId,
          agentId: session.agentId,
        });
      }
    }
  }, cleanupIntervalMs);

  const stopCleanup = () => clearInterval(cleanupTimer);

  return { store, stopCleanup };
}

// ---------------------------------------------------------------------------
// Cloud model execution (async background)
// ---------------------------------------------------------------------------

async function executeCloudModel(
  session: HandshakeSession,
  cloudModel: CloudModelProvider,
  store: SessionStore
): Promise<void> {
  try {
    const response = await cloudModel.execute({
      sessionId: session.sessionId,
      task: session.task,
      snippet: session.snippet,
      error: session.error,
      queueReason: session.queueReason,
    });

    // Only update if session is still in execute phase (not timed out)
    const current = store.get(session.sessionId);
    if (!current || current.phase !== "execute") return;

    current.cloudResponse = response;
    current.phase = "result";
    current.updatedAtMs = Date.now();
    store.set(current);

    log.info("handshake session completed", {
      sessionId: session.sessionId,
      agentId: session.agentId,
    });
  } catch (err) {
    const current = store.get(session.sessionId);
    if (!current || current.phase !== "execute") return;

    current.phase = "failed";
    current.failureReason = `cloud_model_error: ${String(err)}`;
    current.updatedAtMs = Date.now();
    store.set(current);
  }
}
