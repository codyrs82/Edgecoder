// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Load profiles for the live-network load generator (scripts/loadgen/loadgen.mjs).
 *
 * A profile is a list of stages, each a total arrival rate in calls/s across the whole network
 * (every load-generator machine together) held for some seconds. Each machine runs rate / machines.
 * `loop: true` repeats the stage list until --duration is used up.
 *
 * HARD_MAX_RATE is the network-wide ceiling (owner's rule: at most 16 calls/s). Nothing a profile,
 * flag or environment variable says can raise it.
 */
export const HARD_MAX_RATE = 16;

/**
 * Weighted behaviour mixes per persona (see workload.mjs). Weights need not sum to 1.
 * codegen (write a function from a pasted module: a few thousand tokens in, a few hundred out) and
 * coding sessions are what real coding tools send, and what moves money; chat and burst are short.
 */
export const PERSONAS = {
  // Builds agents on top of the network: long multi-turn coding sessions and code generation.
  coder: { coding: 4, codegen: 4, chat: 1, burst: 0.5 },
  // Uses the chat: questions and "write me a function", occasionally a coding session.
  chatter: { codegen: 3, chat: 3, coding: 1, burst: 1 },
  // Backend integration: code generation and fan-out bursts of one-off calls.
  integrator: { codegen: 3, burst: 2, chat: 1, coding: 1 },
};

/**
 * Fallback models per behaviour, weighted, for a run without a capacity snapshot. With one,
 * workload.mjs modelMix builds the mix from the models the network holds (7b and up preferred).
 * The planner (planner.mjs) multiplies each weight by the model's free in-flight allowance, so the
 * load spreads over models in proportion to their free slots.
 */
export const MODELS = {
  chat: { "network/qwen2.5-coder:1.5b": 3, "network/qwen2.5-coder:7b": 2, "network/qwen2.5-coder:14b": 1, "network/qwen3-coder:30b": 1, auto: 1 },
  burst: { "network/qwen2.5-coder:1.5b": 4, "network/qwen2.5-coder:7b": 1, auto: 1 },
  coding: { "network/qwen3-coder:30b": 4, "network/qwen2.5-coder:14b": 3, "network/qwen2.5-coder:7b": 2, auto: 1, "network/qwen2.5-coder:1.5b": 0.5 },
  codegen: { "network/qwen3-coder:30b": 3, "network/qwen2.5-coder:14b": 3, "network/qwen2.5-coder:7b": 3, "network/qwen2.5-coder:1.5b": 0.5 },
};

/** Model size in billions of parameters from its name ("qwen2.5-coder:14b" -> 14); 7 when unknown. */
export function paramsB(model) {
  const mt = /[:\-_](\d+(?:\.\d+)?)b\b/i.exec(String(model));
  return mt ? Number(mt[1]) : 7;
}

/** Largest conversation (approx. tokens) a coding session grows to on a model. */
export function codingContext(modelId) {
  if (modelId === "auto") return 8_000;
  const b = paramsB(modelId);
  return b >= 25 ? 20_000 : b >= 12 ? 12_000 : b >= 6 ? 8_000 : 4_000;
}

const m = (min) => Math.round(min * 60);

/**
 * stages: [{ rate, seconds }]. breach: error-rate threshold over a 30 s window (with at least
 * minCalls calls) that steps the rate down and holds it there (planner.mjs RateGovernor); a run
 * stops early only for real failure (auth, budget, coordinator down), never for capacity.
 */
export const PROFILES = {
  smoke: {
    description: "2 minutes at 1.5 calls/s, small coding contexts: proves the path end to end",
    stages: [{ rate: 1.5, seconds: m(2) }],
    maxRate: 3,
    maxSeconds: m(2),
    codingContextScale: 0.2,
    breach: { errorRate: 0.5, minCalls: 10 },
  },
  steady: {
    description: "a steady 4 calls/s (override with --rate) for --duration (default 30 min)",
    stages: [{ rate: 4, seconds: m(30) }],
    breach: { errorRate: 0.15, minCalls: 20 },
  },
  ramp: {
    description: "0.5 -> 2 -> 4 -> 8 -> 12 -> 16 calls/s, --stage-minutes each (default 5); on errors holds the highest sustainable rate to --duration",
    stages: [0.5, 2, 4, 8, 12, 16].map((rate) => ({ rate, seconds: m(5) })),
    breach: { errorRate: 0.1, minCalls: 20 },
  },
  saturate: {
    description: "climb to 16 calls/s in 2-minute steps, then hold 16 for 20 minutes",
    stages: [...[2, 4, 8, 12].map((rate) => ({ rate, seconds: m(2) })), { rate: 16, seconds: m(20) }],
    breach: { errorRate: 0.4, minCalls: 30 },
  },
  sustain: {
    description: "find the sustainable rate (x1.5 a minute while slot utilization < 70%), then hold 70-85% utilization for --duration (default 60 min); never stops on capacity errors",
    stages: [{ rate: HARD_MAX_RATE, seconds: m(60) }],
    adaptive: true,
    startRate: 1,
    defaultSeconds: m(60),
    target: [0.7, 0.85],
    breach: { errorRate: 0.15, minCalls: 20 },
  },
  soak: {
    description: "a looped day-shaped schedule (2 -> 4 -> 6 -> 4 calls/s, 15 min each) for --duration (default 2 h)",
    stages: [2, 4, 6, 4].map((rate) => ({ rate, seconds: m(15) })),
    loop: true,
    defaultSeconds: m(120),
    breach: { errorRate: 0.1, minCalls: 20 },
  },
};

/** Parse "90s", "5m", "2h" or a bare number of seconds. */
export function parseDuration(s) {
  if (s === undefined || s === null || s === "") return undefined;
  const mt = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(String(s).trim());
  if (!mt) throw new Error(`bad duration: ${s}`);
  const n = Number(mt[1]);
  return Math.round(mt[2] === "h" ? n * 3600 : mt[2] === "m" ? n * 60 : n);
}

/**
 * The concrete schedule: [{ index, rate, startSec, seconds }] covering at most `durationSec`,
 * with every rate clamped to min(HARD_MAX_RATE, profile.maxRate, opts.maxRate).
 * opts: { durationSec, rate (fixed rate for every stage), stageSeconds, loop }.
 */
export function buildSchedule(profileName, opts = {}) {
  const p = PROFILES[profileName];
  if (!p) throw new Error(`unknown profile ${profileName}; one of ${Object.keys(PROFILES).join(", ")}`);
  const cap = Math.min(HARD_MAX_RATE, p.maxRate ?? HARD_MAX_RATE, opts.maxRate ?? HARD_MAX_RATE);
  // sustain: the governor sets the rate (--rate is where it starts); the schedule only cuts the run
  // into --stage-minutes (default 5) segments at the cap, so the report shows load over time.
  let base = p.adaptive ? [{ rate: cap, seconds: opts.stageSeconds ?? m(5) }] : p.stages.map((s) => ({ rate: opts.rate ?? s.rate, seconds: opts.stageSeconds ?? s.seconds }));
  const loop = p.adaptive ? true : opts.loop ?? p.loop ?? false;
  const once = base.reduce((a, s) => a + s.seconds, 0);
  let duration = opts.durationSec ?? p.defaultSeconds ?? once;
  if (p.maxSeconds) duration = Math.min(duration, p.maxSeconds);
  // A single-stage profile with a longer --duration simply holds its rate.
  if (base.length === 1 && !loop) base = [{ rate: base[0].rate, seconds: duration }];
  const out = [];
  let t = 0;
  for (let i = 0; t < duration; i++) {
    const s = base[i % base.length];
    if (i >= base.length && !loop) break;
    const seconds = Math.min(s.seconds, duration - t);
    out.push({ index: out.length, rate: Math.max(0, Math.min(cap, s.rate)), startSec: t, seconds });
    t += seconds;
  }
  return {
    profile: profileName, cap, loop, durationSec: t, stages: out, breach: p.breach, codingContextScale: p.codingContextScale ?? 1,
    adaptive: !!p.adaptive, ...(p.adaptive ? { startRate: Math.min(cap, opts.rate ?? p.startRate), target: p.target } : {}),
  };
}
