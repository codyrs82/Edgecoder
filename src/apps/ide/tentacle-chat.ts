// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * A tentacle's model calls and prompts (tentacles.ts): the ChatFn its agent loop runs on (hints,
 * a reply cap and a per-call price ceiling on every request), its system prompt and its first
 * message, the model on this computer a helper may run on first, and how an attempt that came
 * back with nothing is told apart and where its retry goes (#525).
 */

import type { ChatFn, ChatResult } from "./agent-loop.js";
import { callsTools, fitScore, paramsB, type Workload } from "../../inference-api/auto-route.js";
import { isFrontierModelId } from "../../inference-api/frontier-models.js";
import { catalogEntryForTag } from "../../model/catalog.js";
import type { RoutingHints } from "../../inference-api/job-descriptor.js";
import { ChatBackendError, type ChatBackend, type ChatMessage } from "../../inference-api/types.js";
import type { ServedBy } from "../../swarm/served-by.js";
import type { TentacleSpec } from "./tentacles.js";
import { isContextTooLong } from "./context-budget.js";
import { balanceRefusal, busyGaveUpMessage, busyRefusal, HELPER_BUSY_BACKOFF_MS, HELPER_MIN_REPLY_TOKENS, priceRefusalNeed } from "./tentacle-reserve.js";

/** "path#L10-L40" → { path, start, end }. */
export function parseFileRef(ref: string): { path: string; start?: number; end?: number } {
  const m = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(ref.trim());
  if (!m) return { path: ref.trim() };
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  return { path: m[1], start: Math.max(1, Math.min(start, end)), end: Math.max(start, end) };
}

/**
 * A ChatFn over a backend that sends `hints` with every request and reports each call's usage.
 * `hints` may wait (a call waits for room in the session's budget); `after` runs when the call
 * ends, answered or not (its hold is released). `maxTokens` caps each reply: a number, or sized
 * per call from its messages and tools (helperReplyTokens). A call refused as too long for every
 * host's context window, before any reply came, is sent once more with the minimum reply
 * (HELPER_MIN_REPLY_TOKENS) instead of failing the attempt. `onError` sees every other failed call,
 * including ones the agent loop then retries.
 */
export function hintedChat(
  backend: ChatBackend,
  hints: () => RoutingHints | Promise<RoutingHints>,
  signal: AbortSignal,
  onCall: (u: { cSats: number; where?: string; promptTokens?: number; outputTokens?: number; served?: ServedBy }) => void,
  guard?: () => void,
  o: { maxTokens?: number | ((messages: ChatMessage[], tools?: unknown[]) => number); after?: () => void; onError?: (err: unknown) => void; onPriceRefusal?: (neededCSats: number) => boolean; onBalanceRefusal?: (neededCSats?: number) => boolean; onBusyRefusal?: (waitMs: number) => boolean } = {},
): ChatFn {
  return async ({ messages, tools }, onDelta) => {
    guard?.();
    let h = await hints();
    let priceRetries = 0;
    let balanceRetries = 0;
    let busyRetries = 0;
    let busyWaitedMs = 0;
    try {
      guard?.();
      const msgs = messages.map((m) => ({ ...m, role: (["system", "user", "assistant", "tool"].includes(m.role) ? m.role : "user") as "user" }));
      let maxTokens = typeof o.maxTokens === "function" ? o.maxTokens(msgs, tools as unknown[] | undefined) : o.maxTokens;
      for (;;) {
        let content = "";
        const toolCalls: ChatResult["toolCalls"] = [];
        const req = {
          messages: msgs,
          ...(tools ? { tools: tools as never } : {}),
          temperature: 0.2,
          ...(maxTokens ? { maxTokens } : {}),
          hints: h,
        };
        try {
          for await (const p of backend(req, signal)) {
            if ("delta" in p) {
              content += p.delta;
              onDelta?.(p.delta);
            } else if ("toolCalls" in p) {
              for (const c of p.toolCalls) toolCalls.push({ name: c.function.name, arguments: c.function.arguments ?? {} });
            } else if ("done" in p) {
              onCall({ cSats: Number.isFinite(p.cSatsSpent) ? (p.cSatsSpent as number) : 0, where: p.where, promptTokens: p.promptTokens, outputTokens: p.outputTokens, ...(p.served ? { served: p.served } : {}) });
            }
          }
        } catch (err) {
          // No host's window holds the prompt and this reply: once, with the smallest useful reply.
          if (maxTokens && maxTokens > HELPER_MIN_REPLY_TOKENS && !content && !toolCalls.length && !signal.aborted && isContextTooLong(err)) {
            maxTokens = HELPER_MIN_REPLY_TOKENS;
            guard?.();
            continue;
          }
          // Run 12: refused for its price ceiling before anything ran: once more, with a ceiling that
          // covers what the network said the cheapest fitting model needs (hints() waits for room).
          const need = priceRefusalNeed(err);
          if (need !== undefined && !content && !toolCalls.length && !signal.aborted && priceRetries < 2 && o.onPriceRefusal?.(need)) {
            priceRetries++;
            h = await hints();
            guard?.();
            continue;
          }
          // Run 14: refused because the account's balance can't cover the reserve: once the other
          // helpers' calls end (or with a smaller ceiling), as onBalanceRefusal decides (hints() waits).
          const short = balanceRefusal(err);
          if (short && !content && !toolCalls.length && !signal.aborted && balanceRetries < 12 && o.onBalanceRefusal?.(short.neededCSats)) {
            balanceRetries++;
            h = await hints();
            guard?.();
            continue;
          }
          // Run 15: every machine that fits was busy (503 no_capacity): again after 2 s, 4 s, 8 s
          // (onBusyRefusal; hints() waits, then sizes the ceiling again), then fail saying so.
          if (busyRefusal(err) && !content && !toolCalls.length && !signal.aborted && o.onBusyRefusal) {
            const wait = HELPER_BUSY_BACKOFF_MS[busyRetries];
            if (wait !== undefined && o.onBusyRefusal(wait)) {
              busyRetries++;
              busyWaitedMs += wait;
              h = await hints();
              guard?.();
              continue;
            }
            if (busyRetries > 0) {
              const e = err as ChatBackendError;
              const gaveUp = new ChatBackendError(busyGaveUpMessage(e.message ?? String(err), busyRetries + 1, busyWaitedMs), e.status ?? 503, e.retryAfterSec, e.info);
              o.onError?.(gaveUp);
              throw gaveUp;
            }
          }
          o.onError?.(err);
          throw err;
        }
        return { content, toolCalls };
      }
    } finally {
      o.after?.();
    }
  };
}

export function tentacleSystemPrompt(readOnly: boolean): string {
  return [
    "You are a helper agent (a tentacle) working for a lead agent on one scoped piece of work.",
    readOnly
      ? "You can only read the project. Find what is asked and answer with the facts, file paths and line numbers."
      : "You work in a private copy of the project. Make exactly the change asked for, nothing else; keep edits small and in the style of the code around them. Paths are relative to the project folder.",
    // Small models (#525) often answered with nothing, or pasted code into the reply: say how a change is made.
    ...(readOnly ? [] : ["Change files only by calling edit_file (or write_file for a new file). Code pasted into your reply changes nothing."]),
    "Use the tools to read what you need. When you are done, reply without calling a tool: a short summary of what you did (or found) and anything the lead must know.",
    "Don't ask questions; nobody will answer. If the task can't be done, say why in your summary.",
  ].join("\n");
}

/** The tentacle's first message: the task, its instructions and the given files (within the size cap). */
export function tentaclePrompt(spec: TentacleSpec, read: (path: string) => string | null, maxChars: number, extra?: string): string {
  const parts: string[] = [`# Task\n${spec.task}`];
  if (spec.instructions.trim()) parts.push(`# Instructions\n${spec.instructions.trim()}`);
  if (spec.acceptance && spec.acceptance.kind !== "none") parts.push(`# Done when\nThis check passes in your workspace: ${spec.acceptance.kind} ${JSON.stringify(spec.acceptance.args ?? "")}`);
  if (extra) parts.push(extra);
  let budget = maxChars - parts.join("\n\n").length;
  const files: string[] = [];
  for (const ref of spec.files) {
    const { path, start, end } = parseFileRef(ref);
    const text = read(path);
    if (text === null) {
      files.push(`## ${ref}\n(not found)`);
      continue;
    }
    let body = text;
    let label = path;
    if (start) {
      const lines = text.split("\n").slice(start - 1, end);
      body = lines.map((l, i) => `${start + i}: ${l}`).join("\n");
      label = `${path} (lines ${start}-${start + lines.length - 1})`;
    }
    if (budget <= 200) {
      files.push(`## ${label}\n(not included: context limit; read it with read_file if needed)`);
      continue;
    }
    if (body.length > budget - 100) body = `${body.slice(0, budget - 100)}\n… (cut: read_file with offset for the rest)`;
    budget -= body.length + label.length + 10;
    files.push(`## ${label}\n\`\`\`\n${body}\n\`\`\``);
  }
  if (files.length) parts.push(`# Files\n${files.join("\n\n")}`);
  return parts.join("\n\n");
}

/**
 * Why an attempt came back with nothing usable (#525), or null when it did: the machine reported
 * an empty reply, the model said nothing and changed nothing, or a helper that writes changed no file.
 */
export function emptyAttempt(o: { modelError?: string; summary: string; changedFiles: number; writes: boolean }): "empty_reply" | "no_file" | null {
  if (o.modelError && /empty[_ ]reply/i.test(o.modelError)) return "empty_reply";
  if (!o.modelError && !o.summary.trim() && o.changedFiles === 0) return "empty_reply";
  if (o.writes && o.changedFiles === 0 && !o.modelError) return "no_file";
  return null;
}

/** The size (B params) of an explicit network worker, or null for auto and anything not on the network. */
function networkWorkerB(model: string): number | null {
  if (!model.startsWith("network/")) return null;
  return paramsB(model.slice("network/".length).replace(/@[\w.]+$/, ""));
}

/** Whether `model` is an explicit network worker smaller than the helper floor `minB` (0: no floor). */
export function underFloorWorker(model: string, minB: number): boolean {
  const b = networkWorkerB(model);
  return minB > 0 && b !== null && b < minB;
}

/**
 * The note for an explicit network worker under the helper floor (small models often answer helper
 * work with nothing), or null: its helpers run on auto with the floor instead (tentacles.ts), unless
 * EDGECODER_TENTACLES_MIN_B=0 keeps the explicit model.
 */
export function smallWorkerWarning(model: string, minB: number): string | null {
  if (!underFloorWorker(model, minB)) return null;
  return `${model.slice("network/".length)} is under ${minB}B: small models often return nothing for helper work, so helpers run on auto (a model of at least ${minB}B); set EDGECODER_TENTACLES_MIN_B=0 to keep ${model.slice("network/".length)}`;
}

/**
 * Where the retry goes after an attempt that came back with nothing. An empty reply is retried on
 * another machine at the same tier first (auto keeps its hints and the helper floor, so the retry
 * lands on another ≥ floor host before any cloud tier); a helper that changed no file moves auto up
 * a tier (its hints say quality best). An explicit network worker under the floor (`minB`) moves to
 * auto (with the floor; tentacles.ts already moves one there before the first attempt); any other explicit worker keeps its model and asks for another machine (a
 * fresh session key, so affinity doesn't send it back to the same one). `nextTier`: whether the
 * retry's hints move up a tier.
 */
export function retryAfterEmpty(model: string, minB: number, why: "empty_reply" | "no_file"): { model: string; freshHost: boolean; nextTier: boolean; note: string } {
  const what = why === "empty_reply" ? "returned an empty reply" : "changed no file";
  const short = model.replace(/^network\//, "");
  const nextTier = why === "no_file";
  const floor = minB > 0 ? `a model of at least ${minB}B` : "another machine";
  if (model === "auto") return { model, freshHost: true, nextTier, note: nextTier ? `the helper ${what}; retrying on a stronger tier` : `the helper ${what}; retrying on another machine${minB > 0 ? ` (${floor})` : ""}` };
  if (underFloorWorker(model, minB)) return { model: "auto", freshHost: true, nextTier, note: `${short} ${what}; retrying on auto (${floor})` };
  return { model, freshHost: true, nextTier: false, note: `${short} ${what}; retrying on another machine` };
}

/**
 * Whether a failed call's error says the place it went to can't serve now: a cloud provider error,
 * a 503, or every holder cooling down behind an open circuit (the coordinator's no_capacity
 * "cooling_down"). The client sees no breaker state before a call, so a tier that answered this way
 * is skipped by the session's next-tier retries for a while (tentacles.ts PROVIDER_ERROR_SKIP_MS).
 */
export function isProviderTierError(modelError: string | undefined): boolean {
  return !!modelError && /cloud_provider_(error|rate_limited)|cooling_down|\b503\b|service unavailable/i.test(modelError);
}

/**
 * The smallest model (billions of parameters) a helper's network call on auto may run on: a hard
 * floor sent as the minParamsB hint (best fit never goes below it). Small models (qwen2.5-coder:1.5b
 * on CPU) returned empty replies for most helper turns. An explicit network worker under it runs on
 * auto with the floor. EDGECODER_TENTACLES_MIN_B overrides it (0: no floor, an explicit worker is kept).
 */
export const TENTACLE_HELPER_MIN_PARAMS_B = 7;

function minBFrom(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return v && Number.isFinite(n) && n >= 0 ? n : dflt;
}

export function tentacleHelperMinParamsB(env: NodeJS.ProcessEnv = process.env): number {
  return minBFrom(env.EDGECODER_TENTACLES_MIN_B, TENTACLE_HELPER_MIN_PARAMS_B);
}

/**
 * The smallest model (billions of parameters) on this computer a helper may run on first, like
 * bots' BOT_AGENT_MIN_PARAMS_B: a tentacle is an agent loop with tools, so a tiny model never takes
 * one. Lower than bots' 14B because only low-complexity pieces run locally, and the retry goes to
 * the network. EDGECODER_TENTACLES_LOCAL_MIN_B overrides it.
 */
export const TENTACLE_LOCAL_MIN_PARAMS_B = 7;

export function tentacleLocalMinParamsB(env: NodeJS.ProcessEnv = process.env): number {
  return minBFrom(env.EDGECODER_TENTACLES_LOCAL_MIN_B, TENTACLE_LOCAL_MIN_PARAMS_B);
}

/**
 * The model on this computer a helper runs on first, or null when none can take it: it calls tools
 * (model/tool-support.ts, Ollama's capabilities), is at least `minParamsB` big, and its context
 * window (when the catalog knows it) holds the helper's `minContext`. Among those, Auto's fit for
 * agent work (auto-route.ts fitScore: ~14B coders first). Never a frontier id.
 */
export function pickLocalHelperModel(
  localModels: string[],
  need: { minContext: number; promptTokens?: number },
  o: { minParamsB?: number; callsTools?: (m: string) => boolean; contextTokens?: (m: string) => number | undefined } = {},
): string | null {
  const tools = o.callsTools ?? callsTools;
  const ctxOf = o.contextTokens ?? ((m: string) => catalogEntryForTag(m)?.contextTokens);
  const w: Workload = { heavy: true, needsTools: true, promptTokens: need.promptTokens ?? 0, minParamsB: o.minParamsB ?? tentacleLocalMinParamsB() };
  return (
    localModels
      .filter((m) => !isFrontierModelId(m) && tools(m))
      .filter((m) => {
        const c = ctxOf(m);
        return !c || c >= need.minContext;
      })
      .map((m) => ({ m, s: fitScore(m, w) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)[0]?.m ?? null
  );
}

