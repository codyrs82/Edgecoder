// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";
import { type BlacklistReasonCode } from "../common/types.js";
import { type SecurityLevel } from "../audit/security-events.js";
import { type AnomalyEvent } from "./anomaly-detector.js";

export interface Strike {
  timestampMs: number;
  anomalyEvent: AnomalyEvent;
}

export interface BlacklistAction {
  agentId: string;
  reasonCode: BlacklistReasonCode;
  reason: string;
  evidenceHashSha256: string;
  anomalyEvents: AnomalyEvent[];
}

const DEFAULT_STRIKE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_STRIKE_THRESHOLD = 3;

export class AutoBlacklister {
  private readonly strikeWindowMs: number;
  private readonly strikeThreshold: number;
  private readonly strikes = new Map<string, Strike[]>();
  private readonly onBlacklist: (action: BlacklistAction) => void;

  constructor(
    onBlacklist: (action: BlacklistAction) => void,
    strikeWindowMs: number = DEFAULT_STRIKE_WINDOW_MS,
    strikeThreshold: number = DEFAULT_STRIKE_THRESHOLD
  ) {
    this.onBlacklist = onBlacklist;
    this.strikeWindowMs = strikeWindowMs;
    this.strikeThreshold = strikeThreshold;
  }

  processAnomalies(agentId: string, anomalies: AnomalyEvent[], nowMs: number = Date.now()): BlacklistAction | null {
    if (anomalies.length === 0) return null;

    // CRITICAL severity → instant blacklist
    const critical = anomalies.find(a => a.severity === "CRITICAL");
    if (critical) {
      const action = this.buildBlacklistAction(agentId, anomalies);
      this.onBlacklist(action);
      return action;
    }

    // HIGH/WARN → accumulate strikes
    let agentStrikes = this.strikes.get(agentId) ?? [];
    const cutoff = nowMs - this.strikeWindowMs;
    agentStrikes = agentStrikes.filter(s => s.timestampMs >= cutoff);

    for (const anomaly of anomalies) {
      agentStrikes.push({ timestampMs: nowMs, anomalyEvent: anomaly });
    }
    this.strikes.set(agentId, agentStrikes);

    if (agentStrikes.length >= this.strikeThreshold) {
      const allAnomalies = agentStrikes.map(s => s.anomalyEvent);
      const action = this.buildBlacklistAction(agentId, allAnomalies);
      this.strikes.delete(agentId);
      this.onBlacklist(action);
      return action;
    }

    return null;
  }

  getStrikeCount(agentId: string, nowMs: number = Date.now()): number {
    const agentStrikes = this.strikes.get(agentId);
    if (!agentStrikes) return 0;
    const cutoff = nowMs - this.strikeWindowMs;
    return agentStrikes.filter(s => s.timestampMs >= cutoff).length;
  }

  private buildBlacklistAction(agentId: string, anomalies: AnomalyEvent[]): BlacklistAction {
    // Pick the most severe reason code from anomalies
    const severityOrder: SecurityLevel[] = ["CRITICAL", "HIGH", "WARN", "INFO"];
    const sorted = [...anomalies].sort(
      (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
    );
    const primary = sorted[0];

    const ruleIds = anomalies.map(a => a.ruleId).join(", ");
    const evidenceHash = createHash("sha256")
      .update(JSON.stringify(anomalies))
      .digest("hex");

    return {
      agentId,
      reasonCode: primary.blacklistReason,
      reason: `Auto-blacklisted by behavioral monitoring: ${ruleIds} — ${primary.description}`,
      evidenceHashSha256: evidenceHash,
      anomalyEvents: anomalies,
    };
  }
}
