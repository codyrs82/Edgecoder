// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Auto routing: for each request, the cheapest place that can do the job well.
 *
 * 1. Size the job: does it need tools or a long context (an agent turn), or is it a short
 *    question? That sets the smallest model that will do it well.
 * 2. Rank where it can run, cheapest first: a machine you already reserved (prepaid), this
 *    computer (free), your other machines (free), then the network. Network model calls are
 *    priced per token (the same on every class), so among classes the fastest comes first.
 * 3. Return the ranked list; the caller tries them in order (a place that can't start falls
 *    through to the next).
 */

import { catalogEntryForTag } from "../model/catalog.js";
import type { ChatRequest } from "./types.js";

/** False only for a catalog model that lacks tool calling; models not in the catalog count as able. */
export function callsTools(model: string): boolean {
  const entry = catalogEntryForTag(model);
  return !entry || entry.capabilities.includes("tools");
}

export type Placement = "reserved" | "local" | "mine" | "network";

export interface Route {
  placement: Placement;
  model: string;
  computeClass?: string;
  reservationId?: string;
  /** cSats per second at this place (0 when free or prepaid). */
  cSatsPerSecond: number;
  /** Short reason for the user: where and why. */
  reason: string;
  /** A free model below the size the job wants, used because nothing that fits was available or affordable. */
  fallback?: boolean;
}

export interface RouteInputs {
  /** Models on this computer (empty for the hosted endpoint). */
  localModels: string[];
  /** Models on your other machines that are online. */
  myModels: string[];
  /** Active reservations: the models their machines have. */
  leases: Array<{ id: string; computeClass: string; models: string[] }>;
  /** Network models and the classes that have them (and, when known, the price per million tokens). */
  networkModels: Array<{ model: string; classes: string[]; cSatsPerMTokens?: { input: number; output: number } }>;
  /** cSats per second for each class's base tier. */
  classPrice: Record<string, number>;
  /** Your cSat balance, when known (undefined: not connected or not reported). */
  balanceCSats?: number;
}

export interface Workload {
  heavy: boolean;
  /** Estimated prompt tokens. */
  promptTokens: number;
  needsTools: boolean;
}

/** An agent turn (tools) or a long prompt needs a capable model; a short question doesn't. */
export function sizeWorkload(req: Pick<ChatRequest, "messages" | "tools">): Workload {
  const chars = req.messages.reduce((n, m) => n + m.content.length, 0) + (req.tools ? JSON.stringify(req.tools).length : 0);
  const promptTokens = Math.ceil(chars / 3.5);
  const needsTools = !!req.tools?.length;
  return { heavy: needsTools || promptTokens > 6_000, promptTokens, needsTools };
}

/** Billions of parameters from a model tag ("qwen2.5-coder:7b" -> 7, "qwen3-coder:30b" -> 30); unknown tags count as 7. */
export function paramsB(model: string): number {
  const m = /[:\-_](\d+(?:\.\d+)?)b\b/i.exec(model);
  return m ? Number(m[1]) : 7;
}

const isEmbedding = (m: string) => /embed/i.test(m);
const isCoder = (m: string) => /coder|devstral|codestral|deepseek-coder/i.test(m);

/**
 * How well a model fits the job (higher is better), or -1 when it shouldn't be used. Heavy work
 * wants at least ~7B (coders preferred: they follow tool calls); light work wants the smallest
 * model from ~1.5B up, since bigger models take longer and cost more seconds.
 */
export function fitScore(model: string, w: Workload): number {
  if (isEmbedding(model)) return -1;
  const b = paramsB(model);
  if (w.heavy) {
    if (b < 6) return -1;
    return 100 - Math.abs(b - 14) + (isCoder(model) ? 15 : 0);
  }
  if (b < 1) return -1;
  return 100 - b * 2 + (isCoder(model) ? 3 : 0);
}

/** Relative speed of each class on the same model (base tier); cost per job is price / speed. */
export const CLASS_SPEED: Record<string, number> = { cpu: 1, apple: 3, gpu: 4, "gpu.dc": 8 };

function bestModel(models: string[], w: Workload): string | undefined {
  return models
    .map((m) => ({ m, s: fitScore(m, w) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)[0]?.m;
}

/** Every place the job could run, cheapest first. Empty when nothing fits. */
export function rankRoutes(w: Workload, inp: RouteInputs): Route[] {
  const out: Route[] = [];
  const sizeNote = w.heavy ? "agent work" : "quick task";

  for (const l of inp.leases) {
    const model = bestModel(l.models, w);
    if (model) out.push({ placement: "reserved", model, reservationId: l.id, computeClass: l.computeClass, cSatsPerSecond: 0, reason: `your reserved ${l.computeClass} machine (already paid) · ${model}` });
  }
  const local = bestModel(w.needsTools ? inp.localModels.filter(callsTools) : inp.localModels, w);
  if (local) out.push({ placement: "local", model: local, cSatsPerSecond: 0, reason: `this computer (free) · ${local} for ${sizeNote}` });
  const mine = bestModel(inp.myModels, w);
  if (mine) out.push({ placement: "mine", model: mine, cSatsPerSecond: 0, reason: `your machines (free) · ${mine} for ${sizeNote}` });

  const net: Array<Route & { cost: number }> = [];
  for (const cls of Object.keys(CLASS_SPEED)) {
    // Heavy work on CPU is too slow to be worth it, whatever the price.
    if (w.heavy && cls === "cpu") continue;
    const price = inp.classPrice[cls];
    if (price === undefined) continue;
    const model = bestModel(inp.networkModels.filter((m) => m.classes.includes(cls)).map((m) => m.model), w);
    if (!model) continue;
    // Same token price on every class: the faster one finishes sooner for the same cSats.
    const cost = 1 / CLASS_SPEED[cls];
    net.push({ placement: "network", model, computeClass: cls, cSatsPerSecond: price, cost, reason: `network ${cls} (per-token price, fastest available) · ${model}` });
  }
  net.sort((a, b) => a.cost - b.cost);
  for (const { cost: _c, ...r } of net) out.push(r);
  return out;
}

/** The model id other parts of the system run a route with. */
export function routeModelId(r: Route): string {
  if (r.placement === "local") return r.model;
  if (r.placement === "mine") return `mine/${r.model}`;
  if (r.placement === "reserved") return `reserved/${r.reservationId}/${r.model}`;
  return `network/${r.model}@${r.computeClass}`;
}

export const AUTO_MODEL_ID = "auto";

/** The route a model id names (the inverse of routeModelId); "network/<model>" without a class runs on any. */
export function routeFromModelId(id: string): Route | null {
  const t = id.trim();
  if (!t || t === AUTO_MODEL_ID) return null;
  if (t.startsWith("mine/")) return { placement: "mine", model: t.slice(5), cSatsPerSecond: 0, reason: `your machines (free) · ${t.slice(5)}` };
  const reserved = /^reserved\/([^/]+)\/(.+)$/.exec(t);
  if (reserved) return { placement: "reserved", model: reserved[2], reservationId: reserved[1], cSatsPerSecond: 0, reason: `your reserved machine (already paid) · ${reserved[2]}` };
  if (t.startsWith("network/")) {
    const rest = t.slice(8);
    const at = rest.lastIndexOf("@");
    const suffix = at > 0 ? rest.slice(at + 1) : "";
    const known = suffix === "any" || suffix in CLASS_SPEED;
    const model = known ? rest.slice(0, at) : rest;
    const cls = known ? suffix : "any";
    return { placement: "network", model, computeClass: cls, cSatsPerSecond: 0, reason: `network ${cls} · ${model}` };
  }
  return { placement: "local", model: t, cSatsPerSecond: 0, reason: `this computer (free) · ${t}` };
}

const CLASS_NAMES: Record<string, string> = { any: "", cpu: "CPU", apple: "Apple", gpu: "GPU", "gpu.dc": "Datacenter GPU" };

/** Where a route ran, for the reply footer and the bot's runs table: "This computer · qwen2.5-coder:1.5b". */
export function routeLabel(r: Route): string {
  const cls = r.computeClass ? CLASS_NAMES[r.computeClass] ?? r.computeClass : "";
  const where =
    r.placement === "local" ? "This computer" :
    r.placement === "mine" ? "My machines" :
    r.placement === "reserved" ? `Reserved${cls ? ` ${cls}` : ""}` :
    `Network${cls ? ` ${cls}` : ""}`;
  return `${where} · ${r.model}`;
}

// ---------------------------------------------------------------------------
// Compute policies (persistent bots; the chat's Auto is "auto")
// ---------------------------------------------------------------------------

/**
 * Where a bot's model calls may run.
 * - local_first: this computer, then your other machines, then a reservation, then the network.
 * - auto: the cheapest place that fits (rankRoutes).
 * - local_only: this computer only; never the network.
 * - mine_only: this computer and your other machines (free); never the network.
 * - model: one specific model id (routeModelId form).
 */
export type ComputePolicy = "local_first" | "auto" | "local_only" | "mine_only" | "model";
export const COMPUTE_POLICIES: readonly ComputePolicy[] = ["local_first", "auto", "local_only", "mine_only", "model"];

/** Output tokens a network call may set aside, for the affordability estimate. */
const EST_OUTPUT_TOKENS = 2_048;

/** A rough upper bound on one network call's cost, or 0 when the model's price isn't known. */
export function estimateNetworkCSats(w: Workload, price?: { input: number; output: number }): number {
  if (!price) return 0;
  return (w.promptTokens * price.input + EST_OUTPUT_TOKENS * price.output) / 1e6;
}

/** The free model to use when nothing that fits the job is available or affordable: the biggest usable one. */
function biggestUsable(models: string[]): string | undefined {
  const score = (m: string) => paramsB(m) + (isCoder(m) ? 0.5 : 0);
  return models.filter((m) => !isEmbedding(m) && paramsB(m) >= 1).sort((a, b) => score(b) - score(a))[0];
}

export const FALLBACK_NOTE = "ran on a smaller local model (no cSats)";

function fallbackRoutes(inp: RouteInputs, places: Array<"local" | "mine">): Route[] {
  const out: Route[] = [];
  for (const p of places) {
    const model = biggestUsable(p === "local" ? inp.localModels : inp.myModels);
    if (model) out.push({ placement: p, model, cSatsPerSecond: 0, fallback: true, reason: `${p === "local" ? "this computer" : "your machines"} · ${model} · ${FALLBACK_NOTE}` });
  }
  return out;
}

export interface PlanOptions {
  /** cSats this request may spend on the network (a bot's budget left today); undefined: only the balance caps it. */
  allowanceCSats?: number;
  /** The model id for the "model" policy. */
  model?: string;
}

/** What the network may cost this request: the lower of the balance and the allowance. */
export function networkAllowance(inp: RouteInputs, opts: PlanOptions = {}): number {
  return Math.min(inp.balanceCSats ?? Infinity, opts.allowanceCSats ?? Infinity);
}

/** Whether a network route fits within what may be spent (balance and budget). */
function affordable(r: Route, w: Workload, inp: RouteInputs, allowance: number): boolean {
  if (r.placement !== "network") return true;
  if (!(allowance > 0)) return false;
  const price = inp.networkModels.find((m) => m.model === r.model)?.cSatsPerMTokens;
  return estimateNetworkCSats(w, price) <= allowance;
}

/**
 * The places to try for a request under a policy, in order. Network routes that would cost more
 * than the balance or the allowance are left out. When nothing that fits the job is left, the
 * biggest free model (this computer, then your machines) goes last, even below the job's size.
 */
export function planRoutes(w: Workload, inp: RouteInputs, policy: ComputePolicy = "auto", opts: PlanOptions = {}): Route[] {
  const allowance = networkAllowance(inp, opts);
  const ok = (r: Route) => affordable(r, w, inp, allowance);
  if (policy === "model") {
    const r = opts.model ? routeFromModelId(opts.model) : null;
    return r && ok(r) ? [r] : [];
  }
  if (policy === "local_only") {
    const fit = rankRoutes(w, { ...inp, myModels: [], leases: [], networkModels: [] });
    return fit.length ? fit : fallbackRoutes(inp, ["local"]);
  }
  if (policy === "mine_only") {
    const fit = rankRoutes(w, { ...inp, leases: [], networkModels: [] });
    return fit.length ? fit : fallbackRoutes(inp, ["local", "mine"]);
  }
  const ranked = rankRoutes(w, inp);
  const order: Placement[] = policy === "local_first" ? ["local", "mine", "reserved"] : ["reserved", "local", "mine"];
  const free = order.flatMap((p) => ranked.filter((r) => r.placement === p));
  const net = ranked.filter((r) => r.placement === "network" && ok(r));
  return [...free, ...net, ...(free.length ? [] : fallbackRoutes(inp, ["local", "mine"]))];
}

/** Why a policy found nowhere to run, in plain words. */
export function noRouteMessage(policy: ComputePolicy, inp: RouteInputs, opts: PlanOptions = {}): string {
  const broke = networkAllowance(inp, opts) <= 0;
  const why =
    inp.balanceCSats !== undefined && inp.balanceCSats <= 0 ? "you have no cSats" :
    opts.allowanceCSats !== undefined && opts.allowanceCSats <= 0 ? "today's budget is spent" :
    "it would cost more than you can spend";
  switch (policy) {
    case "local_only":
      return "No model is installed on this computer. Install one in Settings > Models.";
    case "mine_only":
      return "No model is available on this computer or your machines. Install one in Settings > Models, or bring one of your machines online.";
    case "model":
      return opts.model?.startsWith("network/")
        ? `Can't run ${opts.model.slice(8)} on the network: ${why}. Buy cSats, or pick a model on this computer.`
        : `The chosen model (${opts.model ?? "none"}) isn't available right now.`;
    default:
      return broke
        ? `Nothing to run on: no model is installed on this computer or your machines, and the network can't be used because ${why}. Install a model in Settings > Models, or buy cSats.`
        : "No model fits this request: install a coder model (7B or larger) on one of your machines, or try again when the network has one.";
  }
}

/** Route inputs from the compute overview, your reservations and this computer's models. */
export function routeInputsFrom(input: {
  localModels: string[];
  selfAgentId?: string;
  machines?: Array<{ agentId: string; online: boolean; models: string[] }>;
  networkModels?: Array<{ model: string; classes: string[]; cSatsPerMTokens?: { input: number; output: number } }>;
  balanceCSats?: number;
  classes?: Record<string, { cSatsPerSecondBaseTier: number }>;
  leases?: Array<{ id: string; computeClass: string; status: string; endMs: number; models: string[] }>;
  now?: number;
}): RouteInputs {
  const now = input.now ?? Date.now();
  return {
    localModels: input.localModels,
    myModels: [...new Set((input.machines ?? []).filter((m) => m.online && m.agentId !== input.selfAgentId).flatMap((m) => m.models))],
    leases: (input.leases ?? []).filter((l) => l.status === "active" && l.endMs > now).map((l) => ({ id: l.id, computeClass: l.computeClass, models: l.models })),
    networkModels: input.networkModels ?? [],
    classPrice: Object.fromEntries(Object.entries(input.classes ?? {}).map(([k, v]) => [k, v.cSatsPerSecondBaseTier])),
    ...(typeof input.balanceCSats === "number" ? { balanceCSats: input.balanceCSats } : {}),
  };
}
