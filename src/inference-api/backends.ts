// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** What can run a chat: this machine's Ollama (free), or the network (your machines, a lease, or any agent). */

import { NetworkInferenceError, streamNetworkCompletion, type NetworkDeps, type NetworkTarget } from "../apps/ide/network-inference.js";
import { ollamaChat } from "./ollama.js";
import { noRouteMessage, planRoutes, sizeWorkload, type ComputePolicy, type PlanOptions, type Route, type RouteInputs } from "./auto-route.js";
import { ChatBackendError, type ChatBackend, type ChatPiece } from "./types.js";

export function localBackend(ollamaHost: string, model: string): ChatBackend {
  return async function* (req, signal) {
    let stopped = "stop";
    try {
      for await (const p of ollamaChat(ollamaHost, { model, messages: req.messages, tools: req.tools, maxTokens: req.maxTokens, temperature: req.temperature }, signal)) {
        if ("doneReason" in p) stopped = p.doneReason;
        else yield p;
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/ECONNREFUSED|fetch failed|connect/i.test(msg)) throw new ChatBackendError("Ollama isn't running on this computer. Open EdgeCoder to start it.", 503);
      if (/not found/i.test(msg)) throw new ChatBackendError(`${model} isn't installed on this computer. Install it from Settings > Models.`, 404);
      throw new ChatBackendError(msg, 502);
    }
    yield { done: true, cSatsSpent: 0, stopReason: stopped === "length" ? "length" : "stop" };
  };
}

export function networkBackend(deps: NetworkDeps, target: { model: string; computeClass?: string } & NetworkTarget): ChatBackend {
  return async function* (req, signal) {
    try {
      for await (const p of streamNetworkCompletion(deps, { ...target, computeClass: target.computeClass ?? "any", messages: req.messages, tools: req.tools, maxTokens: req.maxTokens, temperature: req.temperature }, signal)) {
        if (p.delta) yield { delta: p.delta };
        if (p.toolCalls?.length) yield { toolCalls: p.toolCalls };
        if (p.done) {
          if (p.error) throw new ChatBackendError(`The machine running ${target.model} reported: ${p.error}`, 502);
          yield { done: true, ...(p.creditsSpent !== undefined ? { cSatsSpent: p.creditsSpent } : {}) };
        }
      }
    } catch (err) {
      if (err instanceof ChatBackendError) throw err;
      if (err instanceof NetworkInferenceError) throw new ChatBackendError(err.message, err.status);
      throw new ChatBackendError((err as Error).message, 502);
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
}): ChatBackend {
  return async function* (req, signal) {
    const inputs = await opts.inputs();
    const policy = opts.policy ?? "auto";
    const planOpts = opts.plan?.() ?? {};
    const routes = planRoutes(sizeWorkload(req), inputs, policy, planOpts);
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
