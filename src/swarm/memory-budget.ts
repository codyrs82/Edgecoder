// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Host memory budget: how much memory a model needs on this machine, and which models it may
 * load or serve on the network, so network work can never push a host into memory exhaustion
 * (2026-11-16: ten llama-server processes, ~120 GB on a 48 GB Mac, a watchdog restart).
 *
 * The budget is a share of physical RAM (AGENT_MEMORY_BUDGET_PCT, default 60%), or 90% of a
 * discrete GPU's VRAM. Every estimate here is conservative (f16 KV cache even when Ollama runs a
 * q8_0 cache, which only adds headroom):
 *
 *   weights  = the model's file size (Ollama /api/tags), else params(B) x bytes per param by quant
 *              (q4: 0.6 GB/B, q5: 0.72, q6: 0.85, q8: 1.07, f16: 2.0)
 *   runtime  = 0.5 GB (compute graph, buffers)
 *   KV cache = max(0.25 GB, params(B) x 0.12 GB) per 8k tokens per parallel slot
 *              (Ollama allocates num_ctx x OLLAMA_NUM_PARALLEL when it loads a model)
 *
 * Shared by the agent (src/swarm/worker-runner.ts: what to load, advertise and serve) and the
 * coordinator (src/swarm/coordinator/memory-admission.ts: what to dispatch to which agent).
 */

import { paramsB } from "../inference-api/auto-route.js";

export const GB = 1024 ** 3;
export const DEFAULT_MEMORY_BUDGET_PCT = 60;
export const RUNTIME_OVERHEAD_BYTES = 0.5 * GB;
/** Context windows tried, largest first, when a model has to be made to fit. */
export const CONTEXT_STEPS = [131_072, 65_536, 32_768, 16_384, 8_192, 4_096, 2_048] as const;

/** AGENT_MEMORY_BUDGET_PCT: 10-90 (% of RAM); anything else is the default 60. */
export function memoryBudgetPct(raw: string | number | undefined): number {
  const n = typeof raw === "number" ? raw : raw === undefined || String(raw).trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 10 && n <= 90 ? n : DEFAULT_MEMORY_BUDGET_PCT;
}

/**
 * The bytes models may use on this host: `pct` of RAM, or 90% of a discrete GPU's VRAM when the
 * models live there (Apple silicon shares RAM with its GPU: RAM counts).
 */
export function memoryBudgetBytes(totalRamBytes: number, pct: number = DEFAULT_MEMORY_BUDGET_PCT, discreteVramBytes?: number): number {
  if (discreteVramBytes && discreteVramBytes > 0) return Math.floor(discreteVramBytes * 0.9);
  return Math.floor(Math.max(0, totalRamBytes) * (memoryBudgetPct(pct) / 100));
}

/** GB per billion parameters for the weights, by the quant in the tag (default 4-bit). */
export function bytesPerParamGb(model: string): number {
  const t = model.toLowerCase();
  if (/(fp16|f16|bf16)/.test(t)) return 2.0;
  if (/q8/.test(t)) return 1.07;
  if (/q6/.test(t)) return 0.85;
  if (/q5/.test(t)) return 0.72;
  return 0.6;
}

/** The weights in memory: the model's file size when known, else by parameters and quant. */
export function weightsBytes(model: string, sizeBytes?: number): number {
  if (sizeBytes && sizeBytes > 0) return sizeBytes;
  return paramsB(model) * bytesPerParamGb(model) * GB;
}

/** KV cache per parallel slot per 8k tokens (f16). */
export function kvBytesPer8kSlot(model: string): number {
  return Math.max(0.25, paramsB(model) * 0.12) * GB;
}

export interface ModelEstimate {
  weightsBytes: number;
  kvBytes: number;
  totalBytes: number;
}

/** Memory a model takes loaded with `numCtx` tokens per slot and `slots` parallel slots. */
export function estimateModelBytes(model: string, opts: { sizeBytes?: number; numCtx: number; slots: number }): ModelEstimate {
  const w = weightsBytes(model, opts.sizeBytes) + RUNTIME_OVERHEAD_BYTES;
  const kv = kvBytesPer8kSlot(model) * Math.max(1, opts.slots) * (Math.max(512, opts.numCtx) / 8192);
  return { weightsBytes: Math.round(w), kvBytes: Math.round(kv), totalBytes: Math.round(w + kv) };
}

export interface ModelFit {
  /** Fits the budget on its own at contextWindow x slots. */
  fits: boolean;
  contextWindow: number;
  slots: number;
  bytes: number;
}

/**
 * The largest context window and slot count (up to the wanted ones) at which `model` fits
 * `budgetBytes` on its own. The window comes down first, to 8k; then the slots (unless
 * `fixedKvSlots`: Ollama's OLLAMA_NUM_PARALLEL decides the KV cache, so fewer agent slots save
 * nothing); then the window to 4k and 2k. Not fitting even then: fits = false, smallest values.
 */
export function fitModel(model: string, opts: { sizeBytes?: number; budgetBytes: number; wantContext: number; wantSlots: number; fixedKvSlots?: number }): ModelFit {
  const wantCtx = Math.max(2048, Math.floor(opts.wantContext));
  const wantSlots = Math.max(1, Math.floor(opts.wantSlots));
  const kvSlots = (slots: number) => (opts.fixedKvSlots && opts.fixedKvSlots > 0 ? Math.max(opts.fixedKvSlots, slots) : slots);
  const steps = [wantCtx, ...CONTEXT_STEPS.filter((c) => c < wantCtx)];
  const tries: Array<[number, number]> = [];
  for (const c of steps) if (c >= 8192 || c === wantCtx) tries.push([c, wantSlots]);
  const floorCtx = Math.min(wantCtx, 8192);
  if (!opts.fixedKvSlots) for (let s = wantSlots - 1; s >= 1; s--) tries.push([floorCtx, s]);
  const minSlots = opts.fixedKvSlots ? wantSlots : 1;
  for (const c of steps) if (c < floorCtx) tries.push([c, minSlots]);
  for (const [ctx, slots] of tries) {
    const bytes = estimateModelBytes(model, { sizeBytes: opts.sizeBytes, numCtx: ctx, slots: kvSlots(slots) }).totalBytes;
    if (bytes <= opts.budgetBytes) return { fits: true, contextWindow: ctx, slots, bytes };
  }
  const [ctx, slots] = tries[tries.length - 1];
  return { fits: false, contextWindow: ctx, slots, bytes: estimateModelBytes(model, { sizeBytes: opts.sizeBytes, numCtx: ctx, slots: kvSlots(slots) }).totalBytes };
}

export interface InstalledModel {
  name: string;
  sizeBytes?: number;
}
export interface LoadedModel {
  name: string;
  /** Bytes Ollama reports for the loaded model (/api/ps size). */
  sizeBytes: number;
  expiresAt?: string;
}

export interface ServingPlan {
  /** Served on the network (advertised to the coordinator), loaded ones first. */
  serving: Array<{ model: string; bytes: number; loaded: boolean }>;
  /** Fit the budget on their own, but past the per-host cap: local use only. */
  localOnly: string[];
  /** Do not fit the budget even on their own (at the served window and slots): local use only. */
  tooBig: string[];
}

/**
 * Which installed models this host serves on the network. A model counts only if it fits the
 * budget on its own at the served context window and slots; the host then serves as many distinct
 * models as fit the budget together (loaded models first: they cost no load and the coordinator
 * prefers them; then the configured model), at most `maxModels` (AGENT_MAX_NETWORK_MODELS, and
 * never more than Ollama keeps loaded, OLLAMA_MAX_LOADED_MODELS). At least one when any fits.
 */
export function planServing(opts: {
  installed: InstalledModel[];
  loaded: LoadedModel[];
  preferred?: string;
  budgetBytes: number;
  contextWindow: number;
  kvSlots: number;
  maxModels?: number;
}): ServingPlan {
  const loaded = new Map(opts.loaded.map((m) => [m.name, m]));
  const cost = (m: InstalledModel): number => {
    const est = estimateModelBytes(m.name, { sizeBytes: m.sizeBytes, numCtx: opts.contextWindow, slots: opts.kvSlots }).totalBytes;
    const l = loaded.get(m.name);
    // A loaded model's real size, but never below the estimate (it may grow to the served window).
    return l && l.sizeBytes > 0 ? Math.max(l.sizeBytes, est) : est;
  };
  const rank = (m: InstalledModel): number => (loaded.has(m.name) ? 0 : m.name === opts.preferred ? 1 : 2);
  const ordered = opts.installed
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || (rank(a.m) === 0 ? opts.loaded.findIndex((l) => l.name === a.m.name) - opts.loaded.findIndex((l) => l.name === b.m.name) : a.i - b.i))
    .map((x) => x.m);
  const cap = opts.maxModels && opts.maxModels > 0 ? Math.floor(opts.maxModels) : Number.POSITIVE_INFINITY;
  const plan: ServingPlan = { serving: [], localOnly: [], tooBig: [] };
  let used = 0;
  for (const m of ordered) {
    const bytes = cost(m);
    if (bytes > opts.budgetBytes) {
      plan.tooBig.push(m.name);
      continue;
    }
    if (plan.serving.length < cap && used + bytes <= opts.budgetBytes) {
      plan.serving.push({ model: m.name, bytes, loaded: loaded.has(m.name) });
      used += bytes;
    } else plan.localOnly.push(m.name);
  }
  return plan;
}

export interface LoadPlan {
  ok: boolean;
  /** Idle models to unload first (keep_alive 0), least recently used first. */
  unload: string[];
  /** Bytes in use by other loaded models after the unloads. */
  usedBytes: number;
  reason?: string;
}

/**
 * Before loading `model` (needing `needBytes`): fits next to what is loaded, or after unloading
 * idle models (not `busy`, not `protectedModels`: the owner's own chat model), least recently used
 * first (earliest keep-alive expiry). Otherwise refuse: the call is handed back.
 */
export function planLoad(opts: { model: string; needBytes: number; budgetBytes: number; loaded: LoadedModel[]; busy?: ReadonlySet<string>; protectedModels?: ReadonlySet<string> }): LoadPlan {
  const others = opts.loaded.filter((m) => m.name !== opts.model);
  let used = others.reduce((s, m) => s + Math.max(0, m.sizeBytes), 0);
  if (opts.loaded.some((m) => m.name === opts.model)) {
    // Already loaded: Ollama reuses it (no new memory) as long as the window is the same.
    return { ok: true, unload: [], usedBytes: used };
  }
  if (used + opts.needBytes <= opts.budgetBytes) return { ok: true, unload: [], usedBytes: used };
  const idle = others
    .filter((m) => !opts.busy?.has(m.name) && !opts.protectedModels?.has(m.name))
    .sort((a, b) => Date.parse(a.expiresAt ?? "") - Date.parse(b.expiresAt ?? "") || 0);
  const unload: string[] = [];
  for (const m of idle) {
    if (used + opts.needBytes <= opts.budgetBytes) break;
    unload.push(m.name);
    used -= Math.max(0, m.sizeBytes);
  }
  if (used + opts.needBytes <= opts.budgetBytes) return { ok: true, unload, usedBytes: used };
  return {
    ok: false,
    unload: [],
    usedBytes: used,
    reason: `memory_budget: ${opts.model} needs ${fmtGb(opts.needBytes)}, only ${fmtGb(Math.max(0, opts.budgetBytes - used))} of this host's ${fmtGb(opts.budgetBytes)} budget is free`
  };
}

export function fmtGb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

export type PressureLevel = "normal" | "warning" | "critical";

/**
 * What an agent reports about its memory with each heartbeat (and register), for the
 * coordinator's admission control (src/swarm/coordinator/memory-admission.ts). Older coordinators
 * ignore it.
 */
export interface MemoryTelemetry {
  totalBytes: number;
  availableBytes?: number;
  pressure: PressureLevel;
  /** Bytes models may use on this host. */
  budgetBytes: number;
  /** Bytes the loaded models use now (Ollama /api/ps). */
  usedBytes: number;
  loadedModels: Array<{ name: string; bytes: number }>;
  /** Served models with their estimated footprint, context window and slots. */
  models: Array<{ name: string; bytes: number; contextWindow: number; slots: number }>;
  /** The agent stopped taking network work for memory (pressure or nothing fits). */
  paused?: boolean;
  atMs: number;
}

/** OLLAMA_MAX_LOADED_MODELS for a host: 1 up to 32 GB, 2 above (the desktop app's local_compute.rs uses the same rule). */
export function ollamaMaxLoadedFor(memoryBytes: number): number {
  return memoryBytes / GB > 33 ? 2 : 1;
}

/** OLLAMA_NUM_PARALLEL for a host without a model-sized value: 1 below 15 GB, 2 up to 63 GB, 4 above (as the desktop app). */
export function ollamaParallelFor(memoryBytes: number): number {
  const gb = memoryBytes / GB;
  return gb >= 63 ? 4 : gb >= 15 ? 2 : 1;
}

/**
 * Memory-safety settings for an `ollama serve` EdgeCoder starts (the installer's service units, the
 * agent's own auto-start): a loaded-model cap by memory, and flash attention with a q8_0 KV cache
 * (about half the cache memory; Ollama 0.5+, a model without flash attention falls back to f16).
 */
export function ollamaMemorySafetyEnv(memoryBytes: number): Record<string, string> {
  return {
    OLLAMA_MAX_LOADED_MODELS: String(ollamaMaxLoadedFor(memoryBytes)),
    OLLAMA_FLASH_ATTENTION: "1",
    OLLAMA_KV_CACHE_TYPE: "q8_0",
  };
}
