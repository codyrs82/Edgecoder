import { afterEach, describe, expect, it } from "vitest";
import {
  EngineError,
  ENGINE_PRESETS,
  engineGenerate,
  engineKvCacheTokens,
  isContextOverflowMessage,
  kvTokensFromMetrics,
  listEngineModels,
  openAiEngineChat,
  resolveEngine,
  toOpenAiMessages,
  type OpenAiEngine
} from "../../src/inference-api/openai-engine.js";
import { localEngineBackend } from "../../src/inference-api/backends.js";
import { ChatBackendError } from "../../src/inference-api/types.js";
import { workerConfigSchema } from "../../src/config/worker.js";
import { startFakeEngine, type FakeEngine } from "../helpers/fake-openai-engine.js";

/*
 * vLLM and MLX engines (src/inference-api/openai-engine.ts): selection by env, the OpenAI
 * protocol (streaming, tool calls, usage, errors, context overflow) against a fake server.
 */

let fake: FakeEngine | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const VLLM_ID = "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ";
const engineAt = (url: string, preset: "vllm" | "mlx" = "vllm"): OpenAiEngine => ({ preset, url });
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("engine selection (EDGECODER_ENGINE)", () => {
  it("defaults to Ollama: unset, empty or 'ollama'", () => {
    expect(resolveEngine({})).toEqual({ kind: "ollama" });
    expect(resolveEngine({ EDGECODER_ENGINE: "" })).toEqual({ kind: "ollama" });
    expect(resolveEngine({ EDGECODER_ENGINE: "Ollama" })).toEqual({ kind: "ollama" });
  });

  it("vllm: VLLM_URL (default :8000), VLLM_MAX_SLOTS, VLLM_MODEL, VLLM_API_KEY", () => {
    expect(resolveEngine({ EDGECODER_ENGINE: "vllm" })).toEqual({ kind: "vllm", preset: "vllm", url: "http://127.0.0.1:8000" });
    expect(resolveEngine({ EDGECODER_ENGINE: "VLLM", VLLM_URL: "http://10.0.0.5:9000/", VLLM_MAX_SLOTS: "6", VLLM_MODEL: VLLM_ID, VLLM_API_KEY: "k" })).toEqual({
      kind: "vllm", preset: "vllm", url: "http://10.0.0.5:9000", maxSlots: 6, model: VLLM_ID, apiKey: "k"
    });
  });

  it("mlx: MLX_URL (default :8080), MLX_MAX_SLOTS, MLX_MODEL; no API key", () => {
    expect(resolveEngine({ EDGECODER_ENGINE: "mlx", VLLM_API_KEY: "k" })).toEqual({ kind: "mlx", preset: "mlx", url: "http://127.0.0.1:8080" });
    expect(resolveEngine({ EDGECODER_ENGINE: "mlx", MLX_MODEL: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit", MLX_MAX_SLOTS: "2" })).toMatchObject({ model: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit", maxSlots: 2 });
    expect(ENGINE_PRESETS.mlx.defaultSlots).toBe(1);
    expect(ENGINE_PRESETS.vllm.defaultSlots).toBe("derive");
  });

  it("a typo or a bad slot count stops the agent instead of falling back to Ollama", () => {
    expect(() => resolveEngine({ EDGECODER_ENGINE: "vlm" })).toThrow(/ollama, vllm or mlx/);
    expect(() => resolveEngine({ EDGECODER_ENGINE: "vllm", VLLM_MAX_SLOTS: "0" })).toThrow(/VLLM_MAX_SLOTS/);
    expect(() => resolveEngine({ EDGECODER_ENGINE: "mlx", MLX_MAX_SLOTS: "17" })).toThrow(/MLX_MAX_SLOTS/);
    expect(() => resolveEngine({ EDGECODER_ENGINE: "vllm", VLLM_URL: "localhost:8000" })).toThrow(/VLLM_URL/);
  });

  it("the worker config validates the same variables", () => {
    expect(workerConfigSchema.safeParse({ EDGECODER_ENGINE: "vllm", VLLM_URL: "http://127.0.0.1:8000", VLLM_MAX_SLOTS: "4" }).success).toBe(true);
    expect(workerConfigSchema.safeParse({ EDGECODER_ENGINE: "mlx", MLX_URL: "http://127.0.0.1:8080", MLX_MAX_SLOTS: "1" }).success).toBe(true);
    expect(workerConfigSchema.safeParse({ EDGECODER_ENGINE: "tgi" }).success).toBe(false);
    expect(workerConfigSchema.safeParse({ VLLM_MAX_SLOTS: "99" }).success).toBe(false);
  });
});

describe("/v1/models and /metrics", () => {
  it("vLLM: served ids with max_model_len; the KV cache from cache_config_info", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: VLLM_ID, maxModelLen: 65_536 }], kvBlocks: 5_440, blockSize: 16, reply: () => ({}) });
    const e = engineAt(fake.url);
    expect(await listEngineModels(e)).toEqual([{ id: VLLM_ID, maxModelLen: 65_536 }]);
    expect(await engineKvCacheTokens(e)).toBe(87_040);
  });

  it("MLX: ids only, and no KV metric", async () => {
    fake = await startFakeEngine({ flavor: "mlx", models: [{ id: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit" }], reply: () => ({}) });
    const e = engineAt(fake.url, "mlx");
    expect(await listEngineModels(e)).toEqual([{ id: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit" }]);
    expect(await engineKvCacheTokens(e)).toBeUndefined();
  });

  it("parses the Prometheus line in any label order; missing labels give undefined", () => {
    expect(kvTokensFromMetrics('vllm:cache_config_info{num_gpu_blocks="100",block_size="32"} 1.0')).toBe(3_200);
    expect(kvTokensFromMetrics('vllm:cache_config_info{block_size="16"} 1.0')).toBeUndefined();
    expect(kvTokensFromMetrics("")).toBeUndefined();
  });

  it("an unreachable engine throws (the probe turns that into a clear problem)", async () => {
    await expect(listEngineModels(engineAt("http://127.0.0.1:9"), 500)).rejects.toThrow();
  });

  it("sends VLLM_API_KEY as a bearer token", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: VLLM_ID }], reply: () => ({}) });
    await listEngineModels({ preset: "vllm", url: fake.url, apiKey: "sekrit" });
    expect(fake.requests[0].headers.authorization).toBe("Bearer sekrit");
  });
});

describe("chat completions (streaming)", () => {
  it("streams text, then ends with usage and timings; the request asks for usage, no thinking, no seed", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: VLLM_ID }], reply: () => ({ pieces: ["Hel", "lo", "!"], usage: { prompt_tokens: 12, completion_tokens: 3 }, pieceDelayMs: 5 }) });
    const pieces = await collect(openAiEngineChat(engineAt(fake.url), { model: VLLM_ID, messages: [{ role: "user", content: "hi" }], maxTokens: 64, temperature: 0.2 }));
    expect(pieces.filter((p) => "delta" in p).map((p) => (p as { delta: string }).delta).join("")).toBe("Hello!");
    const end = pieces.at(-1) as { doneReason: string; promptTokens: number; outputTokens: number; promptMs: number; genMs: number };
    expect(end).toMatchObject({ doneReason: "stop", promptTokens: 12, outputTokens: 3 });
    expect(end.promptMs).toBeGreaterThanOrEqual(0);
    expect(end.genMs).toBeGreaterThanOrEqual(5);
    expect(fake.requests[0].body).toMatchObject({ model: VLLM_ID, stream: true, stream_options: { include_usage: true }, max_tokens: 64, temperature: 0.2, chat_template_kwargs: { enable_thinking: false } });
    // mlx_lm.server does not batch a call that carries a seed: none unless asked.
    expect(fake.requests[0].body.seed).toBeUndefined();
  });

  it("assembles streamed tool-call fragments into whole calls, in order", async () => {
    fake = await startFakeEngine({
      flavor: "vllm",
      models: [{ id: VLLM_ID }],
      reply: () => ({ toolCalls: [{ name: "read_file", arguments: { path: "src/a.ts" } }, { name: "run", arguments: { cmd: "npm test", timeout: 60 } }], usage: { prompt_tokens: 50, completion_tokens: 30 } })
    });
    const tools = [{ type: "function" as const, function: { name: "read_file", parameters: { type: "object" } } }];
    const pieces = await collect(openAiEngineChat(engineAt(fake.url), { model: VLLM_ID, messages: [{ role: "user", content: "go" }], tools }));
    expect(pieces).toContainEqual({ toolCalls: [{ function: { name: "read_file", arguments: { path: "src/a.ts" } } }, { function: { name: "run", arguments: { cmd: "npm test", timeout: 60 } } }] });
    expect(fake.requests[0].body.tools).toEqual(tools);
  });

  it("finish_reason length is reported as length", async () => {
    fake = await startFakeEngine({ flavor: "mlx", models: [{ id: "m" }], reply: () => ({ pieces: ["a"], finishReason: "length" }) });
    const pieces = await collect(openAiEngineChat(engineAt(fake.url, "mlx"), { model: "m", messages: [{ role: "user", content: "x" }] }));
    expect(pieces.at(-1)).toMatchObject({ doneReason: "length" });
  });

  it("a prompt past max_model_len is a context-overflow error (another agent may take it)", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: VLLM_ID, maxModelLen: 8192 }], maxPromptChars: 100, reply: () => ({ pieces: ["x"] }) });
    const err = await collect(openAiEngineChat(engineAt(fake.url), { model: VLLM_ID, messages: [{ role: "user", content: "y".repeat(500) }] })).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ status: 400, contextOverflow: true });
    expect(err.message).toMatch(/^vLLM: This model's maximum context length is 8192/);
  });

  it("other HTTP errors (vLLM's and FastAPI's shapes) are not overflow", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: VLLM_ID }], reply: () => ({ status: 404, errorBody: { error: { message: "The model `nope` does not exist.", type: "NotFoundError", code: 404 } } }) });
    const err = await collect(openAiEngineChat(engineAt(fake.url), { model: "nope", messages: [{ role: "user", content: "x" }] })).catch((e) => e);
    expect(err).toMatchObject({ status: 404, contextOverflow: false, message: "vLLM: The model `nope` does not exist." });
  });

  it("an error event mid-stream throws", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: VLLM_ID }], reply: () => ({ pieces: ["par"], midStreamError: "CUDA out of memory" }) });
    const seen: string[] = [];
    const err = await (async () => {
      for await (const p of openAiEngineChat(engineAt(fake!.url), { model: VLLM_ID, messages: [{ role: "user", content: "x" }] })) if ("delta" in p) seen.push(p.delta);
    })().catch((e) => e);
    expect(seen).toEqual(["par"]);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toMatch(/CUDA out of memory/);
  });

  it("context-overflow wording", () => {
    expect(isContextOverflowMessage("This model's maximum context length is 65536 tokens. However, you requested 70000 tokens")).toBe(true);
    expect(isContextOverflowMessage("Input length (70000) exceeds the model's maximum context length (65536)")).toBe(true);
    expect(isContextOverflowMessage("The model `x` does not exist.")).toBe(false);
  });
});

describe("internal messages as OpenAI messages", () => {
  it("assistant tool calls get ids; tool results answer them by name, in order", () => {
    const out = toOpenAiMessages([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "a", arguments: { x: 1 } } }, { function: { name: "b", arguments: {} } }] },
      { role: "tool", content: "rb", tool_name: "b" },
      { role: "tool", content: "ra", tool_name: "a" }
    ]);
    expect(out[2]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "a", arguments: '{"x":1}' } }, { id: "call_1", type: "function", function: { name: "b", arguments: "{}" } }] });
    expect(out[3]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "rb" });
    expect(out[4]).toMatchObject({ role: "tool", tool_call_id: "call_0", content: "ra" });
  });
});

describe("engineGenerate (benchmark timing)", () => {
  it("greedy with the seed; decode time from the first to the last piece; the engine's token count", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: VLLM_ID }], reply: () => ({ pieces: Array.from({ length: 11 }, (_, i) => `t${i} `), pieceDelayMs: 4, usage: { prompt_tokens: 40, completion_tokens: 11 } }) });
    const g = await engineGenerate(engineAt(fake.url), { model: VLLM_ID, prompt: "p", seed: 42, maxTokens: 512, timeoutMs: 5_000 });
    expect(g.response).toBe(Array.from({ length: 11 }, (_, i) => `t${i} `).join(""));
    expect(g.evalCount).toBe(11);
    // 10 gaps of >= 4 ms, scaled by 11/10.
    expect(g.evalDurationMs).toBeGreaterThanOrEqual(40);
    expect(fake.requests[0].body).toMatchObject({ temperature: 0, seed: 42, max_tokens: 512, messages: [{ role: "user", content: "p" }] });
  });

  it("without usage (an older mlx_lm.server) counts the streamed pieces", async () => {
    fake = await startFakeEngine({ flavor: "mlx", models: [{ id: "m" }], reply: () => ({ pieces: ["a", "b", "c"], pieceDelayMs: 2 }) });
    const g = await engineGenerate(engineAt(fake.url, "mlx"), { model: "m", prompt: "p", seed: 1, maxTokens: 8, timeoutMs: 5_000 });
    expect(g.evalCount).toBe(3);
  });
});

describe("localEngineBackend (this computer's vLLM / MLX as a chat backend)", () => {
  it("streams, then ends free with the counts", async () => {
    fake = await startFakeEngine({ flavor: "mlx", models: [{ id: "m" }], reply: () => ({ pieces: ["ok"], usage: { prompt_tokens: 3, completion_tokens: 1 } }) });
    const pieces = await collect(localEngineBackend(engineAt(fake.url, "mlx"), "m")({ messages: [{ role: "user", content: "x" }] }));
    expect(pieces[0]).toEqual({ delta: "ok" });
    expect(pieces.at(-1)).toMatchObject({ done: true, cSatsSpent: 0, stopReason: "stop", promptTokens: 3, outputTokens: 1 });
  });

  it("a stopped server is a 503 naming the engine", async () => {
    const err = await collect(localEngineBackend(engineAt("http://127.0.0.1:9", "mlx"), "m")({ messages: [{ role: "user", content: "x" }] })).catch((e) => e);
    expect(err).toBeInstanceOf(ChatBackendError);
    expect(err).toMatchObject({ status: 503 });
    expect(err.message).toMatch(/MLX isn't running/);
  });
});
