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
  /**
   * #106: reputation of an agent id never seen before. Below 1 so a caught cheater
   * can't reset to full trust by re-registering; it is sampled more until it earns trust.
   */
  initialReputation: number;
  /** #106: reputation lost for claiming a replica and never reporting it. */
  abandonPenalty: number;
  /** #106: a claimed replica with no report after this long is reassigned once to another agent. */
  replicaClaimTimeoutMs: number;
}

/**
 * #106: verification cost (a known economic choice). Winning replicas are paid like any
 * accepted execution, from newly minted compute credits (not debited from the requester),
 * and at most maxExecutions - 1 replicas run per sampled subtask. This minting only happens
 * when verification is on, and it is off by default (rate 0, RESULT_VERIFICATION_RATE). maxExecutions is capped at 3:
 * the rule is "the first two executions that agree win", which is only a majority at 3.
 */
export const MAX_EXECUTIONS_CAP = 3;

// Default rate 0 (opt-in): most swarm work is LLM generation, whose outputs differ between
// honest runs, so exact-match verification must be enabled only for deterministic workloads.
export const DEFAULT_VERIFICATION: VerificationConfig = {
  rate: 0,
  maxExecutions: 3,
  mismatchPenalty: 0.25,
  matchReward: 0.02,
  timeoutMs: 15 * 60_000,
  initialReputation: 0.5,
  abandonPenalty: 0.25,
  replicaClaimTimeoutMs: 5 * 60_000
};

export function verificationConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VerificationConfig {
  const num = (k: string, d: number, ok: (n: number) => boolean) => {
    const v = env[k];
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && ok(n) ? n : d;
  };
  return {
    rate: num("RESULT_VERIFICATION_RATE", DEFAULT_VERIFICATION.rate, (n) => n >= 0 && n <= 1),
    maxExecutions: Math.floor(num("RESULT_VERIFICATION_MAX_EXECUTIONS", DEFAULT_VERIFICATION.maxExecutions, (n) => n >= 2 && n <= MAX_EXECUTIONS_CAP)),
    mismatchPenalty: num("RESULT_VERIFICATION_MISMATCH_PENALTY", DEFAULT_VERIFICATION.mismatchPenalty, (n) => n >= 0 && n <= 1),
    matchReward: DEFAULT_VERIFICATION.matchReward,
    timeoutMs: num("RESULT_VERIFICATION_TIMEOUT_MS", DEFAULT_VERIFICATION.timeoutMs, (n) => n >= 10_000),
    abandonPenalty: num("RESULT_VERIFICATION_ABANDON_PENALTY", DEFAULT_VERIFICATION.abandonPenalty, (n) => n >= 0 && n <= 1),
    replicaClaimTimeoutMs: num("RESULT_VERIFICATION_REPLICA_CLAIM_TIMEOUT_MS", DEFAULT_VERIFICATION.replicaClaimTimeoutMs, (n) => n >= 10_000),
    initialReputation: num("RESULT_VERIFICATION_INITIAL_REPUTATION", DEFAULT_VERIFICATION.initialReputation, (n) => n >= 0 && n <= 1)
  };
}

export interface ExecutionResult<T = unknown> {
  /** Id of the subtask actually executed (original or replica). */
  subtaskId: string;
  agentId: string;
  /**
   * Reward account the execution pays into. Exclusion and one-vote-per-executor are
   * keyed on this (falls back to agentId), so one operator with two agent ids on the
   * same account can't run the original and the replica and agree with itself.
   */
  accountId?: string;
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
  /** Reward accounts that already executed this subtask; the replica must go to a different one. */
  excludeAccounts: string[];
}

const executorKey = (r: { agentId: string; accountId?: string }) => r.accountId ?? r.agentId;

export type VerificationOutcome<T> =
  | { status: "verified"; originalSubtaskId: string; winners: ExecutionResult<T>[]; losers: ExecutionResult<T>[]; output: string; ok: boolean }
  | { status: "unresolved"; originalSubtaskId: string; winners: []; losers: ExecutionResult<T>[]; abandonedBy?: string[] }
  | { status: "timeout"; originalSubtaskId: string; winners: ExecutionResult<T>[]; losers: []; output: string; ok: boolean };

interface Pending<T> {
  original: Subtask;
  results: ExecutionResult<T>[];
  startedAtMs: number;
  replicaIds: Set<string>;
  /** #106: agents that claimed a replica of this subtask (abandonment detection). */
  replicaClaimants: Set<string>;
  /** Open replica claims: replica id -> claimant and claim time. */
  claims: Map<string, { agentId: string; atMs: number }>;
  /** Agents already penalized for abandoning a replica of this subtask. */
  abandoners: Set<string>;
  reassigned: boolean;
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
    this.cfg.maxExecutions = Math.max(2, Math.min(MAX_EXECUTIONS_CAP, Math.floor(this.cfg.maxExecutions)));
  }

  reputation(agentId: string): number {
    return this.rep.get(agentId) ?? this.cfg.initialReputation;
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

  /** #106: the coordinator calls this when an agent claims a replica subtask. */
  markReplicaClaimed(replicaSubtaskId: string, agentId: string): void {
    const originalId = this.replicaToOriginal.get(replicaSubtaskId);
    const p = originalId ? this.pending.get(originalId) : undefined;
    if (!p) return;
    p.replicaClaimants.add(agentId);
    p.claims.set(replicaSubtaskId, { agentId, atMs: this.now() });
  }

  private penalizeAbandon(p: Pending<T>, agentId: string): void {
    if (p.abandoners.has(agentId)) return;
    p.abandoners.add(agentId);
    this.adjust(agentId, -this.cfg.abandonPenalty);
  }

  /**
   * #106: replicas claimed but not reported within replicaClaimTimeoutMs. The claimant is
   * penalized, its replica id stops being accepted, and (once per subtask) a fresh replica is
   * issued that excludes it. Returns the replacements to enqueue and who abandoned.
   */
  reassignStalled(): { replacements: { request: ReplicaRequest; replaces: string }[]; abandoned: { originalSubtaskId: string; agentId: string }[] } {
    const replacements: { request: ReplicaRequest; replaces: string }[] = [];
    const abandoned: { originalSubtaskId: string; agentId: string }[] = [];
    const now = this.now();
    for (const [id, p] of this.pending) {
      for (const [rid, c] of p.claims) {
        if (now - c.atMs <= this.cfg.replicaClaimTimeoutMs) continue;
        p.claims.delete(rid);
        if (p.results.some((r) => r.agentId === c.agentId)) continue;
        this.penalizeAbandon(p, c.agentId);
        abandoned.push({ originalSubtaskId: id, agentId: c.agentId });
        if (p.reassigned) continue;
        p.reassigned = true;
        this.replicaToOriginal.delete(rid); // a late report from the abandoner is ignored
        p.replicaIds.delete(rid);
        const next = this.nextReplica(p, rid);
        next.excludeAgents = [...new Set([...next.excludeAgents, ...p.abandoners])];
        replacements.push({ request: next, replaces: rid });
      }
    }
    return { replacements, abandoned };
  }

  isPending(originalSubtaskId: string): boolean {
    return this.pending.has(originalSubtaskId);
  }

  private nextReplica(p: Pending<T>, replacing?: string): ReplicaRequest {
    const id = replacing ? `${replacing}:r` : replicaId(p.original.id, p.results.length);
    p.replicaIds.add(id);
    this.replicaToOriginal.set(id, p.original.id);
    return {
      subtask: { ...p.original, id, dependsOn: undefined },
      excludeAgents: [...new Set([...p.results.map((r) => r.agentId), ...p.abandoners])],
      excludeAccounts: [...new Set(p.results.map(executorKey))]
    };
  }

  /** Hold the original result and request the first replica. */
  start(original: Subtask, first: ExecutionResult<T>): ReplicaRequest {
    const p: Pending<T> = { original, results: [first], startedAtMs: this.now(), replicaIds: new Set(), replicaClaimants: new Set(), claims: new Map(), abandoners: new Set(), reassigned: false };
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
    // One execution per agent and per reward account: neither can vote twice.
    if (p.results.some((r) => r.agentId === result.agentId || executorKey(r) === executorKey(result))) return null;
    p.results.push(result);
    p.claims.delete(replicaSubtaskId);

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
      const abandonedBy = [...p.replicaClaimants].filter((a) => !p.results.some((r) => r.agentId === a));
      if (p.results.length === 1 && abandonedBy.length === 0) {
        // Nobody else ever picked the replica up (e.g. no other agents online): accept unverified.
        const [only] = p.results;
        out.push({ status: "timeout", originalSubtaskId: id, winners: [only], losers: [], output: only.output, ok: only.ok });
      } else if (p.results.length === 1) {
        for (const a of abandonedBy) this.penalizeAbandon(p, a);
        // #106: a replica was claimed and never reported. Paying the original now would let an
        // accomplice stall verification into an unverified payout, so nobody earns.
        out.push({ status: "unresolved", originalSubtaskId: id, winners: [], losers: [...p.results], abandonedBy });
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
