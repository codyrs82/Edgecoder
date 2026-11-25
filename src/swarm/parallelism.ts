// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Model calls a machine runs at once (and the OLLAMA_NUM_PARALLEL its Ollama is started with:
 * src/install/services.ts, the desktop app's local_compute.rs). Serving several requests together
 * raises tokens per second and, more to the point for a requester, a second request starts at once
 * instead of waiting behind the first.
 *
 * Without the model: by memory, 4 with 32 GB or more, 2 with 16 GB, else 1 (what the desktop app
 * starts Ollama with). With the model (its size from the tag, e.g. "qwen2.5-coder:1.5b"): as many
 * slots as fit next to the model in the usable memory, at most 2 below 31 GB and 4 above:
 *   usable   = memory × 0.6 (RAM: the OS and the agent need the rest) or × 0.9 (a GPU's VRAM)
 *   model    = params(B) × 0.6 GB (4-bit weights) + 0.5 GB (runtime)
 *   per slot = max(0.25 GB, params(B) × 0.12 GB): the KV cache of an 8k-token context
 *   slots    = clamp(floor((usable − model) / per slot), 1, cap)
 * So a 4 GB CPU agent with a 1.5B model runs 2 calls; 8 GB with a 7B model, 1.
 *
 * A host that runs the model on its CPU (no GPU at all) also gets at most one slot per
 * CPUS_PER_CPU_SLOT logical CPUs (cpuSlotCap), when its CPU count is given: a 2-CPU host runs 1 call.
 *
 * AGENT_PARALLEL_INFERENCE (1-16) overrides. When OLLAMA_NUM_PARALLEL is set (the same machine's
 * Ollama), the computed default never exceeds it: a call past Ollama's slots queues inside Ollama.
 */
export function parallelInferenceFor(
  totalMemBytes: number,
  override?: string,
  opts: { modelParamsB?: number; gpu?: boolean; ollamaNumParallel?: string; cpuOnly?: boolean; cpuCount?: number } = {}
): number {
  const n = Number(override);
  if (Number.isInteger(n) && n >= 1 && n <= 16) return n;
  const gb = totalMemBytes / 1024 ** 3;
  let slots: number;
  const b = opts.modelParamsB;
  if (b !== undefined && Number.isFinite(b) && b > 0) {
    const usable = gb * (opts.gpu ? 0.9 : 0.6);
    const modelGb = b * 0.6 + 0.5;
    const perSlotGb = Math.max(0.25, b * 0.12);
    const cap = gb >= 31 ? 4 : 2;
    slots = Math.max(1, Math.min(cap, Math.floor((usable - modelGb) / perSlotGb)));
  } else {
    slots = gb >= 31 ? 4 : gb >= 15 ? 2 : 1;
  }
  if (opts.cpuOnly && !opts.gpu) slots = Math.min(slots, cpuSlotCap(opts.cpuCount));
  const ollama = Number(opts.ollamaNumParallel);
  if (Number.isInteger(ollama) && ollama >= 1) slots = Math.min(slots, ollama);
  return slots;
}

/**
 * Network run 10: logical CPUs each parallel model call needs on a host that runs the model on its
 * CPU. llama.cpp (Ollama) spreads one call over every core, so two calls on a 2-CPU host do not add
 * throughput: each runs at about half speed (the coordinator's own estimate, best-fit.ts
 * CONTENTION_SHARE.cpu, assumes exactly that). In run 10 the Fly performance-2x hosts (2 dedicated
 * CPUs) ran two 1.5B calls side by side for 44-127 s each, where one alone takes a few seconds; the
 * coordinator took calls back as their first piece was overdue, and the hosts sat with both slots
 * busy on calls they no longer held. One slot per two CPUs keeps a call at full speed, and the host
 * is either free (and pulling) or busy, never "one free" while it cannot start anything quickly.
 */
export const CPUS_PER_CPU_SLOT = 2;

/** Most parallel model calls a CPU-only host with `cpuCount` logical CPUs runs by default; no cap when unknown. */
export function cpuSlotCap(cpuCount: number | undefined): number {
  if (cpuCount === undefined || !Number.isFinite(cpuCount) || cpuCount <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(cpuCount / CPUS_PER_CPU_SLOT));
}

/** Context windows an agent may serve with (tokens). */
export const CONTEXT_WINDOWS = [8192, 16384, 32768] as const;

/**
 * The one context window (num_ctx) an agent serves every network call with. Ollama reloads a model
 * whose num_ctx changes (seconds on a CPU, and a 32k load of a 7B model took 12 GB), so the agent
 * loads its model once with this window and only takes calls that fit it (it advertises the window
 * with each pull; the coordinator routes longer calls to agents with a bigger one).
 *
 * Default: the largest of 8k / 16k / 32k whose KV cache for every parallel slot fits next to the
 * model in usable memory (same estimates as parallelInferenceFor: usable = 60% of RAM or 90% of
 * VRAM, model = params x 0.6 + 0.5 GB, KV = max(0.25, params x 0.12) GB per slot per 8k tokens);
 * 8k when the model is unknown. A 4 GB CPU agent with a 1.5B model and 2 slots: 8k; 16 GB with a
 * 7B model and 2 slots: 16k; 32 GB with a 7B model and 4 slots: 32k.
 * AGENT_CONTEXT_WINDOW (2048-131072) overrides. This is the CPU / unified-memory sizing: a host with
 * a discrete GPU sizes from its VRAM instead (defaultServing below).
 */
export function servedContextWindow(
  totalMemBytes: number,
  override: number | undefined,
  opts: { modelParamsB?: number; gpu?: boolean; slots: number }
): number {
  if (override !== undefined && Number.isInteger(override) && override >= 2048 && override <= 131_072) return override;
  const b = opts.modelParamsB;
  if (b === undefined || !Number.isFinite(b) || b <= 0) return CONTEXT_WINDOWS[0];
  const usable = (totalMemBytes / 1024 ** 3) * (opts.gpu ? 0.9 : 0.6);
  const modelGb = b * 0.6 + 0.5;
  const kvPer8k = Math.max(0.25, b * 0.12);
  for (const ctx of [...CONTEXT_WINDOWS].reverse()) {
    if (modelGb + Math.max(1, opts.slots) * kvPer8k * (ctx / 8192) < usable) return ctx;
  }
  return CONTEXT_WINDOWS[0];
}

/** Largest window a GPU host sizes itself to by default (an explicit AGENT_CONTEXT_WINDOW may go higher). */
export const GPU_CONTEXT_CEILING = 65_536;
/** The window agentic calls need (a 7-19k prompt and a 4k reply): a GPU host gives up slots to reach it. */
export const AGENTIC_CONTEXT_WINDOW = 32_768;
const GIB = 1024 ** 3;
/** Runtime (compute graph, buffers) next to the weights, as memory-budget.ts RUNTIME_OVERHEAD_BYTES. */
const RUNTIME_BYTES = 0.5 * GIB;
/** Each GPU a model is split over keeps its own compute buffers. */
const PER_GPU_BYTES = 0.5 * GIB;
const GPU_WINDOWS = [65_536, 32_768, 16_384, 8_192] as const;

/**
 * The window (and slots) a host with a discrete GPU serves its model with: what the KV cache can
 * use of the VRAM once the weights are in.
 *
 *   free     = VRAM x 0.9 (the memory budget) - weights - 0.5 GB runtime - 0.5 GB per GPU
 *   window   = the largest of 64k / 32k / 16k / 8k, never past the model's own context length,
 *              whose KV cache for every slot fits in `free` (KV slots: at least OLLAMA_NUM_PARALLEL)
 *
 * Below 32k with more than one slot, the slots come down (unless fixed by AGENT_PARALLEL_INFERENCE)
 * when that reaches 32k: one call that holds an agentic prompt beats several that do not (and when
 * not even 8k fits every slot, as many slots as fit at 8k). Undefined when the model does not fit
 * the VRAM even at 8k with one slot (the caller then sizes by RAM).
 */
export function gpuContextWindow(opts: {
  vramBytes: number;
  gpuCount?: number;
  weightsBytes: number;
  kvBytesPer8k: number;
  nativeContext?: number;
  slots: number;
  slotsFixed?: boolean;
  /** Ollama's OLLAMA_NUM_PARALLEL: it allocates the KV cache for this many slots whatever the agent runs. */
  kvSlotsFloor?: number;
}): { contextWindow: number; slots: number } | undefined {
  if (!(opts.vramBytes > 0) || !(opts.weightsBytes > 0) || !(opts.kvBytesPer8k > 0)) return undefined;
  const free = opts.vramBytes * 0.9 - opts.weightsBytes - RUNTIME_BYTES - PER_GPU_BYTES * Math.max(1, Math.floor(opts.gpuCount ?? 1));
  const cap = Math.min(GPU_CONTEXT_CEILING, opts.nativeContext && opts.nativeContext >= 2048 ? opts.nativeContext : GPU_CONTEXT_CEILING);
  const windows: number[] = GPU_WINDOWS.filter((w) => w <= cap);
  if (windows.length === 0) windows.push(cap);
  const kvSlots = (s: number) => Math.max(s, opts.kvSlotsFloor ?? 0);
  const best = (s: number) => windows.find((w) => kvSlots(s) * opts.kvBytesPer8k * (w / 8192) <= free);
  const slots = Math.max(1, Math.floor(opts.slots));
  const want = best(slots);
  const agentic = Math.min(AGENTIC_CONTEXT_WINDOW, cap);
  if (opts.slotsFixed || (want !== undefined && want >= agentic)) return want === undefined ? undefined : { contextWindow: want, slots };
  for (let s = slots - 1; s >= 1; s--) {
    const w = best(s);
    if (w !== undefined && w >= agentic) return { contextWindow: w, slots: s };
  }
  if (want !== undefined) return { contextWindow: want, slots };
  // Not even 8k for every slot: as many slots as fit at the smallest window.
  for (let s = slots - 1; s >= 1; s--) {
    const w = best(s);
    if (w !== undefined) return { contextWindow: w, slots: s };
  }
  return undefined;
}

/**
 * The default window and slots an Ollama agent serves with. AGENT_CONTEXT_WINDOW wins. A host with
 * a discrete GPU (not Apple's unified memory, which is RAM) sizes from its VRAM (gpuContextWindow);
 * a CPU host, an unknown model, or a model too big for the VRAM, by RAM (servedContextWindow).
 */
export function defaultServing(
  totalMemBytes: number,
  override: number | undefined,
  opts: {
    modelParamsB?: number;
    slots: number;
    slotsFixed?: boolean;
    discreteGpu?: { vramBytes: number; count?: number };
    weightsBytes?: number;
    kvBytesPer8k?: number;
    nativeContext?: number;
    kvSlotsFloor?: number;
  }
): { contextWindow: number; slots: number; basis: "override" | "gpu" | "memory" } {
  const slots = Math.max(1, Math.floor(opts.slots));
  if (override !== undefined && Number.isInteger(override) && override >= 2048 && override <= 131_072) return { contextWindow: override, slots, basis: "override" };
  const b = opts.modelParamsB;
  const known = b !== undefined && Number.isFinite(b) && b > 0;
  if (opts.discreteGpu && known) {
    const g = gpuContextWindow({
      vramBytes: opts.discreteGpu.vramBytes,
      gpuCount: opts.discreteGpu.count,
      weightsBytes: opts.weightsBytes && opts.weightsBytes > 0 ? opts.weightsBytes : (b as number) * 0.6 * GIB,
      kvBytesPer8k: opts.kvBytesPer8k && opts.kvBytesPer8k > 0 ? opts.kvBytesPer8k : Math.max(0.25, (b as number) * 0.12) * GIB,
      nativeContext: opts.nativeContext,
      slots,
      slotsFixed: opts.slotsFixed,
      kvSlotsFloor: opts.kvSlotsFloor
    });
    if (g) return { ...g, basis: "gpu" };
  }
  return { contextWindow: servedContextWindow(totalMemBytes, undefined, { modelParamsB: b, slots }), slots, basis: "memory" };
}
