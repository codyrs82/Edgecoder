// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";

export interface TaskResultInput {
  ok: boolean;
  output: string;
  durationMs: number;
}

export interface AgentBehaviorStats {
  // Task quality
  totalTasks: number;
  successCount: number;
  successRate: number;
  emptyOutputCount: number;
  identicalOutputCount: number;
  recentOutputHashes: string[];
  avgOutputLength: number;

  // Timing
  avgDurationMs: number;
  minDurationMs: number;
  durationStdDev: number;
  suspiciouslyFastCount: number;

  // Protocol
  signatureFailureCount: number;
  replayAttemptCount: number;
  rateLimitHitCount: number;
  registrationCount: number;

  // Resource
  taskClaimCount: number;
  taskClaimRate: number;
  requeueCount: number;
  concurrentClaimCount: number;
  heartbeatGapMaxMs: number;

  windowStartMs: number;
  windowEndMs: number;
}

interface TimestampedEvent {
  timestampMs: number;
}

interface TaskEvent extends TimestampedEvent {
  ok: boolean;
  outputHash: string;
  outputLength: number;
  durationMs: number;
}

interface ProtocolEvent extends TimestampedEvent {
  type: "signature_failure" | "replay_attempt" | "rate_limit_hit";
}

interface RegistrationEvent extends TimestampedEvent {}

interface TaskClaimEvent extends TimestampedEvent {}

interface HeartbeatEvent extends TimestampedEvent {}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const OUTPUT_HASH_RING_SIZE = 20;

export class AgentBehaviorTracker {
  private readonly windowMs: number;
  private readonly agents = new Map<string, {
    tasks: TaskEvent[];
    protocolEvents: ProtocolEvent[];
    registrations: RegistrationEvent[];
    taskClaims: TaskClaimEvent[];
    heartbeats: HeartbeatEvent[];
    requeueCount: number;
    concurrentClaimCount: number;
  }>();

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  private getOrCreate(agentId: string) {
    let entry = this.agents.get(agentId);
    if (!entry) {
      entry = {
        tasks: [],
        protocolEvents: [],
        registrations: [],
        taskClaims: [],
        heartbeats: [],
        requeueCount: 0,
        concurrentClaimCount: 0,
      };
      this.agents.set(agentId, entry);
    }
    return entry;
  }

  private pruneWindow<T extends TimestampedEvent>(events: T[], now: number): T[] {
    const cutoff = now - this.windowMs;
    return events.filter(e => e.timestampMs >= cutoff);
  }

  private hashOutput(output: string): string {
    return createHash("sha256").update(output).digest("hex").slice(0, 16);
  }

  recordTaskResult(agentId: string, result: TaskResultInput, nowMs: number = Date.now()): void {
    const entry = this.getOrCreate(agentId);
    entry.tasks = this.pruneWindow(entry.tasks, nowMs);
    entry.tasks.push({
      timestampMs: nowMs,
      ok: result.ok,
      outputHash: this.hashOutput(result.output),
      outputLength: result.output.length,
      durationMs: result.durationMs,
    });
  }

  recordHeartbeat(agentId: string, nowMs: number = Date.now()): void {
    const entry = this.getOrCreate(agentId);
    entry.heartbeats = this.pruneWindow(entry.heartbeats, nowMs);
    entry.heartbeats.push({ timestampMs: nowMs });
  }

  recordRegistration(agentId: string, nowMs: number = Date.now()): void {
    const entry = this.getOrCreate(agentId);
    entry.registrations = this.pruneWindow(entry.registrations, nowMs);
    entry.registrations.push({ timestampMs: nowMs });
  }

  recordProtocolViolation(agentId: string, reason: "signature_failure" | "replay_attempt" | "rate_limit_hit", nowMs: number = Date.now()): void {
    const entry = this.getOrCreate(agentId);
    entry.protocolEvents = this.pruneWindow(entry.protocolEvents, nowMs);
    entry.protocolEvents.push({ timestampMs: nowMs, type: reason });
  }

  recordTaskClaim(agentId: string, nowMs: number = Date.now()): void {
    const entry = this.getOrCreate(agentId);
    entry.taskClaims = this.pruneWindow(entry.taskClaims, nowMs);
    entry.taskClaims.push({ timestampMs: nowMs });
  }

  recordRequeue(agentId: string): void {
    const entry = this.getOrCreate(agentId);
    entry.requeueCount += 1;
  }

  setConcurrentClaimCount(agentId: string, count: number): void {
    const entry = this.getOrCreate(agentId);
    entry.concurrentClaimCount = count;
  }

  getStats(agentId: string, nowMs: number = Date.now()): AgentBehaviorStats | null {
    const entry = this.agents.get(agentId);
    if (!entry) return null;

    // Prune all windows
    entry.tasks = this.pruneWindow(entry.tasks, nowMs);
    entry.protocolEvents = this.pruneWindow(entry.protocolEvents, nowMs);
    entry.registrations = this.pruneWindow(entry.registrations, nowMs);
    entry.taskClaims = this.pruneWindow(entry.taskClaims, nowMs);
    entry.heartbeats = this.pruneWindow(entry.heartbeats, nowMs);

    const tasks = entry.tasks;
    const totalTasks = tasks.length;
    const successCount = tasks.filter(t => t.ok).length;
    const successRate = totalTasks > 0 ? successCount / totalTasks : 1;
    const emptyOutputCount = tasks.filter(t => t.outputLength === 0).length;

    // Identical output detection: count max consecutive identical hashes
    let identicalOutputCount = 0;
    if (tasks.length >= 2) {
      let consecutiveRun = 1;
      for (let i = 1; i < tasks.length; i++) {
        if (tasks[i].outputHash === tasks[i - 1].outputHash) {
          consecutiveRun++;
          identicalOutputCount = Math.max(identicalOutputCount, consecutiveRun);
        } else {
          consecutiveRun = 1;
        }
      }
    }

    // Ring buffer of recent output hashes
    const recentOutputHashes = tasks.slice(-OUTPUT_HASH_RING_SIZE).map(t => t.outputHash);

    const totalOutputLength = tasks.reduce((sum, t) => sum + t.outputLength, 0);
    const avgOutputLength = totalTasks > 0 ? totalOutputLength / totalTasks : 0;

    // Timing
    const durations = tasks.map(t => t.durationMs);
    const avgDurationMs = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;
    const minDurationMs = durations.length > 0 ? Math.min(...durations) : 0;
    const durationStdDev = computeStdDev(durations, avgDurationMs);
    const suspiciouslyFastCount = tasks.filter(t => t.durationMs < 500).length;

    // Protocol
    const signatureFailureCount = entry.protocolEvents.filter(e => e.type === "signature_failure").length;
    const replayAttemptCount = entry.protocolEvents.filter(e => e.type === "replay_attempt").length;
    const rateLimitHitCount = entry.protocolEvents.filter(e => e.type === "rate_limit_hit").length;
    const registrationCount = entry.registrations.length;

    // Resource
    const taskClaimCount = entry.taskClaims.length;
    const windowDurationSec = this.windowMs / 1000;
    const taskClaimRate = windowDurationSec > 0 ? taskClaimCount / windowDurationSec : 0;

    // Heartbeat gap
    let heartbeatGapMaxMs = 0;
    if (entry.heartbeats.length >= 2) {
      const sorted = [...entry.heartbeats].sort((a, b) => a.timestampMs - b.timestampMs);
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i].timestampMs - sorted[i - 1].timestampMs;
        heartbeatGapMaxMs = Math.max(heartbeatGapMaxMs, gap);
      }
    }

    const windowStartMs = nowMs - this.windowMs;

    return {
      totalTasks,
      successCount,
      successRate,
      emptyOutputCount,
      identicalOutputCount,
      recentOutputHashes,
      avgOutputLength,
      avgDurationMs,
      minDurationMs,
      durationStdDev,
      suspiciouslyFastCount,
      signatureFailureCount,
      replayAttemptCount,
      rateLimitHitCount,
      registrationCount,
      taskClaimCount,
      taskClaimRate,
      requeueCount: entry.requeueCount,
      concurrentClaimCount: entry.concurrentClaimCount,
      heartbeatGapMaxMs,
      windowStartMs,
      windowEndMs: nowMs,
    };
  }
}

function computeStdDev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const sumSquaredDiffs = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  return Math.sqrt(sumSquaredDiffs / values.length);
}
