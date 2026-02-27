// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { type BlacklistReasonCode } from "../common/types.js";
import { type SecurityLevel } from "../audit/security-events.js";
import { type AgentBehaviorStats } from "./behavior-tracker.js";

export interface AnomalyEvent {
  ruleId: string;
  ruleName: string;
  severity: SecurityLevel;
  blacklistReason: BlacklistReasonCode;
  description: string;
  stats: Record<string, unknown>;
}

export interface AnomalyConfig {
  // BHV001
  suspiciouslyFastMinCount: number;
  suspiciouslyFastAvgThresholdMs: number;
  // BHV002
  massEmptyMinCount: number;
  massEmptyRatioThreshold: number;
  // BHV003
  duplicateForgeryConsecutiveMin: number;
  // BHV004
  successCollapseMinTasks: number;
  successCollapseRateThreshold: number;
  // BHV005
  protocolAbuseThreshold: number;
  // BHV006
  heartbeatGapThresholdMs: number;
  // BHV007
  taskHoardingConcurrentMultiplier: number;
  taskHoardingRequeueThreshold: number;
  taskHoardingMaxConcurrent: number;
  // BHV008
  registrationStormThreshold: number;
  registrationStormWindowMs: number;
  // BHV009
  robotPrecisionStdDevThreshold: number;
  robotPrecisionMinTasks: number;
  // BHV010
  tinyOutputAvgLengthThreshold: number;
  tinyOutputMinTasks: number;
  tinyOutputMinSuccessRate: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  suspiciouslyFastMinCount: 3,
  suspiciouslyFastAvgThresholdMs: 1000,
  massEmptyMinCount: 5,
  massEmptyRatioThreshold: 0.6,
  duplicateForgeryConsecutiveMin: 3,
  successCollapseMinTasks: 10,
  successCollapseRateThreshold: 0.15,
  protocolAbuseThreshold: 5,
  heartbeatGapThresholdMs: 5 * 60 * 1000,
  taskHoardingConcurrentMultiplier: 2,
  taskHoardingRequeueThreshold: 8,
  taskHoardingMaxConcurrent: 1,
  registrationStormThreshold: 10,
  registrationStormWindowMs: 10 * 60 * 1000,
  robotPrecisionStdDevThreshold: 50,
  robotPrecisionMinTasks: 10,
  tinyOutputAvgLengthThreshold: 10,
  tinyOutputMinTasks: 5,
  tinyOutputMinSuccessRate: 0.8,
};

type AnomalyRule = (stats: AgentBehaviorStats, config: AnomalyConfig) => AnomalyEvent | null;

const bhv001SuspiciouslyFast: AnomalyRule = (stats, config) => {
  if (
    stats.suspiciouslyFastCount >= config.suspiciouslyFastMinCount &&
    stats.avgDurationMs < config.suspiciouslyFastAvgThresholdMs
  ) {
    return {
      ruleId: "BHV001",
      ruleName: "Suspiciously fast",
      severity: "CRITICAL",
      blacklistReason: "forged_results",
      description: `${stats.suspiciouslyFastCount} tasks completed in <500ms with avg ${Math.round(stats.avgDurationMs)}ms`,
      stats: { suspiciouslyFastCount: stats.suspiciouslyFastCount, avgDurationMs: stats.avgDurationMs },
    };
  }
  return null;
};

const bhv002MassEmptyOutputs: AnomalyRule = (stats, config) => {
  if (stats.totalTasks === 0) return null;
  const emptyRatio = stats.emptyOutputCount / stats.totalTasks;
  if (stats.emptyOutputCount >= config.massEmptyMinCount && emptyRatio > config.massEmptyRatioThreshold) {
    return {
      ruleId: "BHV002",
      ruleName: "Mass empty outputs",
      severity: "HIGH",
      blacklistReason: "forged_results",
      description: `${stats.emptyOutputCount}/${stats.totalTasks} tasks returned empty output (${(emptyRatio * 100).toFixed(0)}%)`,
      stats: { emptyOutputCount: stats.emptyOutputCount, totalTasks: stats.totalTasks, emptyRatio },
    };
  }
  return null;
};

const bhv003DuplicateForgery: AnomalyRule = (stats, config) => {
  if (stats.identicalOutputCount >= config.duplicateForgeryConsecutiveMin) {
    return {
      ruleId: "BHV003",
      ruleName: "Duplicate forgery",
      severity: "CRITICAL",
      blacklistReason: "forged_results",
      description: `${stats.identicalOutputCount} consecutive identical output hashes`,
      stats: { identicalOutputCount: stats.identicalOutputCount },
    };
  }
  return null;
};

const bhv004SuccessCollapse: AnomalyRule = (stats, config) => {
  if (stats.totalTasks >= config.successCollapseMinTasks && stats.successRate < config.successCollapseRateThreshold) {
    return {
      ruleId: "BHV004",
      ruleName: "Success collapse",
      severity: "HIGH",
      blacklistReason: "policy_violation",
      description: `Success rate ${(stats.successRate * 100).toFixed(0)}% over ${stats.totalTasks} tasks`,
      stats: { successRate: stats.successRate, totalTasks: stats.totalTasks },
    };
  }
  return null;
};

const bhv005ProtocolAbuse: AnomalyRule = (stats, config) => {
  const total = stats.signatureFailureCount + stats.replayAttemptCount;
  if (total >= config.protocolAbuseThreshold) {
    return {
      ruleId: "BHV005",
      ruleName: "Protocol abuse",
      severity: "CRITICAL",
      blacklistReason: "credential_abuse",
      description: `${total} protocol violations (${stats.signatureFailureCount} sig failures, ${stats.replayAttemptCount} replay attempts)`,
      stats: { signatureFailureCount: stats.signatureFailureCount, replayAttemptCount: stats.replayAttemptCount },
    };
  }
  return null;
};

const bhv006HeartbeatManipulation: AnomalyRule = (stats, config) => {
  if (stats.heartbeatGapMaxMs > config.heartbeatGapThresholdMs && stats.taskClaimCount > 0) {
    return {
      ruleId: "BHV006",
      ruleName: "Heartbeat manipulation",
      severity: "HIGH",
      blacklistReason: "dos_behavior",
      description: `Max heartbeat gap ${Math.round(stats.heartbeatGapMaxMs / 1000)}s while still claiming tasks`,
      stats: { heartbeatGapMaxMs: stats.heartbeatGapMaxMs, taskClaimCount: stats.taskClaimCount },
    };
  }
  return null;
};

const bhv007TaskHoarding: AnomalyRule = (stats, config) => {
  const concurrentThreshold = config.taskHoardingConcurrentMultiplier * config.taskHoardingMaxConcurrent;
  if (
    stats.concurrentClaimCount > concurrentThreshold ||
    stats.requeueCount >= config.taskHoardingRequeueThreshold
  ) {
    return {
      ruleId: "BHV007",
      ruleName: "Task hoarding",
      severity: "HIGH",
      blacklistReason: "dos_behavior",
      description: `Concurrent claims: ${stats.concurrentClaimCount} (limit: ${concurrentThreshold}), requeues: ${stats.requeueCount}`,
      stats: { concurrentClaimCount: stats.concurrentClaimCount, requeueCount: stats.requeueCount },
    };
  }
  return null;
};

const bhv008RegistrationStorm: AnomalyRule = (stats, config) => {
  if (stats.registrationCount >= config.registrationStormThreshold) {
    return {
      ruleId: "BHV008",
      ruleName: "Registration storm",
      severity: "HIGH",
      blacklistReason: "dos_behavior",
      description: `${stats.registrationCount} registrations in window`,
      stats: { registrationCount: stats.registrationCount },
    };
  }
  return null;
};

const bhv009RobotPrecision: AnomalyRule = (stats, config) => {
  if (
    stats.durationStdDev < config.robotPrecisionStdDevThreshold &&
    stats.totalTasks >= config.robotPrecisionMinTasks
  ) {
    return {
      ruleId: "BHV009",
      ruleName: "Robot precision",
      severity: "WARN",
      blacklistReason: "forged_results",
      description: `Duration stddev ${stats.durationStdDev.toFixed(1)}ms over ${stats.totalTasks} tasks (unnaturally consistent)`,
      stats: { durationStdDev: stats.durationStdDev, totalTasks: stats.totalTasks },
    };
  }
  return null;
};

const bhv010TinyOutputs: AnomalyRule = (stats, config) => {
  if (
    stats.avgOutputLength < config.tinyOutputAvgLengthThreshold &&
    stats.totalTasks >= config.tinyOutputMinTasks &&
    stats.successRate > config.tinyOutputMinSuccessRate
  ) {
    return {
      ruleId: "BHV010",
      ruleName: "Tiny outputs",
      severity: "WARN",
      blacklistReason: "forged_results",
      description: `Avg output length ${stats.avgOutputLength.toFixed(1)} over ${stats.totalTasks} "successful" tasks`,
      stats: { avgOutputLength: stats.avgOutputLength, totalTasks: stats.totalTasks, successRate: stats.successRate },
    };
  }
  return null;
};

const ALL_RULES: AnomalyRule[] = [
  bhv001SuspiciouslyFast,
  bhv002MassEmptyOutputs,
  bhv003DuplicateForgery,
  bhv004SuccessCollapse,
  bhv005ProtocolAbuse,
  bhv006HeartbeatManipulation,
  bhv007TaskHoarding,
  bhv008RegistrationStorm,
  bhv009RobotPrecision,
  bhv010TinyOutputs,
];

export class AnomalyDetector {
  private readonly config: AnomalyConfig;

  constructor(config: Partial<AnomalyConfig> = {}) {
    this.config = { ...DEFAULT_ANOMALY_CONFIG, ...config };
  }

  evaluate(stats: AgentBehaviorStats): AnomalyEvent[] {
    const events: AnomalyEvent[] = [];
    for (const rule of ALL_RULES) {
      const result = rule(stats, this.config);
      if (result) events.push(result);
    }
    return events;
  }
}
