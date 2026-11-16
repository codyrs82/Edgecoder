// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coordinator-side hardware verification: which tier an agent is actually paid at.
 *
 * The hardware profile (and the agent's own benchmark) is self-reported, and the agent's code can
 * be modified, so a claimed tier above its class's base tier (weight 1) is granted only after the
 * agent passes a coordinator-issued challenge (src/swarm/benchmark.ts):
 *
 *   - a fresh random seed / nonce per challenge, so answers cannot be precomputed or replayed;
 *   - a checkable answer (CPU: memory-hard proof of work, sample-verified; GPU: nonce-tagged
 *     greedy generation, cross-checked against a second agent running the same model);
 *   - a deadline from the claimed tier's expected speed:  deadline = allowance + work × slack / min.
 *     The measured speed is work / max(server-measured time − allowance, agent-reported time):
 *     the server clock bounds what a lying agent can claim, the agent's own timer stops an honest
 *     agent from being credited with network slack. A tier is supported when measured ≥ min / slack.
 *
 * Pass => granted = claimed. A slow or late answer demotes to the highest tier the measurement
 * supports, which can fall out of the class (a "GPU" measuring like a CPU settles as cpu), but one
 * slow sample never lowers a grant on its own: the first is held (the grant stays, status
 * "unverified", flag challenge_slow_unconfirmed) and re-measured `slowConfirmMs` later, when a
 * model loaded or warmed up by the first challenge, or a busy start-up (sandbox image builds), no
 * longer weighs on it. A second slow sample within `slowConfirmWindowMs` demotes to the better of
 * the two; so does declining or not answering the confirmation. An invalid answer (bad proof,
 * missing tags, cross-check mismatch, faster than the claimed part can physically be) grants the
 * class base tier at once and is logged as a security event.
 *
 * Witnesses are picked at random by the coordinator among eligible agents (`canWitness` here, plus
 * account and network checks in pickBenchmarkWitness): a passed GPU challenge, no blacklist, few
 * witness disagreements and fewer than `witnessStrikeThreshold` witness strikes in the window, and
 * a different account and IP network (/24, /48) from the subject and from each other.
 *
 * Cross-check mismatch needs four witnesses to demote: one witness alone, or two, cannot. When the
 * first witness disagrees with the subject, the same prompt goes to a second witness (not the subject
 * or the first witness, nor their accounts or networks). If it agrees, the subject is verified and
 * the first witness's disagreement is recorded on its record (`witnessDisagreements`) and reported to
 * the caller (`SubmitResult.disagreeingWitness`). If it disagrees too, the subject gets a confirmatory
 * re-challenge: a fresh prompt (new nonce and seed), answered by two fresh witnesses that exclude all
 * the earlier ones (and their accounts and networks). Both of them disagree: the answer is invalid
 * (demoted). Both agree: the subject is verified and each of the two earlier witnesses gets a witness
 * strike (`SubmitResult.struckWitnesses`); past `witnessStrikeThreshold` strikes in the window an
 * agent is no longer picked as a witness, and the caller records a security event and a behaviour
 * strike. A split, or a witness that never answers, settles unconfirmed (no demotion, no strike). No
 * witness available at any step settles as if there had been no witness at all. Until a pass, and
 * for agents that never answer (older agents without benchmark support), the grant is the class
 * base tier: mixed fleets keep working at weight 1, nothing is rejected.
 *
 * Ongoing evidence: every task result feeds a rolling per-agent record (success rate, tokens/s on
 * real work against the challenge baseline). Real work far slower than the challenge (a rented
 * GPU passed the test, then the work ran on a CPU) demotes to base and schedules a re-challenge.
 * `evidence.score` is the seed of the SLA / reputation score: the record is JSON, persisted per
 * agent, and served by GET /economy/hardware/verifications, so it can later be published as is.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  BASE_TIER,
  DEFAULT_COMPUTE_CLASSES,
  normalizeComputeClass,
  tierSpec,
  type ComputeClassId,
  type ComputeClassSpec,
  type ComputeTierId,
  type HardwareClassification,
  type HardwareProfile
} from "../economy/compute-classes.js";
import {
  MAX_KNOWN_BANDWIDTH_GBPS,
  checkInferenceOutput,
  cpuTarget,
  estimateTokens,
  inferenceSimilarity,
  knownBandwidthGbps,
  modelWeightsGb,
  verifyCpuSolutions,
  type AgentBenchmarkReport,
  type BenchmarkChallenge,
  type ChallengeMetric,
  type ChallengeResponse,
  type CpuChallenge,
  type GpuChallenge
} from "./benchmark.js";

/** Which challenge proves a tier: CPU proof of work for cpu tiers, Ollama bandwidth for the rest. */
export function tierMetric(tier: ComputeTierId): ChallengeMetric {
  return tier.startsWith("cpu.") ? "cpu" : "gpu";
}

/**
 * Expected speed per tier: CPU scrypt work units/s (benchmark.ts CPU_WORK) or effective GPU memory
 * bandwidth in GB/s (tokens/s × weight GB). 0 = nothing to prove. The base tier minimum is the class
 * floor used when demoting (below it a "GPU" settles as cpu). Starting points from public bandwidth
 * figures (decode reaches ~50-70% of peak) and a 10-core M1 Max (~2300 units/s on 10 threads);
 * calibrate on the real fleet with HARDWARE_TIER_MIN_JSON.
 */
export const DEFAULT_TIER_MINIMUMS: Record<ComputeTierId, number> = {
  "cpu.std": 0,
  "cpu.hi": 4000, // ~16+ modern cores
  "apple.m": 20,
  "apple.m.hi": 70, // Pro / Max / Ultra (and 32 GB M4)
  "gpu.c8": 60,
  "gpu.c16": 150,
  "gpu.c24": 350, // 3090 / 4090 class
  "gpu.c32": 600, // 5090 class
  // The datacenter class floor, not a performance bar (gpu.dc80 is that): every card the agent labels
  // datacenter must be able to clear it, including the weak ones (A16 / A2 ~200 GB/s peak, L4 / T4
  // ~300, which decode at ~90-160 effective). Was 300 until 2026-11-15, which no A16, A2, L4, T4 or
  // A4000 can reach, so they fell to the consumer tiers or to cpu. Still above CPU decode (~30-70).
  "gpu.dc40": 80,
  "gpu.dc80": 900 // A100-80 / H100 / H200
};

export interface HardwareVerificationConfig {
  /** Off = trust the self-reported tier (pre-2026-11 behavior; a rollback switch, not for production). */
  enabled: boolean;
  tierMinimums: Record<ComputeTierId, number>;
  /** Tolerance: a tier is supported at min / slack. */
  slack: number;
  cpuTargetSeconds: number;
  cpuExpectedSolutions: number;
  cpuSampleChecks: number;
  cpuAllowanceMs: number;
  gpuAllowanceMs: number;
  gpuLines: number;
  gpuNumPredict: number;
  gpuMinTokens: number;
  /** Below this many active parameters decode is overhead-bound and says little about the hardware. */
  gpuMinActiveParamsB: number;
  /** GPU tiers above base need a matching second agent; without one the agent stays at base. */
  requireCrossCheck: boolean;
  crossCheckMinSimilarity: number;
  witnessTimeoutMs: number;
  /** Witness strikes (overruled by a confirmatory round) within witnessStrikeWindowMs that end witness duty. */
  witnessStrikeThreshold: number;
  witnessStrikeWindowMs: number;
  /** Disagreements (overruled by a single other witness) within the window that end witness duty. */
  witnessMaxDisagreements: number;
  /** A passed tier is re-challenged after this long. */
  revalidateMs: number;
  /** Retry after a failure, decline or a missing witness. */
  retryMs: number;
  /** A first slow sample (one that would lower the grant) is re-measured this soon instead of applied. */
  slowConfirmMs: number;
  /** A held slow sample confirms a second one within this long; older, it is forgotten. */
  slowConfirmWindowMs: number;
  /** A delivered challenge is measured until deadline × expiryFactor, then expires (no answer). */
  expiryFactor: number;
  evidence: { alpha: number; minSamples: number; demoteSpeedRatio: number; persistEveryMs: number };
}

export const DEFAULT_HARDWARE_VERIFICATION: HardwareVerificationConfig = {
  enabled: true,
  tierMinimums: DEFAULT_TIER_MINIMUMS,
  slack: 1.25,
  cpuTargetSeconds: 8,
  cpuExpectedSolutions: 256,
  cpuSampleChecks: 12,
  cpuAllowanceMs: 3_000,
  gpuAllowanceMs: 2_000,
  gpuLines: 24,
  gpuNumPredict: 512,
  gpuMinTokens: 96,
  gpuMinActiveParamsB: 3,
  requireCrossCheck: true,
  crossCheckMinSimilarity: 0.3,
  witnessTimeoutMs: 10 * 60_000,
  witnessStrikeThreshold: 2,
  witnessStrikeWindowMs: 30 * 86_400_000,
  witnessMaxDisagreements: 3,
  revalidateMs: 6 * 60 * 60_000,
  retryMs: 15 * 60_000,
  slowConfirmMs: 60_000,
  slowConfirmWindowMs: 30 * 60_000,
  expiryFactor: 4,
  evidence: { alpha: 0.1, minSamples: 10, demoteSpeedRatio: 0.08, persistEveryMs: 60_000 }
};

/**
 *   HARDWARE_VERIFICATION=0                 trust self-reported tiers (rollback only)
 *   HARDWARE_TIER_MIN_JSON                  {"gpu.c24": 300, ...} tier minimums (see DEFAULT_TIER_MINIMUMS)
 *   HARDWARE_GPU_REQUIRE_CROSS_CHECK=0      grant GPU tiers without a second agent's matching output
 *   HARDWARE_CROSS_CHECK_MIN_SIMILARITY     0..1 (default 0.3)
 *   HARDWARE_REVALIDATE_MS / HARDWARE_RETRY_MS
 *   HARDWARE_WITNESS_STRIKE_THRESHOLD       witness strikes that end witness duty (default 2)
 *   HARDWARE_WITNESS_STRIKE_WINDOW_MS       how long a strike counts (default 30 days)
 */
export function hardwareVerificationConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HardwareVerificationConfig {
  const cfg: HardwareVerificationConfig = { ...DEFAULT_HARDWARE_VERIFICATION, tierMinimums: { ...DEFAULT_TIER_MINIMUMS }, evidence: { ...DEFAULT_HARDWARE_VERIFICATION.evidence } };
  if (env.HARDWARE_VERIFICATION === "0" || env.HARDWARE_VERIFICATION === "false") cfg.enabled = false;
  if (env.HARDWARE_GPU_REQUIRE_CROSS_CHECK === "0" || env.HARDWARE_GPU_REQUIRE_CROSS_CHECK === "false") cfg.requireCrossCheck = false;
  const num = (v: string | undefined, min: number, max: number): number | undefined => {
    const n = Number(v);
    return v?.trim() && Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };
  cfg.crossCheckMinSimilarity = num(env.HARDWARE_CROSS_CHECK_MIN_SIMILARITY, 0, 1) ?? cfg.crossCheckMinSimilarity;
  cfg.revalidateMs = num(env.HARDWARE_REVALIDATE_MS, 60_000, 30 * 86_400_000) ?? cfg.revalidateMs;
  cfg.retryMs = num(env.HARDWARE_RETRY_MS, 10_000, 86_400_000) ?? cfg.retryMs;
  cfg.witnessStrikeThreshold = Math.floor(num(env.HARDWARE_WITNESS_STRIKE_THRESHOLD, 1, 100) ?? cfg.witnessStrikeThreshold);
  cfg.witnessStrikeWindowMs = num(env.HARDWARE_WITNESS_STRIKE_WINDOW_MS, 3_600_000, 365 * 86_400_000) ?? cfg.witnessStrikeWindowMs;
  if (env.HARDWARE_TIER_MIN_JSON?.trim()) {
    for (const [k, v] of Object.entries(JSON.parse(env.HARDWARE_TIER_MIN_JSON) as Record<string, unknown>)) {
      if (!(k in cfg.tierMinimums)) throw new Error(`[hardware-verification] unknown tier ${k}`);
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`[hardware-verification] ${k} must be a non-negative number`);
      cfg.tierMinimums[k as ComputeTierId] = n;
    }
  }
  return cfg;
}

export type HardwareVerificationStatus =
  /** Claim is the class base tier with nothing to prove (cpu.std). */
  | "base"
  /** Above-base (or GPU-class) claim not verified: no challenge support, no witness, or not yet run. Paid at base. */
  | "unverified"
  /** A challenge or cross-check is outstanding. Paid at the current grant. */
  | "pending"
  /** Passed: granted = claimed. */
  | "verified"
  /** Measured below the claim, an invalid answer, or real work far below the tier. */
  | "demoted";

export interface HardwareEvidence {
  samples: number;
  /** Rolling success rate of task results. */
  okRate: number;
  /** Rolling tokens/s on real work (output chars / 4 over server-measured claim-to-result time). */
  tokensPerSec?: number;
  /** Tokens/s the agent showed in its last passed GPU challenge. */
  baselineTokensPerSec?: number;
  speedRatio?: number;
  /** 0..1: okRate, scaled down when real work runs far below the challenge baseline. */
  score: number;
  /** `samples` when the current grant was made (demotion waits for minSamples after it). */
  samplesAtGrant: number;
  updatedAtMs: number;
}

export interface HardwareMeasurement {
  metric: ChallengeMetric;
  value: number;
  unit: "workUnits/s" | "GB/s";
  supportedTier: ComputeTierId;
  supportedClass: ComputeClassId;
  atMs: number;
  tokensPerSec?: number;
  model?: string;
  crossChecked?: boolean;
}

/** One agent's verification state. Self-contained JSON: persisted as is and publishable as is. */
export interface HardwareVerificationRecord {
  agentId: string;
  /** Fingerprint of the claimed hardware; a different one resets the grant. */
  profileKey: string;
  claimed: { computeClass: ComputeClassId; tier: ComputeTierId };
  granted: { computeClass: ComputeClassId; tier: ComputeTierId };
  status: HardwareVerificationStatus;
  /** The agent said its profile came from env overrides, not detection. */
  overridden: boolean;
  challengeKinds: ChallengeMetric[];
  /** Plausibility findings on the self-reported profile / benchmark (informational). */
  flags: string[];
  hardware: { cpuModel?: string; gpuModel?: string; vramGb?: number; cpuCores?: number; gpuCount?: number };
  /**
   * The full profile of the last registration that carried one. A registration without a profile
   * (an agent's reconnect probe, older agents) re-asserts this claim instead of dropping to cpu.std;
   * it is still only a claim, granted above its class base tier only on proof.
   */
  profile?: HardwareProfile & { overridden?: boolean };
  measured?: HardwareMeasurement;
  /**
   * A slow measurement that would have lowered the grant, held until a second one confirms it (see
   * the header). Cleared by any measurement that does not lower the grant.
   */
  slowSample?: { atMs: number; computeClass: ComputeClassId; tier: ComputeTierId; value: number };
  selfReport?: AgentBenchmarkReport;
  lastChallengeAtMs?: number;
  lastPassAtMs?: number;
  lastFailAtMs?: number;
  lastFailReason?: string;
  nextChallengeAtMs?: number;
  /**
   * Times this agent, as a witness, disagreed with a subject that another witness then confirmed
   * (lifetime count; `witnessDisagreementTimes` holds the recent ones, which count for eligibility).
   */
  witnessDisagreements?: number;
  lastWitnessDisagreementAtMs?: number;
  witnessDisagreementTimes?: number[];
  /**
   * Witness strikes: this agent disagreed with a subject that then passed a confirmatory round with
   * two fresh witnesses. Lifetime count, and the recent ones (`witnessStrikeTimes`): at
   * witnessStrikeThreshold within the window the agent is no longer picked as a witness.
   */
  witnessStrikes?: number;
  witnessStrikeTimes?: number[];
  evidence: HardwareEvidence;
  updatedAtMs: number;
}

interface PendingChallenge {
  challenge: BenchmarkChallenge;
  agentId: string;
  role: "own" | "witness";
  createdAtMs: number;
  deliveredAtMs?: number;
  /** own: the claimed tier it tests (a re-registration with other hardware makes it stale). */
  claimedTier?: ComputeTierId;
  weightsGb?: number;
  witnessAgentId?: string;
  /** witness: the subject's challenge id. */
  witnessFor?: string;
  /** own: a confirmatory re-challenge after two witnesses disagreed (see ConfirmRound). */
  confirm?: ConfirmRound;
}

/** A confirmatory re-challenge: two fresh witnesses decide; the two earlier ones are struck if overruled. */
interface ConfirmRound {
  witnesses: string[];
  /** The two witnesses whose disagreement led here. */
  disagreeing: string[];
  /** Witness answers received so far. */
  answers: Record<string, string>;
}

interface AwaitingCrossCheck {
  agentId: string;
  claimedTier: ComputeTierId;
  challenge: GpuChallenge;
  output: string;
  measured: HardwareMeasurement;
  expiresAtMs: number;
  /** The first witness disagreed: only the second witness's answer decides. */
  firstWitness?: { agentId: string; similarity: number };
  secondWitnessId?: string;
  confirm?: ConfirmRound;
}

/** A witness struck for being overruled by a confirmatory round. */
/**
 * What a machine's owner is shown about its verification (src/common/hardware-verification-copy.ts
 * turns it into a sentence): the reason it is not verified, when it is checked next, and whether
 * this agent version can answer the check at all.
 */
export function ownerVerificationView(r: HardwareVerificationRecord): {
  status: HardwareVerificationStatus; claimedTier: ComputeTierId; grantedTier: ComputeTierId; reason: string | null;
  nextCheckAtMs: number | null; checkSupported: boolean; flags: string[];
} {
  return {
    status: r.status,
    claimedTier: r.claimed.tier,
    grantedTier: r.granted.tier,
    reason: r.lastFailReason ?? null,
    nextCheckAtMs: r.nextChallengeAtMs ?? null,
    checkSupported: r.challengeKinds.includes(tierMetric(r.claimed.tier)),
    flags: r.flags.filter((f) => f.startsWith("challenge_"))
  };
}

export interface WitnessStrike {
  agentId: string;
  /** Strikes within the window, this one included. */
  strikes: number;
  /** No longer picked as a witness. */
  excluded: boolean;
  /** This strike reached the threshold (the caller records a security event and a behaviour strike once). */
  newlyExcluded: boolean;
}

export interface SubmitResult {
  accepted: boolean;
  reason?: string;
  /** The grant (class / tier) changed: the caller re-posts the agent's ask. */
  changed: boolean;
  record?: HardwareVerificationRecord;
  /** Set for invalid answers (bad proof, missing tags, mismatch): a security event. */
  invalid?: string;
  /** A witness whose mismatch a second witness overruled (recorded on its record): a security event. */
  disagreeingWitness?: string;
  /** Witnesses overruled by a confirmatory round (each a witness strike). */
  struckWitnesses?: WitnessStrike[];
}

export interface HardwareVerifierOptions {
  config?: HardwareVerificationConfig;
  classes?: Record<ComputeClassId, ComputeClassSpec>;
  /** Persistence hook (Postgres upsert); errors are swallowed, memory stays authoritative. */
  persist?: (record: HardwareVerificationRecord) => Promise<unknown> | unknown;
  /**
   * Another witness (a second one after the first disagreed, or the two of a confirmatory round):
   * an eligible agent running `model`, none of `exclude` nor their accounts or networks. Without one
   * a disagreement settles as unconfirmed (no demotion).
   */
  pickWitness?: (subjectId: string, model: string, exclude: string[], nowMs: number) => string | undefined;
  /** Deterministic randomness for tests. */
  random?: { bytes?: (n: number) => Buffer; int?: (n: number) => number; id?: () => string };
}

const KINDS: ChallengeMetric[] = ["cpu", "gpu"];

/** Fingerprint of the hardware a claim rests on (tier plus the fields that produced it). */
export function hardwareProfileKey(claimedTier: ComputeTierId, profile: HardwareProfile | undefined): string {
  const g = profile?.gpu;
  const key = [claimedTier, profile?.platform ?? "", profile?.arch ?? "", profile?.cpuCores ?? "", profile?.cpuModel ?? "", g?.vendor ?? "", g?.model ?? "", g?.vramGb ?? "", g?.datacenter ? "dc" : ""].join("|");
  // Pooled cards (one agent, several GPUs): appended only then, so single-card keys are unchanged.
  return g?.count !== undefined && g.count > 1 ? `${key}|x${g.count}` : key;
}

const CLASS_RANK: Record<ComputeClassId, number> = { cpu: 0, apple: 1, gpu: 1, "gpu.dc": 2 };

/** Order of grants along a demotion chain (gpu.dc > gpu > cpu, then tier weight). */
function grantRank(classes: Record<ComputeClassId, ComputeClassSpec>, g: { computeClass: ComputeClassId; tier: ComputeTierId }): number {
  return CLASS_RANK[g.computeClass] * 1_000 + (tierSpec(classes, g.tier)?.creditsPerSecond ?? 1);
}

/** Tiers of a class, highest weight first. */
function tiersDesc(classes: Record<ComputeClassId, ComputeClassSpec>, cls: ComputeClassId): ComputeTierId[] {
  return [...classes[cls].tiers].sort((a, b) => b.creditsPerSecond - a.creditsPerSecond).map((t) => t.id);
}

/**
 * The highest tier a measurement supports, never above the claim. Within the claimed class first;
 * below the class floor a gpu.dc claim falls to the consumer gpu tiers, and any GPU-class claim to cpu.std.
 */
export function supportedTier(
  claimed: ComputeTierId,
  metric: ChallengeMetric,
  measured: number,
  cfg: Pick<HardwareVerificationConfig, "tierMinimums" | "slack">,
  classes: Record<ComputeClassId, ComputeClassSpec> = DEFAULT_COMPUTE_CLASSES
): { computeClass: ComputeClassId; tier: ComputeTierId } {
  const cls = normalizeComputeClass(claimed) as ComputeClassId;
  const meets = (t: ComputeTierId) => tierMetric(t) === metric && measured >= (cfg.tierMinimums[t] ?? 0) / cfg.slack;
  const claimedWeight = tierSpec(classes, claimed)?.creditsPerSecond ?? 1;
  const chain: ComputeClassId[] = cls === "gpu.dc" ? ["gpu.dc", "gpu"] : [cls];
  for (const c of chain) {
    for (const t of tiersDesc(classes, c)) {
      if (c === cls && (tierSpec(classes, t)?.creditsPerSecond ?? 1) > claimedWeight) continue;
      if (meets(t)) return { computeClass: c, tier: t };
    }
  }
  return { computeClass: "cpu", tier: "cpu.std" };
}

/** Plausibility of the self-reported profile and benchmark against the claim. Never grants anything. */
export function plausibilityFlags(
  claimed: ComputeTierId,
  profile: (HardwareProfile & { overridden?: boolean }) | undefined,
  report: AgentBenchmarkReport | undefined,
  cfg: Pick<HardwareVerificationConfig, "tierMinimums" | "slack">
): string[] {
  const flags: string[] = [];
  if (profile?.overridden) flags.push("profile_overridden");
  const min = cfg.tierMinimums[claimed] ?? 0;
  const metric = tierMetric(claimed);
  if (metric === "cpu" && report?.cpu && min > 0 && report.cpu.workUnitsPerSec < min / cfg.slack) flags.push("self_benchmark_below_claim");
  const bw = report?.gpu?.bandwidthGbps;
  if (metric === "gpu" && bw !== undefined && bw > 0) {
    if (min > 0 && bw < min / cfg.slack) flags.push("self_benchmark_below_claim");
    const peak = knownBandwidthGbps(profile?.gpu?.model ?? profile?.cpuModel);
    if (peak !== undefined && bw > peak * 1.2) flags.push("self_benchmark_exceeds_hardware");
  }
  const claimedMem = profile?.gpu?.vramGb ?? profile?.ramGb;
  if (report?.loaded && claimedMem !== undefined && report.loaded.vramGb > claimedMem + 2) flags.push("loaded_vram_exceeds_claim");
  return flags;
}

function freshEvidence(nowMs: number): HardwareEvidence {
  return { samples: 0, okRate: 1, score: 1, samplesAtGrant: 0, updatedAtMs: nowMs };
}

export class HardwareVerifier {
  readonly config: HardwareVerificationConfig;
  private readonly classes: Record<ComputeClassId, ComputeClassSpec>;
  private readonly records = new Map<string, HardwareVerificationRecord>();
  /** Records loaded from the store this process has not seen a registration for yet. */
  private readonly restored = new Set<string>();
  private readonly pending = new Map<string, PendingChallenge[]>();
  private readonly awaiting = new Map<string, AwaitingCrossCheck>(); // by subject challenge id
  private readonly witnessOutputs = new Map<string, Map<string, string>>(); // by subject challenge id, then witness id
  private readonly lastPersistMs = new Map<string, number>();
  private readonly changedSinceTick = new Set<string>();

  constructor(private readonly opts: HardwareVerifierOptions = {}) {
    this.config = opts.config ?? DEFAULT_HARDWARE_VERIFICATION;
    this.classes = opts.classes ?? DEFAULT_COMPUTE_CLASSES;
  }

  private bytes(n: number): Buffer {
    return this.opts.random?.bytes?.(n) ?? randomBytes(n);
  }
  private int(n: number): number {
    return this.opts.random?.int?.(n) ?? randomInt(n);
  }
  private id(): string {
    return this.opts.random?.id?.() ?? randomUUID();
  }

  private save(rec: HardwareVerificationRecord, nowMs: number): void {
    rec.updatedAtMs = nowMs;
    this.lastPersistMs.set(rec.agentId, nowMs);
    try {
      void Promise.resolve(this.opts.persist?.(structuredClone(rec))).catch(() => undefined);
    } catch {
      // memory stays authoritative
    }
  }

  /** Startup: records from the store. A restored grant is honored only on a matching, fresh, non-overridden registration. */
  load(records: HardwareVerificationRecord[]): void {
    for (const r of records) {
      if (!r?.agentId || !r.claimed?.tier || !r.granted?.tier) continue;
      // An agent that registered before the store finished loading has the authoritative record.
      if (this.records.has(r.agentId)) continue;
      // Outstanding challenges are not persisted: a restored "pending" is re-run on registration.
      const status = r.status === "pending" ? (r.granted.tier === r.claimed.tier ? "verified" : "unverified") : r.status;
      this.records.set(r.agentId, { ...r, status, ...(r.status === "pending" ? { nextChallengeAtMs: undefined } : {}), evidence: { ...freshEvidence(r.updatedAtMs ?? 0), ...r.evidence } });
      this.restored.add(r.agentId);
    }
  }

  get(agentId: string): HardwareVerificationRecord | undefined {
    return this.records.get(agentId);
  }

  list(): HardwareVerificationRecord[] {
    return [...this.records.values()];
  }

  private base(cls: ComputeClassId): { computeClass: ComputeClassId; tier: ComputeTierId } {
    return { computeClass: cls, tier: BASE_TIER[cls] };
  }

  private needsProof(tier: ComputeTierId): boolean {
    return (this.config.tierMinimums[tier] ?? 0) > 0;
  }

  /**
   * The classification the agent is paid and matched at: the granted class / tier and its weight,
   * with the claimed capability (vramGb / memoryGb) for bid constraints. No record => class base tier.
   */
  effective(agentId: string, claimed: HardwareClassification): HardwareClassification {
    if (!this.config.enabled) return claimed;
    const rec = this.records.get(agentId);
    const g = rec && rec.claimed.tier === claimed.tier ? rec.granted : this.base(claimed.computeClass);
    return {
      computeClass: g.computeClass,
      tier: g.tier,
      creditsPerSecond: tierSpec(this.classes, g.tier)?.creditsPerSecond ?? 1,
      ...(claimed.vramGb !== undefined ? { vramGb: claimed.vramGb } : {}),
      ...(claimed.memoryGb !== undefined ? { memoryGb: claimed.memoryGb } : {})
    };
  }

  /** Published reliability (0..1) once there is enough evidence; undefined before (fails any minReliability). */
  reliability(agentId: string): number | undefined {
    const e = this.records.get(agentId)?.evidence;
    return e && e.samples >= this.config.evidence.minSamples ? e.score : undefined;
  }

  /**
   * May this agent witness a GPU cross-check now? It passed a GPU challenge itself (verified at a GPU
   * tier, or measured on a GPU challenge and unverified only for want of a witness, so a new fleet
   * can bootstrap), and its recent witness record is clean enough: fewer than witnessStrikeThreshold
   * strikes and fewer than witnessMaxDisagreements disagreements in the window. Model, account,
   * network and blacklist are the caller's checks (pickBenchmarkWitness).
   */
  canWitness(agentId: string, nowMs: number): boolean {
    const rec = this.records.get(agentId);
    if (!rec || !rec.challengeKinds.includes("gpu")) return false;
    const measuredGpu = rec.measured?.metric === "gpu";
    const verifiedGpu = rec.status === "verified" && tierMetric(rec.granted.tier) === "gpu";
    const unconfirmedGpu = rec.status === "unverified" && measuredGpu && (rec.lastFailReason === "cross_check_unavailable" || rec.lastFailReason === "cross_check_inconclusive");
    if (!verifiedGpu && !unconfirmedGpu) return false;
    const cutoff = nowMs - this.config.witnessStrikeWindowMs;
    const recent = (times: number[] | undefined) => (times ?? []).filter((t) => t >= cutoff).length;
    return recent(rec.witnessStrikeTimes) < this.config.witnessStrikeThreshold && recent(rec.witnessDisagreementTimes) < this.config.witnessMaxDisagreements;
  }

  register(input: {
    agentId: string;
    claimed: HardwareClassification;
    profile?: HardwareProfile & { overridden?: boolean };
    benchmark?: AgentBenchmarkReport;
    challengeKinds?: string[];
    nowMs: number;
  }): HardwareVerificationRecord {
    const { agentId, claimed, profile, nowMs } = input;
    const profileKey = hardwareProfileKey(claimed.tier, profile);
    const prev = this.records.get(agentId);
    const wasRestored = this.restored.delete(agentId);
    const overridden = profile?.overridden === true;
    const kinds = KINDS.filter((k) => input.challengeKinds?.includes(k));
    const metric = tierMetric(claimed.tier);
    const canProve = kinds.includes(metric) && this.needsProof(claimed.tier);
    const fresh = (r: HardwareVerificationRecord) => r.status === "verified" && r.lastPassAtMs !== undefined && nowMs - r.lastPassAtMs < this.config.revalidateMs;
    // Same hardware, same process: a periodic re-registration changes nothing. Restored from the
    // store: keep a fresh pass, unless the profile is overridden (those re-prove every session).
    const keep = prev && prev.profileKey === profileKey && (!wasRestored || (fresh(prev) && !overridden));
    const baseGrant = this.base(claimed.computeClass);
    const rec: HardwareVerificationRecord = keep
      ? { ...prev }
      : {
          agentId,
          profileKey,
          claimed: { computeClass: claimed.computeClass, tier: claimed.tier },
          granted: baseGrant,
          status: "unverified",
          overridden,
          challengeKinds: kinds,
          flags: [],
          hardware: {},
          evidence: prev ? { ...prev.evidence, baselineTokensPerSec: undefined, speedRatio: undefined, samplesAtGrant: prev.evidence.samples } : freshEvidence(nowMs),
          // A witness record survives new hardware: a new profile does not wipe strikes.
          ...(prev ? witnessHistory(prev) : {}),
          updatedAtMs: nowMs
        };
    if (!keep) {
      // New or changed hardware: drop its outstanding challenges (they test the old claim).
      this.pending.set(agentId, (this.pending.get(agentId) ?? []).filter((p) => p.role === "witness"));
      rec.nextChallengeAtMs = canProve ? nowMs : undefined;
      if (prev && prev.profileKey !== profileKey) rec.flags = ["profile_changed"];
    }
    rec.overridden = overridden;
    rec.challengeKinds = kinds;
    if (profile) rec.profile = structuredClone(profile);
    rec.hardware = {
      ...(profile?.cpuModel ? { cpuModel: profile.cpuModel } : {}),
      ...(profile?.gpu?.model ? { gpuModel: profile.gpu.model } : {}),
      ...(profile?.gpu?.vramGb !== undefined ? { vramGb: profile.gpu.vramGb } : {}),
      ...(profile?.gpu?.count !== undefined && profile.gpu.count > 1 ? { gpuCount: profile.gpu.count } : {}),
      ...(profile?.cpuCores !== undefined ? { cpuCores: profile.cpuCores } : {})
    };
    if (input.benchmark) rec.selfReport = input.benchmark;
    rec.flags = [...new Set([...rec.flags.filter((f) => f === "profile_changed" || f.startsWith("challenge_")), ...plausibilityFlags(claimed.tier, profile, rec.selfReport, this.config)])];
    if (!this.needsProof(claimed.tier)) {
      rec.status = "base";
      rec.granted = baseGrant;
    } else if (!keep) {
      rec.status = "unverified";
    }
    if (canProve && rec.nextChallengeAtMs === undefined && !this.hasOutstanding(agentId)) rec.nextChallengeAtMs = nowMs;
    this.records.set(agentId, rec);
    this.save(rec, nowMs);
    return rec;
  }

  /** Heartbeat: a new self-benchmark (plausibility flags only). */
  reportBenchmark(agentId: string, report: AgentBenchmarkReport, nowMs: number): void {
    const rec = this.records.get(agentId);
    if (!rec) return;
    rec.selfReport = report;
    const keepFlags = rec.flags.filter((f) => f === "profile_changed" || f === "profile_overridden" || f.startsWith("challenge_"));
    rec.flags = [...new Set([...keepFlags, ...plausibilityFlags(rec.claimed.tier, { overridden: rec.overridden, cpuModel: rec.hardware.cpuModel, gpu: rec.hardware.gpuModel ? { model: rec.hardware.gpuModel, vramGb: rec.hardware.vramGb } : undefined }, report, this.config)])];
    this.save(rec, nowMs);
  }

  private flag(rec: HardwareVerificationRecord, f: string): void {
    if (!rec.flags.includes(f)) rec.flags.push(f);
  }

  /**
   * Heartbeat: the challenge to hand this agent now, if any (one outstanding at a time). The deadline
   * runs from this delivery. `model` is the agent's Ollama model; `pickWitness` finds another agent
   * running it (different owner) for the cross-check; `exclude` names agents it must not pick.
   */
  nextChallenge(agentId: string, ctx: { nowMs: number; model?: string; pickWitness?: (model: string, exclude?: string[]) => string | undefined }): BenchmarkChallenge | undefined {
    if (!this.config.enabled) return undefined;
    const now = ctx.nowMs;
    this.expire(now);
    const queue = this.pending.get(agentId) ?? [];
    if (queue.some((p) => p.deliveredAtMs !== undefined)) return undefined;
    const queued = queue.find((p) => p.deliveredAtMs === undefined);
    if (queued) {
      queued.deliveredAtMs = now;
      return queued.challenge;
    }
    const rec = this.records.get(agentId);
    if (!rec || rec.nextChallengeAtMs === undefined || now < rec.nextChallengeAtMs) return undefined;
    const tier = rec.claimed.tier;
    const metric = tierMetric(tier);
    const min = this.config.tierMinimums[tier] ?? 0;
    if (min <= 0 || !rec.challengeKinds.includes(metric)) return undefined;
    if (this.hasOutstanding(agentId)) return undefined;
    const challengeId = this.id();
    let pend: PendingChallenge;
    if (metric === "cpu") {
      const workUnits = Math.max(64, Math.ceil(min * this.config.cpuTargetSeconds));
      const challenge: CpuChallenge = {
        challengeId,
        kind: "cpu",
        seed: this.bytes(32).toString("hex"),
        workUnits,
        target: cpuTarget(workUnits, this.config.cpuExpectedSolutions),
        deadlineMs: this.config.cpuAllowanceMs + Math.ceil((workUnits / min) * 1000 * this.config.slack)
      };
      pend = { challenge, agentId, role: "own", createdAtMs: now, deliveredAtMs: now, claimedTier: tier };
    } else {
      const model = ctx.model;
      const size = model ? modelWeightsGb(model) : undefined;
      if (!model || !size || size.activeParamsB < this.config.gpuMinActiveParamsB) {
        // Nothing meaningful to measure with: stay at the current grant and look again later.
        this.flag(rec, !model ? "challenge_no_model" : !size ? "challenge_model_unknown" : "challenge_model_too_small");
        rec.nextChallengeAtMs = now + this.config.retryMs;
        this.save(rec, now);
        return undefined;
      }
      const challenge: GpuChallenge = {
        challengeId,
        kind: "gpu",
        nonce: this.bytes(16).toString("hex"),
        model,
        lines: this.config.gpuLines,
        numPredict: this.config.gpuNumPredict,
        seed: this.int(2 ** 31 - 1),
        deadlineMs: this.config.gpuAllowanceMs + Math.ceil(((this.config.gpuNumPredict * size.weightsGb) / min) * 1000 * this.config.slack)
      };
      const witness = ctx.pickWitness?.(model, [agentId]);
      pend = { challenge, agentId, role: "own", createdAtMs: now, deliveredAtMs: now, claimedTier: tier, weightsGb: size.weightsGb, ...(witness && witness !== agentId ? { witnessAgentId: witness } : {}) };
      if (pend.witnessAgentId) {
        const wq = this.pending.get(pend.witnessAgentId) ?? [];
        wq.push({
          challenge: { ...challenge, challengeId: this.id(), deadlineMs: this.config.witnessTimeoutMs },
          agentId: pend.witnessAgentId,
          role: "witness",
          createdAtMs: now,
          witnessFor: challengeId
        });
        this.pending.set(pend.witnessAgentId, wq);
      }
    }
    queue.push(pend);
    this.pending.set(agentId, queue);
    rec.lastChallengeAtMs = now;
    rec.nextChallengeAtMs = undefined;
    if (rec.status !== "verified") rec.status = "pending";
    this.save(rec, now);
    return pend.challenge;
  }

  /** Set the grant. Anything but the claim is "demoted" (or "unverified" when nothing disproved the claim) with a reason. */
  private grant(
    rec: HardwareVerificationRecord,
    g: { computeClass: ComputeClassId; tier: ComputeTierId },
    nowMs: number,
    otherwise: { status: "demoted" | "unverified"; reason: string; /** Never "verified", even when g is the claim (an invalid answer on a base-tier claim). */ failed?: boolean } = { status: "demoted", reason: "below_claimed_tier" }
  ): boolean {
    const changed = rec.granted.tier !== g.tier || rec.granted.computeClass !== g.computeClass;
    rec.granted = g;
    if (!otherwise.failed && g.tier === rec.claimed.tier && g.computeClass === rec.claimed.computeClass) {
      rec.status = "verified";
      rec.lastPassAtMs = nowMs;
      rec.nextChallengeAtMs = nowMs + this.config.revalidateMs;
      rec.lastFailReason = undefined;
    } else {
      rec.status = otherwise.status;
      rec.lastFailAtMs = nowMs;
      rec.lastFailReason = otherwise.reason;
      rec.nextChallengeAtMs = nowMs + this.config.retryMs;
    }
    if (changed) {
      rec.evidence.samplesAtGrant = rec.evidence.samples;
      this.changedSinceTick.add(rec.agentId);
    }
    return changed;
  }

  /**
   * Apply a measurement. Demotions apply at once; a GPU grant above the class base tier needs the
   * cross-check when requireCrossCheck (otherwise the base tier, "challenge_unconfirmed").
   */
  private settle(rec: HardwareVerificationRecord, m: HardwareMeasurement, crossChecked: boolean, nowMs: number, unconfirmedReason = "cross_check_unavailable"): boolean {
    rec.measured = m.metric === "gpu" ? { ...m, crossChecked } : m;
    if (m.tokensPerSec !== undefined) rec.evidence.baselineTokensPerSec = m.tokensPerSec;
    const base = this.base(rec.claimed.computeClass);
    let target = { computeClass: m.supportedClass, tier: m.supportedTier };
    // One slow sample does not lower a grant: hold it and measure again soon (see the header).
    if (grantRank(this.classes, target) < grantRank(this.classes, rec.granted)) {
      const held = this.heldSlowSample(rec, nowMs);
      if (!held) {
        rec.slowSample = { atMs: nowMs, ...target, value: m.value };
        this.flag(rec, "challenge_slow_unconfirmed");
        // A verified grant stays verified until confirmed; anything else (pending now) is unverified.
        rec.status = rec.status === "verified" ? "verified" : "unverified";
        rec.lastFailAtMs = nowMs;
        rec.lastFailReason = "slow_sample_unconfirmed";
        rec.nextChallengeAtMs = nowMs + this.config.slowConfirmMs;
        return false;
      }
      // Confirmed: the better of the two samples.
      if (grantRank(this.classes, held) > grantRank(this.classes, target)) target = { computeClass: held.computeClass, tier: held.tier };
    }
    rec.slowSample = undefined;
    rec.flags = rec.flags.filter((f) => f !== "challenge_slow_unconfirmed");
    const aboveBase = target.computeClass === base.computeClass && target.tier !== base.tier;
    rec.flags = rec.flags.filter((f) => f !== "challenge_unconfirmed");
    if (m.metric === "gpu" && aboveBase && !crossChecked && this.config.requireCrossCheck) {
      this.flag(rec, "challenge_unconfirmed");
      return this.grant(rec, base, nowMs, { status: "unverified", reason: unconfirmedReason });
    }
    return this.grant(rec, target, nowMs);
  }

  private invalid(rec: HardwareVerificationRecord, reason: string, nowMs: number): boolean {
    this.flag(rec, `challenge_invalid:${reason}`);
    rec.slowSample = undefined;
    return this.grant(rec, this.base(rec.claimed.computeClass), nowMs, { status: "demoted", reason: `invalid:${reason}`, failed: true });
  }

  /** The held slow sample, if it is recent enough to confirm another. */
  private heldSlowSample(rec: HardwareVerificationRecord, nowMs: number): HardwareVerificationRecord["slowSample"] {
    const s = rec.slowSample;
    return s && nowMs - s.atMs <= this.config.slowConfirmWindowMs ? s : undefined;
  }

  /**
   * The confirmation of a held slow sample was declined or never answered: the held sample stands
   * (otherwise not answering would keep a grant the measurement did not support). True when applied.
   */
  private applyHeldSlowSample(rec: HardwareVerificationRecord, nowMs: number): boolean {
    const held = this.heldSlowSample(rec, nowMs);
    rec.slowSample = undefined;
    rec.flags = rec.flags.filter((f) => f !== "challenge_slow_unconfirmed");
    if (!held) return false;
    this.grant(rec, { computeClass: held.computeClass, tier: held.tier }, nowMs);
    return true;
  }

  submit(agentId: string, response: ChallengeResponse, nowMs: number): SubmitResult {
    const queue = this.pending.get(agentId) ?? [];
    const i = queue.findIndex((p) => p.challenge.challengeId === response.challengeId && p.deliveredAtMs !== undefined);
    if (i < 0) return { accepted: false, reason: "unknown_challenge", changed: false };
    const pend = queue[i];
    queue.splice(i, 1);
    if (pend.challenge.kind !== response.kind) return { accepted: false, reason: "kind_mismatch", changed: false };
    if (pend.role === "witness") return this.witnessAnswer(pend, response, nowMs);
    const rec = this.records.get(agentId);
    if (!rec || rec.claimed.tier !== pend.claimedTier) return { accepted: false, reason: "stale_challenge", changed: false };
    const elapsed = Math.max(1, nowMs - (pend.deliveredAtMs as number));
    const done = (changed: boolean, invalid?: string): SubmitResult => {
      this.save(rec, nowMs);
      return { accepted: true, changed, record: rec, ...(invalid ? { invalid } : {}) };
    };
    if (response.declined) {
      this.flag(rec, "challenge_declined");
      const prev = rec.granted;
      if (this.applyHeldSlowSample(rec, nowMs)) return done(prev.tier !== rec.granted.tier || prev.computeClass !== rec.granted.computeClass);
      rec.lastFailReason = `declined:${String(response.declined).slice(0, 40)}`;
      rec.nextChallengeAtMs = nowMs + this.config.retryMs;
      if (rec.status === "pending") rec.status = "unverified";
      return done(false);
    }
    rec.flags = rec.flags.filter((f) => f !== "challenge_declined" && f !== "challenge_timeout");
    const selfMs = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0);
    let work: number;
    let agentMs: number;
    let allowance: number;
    let tokensPerSec: number | undefined;
    if (pend.challenge.kind === "cpu") {
      const check = verifyCpuSolutions(pend.challenge, response.solutions, { sample: this.config.cpuSampleChecks, pick: (n) => this.int(n) });
      if (!check.ok) return done(this.invalid(rec, check.reason, nowMs), check.reason);
      work = pend.challenge.workUnits;
      agentMs = selfMs(response.elapsedMs);
      allowance = this.config.cpuAllowanceMs;
    } else {
      const output = typeof response.output === "string" ? response.output : "";
      const check = checkInferenceOutput(pend.challenge.nonce, pend.challenge.lines, output);
      if (!check.ok) return done(this.invalid(rec, check.reason, nowMs), check.reason);
      const tokens = estimateTokens(output, response.evalCount);
      if (tokens < this.config.gpuMinTokens) return done(this.invalid(rec, "output_too_short", nowMs), "output_too_short");
      work = tokens * (pend.weightsGb as number);
      // Faster than the claimed part can physically be (even counting the whole round trip): not a measurement.
      // Pooled cards: at most their sum (a layer split reads them one after the other, so in practice ~one card's).
      const known = knownBandwidthGbps(rec.hardware.gpuModel ?? rec.hardware.cpuModel);
      const peak = known !== undefined ? known * Math.max(1, rec.hardware.gpuCount ?? 1) : MAX_KNOWN_BANDWIDTH_GBPS;
      if (work / (elapsed / 1000) > peak * 1.2) return done(this.invalid(rec, "faster_than_hardware", nowMs), "faster_than_hardware");
      agentMs = selfMs(response.evalDurationMs);
      allowance = this.config.gpuAllowanceMs;
      tokensPerSec = Number((tokens / (Math.max(elapsed - allowance, agentMs, 1) / 1000)).toFixed(1));
    }
    const value = work / (Math.max(elapsed - allowance, agentMs, 1) / 1000);
    const metric = pend.challenge.kind;
    const s = supportedTier(rec.claimed.tier, metric, value, this.config, this.classes);
    const m: HardwareMeasurement = {
      metric,
      value: Number(value.toFixed(1)),
      unit: metric === "cpu" ? "workUnits/s" : "GB/s",
      supportedTier: s.tier,
      supportedClass: s.computeClass,
      atMs: nowMs,
      ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
      ...(pend.challenge.kind === "gpu" ? { model: pend.challenge.model } : {})
    };
    if (pend.challenge.kind === "gpu" && pend.confirm) {
      const outs = this.witnessOutputs.get(pend.challenge.challengeId);
      this.witnessOutputs.delete(pend.challenge.challengeId);
      const answers: Record<string, string> = {};
      for (const w of pend.confirm.witnesses) {
        const out = outs?.get(w);
        if (out !== undefined) answers[w] = out;
      }
      const round: ConfirmRound = { ...pend.confirm, answers };
      if (Object.keys(answers).length === round.witnesses.length) return this.confirmVerdict(rec, pend.challenge, response.output as string, m, round, nowMs);
      this.awaiting.set(pend.challenge.challengeId, { agentId, claimedTier: rec.claimed.tier, challenge: pend.challenge, output: response.output as string, measured: m, expiresAtMs: nowMs + this.config.witnessTimeoutMs, confirm: round });
      rec.measured = { ...m, crossChecked: false };
      if (rec.status !== "verified") rec.status = "pending";
      return done(false);
    }
    if (pend.challenge.kind === "gpu" && pend.witnessAgentId) {
      const witnessOut = this.witnessOutputs.get(pend.challenge.challengeId)?.get(pend.witnessAgentId);
      if (witnessOut === undefined) {
        this.awaiting.set(pend.challenge.challengeId, { agentId, claimedTier: rec.claimed.tier, challenge: pend.challenge, output: response.output as string, measured: m, expiresAtMs: nowMs + this.config.witnessTimeoutMs });
        rec.measured = { ...m, crossChecked: false };
        if (rec.status !== "verified") rec.status = "pending";
        return done(false);
      }
      this.witnessOutputs.delete(pend.challenge.challengeId);
      return this.crossCheck(rec, pend.challenge, response.output as string, { agentId: pend.witnessAgentId, output: witnessOut }, m, nowMs);
    }
    return done(this.settle(rec, m, false, nowMs));
  }

  /**
   * Compare the subject's output with a witness's. `first` is set when this is the second witness
   * (the first one disagreed): then a second mismatch is invalid and a match overrules the first.
   */
  private crossCheck(
    rec: HardwareVerificationRecord,
    ch: GpuChallenge,
    subject: string,
    witness: { agentId: string; output: string },
    m: HardwareMeasurement,
    nowMs: number,
    first?: { agentId: string; similarity: number }
  ): SubmitResult {
    const finish = (changed: boolean, extra: { invalid?: string; disagreeingWitness?: string } = {}): SubmitResult => {
      this.save(rec, nowMs);
      return { accepted: true, changed, record: rec, ...(extra.invalid ? { invalid: extra.invalid } : {}), ...(extra.disagreeingWitness ? { disagreeingWitness: extra.disagreeingWitness } : {}) };
    };
    // A witness that did not follow the prompt proves nothing either way: treat as no witness.
    if (!checkInferenceOutput(ch.nonce, ch.lines, witness.output).ok) return finish(this.settle(rec, m, false, nowMs));
    const sim = inferenceSimilarity(ch.nonce, subject, witness.output);
    if (sim >= this.config.crossCheckMinSimilarity) {
      const changed = this.settle(rec, m, true, nowMs);
      if (!first) return finish(changed);
      // The second witness overruled the first: record the first one's disagreement.
      this.recordWitnessDisagreement(first.agentId, nowMs);
      return finish(changed, { disagreeingWitness: first.agentId });
    }
    // Two witnesses disagree with the subject. They may be colluding (on separate accounts): demote
    // only if a confirmatory round with two fresh witnesses fails too. None to be had: no demotion.
    if (first) {
      if (!this.requestConfirmatoryRound(rec, ch, [first.agentId, witness.agentId], nowMs)) return finish(this.settle(rec, m, false, nowMs));
      rec.measured = { ...m, crossChecked: false };
      if (rec.status !== "verified") rec.status = "pending";
      return finish(false);
    }
    // One witness alone cannot demote: ask a second one. None available => settle as unconfirmed.
    if (!this.requestSecondWitness(rec, ch, subject, m, { agentId: witness.agentId, similarity: sim }, nowMs)) return finish(this.settle(rec, m, false, nowMs));
    rec.measured = { ...m, crossChecked: false };
    if (rec.status !== "verified") rec.status = "pending";
    return finish(false);
  }

  /** Queue the subject's prompt for a second witness and wait for it (same expiry as the first). */
  private requestSecondWitness(
    rec: HardwareVerificationRecord,
    ch: GpuChallenge,
    subjectOutput: string,
    m: HardwareMeasurement,
    first: { agentId: string; similarity: number },
    nowMs: number
  ): boolean {
    const exclude = [rec.agentId, first.agentId];
    const second = this.opts.pickWitness?.(rec.agentId, ch.model, exclude, nowMs);
    if (!second || exclude.includes(second)) return false;
    const wq = this.pending.get(second) ?? [];
    wq.push({
      challenge: { ...ch, challengeId: this.id(), deadlineMs: this.config.witnessTimeoutMs },
      agentId: second,
      role: "witness",
      createdAtMs: nowMs,
      witnessFor: ch.challengeId
    });
    this.pending.set(second, wq);
    this.awaiting.set(ch.challengeId, {
      agentId: rec.agentId,
      claimedTier: rec.claimed.tier,
      challenge: ch,
      output: subjectOutput,
      measured: m,
      expiresAtMs: nowMs + this.config.witnessTimeoutMs,
      firstWitness: first,
      secondWitnessId: second
    });
    return true;
  }

  /**
   * Two witnesses disagreed with the subject: give the subject a fresh prompt (new nonce and seed,
   * same model and deadline), answered by two fresh witnesses that exclude the subject, both earlier
   * witnesses, and each other (and, in the picker, their accounts and networks). False when two such
   * witnesses cannot be found.
   */
  private requestConfirmatoryRound(rec: HardwareVerificationRecord, ch: GpuChallenge, disagreeing: string[], nowMs: number): boolean {
    const size = modelWeightsGb(ch.model);
    if (!size) return false;
    const exclude = [rec.agentId, ...disagreeing];
    const witnesses: string[] = [];
    for (let i = 0; i < 2; i++) {
      const w = this.opts.pickWitness?.(rec.agentId, ch.model, [...exclude, ...witnesses], nowMs);
      if (!w || exclude.includes(w) || witnesses.includes(w)) return false;
      witnesses.push(w);
    }
    const challenge: GpuChallenge = { ...ch, challengeId: this.id(), nonce: this.bytes(16).toString("hex"), seed: this.int(2 ** 31 - 1) };
    // Delivered at the subject's next heartbeat; its deadline runs from then.
    const own = this.pending.get(rec.agentId) ?? [];
    own.push({ challenge, agentId: rec.agentId, role: "own", createdAtMs: nowMs, claimedTier: rec.claimed.tier, weightsGb: size.weightsGb, confirm: { witnesses, disagreeing, answers: {} } });
    this.pending.set(rec.agentId, own);
    for (const w of witnesses) {
      const wq = this.pending.get(w) ?? [];
      wq.push({ challenge: { ...challenge, challengeId: this.id(), deadlineMs: this.config.witnessTimeoutMs }, agentId: w, role: "witness", createdAtMs: nowMs, witnessFor: challenge.challengeId });
      this.pending.set(w, wq);
    }
    return true;
  }

  /**
   * The confirmatory round's verdict. Both fresh witnesses agree with the subject: verified, and the
   * two earlier witnesses are struck. Both disagree: invalid (four independent witnesses against it).
   * Anything else (a split, or a witness that did not follow the prompt) proves nothing: unconfirmed,
   * no demotion, no strike.
   */
  private confirmVerdict(rec: HardwareVerificationRecord, ch: GpuChallenge, subject: string, m: HardwareMeasurement, round: ConfirmRound, nowMs: number): SubmitResult {
    let agree = 0;
    let disagree = 0;
    for (const w of round.witnesses) {
      const out = round.answers[w];
      if (out === undefined || !checkInferenceOutput(ch.nonce, ch.lines, out).ok) continue;
      if (inferenceSimilarity(ch.nonce, subject, out) >= this.config.crossCheckMinSimilarity) agree++;
      else disagree++;
    }
    let changed: boolean;
    let extra: Partial<SubmitResult> = {};
    if (agree === round.witnesses.length) {
      changed = this.settle(rec, m, true, nowMs);
      extra = { struckWitnesses: round.disagreeing.map((id) => this.recordWitnessStrike(id, nowMs)).filter((s): s is WitnessStrike => s !== undefined) };
    } else if (disagree === round.witnesses.length) {
      changed = this.invalid(rec, "cross_check_mismatch", nowMs);
      extra = { invalid: "cross_check_mismatch" };
    } else {
      changed = this.settle(rec, m, false, nowMs, "cross_check_inconclusive");
    }
    this.save(rec, nowMs);
    return { accepted: true, changed, record: rec, ...extra };
  }

  private recent(times: number[] | undefined, nowMs: number): number[] {
    const cutoff = nowMs - this.config.witnessStrikeWindowMs;
    return [...(times ?? []), nowMs].filter((t) => t >= cutoff).slice(-50);
  }

  /** A witness disagreed with a subject that another witness confirmed: counts against its eligibility. */
  private recordWitnessDisagreement(witnessId: string, nowMs: number): void {
    const rec = this.records.get(witnessId);
    if (!rec) return;
    rec.witnessDisagreements = (rec.witnessDisagreements ?? 0) + 1;
    rec.lastWitnessDisagreementAtMs = nowMs;
    rec.witnessDisagreementTimes = this.recent(rec.witnessDisagreementTimes, nowMs);
    this.save(rec, nowMs);
  }

  /** A witness overruled by a confirmatory round: a strike (and a disagreement). */
  private recordWitnessStrike(witnessId: string, nowMs: number): WitnessStrike | undefined {
    const rec = this.records.get(witnessId);
    if (!rec) return undefined;
    rec.witnessStrikes = (rec.witnessStrikes ?? 0) + 1;
    rec.witnessStrikeTimes = this.recent(rec.witnessStrikeTimes, nowMs);
    this.recordWitnessDisagreement(witnessId, nowMs);
    const strikes = rec.witnessStrikeTimes.length;
    const threshold = this.config.witnessStrikeThreshold;
    return { agentId: witnessId, strikes, excluded: strikes >= threshold, newlyExcluded: strikes === threshold };
  }

  private witnessAnswer(pend: PendingChallenge, response: ChallengeResponse, nowMs: number): SubmitResult {
    const subjectId = pend.witnessFor as string;
    if (response.declined || typeof response.output !== "string") return { accepted: true, changed: false };
    const waiting = this.awaiting.get(subjectId);
    if (!waiting) {
      // The subject has not answered yet; keep the output for when it does (expires with the challenge).
      const subjectPending = [...this.pending.values()].some((q) => q.some((p) => p.challenge.challengeId === subjectId));
      if (subjectPending) this.witnessOutputs.set(subjectId, (this.witnessOutputs.get(subjectId) ?? new Map<string, string>()).set(pend.agentId, response.output));
      return { accepted: true, changed: false };
    }
    if (waiting.confirm) {
      const round = waiting.confirm;
      if (!round.witnesses.includes(pend.agentId) || round.answers[pend.agentId] !== undefined) return { accepted: true, changed: false };
      round.answers[pend.agentId] = response.output;
      if (Object.keys(round.answers).length < round.witnesses.length) return { accepted: true, changed: false };
      this.awaiting.delete(subjectId);
      const subjectRec = this.records.get(waiting.agentId);
      if (!subjectRec || subjectRec.claimed.tier !== waiting.claimedTier) return { accepted: true, changed: false };
      return this.confirmVerdict(subjectRec, waiting.challenge, waiting.output, waiting.measured, round, nowMs);
    }
    // Waiting on a second witness: only that witness's answer counts.
    if (waiting.secondWitnessId !== undefined && pend.agentId !== waiting.secondWitnessId) return { accepted: true, changed: false };
    this.awaiting.delete(subjectId);
    const rec = this.records.get(waiting.agentId);
    if (!rec || rec.claimed.tier !== waiting.claimedTier) return { accepted: true, changed: false };
    return this.crossCheck(rec, waiting.challenge, waiting.output, { agentId: pend.agentId, output: response.output }, waiting.measured, nowMs, waiting.firstWitness);
  }

  /** Expire unanswered challenges and witnesses that never came. Returns agents whose grant changed since the last tick. */
  tick(nowMs: number): string[] {
    this.expire(nowMs);
    const out = [...this.changedSinceTick];
    this.changedSinceTick.clear();
    return out;
  }

  private expire(nowMs: number): void {
    for (const [agentId, queue] of this.pending) {
      const keep: PendingChallenge[] = [];
      for (const p of queue) {
        const limit =
          p.role === "witness" || p.deliveredAtMs === undefined
            ? p.createdAtMs + this.config.witnessTimeoutMs
            : p.deliveredAtMs + p.challenge.deadlineMs * this.config.expiryFactor;
        if (nowMs <= limit) {
          keep.push(p);
          continue;
        }
        if (p.role === "witness") {
          this.witnessOutputs.get(p.witnessFor as string)?.delete(agentId);
          continue;
        }
        this.witnessOutputs.delete(p.challenge.challengeId);
        const rec = this.records.get(agentId);
        if (!rec || rec.claimed.tier !== p.claimedTier) continue;
        // No answer: no measurement, so no demotion below the class, but no grant above base either
        // (a held slow sample whose confirmation went unanswered stands).
        this.flag(rec, "challenge_timeout");
        if (!this.applyHeldSlowSample(rec, nowMs)) this.grant(rec, this.base(rec.claimed.computeClass), nowMs, { status: "unverified", reason: "challenge_timeout", failed: true });
        this.save(rec, nowMs);
      }
      if (keep.length) this.pending.set(agentId, keep);
      else this.pending.delete(agentId);
    }
    for (const [id, a] of this.awaiting) {
      if (nowMs <= a.expiresAtMs) continue;
      this.awaiting.delete(id);
      const rec = this.records.get(a.agentId);
      if (!rec || rec.claimed.tier !== a.claimedTier) continue;
      this.settle(rec, a.measured, false, nowMs);
      this.save(rec, nowMs);
    }
  }

  private hasOutstanding(agentId: string): boolean {
    return (this.pending.get(agentId) ?? []).some((p) => p.role === "own") || [...this.awaiting.values()].some((a) => a.agentId === agentId);
  }

  /**
   * Ongoing evidence from one task result (server-measured claim-to-result time). Returns true when
   * the grant changed (real work far below the challenge baseline demotes to base and re-challenges).
   */
  recordTask(agentId: string, input: { ok: boolean; outputChars: number; elapsedMs: number; outputTokens?: number }, nowMs: number): boolean {
    const rec = this.records.get(agentId);
    if (!rec) return false;
    const e = rec.evidence;
    const { alpha, minSamples, demoteSpeedRatio, persistEveryMs } = this.config.evidence;
    e.samples += 1;
    e.okRate = e.samples === 1 ? (input.ok ? 1 : 0) : e.okRate + alpha * ((input.ok ? 1 : 0) - e.okRate);
    // Speed only from results with real output (~100+ tokens): a short answer after a long sandbox run says nothing about decode speed.
    if (input.ok && input.outputChars >= 400 && input.elapsedMs > 0) {
      const tps = workTokens(input.outputChars, input.outputTokens) / (input.elapsedMs / 1000);
      e.tokensPerSec = e.tokensPerSec === undefined ? tps : e.tokensPerSec + alpha * (tps - e.tokensPerSec);
    }
    e.speedRatio = e.baselineTokensPerSec && e.tokensPerSec !== undefined ? Number((e.tokensPerSec / e.baselineTokensPerSec).toFixed(3)) : undefined;
    e.okRate = Number(e.okRate.toFixed(4));
    if (e.tokensPerSec !== undefined) e.tokensPerSec = Number(e.tokensPerSec.toFixed(2));
    // Real work at a quarter of the challenge speed is normal (prompt processing, sandbox runs); far below it is not the same hardware.
    e.score = Number((e.okRate * (e.speedRatio !== undefined ? Math.min(1, e.speedRatio / 0.25) : 1)).toFixed(3));
    e.updatedAtMs = nowMs;
    const base = this.base(rec.claimed.computeClass);
    const aboveBase = rec.granted.computeClass === base.computeClass && rec.granted.tier !== base.tier;
    let changed = false;
    if (this.config.enabled && aboveBase && e.speedRatio !== undefined && e.speedRatio < demoteSpeedRatio && e.samples - e.samplesAtGrant >= minSamples) {
      changed = this.grant(rec, base, nowMs, { status: "demoted", reason: "task_speed_below_tier" });
      // Re-prove, but not at once: an honest agent with unusually slow work would otherwise flap.
      rec.nextChallengeAtMs = nowMs + this.config.retryMs * 4;
    }
    if (changed || nowMs - (this.lastPersistMs.get(agentId) ?? 0) >= persistEveryMs) this.save(rec, nowMs);
    return changed;
  }
}

/**
 * Tokens a result produced: the model's own count when the agent reported it, kept within what
 * the text can hold (1.5 to 8 characters a token) so an inflated count can't make slow hardware
 * look fast; about 4 characters a token otherwise.
 */
export function workTokens(outputChars: number, reportedTokens?: number): number {
  if (reportedTokens === undefined || !Number.isFinite(reportedTokens) || reportedTokens <= 0) return outputChars / 4;
  return Math.min(outputChars / 1.5, Math.max(outputChars / 8, reportedTokens));
}

/** The witness fields of a record (kept when the agent's hardware profile changes). */
function witnessHistory(r: HardwareVerificationRecord): Partial<HardwareVerificationRecord> {
  const out: Partial<HardwareVerificationRecord> = {};
  if (r.witnessDisagreements) Object.assign(out, { witnessDisagreements: r.witnessDisagreements, lastWitnessDisagreementAtMs: r.lastWitnessDisagreementAtMs });
  if (r.witnessDisagreementTimes?.length) out.witnessDisagreementTimes = [...r.witnessDisagreementTimes];
  if (r.witnessStrikes) out.witnessStrikes = r.witnessStrikes;
  if (r.witnessStrikeTimes?.length) out.witnessStrikeTimes = [...r.witnessStrikeTimes];
  return out;
}

/**
 * The network an address belongs to for witness independence: the /24 of an IPv4 address (also
 * IPv4-mapped IPv6) or the /48 of an IPv6 address. Undefined when it is not an IP address.
 */
export function ipNetworkPrefix(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  let a = ip.trim().toLowerCase();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  a = a.replace(/%.*$/, "");
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const o = v4.slice(1, 5).map(Number);
    return o.every((n) => n <= 255) ? `${o[0]}.${o[1]}.${o[2]}.0/24` : undefined;
  }
  if (!/^[0-9a-f:]+$/.test(a) || !a.includes(":")) return undefined;
  const halves = a.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => g.length === 0 || g.length > 4)) return undefined;
  return `${groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16)).join(":")}::/48`;
}
