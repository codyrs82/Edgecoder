import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderRegistry, ModelProviderKind } from "../../model/providers.js";
import { InteractiveAgent } from "../../agent/interactive.js";
import {
  parseOpenAiRequest,
  formatOpenAiResponse,
  formatOpenAiStreamChunk,
  formatOpenAiModelsResponse,
  OpenAiChatRequest
} from "./openai-compat.js";

const app = Fastify({ logger: true });
const providers = new ProviderRegistry();

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
  const body = chatRequestSchema.parse(req.body) as OpenAiChatRequest;
  const parsed = parseOpenAiRequest(body);
  const requestId = `chatcmpl-${randomUUID()}`;

  // Select provider based on requested model
  const validKinds = providers.availableProviders();
  const selectedKind = validKinds.includes(parsed.model as ModelProviderKind)
    ? (parsed.model as ModelProviderKind)
    : "edgecoder-local";
  providers.use(selectedKind);

  // Detect language from task content
  const language = /\b(javascript|js|typescript|ts|node)\b/i.test(parsed.task)
    ? "javascript" as const
    : "python" as const;

  const agent = new InteractiveAgent(providers.current());

  if (parsed.stream) {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const send = (data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send(formatOpenAiStreamChunk(requestId, selectedKind, "[Planning...]\n"));

    const result = await agent.run(parsed.task, language);

    send(formatOpenAiStreamChunk(requestId, selectedKind, `Plan:\n${result.plan}\n\n`));
    send(formatOpenAiStreamChunk(requestId, selectedKind, `Code:\n${result.generatedCode}\n\n`));

    const status = result.runResult.ok ? "PASSED" : "FAILED";
    send(formatOpenAiStreamChunk(requestId, selectedKind, `Execution: ${status}\n`));

    if (result.runResult.stdout) {
      send(formatOpenAiStreamChunk(requestId, selectedKind, `Output: ${result.runResult.stdout}\n`));
    }
    if (result.runResult.stderr) {
      send(formatOpenAiStreamChunk(requestId, selectedKind, `Errors: ${result.runResult.stderr}\n`));
    }

    send(formatOpenAiStreamChunk(requestId, selectedKind, `\nIterations: ${result.iterations}, Escalated: ${result.escalated}\n`));
    send(formatOpenAiStreamChunk(requestId, selectedKind, "", "stop"));
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return;
  }

  // Non-streaming response
  const result = await agent.run(parsed.task, language);

  const content = [
    result.generatedCode,
    "",
    `// Execution: ${result.runResult.ok ? "PASSED" : "FAILED"}`,
    result.runResult.stdout ? `// Output: ${result.runResult.stdout}` : "",
    result.runResult.stderr ? `// Errors: ${result.runResult.stderr}` : "",
    `// Iterations: ${result.iterations}, Escalated: ${result.escalated}`
  ].filter(Boolean).join("\n");

  return reply.send(formatOpenAiResponse(requestId, selectedKind, content));
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
