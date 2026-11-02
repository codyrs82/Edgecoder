import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { fromAnthropic, anthropicStream } from "../../src/inference-api/anthropic.js";
import { fromOpenAi, openAiResponse } from "../../src/inference-api/openai.js";
import { contextWindowFor } from "../../src/inference-api/ollama.js";
import { registerCompatRoutes } from "../../src/inference-api/routes.js";
import { ChatBackendError, type ChatBackend, type ChatPiece } from "../../src/inference-api/types.js";

async function* pieces(...ps: ChatPiece[]) {
  for (const p of ps) yield p;
}

describe("Anthropic messages -> chat", () => {
  it("maps system, tool use and tool results, keeping tool names", () => {
    const req = fromAnthropic({
      system: [{ type: "text", text: "You are a coder." }],
      messages: [
        { role: "user", content: "list files" },
        { role: "assistant", content: [{ type: "text", text: "Sure." }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "a.ts" }] }] },
      ],
      tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
      max_tokens: 1000,
    });
    expect(req.messages).toEqual([
      { role: "system", content: "You are a coder." },
      { role: "user", content: "list files" },
      { role: "assistant", content: "Sure.", tool_calls: [{ function: { name: "Bash", arguments: { command: "ls" } } }] },
      { role: "tool", content: "a.ts", tool_name: "Bash" },
    ]);
    expect(req.tools?.[0].function.name).toBe("Bash");
    expect(req.maxTokens).toBe(1000);
  });

  it("streams text then a tool_use block, ending with stop_reason tool_use", async () => {
    const out: string[] = [];
    for await (const l of anthropicStream(pieces({ delta: "Hi" }, { toolCalls: [{ function: { name: "Read", arguments: { path: "a" } } }] }, { done: true, cSatsSpent: 0.2 }), "m")) out.push(l);
    const types = out.map((l) => l.split("\n")[0].replace("event: ", ""));
    expect(types).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(out[5]).toContain('"partial_json":"{\\"path\\":\\"a\\"}"');
    expect(out[7]).toContain('"stop_reason":"tool_use"');
  });
});

describe("OpenAI chat -> chat", () => {
  it("maps tool calls (string arguments) and tool results by call id", () => {
    const req = fromOpenAi({
      messages: [
        { role: "developer", content: "sys" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "edit", arguments: '{"x":1}' } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
      tools: [{ type: "function", function: { name: "edit", parameters: { type: "object" } } }],
    });
    expect(req.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(req.messages[2].tool_calls?.[0].function.arguments).toEqual({ x: 1 });
    expect(req.messages[3]).toEqual({ role: "tool", content: "ok", tool_name: "edit" });
  });

  it("returns tool calls with ids and finish_reason tool_calls", async () => {
    const r = await openAiResponse(pieces({ toolCalls: [{ function: { name: "edit", arguments: { x: 1 } } }] }, { done: true }), "m");
    expect(r.choices[0].finish_reason).toBe("tool_calls");
    expect(r.choices[0].message.tool_calls?.[0]).toMatchObject({ type: "function", function: { name: "edit", arguments: '{"x":1}' } });
  });
});

describe("context window", () => {
  it("grows with the prompt, within 8k..32k", () => {
    expect(contextWindowFor([{ role: "user", content: "hi" }], undefined, 1000)).toBe(8192);
    expect(contextWindowFor([{ role: "user", content: "x".repeat(60_000) }], undefined, 4096)).toBe(32_768);
  });
});

describe("compatible routes", () => {
  const backend: ChatBackend = async function* (req) {
    yield { delta: `echo:${req.messages.at(-1)?.content}` };
    yield { done: true, cSatsSpent: 0 };
  };
  const failing: ChatBackend = async function* () {
    throw new ChatBackendError("Not enough cSats", 402);
  };
  const make = (b: ChatBackend) => {
    const app = Fastify();
    registerCompatRoutes(app, { authenticate: async (req) => (req.headers["x-api-key"] === "k" || req.headers.authorization === "Bearer k" ? {} : null), models: async () => ["m1"], resolve: async () => ({ backend: b, model: "m1" }) });
    return app;
  };

  it("refuses a wrong key in each API's error shape", async () => {
    const app = make(backend);
    const a = await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": "nope" }, payload: { messages: [{ role: "user", content: "x" }] } });
    expect(a.statusCode).toBe(401);
    expect(a.json().type).toBe("error");
    const o = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer nope" } });
    expect(o.statusCode).toBe(401);
  });

  it("answers both APIs, streamed and not", async () => {
    const app = make(backend);
    const a = await app.inject({ method: "POST", url: "/v1/messages?beta=true", headers: { "x-api-key": "k" }, payload: { model: "claude-x", max_tokens: 10, messages: [{ role: "user", content: "yo" }] } });
    expect(a.json().content[0]).toEqual({ type: "text", text: "echo:yo" });
    const s = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { stream: true, messages: [{ role: "user", content: "yo" }] } });
    expect(s.body).toContain('"content":"echo:yo"');
    expect(s.body.trim().endsWith("data: [DONE]")).toBe(true);
    const m = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer k" } });
    expect(m.json().data[0].id).toBe("m1");
  });

  it("turns a failure before the first piece into an HTTP error", async () => {
    const app = make(failing);
    const r = await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": "k" }, payload: { stream: true, messages: [{ role: "user", content: "x" }] } });
    expect(r.statusCode).toBe(402);
    expect(r.json().error.message).toContain("cSats");
  });
});
