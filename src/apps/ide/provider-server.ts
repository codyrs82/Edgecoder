import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { request } from "undici";
import { ProviderRegistry, ModelProviderKind } from "../../model/providers.js";
import { InteractiveAgent } from "../../agent/interactive.js";
import {
  formatOpenAiResponse,
  formatOpenAiStreamChunk,
  formatOpenAiModelsResponse,
} from "./openai-compat.js";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:latest";

const app = Fastify({ logger: true });
const providers = new ProviderRegistry();

// --- Ollama health check ---

async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await request(`${OLLAMA_HOST}/api/tags`, { method: "GET" });
    return res.statusCode >= 200 && res.statusCode < 300;
  } catch {
    return false;
  }
}

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

  // Determine which model/provider to use
  const requestedModel = body.model;
  const useOllama = requestedModel !== "edgecoder-local" || await isOllamaAvailable();

  // If Ollama is available, proxy as a real conversational chat
  if (useOllama) {
    const ollamaModel = requestedModel.startsWith("ollama-")
      ? OLLAMA_CHAT_MODEL
      : requestedModel === "edgecoder-local"
        ? OLLAMA_CHAT_MODEL
        : requestedModel;

    if (body.stream) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      try {
        const ollamaRes = await request(`${OLLAMA_HOST}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: ollamaModel,
            messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
            options: {
              temperature: body.temperature ?? 0.7,
              num_predict: body.max_tokens ?? 4096,
            },
          }),
        });

        // Stream Ollama's NDJSON response as SSE chunks
        for await (const chunk of ollamaRes.body) {
          const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
          const lines = text.split("\n").filter(Boolean);

          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as {
                message?: { content?: string };
                done?: boolean;
              };

              if (parsed.message?.content) {
                const sseChunk = formatOpenAiStreamChunk(
                  requestId,
                  ollamaModel,
                  parsed.message.content,
                );
                reply.raw.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
              }

              if (parsed.done) {
                reply.raw.write(
                  `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, ollamaModel, "", "stop"))}\n\n`,
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

        // If we exit the loop without done, close gracefully
        reply.raw.write(
          `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, ollamaModel, "", "stop"))}\n\n`,
        );
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      } catch (err) {
        // Ollama connection failed — send error as a chat message
        const errorMsg = err instanceof Error ? err.message : "Ollama connection failed";
        reply.raw.write(
          `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, "error", `Error connecting to Ollama: ${errorMsg}. Make sure Ollama is running.`))}\n\n`,
        );
        reply.raw.write(
          `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, "error", "", "stop"))}\n\n`,
        );
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      }
      return;
    }

    // Non-streaming Ollama chat
    try {
      const ollamaRes = await request(`${OLLAMA_HOST}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: ollamaModel,
          messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: false,
          options: {
            temperature: body.temperature ?? 0.7,
            num_predict: body.max_tokens ?? 4096,
          },
        }),
      });

      const payload = (await ollamaRes.body.json()) as {
        message?: { content?: string };
      };
      const content = payload.message?.content ?? "";
      return reply.send(formatOpenAiResponse(requestId, ollamaModel, content));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Ollama connection failed";
      return reply.send(
        formatOpenAiResponse(requestId, "error", `Error: ${errorMsg}. Make sure Ollama is running.`),
      );
    }
  }

  // Fallback: edgecoder-local stub (code execution mode)
  const userMessages = body.messages.filter((m) => m.role === "user");
  const task = userMessages.length > 0
    ? userMessages[userMessages.length - 1].content
    : "";

  const language = /\b(javascript|js|typescript|ts|node)\b/i.test(task)
    ? "javascript" as const
    : "python" as const;

  providers.use("edgecoder-local");
  const agent = new InteractiveAgent(providers.current());

  if (body.stream) {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const send = (data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send(formatOpenAiStreamChunk(requestId, "edgecoder-local",
      "⚠️ Ollama is not available. Running in offline code-execution mode.\n\n"));

    const result = await agent.run(task, language);

    send(formatOpenAiStreamChunk(requestId, "edgecoder-local", `**Plan:**\n${result.plan}\n\n`));
    send(formatOpenAiStreamChunk(requestId, "edgecoder-local", `**Code:**\n\`\`\`${language}\n${result.generatedCode}\n\`\`\`\n\n`));

    const status = result.runResult.ok ? "PASSED ✓" : "FAILED ✗";
    send(formatOpenAiStreamChunk(requestId, "edgecoder-local", `**Execution:** ${status}\n`));

    if (result.runResult.stdout) {
      send(formatOpenAiStreamChunk(requestId, "edgecoder-local", `**Output:**\n\`\`\`\n${result.runResult.stdout}\n\`\`\`\n`));
    }
    if (result.runResult.stderr) {
      send(formatOpenAiStreamChunk(requestId, "edgecoder-local", `**Errors:**\n\`\`\`\n${result.runResult.stderr}\n\`\`\`\n`));
    }

    send(formatOpenAiStreamChunk(requestId, "edgecoder-local", "", "stop"));
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return;
  }

  // Non-streaming fallback
  const result = await agent.run(task, language);

  const content = [
    "⚠️ Ollama is not available. Running in offline code-execution mode.\n",
    `**Plan:** ${result.plan}`,
    `\`\`\`${language}\n${result.generatedCode}\n\`\`\``,
    `**Execution:** ${result.runResult.ok ? "PASSED ✓" : "FAILED ✗"}`,
    result.runResult.stdout ? `**Output:** ${result.runResult.stdout}` : "",
    result.runResult.stderr ? `**Errors:** ${result.runResult.stderr}` : "",
  ].filter(Boolean).join("\n\n");

  return reply.send(formatOpenAiResponse(requestId, "edgecoder-local", content));
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
