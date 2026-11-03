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
  /** #106: a claimed replica with no report after this long is reassigned to another agent (see reassignStalled). */
  replicaClaimTimeoutMs: number;
  /**
   * #117: optional hard cap on how often one sampled subtask's stalled replicas are reassigned.
   * Default unlimited: reassignment is bounded by the overall timeout (it happens only while
   * more than replicaClaimTimeoutMs remains) and by the agents left that haven't abandoned it.
   */
  maxReassignments: number;
  /** #105: most reputations kept in memory (the cache in front of Postgres, or the whole book without it). */
  reputationCacheMax: number;
  /**
   * #114: pay winning replicas from newly minted compute credits. Off by default
   * (RESULT_VERIFICATION_MINT_REPLICA_REWARDS), so verification doesn't inflate supply
   * until minting is explicitly decided; the original execution is still paid as usual.
   */
  mintReplicaRewards: boolean;
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
  replicaClaimTimeoutMs: 5 * 60_000,
  maxReassignments: Number.POSITIVE_INFINITY,
  reputationCacheMax: 50_000,
  mintReplicaRewards: false
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
    maxReassignments: num("RESULT_VERIFICATION_MAX_REASSIGNMENTS", DEFAULT_VERIFICATION.maxReassignments, (n) => Number.isInteger(n) && n >= 0 && n <= 1000),
    reputationCacheMax: num("RESULT_VERIFICATION_REPUTATION_CACHE_MAX", DEFAULT_VERIFICATION.reputationCacheMax, (n) => Number.isInteger(n) && n >= 100),
    initialReputation: num("RESULT_VERIFICATION_INITIAL_REPUTATION", DEFAULT_VERIFICATION.initialReputation, (n) => n >= 0 && n <= 1),
    mintReplicaRewards: /^(1|true|yes)$/i.test((env.RESULT_VERIFICATION_MINT_REPLICA_REWARDS ?? "").trim())
  };
}

/**
 * #114: which winners of a settled verification get credits. The original execution is
 * always paid; winning replicas are paid (from minted credits) only when mintReplicaRewards is on.
 */
export function payableWinners<T>(
  outcome: VerificationOutcome<T>,
  cfg: Pick<VerificationConfig, "mintReplicaRewards">
): ExecutionResult<T>[] {
  return outcome.winners.filter((w) => cfg.mintReplicaRewards || w.subtaskId === outcome.originalSubtaskId);
}

/** #114: startup warning text when verification is on, or null when there's nothing to warn about. */
export function verificationStartupWarning(cfg: Pick<VerificationConfig, "rate" | "mintReplicaRewards">): string | null {
  if (!(cfg.rate > 0)) return null;
  return cfg.mintReplicaRewards
    ? `result verification rate ${cfg.rate} > 0 with RESULT_VERIFICATION_MINT_REPLICA_REWARDS on: winning replicas are paid from newly minted credits`
    : `result verification rate ${cfg.rate} > 0: winning replicas are NOT paid (RESULT_VERIFICATION_MINT_REPLICA_REWARDS is off)`;
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
  /** Reward accounts that already executed (or abandoned) this subtask; the replica must go to a different one. */
  excludeAccounts: string[];
}

/** #162: reputation, abandonment and exclusion are keyed on the reward account (agentId only when there is none). */
export const executorKey = (r: { agentId: string; accountId?: string }) => r.accountId ?? r.agentId;

export type VerificationOutcome<T> =
  | { status: "verified"; originalSubtaskId: string; winners: ExecutionResult<T>[]; losers: ExecutionResult<T>[]; output: string; ok: boolean }
  | { status: "unresolved"; originalSubtaskId: string; winners: []; losers: ExecutionResult<T>[]; abandonedBy?: string[] }
  | { status: "timeout"; originalSubtaskId: string; winners: ExecutionResult<T>[]; losers: []; output: string; ok: boolean };

/** Who executed or claimed a replica: the agent id and the reward account (key) it pays into. */
export interface Executor {
  agentId: string;
  key: string;
}

interface Pending<T> {
  original: Subtask;
  results: ExecutionResult<T>[];
  startedAtMs: number;
  replicaIds: Set<string>;
  /** #106: who claimed a replica of this subtask (abandonment detection), by agent id. */
  replicaClaimants: Map<string, Executor>;
  /** Open replica claims: replica id -> claimant and claim time. */
  claims: Map<string, Executor & { atMs: number }>;
  /** #162: reward accounts already penalized for abandoning a replica of this subtask, and their agent ids. */
  abandonerKeys: Set<string>;
  abandonerAgents: Set<string>;
  reassignments: number;
}

/**
 * #105: JSON form of one held verification, persisted so a coordinator restart keeps held
 * results (and their deadline) instead of dropping them.
 */
export interface PendingVerificationSnapshot<T> {
  original: Subtask;
  results: ExecutionResult<T>[];
  startedAtMs: number;
  replicaIds: string[];
  replicaClaimants: Executor[];
  claims: Array<Executor & { replicaId: string; atMs: number }>;
  abandonerKeys: string[];
  abandonerAgents: string[];
  reassignments: number;
}

/** #105: state changes a persistence layer mirrors (Postgres in the coordinator). */
export type VerifierChange<T> =
  | { kind: "pending"; originalSubtaskId: string; snapshot: PendingVerificationSnapshot<T> }
  | { kind: "settled"; originalSubtaskId: string }
  /** A reward account's reputation moved by `delta`: apply it atomically, another coordinator may move it too. */
  | { kind: "reputation"; key: string; delta: number };

export function replicaId(originalId: string, n: number): string {
  return `${originalId}::verify:${n}`;
}

/**
 * #105: bounded per-account reputation cache. When full, entries at or above the initial
 * reputation go first (oldest first): forgetting them only lowers trust back to the initial
 * value. Penalized accounts are dropped only when nothing else is left, so a flood of new
 * accounts can't wash a cheater back to initial trust. With Postgres the database is the
 * source of truth and this is its cache (ResultVerifier.primeReputation).
 */
export class ReputationBook {
  private readonly map = new Map<string, number>();
  constructor(
    private readonly initial: number,
    readonly maxEntries: number = DEFAULT_VERIFICATION.reputationCacheMax
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): number {
    return this.map.get(key) ?? this.initial;
  }

  set(key: string, value: number): void {
    this.map.delete(key); // re-insert: Map order is recency order
    this.map.set(key, Math.max(0, Math.min(1, value)));
    if (this.map.size <= this.maxEntries) return;
    for (const [k, v] of this.map) {
      if (this.map.size <= this.maxEntries) return;
      if (v >= this.initial && k !== key) this.map.delete(k);
    }
    for (const k of this.map.keys()) {
      if (this.map.size <= this.maxEntries) return;
      if (k !== key) this.map.delete(k);
    }
  }
}

export class ResultVerifier<T = unknown> {
  private readonly cfg: VerificationConfig;
  private readonly pending = new Map<string, Pending<T>>();
  private readonly replicaToOriginal = new Map<string, string>();
  private readonly rep: ReputationBook;
  private listener?: (change: VerifierChange<T>) => void;

  constructor(
    cfg: Partial<VerificationConfig> = {},
    private readonly random: () => number = Math.random,
    private readonly now: () => number = Date.now
  ) {
    this.cfg = { ...DEFAULT_VERIFICATION, ...cfg };
    this.cfg.maxExecutions = Math.max(2, Math.min(MAX_EXECUTIONS_CAP, Math.floor(this.cfg.maxExecutions)));
    this.rep = new ReputationBook(this.cfg.initialReputation, this.cfg.reputationCacheMax);
  }

  /** #105: mirror state changes (held verifications, reputation deltas) to persistent storage. */
  onChange(listener: (change: VerifierChange<T>) => void): void {
    this.listener = listener;
  }

  /** Reputation of a reward account (or of an agent id that has none). */
  reputation(key: string): number {
    return this.rep.get(key);
  }

  /** #105: load a reputation read from storage (authoritative across coordinators) into the cache. */
  primeReputation(key: string, value: number): void {
    this.rep.set(key, value);
  }

  /** Entries in the in-memory reputation cache (at most reputationCacheMax). */
  reputationCacheSize(): number {
    return this.rep.size;
  }

  private adjust(key: string, delta: number): void {
    if (delta === 0) return;
    this.rep.set(key, this.reputation(key) + delta);
    this.listener?.({ kind: "reputation", key, delta });
  }

  /** Sampling probability for a result paid into this reward account. */
  sampleRate(key: string): number {
    if (this.cfg.rate <= 0) return 0;
    return Math.min(1, this.cfg.rate * (2 - this.reputation(key)));
  }

  shouldVerify(key: string): boolean {
    return this.random() < this.sampleRate(key);
  }

  isReplica(subtaskId: string): boolean {
    return this.replicaToOriginal.has(subtaskId);
  }

  /** #106: the coordinator calls this when an agent claims a replica subtask. */
  markReplicaClaimed(replicaSubtaskId: string, agentId: string, accountId?: string): void {
    const originalId = this.replicaToOriginal.get(replicaSubtaskId);
    const p = originalId ? this.pending.get(originalId) : undefined;
    if (!originalId || !p) return;
    const who: Executor = { agentId, key: executorKey({ agentId, accountId }) };
    p.replicaClaimants.set(agentId, who);
    p.claims.set(replicaSubtaskId, { ...who, atMs: this.now() });
    this.save(originalId, p);
  }

  /** Did this executor (by agent id or by reward account) report a result for the subtask? */
  private reported(p: Pending<T>, who: Executor): boolean {
    return p.results.some((r) => r.agentId === who.agentId || executorKey(r) === who.key);
  }

  private penalizeAbandon(p: Pending<T>, who: Executor): void {
    p.abandonerAgents.add(who.agentId);
    if (p.abandonerKeys.has(who.key)) return;
    p.abandonerKeys.add(who.key);
    this.adjust(who.key, -this.cfg.abandonPenalty);
  }

  /**
   * #106/#117: replicas claimed but not reported within replicaClaimTimeoutMs. The claimant's
   * reward account is penalized (once per subtask), its replica id stops being accepted, and a
   * fresh replica is issued that excludes every abandoner so far (agent ids and accounts).
   * This repeats for each new stall while more than replicaClaimTimeoutMs remains before the
   * overall deadline (startedAtMs + timeoutMs; reassignment does NOT extend it) and fewer than
   * maxReassignments happened. It stops by itself once no eligible agent is left: the
   * replacement stays unclaimed and expire() settles the subtask at the deadline.
   */
  reassignStalled(): {
    replacements: { request: ReplicaRequest; replaces: string }[];
    abandoned: { originalSubtaskId: string; agentId: string; accountId: string }[];
  } {
    const replacements: { request: ReplicaRequest; replaces: string }[] = [];
    const abandoned: { originalSubtaskId: string; agentId: string; accountId: string }[] = [];
    const now = this.now();
    for (const [id, p] of this.pending) {
      let changed = false;
      for (const [rid, c] of p.claims) {
        if (now - c.atMs <= this.cfg.replicaClaimTimeoutMs) continue;
        p.claims.delete(rid);
        changed = true;
        if (this.reported(p, c)) continue;
        this.penalizeAbandon(p, c);
        abandoned.push({ originalSubtaskId: id, agentId: c.agentId, accountId: c.key });
        const remainingMs = p.startedAtMs + this.cfg.timeoutMs - now;
        if (p.reassignments >= this.cfg.maxReassignments || remainingMs <= this.cfg.replicaClaimTimeoutMs) continue;
        p.reassignments += 1;
        this.replicaToOriginal.delete(rid); // a late report from the abandoner is ignored
        p.replicaIds.delete(rid);
        replacements.push({ request: this.nextReplica(p, `${rid}:r`), replaces: rid });
      }
      if (changed) this.save(id, p);
    }
    return { replacements, abandoned };
  }

  isPending(originalSubtaskId: string): boolean {
    return this.pending.has(originalSubtaskId);
  }

  private nextReplica(p: Pending<T>, preferredId?: string): ReplicaRequest {
    let id = preferredId ?? replicaId(p.original.id, p.results.length);
    while (p.replicaIds.has(id) || this.replicaToOriginal.has(id)) id = `${id}:r`;
    p.replicaIds.add(id);
    this.replicaToOriginal.set(id, p.original.id);
    return {
      subtask: { ...p.original, id, dependsOn: undefined },
      excludeAgents: [...new Set([...p.results.map((r) => r.agentId), ...p.abandonerAgents])],
      excludeAccounts: [...new Set([...p.results.map(executorKey), ...p.abandonerKeys])]
    };
  }

  /** Hold the original result and request the first replica. */
  start(original: Subtask, first: ExecutionResult<T>): ReplicaRequest {
    const p: Pending<T> = {
      original,
      results: [first],
      startedAtMs: this.now(),
      replicaIds: new Set(),
      replicaClaimants: new Map(),
      claims: new Map(),
      abandonerKeys: new Set(),
      abandonerAgents: new Set(),
      reassignments: 0
    };
    this.pending.set(original.id, p);
    const next = this.nextReplica(p);
    this.save(original.id, p);
    return next;
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
      for (const w of winners) this.adjust(executorKey(w), this.cfg.matchReward);
      for (const l of losers) this.adjust(executorKey(l), -this.cfg.mismatchPenalty);
      this.settle(originalId, p);
      const ref = winners.find((w) => w.subtaskId === originalId) ?? winners[0];
      return { status: "verified", originalSubtaskId: originalId, winners, losers, output: ref.output, ok: ref.ok };
    }
    if (p.results.length >= this.cfg.maxExecutions) {
      for (const r of p.results) this.adjust(executorKey(r), -this.cfg.mismatchPenalty / 2);
      this.settle(originalId, p);
      return { status: "unresolved", originalSubtaskId: originalId, winners: [], losers: [...p.results] };
    }
    const next = this.nextReplica(p);
    this.save(originalId, p);
    return { status: "pending", next };
  }

  /** Release verifications whose replicas never reported (no other agents, replica failed). */
  expire(): VerificationOutcome<T>[] {
    const out: VerificationOutcome<T>[] = [];
    const now = this.now();
    for (const [id, p] of this.pending) {
      if (now - p.startedAtMs <= this.cfg.timeoutMs) continue;
      this.settle(id, p);
      const abandoners = [...p.replicaClaimants.values()].filter((c) => !this.reported(p, c));
      // #162: an abandoner is penalized whichever branch settles the subtask (once per account).
      for (const c of abandoners) this.penalizeAbandon(p, c);
      const abandonedBy = abandoners.map((c) => c.agentId);
      if (p.results.length === 1 && abandonedBy.length === 0) {
        // Nobody else ever picked the replica up (e.g. no other agents online): accept unverified.
        const [only] = p.results;
        out.push({ status: "timeout", originalSubtaskId: id, winners: [only], losers: [], output: only.output, ok: only.ok });
      } else if (p.results.length === 1) {
        // #106: a replica was claimed and never reported. Paying the original now would let an
        // accomplice stall verification into an unverified payout, so nobody earns.
        out.push({ status: "unresolved", originalSubtaskId: id, winners: [], losers: [...p.results], abandonedBy });
      } else {
        // Disagreeing results and no tie-breaker arrived: nobody earns.
        for (const r of p.results) this.adjust(executorKey(r), -this.cfg.mismatchPenalty / 2);
        out.push({
          status: "unresolved",
          originalSubtaskId: id,
          winners: [],
          losers: [...p.results],
          ...(abandonedBy.length ? { abandonedBy } : {})
        });
      }
    }
    return out;
  }

  /** #105: JSON snapshot of one held verification (undefined when not pending). */
  snapshot(originalSubtaskId: string): PendingVerificationSnapshot<T> | undefined {
    const p = this.pending.get(originalSubtaskId);
    return p && this.toSnapshot(p);
  }

  private toSnapshot(p: Pending<T>): PendingVerificationSnapshot<T> {
    return {
      original: p.original,
      results: p.results,
      startedAtMs: p.startedAtMs,
      replicaIds: [...p.replicaIds],
      replicaClaimants: [...p.replicaClaimants.values()],
      claims: [...p.claims].map(([replicaId, c]) => ({ replicaId, ...c })),
      abandonerKeys: [...p.abandonerKeys],
      abandonerAgents: [...p.abandonerAgents],
      reassignments: p.reassignments
    };
  }

  /**
   * #105: hold again a verification persisted before a restart. Its deadline is kept
   * (startedAtMs is restored). The queue is not persisted, so replica claims still open at the
   * restart died with the old process: they are dropped without penalty, and those claimants are
   * not counted as abandoners. Returns one fresh replica for the caller to enqueue (it excludes
   * everyone who executed or abandoned so far), or null when the subtask is already held here.
   */
  restore(s: PendingVerificationSnapshot<T>): ReplicaRequest | null {
    if (this.pending.has(s.original.id)) return null;
    const open = new Set(s.claims.map((c) => c.agentId));
    const p: Pending<T> = {
      original: s.original,
      results: [...s.results],
      startedAtMs: s.startedAtMs,
      replicaIds: new Set(),
      replicaClaimants: new Map(s.replicaClaimants.filter((c) => !open.has(c.agentId)).map((c) => [c.agentId, c])),
      claims: new Map(),
      abandonerKeys: new Set(s.abandonerKeys),
      abandonerAgents: new Set(s.abandonerAgents),
      reassignments: s.reassignments
    };
    this.pending.set(s.original.id, p);
    // A new id: no queue item or claim backs the old ones any more, so a late report on them is not accepted.
    let id = `${replicaId(s.original.id, p.results.length)}:restored`;
    while (s.replicaIds.includes(id)) id = `${id}:r`;
    const next = this.nextReplica(p, id);
    this.save(s.original.id, p);
    return next;
  }

  private save(originalId: string, p: Pending<T>): void {
    this.listener?.({ kind: "pending", originalSubtaskId: originalId, snapshot: this.toSnapshot(p) });
  }

  private settle(originalId: string, p: Pending<T>): void {
    this.pending.delete(originalId);
    for (const id of p.replicaIds) this.replicaToOriginal.delete(id);
    this.listener?.({ kind: "settled", originalSubtaskId: originalId });
  }
}
