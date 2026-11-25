// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Best-fit routing: for a `model: "auto"` call, which model, on which class, preferably on which
 * agent. Pure (no I/O, no clock): the coordinator builds a NetworkView of the agents that can take
 * work now (routing.ts) and a JobDescriptor of the request (src/inference-api/job-descriptor.ts).
 *
 * For every (agent, model) the agent holds:
 *
 *   hard filters   the model calls tools when the job needs them; the call fits the agent's
 *                  context window; the estimated cost is within the client's price ceiling; the
 *                  model is at least the job's minimum size (minParamsB). When nothing meets the
 *                  minimum, the biggest available models stay in ("best available").
 *   quality  Q     min(1, log2(1+B) / log2(1+enoughB)), +0.08 for a coder model on code work,
 *                  less up to oversizePenalty for a model more than 4x enoughB (right-sizing).
 *                  enoughB is the size past which a bigger model buys this job little: per job,
 *                  scaled by complexity (0.5 + 1.5c) and quality (best x2 and at least 30B for
 *                  code work, fast x0.5).
 *   latency  L     1 / (1 + total / target): total = wait for a slot + RTT + prefill + decode.
 *                  wait: pickup p50 when the agent has a free slot, else half a typical call plus
 *                  the calls queued for the model per slot. prefill and decode from the agent's
 *                  measured tok/s (hardware verification), else a class default scaled by the
 *                  model's active parameters, slowed by the calls already running on the agent
 *                  (contentionFactor: a CPU host's cores are shared by every call it runs).
 *   price    P     1 / (1 + cSats / priceRef): the call's tokens at the size price, never below
 *                  the class's power floor for its seconds (job-pricing.ts inferenceCostMsat).
 *   reliable R     (verifier reliability, else 0.9) x (0.93 if unverified) x (1 - recent failures)
 *                  x (UNPROVEN_PULL_FACTOR if the agent has not pulled work within PULL_FRESH_MS,
 *                  or never has: #523, a machine that heartbeats but never pulls is not capacity
 *                  Auto can count on, so a proven alternative wins unless it is the only fit).
 *   locality       the client's distance to the agent (clientRttMs, from the client's region; see
 *                  src/common/geo-regions.ts) is part of the estimate's round trip, so among
 *                  otherwise equal agents the one nearest the buyer is preferred (#526).
 *
 *   score = wQ Q + wL L + wP P + wR R, weights normalised to 1. Complexity c moves weight to
 *   quality (x(1 + k c)) and reliability (x(1 + k c / 2)) from latency and price (x(1 - k c / 2));
 *   k = complexityShift. quality "fast" and latency "batch" move it back.
 *
 * Session affinity: the agent that served the session's last turn holds the conversation's prefix
 * in its cache. It is kept when its wait (slot + RTT) is less than re-reading the whole prompt on
 * the best other agent (prompt tokens / that agent's prefill rate), and broken when it is stale,
 * failing, its context is too small, or the job no longer fits it.
 *
 * Per (model, class) only the best agent is kept; the answer is the best pair, its agent as a soft
 * preference (dispatch.ts preferAgent), and the ranked alternatives with their score breakdown.
 *
 * Cloud models (src/cloud-host/): every catalog cloud model whose host is online is an Auto
 * candidate by default (AUTO_CLOUD_MODELS unset; a list narrows it, "off" turns it off), but only
 * when either the job wants the network's top tier (jobWantsTopTier: not a light job, complexity
 * >= AUTO_CLOUD_MIN_COMPLEXITY), or no other machine meets the job's hard requirements (tools,
 * context window, price ceiling, the size floor of its spill band spillFloorB): the automatic
 * fallback when nothing on the network fits, or every other machine in the band is busy (no free
 * slot: the cloud host takes the overflow as more GPUs in the pool). A light or simple job a free
 * network machine can serve, by spilling to a smaller model if need be, never goes to the cloud:
 * this is a hard gate, decided before any score, so neither session affinity nor a faster estimate
 * puts it there (the cloud is not a candidate at all). A machine counts as room only when its
 * estimated completion is within maxCompletionMs (BEST_FIT_MAX_COMPLETION_MS): a 1.5b CPU host that
 * would need ~3 minutes for a 2.5k-token tests call is not room (run 4: 7 such spills timed out at
 * 180 s), so the cloud takes that overflow instead, and such a slow machine is not placed on while
 * the cloud can take the call.
 * Reasoning models (GLM-5.3, DeepSeek V4.1 Flash: they think in `reasoning_content` before they
 * answer): the cloud host asks the provider for the call's max_tokens plus a reasoning allowance
 * (src/cloud-host/host.ts), so a small max_tokens no longer ends inside the thinking. The old
 * filter (AUTO_REASONING_MIN_TOKENS: no reasoning model below a max_tokens) is off by default and
 * stays for a host without the allowance.
 * Among cloud models the standard one (Flash) is kept over a premium one (catalog hint "premium",
 * GLM-5.3) unless the job asks for the best quality at top-tier complexity and the premium one
 * is within the price ceiling; a premium one is also used when it is the only cloud model that fits.
 * A cloud host's speed is the hosted API's (not scaled by model size), it never cold-loads, and
 * its size is not penalised as oversized (its slots are not the network's scarce big-model slots).
 */

import { callsTools, paramsB } from "../../inference-api/auto-route.js";
import { describeComplexity } from "../../inference-api/job-complexity.js";
import { isCodeJob, isLightJob, type JobDescriptor, type JobType } from "../../inference-api/job-descriptor.js";
import { catalogEntryForTag } from "../../model/catalog.js";
import { inferenceCostMsat } from "../../economy/job-pricing.js";
import { modelTokenPrice } from "../../economy/cloud-pricing.js";
import { autoMayUseCloudModel, cloudModelSpec, isCloudModel, parseAutoCloudModels, type AutoCloudModels } from "../../cloud-host/catalog.js";

/** Complexity from which Auto may use a cloud model: where best fit asks for a 30B-class model (requirementsFor). */
export const AUTO_CLOUD_MIN_COMPLEXITY = 0.75;
/** A cloud host's decode rate when none was measured (tokens/s; hosted APIs serve far above a home machine). */
export const CLOUD_DECODE_TPS = 60;
const CLOUD_PREFILL_FACTOR = 40;

// ── Complexity class ─────────────────────────────────────────────────────────────────────
//
// Auto sorts every call into one of three classes before it scores anything:
//
//   simple    complexity < 0.25 and none of the "complex" signals: a small model on a CPU host or a
//             Mac is fine, and when the preferred model is full the call may spill down to any model
//             of at least SIMPLE_SPILL_MIN_B.
//   standard  everything in between: spill stays at or above half the job's size floor (min 3B).
//   complex   complexity >= COMPLEX_MIN_SCORE, or (non-light work) a long context, a large reply, an
//             agentic tool-use turn over real code, several files, or several reasoning cues. It wants
//             the network's top tier (GPU 30B-class or cloud models): its size floor is 14B and cloud
//             models are candidates. It never spills below that floor; when nothing that size is
//             healthy, the biggest available model with a free slot (at least COMPLEX_FALLBACK_MIN_B)
//             is used and the decision says so (belowFloor, capacity "spill"); only when none of
//             those is free does it queue for the biggest busy one (capacity "queued").
//
// The class and the reason are recorded in each routing decision (routing.ts routingSummary).

export type ComplexityClass = "simple" | "standard" | "complex";
/** Complexity score from which a call is complex (complexity level "high"). */
export const COMPLEX_MIN_SCORE = 0.5;
/** Context (prompt + reply room) from which non-light work is complex. */
export const LONG_CONTEXT_TOKENS = 16_000;
/** max_tokens above which non-light work is complex (8192, the usual default, is not). */
export const LARGE_REPLY_TOKENS = 8_192;
/** Prompt size from which an agentic tool-use turn counts as complex without other code signals. */
const AGENTIC_COMPLEX_PROMPT_TOKENS = 2_000;
/** A simple call's spill floor: any model at least this size. */
export const SIMPLE_SPILL_MIN_B = 1.5;
/**
 * D5 (run 3b): a complex call with nothing of its floor online takes the biggest model with a free
 * slot down to this size, rather than queue behind the one busy bigger host (5 of 8 waited 46 s on
 * a 2-slot 9b Mac and got 503 while a 7b Mac was free).
 */
export const COMPLEX_FALLBACK_MIN_B = 7;

type ClassInput = Pick<JobDescriptor, "job" | "complexity"> & Partial<Pick<JobDescriptor, "needsTools" | "contextTokens" | "maxTokens" | "promptTokens">>;

/** The call's complexity class and why (see above). */
export function complexityClassOf(job: ClassInput): { cls: ComplexityClass; why: string } {
  const c = job.complexity;
  const sig = (n: string) => c.signals?.find((s) => s.name === n)?.value ?? 0;
  if (!isLightJob(job.job)) {
    if (c.score >= COMPLEX_MIN_SCORE) return { cls: "complex", why: `complexity ${c.score.toFixed(2)}` };
    if ((job.contextTokens ?? 0) >= LONG_CONTEXT_TOKENS) return { cls: "complex", why: `long context (${job.contextTokens} tokens)` };
    if ((job.maxTokens ?? 0) > LARGE_REPLY_TOKENS) return { cls: "complex", why: `large reply (max ${job.maxTokens} tokens)` };
    // Content signals only when the client did not say how hard it is.
    if (c.hinted === undefined) {
      if (job.job === "agentic" && job.needsTools && (sig("code") >= 0.5 || sig("agentSteps") > 0 || (job.promptTokens ?? 0) >= AGENTIC_COMPLEX_PROMPT_TOKENS)) return { cls: "complex", why: "agentic tool-use turn" };
      if (sig("files") >= 0.4) return { cls: "complex", why: "multi-file" };
      if (sig("reasoning") >= 0.66) return { cls: "complex", why: "reasoning-heavy" };
    }
  }
  return c.score < 0.25 ? { cls: "simple", why: `complexity ${c.score.toFixed(2)}` } : { cls: "standard", why: `complexity ${c.score.toFixed(2)}` };
}

/** The complexity best fit sizes and weighs with: a complex call counts at least COMPLEX_MIN_SCORE. */
export function routingComplexity(job: ClassInput): number {
  return complexityClassOf(job).cls === "complex" ? Math.max(job.complexity.score, COMPLEX_MIN_SCORE) : job.complexity.score;
}

/** Smallest model a call may spill to when its preferred models are full (never below the client's hard floor). */
export function spillFloorB(job: ClassInput, req: Pick<Requirements, "minParamsB" | "hardMinParamsB">): number {
  const cls = complexityClassOf(job).cls;
  const band = cls === "complex" ? req.minParamsB : cls === "standard" ? Math.min(req.minParamsB, Math.max(3, req.minParamsB / 2)) : Math.min(req.minParamsB, SIMPLE_SPILL_MIN_B);
  return Math.max(band, req.hardMinParamsB ?? 0);
}

/**
 * The job is one Auto may always send to a cloud model: not light work, and complex enough to want
 * the network's top tier. Below that, a complex call (floor 14B) gets a cloud model when no healthy
 * machine of that size on the network has a free slot (cloudConsidered).
 */
export function jobWantsTopTier(job: Pick<JobDescriptor, "job" | "complexity">): boolean {
  return !isLightJob(job.job) && job.complexity.score >= AUTO_CLOUD_MIN_COMPLEXITY;
}

/** The job asks for more than the standard cloud model: the best quality at top-tier complexity (a premium cloud model may then win). */
export function jobWantsPremiumCloud(job: Pick<JobDescriptor, "job" | "complexity" | "quality">): boolean {
  return job.quality === "best" && jobWantsTopTier(job);
}

const isPremiumCloud = (model: string) => cloudModelSpec(model)?.hint === "premium";

/** A cloud model's cost-plus price for inferenceCostMsat (economy/cloud-pricing.ts); none for other models. */
function ownPriceOf(model: string): { price?: NonNullable<ReturnType<typeof modelTokenPrice>> } {
  const price = modelTokenPrice(model);
  return price ? { price } : {};
}

export interface AgentView {
  agentId: string;
  /** Masked label for explanations ("mac-•••1a2b"). */
  label: string;
  coordinatorId: string;
  /** Registered with this coordinator (only these can be placed on here). */
  local: boolean;
  computeClass: string;
  /** Tier weight the class's power floor scales by. */
  tierWeight: number;
  models: string[];
  activeModel?: string | null;
  /** Models loaded on the agent now (its memory telemetry); undefined: not reported. */
  loadedModels?: string[];
  slots: number;
  freeSlots: number;
  /** Context window the agent serves with; undefined: not reported (the model's own). */
  contextWindow?: number;
  /** Measured decode rate (hardware verification evidence), tokens/s. */
  tokensPerSec?: number;
  /** Verifier reliability score 0..1 (undefined: too few samples). */
  reliability?: number;
  verified: boolean;
  /** Share of recent model calls that failed, 0..1. */
  failRate?: number;
  /** Round trip agent <-> its coordinator. */
  rttMs?: number | null;
  /** Round trip this coordinator <-> the agent's coordinator (peers only). */
  linkRttMs?: number | null;
  stale: boolean;
  /**
   * How long ago the agent last pulled work (ms). null: it has not pulled (recently, or ever);
   * undefined: not known (a peer's agent). See UNPROVEN_PULL_FACTOR.
   */
  pullAgeMs?: number | null;
  /** Estimated round trip between the buyer and this agent (from their regions); undefined: not known. */
  clientRttMs?: number;
  /** worldOwnerTag of the owner account, when known (a requester's own agents are left out of auto). */
  ownerTag?: string | null;
  /**
   * Not taking work now although online (its circuit is open, or it is under memory pressure):
   * placed on only when no healthy candidate fits (spill, below).
   */
  unhealthy?: boolean;
}

export interface NetworkView {
  agents: AgentView[];
  /** Claimable-to-claimed time, p50 (dispatch.ts pickupStats). */
  pickupP50Ms: number;
  /** Model calls waiting per model. */
  waitingByModel: Record<string, number>;
  btcUsd: number;
}

export interface SessionMemo {
  agentId: string;
  model: string;
  computeClass: string;
  atMs: number;
}

export interface BestFitWeights {
  quality: number;
  latency: number;
  price: number;
  reliability: number;
}

export interface BestFitConfig {
  weights: BestFitWeights;
  /** How far complexity moves weight to quality and reliability (0: not at all). */
  complexityShift: number;
  /** Total time at which the latency score is 0.5. */
  latencyTargetMs: { interactive: number; batch: number };
  /**
   * Cost (cSats) at which the price score is 0.5. 5 since the 30B-class price rose ~4.7× (2026-11-16),
   * so a 30B call scores on price as it did before and Auto still sends code work to it.
   */
  priceRefCSats: number;
  /** How long dispatch keeps a call for the chosen agent before anyone eligible may take it. */
  preferMs: number;
  /**
   * #523: an Auto call nobody has picked up after this long is re-placed on the next candidate
   * (auto-replace.ts); 0 turns it off.
   */
  replaceMs: number;
  /** How long a session remembers the agent of its last turn. */
  sessionTtlMs: number;
  /** Quality taken off a model more than 4x (up to 8x) the size the job wants. */
  oversizePenalty: number;
  /** Also score agents on peer coordinators (the caller may be sent there). */
  peers: boolean;
  /**
   * Cloud models Auto may use (AUTO_CLOUD_MODELS): "all" (the default: every autoEligible catalog
   * model whose host is online), "off", or a list of ids. See the module comment for when.
   */
  autoCloudModels: AutoCloudModels;
  /**
   * Reasoning models and the smallest max_tokens a call needs for them (AUTO_REASONING_MIN_TOKENS):
   * a call with a smaller max_tokens never goes to them. Empty: no such filter.
   */
  reasoningMinTokens: Record<string, number>;
  /**
   * Longest estimated completion (ms) a machine may need for Auto to count it as room for a call
   * (BEST_FIT_MAX_COMPLETION_MS): past it the cloud may take the call as overflow, and while the
   * cloud can, the slow machine is not placed on. Two thirds of the coordinator's 180 s call deadline
   * by default: estimates are rough.
   */
  maxCompletionMs: number;
}

/**
 * The budget a bare number in AUTO_REASONING_MIN_TOKENS used to default to (run 3b: GLM-5.3 0/40
 * reasoning_only at 1024). Unset is now no filter: the cloud host gives reasoning models room on top
 * of max_tokens (src/cloud-host/host.ts DEFAULT_REASONING_ALLOWANCE).
 */
export const DEFAULT_REASONING_MIN_TOKENS = 1_024;
export const KNOWN_REASONING_MODELS: readonly string[] = ["glm-5.3", "deepseek-v4.1-flash"];

/**
 * AUTO_REASONING_MIN_TOKENS: unset, "off" or "0", no filter (the cloud host's reasoning allowance
 * makes room); a number, every built-in reasoning model at that; "model=n,model=n", those models (a
 * bare number in the list sets the built-in ones; model=0 removes one).
 */
export function parseReasoningMinTokens(raw: string | undefined): Record<string, number> {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "" || t === "off" || t === "none" || t === "0" || t === "false") return {};
  const out: Record<string, number> = {};
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 1_000_000;
  for (const part of t.split(",").map((x) => x.trim()).filter(Boolean)) {
    const eq = part.lastIndexOf("=");
    if (eq < 0) {
      const n = Number(part);
      if (ok(n)) for (const m of KNOWN_REASONING_MODELS) out[m] = n;
      continue;
    }
    const model = part.slice(0, eq).trim();
    const n = Number(part.slice(eq + 1).trim());
    if (model && ok(n)) out[model] = n;
  }
  for (const [m, n] of Object.entries(out)) if (n === 0) delete out[m];
  return out;
}

/** The max_tokens a call needs for `model` (a reasoning model); undefined: no minimum. */
export function reasoningMinTokensFor(model: string, cfg: Pick<BestFitConfig, "reasoningMinTokens"> = DEFAULT_BEST_FIT_CONFIG): number | undefined {
  return (cfg.reasoningMinTokens ?? {})[model];
}

/** The call's max_tokens leaves room for `model` to answer after its reasoning (no max_tokens: the provider's default, room). */
export function outputRoomFor(model: string, maxTokens: number | undefined, cfg: Pick<BestFitConfig, "reasoningMinTokens"> = DEFAULT_BEST_FIT_CONFIG): boolean {
  const min = reasoningMinTokensFor(model, cfg);
  return min === undefined || maxTokens === undefined || maxTokens >= min;
}

export const DEFAULT_BEST_FIT_CONFIG: BestFitConfig = {
  weights: { quality: 0.4, latency: 0.3, price: 0.15, reliability: 0.15 },
  complexityShift: 1,
  latencyTargetMs: { interactive: 8_000, batch: 120_000 },
  priceRefCSats: 5,
  preferMs: 400,
  replaceMs: 12_000,
  sessionTtlMs: 30 * 60_000,
  oversizePenalty: 0.25,
  peers: true,
  autoCloudModels: "all",
  reasoningMinTokens: parseReasoningMinTokens(undefined),
  maxCompletionMs: 120_000,
};

/** The config from BEST_FIT_* variables; a missing or invalid value keeps its default. */
export function bestFitConfigFromEnv(env: Record<string, string | undefined> = process.env): BestFitConfig {
  const d = DEFAULT_BEST_FIT_CONFIG;
  const num = (v: string | undefined, def: number, min = 0, max = Infinity) => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  return {
    weights: {
      quality: num(env.BEST_FIT_W_QUALITY, d.weights.quality, 0, 10),
      latency: num(env.BEST_FIT_W_LATENCY, d.weights.latency, 0, 10),
      price: num(env.BEST_FIT_W_PRICE, d.weights.price, 0, 10),
      reliability: num(env.BEST_FIT_W_RELIABILITY, d.weights.reliability, 0, 10),
    },
    complexityShift: num(env.BEST_FIT_COMPLEXITY_SHIFT, d.complexityShift, 0, 2),
    latencyTargetMs: {
      interactive: num(env.BEST_FIT_LATENCY_TARGET_MS, d.latencyTargetMs.interactive, 100),
      batch: num(env.BEST_FIT_BATCH_LATENCY_TARGET_MS, d.latencyTargetMs.batch, 100),
    },
    priceRefCSats: num(env.BEST_FIT_PRICE_REF_CSATS, d.priceRefCSats, 0.001),
    preferMs: num(env.BEST_FIT_PREFER_MS, d.preferMs, 0, 10_000),
    replaceMs: num(env.BEST_FIT_REPLACE_MS, d.replaceMs, 0, 120_000),
    sessionTtlMs: num(env.BEST_FIT_SESSION_TTL_MS, d.sessionTtlMs, 0),
    oversizePenalty: num(env.BEST_FIT_OVERSIZE_PENALTY, d.oversizePenalty, 0, 1),
    peers: !["0", "false"].includes((env.BEST_FIT_PEERS ?? "").trim().toLowerCase()),
    autoCloudModels: parseAutoCloudModels(env.AUTO_CLOUD_MODELS),
    reasoningMinTokens: parseReasoningMinTokens(env.AUTO_REASONING_MIN_TOKENS),
    maxCompletionMs: num(env.BEST_FIT_MAX_COMPLETION_MS, d.maxCompletionMs, 1_000, 3_600_000),
  };
}

// ── Job requirements ──────────────────────────────────────────────────────────────────────

/** Smallest model (B params) per job at low complexity. */
export const BASE_MIN_B: Record<JobType, number> = {
  chat: 3, code_edit: 7, code_review: 7, tests: 7, refactor: 7, summarize: 1, extract: 1, classify: 0.5, long_context: 7, agentic: 7,
};
/** Size past which a bigger model adds little for the job (at medium complexity). */
export const ENOUGH_B: Record<JobType, number> = {
  chat: 7, code_edit: 14, code_review: 14, tests: 14, refactor: 30, summarize: 3, extract: 3, classify: 1.5, long_context: 14, agentic: 30,
};

export interface Requirements {
  minParamsB: number;
  /** The client's hard floor (job.minParamsB): never anything smaller, not even as "best available". */
  hardMinParamsB?: number;
  enoughParamsB: number;
  needsTools: boolean;
  contextTokens: number;
}

/** Complexity raises the minimum: high complexity wants a 30B-class model, low takes small ones. */
export function requirementsFor(job: JobDescriptor): Requirements {
  const c = routingComplexity(job);
  const light = isLightJob(job.job);
  const byComplexity = light ? (c >= 0.75 ? 7 : c >= 0.5 ? 3 : 0) : c >= 0.75 ? 30 : c >= 0.5 ? 14 : c >= 0.25 ? 7 : 0;
  const hardMinParamsB = job.minParamsB && job.minParamsB > 0 ? job.minParamsB : undefined;
  const minParamsB = Math.max(BASE_MIN_B[job.job], byComplexity, hardMinParamsB ?? 0);
  const qualityFactor = job.quality === "best" ? 2 : job.quality === "fast" ? 0.5 : 1;
  let enoughParamsB = Math.max(minParamsB, ENOUGH_B[job.job] * (0.5 + 1.5 * c) * qualityFactor);
  // "best": code work prefers a 30B-class coder, other work at least 14B (light jobs excepted).
  if (job.quality === "best" && !light) enoughParamsB = Math.max(enoughParamsB, isCodeJob(job.job) ? 30 : 14);
  return { minParamsB, ...(hardMinParamsB ? { hardMinParamsB } : {}), enoughParamsB: Math.round(enoughParamsB * 10) / 10, needsTools: job.needsTools, contextTokens: job.contextTokens };
}

/** Weights for this job: complexity moves weight to quality and reliability; normalised to 1. */
export function effectiveWeights(job: JobDescriptor, cfg: BestFitConfig = DEFAULT_BEST_FIT_CONFIG): BestFitWeights {
  const k = cfg.complexityShift * routingComplexity(job);
  const w = { ...cfg.weights };
  w.quality *= 1 + k;
  w.reliability *= 1 + k / 2;
  w.latency *= Math.max(0.1, 1 - k / 2);
  w.price *= Math.max(0.1, 1 - k / 2);
  if (job.quality === "fast") {
    w.latency *= 1.6;
    w.quality *= 0.7;
  } else if (job.quality === "best") {
    w.quality *= 1.6;
    w.price *= 0.6;
  }
  if (job.latency === "batch") {
    w.latency *= 0.3;
    w.price *= 1.3;
  }
  const sum = w.quality + w.latency + w.price + w.reliability || 1;
  const r = (n: number) => Math.round((n / sum) * 1000) / 1000;
  return { quality: r(w.quality), latency: r(w.latency), price: r(w.price), reliability: r(w.reliability) };
}

// ── Speeds and estimates ──────────────────────────────────────────────────────────────────

/** Decode tok/s of a 7B-active model per class, when nothing was measured. */
export const CLASS_TPS_7B: Record<string, number> = { cpu: 6, apple: 25, gpu: 45, "gpu.dc": 90 };
/** Prompt reading is this many times faster than decoding, per class. */
export const PREFILL_FACTOR: Record<string, number> = { cpu: 6, apple: 12, gpu: 25, "gpu.dc": 40 };

const isEmbedding = (m: string) => /embed/i.test(m);
const isCoder = (m: string) => /coder|devstral|codestral|deepseek-coder/i.test(m);

/** Parameters active per token (MoE: "30B (3.3B active)" -> 3.3), else the total. */
export function activeParamsB(model: string): number {
  const active = /\(([\d.]+)\s*B active\)/i.exec(catalogEntryForTag(model)?.paramSize ?? "");
  const tagB = paramsB(model);
  // The catalog entry may be a sibling tag (same family, other size): only trust it for the same total size.
  if (active && Number(/^\s*([\d.]+)\s*B/i.exec(catalogEntryForTag(model)?.paramSize ?? "")?.[1]) === tagB) return Number(active[1]);
  return tagB;
}

/** Decode tok/s of `model` on `agent`: measured (scaled from its active model), else the class default. */
export function decodeTps(agent: Pick<AgentView, "computeClass" | "tokensPerSec" | "activeModel">, model: string): number {
  // A cloud host runs every model on the provider's hardware: its own measured rate, else a flat default.
  if (agent.computeClass === "cloud") return agent.tokensPerSec && agent.tokensPerSec > 0 ? Math.min(500, agent.tokensPerSec) : CLOUD_DECODE_TPS;
  const b = Math.max(0.3, activeParamsB(model));
  if (agent.tokensPerSec && agent.tokensPerSec > 0) {
    const ref = agent.activeModel ? Math.max(0.3, activeParamsB(agent.activeModel)) : b;
    return Math.max(0.5, Math.min(500, agent.tokensPerSec * (ref / b)));
  }
  return Math.max(0.5, Math.min(300, (CLASS_TPS_7B[agent.computeClass] ?? CLASS_TPS_7B.cpu) * (7 / b)));
}

export function prefillTps(agent: Pick<AgentView, "computeClass" | "tokensPerSec" | "activeModel">, model: string): number {
  return decodeTps(agent, model) * (agent.computeClass === "cloud" ? CLOUD_PREFILL_FACTOR : PREFILL_FACTOR[agent.computeClass] ?? PREFILL_FACTOR.cpu);
}

/** Context window an agent serves `model` with: its report, else the model's published one. */
export function contextWindowOf(agent: Pick<AgentView, "contextWindow">, model: string): number {
  return agent.contextWindow ?? cloudModelSpec(model)?.contextWindow ?? catalogEntryForTag(model)?.contextTokens ?? 32_768;
}

export interface Estimate {
  waitMs: number;
  rttMs: number;
  prefillMs: number;
  decodeMs: number;
  ttftMs: number;
  totalMs: number;
  cSats: number;
}

/** Rough cold-load time of a model (weights read into memory): ~1 s plus ~0.4 s per billion parameters. */
export function coldLoadMs(model: string): number {
  return Math.round(1_000 + paramsB(model) * 400);
}

/** Calls already waiting for `model`, per agent that holds it. */
export function queuedShare(view: Pick<NetworkView, "waitingByModel">, model: string, holdersOfModel: number): number {
  return (view.waitingByModel[model] ?? 0) / Math.max(1, holdersOfModel);
}

/**
 * The agent could start one more call for the model now: its free slots less its share of the calls
 * already waiting for that model (a burst placed on one host fills it before anyone pulls).
 */
export function hasFreeSlot(agent: Pick<AgentView, "freeSlots">, queued: number): boolean {
  return agent.freeSlots - queued > 0;
}

/**
 * Run 5: how much slower a call runs on `agent` while it shares the machine with the calls already
 * running there. The measured speed (tokensPerSec) is one call alone; a CPU host's cores (or a Mac's
 * memory bandwidth) are shared by every call it runs at once, so a 2-slot CPU host with one call
 * running serves a second at about half speed. Simple "tests" calls estimated at 115-119 s on a
 * 1.5b CPU host that was already running one (inf-1795600164112-dd9f5233 and two more) ran past the
 * 180 s deadline. A cloud host is not slowed by its other calls.
 */
export const CONTENTION_SHARE: Record<string, number> = { cpu: 1, apple: 0.5, gpu: 0.25, "gpu.dc": 0.15, cloud: 0 };

/** 1 + CONTENTION_SHARE × the calls the agent would be running beside this one (at most slots − 1). */
export function contentionFactor(agent: Pick<AgentView, "computeClass" | "slots" | "freeSlots">, queued = 0): number {
  const share = CONTENTION_SHARE[agent.computeClass] ?? CONTENTION_SHARE.cpu;
  if (!(share > 0) || agent.slots <= 1) return 1;
  const others = Math.min(agent.slots - 1, Math.max(0, agent.slots - agent.freeSlots + Math.max(0, queued)));
  return 1 + share * others;
}

export function estimate(job: JobDescriptor, agent: AgentView, model: string, view: Pick<NetworkView, "pickupP50Ms" | "waitingByModel" | "btcUsd">, holdersOfModel: number, cachedPrefix = false): Estimate {
  const tps = decodeTps(agent, model);
  const pre = prefillTps(agent, model);
  const queued = queuedShare(view, model, holdersOfModel);
  // Run 5: the calls already running there (and those queued for it) share the machine with this one.
  const slowdown = contentionFactor(agent, queued);
  const prefillMs = (((cachedPrefix ? job.newTokens : job.promptTokens) / pre) * 1000) * slowdown;
  const decodeMs = ((job.expectedOutputTokens / tps) * 1000) * slowdown;
  let waitMs = Math.max(50, view.pickupP50Ms || 250);
  if (!hasFreeSlot(agent, queued)) {
    // A typical call on this agent: ~2k prompt tokens and ~500 reply tokens.
    const typical = (2_000 / pre + 500 / tps) * 1000;
    waitMs += typical * (0.5 + Math.max(0, queued - Math.max(0, agent.freeSlots)) / Math.max(1, agent.slots));
  }
  // Model affinity: an agent that has to load the model first pays the load (and it may unload
  // another to make room), so an agent with it loaded wins a close call.
  if (agent.loadedModels && !agent.loadedModels.includes(model) && agent.computeClass !== "cloud") waitMs += coldLoadMs(model);
  const rttMs = (agent.rttMs ?? 50) + (agent.local ? 0 : agent.linkRttMs ?? 100) + Math.max(0, agent.clientRttMs ?? 0);
  const ttftMs = waitMs + rttMs + prefillMs;
  const totalMs = ttftMs + decodeMs;
  const cost = inferenceCostMsat({
    promptTokens: job.promptTokens, outputTokens: job.expectedOutputTokens, paramsB: paramsB(model), btcUsd: view.btcUsd, ...ownPriceOf(model),
    durationMs: prefillMs + decodeMs, computeClass: agent.computeClass, tierWeight: agent.tierWeight, floorSlots: agent.slots, perSecondCostMsat: 0,
  });
  const r = (n: number) => Math.round(n);
  return { waitMs: r(waitMs), rttMs: r(rttMs), prefillMs: r(prefillMs), decodeMs: r(decodeMs), ttftMs: r(ttftMs), totalMs: r(totalMs), cSats: Math.round(cost.costMsat) / 1000 };
}

// ── Scoring ───────────────────────────────────────────────────────────────────────────────

export interface ScoreParts {
  quality: number;
  latency: number;
  price: number;
  reliability: number;
}

export interface Candidate {
  model: string;
  computeClass: string;
  agentId: string;
  agentLabel: string;
  coordinatorId: string;
  local: boolean;
  paramsB: number;
  score: number;
  parts: ScoreParts;
  estimate: Estimate;
  /** Below the job's minimum size, kept because nothing that meets it is available. */
  belowFloor: boolean;
  /** Chosen over the job's preferred models because those are full (within the spill band). */
  spill?: boolean;
}

export type AffinityStatus = "none" | "kept" | "broken";

export interface BestFitResult {
  chosen: Candidate | null;
  /** The call's complexity class and why (complexityClassOf). */
  complexityClass?: ComplexityClass;
  complexityWhy?: string;
  /** Capacity: "preferred" (a preferred model had a free slot), "spill" (they were full: spilled within the band), "queued" (nothing in the band is free). */
  capacity?: "preferred" | "spill" | "queued";
  /** Smallest model the call could spill to. */
  spillFloorB?: number;
  /** Best agent per (model, class), best first (at most 8). */
  candidates: Candidate[];
  requirements: Requirements;
  weights: BestFitWeights;
  affinity: { status: AffinityStatus; reason?: string };
  /** One line: why this one. */
  reason: string;
  /** Why nothing fits, when chosen is null. */
  rejected?: string;
  /**
   * The same as a code: "none" (no agent with a model), "tools", "context", "size" (nothing meets
   * the client's hard floor, hardMinParamsB), or "price" (every fitting model, cloud ones included,
   * costs more than job.maxCSats: a money problem, not capacity).
   */
  rejectedCode?: "none" | "tools" | "context" | "size" | "price";
  /** "price": the cheapest fitting estimate (cSats), so the caller can say what the step needs. */
  cheapestCSats?: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Capability fit 0..1: log size against the size the job wants, a coder bonus on code work, and a
 * right-sizing penalty for a model far bigger than the job needs (more than 4x enoughParamsB), so
 * the few big-model slots stay free for the jobs that need them.
 */
export function qualityPrior(model: string, job: JobDescriptor, req: Requirements, oversizePenalty = DEFAULT_BEST_FIT_CONFIG.oversizePenalty): number {
  const b = paramsB(model);
  const enough = Math.max(0.5, req.enoughParamsB);
  const q = Math.log2(1 + b) / Math.log2(1 + enough);
  const oversize = isCloudModel(model) ? 0 : oversizePenalty * Math.max(0, Math.min(1, Math.log2(b / (4 * enough))));
  return Math.max(0, Math.min(1, q + (isCodeJob(job.job) && isCoder(model) ? 0.08 : 0)) - oversize);
}

/** An agent that pulled work this recently is proven capacity (agents poll every 1-3 s). */
export const PULL_FRESH_MS = 30_000;
/** Reliability multiplier for an agent that has not pulled within PULL_FRESH_MS, or never has (#523). */
export const UNPROVEN_PULL_FACTOR = 0.5;

/** The agent pulls work: false when it has not within PULL_FRESH_MS (or never); true when unknown. */
export function pullsWork(a: Pick<AgentView, "pullAgeMs">): boolean {
  return a.pullAgeMs === undefined || (a.pullAgeMs !== null && a.pullAgeMs <= PULL_FRESH_MS);
}

export function reliabilityOf(a: AgentView): number {
  return (a.reliability ?? 0.9) * (a.verified ? 1 : 0.93) * (1 - Math.max(0, Math.min(1, a.failRate ?? 0))) * (pullsWork(a) ? 1 : UNPROVEN_PULL_FACTOR);
}

function scoreOf(parts: ScoreParts, w: BestFitWeights): number {
  return round3(w.quality * parts.quality + w.latency * parts.latency + w.price * parts.price + w.reliability * parts.reliability);
}

type Evaluated = Candidate & { cloud: boolean; contextOk: boolean; priceOk: boolean; toolsOk: boolean; free: boolean; healthy: boolean; inTime: boolean };

/**
 * Cloud models are considered for this job: it wants the top tier, or no other machine meets its
 * hard requirements (tools, context, price ceiling, size floor): the fallback when nothing fits.
 *
 * C6 (2026-11-25 run 3c: 41 of 118 simple Auto calls went to the cloud host at low load). The size
 * floor here is the call's spill band (spillFloorB), not its preferred minimum: when the preferred
 * models (a simple call's 7b/9b Macs) are full, a free machine in the band (an idle 1.5b CPU host)
 * takes the call by spilling, before the cloud host does. The cloud host is overflow: it joins only
 * when no non-cloud machine in the band has a free slot. A complex call's band is its floor (14B),
 * so it is unchanged; a top-tier job always may use it.
 *
 * Run 4: a machine whose estimated completion is past maxCompletionMs (inTime false) is not room:
 * it would end at the call's deadline.
 */
export function cloudConsidered(
  job: JobDescriptor,
  req: Requirements,
  all: ReadonlyArray<Pick<Evaluated, "cloud" | "toolsOk" | "contextOk" | "priceOk" | "paramsB"> & Partial<Pick<Evaluated, "free" | "healthy" | "inTime">>>,
  floorB: number = spillFloorB(job, req),
): boolean {
  if (jobWantsTopTier(job)) return true;
  // Also when every other machine in the band is full or not taking work: the cloud host is one
  // more machine in the pool (expand), and drops out again once one has room (contract).
  return !all.some((c) => !c.cloud && c.toolsOk && c.contextOk && c.priceOk && c.paramsB >= floorB && c.free !== false && c.healthy !== false && c.inTime !== false);
}

/**
 * Among the cloud models that fit, the standard one (Flash) unless the job wants a premium one
 * (jobWantsPremiumCloud) and one fits within the price ceiling; a premium one alone stays.
 */
function cloudTier<T extends Pick<Evaluated, "cloud" | "model">>(job: JobDescriptor, fits: T[]): T[] {
  const premium = fits.filter((c) => c.cloud && isPremiumCloud(c.model));
  const standard = fits.filter((c) => c.cloud && !isPremiumCloud(c.model));
  if (!premium.length || !standard.length) return fits;
  const drop = new Set<T>(jobWantsPremiumCloud(job) ? standard : premium);
  return fits.filter((c) => !drop.has(c));
}

/** "qwen2.5-coder:7b, qwen3.5:9b": the models online that Auto may use, for an error (at most 8). */
function onlineModels(view: NetworkView, cfg: BestFitConfig): string {
  const usable = (m: string) => !isEmbedding(m) && (!isCloudModel(m) || autoMayUseCloudModel(m, cfg.autoCloudModels ?? "all"));
  const ms = [...new Set(view.agents.filter((a) => !a.stale).flatMap((a) => a.models).filter(usable))];
  ms.sort((a, b) => paramsB(a) - paramsB(b) || a.localeCompare(b));
  return ms.length ? `${ms.slice(0, 8).join(", ")}${ms.length > 8 ? `, +${ms.length - 8} more` : ""}` : "none";
}

/** Every (agent, model) that passes the hard filters except size, with its parts and score. */
function evaluate(job: JobDescriptor, view: NetworkView, cfg: BestFitConfig, req: Requirements, w: BestFitWeights, session?: SessionMemo) {
  const holders = new Map<string, number>();
  for (const a of view.agents) if (!a.stale) for (const m of new Set(a.models)) holders.set(m, (holders.get(m) ?? 0) + 1);
  const out: Evaluated[] = [];
  const shortOutput = new Set<string>();
  const target = job.latency === "batch" ? cfg.latencyTargetMs.batch : cfg.latencyTargetMs.interactive;
  for (const a of view.agents) {
    if (a.stale) continue;
    for (const model of new Set(a.models)) {
      if (isEmbedding(model)) continue;
      // Cloud: only the models AUTO_CLOUD_MODELS allows (default: every autoEligible one); when it
      // may be used is bestFit's call (cloudConsidered).
      const cloud = a.computeClass === "cloud" || isCloudModel(model);
      if (cloud && !autoMayUseCloudModel(model, cfg.autoCloudModels ?? "all")) continue;
      // C5: a reasoning model whose thinking alone would use up the call's max_tokens.
      if (!outputRoomFor(model, job.maxTokens, cfg)) {
        shortOutput.add(model);
        continue;
      }
      const cached = !!session && session.agentId === a.agentId && session.model === model;
      const held = holders.get(model) ?? 1;
      const est = estimate(job, a, model, view, held, cached);
      const parts: ScoreParts = {
        quality: round3(qualityPrior(model, job, req, cfg.oversizePenalty)),
        latency: round3(1 / (1 + est.totalMs / target)),
        price: round3(1 / (1 + est.cSats / cfg.priceRefCSats)),
        reliability: round3(reliabilityOf(a)),
      };
      out.push({
        model, computeClass: a.computeClass, agentId: a.agentId, agentLabel: a.label, coordinatorId: a.coordinatorId, local: a.local,
        paramsB: paramsB(model), score: scoreOf(parts, w), parts, estimate: est, belowFloor: false, cloud,
        toolsOk: !req.needsTools || callsTools(model),
        contextOk: req.contextTokens <= contextWindowOf(a, model),
        priceOk: job.maxCSats === undefined || est.cSats <= job.maxCSats,
        free: !a.unhealthy && hasFreeSlot(a, queuedShare(view, model, held)),
        healthy: !a.unhealthy,
        inTime: est.totalMs <= (cfg.maxCompletionMs ?? DEFAULT_BEST_FIT_CONFIG.maxCompletionMs),
      });
    }
  }
  return Object.assign(out, { shortOutput });
}

const fmtS = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The single biggest reason the chosen candidate beat the runner-up. */
function whyChosen(c: Candidate, next: Candidate | undefined, w: BestFitWeights, req: Requirements): string {
  if (!next) return `the only ${c.belowFloor ? "available model" : "model that fits"}`;
  const gains: Array<[number, string]> = [
    [w.quality * (c.parts.quality - next.parts.quality), `most capable that fits (${c.paramsB}B, ~${req.enoughParamsB}B wanted)`],
    [w.latency * (c.parts.latency - next.parts.latency), `fastest that fits (est. ${fmtS(c.estimate.totalMs)} vs ${fmtS(next.estimate.totalMs)})`],
    [w.price * (c.parts.price - next.parts.price), `cheapest that fits (est. ${c.estimate.cSats} vs ${next.estimate.cSats} cSats)`],
    [w.reliability * (c.parts.reliability - next.parts.reliability), "most reliable that fits"],
  ];
  gains.sort((a, b) => b[0] - a[0]);
  return gains[0][1];
}

/** Score every candidate for `job` on `view`; see the module comment. */
export function bestFit(job: JobDescriptor, view: NetworkView, cfg: BestFitConfig = DEFAULT_BEST_FIT_CONFIG, session?: SessionMemo, nowMs = 0): BestFitResult {
  const req = requirementsFor(job);
  const w = effectiveWeights(job, cfg);
  const cc = complexityClassOf(job);
  const bandB = spillFloorB(job, req);
  const classInfo = { complexityClass: cc.cls, complexityWhy: cc.why, spillFloorB: bandB };
  const sessionLive = session && (nowMs === 0 || nowMs - session.atMs <= cfg.sessionTtlMs) ? session : undefined;
  const evaluated = evaluate(job, view, cfg, req, w, sessionLive);
  // Cloud models only for top-tier jobs, or when no other machine in the band has room (cloudConsidered).
  const cloudIn = evaluated.some((c) => c.cloud) && cloudConsidered(job, req, evaluated, bandB);
  // A machine that would end at the deadline is not placed on while a cloud model can take the call.
  const all = !cloudIn
    ? evaluated.filter((c) => !c.cloud)
    : evaluated.some((c) => c.cloud && c.toolsOk && c.contextOk && c.priceOk)
      ? evaluated.filter((c) => c.cloud || c.inTime)
      : evaluated;
  const hardB = req.hardMinParamsB ?? 0;
  const fits = cloudTier(job, all.filter((c) => c.toolsOk && c.contextOk && c.priceOk));
  const header = `${job.job.replace("_", " ")} · complexity ${describeComplexity(job.complexity, 2)} · ${cc.cls}${cc.why.startsWith("complexity") ? "" : ` (${cc.why})`}`;
  if (fits.length === 0 || (hardB > 0 && !fits.some((c) => c.paramsB >= hardB))) {
    const big = (c: Evaluated) => c.paramsB >= hardB;
    const rejectedCode: NonNullable<BestFitResult["rejectedCode"]> =
      all.length === 0 ? "none" :
      !all.some((c) => c.toolsOk) ? "tools" :
      !all.some((c) => c.toolsOk && c.contextOk) ? "context" :
      !all.some((c) => c.toolsOk && c.contextOk && big(c)) ? "size" : "price";
    const needs = [
      hardB > 0 || rejectedCode === "size" ? `a model ≥ ${hardB || req.minParamsB}B` : "a model",
      req.needsTools ? "with tools" : "",
      rejectedCode === "context" ? `and a ${req.contextTokens}-token context window` : "",
    ].filter(Boolean).join(" ");
    const cloudNote = cfg.autoCloudModels === "off" ? "; cloud models are off (AUTO_CLOUD_MODELS=off)" : "";
    const fitting = all.filter((c) => c.toolsOk && c.contextOk && big(c));
    const cheapestC = rejectedCode === "price" && fitting.length ? fitting.reduce((a, b) => (b.estimate.cSats < a.estimate.cSats ? b : a)) : undefined;
    // C5: reasoning models were online but the call's max_tokens leaves them no room to answer.
    const shortNote = evaluated.shortOutput.size ? `; ${[...evaluated.shortOutput].sort().map((m) => `${m} needs max_tokens ≥ ${reasoningMinTokensFor(m, cfg)}`).join(", ")}` : "";
    const rejected =
      rejectedCode === "none" ? `no agent with a model is online${cloudNote}${shortNote}` :
      rejectedCode === "price"
        ? `every fitting model costs more than the ${job.maxCSats} cSats ceiling (the cheapest, ${cheapestC!.model} on ${cheapestC!.computeClass}, is about ${round3(cheapestC!.estimate.cSats)} cSats)`
        : `No machine on the network can run this job right now (needs ${needs}; online: ${onlineModels(view, cfg)}${cloudNote}${shortNote})`;
    const cheapest = cheapestC ? round3(cheapestC.estimate.cSats) : undefined;
    return { chosen: null, candidates: [], requirements: req, weights: w, affinity: { status: "none" }, ...classInfo, reason: `${header}: nothing fits (${rejected})`, rejected, rejectedCode, ...(cheapest !== undefined ? { cheapestCSats: cheapest } : {}) };
  }
  // Agents not taking work now (circuit open, memory pressure) only when nothing healthy fits.
  const live = fits.some((c) => c.healthy) ? fits.filter((c) => c.healthy) : fits;
  let pool: Evaluated[] = live.filter((c) => c.paramsB >= req.minParamsB);
  let capacity: NonNullable<BestFitResult["capacity"]> = "preferred";
  if (!pool.some((c) => c.free)) {
    // Expand: the preferred models are full, so the call spills to models with a free slot within
    // the band its complexity allows (spillFloorB). Contract: once a preferred model has a free slot
    // again, this step does not run and calls go back to it.
    const spill = live.filter((c) => c.free && c.paramsB < req.minParamsB && c.paramsB >= bandB).map((c) => ({ ...c, spill: true }));
    if (spill.length) {
      pool = [...pool, ...spill];
      capacity = "spill";
    } else capacity = "queued";
  }
  if (pool.length === 0) {
    // Nothing meets the minimum: the biggest available models, marked. Every call takes the biggest
    // with a free slot, if any (a complex call only down to COMPLEX_FALLBACK_MIN_B, or the biggest
    // online when that is smaller); else it queues for the biggest busy one.
    const topAll = Math.max(...live.map((c) => c.paramsB));
    const freeSrc = live.filter((c) => c.free && (cc.cls !== "complex" || c.paramsB >= Math.min(COMPLEX_FALLBACK_MIN_B, topAll)));
    const src = freeSrc.length ? freeSrc : live;
    const top = Math.max(...src.map((c) => c.paramsB));
    pool = src.filter((c) => c.paramsB >= top).map((c) => ({ ...c, belowFloor: true }));
    capacity = pool.some((c) => c.free) ? "spill" : "queued";
  }
  // Never queue a simple or standard call behind a full host while a candidate in its band has a
  // free slot: free candidates rank first. A complex call, or one that asks for the best quality,
  // is scored as before: a much more capable model may be worth a short wait (auto-replace.ts moves
  // it if nobody picks it up).
  const freeFirst = cc.cls !== "complex" && job.quality !== "best";
  const better = (a: Evaluated, b: Evaluated) =>
    (freeFirst && a.free !== b.free ? (a.free ? -1 : 1) : 0) || b.score - a.score || a.estimate.totalMs - b.estimate.totalMs;
  // Best agent per (model, class).
  const byPair = new Map<string, Evaluated>();
  for (const c of pool) {
    const k = `${c.model}\u0000${c.computeClass}`;
    const prev = byPair.get(k);
    if (!prev || better(c, prev) < 0) byPair.set(k, c);
  }
  const strip = (c: Candidate): Candidate => {
    const { contextOk: _a, priceOk: _b, toolsOk: _c, cloud: _d, free: _e, healthy: _f, inTime: _g, ...rest } = c as Candidate & { contextOk?: boolean; priceOk?: boolean; toolsOk?: boolean; cloud?: boolean; free?: boolean; healthy?: boolean; inTime?: boolean };
    return rest;
  };
  const ranked = [...byPair.values()].sort(better).map(strip);
  const freeKeys = new Set(pool.filter((c) => c.free).map((c) => `${c.agentId}\u0000${c.model}`));
  let chosen = ranked[0];
  let affinity: BestFitResult["affinity"] = { status: "none" };

  if (sessionLive) {
    const agent = view.agents.find((a) => a.agentId === sessionLive.agentId);
    const sticky = pool.find((c) => c.agentId === sessionLive.agentId && c.model === sessionLive.model);
    if (!agent || agent.stale) affinity = { status: "broken", reason: "last turn's machine is offline" };
    else if (reliabilityOf(agent) < 0.5) affinity = { status: "broken", reason: "last turn's machine is failing" };
    else if (!all.some((c) => c.agentId === agent.agentId && c.model === sessionLive.model && c.contextOk)) affinity = { status: "broken", reason: "last turn's machine has too small a context window" };
    else if (!sticky) affinity = { status: "broken", reason: "the job no longer fits last turn's model" };
    else if (chosen.agentId === sticky.agentId && chosen.model === sticky.model) affinity = { status: "kept", reason: "the best fit is last turn's machine" };
    else {
      const other = ranked.find((c) => c.agentId !== sticky.agentId) ?? chosen;
      const otherAgent = view.agents.find((a) => a.agentId === other.agentId)!;
      const rereadMs = (job.promptTokens / prefillTps(otherAgent, other.model)) * 1000;
      const waitMs = sticky.estimate.waitMs + sticky.estimate.rttMs;
      if (waitMs < rereadMs) {
        chosen = strip(sticky);
        affinity = { status: "kept", reason: `prompt cached on last turn's machine (wait ${fmtS(waitMs)} < re-read ${fmtS(rereadMs)} elsewhere)` };
      } else {
        affinity = { status: "broken", reason: `last turn's machine is busy (wait ${fmtS(waitMs)} > re-read ${fmtS(rereadMs)} elsewhere)` };
      }
    }
  }

  const next = ranked.find((c) => c !== chosen && !(c.model === chosen.model && c.computeClass === chosen.computeClass));
  const why = affinity.status === "kept" && affinity.reason ? `session affinity: ${affinity.reason}` : whyChosen(chosen, next, w, req);
  // A cloud model that would have met the size but costs more than the ceiling: say so.
  const cloudOverBudget = chosen.belowFloor && all.some((c) => c.cloud && c.toolsOk && c.contextOk && !c.priceOk);
  const floorNote = chosen.belowFloor ? ` (nothing ≥ ${req.minParamsB}B is available${cloudOverBudget ? ` within the ${job.maxCSats} cSats ceiling` : ""}${cc.cls === "complex" ? `; complex call (${cc.why}) on a smaller model` : ""})` : "";
  const spillNote = chosen.spill ? ` (spilled: every model ≥ ${req.minParamsB}B is full; ${cc.cls} band ≥ ${bandB}B)` : "";
  // The cloud as overflow (not a top-tier job): say so, so a decision log shows why.
  const overflowNote = (chosen.computeClass === "cloud" || isCloudModel(chosen.model)) && cloudIn && !jobWantsTopTier(job) ? ` (cloud overflow: no machine ≥ ${bandB}B has a free slot that finishes within ${fmtS(cfg.maxCompletionMs ?? DEFAULT_BEST_FIT_CONFIG.maxCompletionMs)})` : "";
  return {
    chosen,
    candidates: ranked.slice(0, 8),
    requirements: req,
    weights: w,
    affinity,
    ...classInfo,
    capacity: chosen.spill || chosen.belowFloor ? capacity : freeKeys.has(`${chosen.agentId}\u0000${chosen.model}`) ? "preferred" : "queued",
    reason: `${header}: ${why}${floorNote}${spillNote}${overflowNote}`,
  };
}

/** "routed to qwen3-coder:30b on gpu because …" for replies and the usage page. */
export function routedLine(r: Pick<BestFitResult, "chosen" | "reason">): string {
  return r.chosen ? `routed to ${r.chosen.model} on ${r.chosen.computeClass} because ${r.reason}` : r.reason;
}
