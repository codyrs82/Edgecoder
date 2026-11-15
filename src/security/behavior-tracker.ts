// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";

export interface TaskResultInput {
  ok: boolean;
  output: string;
  /**
   * The coordinator's own measurement, claim to result receipt (serverMeasuredDurationMs in
   * src/swarm/result-integrity.ts). Never the duration the agent reports: an honest agent reports
   * only its sandbox run (fast), and a cheater can report whatever it likes.
   */
  durationMs: number;
  /** Subtask kind ("micro_loop" | "single_step" | "inference"); sets the "fast" threshold. */
  kind?: string;
}

/**
 * BHV001: a successful result received sooner than this after its claim (server-measured) is
 * "suspiciously fast" for its kind. The time includes the pull response, the agent's model call
 * and (for code) a sandbox run, and the result upload.
 * - Code kinds (micro_loop, single_step): the agent generates a program with a model and runs it in
 *   a container; under 300 ms end to end is not something an honest run does. Being fast only
 *   sends results to verification (see the anomaly detector), so this can be tight.
 * - inference: one model call with no sandbox; a hot GPU can answer a short prompt in a few hundred
 *   ms, so only under 100 ms counts.
 * Unknown kinds use the code threshold.
 */
export const FAST_RESULT_THRESHOLD_MS: Readonly<Record<string, number>> = {
  micro_loop: 300,
  single_step: 300,
  inference: 100,
};
export const DEFAULT_FAST_RESULT_THRESHOLD_MS = 300;

export function fastResultThresholdMs(kind: string | undefined): number {
  return (kind !== undefined && Object.prototype.hasOwnProperty.call(FAST_RESULT_THRESHOLD_MS, kind))
    ? FAST_RESULT_THRESHOLD_MS[kind]
    : DEFAULT_FAST_RESULT_THRESHOLD_MS;
}

/** Fast successful results and all successful results of one subtask kind, in the window. */
export interface FastResultCounts {
  fast: number;
  ok: number;
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
  /** Successful results faster than their kind's threshold (fastResultThresholdMs). */
  suspiciouslyFastCount: number;
  /** The same per subtask kind ("unknown" when the kind wasn't recorded). */
  fastResultsByKind?: Record<string, FastResultCounts>;

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
  kind?: string;
}

interface ProtocolEvent extends TimestampedEvent {
  type: "signature_failure" | "replay_attempt" | "rate_limit_hit";
}

interface RegistrationEvent extends TimestampedEvent {}

interface TaskClaimEvent extends TimestampedEvent {}

interface HeartbeatEvent extends TimestampedEvent {}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
/** BHV008 counts registrations over 10 minutes, not the hour-long window: a healthy worker
 *  refreshes every 4 minutes (15 an hour), which the hour window read as a storm. */
export const REGISTRATION_STORM_WINDOW_MS = 10 * 60 * 1000;
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
      kind: result.kind,
    });
  }

  recordHeartbeat(agentId: string, nowMs: number = Date.now()): void {
    const entry = this.getOrCreate(agentId);
    entry.heartbeats = this.pruneWindow(entry.heartbeats, nowMs);
    entry.heartbeats.push({ timestampMs: nowMs });
  }

  /** Forget an agent's history (an admin lifted its blacklist). */
  reset(agentId: string): void {
    this.agents.delete(agentId);
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
    // The forgery signals (empty, identical or impossibly fast results) look only at results the
    // agent reported as successful: a failed result earns nothing, and an agent whose model is
    // broken fails fast with empty output, which is not fraud.
    const okTasks = tasks.filter(t => t.ok);
    const emptyOutputCount = okTasks.filter(t => t.outputLength === 0).length;

    // Identical output detection: count max consecutive identical hashes
    let identicalOutputCount = 0;
    if (okTasks.length >= 2) {
      let consecutiveRun = 1;
      for (let i = 1; i < okTasks.length; i++) {
        if (okTasks[i].outputHash === okTasks[i - 1].outputHash) {
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
    const fastResultsByKind: Record<string, FastResultCounts> = {};
    let suspiciouslyFastCount = 0;
    for (const t of okTasks) {
      const key = t.kind ?? "unknown";
      const counts = (fastResultsByKind[key] ??= { fast: 0, ok: 0 });
      counts.ok += 1;
      if (t.durationMs < fastResultThresholdMs(t.kind)) {
        counts.fast += 1;
        suspiciouslyFastCount += 1;
      }
    }

    // Protocol
    const signatureFailureCount = entry.protocolEvents.filter(e => e.type === "signature_failure").length;
    const replayAttemptCount = entry.protocolEvents.filter(e => e.type === "replay_attempt").length;
    const rateLimitHitCount = entry.protocolEvents.filter(e => e.type === "rate_limit_hit").length;
    const registrationCount = entry.registrations.filter(e => e.timestampMs >= nowMs - REGISTRATION_STORM_WINDOW_MS).length;

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
      fastResultsByKind,
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
