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

import type { ChatRequest } from "./types.js";

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
}

export interface RouteInputs {
  /** Models on this computer (empty for the hosted endpoint). */
  localModels: string[];
  /** Models on your other machines that are online. */
  myModels: string[];
  /** Active reservations: the models their machines have. */
  leases: Array<{ id: string; computeClass: string; models: string[] }>;
  /** Network models and the classes that have them. */
  networkModels: Array<{ model: string; classes: string[] }>;
  /** cSats per second for each class's base tier. */
  classPrice: Record<string, number>;
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
  const local = bestModel(inp.localModels, w);
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

/** Route inputs from the compute overview, your reservations and this computer's models. */
export function routeInputsFrom(input: {
  localModels: string[];
  selfAgentId?: string;
  machines?: Array<{ agentId: string; online: boolean; models: string[] }>;
  networkModels?: Array<{ model: string; classes: string[] }>;
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
  };
}
