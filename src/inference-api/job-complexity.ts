// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * How hard a model call is, from the request alone: a score from 0 (a one-line question) to 1 (a
 * multi-file agentic refactor), with the signals that drove it. Best-fit routing
 * (src/swarm/coordinator/best-fit.ts) uses it to set the smallest model it will pick, to move
 * weight from speed and price to capability and reliability, and to size the expected reply.
 *
 * Pure: no I/O, no clock. Each signal is measured on a 0..1 scale and weighted
 * (ComplexityWeights, configurable with BEST_FIT_COMPLEXITY_WEIGHTS_JSON); the score is the
 * weighted sum, clamped to 0..1. A client hint may move the score either way, but never below a
 * floor that clearly complex inputs (an agent loop several steps in, many files, a long reasoning
 * task over code) keep.
 */

import type { ChatMessage } from "./types.js";

export type ComplexityLevel = "low" | "medium" | "high" | "very_high";

/** What a client may send as `complexity`: a number (0..1) or a level. */
export type ComplexityHint = number | ComplexityLevel;

/** Weight of each signal in the score (each signal is 0..1; `simple` subtracts). */
export interface ComplexityWeights {
  /** Prompt and conversation length (tokens, log scale). */
  length: number;
  /** Number of conversation turns. */
  turns: number;
  /** Lines of code in the request. */
  code: number;
  /** Distinct source files mentioned. */
  files: number;
  /** Distinct programming languages. */
  languages: number;
  /** A diff or patch in the request. */
  diff: number;
  /** A stack trace or error log. */
  trace: number;
  /** Tools offered to the model. */
  tools: number;
  /** Steps already taken in an agent loop (tool calls and results). */
  agentSteps: number;
  /** Reasoning cues: plan, design, refactor across files, debug, prove, optimise ... */
  reasoning: number;
  /** Reply length asked for (max_tokens). */
  output: number;
  /** Simplicity cues ("one line", "typo", "quick", "yes or no"): subtracted. */
  simple: number;
}

export const DEFAULT_COMPLEXITY_WEIGHTS: ComplexityWeights = {
  length: 0.14,
  turns: 0.04,
  code: 0.1,
  files: 0.12,
  languages: 0.04,
  diff: 0.05,
  trace: 0.06,
  tools: 0.08,
  agentSteps: 0.1,
  reasoning: 0.2,
  output: 0.07,
  simple: 0.15,
};

/** The floor a clearly complex input keeps whatever the client hints. */
export const COMPLEX_FLOOR = 0.55;

export interface ComplexitySignal {
  name: keyof ComplexityWeights;
  /** The signal on its own 0..1 scale. */
  value: number;
  /** What it added to the score (negative for `simple`). */
  contribution: number;
  /** What was seen, in a few words ("3 files", "stack trace"). */
  detail: string;
}

export interface Complexity {
  /** 0 (trivial) to 1 (very hard). */
  score: number;
  level: ComplexityLevel;
  /** The server's estimate before any hint. */
  estimated: number;
  /** The floor a hint can't go below (0 unless the input is clearly complex). */
  floor: number;
  /** The client's hint, as a number, when one was sent. */
  hinted?: number;
  /** Signals that contributed, largest first. */
  signals: ComplexitySignal[];
}

export interface ComplexityInput {
  messages: Array<Pick<ChatMessage, "role" | "content"> & { tool_calls?: unknown[] }>;
  tools?: unknown[];
  maxTokens?: number;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function levelOf(score: number): ComplexityLevel {
  return score < 0.25 ? "low" : score < 0.5 ? "medium" : score < 0.75 ? "high" : "very_high";
}

const LEVEL_SCORE: Record<ComplexityLevel, number> = { low: 0.15, medium: 0.4, high: 0.65, very_high: 0.9 };

/** A hint as a number 0..1 (undefined when it is not one). */
export function hintScore(h: unknown): number | undefined {
  if (typeof h === "number" && Number.isFinite(h)) return clamp01(h);
  if (typeof h === "string") {
    const k = h.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (k in LEVEL_SCORE) return LEVEL_SCORE[k as ComplexityLevel];
    const n = Number(k);
    if (k !== "" && Number.isFinite(n)) return clamp01(n);
  }
  return undefined;
}

/** Weights from BEST_FIT_COMPLEXITY_WEIGHTS_JSON (a partial object), else the defaults. */
export function complexityWeightsFromEnv(env: Record<string, string | undefined> = process.env): ComplexityWeights {
  const raw = env.BEST_FIT_COMPLEXITY_WEIGHTS_JSON;
  if (!raw || !raw.trim()) return { ...DEFAULT_COMPLEXITY_WEIGHTS };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_COMPLEXITY_WEIGHTS };
    for (const k of Object.keys(out) as Array<keyof ComplexityWeights>) {
      const v = parsed[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) out[k] = v;
    }
    return out;
  } catch {
    return { ...DEFAULT_COMPLEXITY_WEIGHTS };
  }
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", rb: "ruby", php: "php",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", scala: "scala", sql: "sql", sh: "shell",
  bash: "shell", zsh: "shell", svelte: "svelte", vue: "vue", lua: "lua", dart: "dart", ex: "elixir", exs: "elixir",
  hs: "haskell", ml: "ocaml", r: "r", m: "objc", zig: "zig", tf: "terraform", yaml: "yaml", yml: "yaml",
  toml: "toml", json: "json", css: "css", scss: "css", html: "html", md: "markdown",
};
const CODE_LANGS = new Set(Object.values(EXT_LANG).filter((l) => !["yaml", "toml", "json", "markdown"].includes(l)));

const FILE_RE = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)*[\w-]+\.([a-z]{1,6}))(?=$|[\s`'"):,\]]|:\d)/gim;
const FENCE_RE = /```([\w+#-]*)[^\n]*\n([\s\S]*?)```/g;
const DIFF_RE = /^(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|--- a\/|\+\+\+ b\/)/m;
const TRACE_RE = /(?:Traceback \(most recent call last\)|^\s+at [\w$.<>]+ \(.*:\d+:\d+\)|^\s+at .+:\d+:\d+$|panicked at|^panic: |Exception in thread|^\w+(?:Error|Exception): |segmentation fault|^\s+File ".+", line \d+)/m;
const CODE_LINE_RE = /^\s*(?:(?:export\s+)?(?:async\s+)?(?:function|def|class|interface|struct|impl|fn|func|const|let|var|import|from|return|if|for|while|switch|case|try|catch|public|private|package|use|#include)\b|[}\])];?\s*$|.*[;{]\s*$|.*=>\s*\{?\s*$)/;

/** Reasoning cues: each distinct one counts. */
const REASONING_CUES: Array<[string, RegExp]> = [
  ["plan", /\b(plan|roadmap|step[- ]by[- ]step|break (?:it|this) down)\b/i],
  ["design", /\b(design|architect(?:ure)?|trade-?offs?|system design)\b/i],
  ["refactor", /\b(refactor\w*|restructur\w*|re-?architect\w*|migrat\w*)\b/i],
  ["cross-file", /\b(across (?:the )?(?:files|modules|packages|codebase|repo(?:sitory)?)|multiple files|every file|whole (?:codebase|repo(?:sitory)?)|monorepo)\b/i],
  ["debug", /\b(debug\w*|root cause|why (?:does|is|do|doesn't|isn't)|race condition|deadlock|memory leak|flaky|intermittent)\b/i],
  ["prove", /\b(prove|proof|invariant|formally|correctness|verify that)\b/i],
  ["optimise", /\b(optimi[sz]\w*|performance|faster|latency|throughput|big-?o|complexity of|profil\w*)\b/i],
  ["concurrency", /\b(concurren\w*|parallel\w*|thread-?safe|async(?:hronous)? ordering|lock-?free)\b/i],
  ["security", /\b(security|vulnerab\w*|exploit|threat model|sanitiz\w*|injection)\b/i],
  ["algorithm", /\b(algorithm|data structure|dynamic programming|graph|recursion|recursive)\b/i],
  ["implement", /\b(implement|build (?:a|an|the)|write (?:a|an|the) (?:module|service|library|feature|parser|compiler))\b/i],
];

const SIMPLE_CUES: Array<[string, RegExp]> = [
  ["one-line", /\b(one[- ]line[rd]?|single line|one[- ]liner)\b/i],
  ["typo", /\b(typo|spelling|rename|missing (?:semicolon|comma|import))\b/i],
  ["quick", /\b(quick(?:ly)?|briefly|short answer|in one sentence|tl;?dr|eli5)\b/i],
  ["yes/no", /\b(yes or no|true or false|just the (?:answer|number|name))\b/i],
  ["lookup", /^\s*(what is|what's|who is|when (?:is|was)|define|translate)\b/i],
];

/** Text the client wrote (user and system turns); tool results and replies are context, not instructions. */
function instructionText(messages: ComplexityInput["messages"]): string {
  const users = messages.filter((m) => m.role === "user");
  const last = users[users.length - 1]?.content ?? "";
  const system = messages.filter((m) => m.role === "system").map((m) => m.content.slice(0, 4_000)).join("\n");
  // The instructions are at the start and end of the last user turn; a pasted file or log in
  // between is measured by the code, file and trace signals, not searched for cues.
  const head = last.length > 5_000 ? `${last.slice(0, 3_000)}\n${last.slice(-2_000)}` : last;
  return `${head}\n${system}`;
}

/** Signals measured on the request; exported for the routing explanation and tests. */
export function measureSignals(input: ComplexityInput): Record<keyof ComplexityWeights, { value: number; detail: string }> {
  const messages = input.messages;
  const all = messages.map((m) => m.content).join("\n");
  const chars = all.length + messages.reduce((n, m) => n + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) + (input.tools ? JSON.stringify(input.tools).length : 0);
  const tokens = Math.ceil(chars / 3.5);
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant").length;

  // Code: fenced blocks, else lines that look like code.
  let codeLines = 0;
  const langs = new Set<string>();
  let fenced = false;
  for (const m of all.matchAll(FENCE_RE)) {
    fenced = true;
    codeLines += m[2].split("\n").filter((l) => l.trim()).length;
    const tag = m[1].toLowerCase();
    const lang = EXT_LANG[tag] ?? (CODE_LANGS.has(tag) ? tag : undefined);
    if (lang && CODE_LANGS.has(lang)) langs.add(lang);
  }
  if (!fenced) {
    const sample = all.length > 200_000 ? all.slice(0, 200_000) : all;
    for (const line of sample.split("\n")) if (line.trim() && CODE_LINE_RE.test(line)) codeLines++;
  }

  const files = new Set<string>();
  const scan = all.length > 200_000 ? all.slice(0, 200_000) : all;
  for (const m of scan.matchAll(FILE_RE)) {
    const ext = m[2].toLowerCase();
    if (!(ext in EXT_LANG)) continue;
    files.add(m[1]);
    const lang = EXT_LANG[ext];
    if (CODE_LANGS.has(lang)) langs.add(lang);
    if (files.size > 50) break;
  }

  const diff = DIFF_RE.test(scan);
  const trace = TRACE_RE.test(scan);
  const toolCount = input.tools?.length ?? 0;
  const steps = messages.filter((m) => m.role === "tool" || (m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0)).length;

  const text = instructionText(messages);
  const reasons = REASONING_CUES.filter(([, re]) => re.test(text)).map(([k]) => k);
  const simple = SIMPLE_CUES.filter(([, re]) => re.test(text)).map(([k]) => k);
  const maxTokens = input.maxTokens ?? 0;

  return {
    // ~200 tokens (a question) is 0; ~32k tokens is 1.
    length: { value: clamp01(Math.log10(Math.max(1, tokens) / 200) / Math.log10(160)), detail: `~${tokens} prompt tokens` },
    turns: { value: clamp01((turns - 1) / 12), detail: `${turns} turns` },
    // One line is 0; ~400 lines is 1.
    code: { value: codeLines <= 1 ? 0 : clamp01(Math.log2(codeLines) / Math.log2(400)), detail: `${codeLines} code lines` },
    files: { value: clamp01((files.size - 1) / 5), detail: `${files.size} files` },
    languages: { value: clamp01((langs.size - 1) / 3), detail: `${langs.size} languages` },
    diff: { value: diff ? 1 : 0, detail: "diff" },
    trace: { value: trace ? 1 : 0, detail: "stack trace" },
    tools: { value: toolCount ? clamp01(0.5 + toolCount / 16) : 0, detail: `${toolCount} tools` },
    agentSteps: { value: clamp01(steps / 6), detail: `${steps} agent steps` },
    reasoning: { value: clamp01(reasons.length / 3), detail: reasons.length ? reasons.join(", ") : "none" },
    // 512 tokens or fewer is 0; 8k+ is 1.
    output: { value: maxTokens > 512 ? clamp01(Math.log2(maxTokens / 512) / 4) : 0, detail: `max ${maxTokens || "default"} tokens` },
    simple: { value: clamp01(simple.length / 2), detail: simple.length ? simple.join(", ") : "none" },
  };
}

/**
 * The complexity of a request, with the signals behind it. `hint` (the client's `complexity`)
 * replaces the estimate, but a clearly complex input never goes below COMPLEX_FLOOR.
 */
export function estimateComplexity(input: ComplexityInput, hint?: unknown, weights: ComplexityWeights = DEFAULT_COMPLEXITY_WEIGHTS): Complexity {
  const s = measureSignals(input);
  const signals: ComplexitySignal[] = [];
  let total = 0;
  for (const name of Object.keys(weights) as Array<keyof ComplexityWeights>) {
    const value = s[name].value;
    const contribution = (name === "simple" ? -1 : 1) * weights[name] * value;
    total += contribution;
    if (value > 0) signals.push({ name, value: round3(value), contribution: round3(contribution), detail: s[name].detail });
  }
  signals.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const estimated = round3(clamp01(total));
  // Clearly complex: an agent loop several steps in, many files, or reasoning over a lot of code.
  const clearlyComplex = s.agentSteps.value >= 0.5 || s.files.value >= 0.6 || (s.reasoning.value >= 0.66 && s.code.value >= 0.5) || (s.diff.value > 0 && s.files.value >= 0.4);
  const floor = clearlyComplex ? COMPLEX_FLOOR : 0;
  const hinted = hintScore(hint);
  const score = round3(hinted === undefined ? Math.max(estimated, floor) : Math.max(hinted, floor));
  return { score, level: levelOf(score), estimated, floor, ...(hinted !== undefined ? { hinted } : {}), signals };
}

/** Signals that measure how deep an agent loop is rather than what the task is. */
const STEP_SIGNALS: ReadonlySet<keyof ComplexityWeights> = new Set(["agentSteps", "turns"]);

/**
 * The complexity Auto's local-first sizing uses (src/inference-api/auto-route.ts): the same
 * estimate, but the task's content decides the level. The floor that an agent loop several steps
 * in keeps (COMPLEX_FLOOR from step count alone) doesn't apply, and step depth (agent steps,
 * turns) adds its small weight but never lifts a step into high on its own: a simple task stays
 * low or medium however many steps it takes, so it stays on a free model. Content that is clearly
 * complex (many files, a diff across files, reasoning over a lot of code) keeps the floor. A
 * client's hint still counts. Pure: derived from `c` without measuring again. The coordinator's
 * best fit is unchanged (it uses estimateComplexity).
 */
export function contentComplexity(c: Complexity): Pick<Complexity, "level" | "score"> {
  const value = (n: keyof ComplexityWeights) => c.signals.find((s) => s.name === n)?.value ?? 0;
  const sum = (steps: boolean) => c.signals.filter((s) => STEP_SIGNALS.has(s.name) === steps).reduce((n, s) => n + s.contribution, 0);
  const clearlyComplex = value("files") >= 0.6 || (value("reasoning") >= 0.66 && value("code") >= 0.5) || (value("diff") > 0 && value("files") >= 0.4);
  const floor = clearlyComplex ? COMPLEX_FLOOR : 0;
  let score: number;
  if (c.hinted !== undefined) score = Math.max(c.hinted, floor);
  else {
    const content = clamp01(sum(false));
    const withSteps = clamp01(content + sum(true));
    // Step depth alone never crosses into high.
    score = Math.max(content < 0.5 ? Math.min(withSteps, 0.49) : withSteps, floor);
  }
  score = round3(score);
  return { score, level: levelOf(score) };
}

/** "high (0.68): 4 files, refactor, cross-file" for explanations. */
export function describeComplexity(c: Complexity, maxSignals = 3): string {
  const top = c.signals.filter((s) => s.contribution > 0).slice(0, maxSignals).map((s) => s.detail);
  return `${c.level.replace("_", " ")} (${c.score.toFixed(2)})${top.length ? `: ${top.join(", ")}` : ""}${c.hinted !== undefined ? " · client hint" : ""}`;
}
