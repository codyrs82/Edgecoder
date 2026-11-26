import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { fromAnthropic, anthropicStream } from "../../src/inference-api/anthropic.js";
import { fromOpenAi, openAiResponse } from "../../src/inference-api/openai.js";
import { contextWindowFor } from "../../src/inference-api/ollama.js";
import { RESTARTING_MESSAGE, drainOpenRequests, openRequestCount, registerCompatRoutes } from "../../src/inference-api/routes.js";
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

  describe("no capacity (503) and keepalive", () => {
    const busy = (afterMs = 0): ChatBackend =>
      async function* () {
        if (afterMs) await new Promise((r) => setTimeout(r, afterMs));
        throw new ChatBackendError("Every machine is busy", 503, 15);
      };
    const makeWith = (b: ChatBackend, keepaliveMs?: number) => {
      const app = Fastify();
      registerCompatRoutes(app, { authenticate: async () => ({}), models: async () => [], resolve: async () => ({ backend: b, model: "m1" }), keepaliveMs });
      return app;
    };

    it("a call that can't start is 503 with Retry-After, in each API's error shape", async () => {
      const app = makeWith(busy());
      const o = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { messages: [{ role: "user", content: "x" }] } });
      expect(o.statusCode).toBe(503);
      expect(o.headers["retry-after"]).toBe("15");
      expect(o.json().error).toMatchObject({ type: "no_capacity", code: 503 });
      const a = await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": "k" }, payload: { messages: [{ role: "user", content: "x" }] } });
      expect(a.statusCode).toBe(503);
      expect(a.headers["retry-after"]).toBe("15");
      expect(a.json()).toMatchObject({ type: "error", error: { type: "overloaded_error" } });
    });

    it("run 13: a call refused for its price ceiling says so as data (code, reason, neededCSats), for hosted helpers to wait for room", async () => {
      const refused: ChatBackend = async function* () {
        throw new ChatBackendError("No model on the network fits this request: every fitting model costs more than the 1.237 cSats ceiling (the cheapest, deepseek-v4.1-flash on cloud, is about 3.901 cSats).", 404, undefined, { code: "no_route_fits", reason: "price", neededCSats: 3.901, computeClass: "cloud" });
      };
      const app = makeWith(refused);
      const o = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { stream: true, messages: [{ role: "user", content: "x" }] } });
      expect(o.statusCode).toBe(404);
      expect(o.json().error).toMatchObject({ code: 404, edgecoder: { code: "no_route_fits", reason: "price", neededCSats: 3.901, computeClass: "cloud" } });
      // An error without data is as before.
      expect((await makeWith(busy()).inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { messages: [{ role: "user", content: "x" }] } })).json().error.edgecoder).toBeUndefined();
    });

    it("answers an upstream 502/504 as a JSON 503 (Cloudflare would replace a 502 with its own page)", async () => {
      const agentFailed: ChatBackend = async function* () {
        throw new ChatBackendError("The machine running deepseek-v4.1-flash reported: empty_reply", 502);
      };
      const app = makeWith(agentFailed);
      const o = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { messages: [{ role: "user", content: "x" }] } });
      expect(o.statusCode).toBe(503);
      expect(o.headers["retry-after"]).toBe("2");
      expect(o.json().error).toMatchObject({ type: "upstream_error", code: 503 });
      expect(o.json().error.message).toContain("empty_reply");
      const a = await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": "k" }, payload: { messages: [{ role: "user", content: "x" }] } });
      expect(a.statusCode).toBe(503);
      const gw: ChatBackend = async function* () {
        throw new ChatBackendError("gateway", 504);
      };
      expect((await makeWith(gw).inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { messages: [{ role: "user", content: "x" }] } })).statusCode).toBe(503);
    });

    it("a streamed call waiting for its first piece sends SSE keepalive comments, then the error event", async () => {
      const app = makeWith(busy(250), 40);
      const o = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { stream: true, messages: [{ role: "user", content: "x" }] } });
      expect(o.statusCode).toBe(200);
      expect(o.headers["content-type"]).toContain("text/event-stream");
      expect(o.body).toContain(": keepalive\n\n");
      expect(o.body).toContain('"type":"no_capacity"');
      expect(o.body.trim().endsWith("data: [DONE]")).toBe(true);
      const a = await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": "k" }, payload: { stream: true, messages: [{ role: "user", content: "x" }] } });
      expect(a.body).toContain(": keepalive\n\n");
      expect(a.body).toContain("event: error");
      expect(a.body).toContain('"overloaded_error"');
    });

    describe("server stopping (drain)", () => {
      /** Sends one piece, then waits until aborted (a long reply still being generated). */
      const slowReply = (firstAfterMs = 0): ChatBackend =>
        async function* (_req, signal) {
          if (firstAfterMs) await new Promise((r) => setTimeout(r, firstAfterMs));
          yield { delta: "partial " };
          await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true })));
        };
      const waitOpen = async (n: number) => {
        for (let i = 0; i < 200 && openRequestCount() < n; i++) await new Promise((r) => setTimeout(r, 5));
      };

      it("a stream still open at the drain bound ends with server_restarting and [DONE], not a cut", async () => {
        const app = makeWith(slowReply(), 40);
        const pending = app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { stream: true, messages: [{ role: "user", content: "x" }] } });
        await waitOpen(1);
        expect(await drainOpenRequests(30, 5)).toBe(1);
        const o = await pending;
        expect(o.statusCode).toBe(200);
        expect(o.body).toContain('"content":"partial "');
        expect(o.body).toContain('"type":"server_restarting"');
        expect(o.body).toContain(RESTARTING_MESSAGE);
        expect(o.body.trim().endsWith("data: [DONE]")).toBe(true);
        expect(openRequestCount()).toBe(0);
      });

      it("a request that has sent nothing yet gets a 503 with Retry-After", async () => {
        const app = makeWith(slowReply(10_000), 60_000);
        const pending = app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { stream: true, messages: [{ role: "user", content: "x" }] } });
        await waitOpen(1);
        expect(await drainOpenRequests(0)).toBe(1);
        const o = await pending;
        expect(o.statusCode).toBe(503);
        expect(o.headers["retry-after"]).toBe("5");
        expect(o.json().error).toMatchObject({ type: "server_restarting", code: 503 });
      });

      it("requests that finish within the grace are left alone", async () => {
        const app = makeWith(backend, 40);
        const pending = app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { stream: true, messages: [{ role: "user", content: "yo" }] } });
        expect(await drainOpenRequests(2_000, 5)).toBe(0);
        const o = await pending;
        expect(o.body).toContain('"content":"echo:yo"');
        expect(o.body).not.toContain("server_restarting");
      });
    });

    it("a fast streamed call sends no keepalive", async () => {
      const app = makeWith(backend, 40);
      const s = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { stream: true, messages: [{ role: "user", content: "yo" }] } });
      expect(s.body).not.toContain("keepalive");
      expect(s.body).toContain('"content":"echo:yo"');
    });
  });
});
