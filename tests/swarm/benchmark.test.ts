import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activeParamsB,
  answerChallenge,
  checkInferenceOutput,
  cpuTarget,
  estimateTokens,
  expectedCpuSolutions,
  inferencePrompt,
  inferenceSimilarity,
  inferenceTag,
  isCpuSolution,
  knownBandwidthGbps,
  modelWeightsGb,
  runLocalBenchmark,
  solveCpuWork,
  verifyCpuSolutions,
  type CpuWorkSpec,
  type GpuChallenge
} from "../../src/swarm/benchmark.js";
import { fakeModelOutput } from "./helpers/fake-model.js";

describe("CPU proof of work", () => {
  const spec: CpuWorkSpec = { seed: "benchmark-test-seed", workUnits: 160, target: cpuTarget(160, 32) };

  it("is deterministic: the same spec gives the same solutions on any thread count, equal to a plain scan", async () => {
    const one = await solveCpuWork(spec, { threads: 1 });
    const three = await solveCpuWork(spec, { threads: 3 });
    const scan = Array.from({ length: spec.workUnits }, (_, i) => i).filter((i) => isCpuSolution(spec.seed, i, spec.target));
    expect(one.solutions).toEqual(scan);
    expect(three.solutions).toEqual(scan);
    expect(one.processed).toBe(spec.workUnits);
    expect(three.threads).toBe(3);
    expect(scan.length).toBeGreaterThan(10);
  });

  it("a different seed gives a different answer (nothing to precompute)", async () => {
    const a = await solveCpuWork(spec, { threads: 2 });
    const b = await solveCpuWork({ ...spec, seed: "another-seed" }, { threads: 2 });
    expect(a.solutions).not.toEqual(b.solutions);
  });

  it("verifies honest answers and rejects tampered, short, unsorted or out-of-range ones", async () => {
    const { solutions } = await solveCpuWork(spec, { threads: 2 });
    const all = { sample: solutions.length + 5 };
    expect(verifyCpuSolutions(spec, solutions, all)).toEqual({ ok: true });
    const fake = Array.from({ length: spec.workUnits }, (_, i) => i).find((i) => !solutions.includes(i)) as number;
    expect(verifyCpuSolutions(spec, [...solutions, fake].sort((x, y) => x - y), all)).toEqual({ ok: false, reason: "invalid_solution" });
    expect(verifyCpuSolutions(spec, solutions.slice(0, 5), all)).toEqual({ ok: false, reason: "too_few_solutions" });
    expect(verifyCpuSolutions(spec, [...solutions].reverse(), all)).toEqual({ ok: false, reason: "solutions_not_sorted_unique" });
    expect(verifyCpuSolutions(spec, [...solutions, spec.workUnits], all)).toEqual({ ok: false, reason: "solution_out_of_range" });
    expect(verifyCpuSolutions(spec, Array.from({ length: 140 }, (_, i) => i), all)).toEqual({ ok: false, reason: "too_many_solutions" });
    expect(verifyCpuSolutions(spec, undefined)).toEqual({ ok: false, reason: "solutions_missing" });
  });

  it("an answer for one seed does not verify for another (replay)", async () => {
    const { solutions } = await solveCpuWork(spec, { threads: 2 });
    expect(verifyCpuSolutions({ ...spec, seed: "fresh-seed" }, solutions, { sample: solutions.length }).ok).toBe(false);
  });

  it("target gives the expected solution count", () => {
    expect(expectedCpuSolutions({ workUnits: 32_000, target: cpuTarget(32_000, 256) })).toBeCloseTo(256, 0);
  });

  it("local benchmark is time-boxed and reports a CPU rate without Ollama", async () => {
    const r = await runLocalBenchmark({ cpuBudgetMs: 200, threads: 2 });
    expect(r.version).toBe(1);
    expect(r.cpu?.workUnitsPerSec).toBeGreaterThan(0);
    expect(r.cpu?.threads).toBe(2);
    expect(r.cpu?.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(r.gpu).toBeUndefined();
    expect(r.durationMs).toBeLessThan(5_000);
  });

  it("answers a CPU challenge with a verifiable proof", async () => {
    const challenge = { challengeId: "c1", kind: "cpu" as const, ...spec, deadlineMs: 10_000 };
    const res = await answerChallenge(challenge, { threads: 2 });
    expect(res.challengeId).toBe("c1");
    expect(res.declined).toBeUndefined();
    expect(verifyCpuSolutions(spec, res.solutions, { sample: 100 })).toEqual({ ok: true });
  });
});

describe("GPU inference challenge", () => {
  it("tags and prompts derive from the nonce", () => {
    expect(inferenceTag("n1")).toMatch(/^[0-9A-F]{6}$/);
    expect(inferenceTag("n1")).toBe(inferenceTag("n1"));
    expect(inferenceTag("n1")).not.toBe(inferenceTag("n2"));
    expect(inferencePrompt("n1", 24)).toContain(`${inferenceTag("n1")}-1`);
    expect(inferencePrompt("n1", 24)).toContain("exactly 24 numbered lines");
  });

  it("accepts tagged output, rejects untagged or replayed output", () => {
    expect(checkInferenceOutput("n1", 24, fakeModelOutput("n1", 24)).ok).toBe(true);
    expect(checkInferenceOutput("n1", 24, fakeModelOutput("n1", 8)).ok).toBe(false); // fewer than half the lines
    expect(checkInferenceOutput("n1", 24, fakeModelOutput("n2", 24))).toMatchObject({ ok: false, reason: "output_missing_tags" });
    expect(checkInferenceOutput("n1", 24, "")).toMatchObject({ ok: false });
  });

  it("similarity: same model output matches, another model or tags-only text does not", () => {
    const a = fakeModelOutput("n1", 24, "a");
    expect(inferenceSimilarity("n1", a, a)).toBe(1);
    expect(inferenceSimilarity("n1", a, fakeModelOutput("n1", 24, "other-model"))).toBeLessThan(0.15);
    const tagsOnly = Array.from({ length: 24 }, (_, i) => `${i + 1}. ${inferenceTag("n1")}-${i + 1}`).join("\n");
    expect(inferenceSimilarity("n1", a, tagsOnly)).toBe(0);
    // Drift late in the output (different hardware) still matches most of it.
    const drifted = a.split("\n").slice(0, 16).join("\n") + "\n" + fakeModelOutput("n1", 24, "b").split("\n").slice(16).join("\n");
    expect(inferenceSimilarity("n1", a, drifted)).toBeGreaterThan(0.4);
  });

  it("credits tokens from Ollama's count, bounded by the text", () => {
    expect(estimateTokens("x".repeat(300), 50)).toBe(50);
    expect(estimateTokens("x".repeat(300), 10_000)).toBe(100);
    expect(estimateTokens("x".repeat(300))).toBe(75);
  });

  it("model sizes from the catalog use active parameters", () => {
    expect(activeParamsB("9B")).toBe(9);
    expect(activeParamsB("30B (3.3B active)")).toBe(3.3);
    expect(activeParamsB("4B effective")).toBe(4);
    expect(activeParamsB("weird")).toBeUndefined();
    expect(modelWeightsGb("qwen3.5:9b")).toEqual({ weightsGb: 5.4, activeParamsB: 9 });
    expect(modelWeightsGb("not-a-model:1b")).toBeUndefined();
  });

  it("known part bandwidth", () => {
    expect(knownBandwidthGbps("NVIDIA GeForce RTX 4090")).toBe(1008);
    expect(knownBandwidthGbps("NVIDIA GeForce RTX 4060 Ti")).toBe(288);
    expect(knownBandwidthGbps("NVIDIA A100-SXM4-80GB")).toBe(2039);
    expect(knownBandwidthGbps("NVIDIA A100-SXM4-40GB")).toBe(1555);
    expect(knownBandwidthGbps("NVIDIA RTX 6000 Ada Generation")).toBe(960);
    expect(knownBandwidthGbps("Apple M1 Max")).toBe(400);
    expect(knownBandwidthGbps("Apple M4 Pro")).toBe(273);
    expect(knownBandwidthGbps("Apple M2")).toBe(100);
    expect(knownBandwidthGbps("Mystery Accelerator")).toBeUndefined();
  });

  describe("answering through Ollama", () => {
    let server: Server;
    let host = "";
    const generated: unknown[] = [];
    beforeAll(async () => {
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "qwen3.5:9b" }] }));
          if (req.url === "/api/ps") return res.end(JSON.stringify({ models: [{ name: "qwen3.5:9b", size_vram: 6 * 1024 ** 3 }] }));
          if (req.url === "/api/generate") {
            const b = JSON.parse(body) as { prompt: string; options: Record<string, unknown> };
            generated.push(b);
            const tag = /"1\. ([0-9A-F]{6})-1 "/.exec(b.prompt)?.[1] ?? "";
            const lines = Array.from({ length: 24 }, (_, i) => `${i + 1}. ${tag}-${i + 1} a plain sentence about the topic with enough words to count.`).join("\n");
            return res.end(JSON.stringify({ response: lines, eval_count: 400, eval_duration: 2e9 }));
          }
          res.statusCode = 404;
          res.end("{}");
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const challenge = (model: string): GpuChallenge => ({ challengeId: "g1", kind: "gpu", nonce: "abc123", model, lines: 24, numPredict: 512, seed: 42, deadlineMs: 10_000 });

    it("runs the nonce prompt greedily with the coordinator's seed", async () => {
      const res = await answerChallenge(challenge("qwen3.5:9b"), { ollamaHost: host });
      expect(res.declined).toBeUndefined();
      expect(checkInferenceOutput("abc123", 24, res.output).ok).toBe(true);
      expect(res.evalCount).toBe(400);
      expect(res.evalDurationMs).toBe(2000);
      expect(generated.at(-1)).toMatchObject({ options: { temperature: 0, seed: 42, num_predict: 512 } });
    });

    it("declines a model it does not have instead of downloading it", async () => {
      const res = await answerChallenge(challenge("qwen3.5:27b"), { ollamaHost: host });
      expect(res.declined).toBe("model_unavailable");
    });

    it("local benchmark reports tokens/s, bandwidth and the largest loaded model", async () => {
      const r = await runLocalBenchmark({ cpuBudgetMs: 100, threads: 1, ollama: { host, model: "qwen3.5:9b" } });
      expect(r.gpu).toMatchObject({ model: "qwen3.5:9b", evalTokens: 400, tokensPerSec: 200, weightsGb: 5.4, bandwidthGbps: 1080 });
      expect(r.loaded).toEqual({ model: "qwen3.5:9b", vramGb: 6 });
    });
  });
});
