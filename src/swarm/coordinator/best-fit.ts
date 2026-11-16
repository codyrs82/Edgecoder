// Copyright (c) 2025 EdgeCoder, LLC
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
 *                  model's active parameters.
 *   price    P     1 / (1 + cSats / priceRef): the call's tokens at the size price, never below
 *                  the class's power floor for its seconds (job-pricing.ts inferenceCostMsat).
 *   reliable R     (verifier reliability, else 0.9) x (0.93 if unverified) x (1 - recent failures).
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
 */

import { callsTools, paramsB } from "../../inference-api/auto-route.js";
import { describeComplexity } from "../../inference-api/job-complexity.js";
import { isCodeJob, isLightJob, type JobDescriptor, type JobType } from "../../inference-api/job-descriptor.js";
import { catalogEntryForTag } from "../../model/catalog.js";
import { inferenceCostMsat } from "../../economy/job-pricing.js";

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
  /** Cost (cSats) at which the price score is 0.5. */
  priceRefCSats: number;
  /** How long dispatch keeps a call for the chosen agent before anyone eligible may take it. */
  preferMs: number;
  /** How long a session remembers the agent of its last turn. */
  sessionTtlMs: number;
  /** Quality taken off a model more than 4x (up to 8x) the size the job wants. */
  oversizePenalty: number;
  /** Also score agents on peer coordinators (the caller may be sent there). */
  peers: boolean;
}

export const DEFAULT_BEST_FIT_CONFIG: BestFitConfig = {
  weights: { quality: 0.4, latency: 0.3, price: 0.15, reliability: 0.15 },
  complexityShift: 1,
  latencyTargetMs: { interactive: 8_000, batch: 120_000 },
  priceRefCSats: 1,
  preferMs: 400,
  sessionTtlMs: 30 * 60_000,
  oversizePenalty: 0.25,
  peers: true,
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
    sessionTtlMs: num(env.BEST_FIT_SESSION_TTL_MS, d.sessionTtlMs, 0),
    oversizePenalty: num(env.BEST_FIT_OVERSIZE_PENALTY, d.oversizePenalty, 0, 1),
    peers: !["0", "false"].includes((env.BEST_FIT_PEERS ?? "").trim().toLowerCase()),
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
  enoughParamsB: number;
  needsTools: boolean;
  contextTokens: number;
}

/** Complexity raises the minimum: high complexity wants a 30B-class model, low takes small ones. */
export function requirementsFor(job: JobDescriptor): Requirements {
  const c = job.complexity.score;
  const light = isLightJob(job.job);
  const byComplexity = light ? (c >= 0.75 ? 7 : c >= 0.5 ? 3 : 0) : c >= 0.75 ? 30 : c >= 0.5 ? 14 : c >= 0.25 ? 7 : 0;
  const minParamsB = Math.max(BASE_MIN_B[job.job], byComplexity);
  const qualityFactor = job.quality === "best" ? 2 : job.quality === "fast" ? 0.5 : 1;
  let enoughParamsB = Math.max(minParamsB, ENOUGH_B[job.job] * (0.5 + 1.5 * c) * qualityFactor);
  // "best": code work prefers a 30B-class coder, other work at least 14B (light jobs excepted).
  if (job.quality === "best" && !light) enoughParamsB = Math.max(enoughParamsB, isCodeJob(job.job) ? 30 : 14);
  return { minParamsB, enoughParamsB: Math.round(enoughParamsB * 10) / 10, needsTools: job.needsTools, contextTokens: job.contextTokens };
}

/** Weights for this job: complexity moves weight to quality and reliability; normalised to 1. */
export function effectiveWeights(job: JobDescriptor, cfg: BestFitConfig = DEFAULT_BEST_FIT_CONFIG): BestFitWeights {
  const k = cfg.complexityShift * job.complexity.score;
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
  const b = Math.max(0.3, activeParamsB(model));
  if (agent.tokensPerSec && agent.tokensPerSec > 0) {
    const ref = agent.activeModel ? Math.max(0.3, activeParamsB(agent.activeModel)) : b;
    return Math.max(0.5, Math.min(500, agent.tokensPerSec * (ref / b)));
  }
  return Math.max(0.5, Math.min(300, (CLASS_TPS_7B[agent.computeClass] ?? CLASS_TPS_7B.cpu) * (7 / b)));
}

export function prefillTps(agent: Pick<AgentView, "computeClass" | "tokensPerSec" | "activeModel">, model: string): number {
  return decodeTps(agent, model) * (PREFILL_FACTOR[agent.computeClass] ?? PREFILL_FACTOR.cpu);
}

/** Context window an agent serves `model` with: its report, else the model's published one. */
export function contextWindowOf(agent: Pick<AgentView, "contextWindow">, model: string): number {
  return agent.contextWindow ?? catalogEntryForTag(model)?.contextTokens ?? 32_768;
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

export function estimate(job: JobDescriptor, agent: AgentView, model: string, view: Pick<NetworkView, "pickupP50Ms" | "waitingByModel" | "btcUsd">, holdersOfModel: number, cachedPrefix = false): Estimate {
  const tps = decodeTps(agent, model);
  const pre = prefillTps(agent, model);
  const prefillMs = ((cachedPrefix ? job.newTokens : job.promptTokens) / pre) * 1000;
  const decodeMs = (job.expectedOutputTokens / tps) * 1000;
  let waitMs = Math.max(50, view.pickupP50Ms || 250);
  if (agent.freeSlots <= 0) {
    // A typical call on this agent: ~2k prompt tokens and ~500 reply tokens.
    const typical = (2_000 / pre + 500 / tps) * 1000;
    const queued = (view.waitingByModel[model] ?? 0) / Math.max(1, holdersOfModel);
    waitMs += typical * (0.5 + queued / Math.max(1, agent.slots));
  }
  const rttMs = (agent.rttMs ?? 50) + (agent.local ? 0 : agent.linkRttMs ?? 100);
  const ttftMs = waitMs + rttMs + prefillMs;
  const totalMs = ttftMs + decodeMs;
  const cost = inferenceCostMsat({
    promptTokens: job.promptTokens, outputTokens: job.expectedOutputTokens, paramsB: paramsB(model), btcUsd: view.btcUsd,
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
}

export type AffinityStatus = "none" | "kept" | "broken";

export interface BestFitResult {
  chosen: Candidate | null;
  /** Best agent per (model, class), best first (at most 8). */
  candidates: Candidate[];
  requirements: Requirements;
  weights: BestFitWeights;
  affinity: { status: AffinityStatus; reason?: string };
  /** One line: why this one. */
  reason: string;
  /** Why nothing fits, when chosen is null. */
  rejected?: string;
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
  const oversize = oversizePenalty * Math.max(0, Math.min(1, Math.log2(b / (4 * enough))));
  return Math.max(0, Math.min(1, q + (isCodeJob(job.job) && isCoder(model) ? 0.08 : 0)) - oversize);
}

export function reliabilityOf(a: AgentView): number {
  return (a.reliability ?? 0.9) * (a.verified ? 1 : 0.93) * (1 - Math.max(0, Math.min(1, a.failRate ?? 0)));
}

function scoreOf(parts: ScoreParts, w: BestFitWeights): number {
  return round3(w.quality * parts.quality + w.latency * parts.latency + w.price * parts.price + w.reliability * parts.reliability);
}

/** Every (agent, model) that passes the hard filters except size, with its parts and score. */
function evaluate(job: JobDescriptor, view: NetworkView, cfg: BestFitConfig, req: Requirements, w: BestFitWeights, session?: SessionMemo) {
  const holders = new Map<string, number>();
  for (const a of view.agents) if (!a.stale) for (const m of new Set(a.models)) holders.set(m, (holders.get(m) ?? 0) + 1);
  const out: Array<Candidate & { contextOk: boolean; priceOk: boolean; toolsOk: boolean }> = [];
  const target = job.latency === "batch" ? cfg.latencyTargetMs.batch : cfg.latencyTargetMs.interactive;
  for (const a of view.agents) {
    if (a.stale) continue;
    for (const model of new Set(a.models)) {
      if (isEmbedding(model)) continue;
      const cached = !!session && session.agentId === a.agentId && session.model === model;
      const est = estimate(job, a, model, view, holders.get(model) ?? 1, cached);
      const parts: ScoreParts = {
        quality: round3(qualityPrior(model, job, req, cfg.oversizePenalty)),
        latency: round3(1 / (1 + est.totalMs / target)),
        price: round3(1 / (1 + est.cSats / cfg.priceRefCSats)),
        reliability: round3(reliabilityOf(a)),
      };
      out.push({
        model, computeClass: a.computeClass, agentId: a.agentId, agentLabel: a.label, coordinatorId: a.coordinatorId, local: a.local,
        paramsB: paramsB(model), score: scoreOf(parts, w), parts, estimate: est, belowFloor: false,
        toolsOk: !req.needsTools || callsTools(model),
        contextOk: req.contextTokens <= contextWindowOf(a, model),
        priceOk: job.maxCSats === undefined || est.cSats <= job.maxCSats,
      });
    }
  }
  return out;
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
  const sessionLive = session && (nowMs === 0 || nowMs - session.atMs <= cfg.sessionTtlMs) ? session : undefined;
  const all = evaluate(job, view, cfg, req, w, sessionLive);
  const fits = all.filter((c) => c.toolsOk && c.contextOk && c.priceOk);
  const header = `${job.job.replace("_", " ")} · complexity ${describeComplexity(job.complexity, 2)}`;
  if (fits.length === 0) {
    const rejected =
      all.length === 0 ? "no agent with a model is online" :
      !all.some((c) => c.toolsOk) ? "no available model calls tools" :
      !all.some((c) => c.toolsOk && c.contextOk) ? `no agent's context window holds ${req.contextTokens} tokens` :
      `every fitting model costs more than the ${job.maxCSats} cSats ceiling`;
    return { chosen: null, candidates: [], requirements: req, weights: w, affinity: { status: "none" }, reason: `${header}: nothing fits (${rejected})`, rejected };
  }
  let pool: Candidate[] = fits.filter((c) => c.paramsB >= req.minParamsB);
  if (pool.length === 0) {
    // Nothing meets the minimum: the biggest available models, marked.
    const top = Math.max(...fits.map((c) => c.paramsB));
    pool = fits.filter((c) => c.paramsB >= top).map((c) => ({ ...c, belowFloor: true }));
  }
  // Best agent per (model, class).
  const byPair = new Map<string, Candidate>();
  for (const c of pool) {
    const k = `${c.model}\u0000${c.computeClass}`;
    const prev = byPair.get(k);
    if (!prev || c.score > prev.score || (c.score === prev.score && c.estimate.totalMs < prev.estimate.totalMs)) byPair.set(k, c);
  }
  const strip = (c: Candidate): Candidate => {
    const { contextOk: _a, priceOk: _b, toolsOk: _c, ...rest } = c as Candidate & { contextOk?: boolean; priceOk?: boolean; toolsOk?: boolean };
    return rest;
  };
  const ranked = [...byPair.values()].sort((a, b) => b.score - a.score || a.estimate.totalMs - b.estimate.totalMs).map(strip);
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
  const floorNote = chosen.belowFloor ? ` (nothing ≥ ${req.minParamsB}B is available)` : "";
  return {
    chosen,
    candidates: ranked.slice(0, 8),
    requirements: req,
    weights: w,
    affinity,
    reason: `${header}: ${why}${floorNote}`,
  };
}

/** "routed to qwen3-coder:30b on gpu because …" for replies and the usage page. */
export function routedLine(r: Pick<BestFitResult, "chosen" | "reason">): string {
  return r.chosen ? `routed to ${r.chosen.model} on ${r.chosen.computeClass} because ${r.reason}` : r.reason;
}
