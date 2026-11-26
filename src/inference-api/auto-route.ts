// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Auto routing: for each request, the cheapest place that can do the job well.
 *
 * 1. Size the job: does it need tools or a long context (an agent turn), or is it a short
 *    question? That sets the smallest model that will do it well, never below the quality floor
 *    (QualityFloor: 7B by default for both chat and coding, so "explain this code" is not
 *    answered by a 1.5B model just because it is the cheapest).
 * 2. How hard is it (job-complexity.ts: the coordinator's estimate, with the level taken from the
 *    task's content, contentComplexity, so agent-loop depth alone never makes a step high)? A
 *    medium, high or very high step raises the smallest model a free place may use
 *    (ComplexityFloors: ~14B, ~30B, ~30B and a coder or reasoning model), so a hard agent step
 *    doesn't land on a 7B model just because it's free. Within a session the hardest of the last
 *    few steps counts (ComplexityWindow), so steps don't flap between this computer and the network.
 * 3. Rank where it can run, cheapest first: a machine you already reserved (prepaid), this
 *    computer (free), your other machines (free), then the network. Network model calls are
 *    priced per token (the same on every class), so among classes the fastest comes first. When
 *    no free place meets the step and the network can't take it (not connected, no cSats, the
 *    budget is spent, or the policy keeps to free machines), the biggest free model does it,
 *    marked as a fallback with the reason.
 * 4. Return the ranked list; the caller tries them in order (a place that can't start falls
 *    through to the next). Every route's `reason` says where and why, with the complexity.
 */

import { catalogEntryForTag } from "../model/catalog.js";
import { cloudModelSpec } from "../cloud-host/catalog.js";
import { supportsTools } from "../model/tool-support.js";
import type { ChatRequest } from "./types.js";
import { isFrontierModelId } from "./frontier-models.js";
import { normalizeComputeClass } from "../economy/compute-classes.js";
import type { Complexity, ComplexityLevel } from "./job-complexity.js";

/** Whether a model can do an agent step (take tools and call them); see model/tool-support.ts. */
export function callsTools(model: string): boolean {
  return supportsTools(model);
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
  /** The network leg handed to the coordinator as model "auto" (best-fit picks model, class and machine). */
  bestFit?: boolean;
  /**
   * Why Auto didn't take the obvious free model, for the reply footer and the run details: "tools
   * needed; local deepseek-r1:14b has no tool support".
   */
  why?: string;
  /** The step's complexity as Auto counted it (after hysteresis), when Auto chose. */
  complexity?: ComplexityLevel;
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
  /**
   * Machines online per class that have a model (the coordinator's /inference/models
   * classes[c].agents), when the coordinator reports it: for "No GPU machines online. Available
   * now: Datacenter GPU (1), CPU (9)".
   */
  classAgents?: Record<string, number>;
}

export interface Workload {
  heavy: boolean;
  /** Estimated prompt tokens. */
  promptTokens: number;
  needsTools: boolean;
  /** The smallest model (billions of parameters) Auto may pick for this job; see QualityFloor. */
  minParamsB?: number;
  /** How hard the step is and what that asks of a model (sizeWorkload with a complexity); see ComplexityFloors. */
  complexity?: WorkloadComplexity;
}

/** A step's complexity (job-complexity.ts) as the size of model it needs. */
export interface WorkloadComplexity {
  level: ComplexityLevel;
  score: number;
  /** The smallest model (billions of parameters) for this level; none at low (the quality floor applies). */
  minB?: number;
  /** Medium agent steps (tools): a coder model this big is enough. */
  coderMinB?: number;
  /** Very high: a model the catalog knows must be a coder or a reasoning ("thinking") model. */
  reasoningCoder?: boolean;
}

/**
 * The smallest model (billions of parameters, total for MoE) Auto uses for a step by its complexity,
 * on top of the quality floor. Low complexity uses the floor alone. Set one to 0 to turn it off.
 */
export interface ComplexityFloors {
  mediumB: number;
  /** A medium agent step (tools) may run on a coder model this big instead. */
  mediumCoderB: number;
  highB: number;
  /** Very high also wants a coder or a reasoning model when the catalog knows the model. */
  veryHighB: number;
}

export const DEFAULT_COMPLEXITY_FLOORS: ComplexityFloors = { mediumB: 14, mediumCoderB: 7, highB: 30, veryHighB: 30 };

const envNumber = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

/** EDGECODER_AUTO_MEDIUM_MIN_B, EDGECODER_AUTO_MEDIUM_CODER_MIN_B, EDGECODER_AUTO_HIGH_MIN_B, EDGECODER_AUTO_VERY_HIGH_MIN_B, else the defaults. */
export function complexityFloorsFromEnv(env: Record<string, string | undefined> = process.env): ComplexityFloors {
  const d = DEFAULT_COMPLEXITY_FLOORS;
  return {
    mediumB: envNumber(env.EDGECODER_AUTO_MEDIUM_MIN_B, d.mediumB),
    mediumCoderB: envNumber(env.EDGECODER_AUTO_MEDIUM_CODER_MIN_B, d.mediumCoderB),
    highB: envNumber(env.EDGECODER_AUTO_HIGH_MIN_B, d.highB),
    veryHighB: envNumber(env.EDGECODER_AUTO_VERY_HIGH_MIN_B, d.veryHighB),
  };
}

/** What a complexity level asks of a model. */
export function workloadComplexity(c: Pick<Complexity, "level" | "score">, floors: ComplexityFloors = complexityFloorsFromEnv()): WorkloadComplexity {
  const base = { level: c.level, score: c.score };
  if (c.level === "medium") return { ...base, minB: floors.mediumB, coderMinB: floors.mediumCoderB };
  if (c.level === "high") return { ...base, minB: floors.highB };
  if (c.level === "very_high") return { ...base, minB: floors.veryHighB, reasoningCoder: true };
  return base;
}

/** "very high" for "very_high". */
export const levelText = (l: ComplexityLevel) => l.replace("_", " ");

/** Steps a session remembers for hysteresis (EDGECODER_AUTO_COMPLEXITY_WINDOW, default 3; 1 turns it off). */
export function complexityWindowFromEnv(env: Record<string, string | undefined> = process.env): number {
  return Math.max(1, Math.floor(envNumber(env.EDGECODER_AUTO_COMPLEXITY_WINDOW, 3)) || 1);
}

/**
 * Hysteresis for one session (an agent turn, a bot run): each step counts as the hardest of the
 * last `size` steps, so a session that just needed the network for a hard step doesn't drop back to
 * a small local model on the next easy-looking step and flap back again. A harder step takes effect
 * at once; an easier one only after `size` steps.
 */
export class ComplexityWindow {
  private recent: Array<Pick<Complexity, "level" | "score">> = [];
  constructor(readonly size = complexityWindowFromEnv()) {}
  push(c: Pick<Complexity, "level" | "score">): Pick<Complexity, "level" | "score"> & { held: boolean } {
    this.recent.push({ level: c.level, score: c.score });
    while (this.recent.length > Math.max(1, this.size)) this.recent.shift();
    const top = this.recent.reduce((a, b) => (b.score > a.score ? b : a));
    return top.score > c.score ? { ...top, held: true } : { level: c.level, score: c.score, held: false };
  }
}

/**
 * The smallest model Auto picks, in billions of parameters: `chatB` for questions and chat,
 * `codingB` for agent work (tools or a long context). Auto is still the cheapest place among the
 * models that meet it; only when nothing that meets it can run does a smaller free model answer
 * (marked as a fallback). Explicit model choices ignore it.
 */
export interface QualityFloor {
  chatB: number;
  codingB: number;
}

export const DEFAULT_QUALITY_FLOOR: QualityFloor = { chatB: 7, codingB: 7 };

/** The floor from EDGECODER_AUTO_MIN_CHAT_B / EDGECODER_AUTO_MIN_CODING_B, else the default. */
export function qualityFloorFromEnv(env: Record<string, string | undefined> = process.env): QualityFloor {
  const read = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    chatB: read(env.EDGECODER_AUTO_MIN_CHAT_B, DEFAULT_QUALITY_FLOOR.chatB),
    codingB: read(env.EDGECODER_AUTO_MIN_CODING_B, DEFAULT_QUALITY_FLOOR.codingB),
  };
}

/** An agent turn (tools) or a long prompt needs a capable model; a short question gets the chat floor. */
export function sizeWorkload(
  req: Pick<ChatRequest, "messages" | "tools">,
  floor: QualityFloor = qualityFloorFromEnv(),
  /** The step's complexity (estimateComplexity, after hysteresis): raises the model size free places must meet. */
  complexity?: Pick<Complexity, "level" | "score">,
  floors: ComplexityFloors = complexityFloorsFromEnv(),
): Workload {
  const chars = req.messages.reduce((n, m) => n + m.content.length, 0) + (req.tools ? JSON.stringify(req.tools).length : 0);
  const promptTokens = Math.ceil(chars / 3.5);
  const needsTools = !!req.tools?.length;
  const heavy = needsTools || promptTokens > 6_000;
  return { heavy, promptTokens, needsTools, minParamsB: heavy ? floor.codingB : floor.chatB, ...(complexity ? { complexity: workloadComplexity(complexity, floors) } : {}) };
}

/**
 * Billions of parameters (total, for MoE models) of a model: from its tag ("qwen2.5-coder:7b" -> 7,
 * "qwen3-coder:30b" -> 30), else from the catalog's size for a tag that carries none
 * ("qwen3-coder-next:latest" -> 80), or a cloud model's ("glm-5.3" -> 744, src/cloud-host/catalog.ts);
 * unknown models count as 7. Pricing and Auto's sizing use it (a cloud model is priced by its own
 * cost-plus price, economy/cloud-pricing.ts, never by this size).
 */
export function paramsB(model: string): number {
  const cloud = cloudModelSpec(model);
  if (cloud) return cloud.paramsB;
  const m = /[:\-_](\d+(?:\.\d+)?)b\b/i.exec(model);
  if (m) return Number(m[1]);
  const fromCatalog = Number(/^\s*([\d.]+)\s*B/i.exec(catalogEntryForTag(model)?.paramSize ?? "")?.[1]);
  return Number.isFinite(fromCatalog) && fromCatalog > 0 ? fromCatalog : 7;
}

const isEmbedding = (m: string) => /embed/i.test(m);
const isCoder = (m: string) => /coder|devstral|codestral|deepseek-coder/i.test(m);
/** A coder or a reasoning ("thinking") model, as far as the catalog knows; unknown models pass. */
const reasonsAboutCode = (m: string) => {
  const e = catalogEntryForTag(m);
  return !e || isCoder(m) || e.capabilities.includes("thinking");
};

/** Whether a model is big enough (and the right kind) for the step's complexity. */
export function meetsComplexity(model: string, w: Workload): boolean {
  const cx = w.complexity;
  if (!cx || cx.minB === undefined) return true;
  if (cx.reasoningCoder && !reasonsAboutCode(model)) return false;
  const b = paramsB(model);
  if (b >= cx.minB) return true;
  return w.needsTools && cx.coderMinB !== undefined && isCoder(model) && b >= cx.coderMinB;
}

/**
 * How well a model fits the job (higher is better), or -1 when it shouldn't be used. Nothing below
 * the job's floor (`minParamsB`; without one, ~6B for heavy work and 1B for light work) is used.
 * Heavy work prefers ~14B coders (they follow tool calls); light work prefers the smallest model
 * that meets the floor, since bigger models take longer and cost more seconds.
 */
export function fitScore(model: string, w: Workload): number {
  if (isEmbedding(model)) return -1;
  const b = paramsB(model);
  const floor = w.minParamsB ?? (w.heavy ? 6 : 1);
  if (b < floor) return -1;
  if (!meetsComplexity(model, w)) return -1;
  if (w.heavy) return 100 - Math.abs(b - 14) + (isCoder(model) ? 15 : 0);
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
  // "— medium complexity, fits locally": every route says how hard the step is.
  const cx = w.complexity ? levelText(w.complexity.level) : "";
  const fits = (where: string) => (cx ? ` — ${cx} complexity, fits ${where}` : "");

  // An agent step (tools) only goes to a model that calls tools, wherever it runs.
  const usable = (models: string[]) => (w.needsTools ? models.filter(callsTools) : models);
  for (const l of inp.leases) {
    const model = bestModel(usable(l.models), w);
    if (model) out.push({ placement: "reserved", model, reservationId: l.id, computeClass: l.computeClass, cSatsPerSecond: 0, reason: `your reserved ${l.computeClass} machine (already paid) · ${model}${fits("your reserved machine")}` });
  }
  const local = bestModel(usable(inp.localModels), w);
  if (local) out.push({ placement: "local", model: local, cSatsPerSecond: 0, reason: `this computer (free) · ${local} for ${sizeNote}${fits("locally")}` });
  const mine = bestModel(usable(inp.myModels), w);
  if (mine) out.push({ placement: "mine", model: mine, cSatsPerSecond: 0, reason: `your machines (free) · ${mine} for ${sizeNote}${fits("on your machines")}` });

  out.push(...networkRoutes(w, inp));
  return out;
}

/**
 * The classes a "Network <class> only" choice runs on: "gpu" is the GPU family (consumer and
 * datacenter GPUs alike, what people mean by "GPU only"); every other class is itself
 * ("gpu.dc" stays datacenter GPUs only). The coordinator's best fit filters the same way
 * (src/swarm/coordinator/routing.ts).
 */
export function classFamily(cls: string): string[] {
  return cls === "gpu" ? ["gpu", "gpu.dc"] : [cls];
}

/**
 * The network's places for a job, fastest class first. `only`: that class (its family: "gpu" is
 * any GPU) alone (Network GPU only, …), even CPU for agent work, which Auto otherwise skips as too slow.
 */
export function networkRoutes(w: Workload, inp: RouteInputs, only?: string): Route[] {
  const cx = w.complexity ? levelText(w.complexity.level) : "";
  const usable = (models: string[]) => (w.needsTools ? models.filter(callsTools) : models);
  const net: Array<Route & { cost: number }> = [];
  for (const cls of only ? classFamily(only) : Object.keys(CLASS_SPEED)) {
    // Heavy work on CPU is too slow to be worth it, whatever the price (unless CPU was asked for).
    if (!only && w.heavy && cls === "cpu") continue;
    const price = inp.classPrice[cls];
    if (price === undefined) continue;
    const model = bestModel(usable(inp.networkModels.filter((m) => m.classes.includes(cls)).map((m) => m.model)), w);
    if (!model) continue;
    // Same token price on every class: the faster one finishes sooner for the same cSats.
    const cost = 1 / (CLASS_SPEED[cls] ?? 1);
    net.push({ placement: "network", model, computeClass: cls, cSatsPerSecond: price, cost, reason: `network ${cls} (per-token price, ${only ? `${cls} only` : "fastest available"}) · ${model}${cx ? ` — ${cx} complexity` : ""}` });
  }
  net.sort((a, b) => a.cost - b.cost);
  return net.map(({ cost: _c, ...r }) => r);
}

/** The model id other parts of the system run a route with. */
export function routeModelId(r: Route): string {
  if (r.placement === "local") return r.model;
  if (r.placement === "mine") return `mine/${r.model}`;
  if (r.placement === "reserved") return `reserved/${r.reservationId}/${r.model}`;
  return `network/${r.model}@${r.computeClass}`;
}

export const AUTO_MODEL_ID = "auto";

/**
 * Model names that leave the choice to the network: none, "", "default" or "auto". A client that
 * gets one of these sends model "auto", so the coordinator's best-fit routing picks the model, the
 * class and the machine (docs: site-docs, "Default model per client"). Anything else is a pin.
 */
export function isUnpinnedModel(model: string | null | undefined): boolean {
  const m = (model ?? "").trim().toLowerCase();
  return m === "" || m === "default" || m === AUTO_MODEL_ID;
}

/** The route for the network's best fit: the coordinator picks the model, the class and the machine. */
export function bestFitRoute(computeClass?: string): Route {
  return computeClass && computeClass !== "any"
    ? { ...BEST_FIT_ROUTE, computeClass, reason: `network ${computeClass} only · best fit (the coordinator picks the model and machine)` }
    : BEST_FIT_ROUTE;
}

/** The fixed best-fit route (any class). */
export const BEST_FIT_ROUTE: Route = Object.freeze({
  placement: "network",
  model: AUTO_MODEL_ID,
  computeClass: "any",
  cSatsPerSecond: 0,
  reason: "network · best fit (the coordinator picks the model and machine)",
  bestFit: true,
}) as Route;

/** The route a model id names (the inverse of routeModelId); "network/<model>" without a class runs on any. */
export function routeFromModelId(id: string): Route | null {
  const t = id.trim();
  // Frontier ids run only on the user's own key in the IDE provider, never on a route (bots included).
  if (!t || t === AUTO_MODEL_ID || isFrontierModelId(t)) return null;
  if (t.startsWith("mine/")) return { placement: "mine", model: t.slice(5), cSatsPerSecond: 0, reason: `your machines (free) · ${t.slice(5)}` };
  const reserved = /^reserved\/([^/]+)\/(.+)$/.exec(t);
  if (reserved) return { placement: "reserved", model: reserved[2], reservationId: reserved[1], cSatsPerSecond: 0, reason: `your reserved machine (already paid) · ${reserved[2]}` };
  if (t.startsWith("network/")) {
    const rest = t.slice(8);
    const at = rest.lastIndexOf("@");
    const suffix = at > 0 ? rest.slice(at + 1) : "";
    // A class, or a hardware tier ("@gpu.c8") standing for its class: calls match by class only.
    const named = suffix === "any" ? "any" : normalizeComputeClass(suffix);
    const model = named ? rest.slice(0, at) : rest;
    const cls = named ?? "any";
    return { placement: "network", model, computeClass: cls, cSatsPerSecond: 0, reason: `network ${cls} · ${model}` };
  }
  return { placement: "local", model: t, cSatsPerSecond: 0, reason: `this computer (free) · ${t}` };
}

export const CLASS_NAMES: Record<string, string> = { any: "", cpu: "CPU", apple: "Apple", gpu: "GPU", "gpu.dc": "Datacenter GPU", cloud: "Cloud" };

/**
 * What Auto decided for one model call, for status events (`route`) and the UI: where it runs, the
 * short reason (with the complexity), why it skipped the obvious free model, and whether it is a
 * smaller free model used as a fallback.
 */
export interface RouteSummary {
  /** "This computer · qwen3-coder:30b", "Network · best fit". */
  label: string;
  placement: Placement;
  model: string;
  /** "this computer (free) · qwen3-coder:30b for agent work — medium complexity, fits locally". */
  reason: string;
  /** "high complexity, needs ≥30B; this computer has ≤14B", "high-complexity step; a larger model wasn't available (balance 0)". */
  why?: string;
  complexity?: ComplexityLevel;
  fallback?: boolean;
}

export function routeSummary(r: Route): RouteSummary {
  return {
    label: routeLabel(r),
    placement: r.placement,
    model: r.model,
    reason: r.reason,
    ...(r.why ? { why: r.why } : {}),
    ...(r.complexity ? { complexity: r.complexity } : {}),
    ...(r.fallback ? { fallback: true } : {}),
  };
}

/** Where a route ran, for the reply footer and the bot's runs table: "This computer · qwen2.5-coder:1.5b". */
export function routeLabel(r: Route): string {
  const cls = r.computeClass ? CLASS_NAMES[r.computeClass] ?? r.computeClass : "";
  if (r.bestFit) return `Network${cls ? ` ${cls}` : ""} · best fit`;
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
 * - network_only: always the network (paid, within the budget), never this computer, your machines
 *   or a reservation, and no free fallback: with no cSats left it stops (noRouteMessage). Limited to
 *   one class when PlanOptions.computeClass is set; the model is the network's best fit, or
 *   PlanOptions.model when one is chosen.
 */
export type ComputePolicy = "local_first" | "auto" | "local_only" | "mine_only" | "model" | "network_only";
export const COMPUTE_POLICIES: readonly ComputePolicy[] = ["local_first", "auto", "local_only", "mine_only", "model", "network_only"];

/** The classes Network only may be limited to (economy/compute-classes.ts COMPUTE_CLASS_IDS). */
export const NETWORK_CLASSES = ["gpu", "apple", "cpu", "gpu.dc"] as const;
export type NetworkClass = (typeof NETWORK_CLASSES)[number];
export const isNetworkClass = (v: unknown): v is NetworkClass => typeof v === "string" && (NETWORK_CLASSES as readonly string[]).includes(v);

/** Policies chat, Code and API clients may run Auto on ("model" is a pin, not Auto). */
export const AUTO_POLICIES = ["auto", "local_first", "local_only", "mine_only"] as const;
export type AutoPolicy = (typeof AUTO_POLICIES)[number];

/**
 * The policy chat, Code, `edgecoder code` and API Auto run on here: EDGECODER_AUTO_POLICY, default
 * "auto". "mine_only" is free machines only (this computer and your machines, never the network):
 * a hard step that needs a bigger model then runs on the biggest free one, marked as a fallback.
 */
export function autoPolicyFromEnv(env: Record<string, string | undefined> = process.env): AutoPolicy {
  const v = (env.EDGECODER_AUTO_POLICY ?? "").trim().toLowerCase().replace(/-/g, "_");
  return (AUTO_POLICIES as readonly string[]).includes(v) ? (v as AutoPolicy) : "auto";
}

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

function fallbackRoutes(inp: RouteInputs, places: Array<"local" | "mine">, needsTools = false): Route[] {
  const out: Route[] = [];
  for (const p of places) {
    const models = p === "local" ? inp.localModels : inp.myModels;
    // Never a model that can't call tools for an agent step, not even as the last resort.
    const model = biggestUsable(needsTools ? models.filter(callsTools) : models);
    if (model) out.push({ placement: p, model, cSatsPerSecond: 0, fallback: true, reason: `${p === "local" ? "this computer" : "your machines"} · ${model} · ${FALLBACK_NOTE}` });
  }
  // The biggest first (a stable sort: this computer wins a tie).
  return out.sort((a, b) => paramsB(b.model) - paramsB(a.model));
}

export interface PlanOptions {
  /** cSats this request may spend on the network (a bot's budget left today); undefined: only the balance caps it. */
  allowanceCSats?: number;
  /** The model id for the "model" policy (and network_only's chosen model). */
  model?: string;
  /** network_only: the one class it may run on ("gpu" is the GPU family: gpu and gpu.dc; undefined: any class). */
  computeClass?: string;
  /** network_only: the bot's daily budget, for the message when it's spent. */
  budgetCSats?: number | null;
  /** Whose budget allowanceCSats is (a bot's name), for "Harry's budget has 6 left today". */
  budgetOwner?: string;
  /**
   * Routes to leave out (routeModelId form, "network/auto@any" for the network's best fit): a bot
   * whose model answered an agent step with a plan and no tool call tries the next place once.
   * Ignored when it would leave nothing to try.
   */
  exclude?: string[];
  /**
   * The smallest model (billions of parameters) for agent work (tools or a long context) under
   * local_first and auto, when it's above the usual floor. Bots set it: a 7B model on this computer
   * doesn't follow tool calls well enough to work on its own, so a capable model on your machines or
   * the network (within the budget) comes first. The biggest free model is still the last resort.
   */
  agentMinParamsB?: number;
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
  if (policy === "network_only") {
    // Never a free place, never a free fallback: the network or nothing (noRouteMessage says why).
    const cls = isNetworkClass(opts.computeClass) ? opts.computeClass : undefined;
    if (opts.model) {
      const named = routeFromModelId(opts.model);
      if (!named) return [];
      const pinnedCls = cls ?? (named.placement === "network" ? named.computeClass ?? "any" : "any");
      // A family ("gpu": any GPU): each of its classes that has the model, fastest first; when the
      // network's models aren't known, the class itself.
      const offered = inp.networkModels.find((m) => m.model === named.model)?.classes;
      const family = pinnedCls === "any" ? ["any"] : classFamily(pinnedCls);
      const classes = family.length > 1 && offered ? family.filter((c) => offered.includes(c)).sort((a, b) => (CLASS_SPEED[b] ?? 0) - (CLASS_SPEED[a] ?? 0)) : [pinnedCls];
      return (classes.length ? classes : [pinnedCls])
        .map((c): Route => ({ placement: "network", model: named.model, computeClass: c, cSatsPerSecond: 0, reason: `network ${pinnedCls === "any" ? "" : `${pinnedCls} `}only · ${named.model}` }))
        .filter(ok);
    }
    const sized = w.heavy && opts.agentMinParamsB && opts.agentMinParamsB > (w.minParamsB ?? 0) ? { ...w, minParamsB: opts.agentMinParamsB } : w;
    return networkRoutes(sized, inp, cls).filter(ok);
  }
  if (policy === "local_only" || policy === "mine_only") {
    // Free machines only: never the network, whatever the step needs.
    const freeInp: RouteInputs = { ...inp, ...(policy === "local_only" ? { myModels: [] } : {}), leases: [], networkModels: [] };
    const toolWhy = toolSkipNote(w, freeInp);
    const fit = rankRoutes(w, freeInp);
    if (fit.length) return withWhy(fit, toolWhy);
    const cxWhy = complexityFallbackNote(w, freeInp, policy === "local_only" ? "this computer only" : "free machines only");
    return withWhy(fallbackRoutes(inp, policy === "local_only" ? ["local"] : ["local", "mine"], w.needsTools), joinWhy(cxWhy, toolWhy));
  }
  const agentFloor = w.heavy && opts.agentMinParamsB && opts.agentMinParamsB > (w.minParamsB ?? 0) ? opts.agentMinParamsB : undefined;
  if (agentFloor) w = { ...w, minParamsB: agentFloor };
  const ranked = rankRoutes(w, inp);
  const order: Placement[] = policy === "local_first" ? ["local", "mine", "reserved"] : ["reserved", "local", "mine"];
  const free = order.flatMap((p) => ranked.filter((r) => r.placement === p));
  const net = ranked.filter((r) => r.placement === "network" && ok(r));
  const toolWhy = toolSkipNote(w, inp);
  if (free.length) return withWhy([...free, ...net], toolWhy);
  // Nothing free meets the step: the network when it can take it, then the biggest free model.
  const needWhy = complexityNeedNote(w, inp);
  const blocked = net.length ? "the network couldn't take it" : networkBlockedReason(inp, opts, ranked);
  // A bot's agent step (agentMinParamsB) with nothing that big: say why it ran on the smaller model
  // ("agent work wants ≥14B; this computer has ≤7B; a larger model wasn't available (balance 0)").
  const has = agentFloor && !needWhy ? biggestFree(w, inp) : undefined;
  const floorWhy = agentFloor && !needWhy ? `agent work wants ≥${agentFloor}B${has ? `; ${has}` : ""}; a larger model wasn't available (${blocked})` : undefined;
  return [
    ...withWhy(net, joinWhy(needWhy, toolWhy)),
    ...withWhy(fallbackRoutes(inp, ["local", "mine"], w.needsTools), joinWhy(needWhy ? complexityFallbackNote(w, { ...inp, networkModels: [] }, blocked) : floorWhy, toolWhy)),
  ];
}

/** The workload without its complexity: what the free places would have done before it. */
const withoutComplexity = (w: Workload): Workload => {
  const { complexity: _c, ...rest } = w;
  return rest;
};

/** Whether the step's complexity (not the quality floor or tools) is what kept the free places out. */
function complexityKeptFreeOut(w: Workload, freeInp: RouteInputs): boolean {
  if (w.complexity?.minB === undefined) return false;
  const places = (rs: Route[]) => rs.filter((r) => r.placement !== "network");
  return places(rankRoutes(w, freeInp)).length === 0 && places(rankRoutes(withoutComplexity(w), freeInp)).length > 0;
}

/** "this computer has ≤14B": the biggest free model a step could use, and where it is. */
function biggestFree(w: Workload, inp: Pick<RouteInputs, "localModels" | "myModels">): string | undefined {
  const usable = (ms: string[]) => (w.needsTools ? ms.filter(callsTools) : ms).filter((m) => !isEmbedding(m));
  const top = (ms: string[]) => Math.max(0, ...usable(ms).map(paramsB));
  const local = top(inp.localModels);
  const mine = top(inp.myModels);
  if (!local && !mine) return undefined;
  return local >= mine ? `this computer has ≤${local}B` : `your machines have ≤${mine}B`;
}

/** Why the step went past the free places: "high complexity, needs ≥30B; this computer has ≤14B". */
export function complexityNeedNote(w: Workload, inp: RouteInputs): string | undefined {
  if (!complexityKeptFreeOut(w, { ...inp, networkModels: [] })) return undefined;
  const cx = w.complexity!;
  const has = biggestFree(w, inp);
  return `${levelText(cx.level)} complexity, needs ≥${cx.minB}B${cx.reasoningCoder ? " coder or reasoning model" : ""}${has ? `; ${has}` : ""}`;
}

/** Why a hard step ran on a smaller free model: "high-complexity step; a larger model wasn't available (balance 0)". */
function complexityFallbackNote(w: Workload, freeInp: RouteInputs, blocked: string): string | undefined {
  if (!complexityKeptFreeOut(w, freeInp)) return undefined;
  return `${levelText(w.complexity!.level).replace(" ", "-")}-complexity step; a larger model wasn't available (${blocked})`;
}

/** Why the network can't take a request, in a few words. */
export function networkBlockedReason(inp: RouteInputs, opts: PlanOptions, ranked: Route[]): string {
  if (!inp.networkModels.length && inp.balanceCSats === undefined) return "not connected to the network";
  if (inp.balanceCSats !== undefined && inp.balanceCSats <= 0) return "balance 0";
  if (opts.allowanceCSats !== undefined && opts.allowanceCSats <= 0) return "today's budget is spent";
  if (!ranked.some((r) => r.placement === "network")) return "no network model that size";
  return "it would cost more than you can spend";
}

const joinWhy = (...parts: Array<string | undefined>) => parts.filter(Boolean).join("; ") || undefined;

/**
 * Why an agent step skipped a free model it would otherwise have used: the biggest model on this
 * computer (then your machines) that can't call tools. Undefined when nothing was skipped.
 */
export function toolSkipNote(w: Workload, inp: Pick<RouteInputs, "localModels" | "myModels">): string | undefined {
  if (!w.needsTools) return undefined;
  for (const [where, models] of [["local", inp.localModels], ["your machines'", inp.myModels]] as const) {
    const skipped = biggestUsable(models.filter((m) => !callsTools(m)));
    if (skipped) return `tools needed; ${where} ${skipped} has no tool support`;
  }
  return undefined;
}

function withWhy(routes: Route[], why: string | undefined): Route[] {
  return why ? routes.map((r) => ({ ...r, why: joinWhy(r.why, why) })) : routes;
}

/** cSats in a few significant digits: 0.012, 0.4, 6, 94. */
export function fmtCSats(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n >= 10) return String(Math.round(n));
  return String(Number(n.toPrecision(2)));
}

/** "GPU", "Datacenter GPU": a class's name for messages. */
export const className = (cls: string): string => CLASS_NAMES[cls] || cls;

/**
 * Machines online per class with a model: the coordinator's counts when it reports them, else
 * the classes that have a model (count unknown, as -1).
 */
function onlineByClass(inp: RouteInputs, model?: string): Record<string, number> {
  const out: Record<string, number> = {};
  const offered = new Set((model ? inp.networkModels.filter((m) => m.model === model) : inp.networkModels).flatMap((m) => m.classes));
  for (const cls of NETWORK_CLASSES) {
    const known = inp.classAgents?.[cls];
    // A pinned model: the class has it or not (the per-class count is for any model).
    out[cls] = model ? (offered.has(cls) ? -1 : 0) : known !== undefined ? known : offered.has(cls) ? -1 : 0;
  }
  return out;
}

/**
 * Whether the network has a machine of this class (its family: "gpu" is any GPU) with a model
 * (`model`: that model); undefined when the network's models aren't known.
 */
export function classOnline(inp: RouteInputs, cls: string, model?: string): boolean | undefined {
  if (!inp.networkModels.length && !inp.classAgents) return undefined;
  const by = onlineByClass(inp, model);
  return classFamily(cls).some((c) => by[c] !== 0);
}

/**
 * Why a "Network <class> only" request found no machine, and what is there instead:
 * "No GPU machines online. Available now: Datacenter GPU (1), Apple (2), CPU (9)."
 */
export function classUnavailableMessage(cls: string, inp: RouteInputs, model?: string): string {
  const family = classFamily(cls);
  const by = onlineByClass(inp, model);
  const others = NETWORK_CLASSES.filter((c) => !family.includes(c) && by[c] !== 0)
    .sort((a, b) => (CLASS_SPEED[b] ?? 0) - (CLASS_SPEED[a] ?? 0))
    .map((c) => (by[c] > 0 ? `${className(c)} (${by[c]})` : className(c)));
  const what = model ? `No ${className(cls)} machines online with ${model.replace(/^network\//, "")}.` : `No ${className(cls)} machines online.`;
  return `${what} ${others.length ? `Available now: ${others.join(", ")}.` : "Nothing else is online on the network right now either."} Choose another compute option, or try again when one is back.`;
}

/**
 * The out-of-cSats message: what may be spent (the balance, and a bot's budget left today), and
 * about what the step needs where it was going to run. "Not enough cSats: your balance is 0.01
 * cSats (Harry's budget has 6 left today). This step needs about 0.4 cSats on a Datacenter GPU."
 * Every one starts "Not enough cSats" (the apps key their Buy cSats action on it).
 */
export function notEnoughCSatsMessage(inp: RouteInputs, opts: PlanOptions = {}, need?: { cSats?: number; computeClass?: string; expectedCSats?: number }): string {
  const parts: string[] = [];
  const bal = inp.balanceCSats;
  const left = opts.allowanceCSats;
  const budget = left !== undefined && Number.isFinite(left) ? `${opts.budgetOwner ? `${opts.budgetOwner}'s` : "today's"} budget has ${fmtCSats(Math.max(0, left))} left today` : "";
  if (bal !== undefined) parts.push(`your balance is ${fmtCSats(Math.max(0, bal))} cSats${budget ? ` (${budget})` : ""}.`);
  else if (budget) parts.push(`${budget}.`);
  else parts.push("there aren't enough cSats for this step.");
  const where = need?.computeClass && need.computeClass !== "any" ? ` on a${/^[AEIOU]/i.test(className(need.computeClass)) ? "n" : ""} ${className(need.computeClass)}` : " on the network";
  // A call refused for its reserve (402 insufficient_credits) says what it sets aside and what it is expected to cost.
  if (need?.cSats !== undefined && need.cSats > 0 && need.expectedCSats !== undefined && need.expectedCSats >= 0) {
    parts.push(`This step sets aside up to ${fmtCSats(need.cSats)} cSats${where}; expected cost about ${fmtCSats(need.expectedCSats)} cSats; unused cSats come back.`);
  } else if (need?.cSats !== undefined && need.cSats > 0) parts.push(`This step needs about ${fmtCSats(need.cSats)} cSats${where}.`);
  return `Not enough cSats: ${parts.join(" ")}`;
}

/** The cheapest estimate for this step on the network (in `cls`'s family, when set), when prices are known. */
export function cheapestNetworkEstimate(w: Workload, inp: RouteInputs, cls?: string): { cSats: number; computeClass?: string } | undefined {
  const fam = cls && cls !== "any" ? classFamily(cls) : undefined;
  let best: { cSats: number; computeClass?: string } | undefined;
  for (const m of inp.networkModels) {
    if (!m.cSatsPerMTokens || isEmbedding(m.model) || (w.needsTools && !callsTools(m.model))) continue;
    if (fitScore(m.model, w) < 0) continue;
    const classes = fam ? m.classes.filter((c) => fam.includes(c)) : m.classes;
    if (!classes.length) continue;
    const cSats = estimateNetworkCSats(w, m.cSatsPerMTokens);
    if (!best || cSats < best.cSats) best = { cSats, computeClass: cls && cls !== "any" ? cls : classes.length === 1 ? classes[0] : undefined };
  }
  return best;
}

/** Why a policy found nowhere to run, in plain words. `w`: the step, for the cost estimate. */
export function noRouteMessage(policy: ComputePolicy, inp: RouteInputs, opts: PlanOptions = {}, w?: Workload): string {
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
    case "network_only": {
      const clsId = opts.computeClass && opts.computeClass !== "any" ? opts.computeClass : undefined;
      const cls = clsId ? ` ${className(clsId)}` : "";
      if (opts.allowanceCSats !== undefined && opts.allowanceCSats <= 0) {
        return `Network${cls} only: no cSats left today${opts.budgetCSats != null ? ` (budget ${opts.budgetCSats})` : ""}. It never runs on this computer or your machines; it resumes tomorrow, or raise the daily budget.`;
      }
      if (!inp.networkModels.length && inp.balanceCSats === undefined && !inp.classAgents) return `Network${cls} only: this computer isn't connected to the network. Sign in and let the agent start.`;
      const model = opts.model ? routeFromModelId(opts.model)?.model : undefined;
      // No machine of the class: that, and what is there instead (before any money question).
      if (clsId && classOnline(inp, clsId, model) === false) return classUnavailableMessage(clsId, inp, model);
      const est = w ? cheapestNetworkEstimate(w, inp, clsId) : undefined;
      if (broke || (est && est.cSats > networkAllowance(inp, opts))) return notEnoughCSatsMessage(inp, opts, est ? { ...est, computeClass: clsId ?? est.computeClass } : undefined);
      return `Network${cls} only: no network${cls} machine has a model for this step right now${model ? ` (${model})` : ""}. Try again later or choose another class.`;
    }
    case "model":
      if (opts.model?.startsWith("network/")) {
        // planRoutes leaves a network pin out only when it can't be paid for.
        const r = routeFromModelId(opts.model);
        const price = inp.networkModels.find((m) => m.model === r?.model)?.cSatsPerMTokens;
        return notEnoughCSatsMessage(inp, opts, w && price ? { cSats: estimateNetworkCSats(w, price), computeClass: r?.computeClass } : undefined);
      }
      return `The chosen model (${opts.model ?? "none"}) isn't available right now.`;
    default: {
      // The network has a model for it, but it costs more than may be spent: a money problem.
      const est = w && !broke ? cheapestNetworkEstimate(w, inp) : undefined;
      if (est && est.cSats > networkAllowance(inp, opts)) {
        return `${notEnoughCSatsMessage(inp, opts, est)} No model on this computer or your machines can take it instead: install one in Settings > Models, or buy cSats.`;
      }
      return broke
        ? `Nothing to run on: no model is installed on this computer or your machines, and the network can't be used because ${why}. Install a model in Settings > Models, or buy cSats.`
        : "No model fits this request: install a coder model that calls tools (7B or larger, e.g. qwen2.5-coder:7b or qwen3.5:9b) on one of your machines, or try again when the network has one.";
    }
  }
}

/** A machine's class as the four classes ("gpu.dc40" → "gpu.dc", "apple.m" → "apple"). */
function baseClassOf(c: string): string {
  return c.startsWith("gpu.dc") ? "gpu.dc" : c.startsWith("gpu") ? "gpu" : c.startsWith("apple") ? "apple" : "cpu";
}

/** Route inputs from the compute overview, your reservations and this computer's models. */
export function routeInputsFrom(input: {
  localModels: string[];
  selfAgentId?: string;
  machines?: Array<{ agentId: string; online: boolean; models: string[]; computeClass?: string }>;
  networkModels?: Array<{ model: string; classes: string[]; cSatsPerMTokens?: { input: number; output: number } }>;
  balanceCSats?: number;
  classes?: Record<string, { cSatsPerSecondBaseTier: number; agents?: number }>;
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
    ...(Object.values(input.classes ?? {}).some((v) => typeof v.agents === "number")
      ? {
          // Other people's machines: the coordinator counts yours too, but the network leg never runs there.
          classAgents: Object.fromEntries(
            Object.entries(input.classes ?? {})
              .filter(([, v]) => typeof v.agents === "number")
              .map(([k, v]) => [k, Math.max(0, (v.agents as number) - (input.machines ?? []).filter((m) => m.online && m.models.length > 0 && m.computeClass && baseClassOf(m.computeClass) === k).length)]),
          ),
        }
      : {}),
  };
}
