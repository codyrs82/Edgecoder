import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_TOO_LONG_ERROR, runInferenceSubtask } from "../../src/swarm/inference-runner.js";
import { openAiEngineChat, type OpenAiEngine } from "../../src/inference-api/openai-engine.js";
import { answerChallenge, runLocalBenchmark, type GpuChallenge } from "../../src/swarm/benchmark.js";
import { classifyHardware, type HardwareProfile } from "../../src/economy/compute-classes.js";
import { DEFAULT_HARDWARE_VERIFICATION, HardwareVerifier } from "../../src/swarm/hardware-verification.js";
import { OpenAiEngineProvider } from "../../src/model/providers.js";
import type { Subtask } from "../../src/common/types.js";
import { startFakeEngine, type FakeEngine } from "../helpers/fake-openai-engine.js";
import { fakeModelOutput } from "./helpers/fake-model.js";

/*
 * A network model call, a code-task generation and the GPU challenge on vLLM / MLX, end to end
 * against a fake engine: the coordinator sees the catalog tag, the same pieces and the same checks.
 */

let fake: FakeEngine | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const AWQ = "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ";
const TAG = "qwen3-coder:30b";

function subtask(input: unknown, model = TAG): Subtask {
  return {
    id: "s1", taskId: "t1", kind: "inference", language: "python", timeoutMs: 30_000, snapshotRef: "inference",
    requestedModel: model, input: JSON.stringify(input), projectMeta: { projectId: "inference", resourceClass: "gpu", priority: 50 }
  } as unknown as Subtask;
}

/** The worker's deps.chat: the requested catalog tag runs on the served id. */
const chatVia = (engine: OpenAiEngine, served: Record<string, string>) => (model: string, req: Parameters<NonNullable<Parameters<typeof runInferenceSubtask>[1]["chat"]>>[1], signal: AbortSignal, timeoutMs: number) => {
  const id = served[model];
  if (!id) throw new Error(`model_unavailable: ${model}`);
  return openAiEngineChat(engine, { model: id, ...req }, signal, timeoutMs);
};

describe("network inference on vLLM", () => {
  it("streams the pieces to the coordinator, sends tool calls and token counts with the last one", async () => {
    fake = await startFakeEngine({
      flavor: "vllm",
      models: [{ id: AWQ, maxModelLen: 65_536 }],
      reply: () => ({ pieces: ["Let me ", "look."], toolCalls: [{ name: "read_file", arguments: { path: "a.ts" } }], usage: { prompt_tokens: 20, completion_tokens: 9 } })
    });
    const engine: OpenAiEngine = { preset: "vllm", url: fake.url };
    const posted: any[] = [];
    const r = await runInferenceSubtask(subtask({ messages: [{ role: "user", content: "read a.ts" }], tools: [{ type: "function", function: { name: "read_file" } }], maxTokens: 256 }), {
      agentId: "a1", ollamaHost: "http://127.0.0.1:9", contextWindow: 65_536, post: async (_p, b) => { posted.push(b); return {}; }, chat: chatVia(engine, { [TAG]: AWQ })
    });
    expect(r).toMatchObject({ ok: true, output: "Let me look." });
    expect(fake.requests.at(-1)?.body).toMatchObject({ model: AWQ, max_tokens: 256 });
    const last = posted.at(-1);
    expect(last).toMatchObject({ done: true, toolCalls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }], promptTokens: 20, outputTokens: 9 });
    expect(typeof last.genMs).toBe("number");
  });

  it("vLLM's own context check maps to context_too_long, with nothing sent (the coordinator retries elsewhere)", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: AWQ, maxModelLen: 8192 }], maxPromptChars: 200, reply: () => ({ pieces: ["x"] }) });
    const posted: unknown[] = [];
    const r = await runInferenceSubtask(subtask({ messages: [{ role: "user", content: "z".repeat(1_000) }] }), {
      agentId: "a1", ollamaHost: "", post: async (_p, b) => { posted.push(b); return {}; }, chat: chatVia({ preset: "vllm", url: fake.url }, { [TAG]: AWQ })
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(new RegExp(`^${CONTEXT_TOO_LONG_ERROR}: vLLM: This model's maximum context length`));
    expect(posted).toEqual([]);
  });

  it("a model the engine does not serve fails the call without running anything", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: AWQ }], reply: () => ({ pieces: ["x"] }) });
    const r = await runInferenceSubtask(subtask({ messages: [{ role: "user", content: "hi" }] }, "qwen2.5-coder:7b"), {
      agentId: "a1", ollamaHost: "", post: async () => ({}), chat: chatVia({ preset: "vllm", url: fake.url }, { [TAG]: AWQ })
    });
    expect(r).toMatchObject({ ok: false, error: "model_unavailable: qwen2.5-coder:7b" });
    expect(fake.requests).toEqual([]);
  });

  it("an empty reply is empty_reply (retried elsewhere), as on Ollama", async () => {
    fake = await startFakeEngine({ flavor: "mlx", models: [{ id: "m" }], reply: () => ({ pieces: [] }) });
    const r = await runInferenceSubtask(subtask({ messages: [{ role: "user", content: "hi" }] }), { agentId: "a1", ollamaHost: "", post: async () => ({}), chat: chatVia({ preset: "mlx", url: fake.url }, { [TAG]: "m" }) });
    expect(r).toMatchObject({ ok: false, error: "empty_reply" });
  });
});

describe("code tasks on the engine (OpenAiEngineProvider)", () => {
  it("generates with the served model, as the ollama-local provider", async () => {
    fake = await startFakeEngine({ flavor: "vllm", models: [{ id: AWQ }], reply: () => ({ pieces: ["print(1)"] }) });
    const p = new OpenAiEngineProvider({ preset: "vllm", url: fake.url }, () => AWQ);
    expect(p.kind).toBe("ollama-local");
    expect(await p.generate({ prompt: "write it" })).toEqual({ text: "print(1)", provider: "ollama-local" });
    expect(await p.health()).toBe(true);
    await expect(new OpenAiEngineProvider({ preset: "vllm", url: fake.url }, () => undefined).generate({ prompt: "x" })).rejects.toThrow(/no model served/);
  });
});

/** A fake engine that answers the GPU challenge like a greedy model: the nonce-tagged lines, in pieces. */
async function challengeEngine(flavor: "vllm" | "mlx", id: string, pieceDelayMs = 1) {
  return startFakeEngine({
    flavor,
    models: [{ id, maxModelLen: 65_536 }],
    reply: (body) => {
      const prompt: string = body.messages[0].content;
      const tag = /"1\. ([0-9A-F]{6})-1 "/.exec(prompt)?.[1];
      if (!tag) return { pieces: ["OK"], usage: { prompt_tokens: 5, completion_tokens: 1 } };
      // Recover the nonce-specific text the helper would give for this challenge: the test passes the nonce in the seed's place.
      const lines = Number(/Write exactly (\d+) numbered lines/.exec(prompt)?.[1] ?? 12);
      const out = fakeModelOutput(String(body.seed), lines).replace(/[0-9A-F]{6}-/g, `${tag}-`);
      const pieces = out.match(/.{1,6}/gs) ?? [];
      return { pieces, pieceDelayMs, usage: { prompt_tokens: 60, completion_tokens: 512 } };
    }
  });
}

describe("GPU benchmark and challenge through the engine", () => {
  const A16x2: HardwareProfile = { cpuCores: 12, ramGb: 120, platform: "linux", arch: "x64", cpuModel: "Intel Xeon (Cascadelake)", gpu: { vendor: "nvidia", model: "NVIDIA A16", vramGb: 30, datacenter: true, count: 2 } };

  it("self-benchmark reports the catalog tag, tokens/s and bandwidth (no Ollama involved)", async () => {
    fake = await challengeEngine("vllm", AWQ);
    const r = await runLocalBenchmark({ cpuBudgetMs: 50, threads: 1, engine: { engine: { preset: "vllm", url: fake.url }, model: AWQ, tag: TAG } });
    expect(r.errors).toBeUndefined();
    expect(r.gpu).toMatchObject({ model: TAG, weightsGb: 1.98 });
    expect(r.gpu!.tokensPerSec).toBeGreaterThan(0);
    expect(r.loaded).toBeUndefined();
    // Warm-up first, then the timed run.
    expect(fake.requests.filter((q) => q.path === "/v1/chat/completions").map((q) => q.body.max_tokens)).toEqual([4, 192]);
  });

  it("a gpu.dc40 challenge on vLLM passes the coordinator's checks; the agent's own fast timer cannot beat the server clock", async () => {
    fake = await challengeEngine("vllm", AWQ);
    const engine: OpenAiEngine = { preset: "vllm", url: fake.url };
    const T0 = 1_800_000_000_000;
    const claimed = classifyHardware(A16x2);
    const run = async (submitAfterMs: number) => {
      const v = new HardwareVerifier({ config: DEFAULT_HARDWARE_VERIFICATION, random: { id: () => "ch-1" } });
      v.register({ agentId: "a16", claimed, profile: A16x2, challengeKinds: ["cpu", "gpu"], nowMs: T0 });
      const c = v.nextChallenge("a16", { nowMs: T0, model: TAG }) as GpuChallenge;
      expect(c).toMatchObject({ kind: "gpu", model: TAG });
      // The fake keys its text on the seed: give it the nonce through the seed.
      const answer = await answerChallenge({ ...c, seed: c.nonce as unknown as number }, { engine: { engine, servedModelFor: (t) => (t === TAG ? AWQ : undefined) } });
      expect(answer.declined).toBeUndefined();
      expect(answer.evalCount).toBe(512);
      expect(answer.evalDurationMs).toBeGreaterThan(0);
      return { v, res: v.submit("a16", { ...answer, challengeId: c.challengeId }, T0 + submitAfterMs) };
    };
    // Answered 11.5 s after delivery (~95 GB/s, a warm 2x A16): verified at gpu.dc40.
    const ok = await run(11_500);
    expect(ok.res.invalid).toBeUndefined();
    expect(ok.v.get("a16")).toMatchObject({ status: "verified", granted: { computeClass: "gpu.dc", tier: "gpu.dc40" } });
    // The same answer 0.5 s after delivery is faster than two A16s can be: invalid, whatever the agent's timer says.
    const fast = await run(500);
    expect(fast.res.invalid).toBe("faster_than_hardware");
  });

  it("declines a challenge for a model the engine does not serve", async () => {
    fake = await challengeEngine("vllm", AWQ);
    const a = await answerChallenge({ challengeId: "c", kind: "gpu", nonce: "n", model: "gpt-oss:20b", lines: 12, numPredict: 512, seed: 1, deadlineMs: 30_000 }, { engine: { engine: { preset: "vllm", url: fake.url }, servedModelFor: () => undefined } });
    expect(a.declined).toBe("model_unavailable");
    expect(fake.requests).toEqual([]);
  });

  it("apple.m through MLX: a MacBook's challenge on mlx_lm.server verifies", async () => {
    const MLX7B = "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit";
    fake = await challengeEngine("mlx", MLX7B);
    const mac: HardwareProfile = { cpuCores: 10, ramGb: 16, platform: "darwin", arch: "arm64", cpuModel: "Apple M2", gpu: { vendor: "apple", model: "Apple M2", vramGb: 16 } };
    const claimed = classifyHardware(mac);
    expect(claimed).toMatchObject({ computeClass: "apple", tier: "apple.m" });
    const T0 = 1_800_000_000_000;
    const v = new HardwareVerifier({ config: DEFAULT_HARDWARE_VERIFICATION, random: { id: () => "ch-1" } });
    v.register({ agentId: "mac", claimed, profile: mac, challengeKinds: ["cpu", "gpu"], nowMs: T0 });
    const c = v.nextChallenge("mac", { nowMs: T0, model: "qwen2.5-coder:7b" }) as GpuChallenge;
    expect(c?.kind).toBe("gpu");
    const answer = await answerChallenge({ ...c, seed: c.nonce as unknown as number }, { engine: { engine: { preset: "mlx", url: fake.url }, servedModelFor: (t) => (t === "qwen2.5-coder:7b" ? MLX7B : undefined) } });
    // 512 tokens × 4.2 GB in ~25 s ≈ 86 GB/s: within an M2's 100 GB/s, above apple.m's floor.
    const res = v.submit("mac", { ...answer, challengeId: c.challengeId }, T0 + 25_000);
    expect(res.invalid).toBeUndefined();
    expect(v.get("mac")).toMatchObject({ status: "verified", granted: { computeClass: "apple", tier: "apple.m" } });
  });
});
