// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Run 9 (2026-11-25, whole-pool test): simple Auto chats with max_tokens 1024
 * (inf-1795634792979-904caf10, inf-1795634791108-926930fc) went to the cloud host as "cloud overflow:
 * no machine ≥ 1.5B has a free slot that finishes within 120 s" while the 1.5b CPU hosts were idle.
 * The completion check judged each call on its max_tokens: at the 1.5b CPU decode rate (~6.5 tok/s)
 * any max_tokens above ~800 rules a CPU host out, although a simple chat writes a few hundred tokens.
 *
 * An Auto call is now judged on the reply it is expected to write, not its cap:
 *
 *   expected = the median output of recent finished Auto calls of the same job type (chat, tests, ...),
 *              with at least SERVICE_MIN_SAMPLES of them, else the job descriptor's own estimate
 *              (job-descriptor.ts OUTPUT_BY_JOB scaled by complexity); never above max_tokens.
 *
 * The same number judges the call at submit, at claim time and in the waiting sweep (judgedOutputOf),
 * so the places agree. Best fit's own estimates (price, latency) keep the descriptor's estimate. A reply that runs past it is still covered: it is cut at the deadline and
 * returned as a partial reply (finish_reason "length", edgecoder.cut "deadline"). Named-model calls
 * keep their max_tokens judgement (run 7: a caller who named a slow model with a long cap gets a
 * clean refusal, not a cut reply).
 *
 * Only replies from network machines count as samples: a cloud host's reasoning models count their
 * thinking as output, which says nothing about how long the visible reply is.
 */

import { SERVICE_MIN_SAMPLES, SERVICE_WINDOW_MS, SERVICE_SAMPLES } from "./start-eta.js";

/** Recent output lengths (tokens) of finished Auto calls, per job type. */
export class OutputLengths {
  private readonly byJob = new Map<string, Array<{ at: number; tokens: number }>>();

  record(job: string, tokens: number, atMs = Date.now()): void {
    if (!job || !Number.isFinite(tokens) || tokens <= 0) return;
    const list = this.byJob.get(job) ?? [];
    list.push({ at: atMs, tokens: Math.round(tokens) });
    if (list.length > SERVICE_SAMPLES) list.splice(0, list.length - SERVICE_SAMPLES);
    this.byJob.set(job, list);
  }

  /** Median recent output of `job`, null with fewer than SERVICE_MIN_SAMPLES in the window. */
  median(job: string, nowMs = Date.now()): number | null {
    const v = (this.byJob.get(job) ?? []).filter((s) => nowMs - s.at <= SERVICE_WINDOW_MS).map((s) => s.tokens);
    if (v.length < SERVICE_MIN_SAMPLES) return null;
    v.sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
  }

  clear(): void {
    this.byJob.clear();
  }
}

export const outputLengths = new OutputLengths();

/** The judged reply is never below this many tokens (a run of one-line answers does not make the next call free). */
export const EXPECTED_OUTPUT_MIN_TOKENS = 64;

/**
 * The reply an Auto call of `job` is judged on (tokens): the observed median, else the descriptor's
 * `expectedOutputTokens`, at least EXPECTED_OUTPUT_MIN_TOKENS, capped by `maxTokens`.
 */
export function expectedOutputTokens(job: { job: string; expectedOutputTokens: number; maxTokens?: number }, nowMs = Date.now()): number {
  const observed = outputLengths.median(job.job, nowMs);
  const base = Math.max(EXPECTED_OUTPUT_MIN_TOKENS, observed ?? job.expectedOutputTokens);
  const capped = job.maxTokens !== undefined && job.maxTokens > 0 ? Math.min(base, job.maxTokens) : base;
  return Math.max(1, Math.round(capped));
}

/** Auto calls waiting or running here: their job type and the reply they are judged on, by subtask id. */
const judged = new Map<string, { job: string; outputTokens: number }>();

/** An Auto call was placed: it is judged on `outputTokens` from now on (judgedOutputOf). */
export function noteJudgedOutput(subtaskId: string, job: string, outputTokens: number): void {
  judged.set(subtaskId, { job, outputTokens });
  if (judged.size > 20_000) judged.delete(judged.keys().next().value as string);
}

/** The reply an Auto call is judged on, undefined for a named-model call (judged on its max_tokens). */
export function judgedOutputOf(subtaskId: string): number | undefined {
  return judged.get(subtaskId)?.outputTokens;
}

/**
 * A call finished normally with `outputTokens`: an Auto call's output is a sample for its job type
 * (not when a cloud host served it), and it is no longer judged.
 */
export function noteFinishedOutput(subtaskId: string, outputTokens: number | undefined, computeClass: string | undefined, nowMs = Date.now()): void {
  const j = judged.get(subtaskId);
  if (!j) return;
  judged.delete(subtaskId);
  if (outputTokens !== undefined && computeClass !== "cloud") outputLengths.record(j.job, outputTokens, nowMs);
}

/** Forget calls that are gone (`alive` false). */
export function pruneJudged(alive: (subtaskId: string) => boolean): void {
  for (const id of judged.keys()) if (!alive(id)) judged.delete(id);
}

/** Tests: forget everything. */
export function clearExpectedOutput(): void {
  judged.clear();
  outputLengths.clear();
}
