// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Power limits on the coordinator side (network run 22).
 *
 * /pull applies the agent's power policy (src/swarm/power-policy.ts) from the telemetry the agent
 * sends with /register and /heartbeat. A laptop on low battery takes small jobs only (timeoutMs up to
 * SMALL_TASK_MAX_TIMEOUT_MS), which rules out every network model call. Before run 22 this was
 * checked only after the claim: desktop-maw-mb-02 (laptop_battery_low) still counted as a free Apple
 * host in /inference/models freeHosts, best fit and locality, so the portal's latency rule kept
 * sending lhr/fra buyers' 1.5b calls to it. It claimed each one, handed it back
 * ("power_small_task_filter", 39 times), and the claim had used up the call's locality hold, so a
 * distant CPU host took it with no preference.
 *
 * Now the same decision is applied wherever a host is judged free or ready for a call, and the
 * claim itself is never made.
 */

import { evaluateAgentPowerPolicy, iosAgentNotCharging, powerAllowsTask, type AgentPowerTelemetry, type PowerPolicyDecision } from "../power-policy.js";
import { IOS_BATTERY_PULL_MIN_INTERVAL_MS, IOS_BATTERY_TASK_STOP_LEVEL_PCT } from "./context.js";
import { agentCapabilities, lastTaskAssignedByAgent } from "./agent-state.js";

type PowerCapability = { os?: string; clientType?: string; powerTelemetry?: AgentPowerTelemetry };

/** The agent's power decision now, as /pull applies it; undefined for an agent not registered here. */
export function agentPowerDecision(agentId: string, nowMs = Date.now(), cap: PowerCapability | undefined = agentCapabilities.get(agentId)): PowerPolicyDecision | undefined {
  if (!cap) return undefined;
  // iPhones take coordinator jobs only while charging (/pull answers them idle otherwise).
  if (iosAgentNotCharging(cap)) return { allowCoordinatorTasks: false, allowPeerDirectWork: false, reason: "ios_not_charging" };
  return evaluateAgentPowerPolicy({
    os: cap.os ?? "",
    telemetry: cap.powerTelemetry,
    nowMs,
    lastTaskAssignedAtMs: lastTaskAssignedByAgent.get(agentId),
    batteryPullMinIntervalMs: IOS_BATTERY_PULL_MIN_INTERVAL_MS,
    batteryTaskStopLevelPct: IOS_BATTERY_TASK_STOP_LEVEL_PCT,
  });
}

/**
 * Whether the agent's power state refuses a job with this timeout now. `timeoutMs` undefined: a
 * network model call of unknown length (free-host counts, best fit), which a small-tasks-only host
 * refuses.
 */
export function powerRefuses(agentId: string, timeoutMs: number | undefined, nowMs = Date.now()): boolean {
  return !powerAllowsTask(agentPowerDecision(agentId, nowMs), timeoutMs);
}

/**
 * What the agent's heartbeat reply and /capacity say about its power limits: whether it takes
 * coordinator jobs, and, when it takes small jobs only, the longest one it takes (acceptsSmall: it
 * takes jobs up to maxTaskTimeoutMs; acceptsModelCalls: false while network model calls are refused).
 */
export function powerLimitReport(decision: PowerPolicyDecision | undefined): { acceptsTasks: boolean; acceptsModelCalls: boolean; smallTasksOnly: boolean; maxTaskTimeoutMs?: number; reason: string } | undefined {
  if (!decision) return undefined;
  return {
    acceptsTasks: decision.allowCoordinatorTasks,
    acceptsModelCalls: powerAllowsTask(decision, undefined),
    smallTasksOnly: decision.allowSmallTasksOnly === true,
    ...(decision.allowSmallTasksOnly && decision.maxTaskTimeoutMs !== undefined ? { maxTaskTimeoutMs: decision.maxTaskTimeoutMs } : {}),
    reason: decision.reason,
  };
}
