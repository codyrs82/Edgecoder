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
  /**
   * How the coordinator judged the result (src/swarm/result-outcome.ts). "program_error": the agent
   * ran the job and the program failed; it is a correctly executed job for the failure-rate rules,
   * and a paid result for the forgery signals. Default: "ok" when ok, else "agent_failure".
   */
  outcome?: "ok" | "program_error" | "agent_failure";
  /**
   * The account that submitted the job. At most submitterFailureCap agent failures from one
   * submitter count toward the failure-rate rules in the window, so one buyer can't sink a worker.
   * Absent: one shared "unattributed" bucket.
   */
  submitter?: string;
  /** Lets a verification verdict excuse the failure later (excuseFailure). */
  subtaskId?: string;
}

/**
 * BHV006 counts abandoned claims (a claim whose lease lapsed: the holder went quiet, or ran past
 * the subtask's hard deadline) over this window, not the hour-long one: the rule looks for a
 * pattern, and one laptop sleep or app restart is a single abandoned claim, not misbehaviour.
 */
export const DEFAULT_ABANDONED_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Agent failures from one submitter that count toward the failure-rate rules per window (default). */
export const DEFAULT_SUBMITTER_FAILURE_CAP = 3;

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
  /**
   * Results that were not agent failures (successes and program errors), among the results the
   * failure-rate rules count: agent failures over a submitter's cap are left out of both.
   */
  successCount: number;
  successRate: number;
  /** Results the failure-rate rules (BHV004) count: totalTasks minus capped-out failures. */
  rateTasks?: number;
  /** Agent failures left out because their submitter was already at its cap. */
  cappedFailureCount?: number;
  emptyOutputCount: number;
  identicalOutputCount: number;
  recentOutputHashes: string[];
  avgOutputLength: number;
  /**
   * Results the output-content rules (BHV002 empty, BHV003 identical, BHV010 tiny) look at: code
   * results only. A model call's output is whatever the requester's prompt asks for: a one-word or
   * repeated answer is often the right one (live regtest, 2026-11-15: short factual answers got every
   * honest agent blacklisted). Model calls are covered by BHV001 and result verification instead.
   */
  outputTasks: number;

  // Timing
  avgDurationMs: number;
  minDurationMs: number;
  durationStdDev: number;
  /**
   * Duration spread over code results only (BHV009 "robot precision"). A model call's duration
   * follows its prompt and model: short, similar questions on a small model are honestly very
   * consistent (live regtest load test, 2026-11-15: an honest CPU agent was blacklisted at 48 ms).
   */
  codeDurationStdDev: number;
  /** Code results the precision rule saw. */
  codeTimingTasks: number;
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
  /**
   * Longest gap between heartbeats in the window. Informational only: a gap alone is not
   * misbehaviour (sleep, an app update restart, a network drop); its claims are requeued at lease
   * expiry and recorded as abandoned claims, which BHV006 looks at instead.
   */
  heartbeatGapMaxMs: number;
  /** Abandoned claims (lease lapsed) in the abandoned-claim window (24 h by default). */
  abandonedClaimCount?: number;
  /**
   * Abandoned claims since the agent last returned any result, within that window: the agent
   * came back and kept claiming without completing anything.
   */
  abandonedClaimStreak?: number;
  /** Abandoned claims in that window that ran past their hard deadline while the agent was heartbeating. */
  abandonedWhileActiveCount?: number;

  windowStartMs: number;
  windowEndMs: number;
}

interface TimestampedEvent {
  timestampMs: number;
}

interface TaskEvent extends TimestampedEvent {
  ok: boolean;
  outcome: "ok" | "program_error" | "agent_failure";
  submitter: string;
  subtaskId?: string;
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

interface AbandonedClaimEvent extends TimestampedEvent {
  whileActive: boolean;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
/** BHV008 counts registrations over 10 minutes, not the hour-long window: a healthy worker
 *  refreshes every 4 minutes (15 an hour), which the hour window read as a storm. */
export const REGISTRATION_STORM_WINDOW_MS = 10 * 60 * 1000;
const OUTPUT_HASH_RING_SIZE = 20;

export class AgentBehaviorTracker {
  private readonly windowMs: number;
  private readonly submitterFailureCap: number;
  private readonly abandonedClaimWindowMs: number;
  private readonly agents = new Map<string, {
    tasks: TaskEvent[];
    protocolEvents: ProtocolEvent[];
    registrations: RegistrationEvent[];
    taskClaims: TaskClaimEvent[];
    heartbeats: HeartbeatEvent[];
    abandonedClaims: AbandonedClaimEvent[];
    /** Last result of any kind (success, program error or agent failure); not pruned. */
    lastResultAtMs: number;
    requeueCount: number;
    concurrentClaimCount: number;
  }>();

  constructor(windowMs: number = DEFAULT_WINDOW_MS, opts: { submitterFailureCap?: number; abandonedClaimWindowMs?: number } = {}) {
    this.windowMs = windowMs;
    this.submitterFailureCap = Math.max(1, Math.floor(opts.submitterFailureCap ?? DEFAULT_SUBMITTER_FAILURE_CAP));
    this.abandonedClaimWindowMs = Math.max(1, Math.floor(opts.abandonedClaimWindowMs ?? DEFAULT_ABANDONED_CLAIM_WINDOW_MS));
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
        abandonedClaims: [],
        lastResultAtMs: 0,
        requeueCount: 0,
        concurrentClaimCount: 0,
      };
      this.agents.set(agentId, entry);
    }
    return entry;
  }

  private pruneWindow<T extends TimestampedEvent>(events: T[], now: number, windowMs: number = this.windowMs): T[] {
    const cutoff = now - windowMs;
    return events.filter(e => e.timestampMs >= cutoff);
  }

  private hashOutput(output: string): string {
    return createHash("sha256").update(output).digest("hex").slice(0, 16);
  }

  recordTaskResult(agentId: string, result: TaskResultInput, nowMs: number = Date.now()): void {
    const entry = this.getOrCreate(agentId);
    entry.tasks = this.pruneWindow(entry.tasks, nowMs);
    entry.lastResultAtMs = Math.max(entry.lastResultAtMs, nowMs);
    entry.tasks.push({
      timestampMs: nowMs,
      ok: result.ok,
      outcome: result.outcome ?? (result.ok ? "ok" : "agent_failure"),
      submitter: result.submitter ?? "unattributed",
      subtaskId: result.subtaskId,
      outputHash: this.hashOutput(result.output),
      outputLength: result.output.length,
      durationMs: result.durationMs,
      kind: result.kind,
    });
  }

  /**
   * A verification verdict showed the job was at fault (an agreeing replica on another account also
   * failed it): the recorded agent failure becomes a program error. Returns whether one was found.
   */
  excuseFailure(agentId: string, subtaskId: string): boolean {
    const t = this.agents.get(agentId)?.tasks.find((e) => e.subtaskId === subtaskId && e.outcome === "agent_failure");
    if (!t) return false;
    t.outcome = "program_error";
    return true;
  }

  recordHeartbeat(agentId: string, nowMs: number = Date.now()): void {
    const entry = this.getOrCreate(agentId);
    entry.heartbeats = this.pruneWindow(entry.heartbeats, nowMs);
    entry.heartbeats.push({ timestampMs: nowMs });
  }

  /**
   * A claim this agent held lapsed (src/swarm/queue.ts onClaimAbandoned) and went back on the
   * queue for others. `whileActive`: it ran past its hard deadline while the agent heartbeated.
   */
  recordAbandonedClaim(agentId: string, opts: { whileActive?: boolean } = {}, nowMs: number = Date.now()): void {
    const entry = this.getOrCreate(agentId);
    entry.abandonedClaims = this.pruneWindow(entry.abandonedClaims, nowMs, this.abandonedClaimWindowMs);
    entry.abandonedClaims.push({ timestampMs: nowMs, whileActive: Boolean(opts.whileActive) });
  }

  /** Forget an agent's abandoned claims (a BHV006 blacklist was issued: its expiry starts afresh). */
  clearAbandonedClaims(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (entry) entry.abandonedClaims = [];
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
    entry.abandonedClaims = this.pruneWindow(entry.abandonedClaims, nowMs, this.abandonedClaimWindowMs);

    const tasks = entry.tasks;
    const totalTasks = tasks.length;
    // Failure-rate rules: a program error is a correctly executed job, and at most
    // submitterFailureCap agent failures per submitter count (the rest are left out entirely).
    const failuresBySubmitter = new Map<string, number>();
    let rateTasks = 0;
    let successCount = 0;
    let cappedFailureCount = 0;
    for (const t of tasks) {
      if (t.outcome === "agent_failure") {
        const n = failuresBySubmitter.get(t.submitter) ?? 0;
        if (n >= this.submitterFailureCap) {
          cappedFailureCount += 1;
          continue;
        }
        failuresBySubmitter.set(t.submitter, n + 1);
      } else {
        successCount += 1;
      }
      rateTasks += 1;
    }
    const successRate = rateTasks > 0 ? successCount / rateTasks : 1;
    // The forgery signals (empty, identical or impossibly fast results) look only at results that
    // are paid: successes and program errors. An agent failure earns nothing, and an agent whose
    // model is broken fails fast with empty output, which is not fraud. Program errors are in, so a
    // worker can't dodge the signals by calling its forgeries failed programs.
    const okTasks = tasks.filter(t => t.outcome !== "agent_failure");
    const isCode = (t: { kind?: string }) => t.kind !== "inference";
    const codeTasks = tasks.filter(isCode);
    const okCodeTasks = okTasks.filter(isCode);
    const emptyOutputCount = okCodeTasks.filter(t => t.outputLength === 0).length;

    // Identical output detection: count max consecutive identical hashes
    let identicalOutputCount = 0;
    if (okCodeTasks.length >= 2) {
      let consecutiveRun = 1;
      for (let i = 1; i < okCodeTasks.length; i++) {
        if (okCodeTasks[i].outputHash === okCodeTasks[i - 1].outputHash) {
          consecutiveRun++;
          identicalOutputCount = Math.max(identicalOutputCount, consecutiveRun);
        } else {
          consecutiveRun = 1;
        }
      }
    }

    // Ring buffer of recent output hashes
    const recentOutputHashes = tasks.slice(-OUTPUT_HASH_RING_SIZE).map(t => t.outputHash);

    const totalOutputLength = codeTasks.reduce((sum, t) => sum + t.outputLength, 0);
    const avgOutputLength = codeTasks.length > 0 ? totalOutputLength / codeTasks.length : 0;
    const outputTasks = codeTasks.length;

    // Timing
    const durations = tasks.map(t => t.durationMs);
    const avgDurationMs = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;
    const minDurationMs = durations.length > 0 ? Math.min(...durations) : 0;
    const durationStdDev = computeStdDev(durations, avgDurationMs);
    const codeDurations = codeTasks.map(t => t.durationMs);
    const codeAvgDurationMs = codeDurations.length > 0 ? codeDurations.reduce((a, b) => a + b, 0) / codeDurations.length : 0;
    const codeDurationStdDev = computeStdDev(codeDurations, codeAvgDurationMs);
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

    // Abandoned claims (BHV006)
    const abandonedClaimCount = entry.abandonedClaims.length;
    const abandonedClaimStreak = entry.abandonedClaims.filter(e => e.timestampMs > entry.lastResultAtMs).length;
    const abandonedWhileActiveCount = entry.abandonedClaims.filter(e => e.whileActive).length;

    const windowStartMs = nowMs - this.windowMs;

    return {
      totalTasks,
      successCount,
      successRate,
      rateTasks,
      cappedFailureCount,
      emptyOutputCount,
      identicalOutputCount,
      recentOutputHashes,
      avgOutputLength,
      outputTasks,
      avgDurationMs,
      minDurationMs,
      durationStdDev,
      codeDurationStdDev,
      codeTimingTasks: codeDurations.length,
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
      abandonedClaimCount,
      abandonedClaimStreak,
      abandonedWhileActiveCount,
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
