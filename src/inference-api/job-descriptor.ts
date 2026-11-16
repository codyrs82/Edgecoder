// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What a `model: "auto"` request is: the job descriptor best-fit routing scores candidates for
 * (src/swarm/coordinator/best-fit.ts).
 *
 * A client may say what it wants, in an `edgecoder` object on the request body or in headers:
 *
 *   job         chat | code_edit | code_review | tests | refactor | summarize | extract |
 *               classify | long_context | agentic          (x-edgecoder-job)
 *   quality     fast | balanced | best                     (x-edgecoder-quality)
 *   maxCSats    price ceiling for the call, cSats          (x-edgecoder-max-csats)
 *   latency     interactive | batch                        (x-edgecoder-latency)
 *   needsTools  true | false                               (x-edgecoder-needs-tools)
 *   minContext  tokens                                     (x-edgecoder-min-context)
 *   complexity  0..1 or low | medium | high | very_high    (x-edgecoder-complexity)
 *   sessionId   conversation id                            (x-session-id; else the OpenAI `user`)
 *
 * Whatever is not said is inferred from the request: tools mean an agent turn, the prompt's size,
 * and cues in the system prompt and the last user turn. Pure: no I/O.
 */

import { createHash } from "node:crypto";
import { estimateComplexity, hintScore, type Complexity, type ComplexityWeights, DEFAULT_COMPLEXITY_WEIGHTS } from "./job-complexity.js";
import type { ChatMessage } from "./types.js";

export const JOB_TYPES = ["chat", "code_edit", "code_review", "tests", "refactor", "summarize", "extract", "classify", "long_context", "agentic"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const QUALITIES = ["fast", "balanced", "best"] as const;
export type Quality = (typeof QUALITIES)[number];
export type LatencyClass = "interactive" | "batch";

/** What a client may say about a request. Every field is optional. */
export interface RoutingHints {
  job?: JobType;
  quality?: Quality;
  maxCSats?: number;
  latency?: LatencyClass;
  needsTools?: boolean;
  minContext?: number;
  complexity?: number | string;
  sessionId?: string;
}

export interface JobDescriptor {
  job: JobType;
  /** True when the job type was inferred rather than sent. */
  jobInferred: boolean;
  quality: Quality;
  latency: LatencyClass;
  needsTools: boolean;
  /** Tokens the call needs in the context window (prompt + reply room). */
  contextTokens: number;
  promptTokens: number;
  /** Tokens after the last assistant turn: what a machine that holds the conversation's prefix still has to read. */
  newTokens: number;
  /** Reply tokens expected (for latency and price), within max_tokens. */
  expectedOutputTokens: number;
  maxTokens?: number;
  maxCSats?: number;
  complexity: Complexity;
  /** Conversation key for session affinity. */
  sessionKey: string;
  /** Where the session key came from. */
  sessionFrom: "header" | "user" | "hash";
}

const LIGHT_JOBS: ReadonlySet<JobType> = new Set(["summarize", "extract", "classify"]);
export const isLightJob = (j: JobType) => LIGHT_JOBS.has(j);
const CODE_JOBS: ReadonlySet<JobType> = new Set(["code_edit", "code_review", "tests", "refactor", "agentic"]);
export const isCodeJob = (j: JobType) => CODE_JOBS.has(j);

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);
const bool = (v: unknown): boolean | undefined => (v === true || v === "true" || v === "1" ? true : v === false || v === "false" || v === "0" ? false : undefined);
const posNum = (v: unknown, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined;
};
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined => {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/-/g, "_") : "";
  return (list as readonly string[]).includes(s) ? (s as T) : undefined;
};

/** Hints from a raw object (the body's `edgecoder`, or a submit's `routing`); unknown or malformed fields are dropped. */
export function cleanHints(raw: unknown): RoutingHints {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: RoutingHints = {};
  const job = oneOf(JOB_TYPES, o.job);
  if (job) out.job = job;
  const quality = oneOf(QUALITIES, o.quality);
  if (quality) out.quality = quality;
  const maxCSats = posNum(o.maxCSats ?? o.max_csats, 1e9);
  if (maxCSats !== undefined) out.maxCSats = maxCSats;
  const latency = oneOf(["interactive", "batch"] as const, o.latency);
  if (latency) out.latency = latency;
  const needsTools = bool(o.needsTools ?? o.needs_tools);
  if (needsTools !== undefined) out.needsTools = needsTools;
  const minContext = posNum(o.minContext ?? o.min_context, 10_000_000);
  if (minContext !== undefined) out.minContext = Math.floor(minContext);
  const c = o.complexity;
  if (hintScore(c) !== undefined) out.complexity = typeof c === "number" ? c : String(c);
  const sessionId = str(o.sessionId ?? o.session_id, 200);
  if (sessionId) out.sessionId = sessionId;
  return out;
}

/**
 * Hints from an OpenAI- or Anthropic-style request: the body's `edgecoder` object, then
 * `x-edgecoder-*` headers (the body wins), the session from `x-session-id`, else the `user` field
 * (OpenAI) or `metadata.user_id` (Anthropic).
 */
export function routingHintsFrom(body: unknown, headers: Record<string, unknown> = {}): RoutingHints {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const fromHeaders = cleanHints({
    job: h("x-edgecoder-job"), quality: h("x-edgecoder-quality"), maxCSats: h("x-edgecoder-max-csats"), latency: h("x-edgecoder-latency"),
    needsTools: h("x-edgecoder-needs-tools"), minContext: h("x-edgecoder-min-context"), complexity: h("x-edgecoder-complexity"), sessionId: h("x-session-id"),
  });
  const fromBody = cleanHints(b.edgecoder);
  const out: RoutingHints = { ...fromHeaders, ...fromBody };
  if (!out.sessionId) {
    const user = str(b.user, 200) ?? str((b.metadata as Record<string, unknown> | undefined)?.user_id, 200);
    if (user) out.sessionId = `user:${user}`;
  }
  return out;
}

/** The first `head` and last `tail` characters of a long text. */
export function headTail(text: string, head: number, tail: number): string {
  return text.length <= head + tail ? text : `${text.slice(0, head)}\n${text.slice(-tail)}`;
}

/** Cues for each job type, tried in order on the last user turn and the system prompt. */
const JOB_CUES: Array<[JobType, RegExp]> = [
  ["tests", /\b(unit tests?|write (?:the )?tests?|test cases?|add tests?|test coverage|vitest|jest|pytest|spec file)\b/i],
  ["code_review", /\b(review (?:this|the|my)|code review|pull request|look over|critique|any (?:bugs|issues) in)\b/i],
  ["refactor", /\b(refactor\w*|restructur\w*|clean ?up (?:the|this) code|extract (?:a |the )?(?:function|method|class|module))\b/i],
  ["summarize", /\b(summar(?:y|ise|ize)|tl;?dr|recap|key points|condense|digest of)\b/i],
  ["classify", /\b(classify|categori[sz]e|label (?:this|each|the)|sentiment|which category|is this (?:spam|a bug|toxic))\b/i],
  ["extract", /\b(extract|pull out|parse (?:the|this|out)|as json|into json|structured data|fill (?:in )?the fields)\b/i],
  ["code_edit", /\b(fix|implement|add (?:a|an|the) \w+|change|update|modify|edit|write (?:a|an|the) (?:function|class|script|method|component)|bug)\b/i],
];

const LONG_CONTEXT_TOKENS = 24_000;

/** The job type when the client did not say: tools are an agent turn, then cues, then size. */
export function inferJob(messages: Array<Pick<ChatMessage, "role" | "content">>, tools: unknown[] | undefined, promptTokens: number, hasCode: boolean): JobType {
  if (tools?.length) return "agentic";
  const users = messages.filter((m) => m.role === "user");
  // The instructions: the start and end of the last user turn (a pasted log or file in between is not one).
  const last = headTail(users[users.length - 1]?.content ?? "", 1_500, 1_500);
  const system = messages.filter((m) => m.role === "system").map((m) => m.content.slice(0, 2_000)).join("\n");
  for (const text of [last, system]) {
    for (const [job, re] of JOB_CUES) {
      if (!re.test(text)) continue;
      // "fix" or "change" in a question without code is still chat.
      if (job === "code_edit" && !hasCode) continue;
      return job;
    }
  }
  if (promptTokens > LONG_CONTEXT_TOKENS) return "long_context";
  return hasCode ? "code_edit" : "chat";
}

/** Typical reply length per job (tokens) at medium complexity. */
const OUTPUT_BY_JOB: Record<JobType, number> = {
  chat: 400, code_edit: 700, code_review: 600, tests: 1_200, refactor: 1_500, summarize: 400, extract: 300, classify: 20, long_context: 600, agentic: 500,
};

/** Session key: the client's id when sent, else a hash of the conversation's first turns. */
export function sessionKeyOf(messages: Array<Pick<ChatMessage, "role" | "content">>, sessionId?: string): { key: string; from: JobDescriptor["sessionFrom"] } {
  if (sessionId) return { key: createHash("sha256").update(sessionId).digest("hex").slice(0, 32), from: sessionId.startsWith("user:") ? "user" : "header" };
  const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  return { key: createHash("sha256").update(`${system.slice(0, 4_000)}\u0000${firstUser.slice(0, 4_000)}`).digest("hex").slice(0, 32), from: "hash" };
}

export function describeJob(
  req: { messages: Array<Pick<ChatMessage, "role" | "content"> & { tool_calls?: unknown[] }>; tools?: unknown[]; maxTokens?: number },
  hints: RoutingHints = {},
  weights: ComplexityWeights = DEFAULT_COMPLEXITY_WEIGHTS,
): JobDescriptor {
  const chars = req.messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) + (req.tools ? JSON.stringify(req.tools).length : 0);
  const promptTokens = Math.ceil(chars / 3.5);
  let lastReply = -1;
  req.messages.forEach((m, i) => {
    if (m.role === "assistant") lastReply = i;
  });
  const newTokens = Math.ceil(req.messages.slice(lastReply + 1).reduce((n, m) => n + m.content.length, 0) / 3.5);
  const complexity = estimateComplexity(req, hints.complexity, weights);
  const hasCode = req.messages.some((m) => m.content.includes("```")) || complexity.signals.some((s) => (s.name === "code" && s.value >= 0.3) || s.name === "diff" || s.name === "trace");
  const job = hints.job ?? inferJob(req.messages, req.tools, promptTokens, hasCode);
  // Longer replies for harder jobs: 0.6x at trivial, 1.4x at very hard.
  let expectedOutputTokens = Math.round(OUTPUT_BY_JOB[job] * (0.6 + 0.8 * complexity.score));
  if (req.maxTokens) expectedOutputTokens = Math.min(expectedOutputTokens, req.maxTokens);
  // Same as the coordinator's contextNeeded (3 chars a token, room for the reply).
  const contextTokens = Math.max(hints.minContext ?? 0, Math.ceil(chars / 3) + (req.maxTokens ?? 4_096) + 256);
  const session = sessionKeyOf(req.messages, hints.sessionId);
  return {
    job,
    jobInferred: !hints.job,
    quality: hints.quality ?? "balanced",
    latency: hints.latency ?? "interactive",
    needsTools: hints.needsTools ?? (!!req.tools?.length || job === "agentic"),
    contextTokens,
    promptTokens,
    newTokens: Math.min(promptTokens, newTokens),
    expectedOutputTokens,
    ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
    ...(hints.maxCSats !== undefined ? { maxCSats: hints.maxCSats } : {}),
    complexity,
    sessionKey: session.key,
    sessionFrom: session.from,
  };
}
