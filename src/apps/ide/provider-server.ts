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
import { buildChatSystemPrompt, buildIdeAgentSystemPrompt, type SystemPromptContext } from "../../model/system-prompt.js";
import { ollamaTags } from "../../model/swap.js";
import { PullTracker } from "../../model/pull-tracker.js";
import { ToolExecutor } from "./tool-executor.js";
import { READ_TOOLS, type ToolName, type IdeStreamEvent } from "./tool-types.js";

const app = Fastify({ logger: true });
const providers = new ProviderRegistry();
const router = new IntelligentRouter();
const idePullTracker = new PullTracker();

// --- IDE Agent state ---

let activeProjectRoot: string | null = null;
const pendingApprovals = new Map<
  string,
  {
    resolve: (approved: boolean) => void;
    tool: ToolName;
    args: Record<string, unknown>;
  }
>();

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
    const activeModel = body.model !== "edgecoder-local" ? body.model : (process.env.OLLAMA_MODEL ?? "qwen3.5:9b");

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

// --- IDE Agent endpoints ---

const projectBodySchema = z.object({
  projectRoot: z.string().min(1),
});

app.post("/v1/ide/project", async (req, reply) => {
  const body = projectBodySchema.parse(req.body);
  activeProjectRoot = body.projectRoot;
  return reply.send({ ok: true, projectRoot: activeProjectRoot });
});

app.get("/v1/ide/project", async (_req, reply) => {
  return reply.send({ projectRoot: activeProjectRoot });
});

const toolApprovalSchema = z.object({
  id: z.string().min(1),
  approved: z.boolean(),
});

app.post("/v1/ide/tool-approval", async (req, reply) => {
  const body = toolApprovalSchema.parse(req.body);
  const entry = pendingApprovals.get(body.id);
  if (!entry) {
    return reply.status(404).send({ error: "No pending approval with that id" });
  }
  entry.resolve(body.approved);
  pendingApprovals.delete(body.id);
  return reply.send({ ok: true });
});

const ideChatSchema = z.object({
  messages: z
    .array(z.object({ role: z.string(), content: z.string() }))
    .min(1),
  model: z.string().optional(),
  projectRoot: z.string().optional(),
});

app.post("/v1/ide/chat", async (req, reply) => {
  const body = ideChatSchema.parse(req.body);
  const projectRoot = body.projectRoot ?? activeProjectRoot;

  if (!projectRoot) {
    return reply.status(400).send({
      error: "No project root set. POST /v1/ide/project first or include projectRoot in body.",
    });
  }

  const executor = new ToolExecutor(projectRoot);
  const ollamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const chatModel =
    body.model || process.env.OLLAMA_MODEL || "qwen2.5:7b";

  // Build system prompt
  let systemContent = "";
  try {
    let ollamaHealthy = true;
    let installedModels: Array<{ name: string; paramSize: number }> = [];
    let activeModelParamSize = 0;
    let activeModelQuantization: string | undefined;

    try {
      const tags = await ollamaTags();
      installedModels = tags.models.map((m) => ({
        name: m.name,
        paramSize: parseFloat(
          m.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0",
        ),
      }));
      const entry = tags.models.find((m) => m.name === chatModel);
      if (entry) {
        activeModelParamSize = parseFloat(
          entry.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0",
        );
        activeModelQuantization = entry.details.quantization_level;
      }
    } catch {
      ollamaHealthy = false;
    }

    const ctx: SystemPromptContext = {
      activeModel: chatModel,
      activeModelParamSize,
      activeModelQuantization,
      installedModels,
      swarmModels: [],
      ollamaHealthy,
      queueDepth: 0,
      connectedAgents: 0,
    };
    systemContent = buildIdeAgentSystemPrompt(ctx, projectRoot);
  } catch {
    // Non-critical — proceed without system prompt
  }

  // SSE setup
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function sendEvent(event: IdeStreamEvent): void {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  // Build message history for the agentic loop
  const messageHistory: Array<{ role: string; content: string }> = [
    ...(systemContent ? [{ role: "system", content: systemContent }] : []),
    ...body.messages,
  ];

  const MAX_ITERATIONS = 20;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Call Ollama (non-streaming to parse full response)
    let assistantContent: string;
    try {
      const { request: httpRequest } = await import("undici");
      const ollamaRes = await httpRequest(`${ollamaHost}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: chatModel,
          messages: messageHistory.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: false,
        }),
        headersTimeout: 120_000,
        bodyTimeout: 120_000,
      });

      const ollamaBody = (await ollamaRes.body.json()) as {
        message?: { content?: string };
      };
      assistantContent = ollamaBody.message?.content ?? "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Ollama request failed";
      sendEvent({ type: "text", content: `Error contacting model: ${msg}` });
      break;
    }

    if (!assistantContent.trim()) {
      break;
    }

    // Parse tool_call and plan blocks
    const toolCallRegex = /```tool_call\s*\n([\s\S]*?)\n```/g;
    const planRegex = /```plan\s*\n([\s\S]*?)\n```/g;

    // Collect all matches with their positions
    interface BlockMatch {
      kind: "tool_call" | "plan";
      start: number;
      end: number;
      body: string;
    }
    const matches: BlockMatch[] = [];

    let m: RegExpExecArray | null;
    while ((m = toolCallRegex.exec(assistantContent)) !== null) {
      matches.push({
        kind: "tool_call",
        start: m.index,
        end: m.index + m[0].length,
        body: m[1],
      });
    }
    while ((m = planRegex.exec(assistantContent)) !== null) {
      matches.push({
        kind: "plan",
        start: m.index,
        end: m.index + m[0].length,
        body: m[1],
      });
    }

    // Sort by position
    matches.sort((a, b) => a.start - b.start);

    // If no tool calls or plans, send the whole text and break
    if (matches.length === 0) {
      sendEvent({ type: "text", content: assistantContent });
      break;
    }

    // Send text between / around matches, and process each match
    let cursor = 0;
    let hadToolCall = false;
    const toolResults: string[] = [];

    for (const match of matches) {
      // Send text before this match
      if (match.start > cursor) {
        const textBefore = assistantContent.slice(cursor, match.start).trim();
        if (textBefore) {
          sendEvent({ type: "text", content: textBefore });
        }
      }
      cursor = match.end;

      if (match.kind === "plan") {
        try {
          const steps = JSON.parse(match.body) as Array<{
            index: number;
            description: string;
            status: string;
          }>;
          sendEvent({
            type: "plan",
            steps: steps.map((s) => ({
              index: s.index,
              description: s.description,
              status: (s.status as "pending" | "in_progress" | "completed" | "failed") || "pending",
            })),
            status: "proposed",
          });
        } catch {
          // Malformed plan — send as text
          sendEvent({ type: "text", content: match.body });
        }
        continue;
      }

      // tool_call
      hadToolCall = true;
      let toolName: ToolName;
      let toolArgs: Record<string, unknown>;

      try {
        const parsed = JSON.parse(match.body) as {
          tool: string;
          args?: Record<string, unknown>;
        };
        toolName = parsed.tool as ToolName;
        toolArgs = parsed.args ?? {};
      } catch {
        sendEvent({
          type: "text",
          content: `(malformed tool call: ${match.body})`,
        });
        continue;
      }

      const callId = `tc_${randomUUID().slice(0, 8)}`;
      const requiresApproval = !READ_TOOLS.has(toolName);

      sendEvent({
        type: "tool_call",
        id: callId,
        tool: toolName,
        args: toolArgs,
        requires_approval: requiresApproval,
      });

      // If write tool — wait for approval
      if (requiresApproval) {
        const approved = await new Promise<boolean>((resolve) => {
          pendingApprovals.set(callId, { resolve, tool: toolName, args: toolArgs });

          // 5-minute timeout — auto-reject
          setTimeout(() => {
            if (pendingApprovals.has(callId)) {
              pendingApprovals.delete(callId);
              resolve(false);
            }
          }, 5 * 60 * 1000);
        });

        if (!approved) {
          const rejectionMsg = `Tool call ${toolName} was rejected by the user.`;
          sendEvent({
            type: "tool_result",
            id: callId,
            error: rejectionMsg,
          });
          toolResults.push(`[Tool ${toolName} rejected]: ${rejectionMsg}`);
          continue;
        }
      }

      // Execute the tool
      const result = await executor.execute(toolName, toolArgs);

      // For run_shell results, parse and send as shell_output
      if (toolName === "run_shell" && result.result) {
        try {
          const shellData = JSON.parse(result.result) as {
            stdout: string;
            stderr: string;
            exit_code: number;
          };
          sendEvent({
            type: "shell_output",
            id: callId,
            stdout: shellData.stdout,
            stderr: shellData.stderr,
            exit_code: shellData.exit_code,
          });
        } catch {
          sendEvent({
            type: "tool_result",
            id: callId,
            result: result.result,
            error: result.error,
          });
        }
      } else {
        sendEvent({
          type: "tool_result",
          id: callId,
          result: result.result,
          error: result.error,
        });
      }

      const resultText = result.error
        ? `[Error]: ${result.error}`
        : result.result ?? "(no output)";
      toolResults.push(`[Tool ${toolName} result]: ${resultText}`);
    }

    // Send any trailing text after the last match
    if (cursor < assistantContent.length) {
      const trailing = assistantContent.slice(cursor).trim();
      if (trailing) {
        sendEvent({ type: "text", content: trailing });
      }
    }

    // Add assistant message + tool results to history for next iteration
    messageHistory.push({ role: "assistant", content: assistantContent });
    if (toolResults.length > 0) {
      messageHistory.push({
        role: "user",
        content: toolResults.join("\n\n"),
      });
    }

    // If no tool calls were found in this iteration, we're done
    if (!hadToolCall) {
      break;
    }
  }

  sendEvent({ type: "done" });
  reply.raw.end();
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
