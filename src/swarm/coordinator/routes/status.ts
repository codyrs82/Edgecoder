// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Status routes: queue status, subtask results, runtime health, features, models and capacity.
 */
import { request } from "undici";
import { msatToCSats } from "../../../economy/job-pricing.js";
import { evaluateAgentPowerPolicy } from "../../power-policy.js";
import type { CoordinatorApp } from "../app.js";
import {
  queue,
  taskBilling,
  OLLAMA_HOST,
  PROVIDER,
  networkMode,
  IOS_BATTERY_PULL_MIN_INTERVAL_MS,
  IOS_BATTERY_TASK_STOP_LEVEL_PCT
} from "../context.js";
import { mutable } from "../mutable-state.js";
import {
  agentCapabilities,
  lastTaskAssignedByAgent,
  agentOrchestration,
  activeBlacklistRecord,
  activeTunnels,
  directWorkById,
  blacklistByAgent
} from "../agent-state.js";
import { diagnosticsByAgentId } from "../services.js";
import { agentAccount, agentSignatureAtGate, hasMeshToken, hasPortalServiceToken } from "../auth.js";
import { isFrontierModelId } from "../../../inference-api/frontier-models.js";

export function registerStatusRoutes(app: CoordinatorApp): void {
  app.get("/status", async () => queue.status());

  /**
   * Requester-side result lookup for a submitted subtask (used by the IDE /run/swarm
   * route, which polls after POST /submit). Scoped to the submitter below.
   * 404 while the subtask is still queued/running or when the ids don't match.
   */
  app.get("/tasks/:taskId/subtasks/:subtaskId/result", async (req, reply) => {
    const { taskId, subtaskId } = req.params as { taskId: string; subtaskId: string };
    const billing = taskBilling.get(taskId);
    // A coordinator (mesh token) or the portal reads any result; an agent (its signature, which is
    // how it passed the global hook) only results of tasks its own account submitted.
    const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
    if (!hasMeshToken(headers) && !hasPortalServiceToken(headers)) {
      const signer = agentSignatureAtGate(headers, "GET", String(req.url ?? "").split("?")[0]);
      if (!signer) return reply.code(401).send({ error: "mesh_unauthorized" });
      const owner = billing?.accountId;
      if (owner && owner !== "anonymous" && owner !== signer && owner !== (await agentAccount(signer))) {
        return reply.code(404).send({ error: "result_not_ready", taskId, subtaskId });
      }
    }
    const result = queue.getResult(subtaskId);
    if (!result || result.taskId !== taskId) {
      return reply.code(404).send({ error: "result_not_ready", taskId, subtaskId });
    }
    return reply.send({
      taskId: result.taskId,
      subtaskId: result.subtaskId,
      ok: result.ok,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
      // What /submit charged the submitter (0 once refunded or for anonymous tasks).
      // cSats: the settled cost once the task finished, else what is set aside for it.
      creditsSpent: billing ? msatToCSats(billing.refunded ? billing.costMsat : billing.reservedMsat) : 0
    });
  });

  app.get("/health/runtime", async () => {
    const status = queue.status();
    const ollamaHost = OLLAMA_HOST ?? "http://127.0.0.1:11434";
    let ollamaReachable = false;
    let ollamaVersion: string | null = null;
    let ollamaModelCount = 0;
    let ollamaError: string | null = null;

    try {
      const versionRes = await request(`${ollamaHost}/api/version`, { method: "GET" });
      if (versionRes.statusCode >= 200 && versionRes.statusCode < 300) {
        const payload = (await versionRes.body.json()) as { version?: string };
        ollamaReachable = true;
        ollamaVersion = payload.version ?? null;
      }
    } catch (error) {
      ollamaError = String(error);
    }

    try {
      const tagsRes = await request(`${ollamaHost}/api/tags`, { method: "GET" });
      if (tagsRes.statusCode >= 200 && tagsRes.statusCode < 300) {
        const payload = (await tagsRes.body.json()) as { models?: Array<{ name?: string }> };
        ollamaReachable = true;
        ollamaModelCount = payload.models?.length ?? 0;
      }
    } catch (error) {
      if (!ollamaError) ollamaError = String(error);
    }

    return {
      ok: true,
      coordinator: {
        provider: mutable.coordinatorProvider,
        queued: status.queued,
        agents: status.agents,
        results: status.results
      },
      ollama: {
        expectedProvider: PROVIDER,
        host: ollamaHost,
        reachable: ollamaReachable,
        version: ollamaVersion,
        modelCount: ollamaModelCount,
        error: ollamaError
      }
    };
  });
  app.get("/features", async () => ({
    public_mesh: networkMode === "public_mesh",
    enterprise_overlay: networkMode === "enterprise_overlay"
  }));
  app.get("/models/available", async (_req, reply) => {
    const modelMap: Record<string, { model: string; paramSize: number; agentCount: number; avgLoad: number }> = {};

    for (const [_agentId, cap] of agentCapabilities) {
      const model = cap.activeModel;
      // Frontier ids (someone's own key) are never advertised as network models.
      if (!model || isFrontierModelId(model)) continue;
      if (!modelMap[model]) {
        modelMap[model] = { model, paramSize: cap.activeModelParamSize ?? 0, agentCount: 0, avgLoad: 0 };
      }
      modelMap[model].agentCount += 1;
      // agentCapabilities does not track per-agent load; default to 0
      modelMap[model].avgLoad += 0;
    }

    const models = Object.values(modelMap).map(m => ({
      ...m,
      avgLoad: m.agentCount > 0 ? m.avgLoad / m.agentCount : 0,
    }));

    return reply.send(models);
  });
  app.get("/capacity", async () => {
    const agents = [...agentCapabilities.entries()].map(([agentId, info]) => {
      const powerDecision = evaluateAgentPowerPolicy({
        os: info.os,
        telemetry: info.powerTelemetry,
        nowMs: Date.now(),
        lastTaskAssignedAtMs: lastTaskAssignedByAgent.get(agentId),
        batteryPullMinIntervalMs: IOS_BATTERY_PULL_MIN_INTERVAL_MS,
        batteryTaskStopLevelPct: IOS_BATTERY_TASK_STOP_LEVEL_PCT
      });
      const orch = agentOrchestration.get(agentId);
      const recentDiagnostics = diagnosticsByAgentId.get(agentId) ?? [];
      const lastDiagnostic = recentDiagnostics.at(-1);
      // Owner email and network location are personal data: never in this mesh-token read.
      const { ownerEmail: _email, sourceIp: _ip, countryCode: _cc, vpnDetected: _vpn, ...publicInfo } = info;
      return {
        agentId,
        ...publicInfo,
        connectedPeers: [...info.connectedPeers],
        blacklisted: Boolean(activeBlacklistRecord(agentId)),
        powerPolicy: powerDecision,
        lastSeenMs: info.lastSeenMs,
        orchestrationStatus: orch?.pending && orch?.status ? orch.status : undefined,
        diagnostics: lastDiagnostic
          ? {
              lastEventAtMs: lastDiagnostic.eventAtMs,
              lastEventMessage: lastDiagnostic.message,
              recentCount: recentDiagnostics.length
            }
          : undefined
      };
    });
    const totalCapacity = agents.reduce((sum, a) => sum + a.maxConcurrentTasks, 0);
    return {
      totals: {
        agentsConnected: agents.length,
        totalCapacity,
        swarmEnabledCount: agents.filter((a) => a.swarmEnabled).length,
        localOllamaCount: agents.filter((a) => a.localModelProvider === "ollama-local").length,
        ideEnabledCount: agents.filter((a) => a.ideEnabled).length,
        activeTunnels: activeTunnels.size,
        peerDirectAccepted: [...directWorkById.values()].filter((w) => w.status === "accepted").length,
        peerDirectCompleted: [...directWorkById.values()].filter((w) => w.status === "completed").length,
        blacklistedAgents: [...blacklistByAgent.keys()].filter((agentId) => Boolean(activeBlacklistRecord(agentId)))
          .length
      },
      agents
    };
  });
}
