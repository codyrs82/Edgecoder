// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/** What can run a chat: this machine's Ollama (free), or the network (your machines, a lease, or any agent). */

import { cpus } from "node:os";
import type { ServedBy } from "../swarm/served-by.js";
import { AutoUnsupportedError, NetworkInferenceError, RouteElsewhereError, streamNetworkCompletion, type NetworkDeps, type NetworkTarget } from "../apps/ide/network-inference.js";
import { contextWindowFor, ollamaChat, type OllamaPiece } from "./ollama.js";
import { ENGINE_PRESETS, EngineError, openAiEngineChat, type OpenAiEngine } from "./openai-engine.js";
import { BEST_FIT_ROUTE, ComplexityWindow, bestFitRoute, cheapestNetworkEstimate, classOnline, classUnavailableMessage, networkAllowance, noRouteMessage, notEnoughCSatsMessage, planRoutes, routeModelId, sizeWorkload, type ComplexityFloors, type ComputePolicy, type PlanOptions, type QualityFloor, type Route, type RouteInputs } from "./auto-route.js";
import { complexityWeightsFromEnv, contentComplexity, estimateComplexity } from "./job-complexity.js";
import { ChatBackendError, type ChatBackend, type ChatPiece } from "./types.js";
import type { RoutingHints } from "./job-descriptor.js";

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
      const routing = target.model === "auto" ? { routing: target.routing ?? req.hints } : namedModelCeiling(target.routing, req.hints);
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
      if (err instanceof NetworkInferenceError) throw new ChatBackendError(err.message, err.status, err.retryAfterSec, err.info);
      throw new ChatBackendError((err as Error).message, 502);
    }
  };
}

/**
 * A named model's call carries only the buyer's price ceiling (maxCSats): the lower of the target's
 * (a bot's budget left) and the request's hints (a helper's budget left), so the coordinator caps
 * the call's reserve at it (#525: hosted helper calls reserved 53.6 cSats on a 25 cSat budget).
 */
export function namedModelCeiling(...sources: Array<{ maxCSats?: number } | undefined>): { routing?: { maxCSats: number } } {
  const caps = sources.map((s) => s?.maxCSats).filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0);
  return caps.length ? { routing: { maxCSats: Math.max(0.001, Math.min(...caps)) } } : {};
}

/**
 * A named network model (#526): sent to `url` with routeRedirect, so a coordinator with no free slot
 * for it that knows a peer with one answers route_elsewhere before anything is reserved. The call
 * then goes there once (only to a coordinator `allowed` names), without a further redirect; a peer
 * that is not allowed is not followed and the first coordinator takes the call without redirecting.
 */
export function redirectingNetworkBackend(opts: { url: string; allowed: (url: string) => boolean | Promise<boolean>; run: (url: string, routeRedirect: boolean) => ChatBackend }): ChatBackend {
  return async function* (req, signal) {
    try {
      return yield* opts.run(opts.url, true)(req, signal);
    } catch (err) {
      if (!(err instanceof RouteElsewhere)) throw err;
      const next = err.url.replace(/\/+$/, "");
      const follow = next !== opts.url.replace(/\/+$/, "") && (await Promise.resolve(opts.allowed(next)).catch(() => false));
      return yield* opts.run(follow ? next : opts.url, false)(req, signal);
    }
  };
}

/** The coordinator sends the call to another coordinator (`url`): Auto's best fit, or a named model's free slot. */
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

/** Sessions a backend keeps a complexity window for (hysteresis), the oldest dropped first. */
const MAX_COMPLEXITY_SESSIONS = 200;

/**
 * Auto: run each request at the cheapest place that fits it (auto-route.ts), trying the next
 * place when one can't start (no machine has the model, not enough cSats, offline). The last
 * piece says where it ran.
 *
 * Each request's complexity is estimated once (estimateComplexity, the coordinator's scorer; a
 * caller that already did sets `req.complexity`). The free places are sized by its content-only
 * level (contentComplexity: agent-loop depth alone never makes a step high), counted as the
 * hardest of the session's last few steps (ComplexityWindow; the session is `hints.sessionId`,
 * else this backend, which is one agent turn or bot run). The network's best fit gets the full
 * estimate as its `complexity` hint: the score the coordinator would compute itself, so its
 * choice is the same as without the hint.
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
  /**
   * Network best fit: when set, the plan's network leg goes to the coordinator first as model
   * "auto" (its best-fit routing picks the model, class and machine), with the client's hints and
   * what may be spent as the price ceiling. The client-side network routes stay behind it, so an
   * older coordinator or a refusal still lands somewhere. Not used for the "model" policy (a pin).
   */
  networkBestFit?: (routing: RoutingHints) => ChatBackend;
  /** Model sizes by complexity (default: the env, else 14B / 30B / 30B); see ComplexityFloors. */
  complexityFloors?: ComplexityFloors;
  /** Steps of hysteresis (default: EDGECODER_AUTO_COMPLEXITY_WINDOW, else 3). */
  complexityWindow?: number;
  /**
   * Whose steps share a hysteresis window: "backend" (default: one agent turn or bot run per
   * backend; requests with a `hints.sessionId` get their own), or "session" (a long-lived backend
   * many clients share: only requests with a session id are remembered).
   */
  hysteresis?: "backend" | "session";
}): ChatBackend {
  const windows = new Map<string, ComplexityWindow>();
  const windowFor = (key: string) => {
    let w = windows.get(key);
    if (!w) {
      w = new ComplexityWindow(opts.complexityWindow);
      windows.set(key, w);
      if (windows.size > MAX_COMPLEXITY_SESSIONS) windows.delete(windows.keys().next().value!);
    }
    return w;
  };
  return async function* (req, signal) {
    const inputs = await opts.inputs();
    const policy = opts.policy ?? "auto";
    const planOpts = opts.plan?.() ?? {};
    const estimated = req.complexity ?? estimateComplexity({ messages: req.messages, tools: req.tools, maxTokens: req.maxTokens }, req.hints?.complexity, complexityWeightsFromEnv());
    const session = req.hints?.sessionId ?? (opts.hysteresis === "session" ? undefined : "");
    const local = contentComplexity(estimated);
    const complexity = session === undefined ? { ...local, held: false } : windowFor(session).push(local);
    const workload = sizeWorkload(req, opts.floor, complexity, opts.complexityFloors);
    const planned = planRoutes(workload, inputs, policy, planOpts).map((r) => ({ ...r, complexity: complexity.level }));
    // Network only with no model chosen: the coordinator's best fit (in its class) leads, even when
    // this side doesn't know the network's models, as long as something may be spent.
    const networkOnlyBestFit = policy === "network_only" && !planOpts.model && !!opts.networkBestFit && networkAllowance(inputs, planOpts) > 0;
    const all =
      networkOnlyBestFit ? [bestFitRoute(planOpts.computeClass), ...planned] :
      opts.networkBestFit && policy !== "model" && policy !== "network_only" ? withBestFit(planned) :
      planned;
    // A bot escalating past a model that only described its plan: the next place, when there is one.
    const skip = new Set(planOpts.exclude ?? []);
    const kept = skip.size ? all.filter((r) => !skip.has(routeModelId(r))) : all;
    const routes = kept.length ? kept : all;
    if (!routes.length) throw noRouteError(noRouteMessage(policy, inputs, planOpts, workload), planOpts.computeClass);
    const allowance = networkAllowance(inputs, planOpts);
    const bestFitHints = (): RoutingHints => {
      const ceiling = Number.isFinite(allowance) ? Math.min(req.hints?.maxCSats ?? Infinity, allowance) : req.hints?.maxCSats;
      const cls = policy === "network_only" && planOpts.computeClass && planOpts.computeClass !== "any" ? { computeClass: planOpts.computeClass } : {};
      // A bot's agent step: its size floor goes along, so best fit never places it on a smaller
      // model (it takes a cloud model when nothing else on the network is big enough).
      const floor = workload.heavy && planOpts.agentMinParamsB && planOpts.agentMinParamsB > 0 ? { minParamsB: planOpts.agentMinParamsB } : {};
      return { ...req.hints, complexity: estimated.score, ...cls, ...floor, ...(ceiling !== undefined && Number.isFinite(ceiling) ? { maxCSats: Math.max(0.001, ceiling) } : {}) };
    };
    // The small free fallback is always tried, whatever maxTries cuts (the best-fit leg does not count).
    const main = routes.filter((r) => !r.fallback).slice(0, (opts.maxTries ?? 4) + (routes.some((r) => r.bestFit) ? 1 : 0));
    let lastErr: unknown;
    const errs: unknown[] = [];
    for (const r of [...main, ...routes.filter((r) => r.fallback)]) {
      const it = (r.bestFit && opts.networkBestFit ? opts.networkBestFit(bestFitHints()) : opts.run(r))(req, signal);
      let first: IteratorResult<ChatPiece>;
      try {
        first = await it.next();
      } catch (err) {
        lastErr = err;
        errs.push(err);
        continue;
      }
      opts.onRoute?.(r);
      for (let n = first; !n.done; n = await it.next()) {
        // Best fit: the coordinator's own line says where it ran.
        // A route Auto took because a free model can't call tools says so ("… (tools needed; local deepseek-r1:14b has no tool support)").
        if (!("done" in n.value)) {
          yield n.value;
          continue;
        }
        const where = r.bestFit && n.value.where ? n.value.where : r.reason;
        yield { ...n.value, where: r.why ? `${where} (${r.why})` : where };
      }
      return;
    }
    // One clear failure instead of the last route's: a class with no machine, else money.
    const cls = policy === "network_only" && planOpts.computeClass && planOpts.computeClass !== "any" ? planOpts.computeClass : undefined;
    const pinned = planOpts.model ? planned.find((r) => r.placement === "network")?.model : undefined;
    const classGone = errs.some((e) => e instanceof ChatBackendError && (e.info?.code === "no_agent_in_class" || (e.info?.code === "no_route_fits" && e.info.reason === "none")));
    if (cls && (classGone || classOnline(inputs, cls, pinned) === false)) {
      throw new ChatBackendError(classUnavailableMessage(cls, inputs, pinned), 404, undefined, { code: "class_unavailable", computeClass: cls });
    }
    const money = errs.find((e): e is ChatBackendError => e instanceof ChatBackendError && (e.info?.code === "insufficient_credits" || (e.info?.code === "no_route_fits" && e.info.reason === "price") || e.status === 402));
    if (money && (policy === "network_only" || policy === "model" || routes.every((r) => r.placement === "network"))) {
      const est = money.info?.neededCSats !== undefined ? { cSats: money.info.neededCSats, computeClass: money.info.computeClass } : cheapestNetworkEstimate(workload, inputs, cls);
      const msg = notEnoughCSatsMessage(inputs, planOpts, est ? { ...est, computeClass: cls ?? est.computeClass } : undefined);
      const tail = policy === "network_only" || policy === "model" ? "" : " No model on this computer or your machines can take it instead: install one in Settings > Models, or buy cSats.";
      throw new ChatBackendError(msg + tail, 402, undefined, { code: "not_enough_csats", ...(est?.cSats !== undefined ? { neededCSats: est.cSats } : {}), ...(cls ? { computeClass: cls } : {}) });
    }
    throw lastErr instanceof ChatBackendError ? lastErr :new ChatBackendError((lastErr as Error)?.message ?? "Auto couldn't start anywhere", 502);
  };
}

/** A "nowhere to run" error, with its kind as data (the apps key Buy cSats / Edit compute on it). */
function noRouteError(message: string, computeClass?: string): ChatBackendError {
  if (message.startsWith("Not enough cSats")) return new ChatBackendError(message, 402, undefined, { code: "not_enough_csats", ...(computeClass ? { computeClass } : {}) });
  if (/^No .+ machines online/.test(message)) return new ChatBackendError(message, 404, undefined, { code: "class_unavailable", ...(computeClass ? { computeClass } : {}) });
  return new ChatBackendError(message, 404);
}

/**
 * The plan with the network's best fit in front of its network routes: placed where the first
 * network route was (after the free places the policy prefers), and only when the plan has a network
 * route at all (the network is allowed and affordable).
 */
export function withBestFit(routes: Route[]): Route[] {
  const i = routes.findIndex((r) => r.placement === "network" && !r.fallback);
  if (i < 0) return routes;
  const { why, complexity } = routes[i];
  const cx = complexity ? { complexity, reason: `${BEST_FIT_ROUTE.reason} — ${complexity.replace("_", " ")} complexity` } : {};
  return [...routes.slice(0, i), why || complexity ? { ...BEST_FIT_ROUTE, ...cx, ...(why ? { why } : {}) } : BEST_FIT_ROUTE, ...routes.slice(i)];
}
