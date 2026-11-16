// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Portal routes: model list, chat and model pull progress.
 */
import type { FastifyReply } from "fastify";
import { request } from "undici";
import { z } from "zod";
import { buildChatSystemPrompt, type SystemPromptContext } from "../../../model/system-prompt.js";
import type { CoordinatorApp } from "../app.js";
import {
  OLLAMA_HOST,
  mesh,
  identity,
  COORDINATOR_BOOTSTRAP_URLS,
  COORDINATOR_PUBLIC_URL,
  MESH_AUTH_TOKEN,
  queue,
  coordinatorPullTracker
} from "../context.js";
import { agentCapabilities, federatedCapabilities } from "../agent-state.js";

// ── Mesh-peer chat failover helper ──
// Tries chat-capable mesh peers (from federatedCapabilities + bootstrap URLs).
// Streams the first successful response through `reply` and returns true.
// Returns false if all peers fail so the caller can send its own error.
async function tryMeshPeerChat(
  chatBody: { messages: Array<{ role: string; content: string }>; model?: string; temperature?: number; max_tokens?: number },
  reply: FastifyReply,
): Promise<boolean> {
  const chatPeerUrls: string[] = [];
  const meshPeers = mesh.listPeers();
  for (const cap of federatedCapabilities.values()) {
    if (!cap.chatEnabled) continue;
    if (cap.coordinatorId === identity.peerId) continue;
    const peer = meshPeers.find(p => p.peerId === cap.coordinatorId);
    if (peer?.coordinatorUrl) chatPeerUrls.push(peer.coordinatorUrl);
  }
  // Fallback: include bootstrap URLs in case mesh hasn't converged yet
  for (const url of COORDINATOR_BOOTSTRAP_URLS) {
    if (url !== COORDINATOR_PUBLIC_URL && !chatPeerUrls.includes(url)) {
      chatPeerUrls.push(url);
    }
  }

  for (const peerUrl of chatPeerUrls) {
    try {
      // The mesh token only: peers already hold it, and it is what /portal/chat accepts from them. The
      // portal service token names any account and must never leave this coordinator.
      const fwdHeaders: Record<string, string> = { "content-type": "application/json" };
      if (MESH_AUTH_TOKEN) fwdHeaders["x-mesh-token"] = MESH_AUTH_TOKEN;
      const peerRes = await request(`${peerUrl.replace(/\/$/, "")}/portal/chat`, {
        method: "POST",
        headers: fwdHeaders,
        body: JSON.stringify(chatBody),
        headersTimeout: 120_000,
        bodyTimeout: 0,
      });
      if (peerRes.statusCode >= 200 && peerRes.statusCode < 300) {
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        for await (const chunk of peerRes.body) {
          reply.raw.write(chunk);
        }
        reply.raw.end();
        return true;
      }
      await peerRes.body.text().catch(() => "");
    } catch {
      // peer unreachable, try next
    }
  }

  return false;
}

export function registerPortalRoutes(app: CoordinatorApp): void {
  // Portal model discovery — returns local Ollama models + swarm models
  app.get("/portal/models", async (_req, reply) => {
    const ollamaHost = OLLAMA_HOST ?? "http://127.0.0.1:11434";
    let local: Array<{ name: string; parameterSize: string; quantization: string; running: boolean }> = [];
    let runningNames: Set<string> = new Set();

    // Get running models
    try {
      const psRes = await request(`${ollamaHost}/api/ps`, { method: "GET", headersTimeout: 3_000 });
      if (psRes.statusCode >= 200 && psRes.statusCode < 300) {
        const ps = (await psRes.body.json()) as { models?: Array<{ name: string }> };
        for (const m of ps.models ?? []) runningNames.add(m.name);
      } else {
        await psRes.body.text().catch(() => "");
      }
    } catch { /* ignore */ }

    // Get installed models
    try {
      const tagsRes = await request(`${ollamaHost}/api/tags`, { method: "GET", headersTimeout: 3_000 });
      if (tagsRes.statusCode >= 200 && tagsRes.statusCode < 300) {
        const tags = (await tagsRes.body.json()) as { models?: Array<{ name: string; details: { parameter_size: string; quantization_level: string } }> };
        local = (tags.models ?? []).map((m) => ({
          name: m.name,
          parameterSize: m.details.parameter_size ?? "",
          quantization: m.details.quantization_level ?? "",
          running: runningNames.has(m.name),
        }));
      } else {
        await tagsRes.body.text().catch(() => "");
      }
    } catch { /* Ollama not reachable */ }

    // Build swarm model list from agent capabilities
    const swarmModelMap: Record<string, number> = {};
    for (const [, cap] of agentCapabilities) {
      if (cap.activeModel) {
        swarmModelMap[cap.activeModel] = (swarmModelMap[cap.activeModel] ?? 0) + 1;
      }
    }
    const swarm = Object.entries(swarmModelMap).map(([model, agentCount]) => ({
      model,
      paramSize: 0,
      agentCount,
    }));

    return reply.send({ local, swarm });
  });

  // Portal chat completion — streams Ollama response for portal web chat
  app.post("/portal/chat", async (req, reply) => {
    const body = z.object({
      messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
      model: z.string().optional(),
      temperature: z.number().optional(),
      max_tokens: z.number().optional()
    }).parse(req.body);

    const ollamaHost = OLLAMA_HOST ?? "http://127.0.0.1:11434";
    let chatModel = body.model ?? process.env.OLLAMA_MODEL ?? "qwen3.5:9b";

    // Auto-detect available model if configured one isn't available
    let ollamaHealthy = true;
    let installedModels: Array<{ name: string; paramSize: number }> = [];
    let activeModelQuantization: string | undefined;
    let activeModelParamSize = 0;
    try {
      const tagsRes = await request(`${ollamaHost}/api/tags`, { method: "GET", headersTimeout: 3_000 });
      if (tagsRes.statusCode >= 200 && tagsRes.statusCode < 300) {
        const tags = (await tagsRes.body.json()) as { models?: Array<{ name: string; size: number; details: { parameter_size: string; quantization_level: string } }> };
        const available = tags.models ?? [];
        installedModels = available.map((m) => ({
          name: m.name,
          paramSize: parseFloat(m.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0"),
        }));
        const activeEntry = available.find((m) => m.name === chatModel);
        if (activeEntry) {
          activeModelParamSize = parseFloat(activeEntry.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0");
          activeModelQuantization = activeEntry.details.quantization_level;
        }
        if (available.length > 0 && !available.some((m) => m.name === chatModel || m.name.startsWith(chatModel + ":"))) {
          chatModel = available[0].name;
          const fallback = available[0];
          activeModelParamSize = parseFloat(fallback.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0");
          activeModelQuantization = fallback.details.quantization_level;
        }
      }
    } catch {
      ollamaHealthy = false;
    }

    // ── Forward to mesh peer when local Ollama is down ──
    if (!ollamaHealthy) {
      app.log.warn("Local Ollama unavailable — failing over to mesh network");
      const handled = await tryMeshPeerChat(body, reply);
      if (handled) return;
      return reply.code(502).send({
        error: "no_models_available",
        detail: "No local Ollama running and no mesh peers with available models. Start Ollama locally or ensure at least one peer in the network has a model loaded."
      });
    }

    // Build swarm model list from agent capabilities
    const swarmModelMap: Record<string, number> = {};
    for (const [, cap] of agentCapabilities) {
      if (cap.activeModel) {
        swarmModelMap[cap.activeModel] = (swarmModelMap[cap.activeModel] ?? 0) + 1;
      }
    }
    const swarmModels = Object.entries(swarmModelMap).map(([model, agentCount]) => ({ model, agentCount }));

    const queueStatus = queue.status();
    const pullProgress = coordinatorPullTracker.getProgress();

    const systemPromptCtx: SystemPromptContext = {
      activeModel: chatModel,
      activeModelParamSize,
      activeModelQuantization,
      installedModels,
      swarmModels,
      ollamaHealthy,
      queueDepth: queueStatus.queued,
      connectedAgents: agentCapabilities.size,
      pullInProgress: pullProgress ? { model: pullProgress.model, progressPct: pullProgress.progressPct } : undefined,
    };

    const systemPrompt = buildChatSystemPrompt(systemPromptCtx);
    const messagesWithSystem = [
      { role: "system", content: systemPrompt },
      ...body.messages.filter((m) => m.role !== "system"),
    ];

    // Local Ollama is available — try calling it directly
    let ollamaRes;
    try {
      ollamaRes = await request(`${ollamaHost}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: chatModel,
          messages: messagesWithSystem,
          stream: true,
          options: {
            temperature: body.temperature ?? 0.7,
            num_predict: body.max_tokens ?? 4096
          }
        }),
        headersTimeout: 120_000,
        bodyTimeout: 0
      });
    } catch (localErr) {
      app.log.warn({ err: localErr }, "Local Ollama chat failed — falling over to mesh");
      ollamaRes = null;
    }

    if (!ollamaRes || ollamaRes.statusCode < 200 || ollamaRes.statusCode >= 300) {
      // Consume error body if present
      if (ollamaRes) await ollamaRes.body.text().catch(() => "");
      const handled = await tryMeshPeerChat(body, reply);
      if (handled) return;
      return reply.code(502).send({ error: "no_models_available", model: chatModel });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    for await (const chunk of ollamaRes.body) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          if (parsed.message?.content) {
            reply.raw.write(`data: ${JSON.stringify({ content: parsed.message.content })}\n\n`);
          }
          if (parsed.done) {
            reply.raw.write("data: [DONE]\n\n");
          }
        } catch {
          // skip unparseable lines
        }
      }
    }

    reply.raw.end();
  });

  // Pull progress endpoint on the coordinator
  app.get("/model/pull/progress", async (_req, reply) => {
    const progress = coordinatorPullTracker.getProgress();
    return reply.send(progress ?? { status: "idle" });
  });
}
