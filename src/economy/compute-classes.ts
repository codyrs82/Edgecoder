// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Compute classes: which capability pool ran a task, and what a credit of it is worth.
 *
 * A credit is one server-measured second of work on the base tier of a class. There are four
 * class-markets, one per real capability pool, each with ONE reference, ONE order book and ONE
 * clearing price (a flat price per credit within the class):
 *
 *   cpu     commodity and server cores
 *   apple   Apple silicon (unified memory)
 *   gpu     consumer GPUs
 *   gpu.dc  datacenter GPUs (kept separate as a reliability / SLA tier)
 *
 * Throughput is expressed by weights, not by more markets: within a class, faster hardware mints
 * more credits per measured second (`creditsPerSecond` of its tier). The base tier of each class
 * has weight 1, and the class's reference USD/hour is the base tier's hour, so
 *
 *   usdPerCredit(class)   = usdPerHourReference(class) / 3600
 *   usdPerHour(tier)      = usdPerHourReference(class) × creditsPerSecond(tier)
 *
 * e.g. a 24 GB GPU-hour is 3.5 GPU-credit-hours. Capability requirements (a 30B model needs a
 * 24 GB card) are constraints on the bid (`minVramGb`, `minMemoryGb`, see order-book.ts), not
 * separate markets.
 *
 * On top of the class price: the model profile (src/credits/pricing.ts modelSizeMultiplier on
 * the credit rate, modalityMultiplier here on the sats value) and the market (order-book.ts).
 *
 * Legacy ids: until 2026-11 there were nine classes (cpu.std ... gpu.dc80), each with its own
 * price. Those ids live on in signed receipts, ledger payloads and market history; they are the
 * tier ids now, and `normalizeComputeClass` maps any of them onto its class.
 */

export type ComputeClassId = "cpu" | "apple" | "gpu" | "gpu.dc";

export const COMPUTE_CLASS_IDS: ComputeClassId[] = ["cpu", "apple", "gpu", "gpu.dc"];

/** The nine pre-2026-11 class ids. Never rewritten where they were signed or persisted. */
export type LegacyComputeClassId = "cpu.std" | "cpu.hi" | "apple.m" | "apple.m.hi" | "gpu.c8" | "gpu.c16" | "gpu.c24" | "gpu.dc40" | "gpu.dc80";

export const LEGACY_COMPUTE_CLASS_IDS: LegacyComputeClassId[] = ["cpu.std", "cpu.hi", "apple.m", "apple.m.hi", "gpu.c8", "gpu.c16", "gpu.c24", "gpu.dc40", "gpu.dc80"];

/** Hardware tiers inside the classes. The legacy class ids name the tiers; gpu.c32 is new (> 24 GB consumer cards). */
export type ComputeTierId = LegacyComputeClassId | "gpu.c32";

/**
 * The one legacy map. `creditsPerSecond` is the frozen divisor the old oracle used for that class
 * (satsPerCredit = unitHour / (creditsPerSecond × 3600)); it converts a legacy msat/credit price
 * into the current unit (see legacyMsatToCurrent). Do not edit: it describes history.
 */
export const LEGACY_COMPUTE_CLASSES: Record<LegacyComputeClassId, { computeClass: ComputeClassId; creditsPerSecond: number }> = {
  "cpu.std": { computeClass: "cpu", creditsPerSecond: 1 },
  "cpu.hi": { computeClass: "cpu", creditsPerSecond: 1 },
  "apple.m": { computeClass: "apple", creditsPerSecond: 2 },
  "apple.m.hi": { computeClass: "apple", creditsPerSecond: 3 },
  "gpu.c8": { computeClass: "gpu", creditsPerSecond: 2 },
  "gpu.c16": { computeClass: "gpu", creditsPerSecond: 3 },
  "gpu.c24": { computeClass: "gpu", creditsPerSecond: 4 },
  "gpu.dc40": { computeClass: "gpu.dc", creditsPerSecond: 6 },
  "gpu.dc80": { computeClass: "gpu.dc", creditsPerSecond: 10 }
};

/** Agent-reported hardware. Everything optional; unknown hardware prices as cpu at weight 1. */
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
    /** Datacenter parts (A100/H100/L40/A6000) go to the gpu.dc class, not gpu. */
    datacenter?: boolean;
  };
  /** Optional benchmark the agent ran (single-thread score); reserved for future tiering. */
  benchmarkScore?: number;
}

export interface ComputeTierSpec {
  id: ComputeTierId;
  label: string;
  /** Credits minted per measured second on this tier (the throughput weight). The base tier is 1. */
  creditsPerSecond: number;
}

export interface ComputeClassSpec {
  id: ComputeClassId;
  label: string;
  resourceClass: "cpu" | "gpu";
  /** Reference USD per hour of the base tier (weight 1), i.e. per 3600 credits. One flat price per credit in the class. */
  usdPerHourReference: number;
  /** Tiers, base tier (creditsPerSecond 1) first. */
  tiers: ComputeTierSpec[];
}

/**
 * Reference USD/hour per class (base tier) and tier weights. Sources: cloud spot vCPU
 * (0.01-0.02), Apple silicon rental (0.10-0.30), GPU marketplaces 2026 (RTX 3060/4060 ~0.10,
 * 4080/A4000 ~0.20, 4090 ~0.35, A6000/L40 ~0.70, A100-80/H100 ~1.50-2.50). The weights keep each
 * tier's hour at the old per-class references (cpu.hi 0.08, apple.m.hi 0.30, gpu.c16 0.20,
 * gpu.c24 0.35). References are overridable via RATE_COMPUTE_SOURCES_JSON (computeClass field) or
 * COMPUTE_REFERENCE_USD_PER_HOUR_JSON; weights via COMPUTE_TIER_WEIGHTS_JSON.
 */
export const DEFAULT_COMPUTE_CLASSES: Record<ComputeClassId, ComputeClassSpec> = {
  cpu: {
    id: "cpu",
    label: "CPU",
    resourceClass: "cpu",
    usdPerHourReference: 0.02,
    tiers: [
      { id: "cpu.std", label: "Standard (< 32 cores, < 128 GB)", creditsPerSecond: 1 },
      { id: "cpu.hi", label: "High-core / high-memory (≥ 32 cores or ≥ 128 GB)", creditsPerSecond: 4 }
    ]
  },
  apple: {
    id: "apple",
    label: "Apple silicon",
    resourceClass: "gpu",
    usdPerHourReference: 0.12,
    tiers: [
      { id: "apple.m", label: "< 32 GB unified memory", creditsPerSecond: 1 },
      { id: "apple.m.hi", label: "≥ 32 GB unified memory", creditsPerSecond: 2.5 }
    ]
  },
  gpu: {
    id: "gpu",
    label: "GPU",
    resourceClass: "gpu",
    usdPerHourReference: 0.1,
    tiers: [
      { id: "gpu.c8", label: "≤ 8 GB VRAM", creditsPerSecond: 1 },
      { id: "gpu.c16", label: "≤ 16 GB VRAM", creditsPerSecond: 2 },
      { id: "gpu.c24", label: "≤ 24 GB VRAM (RTX 4090 class)", creditsPerSecond: 3.5 },
      { id: "gpu.c32", label: "> 24 GB VRAM (consumer)", creditsPerSecond: 4.5 }
    ]
  },
  "gpu.dc": {
    id: "gpu.dc",
    label: "Datacenter GPU",
    resourceClass: "gpu",
    usdPerHourReference: 0.7,
    tiers: [
      { id: "gpu.dc40", label: "≤ 48 GB (A6000 / L40 / A100-40)", creditsPerSecond: 1 },
      { id: "gpu.dc80", label: "> 48 GB (A100-80 / H100 / H200)", creditsPerSecond: 2.9 }
    ]
  }
};

/** The legacy (or tier) id that is the base tier of each class. */
export const BASE_TIER: Record<ComputeClassId, ComputeTierId> = { cpu: "cpu.std", apple: "apple.m", gpu: "gpu.c8", "gpu.dc": "gpu.dc40" };

const isCurrentId = (id: string): id is ComputeClassId => (COMPUTE_CLASS_IDS as string[]).includes(id);
export const isLegacyComputeClassId = (id: string): id is LegacyComputeClassId => Object.prototype.hasOwnProperty.call(LEGACY_COMPUTE_CLASSES, id);

/** Current class for a current, legacy or tier id; undefined for anything else. */
export function normalizeComputeClass(id: string | undefined | null): ComputeClassId | undefined {
  if (typeof id !== "string") return undefined;
  if (isCurrentId(id)) return id;
  if (isLegacyComputeClassId(id)) return LEGACY_COMPUTE_CLASSES[id].computeClass;
  if (id === "gpu.c32") return "gpu";
  return undefined;
}

/** Ids an API edge accepts for a class parameter: the four current ids plus the nine legacy ones. */
export const ACCEPTED_COMPUTE_CLASS_IDS: string[] = [...COMPUTE_CLASS_IDS, ...LEGACY_COMPUTE_CLASS_IDS];

export function tierSpec(classes: Record<ComputeClassId, ComputeClassSpec>, tier: ComputeTierId): ComputeTierSpec | undefined {
  const cls = normalizeComputeClass(tier);
  return cls ? classes[cls]?.tiers.find((t) => t.id === tier) : undefined;
}

/**
 * Convert a price quoted under a legacy class id (msat per old credit) into the current unit
 * (msat per credit of the class). Old credit = 1/creditsPerSecond(legacy) of a tier-second; new
 * credit = 1/weight(tier) of a tier-second, so the per-hour value of the tier is preserved:
 *   current = legacy × legacyCreditsPerSecond / tierWeight
 * Current ids pass through unchanged.
 */
export function legacyMsatToCurrent(id: string, msatPerCredit: number, classes: Record<ComputeClassId, ComputeClassSpec> = DEFAULT_COMPUTE_CLASSES): number {
  if (!isLegacyComputeClassId(id) || !Number.isFinite(msatPerCredit)) return msatPerCredit;
  const weight = tierSpec(classes, id)?.creditsPerSecond ?? 1;
  return (msatPerCredit * LEGACY_COMPUTE_CLASSES[id].creditsPerSecond) / weight;
}

/** Capability a requester may require of the hardware that fills its bid. */
export interface CapabilityConstraints {
  /** Minimum discrete GPU VRAM in GB (Apple unified memory does not count; use minMemoryGb). */
  minVramGb?: number;
  /** Minimum system / unified memory in GB. */
  minMemoryGb?: number;
}

/**
 * What a legacy class id implied about the hardware: a bid on gpu.c24 only matched 17-24 GB cards,
 * so mapping it to "gpu" without a constraint would let an 8 GB card fill it. cpu.hi (cores OR
 * memory) has no clean single constraint and maps to plain cpu.
 */
export function legacyClassConstraints(id: string): CapabilityConstraints {
  switch (id) {
    case "gpu.c16":
      return { minVramGb: 9 };
    case "gpu.c24":
      return { minVramGb: 17 };
    case "gpu.dc80":
      return { minVramGb: 49 };
    case "apple.m.hi":
      return { minMemoryGb: 32 };
    default:
      return {};
  }
}

/** Where an agent landed: its class-market, tier and weight, and the capability its ask advertises. */
export interface HardwareClassification {
  computeClass: ComputeClassId;
  tier: ComputeTierId;
  /** Credits per measured second (the tier weight). */
  creditsPerSecond: number;
  /** Discrete GPU VRAM in GB, when the agent has one. */
  vramGb?: number;
  /** System RAM (or Apple unified memory) in GB, when reported. */
  memoryGb?: number;
}

/** Self-reported sizes: finite, positive, and capped so an absurd report cannot satisfy every constraint. */
function gb(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(n, 4096) : undefined;
}

/** Map an agent's hardware profile to its class, tier and weight. Deterministic; unknown -> cpu at weight 1. */
export function classifyHardware(hw: HardwareProfile | undefined, classes: Record<ComputeClassId, ComputeClassSpec> = DEFAULT_COMPUTE_CLASSES): HardwareClassification {
  const make = (tier: ComputeTierId, vramGb?: number, memoryGb?: number): HardwareClassification => {
    const cls = normalizeComputeClass(tier) as ComputeClassId;
    const weight = tierSpec(classes, tier)?.creditsPerSecond ?? 1;
    return { computeClass: cls, tier, creditsPerSecond: weight, ...(vramGb !== undefined ? { vramGb } : {}), ...(memoryGb !== undefined ? { memoryGb } : {}) };
  };
  if (!hw) return make("cpu.std");
  const memoryGb = gb(hw.ramGb);
  const gpu = hw.gpu;
  const vendor = (gpu?.vendor ?? "").toLowerCase();
  const isApple = hw.platform === "darwin" && (hw.arch === "arm64" || vendor === "apple");
  if (isApple) return make((memoryGb ?? 0) >= 32 ? "apple.m.hi" : "apple.m", undefined, memoryGb);
  const vram = gb(gpu?.vramGb);
  if (gpu && vram !== undefined && vendor !== "intel") {
    const dc = gpu.datacenter === true || /a100|h100|h200|l40|a6000|a40|v100|mi300|b200/i.test(gpu.model ?? "");
    if (dc) return make(vram > 48 ? "gpu.dc80" : "gpu.dc40", vram, memoryGb);
    if (vram <= 8) return make("gpu.c8", vram, memoryGb);
    if (vram <= 16) return make("gpu.c16", vram, memoryGb);
    if (vram <= 24) return make("gpu.c24", vram, memoryGb);
    return make("gpu.c32", vram, memoryGb);
  }
  if ((hw.cpuCores ?? 0) >= 32 || (memoryGb ?? 0) >= 128) return make("cpu.hi", undefined, memoryGb);
  return make("cpu.std", undefined, memoryGb);
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

/**
 * Classes with env overrides over the defaults:
 *   COMPUTE_TIER_WEIGHTS_JSON          {"gpu.c24": 3.2, ...}  tier weights (base tiers are fixed at 1)
 *   COMPUTE_REFERENCE_USD_PER_HOUR_JSON {"gpu": 0.12, ...}    class reference (base-tier USD/hour).
 *       A legacy / tier key sets that tier's hour instead: {"gpu.c24": 0.4} => gpu = 0.4 / weight(gpu.c24).
 *       Current class keys win over tier keys for the same class.
 *   COMPUTE_REFERENCE_USD_PER_VCPU_HOUR (legacy) sets cpu; COMPUTE_REFERENCE_USD_PER_GPU_HOUR
 *       (legacy, a 4090-class hour) sets gpu through the gpu.c24 weight.
 */
export function computeClassesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<ComputeClassId, ComputeClassSpec> {
  const out: Record<ComputeClassId, ComputeClassSpec> = JSON.parse(JSON.stringify(DEFAULT_COMPUTE_CLASSES));
  const positive = (k: string, v: unknown, what: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`[compute-classes] ${k} must be a positive ${what}`);
    return n;
  };
  if (env.COMPUTE_TIER_WEIGHTS_JSON?.trim()) {
    const parsed = JSON.parse(env.COMPUTE_TIER_WEIGHTS_JSON) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      const t = tierSpec(out, k as ComputeTierId);
      if (!t) throw new Error(`[compute-classes] unknown tier ${k}`);
      const n = positive(k, v, "credits per second");
      if (BASE_TIER[normalizeComputeClass(k) as ComputeClassId] === k && n !== 1) {
        throw new Error(`[compute-classes] ${k} is a base tier; its weight is fixed at 1 (change the class reference instead)`);
      }
      t.creditsPerSecond = n;
    }
  }
  const weightOf = (tier: ComputeTierId): number => tierSpec(out, tier)?.creditsPerSecond ?? 1;
  // Legacy single-value knobs keep working.
  const cpu = Number(env.COMPUTE_REFERENCE_USD_PER_VCPU_HOUR);
  if (env.COMPUTE_REFERENCE_USD_PER_VCPU_HOUR?.trim() && Number.isFinite(cpu) && cpu > 0) out.cpu.usdPerHourReference = cpu;
  const gpu = Number(env.COMPUTE_REFERENCE_USD_PER_GPU_HOUR);
  if (env.COMPUTE_REFERENCE_USD_PER_GPU_HOUR?.trim() && Number.isFinite(gpu) && gpu > 0) out.gpu.usdPerHourReference = gpu / weightOf("gpu.c24");
  if (env.COMPUTE_REFERENCE_USD_PER_HOUR_JSON?.trim()) {
    const parsed = JSON.parse(env.COMPUTE_REFERENCE_USD_PER_HOUR_JSON) as Record<string, unknown>;
    const entries = Object.entries(parsed);
    for (const [k] of entries) {
      if (!normalizeComputeClass(k) || (!isCurrentId(k) && !tierSpec(out, k as ComputeTierId))) {
        throw new Error(`[compute-classes] unknown class ${k}; valid: ${COMPUTE_CLASS_IDS.join(", ")} (or a tier id)`);
      }
    }
    // Tier keys first, then class keys, so an explicit class reference wins.
    for (const [k, v] of entries.filter(([k]) => !isCurrentId(k))) {
      out[normalizeComputeClass(k) as ComputeClassId].usdPerHourReference = positive(k, v, "USD/hour") / weightOf(k as ComputeTierId);
    }
    for (const [k, v] of entries.filter(([k]) => isCurrentId(k))) out[k as ComputeClassId].usdPerHourReference = positive(k, v, "USD/hour");
  }
  return out;
}

/**
 * Sats per credit of a class at a given BTC/USD and markup. Flat within the class:
 *   satsPerCreditHour = usdPerHour(class) / btcUsd × 1e8 × (1 + markup)
 *   satsPerCredit     = satsPerCreditHour / 3600
 * A tier's hour is satsPerCreditHour × creditsPerSecond(tier), because the tier mints that many
 * credits per second.
 */
export function satsPerCreditForClass(usdPerHour: number, btcUsd: number, markupBps: number): number {
  const satsPerHour = (usdPerHour / btcUsd) * 1e8 * (1 + markupBps / 10_000);
  return Number((satsPerHour / 3600).toFixed(9));
}

/**
 * API edge: resolve a requested class (current, legacy or "any") with an optional explicit price
 * and constraints. A legacy id maps onto its class, its explicit price converts into the current
 * unit, and it brings the capability it implied (explicit constraints win). Undefined class =>
 * not a known id (callers validate first).
 */
export function resolveRequestedClass(
  requested: string,
  msatPerCredit: number | undefined,
  constraints: CapabilityConstraints = {},
  classes: Record<ComputeClassId, ComputeClassSpec> = DEFAULT_COMPUTE_CLASSES
): { computeClass: ComputeClassId | "any" | undefined; msatPerCredit: number | undefined; constraints: CapabilityConstraints } {
  const legacy = isLegacyComputeClassId(requested);
  const price = msatPerCredit !== undefined && legacy && msatPerCredit > 0 ? Math.max(1, Math.round(legacyMsatToCurrent(requested, msatPerCredit, classes))) : msatPerCredit;
  const explicit: CapabilityConstraints = {};
  if (constraints.minVramGb !== undefined) explicit.minVramGb = constraints.minVramGb;
  if (constraints.minMemoryGb !== undefined) explicit.minMemoryGb = constraints.minMemoryGb;
  return {
    computeClass: requested === "any" ? "any" : normalizeComputeClass(requested),
    msatPerCredit: price,
    constraints: { ...legacyClassConstraints(requested), ...explicit }
  };
}

/**
 * The class and throughput weight a finished task is paid at. Hardware is self-reported, so a
 * CPU task is always paid as CPU work: an agent claiming a GPU or Apple tier earns the cpu base
 * rate (weight 1) on it, and only a real cpu-class agent keeps its own cpu tier weight. This
 * bounds what overstating hardware gains on the commonest task type until hardware is verified
 * (benchmarks / the SLA score). GPU tasks are paid at the agent's own class and tier.
 */
export function settlementClassFor(
  resourceClass: "cpu" | "gpu",
  agentClass: ComputeClassId,
  agentWeight: number
): { computeClass: ComputeClassId; creditsPerSecond: number } {
  if (resourceClass === "cpu" && agentClass !== "cpu") return { computeClass: "cpu", creditsPerSecond: 1 };
  return { computeClass: agentClass, creditsPerSecond: agentWeight };
}
