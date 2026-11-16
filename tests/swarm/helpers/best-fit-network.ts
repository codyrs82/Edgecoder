// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The network as of Nov 2026, for best-fit routing tests: nine CPU agents with
 * qwen2.5-coder:1.5b, one 2xA16 GPU with qwen3-coder:30b on one slot, and Macs with 7b, 14b and
 * 1.5b coders.
 */
import type { AgentView, NetworkView } from "../../../src/swarm/coordinator/best-fit.js";

export function agent(over: Partial<AgentView> & Pick<AgentView, "agentId" | "computeClass" | "models">): AgentView {
  return {
    label: `${over.computeClass}-${over.agentId}`,
    coordinatorId: "coord-a",
    local: true,
    tierWeight: 1,
    activeModel: over.models[0],
    slots: 1,
    freeSlots: 1,
    verified: true,
    rttMs: 40,
    stale: false,
    ...over,
  };
}

export function currentNetwork(over: { gpuFree?: number; gpuWaiting?: number } = {}): NetworkView {
  const cpus = Array.from({ length: 9 }, (_, i) => agent({ agentId: `cpu${i + 1}`, computeClass: "cpu", models: ["qwen2.5-coder:1.5b"], tokensPerSec: 18, contextWindow: 16_384 }));
  return {
    agents: [
      ...cpus,
      agent({ agentId: "gpu1", computeClass: "gpu", models: ["qwen3-coder:30b"], tokensPerSec: 40, contextWindow: 32_768, freeSlots: over.gpuFree ?? 1, tierWeight: 2 }),
      agent({ agentId: "mac7", computeClass: "apple", models: ["qwen2.5-coder:7b"], tokensPerSec: 22, contextWindow: 32_768 }),
      agent({ agentId: "mac14", computeClass: "apple", models: ["qwen2.5-coder:14b"], tokensPerSec: 12, contextWindow: 32_768 }),
      agent({ agentId: "mac15", computeClass: "apple", models: ["qwen2.5-coder:1.5b"], tokensPerSec: 60, contextWindow: 32_768 }),
    ],
    pickupP50Ms: 250,
    waitingByModel: over.gpuWaiting ? { "qwen3-coder:30b": over.gpuWaiting } : {},
    btcUsd: 100_000,
  };
}
