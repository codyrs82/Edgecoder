// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { CapabilitySummaryPayload } from "../common/types.js";

export interface AgentCapabilityInfo {
  agentId: string;
  activeModel: string;
  activeModelParamSize: number;
  currentLoad: number;
}

export function buildCapabilitySummary(
  coordinatorId: string,
  agents: AgentCapabilityInfo[],
): CapabilitySummaryPayload {
  const modelMap: CapabilitySummaryPayload["modelAvailability"] = {};

  for (const agent of agents) {
    if (!agent.activeModel) continue;
    const key = agent.activeModel;
    if (!modelMap[key]) {
      modelMap[key] = { agentCount: 0, totalParamCapacity: 0, avgLoad: 0 };
    }
    modelMap[key].agentCount += 1;
    modelMap[key].totalParamCapacity += agent.activeModelParamSize;
    modelMap[key].avgLoad += agent.currentLoad;
  }

  for (const entry of Object.values(modelMap)) {
    if (entry.agentCount > 0) {
      entry.avgLoad = entry.avgLoad / entry.agentCount;
    }
  }

  return {
    coordinatorId,
    agentCount: agents.length,
    modelAvailability: modelMap,
    timestamp: Date.now(),
  };
}
