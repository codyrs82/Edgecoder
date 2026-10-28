// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";
import type { Subtask } from "../common/types.js";

/**
 * #50: redundant execution for worker results.
 *
 * A sampled subtask is re-executed by a different agent (a "replica"). Credits and
 * dependency release are held until a majority of executions agree:
 * - 2 matching results -> verified: matching agents earn, mismatching ones don't and lose reputation;
 * - no majority after maxExecutions -> unresolved: nobody earns, everyone loses some reputation;
 * - no replica result before timeoutMs (e.g. no other agents online) -> timeout: the original
 *   result is accepted unverified, so single-node meshes aren't starved.
 * Sampling rate rises as an agent's reputation falls: p = min(1, rate * (2 - reputation)).
 */

export interface VerificationConfig {
  /** Base fraction of subtasks re-executed (0..1). */
  rate: number;
  /** Total executions including the original before giving up (>= 2). */
  maxExecutions: number;
  /** Reputation lost on a mismatch (agreement gains matchReward). Reputation is clamped to [0, 1]. */
  mismatchPenalty: number;
  matchReward: number;
  /** Hold time before an unreplicated result is released unverified. */
  timeoutMs: number;
}

// Default rate 0 (opt-in): most swarm work is LLM generation, whose outputs differ between
// honest runs, so exact-match verification must be enabled only for deterministic workloads.
export const DEFAULT_VERIFICATION: VerificationConfig = {
  rate: 0,
  maxExecutions: 3,
  mismatchPenalty: 0.25,
  matchReward: 0.02,
  timeoutMs: 15 * 60_000
};

export function verificationConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VerificationConfig {
  const num = (k: string, d: number, ok: (n: number) => boolean) => {
    const v = env[k];
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && ok(n) ? n : d;
  };
  return {
    rate: num("RESULT_VERIFICATION_RATE", DEFAULT_VERIFICATION.rate, (n) => n >= 0 && n <= 1),
    maxExecutions: Math.floor(num("RESULT_VERIFICATION_MAX_EXECUTIONS", DEFAULT_VERIFICATION.maxExecutions, (n) => n >= 2 && n <= 7)),
    mismatchPenalty: num("RESULT_VERIFICATION_MISMATCH_PENALTY", DEFAULT_VERIFICATION.mismatchPenalty, (n) => n >= 0 && n <= 1),
    matchReward: DEFAULT_VERIFICATION.matchReward,
    timeoutMs: num("RESULT_VERIFICATION_TIMEOUT_MS", DEFAULT_VERIFICATION.timeoutMs, (n) => n >= 10_000)
  };
}

export interface ExecutionResult<T = unknown> {
  /** Id of the subtask actually executed (original or replica). */
  subtaskId: string;
  agentId: string;
  ok: boolean;
  output: string;
  /** Caller data needed to settle later (e.g. credited duration, task id). */
  meta: T;
}

/** Comparison key: ok flag + output with line endings and surrounding whitespace normalized. */
export function resultKey(r: { ok: boolean; output: string }): string {
  const body = (r.output ?? "").replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(`${r.ok ? 1 : 0}\n${body}`).digest("hex");
}

export interface ReplicaRequest {
  subtask: Subtask;
  excludeAgents: string[];
}

export type VerificationOutcome<T> =
  | { status: "verified"; originalSubtaskId: string; winners: ExecutionResult<T>[]; losers: ExecutionResult<T>[]; output: string; ok: boolean }
  | { status: "unresolved"; originalSubtaskId: string; winners: []; losers: ExecutionResult<T>[] }
  | { status: "timeout"; originalSubtaskId: string; winners: ExecutionResult<T>[]; losers: []; output: string; ok: boolean };

interface Pending<T> {
  original: Subtask;
  results: ExecutionResult<T>[];
  startedAtMs: number;
  replicaIds: Set<string>;
}

export function replicaId(originalId: string, n: number): string {
  return `${originalId}::verify:${n}`;
}

export class ResultVerifier<T = unknown> {
  private readonly cfg: VerificationConfig;
  private readonly pending = new Map<string, Pending<T>>();
  private readonly replicaToOriginal = new Map<string, string>();
  private readonly rep = new Map<string, number>();

  constructor(
    cfg: Partial<VerificationConfig> = {},
    private readonly random: () => number = Math.random,
    private readonly now: () => number = Date.now
  ) {
    this.cfg = { ...DEFAULT_VERIFICATION, ...cfg };
  }

  reputation(agentId: string): number {
    return this.rep.get(agentId) ?? 1;
  }

  private adjust(agentId: string, delta: number): void {
    this.rep.set(agentId, Math.max(0, Math.min(1, this.reputation(agentId) + delta)));
  }

  /** Sampling probability for a result from this agent. */
  sampleRate(agentId: string): number {
    if (this.cfg.rate <= 0) return 0;
    return Math.min(1, this.cfg.rate * (2 - this.reputation(agentId)));
  }

  shouldVerify(agentId: string): boolean {
    return this.random() < this.sampleRate(agentId);
  }

  isReplica(subtaskId: string): boolean {
    return this.replicaToOriginal.has(subtaskId);
  }

  isPending(originalSubtaskId: string): boolean {
    return this.pending.has(originalSubtaskId);
  }

  private nextReplica(p: Pending<T>): ReplicaRequest {
    const id = replicaId(p.original.id, p.results.length);
    p.replicaIds.add(id);
    this.replicaToOriginal.set(id, p.original.id);
    return {
      subtask: { ...p.original, id, dependsOn: undefined },
      excludeAgents: [...new Set(p.results.map((r) => r.agentId))]
    };
  }

  /** Hold the original result and request the first replica. */
  start(original: Subtask, first: ExecutionResult<T>): ReplicaRequest {
    const p: Pending<T> = { original, results: [first], startedAtMs: this.now(), replicaIds: new Set() };
    this.pending.set(original.id, p);
    return this.nextReplica(p);
  }

  /**
   * Record a replica result. Returns the next replica to run when there's no majority yet,
   * or the final outcome. Unknown/settled replica ids return null.
   */
  recordReplica(
    replicaSubtaskId: string,
    result: ExecutionResult<T>
  ): { status: "pending"; next: ReplicaRequest } | VerificationOutcome<T> | null {
    const originalId = this.replicaToOriginal.get(replicaSubtaskId);
    const p = originalId ? this.pending.get(originalId) : undefined;
    if (!originalId || !p) return null;
    // One execution per agent: a repeat agent can't vote twice.
    if (p.results.some((r) => r.agentId === result.agentId)) return null;
    p.results.push(result);

    const groups = new Map<string, ExecutionResult<T>[]>();
    for (const r of p.results) {
      const k = resultKey(r);
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const majority = [...groups.values()].find((g) => g.length >= 2);
    if (majority) {
      const winners = majority;
      const losers = p.results.filter((r) => !winners.includes(r));
      for (const w of winners) this.adjust(w.agentId, this.cfg.matchReward);
      for (const l of losers) this.adjust(l.agentId, -this.cfg.mismatchPenalty);
      this.settle(originalId, p);
      const ref = winners.find((w) => w.subtaskId === originalId) ?? winners[0];
      return { status: "verified", originalSubtaskId: originalId, winners, losers, output: ref.output, ok: ref.ok };
    }
    if (p.results.length >= this.cfg.maxExecutions) {
      for (const r of p.results) this.adjust(r.agentId, -this.cfg.mismatchPenalty / 2);
      this.settle(originalId, p);
      return { status: "unresolved", originalSubtaskId: originalId, winners: [], losers: [...p.results] };
    }
    return { status: "pending", next: this.nextReplica(p) };
  }

  /** Release verifications whose replicas never reported (no other agents, replica failed). */
  expire(): VerificationOutcome<T>[] {
    const out: VerificationOutcome<T>[] = [];
    const now = this.now();
    for (const [id, p] of this.pending) {
      if (now - p.startedAtMs <= this.cfg.timeoutMs) continue;
      this.settle(id, p);
      if (p.results.length === 1) {
        const [only] = p.results;
        out.push({ status: "timeout", originalSubtaskId: id, winners: [only], losers: [], output: only.output, ok: only.ok });
      } else {
        // Disagreeing results and no tie-breaker arrived: nobody earns.
        for (const r of p.results) this.adjust(r.agentId, -this.cfg.mismatchPenalty / 2);
        out.push({ status: "unresolved", originalSubtaskId: id, winners: [], losers: [...p.results] });
      }
    }
    return out;
  }

  private settle(originalId: string, p: Pending<T>): void {
    this.pending.delete(originalId);
    for (const id of p.replicaIds) this.replicaToOriginal.delete(id);
  }
}
