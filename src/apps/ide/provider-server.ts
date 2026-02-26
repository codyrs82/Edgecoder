// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderRegistry } from "../../model/providers.js";
import { InteractiveAgent } from "../../agent/interactive.js";
import { IntelligentRouter } from "../../model/router.js";
import {
  formatOpenAiResponse,
  formatOpenAiStreamChunk,
  formatOpenAiModelsResponse,
} from "./openai-compat.js";
import { buildChatSystemPrompt, type SystemPromptContext } from "../../model/system-prompt.js";
import { ollamaTags } from "../../model/swap.js";
import { PullTracker } from "../../model/pull-tracker.js";

const app = Fastify({ logger: true });
const providers = new ProviderRegistry();
const router = new IntelligentRouter();
const idePullTracker = new PullTracker();

// --- OpenAI-compatible endpoints ---

app.get("/v1/models", async () => {
  return formatOpenAiModelsResponse(providers.availableProviders());
});

const chatRequestSchema = z.object({
  model: z.string().default("edgecoder-local"),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string()
  })).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().optional()
});

app.post("/v1/chat/completions", async (req, reply) => {
  const body = chatRequestSchema.parse(req.body);
  const requestId = `chatcmpl-${randomUUID()}`;

  // Build system prompt from live state
  let systemPromptMsg: { role: string; content: string } | null = null;
  try {
    let ollamaHealthy = true;
    let installedModels: Array<{ name: string; paramSize: number }> = [];
    let activeModelParamSize = 0;
    let activeModelQuantization: string | undefined;
    const activeModel = body.model !== "edgecoder-local" ? body.model : (process.env.OLLAMA_MODEL ?? "qwen2.5:7b");

    try {
      const tags = await ollamaTags();
      installedModels = tags.models.map((m) => ({
        name: m.name,
        paramSize: parseFloat(m.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0"),
      }));
      const entry = tags.models.find((m) => m.name === activeModel);
      if (entry) {
        activeModelParamSize = parseFloat(entry.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0");
        activeModelQuantization = entry.details.quantization_level;
      }
    } catch {
      ollamaHealthy = false;
    }

    const routerStatus = router.status();
    const pullProgress = idePullTracker.getProgress();

    const ctx: SystemPromptContext = {
      activeModel,
      activeModelParamSize,
      activeModelQuantization,
      installedModels,
      swarmModels: [],
      ollamaHealthy,
      queueDepth: 0,
      connectedAgents: 0,
      pullInProgress: pullProgress ? { model: pullProgress.model, progressPct: pullProgress.progressPct } : undefined,
      routeUsed: undefined,
    };
    systemPromptMsg = { role: "system", content: buildChatSystemPrompt(ctx) };
  } catch {
    // Non-critical — proceed without system prompt
  }

  // Merge: our system prompt first, then preserve client file-context system messages, then user/assistant
  const clientFileContextMsgs = body.messages.filter((m) => m.role === "system");
  const nonSystemMsgs = body.messages.filter((m) => m.role !== "system");
  const messagesWithSystem = [
    ...(systemPromptMsg ? [systemPromptMsg] : []),
    ...clientFileContextMsgs,
    ...nonSystemMsgs,
  ];

  const result = await router.routeChat(messagesWithSystem, {
    stream: body.stream,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    requestedModel: body.model !== "edgecoder-local" ? body.model : undefined,
  });

  app.log.info({ route: result.route, model: result.model }, "chat routed");

  // --- Streaming via Ollama (local or bluetooth) ---
  if (result.stream) {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // Send route metadata as first event so the UI can show it immediately
    const routeLabels: Record<string, string> = {
      "ollama-local": "local model",
      "bluetooth-local": "nearby device",
      "swarm": "swarm network",
      "edgecoder-local": "offline",
    };
    reply.raw.write(`data: ${JSON.stringify({
      route_info: {
        route: result.route,
        label: routeLabels[result.route] ?? result.route,
        model: result.model,
        p95Ms: router.status().localLatencyP95Ms,
        concurrent: router.status().activeConcurrent,
      }
    })}\n\n`);

    const streamStart = Date.now();
    try {
      for await (const chunk of result.stream) {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
        const lines = text.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
            };

            if (parsed.message?.content) {
              reply.raw.write(
                `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, result.model, parsed.message.content))}\n\n`,
              );
            }

            if (parsed.done) {
              router.recordStreamComplete(Date.now() - streamStart);
              reply.raw.write(
                `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, result.model, "", "stop"))}\n\n`,
              );
              reply.raw.write("data: [DONE]\n\n");
              reply.raw.end();
              return;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      // Stream ended without done flag — close gracefully
      router.recordStreamComplete(Date.now() - streamStart);
      reply.raw.write(
        `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, result.model, "", "stop"))}\n\n`,
      );
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    } catch (err) {
      router.recordStreamComplete(Date.now() - streamStart);
      const errorMsg = err instanceof Error ? err.message : "Stream failed";
      reply.raw.write(
        `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, "error", `Error: ${errorMsg}`))}` + "\n\n",
      );
      reply.raw.write(
        `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, "error", "", "stop"))}\n\n`,
      );
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    }
    return;
  }

  // --- Non-streaming response (any route) ---

  // Swarm results include route metadata
  let content = result.text ?? "";
  if (result.route === "swarm" && result.swarmTaskId) {
    content += `\n\n_Routed via swarm (task: ${result.swarmTaskId})_`;
  }

  return reply.send(formatOpenAiResponse(requestId, result.model, content));
});

// --- Router status endpoint ---

app.get("/v1/router/status", async () => {
  return router.status();
});

// --- Pull progress endpoint ---

app.get("/model/pull/progress", async (_req, reply) => {
  const progress = idePullTracker.getProgress();
  return reply.send(progress ?? { status: "idle" });
});

// --- Legacy endpoints (backward compat) ---

const legacyRequestSchema = z.object({
  provider: z.enum(["edgecoder-local", "ollama-local"]).default("edgecoder-local"),
  task: z.string().min(1),
  language: z.enum(["python", "javascript"]).default("python")
});

app.get("/models", async () => ({
  providers: providers.availableProviders()
}));

app.post("/run", async (req, reply) => {
  const body = legacyRequestSchema.parse(req.body);
  providers.use(body.provider);
  const agent = new InteractiveAgent(providers.current());
  const output = await agent.run(body.task, body.language);
  return reply.send(output);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen({ port: 4304, host: "0.0.0.0" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app as ideProviderServer };
