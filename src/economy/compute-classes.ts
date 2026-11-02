// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Compute classes: what kind of hardware ran a task, and what a unit-hour of it is worth.
 *
 * A credit is one server-measured second of work. Different seconds are worth different sats:
 * a second on a 24 GB GPU serving a 30B model is not a second of a laptop CPU running a test.
 * Three independent factors set the price:
 *
 *   1. compute class  - from the agent's hardware profile (CPU tier, GPU VRAM tier, Apple unified
 *                       memory tier). Each class has a reference USD/hour that the rate oracle
 *                       converts to sats daily and that live market sources can override.
 *   2. model profile  - parameter count and modality of the model that served the task
 *                       (src/credits/pricing.ts modelSizeMultiplier + modalityMultiplier here).
 *   3. market         - the order book (src/economy/order-book.ts): agents' asks and requesters'
 *                       bids per class move the clearing price around the oracle reference.
 */

export type ComputeClassId =
  | "cpu.std" // commodity x86/ARM cores, < 32 GB RAM
  | "cpu.hi" // many-core / high-memory servers (>= 32 cores or >= 128 GB)
  | "apple.m" // Apple silicon, < 32 GB unified memory
  | "apple.m.hi" // Apple silicon, >= 32 GB unified memory (runs 30B-class models)
  | "gpu.c8" // consumer GPU, <= 8 GB VRAM
  | "gpu.c16" // consumer GPU, <= 16 GB VRAM
  | "gpu.c24" // consumer GPU, <= 24 GB VRAM (4090 class)
  | "gpu.dc40" // datacenter GPU, <= 48 GB (A6000/L40/A100-40)
  | "gpu.dc80"; // datacenter GPU, > 48 GB (A100-80/H100/H200)

export const COMPUTE_CLASS_IDS: ComputeClassId[] = ["cpu.std", "cpu.hi", "apple.m", "apple.m.hi", "gpu.c8", "gpu.c16", "gpu.c24", "gpu.dc40", "gpu.dc80"];

/** Agent-reported hardware. Everything optional; unknown hardware prices as cpu.std. */
export interface HardwareProfile {
  cpuCores?: number;
  cpuModel?: string;
  ramGb?: number;
  arch?: string; // "arm64" | "x64"
  platform?: string; // "darwin" | "linux" | "windows"
  gpu?: {
    vendor?: string; // "nvidia" | "amd" | "apple" | "intel"
    model?: string;
    vramGb?: number;
    /** Datacenter parts (A100/H100/L40/A6000) price higher than consumer parts at the same VRAM. */
    datacenter?: boolean;
  };
  /** Optional benchmark the agent ran (single-thread score); reserved for future tiering. */
  benchmarkScore?: number;
}

export interface ComputeClassSpec {
  id: ComputeClassId;
  label: string;
  resourceClass: "cpu" | "gpu";
  /** Reference market price in USD per hour of the whole unit (one agent slot of this class). */
  usdPerHourReference: number;
  /** Credits per second of work on this class (before model and load multipliers). */
  creditsPerSecond: number;
}

/**
 * Reference USD/hour by class. Sources: cloud spot vCPU (0.01-0.02), Apple silicon rental
 * (0.10-0.30), GPU marketplaces 2026 (RTX 3060/4060 ~0.10, 4080/A4000 ~0.20, 4090 ~0.35,
 * A6000/L40 ~0.70, A100-80/H100 ~1.50-2.50). Overridable per class via RATE_COMPUTE_SOURCES_JSON
 * (computeClass field) or COMPUTE_REFERENCE_USD_PER_HOUR_JSON.
 */
export const DEFAULT_COMPUTE_CLASSES: Record<ComputeClassId, ComputeClassSpec> = {
  "cpu.std": { id: "cpu.std", label: "CPU (standard)", resourceClass: "cpu", usdPerHourReference: 0.02, creditsPerSecond: 1.0 },
  "cpu.hi": { id: "cpu.hi", label: "CPU (high-core / high-memory)", resourceClass: "cpu", usdPerHourReference: 0.08, creditsPerSecond: 1.0 },
  "apple.m": { id: "apple.m", label: "Apple silicon (< 32 GB)", resourceClass: "gpu", usdPerHourReference: 0.12, creditsPerSecond: 2.0 },
  "apple.m.hi": { id: "apple.m.hi", label: "Apple silicon (>= 32 GB)", resourceClass: "gpu", usdPerHourReference: 0.3, creditsPerSecond: 3.0 },
  "gpu.c8": { id: "gpu.c8", label: "GPU <= 8 GB", resourceClass: "gpu", usdPerHourReference: 0.1, creditsPerSecond: 2.0 },
  "gpu.c16": { id: "gpu.c16", label: "GPU <= 16 GB", resourceClass: "gpu", usdPerHourReference: 0.2, creditsPerSecond: 3.0 },
  "gpu.c24": { id: "gpu.c24", label: "GPU <= 24 GB", resourceClass: "gpu", usdPerHourReference: 0.35, creditsPerSecond: 4.0 },
  "gpu.dc40": { id: "gpu.dc40", label: "Datacenter GPU <= 48 GB", resourceClass: "gpu", usdPerHourReference: 0.7, creditsPerSecond: 6.0 },
  "gpu.dc80": { id: "gpu.dc80", label: "Datacenter GPU > 48 GB", resourceClass: "gpu", usdPerHourReference: 1.8, creditsPerSecond: 10.0 }
};

/** Map an agent's hardware profile to a compute class. Deterministic; unknown -> cpu.std. */
export function classifyHardware(hw: HardwareProfile | undefined): ComputeClassId {
  if (!hw) return "cpu.std";
  const gpu = hw.gpu;
  const vendor = (gpu?.vendor ?? "").toLowerCase();
  const isApple = hw.platform === "darwin" && (hw.arch === "arm64" || vendor === "apple");
  if (isApple) return (hw.ramGb ?? 0) >= 32 ? "apple.m.hi" : "apple.m";
  if (gpu && (gpu.vramGb ?? 0) > 0 && vendor !== "intel") {
    const vram = gpu.vramGb as number;
    const dc = gpu.datacenter === true || /a100|h100|h200|l40|a6000|a40|v100|mi300|b200/i.test(gpu.model ?? "");
    if (dc) return vram > 48 ? "gpu.dc80" : "gpu.dc40";
    if (vram <= 8) return "gpu.c8";
    if (vram <= 16) return "gpu.c16";
    if (vram <= 24) return "gpu.c24";
    return "gpu.dc40";
  }
  if ((hw.cpuCores ?? 0) >= 32 || (hw.ramGb ?? 0) >= 128) return "cpu.hi";
  return "cpu.std";
}

/** Model modality multiplier: multimodal / thinking work uses more compute per second of wall time on the same class. */
export function modalityMultiplier(capabilities: ReadonlyArray<string> | undefined): number {
  if (!capabilities || capabilities.length === 0) return 1.0;
  let m = 1.0;
  const caps = new Set(capabilities.map((c) => c.toLowerCase()));
  if (caps.has("vision")) m *= 1.25;
  if (caps.has("thinking")) m *= 1.1;
  return Number(m.toFixed(4));
}

/** Parse COMPUTE_REFERENCE_USD_PER_HOUR_JSON ({"gpu.c24": 0.4, ...}) over the defaults. */
export function computeClassesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<ComputeClassId, ComputeClassSpec> {
  const out: Record<ComputeClassId, ComputeClassSpec> = JSON.parse(JSON.stringify(DEFAULT_COMPUTE_CLASSES));
  // Legacy single-value knobs keep working: they set cpu.std and gpu.c24.
  const cpu = Number(env.COMPUTE_REFERENCE_USD_PER_VCPU_HOUR);
  if (env.COMPUTE_REFERENCE_USD_PER_VCPU_HOUR?.trim() && Number.isFinite(cpu) && cpu > 0) out["cpu.std"].usdPerHourReference = cpu;
  const gpu = Number(env.COMPUTE_REFERENCE_USD_PER_GPU_HOUR);
  if (env.COMPUTE_REFERENCE_USD_PER_GPU_HOUR?.trim() && Number.isFinite(gpu) && gpu > 0) out["gpu.c24"].usdPerHourReference = gpu;
  if (env.COMPUTE_REFERENCE_USD_PER_HOUR_JSON?.trim()) {
    const parsed = JSON.parse(env.COMPUTE_REFERENCE_USD_PER_HOUR_JSON) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in out)) throw new Error(`[compute-classes] unknown class ${k}; valid: ${COMPUTE_CLASS_IDS.join(", ")}`);
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`[compute-classes] ${k} must be a positive USD/hour`);
      out[k as ComputeClassId].usdPerHourReference = n;
    }
  }
  return out;
}

/**
 * Sats per credit for a class at a given BTC/USD and markup:
 *   satsPerUnitHour = usdPerHour / btcUsd × 1e8 × (1 + markup)
 *   satsPerCredit   = satsPerUnitHour / (creditsPerSecond × 3600)
 * so that one unit-hour of the class is worth its market price regardless of how many credits
 * per second the class mints.
 */
export function satsPerCreditForClass(spec: ComputeClassSpec, usdPerHour: number, btcUsd: number, markupBps: number): number {
  const satsPerHour = (usdPerHour / btcUsd) * 1e8 * (1 + markupBps / 10_000);
  return Number((satsPerHour / (spec.creditsPerSecond * 3600)).toFixed(9));
}
