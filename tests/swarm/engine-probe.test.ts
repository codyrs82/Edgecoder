import { afterEach, describe, expect, it } from "vitest";
import { engineServing, probeEngine } from "../../src/swarm/engine-probe.js";
import { startFakeEngine, type FakeEngine } from "../helpers/fake-openai-engine.js";

/*
 * What an agent on vLLM / MLX reports: the served model as its catalog tag, the context window,
 * and its slots (N > 1 on one agent for vLLM), or a clear problem when the engine is not serving.
 */

let fake: FakeEngine | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});
const GB = 1024 ** 3;
const AWQ = "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ";

describe("probeEngine", () => {
  it("vLLM up: the served model as its catalog tag, max_model_len, KV-cache size", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: AWQ, maxModelLen: 65_536 }], kvBlocks: 5_440, reply: () => ({}) });
    const s = await probeEngine({ preset: "vllm", url: fake.url });
    expect(s).toMatchObject({ ok: true, model: { id: AWQ, tag: "qwen3-coder:30b", maxModelLen: 65_536 }, kvCacheTokens: 87_040 });
  });

  it("not reachable: says where and what to do", async () => {
    const s = await probeEngine({ preset: "vllm", url: "http://127.0.0.1:9" }, new Map(), 500);
    expect(s.ok).toBe(false);
    expect(s.problem).toMatch(/vLLM is not reachable at http:\/\/127\.0\.0\.1:9.*docs\/inference-engines\.md/);
  });

  it("serving another model than VLLM_MODEL, or a non-catalog model: not ok, with the fix", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: "my-org/coder-ft", maxModelLen: 32_768 }], reply: () => ({}) });
    expect((await probeEngine({ preset: "vllm", url: fake.url, model: AWQ })).problem).toMatch(/serves my-org\/coder-ft, not the configured VLLM_MODEL=/);
    expect((await probeEngine({ preset: "vllm", url: fake.url })).problem).toMatch(/none of them a catalog model; set ENGINE_MODEL_ALIASES/);
    expect(await probeEngine({ preset: "vllm", url: fake.url }, new Map([["my-org/coder-ft", "qwen3-coder:30b"]]))).toMatchObject({ ok: true, model: { tag: "qwen3-coder:30b" } });
  });

  it("MLX lists every cached model: MLX_MODEL picks the loaded one", async () => {
    fake = await startFakeEngine({ flavor: "mlx", models: [{ id: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit" }, { id: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit" }], reply: () => ({}) });
    expect(await probeEngine({ preset: "mlx", url: fake.url, model: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit" })).toMatchObject({ ok: true, model: { tag: "qwen3-coder:30b" } });
    const s = await probeEngine({ preset: "mlx", url: fake.url });
    expect(s).toMatchObject({ ok: true, model: { tag: "qwen2.5-coder:7b" } });
    expect(s.kvCacheTokens).toBeUndefined();
  });

  it("an engine still loading (no models yet) is not ok", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [], reply: () => ({}) });
    expect((await probeEngine({ preset: "vllm", url: fake.url })).problem).toMatch(/serves no model yet/);
  });
});

describe("engineServing: context window and slots", () => {
  const vllm = (maxModelLen: number, kvCacheTokens?: number) => ({ model: { id: AWQ, tag: "qwen3-coder:30b", maxModelLen }, ...(kvCacheTokens ? { kvCacheTokens } : {}) });

  it("vLLM: the window is max_model_len; slots from the KV cache (each call half the window)", () => {
    // 2x A16, AWQ, fp16 KV: ~87k tokens of cache.
    expect(engineServing({ preset: "vllm", status: vllm(65_536, 87_040), totalMemBytes: 117 * GB })).toEqual({ contextWindow: 65_536, slots: 2 });
    expect(engineServing({ preset: "vllm", status: vllm(32_768, 87_040), totalMemBytes: 117 * GB })).toEqual({ contextWindow: 32_768, slots: 5 });
    // A100 80 GB, FP8 weights: ~430k tokens: capped at 16 slots.
    expect(engineServing({ preset: "vllm", status: vllm(65_536, 430_000), totalMemBytes: 117 * GB })).toEqual({ contextWindow: 65_536, slots: 13 });
    expect(engineServing({ preset: "vllm", status: vllm(32_768, 800_000), totalMemBytes: 117 * GB }).slots).toBe(16);
    // KV cache unknown (metrics off): 1.
    expect(engineServing({ preset: "vllm", status: vllm(65_536), totalMemBytes: 117 * GB }).slots).toBe(1);
  });

  it("VLLM_MAX_SLOTS, then AGENT_PARALLEL_INFERENCE, override the derivation", () => {
    expect(engineServing({ preset: "vllm", status: vllm(65_536, 87_040), maxSlots: 4, parallelOverride: "8", totalMemBytes: 117 * GB }).slots).toBe(4);
    expect(engineServing({ preset: "vllm", status: vllm(65_536, 87_040), parallelOverride: "8", totalMemBytes: 117 * GB }).slots).toBe(8);
    expect(engineServing({ preset: "vllm", status: vllm(65_536, 87_040), parallelOverride: "99", totalMemBytes: 117 * GB }).slots).toBe(2);
  });

  it("AGENT_CONTEXT_WINDOW can lower vLLM's window, never raise it past max_model_len", () => {
    expect(engineServing({ preset: "vllm", status: vllm(65_536), contextOverride: 32_768, totalMemBytes: 117 * GB }).contextWindow).toBe(32_768);
    expect(engineServing({ preset: "vllm", status: vllm(32_768), contextOverride: 65_536, totalMemBytes: 117 * GB }).contextWindow).toBe(32_768);
    expect(engineServing({ preset: "vllm", status: vllm(262_144), totalMemBytes: 117 * GB }).contextWindow).toBe(131_072);
  });

  it("MLX: 1 slot by default; the window from AGENT_CONTEXT_WINDOW or the memory estimate", () => {
    const mlx = { model: { id: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit", tag: "qwen3-coder:30b" } };
    expect(engineServing({ preset: "mlx", status: mlx, contextOverride: 32_768, totalMemBytes: 32 * GB })).toEqual({ contextWindow: 32_768, slots: 1 });
    expect(engineServing({ preset: "mlx", status: mlx, maxSlots: 2, totalMemBytes: 32 * GB }).slots).toBe(2);
    const est = engineServing({ preset: "mlx", status: { model: { id: "x", tag: "qwen2.5-coder:7b" } }, totalMemBytes: 16 * GB });
    expect(est.slots).toBe(1);
    expect([8192, 16_384, 32_768]).toContain(est.contextWindow);
  });
});
