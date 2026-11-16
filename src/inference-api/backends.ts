// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** What can run a chat: this machine's Ollama (free), or the network (your machines, a lease, or any agent). */

import { cpus } from "node:os";
import type { ServedBy } from "../swarm/served-by.js";
import { AutoUnsupportedError, NetworkInferenceError, RouteElsewhereError, streamNetworkCompletion, type NetworkDeps, type NetworkTarget } from "../apps/ide/network-inference.js";
import { contextWindowFor, ollamaChat, type OllamaPiece } from "./ollama.js";
import { ENGINE_PRESETS, EngineError, openAiEngineChat, type OpenAiEngine } from "./openai-engine.js";
import { noRouteMessage, planRoutes, sizeWorkload, type ComputePolicy, type PlanOptions, type QualityFloor, type Route, type RouteInputs } from "./auto-route.js";
import { ChatBackendError, type ChatBackend, type ChatPiece } from "./types.js";

/** "This computer (Apple M1 Max)": a call that ran on this machine's Ollama. */
export function thisComputer(t: { promptMs?: number; genMs?: number; promptTokens?: number; outputTokens?: number } = {}): ServedBy {
  const cpu = (cpus()[0]?.model ?? "").replace(/\s+/g, " ").trim();
  const out: ServedBy = { label: "This computer", own: true, computeClass: "local", tier: null, hardware: cpu ? `This computer (${cpu})` : "This computer", region: null, country: null };
  for (const k of ["promptMs", "genMs", "promptTokens", "outputTokens"] as const) if (typeof t[k] === "number" && Number.isFinite(t[k])) out[k] = Math.round(t[k]!);
  return out;
}

export function localBackend(ollamaHost: string, model: string): ChatBackend {
  return async function* (req, signal) {
    let stopped = "stop";
    let tokens: { promptTokens?: number; outputTokens?: number } = {};
    let timing: { promptMs?: number; genMs?: number } = {};
    try {
      // Sized per call, but never below the window this machine's agent serves network calls with
      // (AGENT_CONTEXT_WINDOW), so a short local chat does not make Ollama reload the model.
      const numCtx = contextWindowFor(req.messages, req.tools, req.maxTokens, Number(process.env.AGENT_CONTEXT_WINDOW) || undefined);
      for await (const p of ollamaChat(ollamaHost, { model, messages: req.messages, tools: req.tools, maxTokens: req.maxTokens, temperature: req.temperature, numCtx }, signal)) {
        if ("doneReason" in p) {
          stopped = p.doneReason;
          tokens = {
            ...(p.promptTokens !== undefined ? { promptTokens: p.promptTokens } : {}),
            ...(p.outputTokens !== undefined ? { outputTokens: p.outputTokens } : {})
          };
          timing = { promptMs: p.promptMs, genMs: p.genMs };
        } else yield p;
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/ECONNREFUSED|fetch failed|connect/i.test(msg)) throw new ChatBackendError("Ollama isn't running on this computer. Open EdgeCoder to start it.", 503);
      if (/not found/i.test(msg)) throw new ChatBackendError(`${model} isn't installed on this computer. Install it from Settings > Models.`, 404);
      throw new ChatBackendError(msg, 502);
    }
    yield { done: true, cSatsSpent: 0, stopReason: stopped === "length" ? "length" : "stop", ...tokens, served: thisComputer({ ...tokens, ...timing }) };
  };
}

/**
 * This machine's vLLM or MLX server (src/inference-api/openai-engine.ts) as a chat backend, the
 * counterpart of localBackend: `model` is the served id (e.g. an mlx-community repo). Free, like
 * Ollama. Not wired into the desktop yet (it still manages Ollama).
 */
export function localEngineBackend(engine: OpenAiEngine, model: string): ChatBackend {
  return async function* (req, signal) {
    const label = ENGINE_PRESETS[engine.preset].label;
    let end: Extract<OllamaPiece, { doneReason: string }> | undefined;
    try {
      for await (const p of openAiEngineChat(engine, { model, messages: req.messages, tools: req.tools, maxTokens: req.maxTokens, temperature: req.temperature }, signal)) {
        if ("doneReason" in p) end = p;
        else yield p;
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (err instanceof EngineError) throw new ChatBackendError(err.contextOverflow ? `context_too_long: ${msg}` : msg, err.contextOverflow ? 413 : err.status === 404 ? 404 : 502);
      if (/ECONNREFUSED|fetch failed|connect/i.test(msg)) throw new ChatBackendError(`${label} isn't running on this computer (${engine.url}).`, 503);
      throw new ChatBackendError(msg, 502);
    }
    const tokens = { ...(end?.promptTokens !== undefined ? { promptTokens: end.promptTokens } : {}), ...(end?.outputTokens !== undefined ? { outputTokens: end.outputTokens } : {}) };
    yield { done: true, cSatsSpent: 0, stopReason: end?.doneReason === "length" ? "length" : "stop", ...tokens, served: thisComputer({ ...tokens, promptMs: end?.promptMs, genMs: end?.genMs }) };
  };
}

export function networkBackend(deps: NetworkDeps, target: { model: string; computeClass?: string } & NetworkTarget): ChatBackend {
  return async function* (req, signal) {
    try {
      const routing = target.model === "auto" ? { routing: target.routing ?? req.hints } : {};
      for await (const p of streamNetworkCompletion(deps, { ...target, ...routing, computeClass: target.computeClass ?? "any", messages: req.messages, tools: req.tools, maxTokens: req.maxTokens, temperature: req.temperature }, signal)) {
        if (p.delta) yield { delta: p.delta };
        if (p.toolCalls?.length) yield { toolCalls: p.toolCalls };
        if (p.done) {
          if (p.error) throw new ChatBackendError(`The machine running ${target.model} reported: ${p.error}`, 502);
          yield { done: true, ...(p.routed ? { where: p.routed } : {}), ...(p.creditsSpent !== undefined ? { cSatsSpent: p.creditsSpent } : {}), ...(p.promptTokens !== undefined ? { promptTokens: p.promptTokens } : {}), ...(p.outputTokens !== undefined ? { outputTokens: p.outputTokens } : {}), ...(p.served ? { served: p.served } : {}) };
        }
      }
    } catch (err) {
      if (err instanceof ChatBackendError) throw err;
      if (err instanceof RouteElsewhereError) throw new RouteElsewhere(err.message, err.url);
      if (err instanceof AutoUnsupportedError) throw new AutoUnsupported(err.message);
      if (err instanceof NetworkInferenceError) throw new ChatBackendError(err.message, err.status, err.retryAfterSec);
      throw new ChatBackendError((err as Error).message, 502);
    }
  };
}

/** model "auto" on the coordinator: the best fit is on another coordinator (`url`). */
export class RouteElsewhere extends ChatBackendError {
  constructor(message: string, readonly url: string) {
    super(message, 409);
  }
}

/** model "auto" reached a coordinator that does not route it (older build). */
export class AutoUnsupported extends ChatBackendError {
  constructor(message: string) {
    super(message, 404);
  }
}

/**
 * Hosted "auto" with network best-fit routing (src/swarm/coordinator/routing.ts): the coordinator
 * picks the model, class and agent for each request from the job and the live network.
 *
 * - Free places come first, as before: when the client-side plan's first route is a reservation
 *   you hold or your own machines (`useClientSide`), `clientSide` runs it.
 * - Otherwise the request goes to `pick()`'s coordinator as model "auto" (with the client's
 *   hints). When it answers that a peer is the best fit, the request goes there once (only to a
 *   coordinator `allowed` names), without a further redirect; a peer that is not allowed is not
 *   followed and the first coordinator places it on its own agents.
 * - An older coordinator that does not route "auto" falls back to `clientSide`.
 */
export function coordinatorAutoBackend(opts: {
  useClientSide: (req: Parameters<ChatBackend>[0]) => Promise<boolean>;
  clientSide: ChatBackend;
  pick: () => Promise<string | null>;
  allowed: (url: string) => boolean | Promise<boolean>;
  run: (url: string, routeRedirect: boolean) => ChatBackend;
}): ChatBackend {
  return async function* (req, signal) {
    if (await opts.useClientSide(req).catch(() => false)) return yield* opts.clientSide(req, signal);
    const url = await opts.pick().catch(() => null);
    if (!url) return yield* opts.clientSide(req, signal);
    try {
      return yield* opts.run(url, true)(req, signal);
    } catch (err) {
      if (err instanceof RouteElsewhere) {
        const next = err.url.replace(/\/+$/, "");
        const follow = next !== url && (await Promise.resolve(opts.allowed(next)).catch(() => false));
        return yield* opts.run(follow ? next : url, false)(req, signal);
      }
      if (err instanceof AutoUnsupported) return yield* opts.clientSide(req, signal);
      throw err;
    }
  };
}

/**
 * Auto: run each request at the cheapest place that fits it (auto-route.ts), trying the next
 * place when one can't start (no machine has the model, not enough cSats, offline). The last
 * piece says where it ran.
 */
export function autoBackend(opts: {
  inputs: () => Promise<RouteInputs>;
  run: (r: Route) => ChatBackend;
  onRoute?: (r: Route) => void;
  maxTries?: number;
  /** Where calls may run (default "auto": the cheapest place that fits). */
  policy?: ComputePolicy;
  /** Per request: what the network may cost (a bot's budget left today) and the "model" policy's model. */
  plan?: () => PlanOptions;
  /** The smallest model Auto picks for chat and for agent work (default: the env, else 7B / 7B). */
  floor?: QualityFloor;
}): ChatBackend {
  return async function* (req, signal) {
    const inputs = await opts.inputs();
    const policy = opts.policy ?? "auto";
    const planOpts = opts.plan?.() ?? {};
    const routes = planRoutes(sizeWorkload(req, opts.floor), inputs, policy, planOpts);
    if (!routes.length) throw new ChatBackendError(noRouteMessage(policy, inputs, planOpts), 404);
    // The small free fallback is always tried, whatever maxTries cuts.
    const main = routes.filter((r) => !r.fallback).slice(0, opts.maxTries ?? 4);
    let lastErr: unknown;
    for (const r of [...main, ...routes.filter((r) => r.fallback)]) {
      const it = opts.run(r)(req, signal);
      let first: IteratorResult<ChatPiece>;
      try {
        first = await it.next();
      } catch (err) {
        lastErr = err;
        continue;
      }
      opts.onRoute?.(r);
      for (let n = first; !n.done; n = await it.next()) {
        yield "done" in n.value ? { ...n.value, where: r.reason } : n.value;
      }
      return;
    }
    if (lastErr instanceof ChatBackendError && lastErr.status === 402 && routes.every((r) => r.placement === "network")) {
      throw new ChatBackendError(`${lastErr.message} No model on this computer or your machines can take it instead: install one in Settings > Models, or buy cSats.`, 402);
    }
    throw lastErr instanceof ChatBackendError ? lastErr :new ChatBackendError((lastErr as Error)?.message ?? "Auto couldn't start anywhere", 502);
  };
}
