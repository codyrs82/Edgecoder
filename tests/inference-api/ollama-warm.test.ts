import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_CONTEXT_WINDOW, contextWindowFor, keepAliveValue, ollamaChat, warmOllamaModel } from "../../src/inference-api/ollama.js";
import { workerConfigSchema } from "../../src/config/worker.js";

/*
 * Warm models: the agent loads its network model before taking work, with the context window
 * network calls use (Ollama reloads a model whose num_ctx changes), and every call carries
 * keep_alive so an idle model is not unloaded after Ollama's 5 minute default.
 */
let server: Server | undefined;
afterEach(() => server?.close());

async function capture(reply: string): Promise<{ host: string; bodies: Array<{ url: string; body: any }> }> {
  const bodies: Array<{ url: string; body: any }> = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push({ url: req.url ?? "", body: JSON.parse(raw) });
      res.end(reply);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { host: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies };
}

describe("keep_alive", () => {
  it("sends numbers as numbers and durations as strings; ignores anything else", () => {
    expect(keepAliveValue("-1")).toBe(-1);
    expect(keepAliveValue("300")).toBe(300);
    expect(keepAliveValue("30m")).toBe("30m");
    expect(keepAliveValue("1h30m")).toBe("1h30m");
    expect(keepAliveValue("forever")).toBeUndefined();
    expect(keepAliveValue(undefined)).toBeUndefined();
  });

  it("AGENT_MODEL_KEEP_ALIVE is validated", () => {
    expect(workerConfigSchema.safeParse({ AGENT_MODEL_KEEP_ALIVE: "30m" }).success).toBe(true);
    expect(workerConfigSchema.safeParse({ AGENT_MODEL_KEEP_ALIVE: "-1" }).success).toBe(true);
    expect(workerConfigSchema.safeParse({ AGENT_MODEL_KEEP_ALIVE: "soon" }).success).toBe(false);
  });

  it("a network call carries keep_alive", async () => {
    const { host, bodies } = await capture(JSON.stringify({ message: { content: "hi" }, done: true }) + "\n");
    for await (const _ of ollamaChat(host, { model: "m", messages: [{ role: "user", content: "x" }], keepAlive: "-1" })) void _;
    expect(bodies[0]).toMatchObject({ url: "/api/chat", body: { keep_alive: -1, options: { num_ctx: MIN_CONTEXT_WINDOW } } });
  });
});

describe("context window", () => {
  it("local chat sizes per call, never below the agent's window", () => {
    const short = [{ role: "user" as const, content: "hi" }];
    const long = [{ role: "user" as const, content: "x".repeat(60_000) }];
    expect(contextWindowFor(short, undefined, 64)).toBe(8192);
    expect(contextWindowFor(short, undefined, 64, 16_384)).toBe(16_384);
    expect(contextWindowFor(long, undefined, 64, 16_384)).toBe(32_768);
  });

  it("the last piece carries the model-load time (left out of the power floor)", async () => {
    const { host } = await capture(JSON.stringify({ message: { content: "hi" }, done: true, prompt_eval_count: 48, eval_count: 11, load_duration: 3_400_000_000 }) + "\n");
    const pieces = [];
    for await (const p of ollamaChat(host, { model: "m", messages: [{ role: "user", content: "x" }] })) pieces.push(p);
    expect(pieces.at(-1)).toEqual({ doneReason: "stop", promptTokens: 48, outputTokens: 11, loadMs: 3_400 });
  });

  it("warming with a generation runs a few tokens, not just the load", async () => {
    const { host, bodies } = await capture(JSON.stringify({ response: "OK", done: true }));
    await warmOllamaModel(host, "qwen3-coder:30b", { keepAlive: "-1", numCtx: 65_536, generate: true });
    expect(bodies[0].body).toMatchObject({ model: "qwen3-coder:30b", prompt: "Say OK.", keep_alive: -1, options: { num_ctx: 65_536, num_predict: 4 } });
  });

  it("a fixed window is sent as given", async () => {
    const { host, bodies } = await capture(JSON.stringify({ message: { content: "hi" }, done: true }) + "\n");
    for await (const _ of ollamaChat(host, { model: "m", messages: [{ role: "user", content: "x".repeat(50_000) }], numCtx: 8192 })) void _;
    expect(bodies[0].body.options.num_ctx).toBe(8192);
  });
});

describe("warmOllamaModel", () => {
  it("loads the model with an empty prompt, the network context window and keep_alive", async () => {
    const { host, bodies } = await capture(JSON.stringify({ done: true }));
    await warmOllamaModel(host, "qwen2.5-coder:1.5b", { keepAlive: "30m" });
    await warmOllamaModel(host, "qwen2.5-coder:1.5b", { keepAlive: "30m", numCtx: 16_384 });
    expect(bodies).toEqual([
      { url: "/api/generate", body: { model: "qwen2.5-coder:1.5b", prompt: "", stream: false, keep_alive: "30m", options: { num_ctx: MIN_CONTEXT_WINDOW } } },
      { url: "/api/generate", body: { model: "qwen2.5-coder:1.5b", prompt: "", stream: false, keep_alive: "30m", options: { num_ctx: 16_384 } } },
    ]);
  });

  it("reports Ollama's error", async () => {
    server = createServer((_req, res) => { res.statusCode = 404; res.end(JSON.stringify({ error: "model not found" })); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    await expect(warmOllamaModel(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "x")).rejects.toThrow("ollama: model not found");
  });
});
