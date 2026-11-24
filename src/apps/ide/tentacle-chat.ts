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
import type { ChatBackend } from "../../inference-api/types.js";
import type { ServedBy } from "../../swarm/served-by.js";
import type { TentacleSpec } from "./tentacles.js";

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
 * ends, answered or not (its hold is released). `maxTokens` caps each reply.
 */
export function hintedChat(
  backend: ChatBackend,
  hints: () => RoutingHints | Promise<RoutingHints>,
  signal: AbortSignal,
  onCall: (u: { cSats: number; where?: string; promptTokens?: number; outputTokens?: number; served?: ServedBy }) => void,
  guard?: () => void,
  o: { maxTokens?: number; after?: () => void } = {},
): ChatFn {
  return async ({ messages, tools }, onDelta) => {
    guard?.();
    const h = await hints();
    try {
      guard?.();
      let content = "";
      const toolCalls: ChatResult["toolCalls"] = [];
      const req = {
        messages: messages.map((m) => ({ ...m, role: (["system", "user", "assistant", "tool"].includes(m.role) ? m.role : "user") as "user" })),
        ...(tools ? { tools: tools as never } : {}),
        temperature: 0.2,
        ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}),
        hints: h,
      };
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
      return { content, toolCalls };
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

/** A note for an explicit network worker smaller than the helper floor (it often answers with nothing), or null. */
export function smallWorkerWarning(model: string, minB: number): string | null {
  const b = networkWorkerB(model);
  if (b === null || b >= minB) return null;
  return `${model.slice("network/".length)} is under ${minB}B: small models often return nothing for helper work; an empty attempt retries on auto (a stronger tier)`;
}

/**
 * Where the retry goes after an attempt that came back with nothing: auto moves up a tier (its
 * hints say quality best); an explicit network worker under the floor (`minB`) escalates to auto,
 * which picks the next tier within the helper's budget; any other explicit worker keeps its model
 * and asks for another machine (a fresh session key, so affinity doesn't send it back to the same one).
 */
export function retryAfterEmpty(model: string, minB: number, why: "empty_reply" | "no_file"): { model: string; freshHost: boolean; note: string } {
  const what = why === "empty_reply" ? "returned an empty reply" : "changed no file";
  const short = model.replace(/^network\//, "");
  if (model === "auto") return { model, freshHost: true, note: `the helper ${what}; retrying on a stronger tier` };
  const b = networkWorkerB(model);
  if (b !== null && b < minB) return { model: "auto", freshHost: true, note: `${short} ${what}; retrying on auto (a stronger tier than ${short})` };
  return { model, freshHost: true, note: `${short} ${what}; retrying on another machine` };
}

/**
 * The smallest model (billions of parameters) on this computer a helper may run on first, like
 * bots' BOT_AGENT_MIN_PARAMS_B: a tentacle is an agent loop with tools, so a tiny model never takes
 * one. Lower than bots' 14B because only low-complexity pieces run locally, and the retry goes to
 * the network. EDGECODER_TENTACLES_LOCAL_MIN_B overrides it.
 */
export const TENTACLE_LOCAL_MIN_PARAMS_B = 7;

export function tentacleLocalMinParamsB(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EDGECODER_TENTACLES_LOCAL_MIN_B);
  return env.EDGECODER_TENTACLES_LOCAL_MIN_B && Number.isFinite(n) && n >= 0 ? n : TENTACLE_LOCAL_MIN_PARAMS_B;
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

