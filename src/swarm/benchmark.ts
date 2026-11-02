// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Hardware throughput benchmark: what the agent runs, and the pure checks the coordinator runs
 * on the answers (src/swarm/hardware-verification.ts decides tiers from them).
 *
 * CPU: memory-hard proof of work. Work unit i is scrypt("edgecoder-bench-v1:" + i, seed) with
 * N=2048, r=8 (2 MiB per hash, so cache- and GPU-unfriendly), striped across every core with
 * worker_threads. A unit is a "solution" when the first 32 bits of its hash are below a target.
 * Scanning [0, workUnits) with a given seed has exactly one answer (the sorted solution indices),
 * so the result is deterministic and checkable: the coordinator recomputes a random sample of the
 * returned solutions (one hash each) and checks the count against the expected workUnits ×
 * target / 2^32, so skipped work shows up as missing solutions and invented ones fail the sample.
 * The seed comes from the coordinator, so nothing can be precomputed or replayed.
 *
 * GPU / Apple GPU: through the local Ollama the agent already runs (no CUDA/Metal code needed and
 * no new dependency). A fixed-seed, temperature-0 generation of a nonce-derived prompt on the
 * agent's model gives tokens/s; tokens/s × the model's weight size is the effective memory
 * bandwidth (decode reads every active weight once per token), which separates hardware classes
 * independently of the model: ~30-70 GB/s on CPUs, 60-400 on Apple silicon, 200-2000+ on GPUs.
 * The output must carry nonce-derived tags (a response to this challenge, not a replay), and
 * because greedy decoding of the same model is near-deterministic, the coordinator can compare
 * it with a second agent running the same model (cross-check). Inference output cannot be
 * checked cheaply on its own; that is why GPU tiers above base need the cross-check by default.
 */
import { createHash, randomInt, scryptSync } from "node:crypto";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { request } from "undici";
import { catalogEntryForTag } from "../model/catalog.js";

/** scrypt cost of one CPU work unit. Changing it changes every tier minimum; bump the prefix with it. */
export const CPU_WORK = { N: 2048, r: 8, p: 1, keylen: 16, prefix: "edgecoder-bench-v1:" } as const;

export type ChallengeMetric = "cpu" | "gpu";

export interface CpuWorkSpec {
  seed: string;
  workUnits: number;
  /** A unit is a solution when readUInt32BE(hash, 0) < target. */
  target: number;
}

export interface CpuChallenge extends CpuWorkSpec {
  challengeId: string;
  kind: "cpu";
  /** Budget in ms from delivery; answers after it are still measured (and demote), not passed. */
  deadlineMs: number;
}

export interface GpuChallenge {
  challengeId: string;
  kind: "gpu";
  nonce: string;
  /** Ollama tag to run (the agent's own model; the agent declines if it is not installed). */
  model: string;
  lines: number;
  numPredict: number;
  seed: number;
  deadlineMs: number;
}

export type BenchmarkChallenge = CpuChallenge | GpuChallenge;

export interface ChallengeResponse {
  challengeId: string;
  kind: ChallengeMetric;
  /** cpu: sorted solution indices. */
  solutions?: number[];
  /** gpu: the generated text and Ollama's own counters. */
  output?: string;
  evalCount?: number;
  evalDurationMs?: number;
  /** Agent wall time from receiving the challenge to answering it. */
  elapsedMs: number;
  /** Set when the agent could not run it (e.g. "model_unavailable"); no measurement. */
  declined?: string;
}

/** What the agent measured locally (self-reported; plausibility evidence only, never a grant). */
export interface AgentBenchmarkReport {
  version: 1;
  ranAtMs: number;
  durationMs: number;
  cpu?: { workUnitsPerSec: number; threads: number; processed: number; elapsedMs: number; digest: string };
  gpu?: { model: string; tokensPerSec: number; evalTokens: number; weightsGb?: number; bandwidthGbps?: number };
  /** Largest model resident in GPU memory per Ollama /api/ps. */
  loaded?: { model: string; vramGb: number };
  errors?: string[];
}

// ── CPU work ──

export function cpuWorkHash(seed: string, index: number): Buffer {
  return scryptSync(`${CPU_WORK.prefix}${index}`, seed, CPU_WORK.keylen, { N: CPU_WORK.N, r: CPU_WORK.r, p: CPU_WORK.p });
}

export function isCpuSolution(seed: string, index: number, target: number): boolean {
  return cpuWorkHash(seed, index).readUInt32BE(0) < target;
}

/** Target giving `expectedSolutions` solutions on average over `workUnits` units. */
export function cpuTarget(workUnits: number, expectedSolutions: number): number {
  return Math.max(1, Math.min(0xffff_ffff, Math.floor((expectedSolutions / Math.max(1, workUnits)) * 2 ** 32)));
}

export function expectedCpuSolutions(spec: Pick<CpuWorkSpec, "workUnits" | "target">): number {
  return (spec.workUnits * spec.target) / 2 ** 32;
}

// Self-contained so it runs as an eval worker both from dist/ and under vitest (no TS loader in workers).
const CPU_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { scryptSync } = require("node:crypto");
const { seed, workUnits, target, start, step, budgetMs, N, r, p, keylen, prefix } = workerData;
const t0 = Date.now();
const solutions = [];
let processed = 0;
for (let i = start; i < workUnits; i += step) {
  if (budgetMs > 0 && (processed & 7) === 0 && Date.now() - t0 > budgetMs) break;
  if (scryptSync(prefix + i, seed, keylen, { N, r, p }).readUInt32BE(0) < target) solutions.push(i);
  processed++;
}
parentPort.postMessage({ solutions, processed });
`;

export interface CpuWorkResult {
  solutions: number[];
  /** Units actually hashed (== workUnits unless a time budget stopped the scan). */
  processed: number;
  elapsedMs: number;
  threads: number;
}

function scanStripe(spec: CpuWorkSpec, start: number, step: number, budgetMs: number): { solutions: number[]; processed: number } {
  const t0 = Date.now();
  const solutions: number[] = [];
  let processed = 0;
  for (let i = start; i < spec.workUnits; i += step) {
    if (budgetMs > 0 && (processed & 7) === 0 && Date.now() - t0 > budgetMs) break;
    if (isCpuSolution(spec.seed, i, spec.target)) solutions.push(i);
    processed++;
  }
  return { solutions, processed };
}

/**
 * Scan [0, workUnits) on `threads` worker threads (unit i on thread i mod threads). Without a time
 * budget the answer depends only on the spec. Falls back to the calling thread if workers fail.
 */
export async function solveCpuWork(spec: CpuWorkSpec, opts: { threads?: number; timeBudgetMs?: number } = {}): Promise<CpuWorkResult> {
  const threads = Math.max(1, Math.min(256, Math.floor(opts.threads ?? availableParallelism())));
  const budgetMs = Math.max(0, opts.timeBudgetMs ?? 0);
  const t0 = Date.now();
  const stripes = await Promise.all(
    Array.from({ length: threads }, (_, k) =>
      new Promise<{ solutions: number[]; processed: number }>((resolve, reject) => {
        const worker = new Worker(CPU_WORKER_SOURCE, {
          eval: true,
          workerData: { ...spec, start: k, step: threads, budgetMs, N: CPU_WORK.N, r: CPU_WORK.r, p: CPU_WORK.p, keylen: CPU_WORK.keylen, prefix: CPU_WORK.prefix }
        });
        worker.once("message", (m) => resolve(m as { solutions: number[]; processed: number }));
        worker.once("error", reject);
      }).catch(() => scanStripe(spec, k, threads, budgetMs))
    )
  );
  return {
    solutions: stripes.flatMap((s) => s.solutions).sort((a, b) => a - b),
    processed: stripes.reduce((n, s) => n + s.processed, 0),
    elapsedMs: Date.now() - t0,
    threads
  };
}

export type CheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Coordinator check of a CPU answer: well-formed, a plausible count (a short count means skipped
 * work: at most ~3.5 sigma below the expectation), and a random sample re-hashed. Cost: `sample`
 * hashes (~4 ms each), independent of the work the agent did.
 */
export function verifyCpuSolutions(
  spec: CpuWorkSpec,
  solutions: unknown,
  opts: { sample?: number; pick?: (n: number) => number } = {}
): CheckResult {
  if (!Array.isArray(solutions)) return { ok: false, reason: "solutions_missing" };
  const expected = expectedCpuSolutions(spec);
  const sd = Math.sqrt(Math.max(1, expected));
  if (solutions.length > expected + 6 * sd + 8) return { ok: false, reason: "too_many_solutions" };
  for (let i = 0; i < solutions.length; i++) {
    const v = solutions[i];
    if (!Number.isInteger(v) || v < 0 || v >= spec.workUnits) return { ok: false, reason: "solution_out_of_range" };
    if (i > 0 && v <= solutions[i - 1]) return { ok: false, reason: "solutions_not_sorted_unique" };
  }
  if (solutions.length < Math.max(expected >= 8 ? 1 : 0, Math.floor(expected - 3.5 * sd))) return { ok: false, reason: "too_few_solutions" };
  const pick = opts.pick ?? ((n: number) => randomInt(n));
  const pool = [...(solutions as number[])];
  const k = Math.min(pool.length, Math.max(1, opts.sample ?? 12));
  for (let i = 0; i < k; i++) {
    const j = pick(pool.length);
    const idx = pool[j];
    pool.splice(j, 1);
    if (!isCpuSolution(spec.seed, idx, spec.target)) return { ok: false, reason: "invalid_solution" };
  }
  return { ok: true };
}

// ── GPU inference challenge ──

const TOPICS = [
  "rivers", "lighthouses", "volcanoes", "bicycles", "glaciers", "libraries", "bridges", "orchards", "comets", "deserts",
  "harbors", "forests", "telescopes", "bakeries", "canals", "meadows", "trains", "islands", "caves", "windmills",
  "coral reefs", "mountains", "markets", "gardens", "satellites", "castles", "beehives", "waterfalls", "museums", "tides",
  "clocks", "ferries", "tea", "maps", "kites", "salt", "violins", "owls", "quarries", "rainforests"
];

function nonceHash(nonce: string): Buffer {
  return createHash("sha256").update(`edgecoder-gpu-bench:${nonce}`).digest();
}

/** Six-hex tag every output line must carry; derived from the nonce so an answer cannot be replayed. */
export function inferenceTag(nonce: string): string {
  return nonceHash(nonce).toString("hex").slice(0, 6).toUpperCase();
}

export function inferencePrompt(nonce: string, lines: number): string {
  const h = nonceHash(nonce);
  const topic = TOPICS[h.readUInt16BE(4) % TOPICS.length];
  const tag = inferenceTag(nonce);
  return (
    `Write exactly ${lines} numbered lines about ${topic}. Start line N with "N. ${tag}-N " ` +
    `(for example "1. ${tag}-1 "), then one plain factual sentence of 12 to 20 words. ` +
    `No introduction, no conclusion, no blank lines.`
  );
}

/** At least half of the requested lines carry their tag. */
export function checkInferenceOutput(nonce: string, lines: number, output: unknown): CheckResult & { tagged?: number } {
  if (typeof output !== "string" || output.length === 0) return { ok: false, reason: "output_missing" };
  const tag = inferenceTag(nonce);
  let tagged = 0;
  for (let n = 1; n <= lines; n++) if (new RegExp(`\\b${tag}-${n}\\b`).test(output)) tagged++;
  return tagged >= Math.ceil(lines / 2) ? { ok: true, tagged } : { ok: false, reason: "output_missing_tags", tagged };
}

/** Tokens the coordinator credits: Ollama's count, bounded by the text (≥ 3 chars per token). */
export function estimateTokens(output: string, reportedEvalCount?: number): number {
  const upper = Math.ceil(output.length / 3);
  return typeof reportedEvalCount === "number" && Number.isFinite(reportedEvalCount) && reportedEvalCount > 0
    ? Math.min(Math.floor(reportedEvalCount), upper)
    : Math.ceil(output.length / 4);
}

function contentWords(nonce: string, text: string): string[] {
  const tag = inferenceTag(nonce);
  return text
    .replace(new RegExp(`${tag}-\\d+`, "g"), " ")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 240);
}

/**
 * Word-bigram Jaccard similarity of two answers to the same challenge, ignoring the tags and
 * numbering (which any script can produce). Same model, same seed, temperature 0: high (outputs
 * may drift apart late on different hardware). Fabricated text or a different model: near 0.
 */
export function inferenceSimilarity(nonce: string, a: string, b: string): number {
  const bigrams = (w: string[]) => new Set(w.slice(1).map((x, i) => `${w[i]} ${x}`));
  const A = bigrams(contentWords(nonce, a));
  const B = bigrams(contentWords(nonce, b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Active parameters in billions from a catalog paramSize ("9B", "30B (3.3B active)", "4B effective"). */
export function activeParamsB(paramSize: string): number | undefined {
  const active = /([\d.]+)\s*B\s+active/i.exec(paramSize);
  const n = Number((active ?? /^\s*([\d.]+)\s*B/i.exec(paramSize))?.[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** GB of weights read per generated token (Q4_K_M ≈ 0.6 bytes per parameter); undefined if not in the catalog. */
export function modelWeightsGb(tag: string): { weightsGb: number; activeParamsB: number } | undefined {
  const entry = catalogEntryForTag(tag);
  const b = entry ? activeParamsB(entry.paramSize) : undefined;
  return b === undefined ? undefined : { weightsGb: Number((b * 0.6).toFixed(2)), activeParamsB: b };
}

/**
 * Peak memory bandwidth (GB/s) of known parts, most specific first. A measurement above the part's
 * peak is not that part (or not a measurement). Unknown parts: undefined.
 */
const KNOWN_BANDWIDTH: Array<[RegExp, number]> = [
  [/\bB200\b/i, 8000], [/\bH200\b/i, 4800], [/\bMI3\d\dX?\b/i, 5300], [/\bH100\b/i, 3350], [/\bH800\b/i, 3350],
  [/\bA100\b.*80/i, 2039], [/\bA100\b/i, 1555], [/\bA800\b/i, 2039], [/\bL40S?\b/i, 864], [/RTX\s*6000\s*Ada/i, 960],
  [/\bA6000\b/i, 768], [/\bA5000\b/i, 768], [/\bA4000\b/i, 448], [/\bL4\b/i, 300], [/\bA10G?\b/i, 600], [/\bV100\b/i, 900],
  [/\b5090\b/, 1792], [/\b5080\b/, 960], [/\b5070\s*Ti\b/i, 896], [/\b5070\b/, 672], [/\b5060\s*Ti\b/i, 448],
  [/\b4090\b/, 1008], [/\b4080\b/, 736], [/\b4070\s*Ti\s*Super\b/i, 672], [/\b4070\b/, 504], [/\b4060\s*Ti\b/i, 288], [/\b4060\b/, 272],
  [/\b3090\b/, 936], [/\b3080\b/, 912], [/\b3070\b/, 448], [/\b3060\s*Ti\b/i, 448], [/\b3060\b/, 360],
  [/\bRX\s*7900\s*XTX\b/i, 960], [/\bRX\s*7900\b/i, 800],
  [/\bM\d\s*Ultra\b/i, 800], [/\bM4\s*Max\b/i, 546], [/\bM\d\s*Max\b/i, 400], [/\bM4\s*Pro\b/i, 273], [/\bM3\s*Pro\b/i, 150],
  [/\bM\d\s*Pro\b/i, 200], [/\bM4\b/i, 120], [/\bM[23]\b/i, 100], [/\bM1\b/i, 68]
];
/** Fastest part anything could be (used when the claimed part is unknown). */
export const MAX_KNOWN_BANDWIDTH_GBPS = 8000;

export function knownBandwidthGbps(model: string | undefined): number | undefined {
  if (!model) return undefined;
  return KNOWN_BANDWIDTH.find(([re]) => re.test(model))?.[1];
}

// ── Ollama (agent side) ──

function ollamaBase(host?: string): string {
  if (!host) return "http://127.0.0.1:11434";
  return host.startsWith("http") ? host.replace(/\/$/, "") : `http://${host}`;
}

export interface OllamaGeneration {
  response: string;
  evalCount?: number;
  evalDurationMs?: number;
}

export async function ollamaGenerate(input: { host?: string; model: string; prompt: string; seed: number; numPredict: number; timeoutMs: number }): Promise<OllamaGeneration> {
  const res = await request(`${ollamaBase(input.host)}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    headersTimeout: input.timeoutMs,
    bodyTimeout: input.timeoutMs,
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      stream: false,
      think: false,
      options: { temperature: 0, top_k: 1, seed: input.seed, num_predict: input.numPredict }
    })
  });
  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`ollama_generate_${res.statusCode}`);
  const body = JSON.parse(text) as { response?: string; eval_count?: number; eval_duration?: number };
  return {
    response: String(body.response ?? ""),
    evalCount: typeof body.eval_count === "number" ? body.eval_count : undefined,
    evalDurationMs: typeof body.eval_duration === "number" ? body.eval_duration / 1e6 : undefined
  };
}

/** Models resident in memory per Ollama /api/ps, largest VRAM share first. */
export async function ollamaLoaded(host?: string, timeoutMs = 3_000): Promise<Array<{ model: string; vramGb: number }>> {
  const res = await request(`${ollamaBase(host)}/api/ps`, { method: "GET", headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) return [];
  const body = JSON.parse(text) as { models?: Array<{ name?: string; model?: string; size_vram?: number }> };
  return (body.models ?? [])
    .map((m) => ({ model: String(m.name ?? m.model ?? ""), vramGb: Number(((m.size_vram ?? 0) / 1024 ** 3).toFixed(2)) }))
    .filter((m) => m.model)
    .sort((a, b) => b.vramGb - a.vramGb);
}

async function ollamaHasModel(host: string | undefined, model: string): Promise<boolean> {
  try {
    const res = await request(`${ollamaBase(host)}/api/tags`, { method: "GET", headersTimeout: 3_000, bodyTimeout: 3_000 });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) return false;
    const body = JSON.parse(text) as { models?: Array<{ name?: string; model?: string }> };
    const want = model.includes(":") ? model : `${model}:latest`;
    return (body.models ?? []).some((m) => m.name === model || m.model === model || m.name === want || m.model === want);
  } catch {
    return false;
  }
}

// ── Agent entry points ──

export const LOCAL_BENCH_SEED = "edgecoder-local-benchmark-v1";

/**
 * The agent's periodic self-benchmark (< ~30 s): a time-boxed CPU scan on every core, then (when an
 * Ollama model is configured) a short fixed-seed generation and the largest model in VRAM.
 */
export async function runLocalBenchmark(opts: { cpuBudgetMs?: number; threads?: number; ollama?: { host?: string; model: string; timeoutMs?: number } }): Promise<AgentBenchmarkReport> {
  const t0 = Date.now();
  const errors: string[] = [];
  const report: AgentBenchmarkReport = { version: 1, ranAtMs: t0, durationMs: 0 };
  try {
    const spec: CpuWorkSpec = { seed: LOCAL_BENCH_SEED, workUnits: 10_000_000, target: cpuTarget(10_000, 1) };
    const r = await solveCpuWork(spec, { threads: opts.threads, timeBudgetMs: opts.cpuBudgetMs ?? 4_000 });
    report.cpu = {
      workUnitsPerSec: Math.round((r.processed / Math.max(1, r.elapsedMs)) * 1000),
      threads: r.threads,
      processed: r.processed,
      elapsedMs: r.elapsedMs,
      digest: createHash("sha256").update(`${spec.seed}:${r.processed}:${r.solutions.join(",")}`).digest("hex").slice(0, 16)
    };
  } catch (e) {
    errors.push(`cpu:${String(e).slice(0, 80)}`);
  }
  if (opts.ollama?.model) {
    const { host, model } = opts.ollama;
    try {
      const gen = await ollamaGenerate({ host, model, prompt: inferencePrompt(LOCAL_BENCH_SEED, 12), seed: 7, numPredict: 192, timeoutMs: opts.ollama.timeoutMs ?? 20_000 });
      const tokens = estimateTokens(gen.response, gen.evalCount);
      const tps = gen.evalDurationMs && gen.evalDurationMs > 0 ? (tokens / gen.evalDurationMs) * 1000 : 0;
      const size = modelWeightsGb(model);
      report.gpu = {
        model,
        tokensPerSec: Number(tps.toFixed(1)),
        evalTokens: tokens,
        ...(size ? { weightsGb: size.weightsGb, bandwidthGbps: Number((tps * size.weightsGb).toFixed(1)) } : {})
      };
    } catch (e) {
      errors.push(`gpu:${String(e).slice(0, 80)}`);
    }
    try {
      const loaded = (await ollamaLoaded(host))[0];
      if (loaded) report.loaded = loaded;
    } catch {
      // Ollama without /api/ps: nothing to report
    }
  }
  report.durationMs = Date.now() - t0;
  if (errors.length) report.errors = errors;
  return report;
}

/** Answer a coordinator challenge. Never throws: failures come back as `declined`. */
export async function answerChallenge(challenge: BenchmarkChallenge, ctx: { ollamaHost?: string; threads?: number }): Promise<ChallengeResponse> {
  const t0 = Date.now();
  const base = { challengeId: challenge.challengeId, kind: challenge.kind };
  try {
    if (challenge.kind === "cpu") {
      const r = await solveCpuWork(challenge, { threads: ctx.threads });
      return { ...base, solutions: r.solutions, elapsedMs: Date.now() - t0 };
    }
    if (!(await ollamaHasModel(ctx.ollamaHost, challenge.model))) return { ...base, elapsedMs: Date.now() - t0, declined: "model_unavailable" };
    const gen = await ollamaGenerate({
      host: ctx.ollamaHost,
      model: challenge.model,
      prompt: inferencePrompt(challenge.nonce, challenge.lines),
      seed: challenge.seed,
      numPredict: challenge.numPredict,
      // Answer even when slow: a late answer is still a measurement (it demotes instead of passing).
      timeoutMs: Math.min(5 * 60_000, Math.max(30_000, challenge.deadlineMs * 3))
    });
    return { ...base, output: gen.response.slice(0, 16_000), evalCount: gen.evalCount, evalDurationMs: gen.evalDurationMs, elapsedMs: Date.now() - t0 };
  } catch (e) {
    return { ...base, elapsedMs: Date.now() - t0, declined: `error:${String(e).slice(0, 80)}` };
  }
}
