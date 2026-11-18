// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Does this agent claim its GPU? The class the coordinator prices it at (src/economy/compute-classes.ts
 * classifyHardware) follows the profile, then the coordinator's benchmark challenge
 * (src/swarm/hardware-verification.ts) grants or demotes. For cards a vendor stack drives (CUDA,
 * ROCm on a supported target, Apple silicon) the detected GPU is claimed as before. For cards only
 * Vulkan can drive, or that only sysfs found (src/install/hardware.ts gpuNeedsOffloadProof), Ollama
 * may well be running the model on the CPU, so the agent claims the GPU only on evidence that it
 * does not:
 *
 *   1. Ollama's /api/ps: the served model (else the largest loaded one) has size_vram >= 90% of its
 *      size -> offload confirmed; less -> partial offload, CPU class;
 *   2. else the agent's own GPU benchmark: effective bandwidth at least the GPU class floor
 *      (DEFAULT_TIER_MINIMUMS gpu.c8 / slack, what the coordinator itself requires) -> GPU;
 *      below -> CPU;
 *   3. else the previous decision (nothing loaded right now says nothing), CPU at start.
 *
 * Both are self-reported, so this only keeps an honest host from claiming a class its engine does not
 * deliver; the coordinator's challenge is still what grants a tier above the class base.
 */
import { DEFAULT_TIER_MINIMUMS } from "./hardware-verification.js";

/** Fraction of a loaded model that must sit in VRAM to count as "on the GPU". */
export const OFFLOAD_MIN_FRACTION = 0.9;
/** The GPU class floor in GB/s: gpu.c8's minimum over the coordinator's default slack (1.25). */
export const GPU_CLASS_MIN_BANDWIDTH_GBPS = DEFAULT_TIER_MINIMUMS["gpu.c8"] / 1.25;

export interface LoadedModel {
  name: string;
  sizeBytes: number;
  vramBytes: number;
}

export type GpuClaimEvidence = "detected" | "offload" | "partial_offload" | "benchmark" | "slow_benchmark" | "unconfirmed";

export interface GpuClaimDecision {
  claimGpu: boolean;
  evidence: GpuClaimEvidence;
  detail: string;
}

const strip = (n: string) => n.replace(/:latest$/, "");

export function decideGpuClaim(input: {
  /** src/install/hardware.ts gpuNeedsOffloadProof for the reported card. */
  needsProof: boolean;
  /** Ollama /api/ps, when it answered. */
  loaded?: LoadedModel[];
  /** The model the agent serves. */
  model?: string;
  /** The agent's last self-benchmark GPU bandwidth (GB/s). */
  benchmarkBandwidthGbps?: number;
  previous?: boolean;
}): GpuClaimDecision {
  if (!input.needsProof) return { claimGpu: true, evidence: "detected", detail: "GPU detected by its vendor stack" };
  const loaded = (input.loaded ?? []).filter((m) => m.sizeBytes > 0);
  const mine = input.model ? loaded.find((m) => strip(m.name) === strip(input.model as string)) : undefined;
  const pick = mine ?? [...loaded].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
  if (pick) {
    const pct = Math.round((Math.min(pick.vramBytes, pick.sizeBytes) / pick.sizeBytes) * 100);
    return pick.vramBytes >= pick.sizeBytes * OFFLOAD_MIN_FRACTION
      ? { claimGpu: true, evidence: "offload", detail: `Ollama has ${pick.name} ${pct}% in VRAM` }
      : { claimGpu: false, evidence: "partial_offload", detail: `Ollama has ${pick.name} only ${pct}% in VRAM (the rest on the CPU)` };
  }
  const bw = input.benchmarkBandwidthGbps;
  if (typeof bw === "number" && Number.isFinite(bw) && bw > 0) {
    return bw >= GPU_CLASS_MIN_BANDWIDTH_GBPS
      ? { claimGpu: true, evidence: "benchmark", detail: `benchmark ${bw} GB/s, at least the GPU floor ${GPU_CLASS_MIN_BANDWIDTH_GBPS} GB/s` }
      : { claimGpu: false, evidence: "slow_benchmark", detail: `benchmark ${bw} GB/s, below the GPU floor ${GPU_CLASS_MIN_BANDWIDTH_GBPS} GB/s` };
  }
  return { claimGpu: input.previous ?? false, evidence: "unconfirmed", detail: "no model loaded and no GPU benchmark yet" };
}

/** The profile the agent registers with: the detected one, or the same without its GPU (CPU class). */
export function claimedProfile(detected: Record<string, unknown>, claimGpu: boolean): Record<string, unknown> {
  if (claimGpu || !detected.gpu) return detected;
  const { gpu: _gpu, ...rest } = detected;
  return rest;
}
