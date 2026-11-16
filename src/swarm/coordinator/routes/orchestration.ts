// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Orchestration routes: model install rollouts on the coordinator and on agents.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureOllamaModelInstalled } from "../../../model/ollama-installer.js";
import { pgStore } from "../../../db/store.js";
import type { CoordinatorApp } from "../app.js";
import { OLLAMA_MODEL, OLLAMA_HOST, OLLAMA_AUTO_INSTALL, CC } from "../context.js";
import { mutable } from "../mutable-state.js";
import { upsertRollout, agentCapabilities, agentOrchestration, ollamaRollouts } from "../agent-state.js";
import { authorizeAdmin, requireMeshToken, requireAgentSelf } from "../auth.js";
import { appendAgentDiagnostic } from "../services.js";

const AGENT_ORCHESTRATION_ONLINE_WINDOW_MS = CC.AGENT_ORCHESTRATION_ONLINE_WINDOW_MS;

function canonicalNodeSuffix(nodeId: string): string {
  return String(nodeId)
    .toLowerCase()
    .replace(/^iphone-/, "")
    .replace(/^ios-/, "")
    .replace(/[^a-z0-9]/g, "");
}

function looksLikeIosAlias(agentIdA: string, agentIdB: string): boolean {
  const a = canonicalNodeSuffix(agentIdA);
  const b = canonicalNodeSuffix(agentIdB);
  if (!a || !b) return false;
  const aIosStyle = /^ios-|^iphone-/i.test(agentIdA);
  const bIosStyle = /^ios-|^iphone-/i.test(agentIdB);
  if (!aIosStyle || !bIosStyle) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function resolveRecentOrchestrationAgentId(
  requestedAgentId: string
): { agentId: string | null; reason?: "agent_not_connected" | "agent_not_recently_seen" } {
  const now = Date.now();
  const exact = agentCapabilities.get(requestedAgentId);
  if (exact) {
    if (now - Number(exact.lastSeenMs ?? 0) <= AGENT_ORCHESTRATION_ONLINE_WINDOW_MS) {
      return { agentId: requestedAgentId };
    }
    return { agentId: null, reason: "agent_not_recently_seen" };
  }
  const aliasMatch = [...agentCapabilities.entries()]
    .filter(([agentId, cap]) =>
      looksLikeIosAlias(agentId, requestedAgentId) &&
      now - Number(cap.lastSeenMs ?? 0) <= AGENT_ORCHESTRATION_ONLINE_WINDOW_MS
    )
    .sort((a, b) => Number(b[1].lastSeenMs ?? 0) - Number(a[1].lastSeenMs ?? 0))[0];
  if (aliasMatch?.[0]) return { agentId: aliasMatch[0] };
  return { agentId: null, reason: "agent_not_connected" };
}

export function registerOrchestrationRoutes(app: CoordinatorApp): void {
  app.post("/orchestration/coordinator/ollama-install", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return; // operator: pulls a model onto this coordinator's volume
    const body = z
      .object({
        provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
        model: z.string().default(OLLAMA_MODEL),
        autoInstall: z.boolean().default(true),
        requestedBy: z.string().default("control-plane")
      })
      .parse(req.body);
    const rolloutId = randomUUID();
    const requestedAtMs = Date.now();
    await upsertRollout({
      rolloutId,
      targetType: "coordinator",
      targetId: "coordinator-local",
      provider: body.provider,
      model: body.model,
      autoInstall: body.autoInstall,
      status: "in_progress",
      requestedBy: body.requestedBy,
      requestedAtMs,
      updatedAtMs: requestedAtMs
    });
    try {
      await ensureOllamaModelInstalled({
        enabled: body.provider === "ollama-local",
        autoInstall: body.autoInstall,
        model: body.model,
        role: "coordinator",
        host: OLLAMA_HOST
      });
      mutable.coordinatorProvider = body.provider;
      await upsertRollout({
        rolloutId,
        targetType: "coordinator",
        targetId: "coordinator-local",
        provider: body.provider,
        model: body.model,
        autoInstall: body.autoInstall,
        status: "applied",
        requestedBy: body.requestedBy,
        requestedAtMs,
        updatedAtMs: Date.now()
      });
      return reply.send({ ok: true, rolloutId, coordinatorProvider: mutable.coordinatorProvider, model: body.model });
    } catch (error) {
      await upsertRollout({
        rolloutId,
        targetType: "coordinator",
        targetId: "coordinator-local",
        provider: body.provider,
        model: body.model,
        autoInstall: body.autoInstall,
        status: "failed",
        requestedBy: body.requestedBy,
        requestedAtMs,
        updatedAtMs: Date.now(),
        error: String(error)
      });
      return reply.code(500).send({ error: String(error), rolloutId });
    }
  });

  app.get("/orchestration/coordinator/status", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    return {
      provider: mutable.coordinatorProvider,
      ollamaAutoInstall: OLLAMA_AUTO_INSTALL
    };
  });

  app.post("/orchestration/agents/:agentId/ollama-install", async (req, reply) => {
    // Operator: a forced model rollout makes the target agent pull (and maybe install Ollama).
    if (!authorizeAdmin(req, reply)) return;
    const params = z.object({ agentId: z.string() }).parse(req.params);
    const body = z
      .object({
        provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
        model: z.string().default(OLLAMA_MODEL),
        autoInstall: z.boolean().default(true),
        requestedBy: z.string().default("control-plane")
      })
      .parse(req.body);
    const requestedAgentId = params.agentId;
    const resolvedTarget = resolveRecentOrchestrationAgentId(requestedAgentId);
    if (!resolvedTarget.agentId) {
      appendAgentDiagnostic(
        requestedAgentId,
        `Model switch request rejected: ${resolvedTarget.reason ?? "agent_not_connected"}`
      );
      return reply.code(409).send({
        error: "agent_not_connected",
        reason: resolvedTarget.reason ?? "agent_not_connected",
        agentId: requestedAgentId
      });
    }
    const targetAgentId = resolvedTarget.agentId;
    if (targetAgentId !== requestedAgentId) {
      appendAgentDiagnostic(requestedAgentId, `Routing model switch request to active id ${targetAgentId}`);
    }
    const rolloutId = randomUUID();
    appendAgentDiagnostic(
      targetAgentId,
      `Model switch requested: ${body.provider} (${body.model}) autoInstall=${body.autoInstall ? "true" : "false"}`
    );
    agentOrchestration.set(targetAgentId, {
      rolloutId,
      provider: body.provider,
      model: body.model,
      autoInstall: body.autoInstall,
      pending: true,
      requestedAtMs: Date.now()
    });
    await upsertRollout({
      rolloutId,
      targetType: "agent",
      targetId: targetAgentId,
      provider: body.provider,
      model: body.model,
      autoInstall: body.autoInstall,
      status: "requested",
      requestedBy: body.requestedBy,
      requestedAtMs: Date.now(),
      updatedAtMs: Date.now()
    });
    return reply.send({ ok: true, agentId: targetAgentId, requestedAgentId, rolloutId });
  });

  app.post("/orchestration/agents/:agentId/status", async (req, reply) => {
    const params = z.object({ agentId: z.string() }).parse(req.params);
    if (!(await requireAgentSelf(req, reply, params.agentId))) return;
    const body = z
      .object({
        phase: z.string().max(64),
        message: z.string().max(512),
        progressPct: z.number().min(0).max(100).optional()
      })
      .parse(req.body);
    const current = agentOrchestration.get(params.agentId);
    if (!current) return reply.code(404).send({ error: "orchestration_not_found" });
    current.status = {
      phase: body.phase,
      message: body.message,
      progressPct: body.progressPct,
      updatedAtMs: Date.now()
    };
    appendAgentDiagnostic(
      params.agentId,
      `${body.phase}: ${body.message}${body.progressPct != null ? ` (${body.progressPct}%)` : ""}`,
      current.status.updatedAtMs
    );
    agentOrchestration.set(params.agentId, current);
    await upsertRollout({
      rolloutId: current.rolloutId,
      targetType: "agent",
      targetId: params.agentId,
      provider: current.provider,
      model: current.model ?? OLLAMA_MODEL,
      autoInstall: current.autoInstall,
      status: "in_progress",
      requestedBy: "control-plane",
      requestedAtMs: current.requestedAtMs,
      updatedAtMs: Date.now()
    });
    return reply.send({ ok: true });
  });

  app.post("/orchestration/agents/:agentId/ack", async (req, reply) => {
    const params = z.object({ agentId: z.string() }).parse(req.params);
    if (!(await requireAgentSelf(req, reply, params.agentId))) return;
    const body = z.object({ ok: z.boolean(), error: z.string().optional() }).parse(req.body);
    const current = agentOrchestration.get(params.agentId);
    if (!current) return reply.code(404).send({ error: "orchestration_not_found" });
    current.pending = false;
    agentOrchestration.set(params.agentId, current);
    appendAgentDiagnostic(
      params.agentId,
      body.ok ? "Model switch applied successfully." : `Model switch failed: ${body.error ?? "unknown error"}`
    );
    if (body.ok) {
      const cap = agentCapabilities.get(params.agentId);
      if (cap) {
        cap.localModelProvider = current.provider;
        // #54: a reported catalog is refreshed by the agent's own next report, not assumed here.
        if (!cap.modelsReported) cap.localModelCatalog = current.provider === "ollama-local" ? [current.model ?? OLLAMA_MODEL] : ["edgecoder-default"];
        agentCapabilities.set(params.agentId, cap);
      }
    }
    await upsertRollout({
      rolloutId: current.rolloutId,
      targetType: "agent",
      targetId: params.agentId,
      provider: current.provider,
      model: current.model ?? OLLAMA_MODEL,
      autoInstall: current.autoInstall,
      status: body.ok ? "applied" : "failed",
      requestedBy: "control-plane",
      requestedAtMs: current.requestedAtMs,
      updatedAtMs: Date.now(),
      error: body.error
    });
    return reply.send({ ok: body.ok, pending: current.pending, error: body.error });
  });

  app.get("/orchestration/rollouts", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    if (pgStore) {
      try {
        const rolloutsQueryTimeoutMs = 3_000;
        const rollouts = await Promise.race([
          pgStore.listOllamaRollouts(200),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("rollouts_query_timeout")), rolloutsQueryTimeoutMs)
          )
        ]);
        return { rollouts };
      } catch (error) {
        app.log.warn({ error }, "rollouts_query_fallback_in_memory");
      }
    }
    return { rollouts: [...ollamaRollouts.values()] };
  });
}
