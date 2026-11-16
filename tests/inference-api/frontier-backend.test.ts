import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { backendChat, runAgentLoop, toolSchemas } from "../../src/apps/ide/agent-loop.js";
import { frontierBackend, testFrontierKey, toAnthropicMessages, turnFingerprint, type FrontierTarget } from "../../src/inference-api/frontier.js";
import type { ChatPiece } from "../../src/inference-api/types.js";

// A fake Anthropic Messages API and a fake OpenAI-compatible API on loopback.
const KEY = "sk-ant-api03-FAKEKEY-abcdefghijklmnopqrstuvwxyz0123456789";
const OAI_KEY = "sk-proj-FAKEKEYabcdefghijklmnopqrstuvwxyz0123";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handlers: Handler[] = [];
const seen: Array<{ url: string; headers: IncomingMessage["headers"]; body: any }> = [];
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: body ? JSON.parse(body) : null });
      const h = handlers.shift();
      if (!h) {
        res.writeHead(500).end("no handler");
        return;
      }
      h(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  handlers = [];
  seen.length = 0;
});

function sse(res: ServerResponse, events: Array<Record<string, unknown>>) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

const anthropicReply = (opts: { text?: string; tool?: { name: string; input: unknown }; thinking?: boolean; stop?: string; model?: string; stopDetails?: unknown }) => {
  const ev: Array<Record<string, unknown>> = [{ type: "message_start", message: { model: opts.model ?? "claude-opus-5-5", usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }];
  let i = 0;
  if (opts.thinking) {
    ev.push({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } });
    ev.push({ type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: "" } });
    ev.push({ type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "SIG123" } });
    ev.push({ type: "content_block_stop", index: i++ });
  }
  if (opts.text) {
    ev.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
    for (const part of opts.text.match(/.{1,5}/g) ?? []) ev.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: part } });
    ev.push({ type: "content_block_stop", index: i++ });
  }
  if (opts.tool) {
    ev.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: "toolu_FAKE1", name: opts.tool.name, input: {} } });
    const json = JSON.stringify(opts.tool.input);
    ev.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } });
    ev.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(5) } });
    ev.push({ type: "content_block_stop", index: i++ });
  }
  ev.push({ type: "message_delta", delta: { stop_reason: opts.stop ?? (opts.tool ? "tool_use" : "end_turn"), ...(opts.stopDetails ? { stop_details: opts.stopDetails } : {}) }, usage: { output_tokens: 500 } });
  ev.push({ type: "message_stop" });
  return ev;
};

const target = (over: Partial<FrontierTarget> = {}): FrontierTarget => ({
  provider: { id: "anthropic", kind: "anthropic", baseUrl: base },
  model: "claude-opus-5-5",
  apiKey: async () => KEY,
  effort: "high",
  baseDelayMs: 1,
  ...over,
});

async function collect(it: AsyncIterable<ChatPiece>) {
  const out: ChatPiece[] = [];
  for await (const p of it) out.push(p);
  return out;
}

describe("frontierBackend: Anthropic Messages API", () => {
  it("streams text, sends the key only in x-api-key, and prices the call", async () => {
    handlers.push((_req, _b, res) => sse(res, anthropicReply({ text: "Hello there" })));
    const pieces = await collect(frontierBackend(target())({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }], temperature: 0.3 }));
    expect(pieces.filter((p) => "delta" in p).map((p) => (p as { delta: string }).delta).join("")).toBe("Hello there");
    const done = pieces.at(-1) as Extract<ChatPiece, { done: true }>;
    // 1000 in x $4/M + 500 out x $20/M = 0.004 + 0.01
    expect(done).toMatchObject({ done: true, cSatsSpent: 0, promptTokens: 1000, outputTokens: 500, usd: 0.014, servedBy: "claude-opus-5-5" });
    // A where-it-ran line in the network's served shape, so footers and the terminal show it.
    expect(done.served).toMatchObject({ label: "Anthropic (your key)", own: true, computeClass: "frontier", hardware: "Anthropic · your key", promptTokens: 1000, outputTokens: 500, usd: 0.014 });
    const r = seen[0];
    expect(r.url).toBe("/v1/messages");
    expect(r.headers["x-api-key"]).toBe(KEY);
    expect(r.headers["anthropic-version"]).toBe("2023-06-01");
    expect(r.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    expect(r.body).toMatchObject({ model: "claude-opus-5-5", stream: true, system: "Be brief.", output_config: { effort: "high" }, cache_control: { type: "ephemeral" }, fallbacks: "default" });
    // Sampling parameters are rejected by current models: never sent.
    expect(r.body.temperature).toBeUndefined();
    expect(r.body.thinking).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(KEY);
  });

  it("maps tool use both ways and passes thinking blocks back unchanged within a turn", async () => {
    handlers.push((_req, _b, res) => sse(res, anthropicReply({ thinking: true, text: "Reading it.", tool: { name: "read_file", input: { path: "a.ts" } } })));
    handlers.push((_req, _b, res) => sse(res, anthropicReply({ text: "Done: a.ts exports x." })));
    const events: unknown[] = [];
    await runAgentLoop({
      chat: backendChat(frontierBackend(target())),
      systemPrompt: () => "sys",
      messages: [{ role: "user", content: "what does a.ts export?" }],
      sendEvent: (e) => events.push(e),
      isCancelled: () => false,
      tools: toolSchemas(),
      runTool: async (tool, args) => `ran ${tool} ${JSON.stringify(args)}`,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].body.tools.find((t: { name: string }) => t.name === "read_file")).toMatchObject({ name: "read_file", input_schema: { type: "object" } });
    const second = seen[1].body.messages;
    expect(second[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "SIG123" },
        { type: "text", text: "Reading it." },
        { type: "tool_use", id: "toolu_FAKE1", name: "read_file", input: { path: "a.ts" } },
      ],
    });
    expect(second[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_FAKE1", content: 'ran read_file {"path":"a.ts"}' }] });
  });

  it("retries 429 and 529 before streaming, honouring Retry-After", async () => {
    const waits: number[] = [];
    handlers.push((_req, _b, res) => res.writeHead(429, { "retry-after": "2", "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } })));
    handlers.push((_req, _b, res) => res.writeHead(529, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })));
    handlers.push((_req, _b, res) => sse(res, anthropicReply({ text: "ok" })));
    const pieces = await collect(frontierBackend(target({ sleep: async (ms) => void waits.push(ms) }))({ messages: [{ role: "user", content: "hi" }] }));
    expect(pieces.some((p) => "delta" in p && p.delta === "ok")).toBe(true);
    expect(seen).toHaveLength(3);
    expect(waits[0]).toBeGreaterThanOrEqual(2000);
  });

  it("retries an overloaded error event that arrives before any output", async () => {
    handlers.push((_req, _b, res) => sse(res, [{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]));
    handlers.push((_req, _b, res) => sse(res, anthropicReply({ text: "second time" })));
    const pieces = await collect(frontierBackend(target())({ messages: [{ role: "user", content: "hi" }] }));
    expect(pieces.map((p) => ("delta" in p ? p.delta : "")).join("")).toBe("second time");
  });

  it("gives up after maxRetries with the provider's message", async () => {
    for (let i = 0; i < 3; i++) handlers.push((_req, _b, res) => res.writeHead(503).end("busy"));
    await expect(collect(frontierBackend(target({ maxRetries: 2 }))({ messages: [{ role: "user", content: "hi" }] }))).rejects.toThrow(/server error \(HTTP 503\)/);
    expect(seen).toHaveLength(3);
  });

  it("says clearly when the key is rejected, without echoing it or retrying", async () => {
    handlers.push((_req, _b, res) => res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } })));
    const err = await collect(frontierBackend(target())({ messages: [{ role: "user", content: "hi" }] })).catch((e) => e as Error & { status: number });
    expect(err).toBeInstanceOf(Error);
    expect((err as { status: number }).status).toBe(401);
    expect((err as Error).message).toMatch(/Anthropic rejected your API key/);
    expect((err as Error).message).not.toContain(KEY);
    expect(seen).toHaveLength(1);
  });

  it("redacts a key quoted in any other provider error", async () => {
    handlers.push((_req, _b, res) => res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `bad request for key ${KEY}` } })));
    const err = (await collect(frontierBackend(target())({ messages: [{ role: "user", content: "hi" }] })).catch((e) => e)) as Error;
    expect(err.message).toMatch(/refused the request \(HTTP 400\)/);
    expect(err.message).not.toContain("FAKEKEY");
  });

  it("does not run tools from a refused or cut-off reply", async () => {
    handlers.push((_req, _b, res) => sse(res, anthropicReply({ text: "Sure", tool: { name: "run_shell", input: { command: "ls" } }, stop: "max_tokens" })));
    const cut = await collect(frontierBackend(target())({ messages: [{ role: "user", content: "hi" }] }));
    expect(cut.some((p) => "toolCalls" in p)).toBe(false);
    expect(cut.some((p) => "delta" in p && /output limit/.test(p.delta))).toBe(true);
    handlers.push((_req, _b, res) => sse(res, anthropicReply({ stop: "refusal", stopDetails: { category: "cyber" } })));
    const refused = await collect(frontierBackend(target())({ messages: [{ role: "user", content: "hi" }] }));
    expect(refused.some((p) => "delta" in p && /declined this request \[cyber\]/.test(p.delta))).toBe(true);
  });

  it("prices a server-side fallback by the model that answered", async () => {
    handlers.push((_req, _b, res) => sse(res, anthropicReply({ text: "hi", model: "claude-sonnet-5-5" })));
    const done = (await collect(frontierBackend(target())({ messages: [{ role: "user", content: "hi" }] }))).at(-1) as Extract<ChatPiece, { done: true }>;
    expect(done.servedBy).toBe("claude-sonnet-5-5");
    expect(done.usd).toBe(0.007); // 1000 x $2/M + 500 x $10/M
  });

  it("builds a valid conversation from the internal format", () => {
    const calls = [{ function: { name: "read_file", arguments: { path: "x" } } }];
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "S" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "", tool_calls: calls },
      { role: "tool", content: "[Error]: missing", tool_name: "read_file" },
      { role: "user", content: "and then?" },
    ]);
    expect(system).toBe("S");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const id = (messages[1].content[0] as { id: string }).id;
    expect(messages[2].content).toEqual([{ type: "tool_result", tool_use_id: id, content: "[Error]: missing", is_error: true }, { type: "text", text: "and then?" }]);
    expect(turnFingerprint("", calls)).toBe(JSON.stringify(["", [["read_file", { path: "x" }]]]));
  });
});

describe("frontierBackend: OpenAI-compatible", () => {
  const oai = (over: Partial<FrontierTarget> = {}) => target({ provider: { id: "openai", kind: "openai-compatible", baseUrl: `${base}/v1` }, model: "gpt-5", apiKey: async () => OAI_KEY, ...over });
  const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

  it("streams text and tool calls, with usage, bearer auth and no temperature", async () => {
    handlers.push((_req, _b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ model: "gpt-5", choices: [{ delta: { content: "Let me look." } }] }));
      res.write(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } }] } }] }));
      res.write(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"b.ts"}' } }] }, finish_reason: "tool_calls" }] }));
      res.write(chunk({ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 1000 } } }));
      res.end("data: [DONE]\n\n");
    });
    const pieces = await collect(frontierBackend(oai({ prices: { "openai/gpt-5": { input: 1, output: 10 } } }))({ messages: [{ role: "user", content: "hi" }], tools: toolSchemas() as never, temperature: 0.3 }));
    expect(pieces[0]).toEqual({ delta: "Let me look." });
    expect(pieces[1]).toEqual({ toolCalls: [{ function: { name: "read_file", arguments: { path: "b.ts" } } }] });
    // 1000 uncached x $1/M + 1000 cached x $0.5/M + 100 x $10/M
    expect(pieces[2]).toMatchObject({ done: true, promptTokens: 2000, outputTokens: 100, usd: 0.0025 });
    expect(seen[0].url).toBe("/v1/chat/completions");
    expect(seen[0].headers.authorization).toBe(`Bearer ${OAI_KEY}`);
    expect(seen[0].body).toMatchObject({ model: "gpt-5", stream: true, stream_options: { include_usage: true } });
    expect(seen[0].body.temperature).toBeUndefined();
  });

  it("retries a 500 and maps 401 to a clear error", async () => {
    handlers.push((_req, _b, res) => res.writeHead(500).end("{}"));
    handlers.push((_req, _b, res) => res.writeHead(401).end(JSON.stringify({ error: { message: `Incorrect API key provided: ${OAI_KEY}` } })));
    const err = (await collect(frontierBackend(oai())({ messages: [{ role: "user", content: "hi" }] })).catch((e) => e)) as Error;
    expect(err.message).toMatch(/OpenAI rejected your API key/);
    expect(err.message).not.toContain("FAKEKEY");
    expect(seen).toHaveLength(2);
  });

  it("drops stream_options once for a server that refuses it", async () => {
    handlers.push((_req, _b, res) => res.writeHead(400).end(JSON.stringify({ error: { message: "Unrecognized request argument: stream_options" } })));
    handlers.push((_req, _b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(chunk({ choices: [{ delta: { content: "fine" }, finish_reason: "stop" }] }));
    });
    const pieces = await collect(frontierBackend(oai())({ messages: [{ role: "user", content: "hi" }] }));
    expect(pieces[0]).toEqual({ delta: "fine" });
    expect(seen[1].body.stream_options).toBeUndefined();
  });
});

describe("testFrontierKey", () => {
  it("lists models with the key (no tokens used) and reports a bad key", async () => {
    handlers.push((_req, _b, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-5-5" }] })));
    expect(await testFrontierKey({ id: "anthropic", kind: "anthropic", baseUrl: base }, KEY)).toEqual({ models: ["claude-opus-5-5", "claude-haiku-5-5"] });
    expect(seen[0].url).toBe("/v1/models?limit=100");
    expect(seen[0].headers["x-api-key"]).toBe(KEY);
    handlers.push((_req, _b, res) => res.writeHead(401).end("{}"));
    await expect(testFrontierKey({ id: "openai", kind: "openai-compatible", baseUrl: `${base}/v1` }, OAI_KEY)).rejects.toThrow(/rejected your API key/);
    expect(seen[1].url).toBe("/v1/models");
  });
});
