import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { hostedBackend, hostedConfigFromEnv, toOpenAiMessages } from "../../src/apps/ide/hosted-backend.js";

let server: Server | null = null;
afterEach(() => server?.close());

describe("the hosted endpoint as a chat backend (API key)", () => {
  it("is configured only with a key, and only for https (or a local test server)", () => {
    expect(hostedConfigFromEnv({})).toBeNull();
    expect(hostedConfigFromEnv({ EDGECODER_API_KEY: "eck_x" })?.baseUrl).toBe("https://edgecoder.io");
    expect(hostedConfigFromEnv({ EDGECODER_API_KEY: "eck_x", EDGECODER_URL: "https://example.com/v1/" })?.baseUrl).toBe("https://example.com");
    expect(hostedConfigFromEnv({ EDGECODER_API_KEY: "eck_x", EDGECODER_URL: "http://evil.example" })).toBeNull();
  });

  it("pairs tool results with the call ids of the reply before them", () => {
    const out = toOpenAiMessages([
      { role: "user", content: "read a" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a" } } }] },
      { role: "tool", content: "A", tool_name: "read_file" },
    ]);
    expect(out[1]).toMatchObject({ tool_calls: [{ id: "call_1_0", function: { name: "read_file", arguments: '{"path":"a"}' } }] });
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "call_1_0", content: "A" });
  });

  it("streams text, assembles tool calls split across chunks, and reports cSats", async () => {
    let auth = "";
    let body: { model?: string; tools?: unknown[] } = {};
    server = createServer((req, res) => {
      auth = String(req.headers.authorization);
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        body = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        chunk({ choices: [{ delta: { content: "Reading " } }] });
        chunk({ choices: [{ delta: { content: "it." } }] });
        chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read_file", arguments: '{"pa' } }] } }] });
        chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 3 }, edgecoder: { cSatsSpent: 0.063 } });
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const backend = hostedBackend({ baseUrl: `http://127.0.0.1:${port}`, apiKey: () => "eck_test" }, "network/qwen3-coder:30b");
    const pieces = [];
    for await (const p of backend({ messages: [{ role: "user", content: "read the readme" }], tools: [{ type: "function", function: { name: "read_file" } }] })) pieces.push(p);
    expect(auth).toBe("Bearer eck_test");
    expect(body.model).toBe("network/qwen3-coder:30b");
    expect(body.tools).toHaveLength(1);
    expect(pieces).toEqual([
      { delta: "Reading " },
      { delta: "it." },
      { toolCalls: [{ function: { name: "read_file", arguments: { path: "README.md" } } }] },
      { done: true, stopReason: "stop", cSatsSpent: 0.063, promptTokens: 10, outputTokens: 3 },
    ]);
  });

  it("explains a refused key", async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const it = hostedBackend({ baseUrl: `http://127.0.0.1:${port}`, apiKey: () => "eck_bad" }, "auto")({ messages: [{ role: "user", content: "x" }] });
    await expect(it.next()).rejects.toThrow(/refused the API key/);
  });
});
