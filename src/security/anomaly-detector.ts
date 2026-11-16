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
  /**
   * "flag": not a strike and never a blacklist on its own. The coordinator logs it and acts on it
   * otherwise (BHV001: the agent's next verifiable results are sent to verification).
   * Absent: a strike (CRITICAL blacklists at once, HIGH/WARN accumulate; AutoBlacklister).
   */
  enforcement?: "flag";
}

export interface AnomalyConfig {
  // BHV001 (fast-result thresholds per kind: FAST_RESULT_THRESHOLD_MS in behavior-tracker.ts)
  /** Fast successful results in the window that flag the agent for verification. */
  suspiciouslyFastMinCount: number;
  /** Fast results of kinds the coordinator cannot verify that make a sustained pattern (a strike). */
  suspiciouslyFastSustainedCount: number;
  /** ...when they are at least this share of that agent's successful results of those kinds. */
  suspiciouslyFastSustainedRatio: number;
  /**
   * Kinds whose results the coordinator verifies by re-execution (result verification on and a
   * comparator for the kind). Fast results of these kinds are only ever sent to verification, and
   * a forged one is then caught by the verification-mismatch rule (VRF001), never by speed alone.
   */
  suspiciouslyFastVerifiableKinds: string[];
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
  // BHV006 (the window is the tracker's abandonedClaimWindowMs, 24 h by default)
  /**
   * Abandoned claims that make a pattern: this many since the agent last returned any result (it
   * reconnected and kept claiming without completing), or this many that ran past their deadline
   * while it was heartbeating. A heartbeat gap alone is never a strike (sleep, an update restart).
   */
  abandonedClaimThreshold: number;
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
  suspiciouslyFastSustainedCount: 20,
  suspiciouslyFastSustainedRatio: 0.8,
  suspiciouslyFastVerifiableKinds: [],
  massEmptyMinCount: 5,
  massEmptyRatioThreshold: 0.6,
  duplicateForgeryConsecutiveMin: 3,
  successCollapseMinTasks: 10,
  successCollapseRateThreshold: 0.15,
  protocolAbuseThreshold: 5,
  abandonedClaimThreshold: 5,
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

/**
 * BHV001, on coordinator-measured durations (claim to result receipt) against a per-kind threshold.
 * Graduated: a few fast results only flag the agent (its next verifiable results go to
 * verification); a strike needs a sustained pattern of fast results the coordinator cannot check
 * by re-execution. Fast results of verifiable kinds never strike: verification decides those.
 */
const bhv001SuspiciouslyFast: AnomalyRule = (stats, config) => {
  const verifiable = new Set(config.suspiciouslyFastVerifiableKinds);
  let unverifiableFast = 0;
  let unverifiableOk = 0;
  for (const [kind, counts] of Object.entries(stats.fastResultsByKind ?? {})) {
    if (verifiable.has(kind)) continue;
    unverifiableFast += counts.fast;
    unverifiableOk += counts.ok;
  }
  if (
    unverifiableFast >= config.suspiciouslyFastSustainedCount &&
    unverifiableOk > 0 &&
    unverifiableFast / unverifiableOk >= config.suspiciouslyFastSustainedRatio
  ) {
    return {
      ruleId: "BHV001",
      ruleName: "Suspiciously fast",
      severity: "HIGH",
      blacklistReason: "forged_results",
      description: `${unverifiableFast}/${unverifiableOk} unverifiable results returned faster than their kind's minimum (server-measured)`,
      stats: { suspiciouslyFastCount: stats.suspiciouslyFastCount, unverifiableFast, unverifiableOk, fastResultsByKind: stats.fastResultsByKind },
    };
  }
  if (stats.suspiciouslyFastCount >= config.suspiciouslyFastMinCount) {
    return {
      ruleId: "BHV001",
      ruleName: "Suspiciously fast",
      severity: "WARN",
      blacklistReason: "forged_results",
      description: `${stats.suspiciouslyFastCount} results returned faster than their kind's minimum (server-measured); flagged for verification`,
      stats: { suspiciouslyFastCount: stats.suspiciouslyFastCount, fastResultsByKind: stats.fastResultsByKind },
      enforcement: "flag",
    };
  }
  return null;
};

/*
 * Output-content rules (BHV002 empty, BHV003 identical, BHV010 tiny) flag, never strike. A code
 * result's output is what the requester's program prints, so a buyer can make an honest worker's
 * outputs empty, identical or tiny at will (three "print('OK')" jobs used to blacklist the worker
 * instantly through BHV003). A flag sends the agent's next results to re-execution verification,
 * which decides; see docs/security/agent-threat-model.md.
 */
const bhv002MassEmptyOutputs: AnomalyRule = (stats, config) => {
  if (stats.totalTasks === 0) return null;
  if (stats.outputTasks === 0) return null;
  const emptyRatio = stats.emptyOutputCount / stats.outputTasks;
  if (stats.emptyOutputCount >= config.massEmptyMinCount && emptyRatio > config.massEmptyRatioThreshold) {
    return {
      ruleId: "BHV002",
      ruleName: "Mass empty outputs",
      severity: "WARN",
      blacklistReason: "forged_results",
      description: `${stats.emptyOutputCount}/${stats.outputTasks} code tasks returned empty output (${(emptyRatio * 100).toFixed(0)}%)`,
      stats: { emptyOutputCount: stats.emptyOutputCount, totalTasks: stats.outputTasks, emptyRatio },
      enforcement: "flag",
    };
  }
  return null;
};

const bhv003DuplicateForgery: AnomalyRule = (stats, config) => {
  if (stats.identicalOutputCount >= config.duplicateForgeryConsecutiveMin) {
    return {
      ruleId: "BHV003",
      ruleName: "Duplicate forgery",
      severity: "WARN",
      blacklistReason: "forged_results",
      description: `${stats.identicalOutputCount} consecutive identical output hashes`,
      stats: { identicalOutputCount: stats.identicalOutputCount },
      enforcement: "flag",
    };
  }
  return null;
};

const bhv004SuccessCollapse: AnomalyRule = (stats, config) => {
  // Counts agent failures only (a program error is a correctly executed job), and at most a few per
  // submitter (AgentBehaviorTracker): a buyer whose programs exit non-zero can't collapse it.
  const counted = stats.rateTasks ?? stats.totalTasks;
  if (counted >= config.successCollapseMinTasks && stats.successRate < config.successCollapseRateThreshold) {
    return {
      ruleId: "BHV004",
      ruleName: "Success collapse",
      severity: "HIGH",
      blacklistReason: "policy_violation",
      description: `Success rate ${(stats.successRate * 100).toFixed(0)}% over ${counted} tasks`,
      stats: { successRate: stats.successRate, totalTasks: counted, cappedFailureCount: stats.cappedFailureCount ?? 0 },
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

/**
 * BHV006 "abandoned claims". A heartbeat gap is not misbehaviour: a laptop sleeps, the desktop app
 * restarts to finish an update, a network drops. The claims it held are requeued at lease expiry
 * (src/swarm/queue.ts), and an agent that announces it is going offline hands them back at once and
 * abandons nothing. Only a pattern strikes: the agent keeps claiming and abandoning without ever
 * returning a result, or keeps holding claims past their deadline while heartbeating.
 */
const bhv006AbandonedClaims: AnomalyRule = (stats, config) => {
  const streak = stats.abandonedClaimStreak ?? 0;
  const whileActive = stats.abandonedWhileActiveCount ?? 0;
  if (streak < config.abandonedClaimThreshold && whileActive < config.abandonedClaimThreshold) return null;
  const description = streak >= config.abandonedClaimThreshold
    ? `${streak} claims abandoned in a row without returning a result (lease lapsed; ${stats.abandonedClaimCount ?? streak} in the window)`
    : `${whileActive} claims held past their deadline while heartbeating`;
  return {
    ruleId: "BHV006",
    ruleName: "Abandoned claims",
    severity: "HIGH",
    blacklistReason: "dos_behavior",
    description,
    stats: { abandonedClaimCount: stats.abandonedClaimCount ?? 0, abandonedClaimStreak: streak, abandonedWhileActiveCount: whileActive, heartbeatGapMaxMs: stats.heartbeatGapMaxMs },
  };
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
    // Code results only: model calls are timed by their prompt and model (see BehaviorStats.codeDurationStdDev).
    (stats.codeTimingTasks ?? 0) >= config.robotPrecisionMinTasks &&
    (stats.codeDurationStdDev ?? Infinity) < config.robotPrecisionStdDevThreshold
  ) {
    return {
      ruleId: "BHV009",
      ruleName: "Robot precision",
      severity: "WARN",
      blacklistReason: "forged_results",
      description: `Duration stddev ${(stats.codeDurationStdDev ?? 0).toFixed(1)}ms over ${stats.codeTimingTasks} code tasks (unnaturally consistent)`,
      stats: { durationStdDev: stats.codeDurationStdDev ?? 0, totalTasks: stats.codeTimingTasks ?? 0 },
    };
  }
  return null;
};

const bhv010TinyOutputs: AnomalyRule = (stats, config) => {
  if (
    stats.avgOutputLength < config.tinyOutputAvgLengthThreshold &&
    stats.outputTasks >= config.tinyOutputMinTasks &&
    stats.successRate > config.tinyOutputMinSuccessRate
  ) {
    return {
      ruleId: "BHV010",
      ruleName: "Tiny outputs",
      severity: "WARN",
      blacklistReason: "forged_results",
      description: `Avg output length ${stats.avgOutputLength.toFixed(1)} over ${stats.outputTasks} code tasks`,
      stats: { avgOutputLength: stats.avgOutputLength, totalTasks: stats.totalTasks, successRate: stats.successRate },
      enforcement: "flag",
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
  bhv006AbandonedClaims,
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
