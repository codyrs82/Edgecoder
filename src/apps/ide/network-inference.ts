// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Network models for the OpenAI-compatible endpoint: "network/<model>[@class]" runs the chat on an
 * agent that has the model (any class, or the one named: cpu, apple, gpu, gpu.dc), through this
 * machine's agent (signed, billed per second by class to its owner in cSats), and streams the
 * reply back as it is generated.
 */

import type { ServedBy } from "../../swarm/served-by.js";
import { randomUUID } from "node:crypto";
import { request } from "undici";
import type { ChatMessage, ToolCall, ToolSpec } from "../../inference-api/types.js";
import type { RoutingHints } from "../../inference-api/job-descriptor.js";
import type { CoordinatorChoice } from "../../common/coordinator-choice.js";

export const NETWORK_PREFIX = "network/";
const CLASSES = new Set(["cpu", "apple", "gpu", "gpu.dc", "cloud"]);

export type Transport = (method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal) => Promise<{ status: number; json: Record<string, unknown> }>;

export interface NetworkDeps {
  /** The local agent's forwarder, e.g. http://127.0.0.1:4305 (signs for this machine's owner). */
  forwarder: string;
  token: () => string;
  /** Account to bill: this machine's agent id (the coordinator maps it to its owner), or the hosted key's account. */
  agentId: string;
  /** Reach the coordinator some other way (the hosted endpoint: portal service token). Paths are the coordinator's own. */
  transport?: Transport;
}

export interface NetworkModel {
  id: string;
  model: string;
  agents: number;
  classes: string[];
}

/**
 * Model ids that run off this computer: "network/qwen2.5-coder:32b@gpu" (any agent, optionally one
 * class), "mine/<model>" (your own machines) and "reserved/<reservation>/<model>" (a machine you
 * reserved). Null for anything else (a local model).
 */
export function parseNetworkModel(id: string): { model: string; computeClass: string; target?: "mine"; reservationId?: string } | null {
  if (id.startsWith("mine/")) return id.length > 5 ? { model: id.slice(5), computeClass: "any", target: "mine" } : null;
  const reserved = /^reserved\/([^/]+)\/(.+)$/.exec(id);
  if (reserved) return { model: reserved[2], computeClass: "any", reservationId: reserved[1] };
  if (!id.startsWith(NETWORK_PREFIX)) return null;
  const rest = id.slice(NETWORK_PREFIX.length);
  const at = rest.lastIndexOf("@");
  if (at > 0 && CLASSES.has(rest.slice(at + 1))) return { model: rest.slice(0, at), computeClass: rest.slice(at + 1) };
  return rest ? { model: rest, computeClass: "any" } : null;
}

export async function call(d: NetworkDeps, method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal) {
  if (d.transport) return d.transport(method, path, body, signal);
  const res = await request(`${d.forwarder}/forward${path}`, {
    method,
    headers: { authorization: `Bearer ${d.token()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headersTimeout: 70_000,
    bodyTimeout: 70_000,
    signal,
  });
  const text = await res.body.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text };
  }
  return { status: res.statusCode, json };
}

/** Models agents on the network have now; each also offered per class it runs on. */
export async function listNetworkModels(d: NetworkDeps): Promise<NetworkModel[]> {
  const { status, json } = await call(d, "GET", "/inference/models");
  if (status !== 200) return [];
  const models = (json.models as Array<{ model: string; agents: number; classes: string[]; restricted?: string }>) ?? [];
  const out: NetworkModel[] = [];
  for (const m of models) {
    // A restricted model (security research tier) is offered only on your own machines, never as a network call.
    if (m.restricted) {
      out.push({ id: `mine/${m.model}`, model: m.model, agents: m.agents, classes: m.classes });
      continue;
    }
    out.push({ id: `${NETWORK_PREFIX}${m.model}`, model: m.model, agents: m.agents, classes: m.classes });
    for (const c of m.classes) out.push({ id: `${NETWORK_PREFIX}${m.model}@${c}`, model: m.model, agents: m.agents, classes: [c] });
  }
  return out;
}

/**
 * The context window (tokens) a network model can be counted on to serve: the coordinator's
 * /inference/models figure (the smallest any agent serves it with), else undefined.
 */
export async function networkContextWindow(d: NetworkDeps, model: string): Promise<number | undefined> {
  const { status, json } = await call(d, "GET", "/inference/models");
  if (status !== 200) return undefined;
  const m = ((json.models as Array<{ model: string; contextWindow?: unknown }>) ?? []).find((x) => x.model === model);
  return typeof m?.contextWindow === "number" && m.contextWindow >= 2048 ? m.contextWindow : undefined;
}

export interface CompletionPiece {
  delta?: string;
  toolCalls?: ToolCall[];
  done?: boolean;
  error?: string;
  creditsSpent?: number;
  promptTokens?: number;
  outputTokens?: number;
  /** model "auto": "routed to <model> on <class> because <reason>" (the coordinator's best-fit choice). */
  routed?: string;
  /** Where the call ran (coordinator's served-by: masked machine label, hardware, region, timings). */
  served?: ServedBy;
}

/** A coordinator's `served` object, kept only when it has the expected shape. */
export function servedOf(v: unknown): ServedBy | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.label !== "string" || typeof o.hardware !== "string") return undefined;
  const str = (x: unknown, n = 80) => (typeof x === "string" ? x.slice(0, n) : undefined);
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined);
  const out: ServedBy = { label: o.label.slice(0, 80), own: o.own === true, computeClass: str(o.computeClass, 20) ?? "", tier: str(o.tier, 20) ?? null, hardware: o.hardware.slice(0, 80), region: str(o.region, 24) ?? null, country: str(o.country, 4) ?? null };
  const gpu = str(o.gpu);
  if (gpu) out.gpu = gpu;
  const city = str(o.city, 40);
  if (city) out.city = city;
  for (const k of ["pickupMs", "promptMs", "genMs", "promptTokens", "outputTokens"] as const) {
    const n = num(o[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

/** Where a network chat runs: any agent (billed per second), your own machines, or a lease you hold. */
export interface NetworkTarget {
  target?: "network" | "mine";
  reservationId?: string;
  /** Price ceiling, cSats per second on the class's base tier (sent as msat per credit). */
  maxCSatsPerSecond?: number;
  /** What sent it, for the usage page. */
  source?: string;
  /** model "auto": the client's hints for best-fit routing (job-descriptor.ts). */
  routing?: RoutingHints;
  /** model "auto": the coordinator may answer route_elsewhere when a peer is the best fit. */
  routeRedirect?: boolean;
  /** The portal's coordinator choice for this call (kept on its routing decision; portal service token only). */
  coordinatorChoice?: CoordinatorChoice;
}

/**
 * Why a network call couldn't start, as data (the apps word it): `code` the coordinator's error
 * ("no_route_fits", "insufficient_credits"), `reason` for no_route_fits ("none": no machine,
 * "price": nothing within what may be spent), `neededCSats` about what the step needs.
 */
export interface NetworkFailureInfo {
  code: string;
  reason?: string;
  neededCSats?: number;
  computeClass?: string;
}

export class NetworkInferenceError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSec?: number, readonly info?: NetworkFailureInfo) {
    super(message);
  }
}

/** no_route_fits from the coordinator as data; older coordinators only send the detail text. */
export function noRouteInfo(json: Record<string, unknown>): NetworkFailureInfo {
  const detail = String(json.detail ?? "");
  const reason =
    typeof json.reason === "string" ? json.reason :
    /costs more than the .* cSats ceiling/.test(detail) ? "price" :
    /no agent with a model is online/.test(detail) ? "none" : undefined;
  return {
    code: "no_route_fits",
    ...(reason ? { reason } : {}),
    ...(typeof json.neededCSats === "number" ? { neededCSats: json.neededCSats } : {}),
    ...(typeof json.computeClass === "string" ? { computeClass: json.computeClass } : {}),
  };
}

/** model "auto": the coordinator's best fit is on a peer coordinator; resubmit there. */
export class RouteElsewhereError extends NetworkInferenceError {
  constructor(readonly url: string, readonly routing: Record<string, unknown> | undefined) {
    super(`The best fit for this request is on another coordinator (${url}).`, 409);
  }
}

/** model "auto" sent to a coordinator that does not route it (an older build): plan on this side instead. */
export class AutoUnsupportedError extends NetworkInferenceError {
  constructor() {
    super("This coordinator does not route model auto.", 404);
  }
}

/**
 * The coordinator cancelled the call because no agent claimed it in time (503 no_capacity):
 * nothing was charged and it can be sent again after `retryAfterSec`.
 */
function noCapacityError(json: Record<string, unknown>, model: string): NetworkInferenceError {
  const retryAfterSec = typeof json.retryAfterSec === "number" && json.retryAfterSec > 0 ? Math.ceil(json.retryAfterSec) : 15;
  // The coordinator says whether the class had any machine with the model at all (older ones never do: "busy").
  if (json.reason === "none_in_class") {
    return new NetworkInferenceError(`No ${String(json.computeClass ?? "requested-class")} machine runs ${model} right now (machines of other classes do). Nothing was charged; try another class or try again later.`, 503, retryAfterSec);
  }
  return new NetworkInferenceError(`Every machine that runs ${model} is busy and none could start this request in time. Nothing was charged; try again in ${retryAfterSec} s.`, 503, retryAfterSec);
}

/**
 * A stream read that failed on the way (the connection reset, an edge proxy's 502/504 page, the
 * coordinator briefly unreachable) is read again after a short wait: a read only returns pieces
 * after `after`, so repeating it loses and duplicates nothing. What the coordinator itself answered
 * (no_capacity, unknown_stream, not_requester) is not retried. Without this, one dropped long poll
 * ended a reply that was still being generated.
 */
export const STREAM_READ_RETRY_DELAYS_MS = [250, 1_000, 3_000];

const transientRead = (status: number, json: Record<string, unknown>) =>
  status === 502 || status === 504 || status === 520 || status === 522 || status === 524 || (status === 503 && json.error !== "no_capacity") || json.error === "coordinator_bad_response";

async function readStream(d: NetworkDeps, body: { taskId: string; subtaskId: string; after: number }, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= STREAM_READ_RETRY_DELAYS_MS.length;
    try {
      const r = await call(d, "POST", "/inference/stream", { ...body, waitMs: 15_000 }, signal);
      if (last || signal?.aborted || !transientRead(r.status, r.json)) return r;
    } catch (err) {
      if (last || signal?.aborted) throw err;
    }
    await new Promise((res) => setTimeout(res, STREAM_READ_RETRY_DELAYS_MS[attempt]));
  }
}

/**
 * Task ids of the network calls this provider has in flight. When this machine's own agent serves
 * one of them, Active work says the job is yours; any other job it serves is "someone on the network".
 */
export const ownInflightTaskIds = new Set<string>();

/** Run a chat on the network and yield the reply as it streams. */
export async function* streamNetworkCompletion(
  d: NetworkDeps,
  req: { model: string; computeClass: string; messages: Array<{ role: string; content: string } | ChatMessage>; tools?: ToolSpec[]; maxTokens?: number; temperature?: number } & NetworkTarget,
  signal?: AbortSignal,
): AsyncGenerator<CompletionPiece> {
  const taskId = `inf-${Date.now()}-${randomUUID().slice(0, 8)}`;
  ownInflightTaskIds.add(taskId);
  try {
    yield* streamSubmitted(d, req, taskId, signal);
  } finally {
    ownInflightTaskIds.delete(taskId);
  }
}

async function* streamSubmitted(
  d: NetworkDeps,
  req: Parameters<typeof streamNetworkCompletion>[1],
  taskId: string,
  signal?: AbortSignal,
): AsyncGenerator<CompletionPiece> {
  const sub = await call(d, "POST", "/inference/submit", {
    taskId,
    submitterAccountId: d.agentId,
    model: req.model,
    computeClass: req.computeClass,
    messages: req.messages.map((m) => {
      const cm = m as ChatMessage;
      const role = cm.role === "system" || cm.role === "assistant" || cm.role === "tool" ? cm.role : "user";
      return { role, content: cm.content, ...(cm.tool_calls?.length ? { tool_calls: cm.tool_calls } : {}), ...(cm.tool_name ? { tool_name: cm.tool_name } : {}) };
    }),
    ...(req.tools?.length ? { tools: req.tools } : {}),
    ...(req.target ? { target: req.target } : {}),
    ...(req.reservationId ? { reservationId: req.reservationId } : {}),
    ...(req.source ? { source: req.source.slice(0, 80) } : {}),
    ...(req.maxCSatsPerSecond ? { maxBidMsatPerCredit: Math.round(req.maxCSatsPerSecond * 1000) } : {}),
    ...(req.maxTokens ? { maxTokens: Math.min(32_768, req.maxTokens) } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.model === "auto" && req.routing && Object.keys(req.routing).length ? { routing: req.routing } : {}),
    // A named model still carries the buyer's price ceiling: the coordinator caps the call's reserve at it.
    ...(req.model !== "auto" && req.routing?.maxCSats !== undefined ? { routing: { maxCSats: req.routing.maxCSats } } : {}),
    ...(req.model === "auto" && req.routeRedirect ? { routeRedirect: true } : {}),
    ...(req.coordinatorChoice ? { coordinatorChoice: req.coordinatorChoice } : {}),
  }, signal);
  if (sub.status !== 200) {
    const err = String(sub.json.error ?? `HTTP ${sub.status}`);
    if (req.model === "auto") {
      if (err === "route_elsewhere" && typeof sub.json.coordinatorUrl === "string") throw new RouteElsewhereError(sub.json.coordinatorUrl, sub.json.routing as Record<string, unknown> | undefined);
      // An older coordinator looks for a model called "auto"; one that routes says no_route_fits.
      if (err === "no_agent_has_model") throw new AutoUnsupportedError();
      if (err === "no_route_fits") throw new NetworkInferenceError(`No model on the network fits this request: ${String(sub.json.detail ?? "nothing is available")}.`, 404, undefined, noRouteInfo(sub.json));
    }
    const msg =
      err === "no_agent_has_model" ? `No machine on the network has ${req.model} right now.` :
      err === "no_own_agent_has_model" && sub.json.reason === "local_only"
        ? `${req.model} is installed on your machine ${((sub.json.localOnlyOn as string[] | undefined) ?? []).slice(0, 3).join(", ") || "(one of yours)"}, but it is too big for that machine to share on the network, and its agent is too old to run it for you only. Update the agent there, or pick a model it serves.` :
      err === "no_own_agent_has_model" ? `None of your own machines has ${req.model} (or none is online).` :
      err === "no_agent_in_class" ? `No ${String(sub.json.computeClass ?? req.computeClass)} machine runs ${req.model} right now; it runs on: ${((sub.json.availableClasses as string[]) ?? []).join(", ") || "no class"}. Nothing was charged.` :
      err === "reservation_not_active" ? "That reservation isn't active: it ended, or it belongs to another account. Reserve again on the Compute page." :
      err === "reserved_agent_lacks_model" ? `The reserved machine doesn't have ${req.model}; it has: ${((sub.json.models as string[]) ?? []).join(", ") || "no models"}.` :
      err === "insufficient_credits" ? `Not enough cSats for this request (it sets aside up to ${sub.json.neededCSats} cSats; unused cSats come back).` :
      err === "agent_not_registered" ? "This computer's agent isn't connected to the network yet." :
      `Network request failed: ${err}`;
    // 404 (reservation_not_active) stays a 404: as a 502 the edge (Cloudflare) swaps the body for its
    // own error page, so an API caller never sees why.
    const info: NetworkFailureInfo | undefined =
      err === "insufficient_credits" ? { code: err, ...(typeof sub.json.neededCSats === "number" ? { neededCSats: sub.json.neededCSats } : {}), ...(req.computeClass && req.computeClass !== "any" ? { computeClass: req.computeClass } : {}) } :
      err === "no_agent_in_class" || err === "no_agent_has_model" ? { code: err, ...(req.computeClass && req.computeClass !== "any" ? { computeClass: req.computeClass } : {}) } :
      undefined;
    throw new NetworkInferenceError(msg, sub.status === 402 ? 402 : sub.status === 409 || sub.status === 404 ? 404 : 502, undefined, info);
  }
  const subtaskId = String(sub.json.subtaskId);
  const routed = typeof (sub.json.routing as { line?: unknown } | undefined)?.line === "string" ? String((sub.json.routing as { line: string }).line) : undefined;
  let after = 0;
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) return;
    const r = await readStream(d, { taskId, subtaskId, after }, signal);
    if (r.status === 503 && r.json.error === "no_capacity") throw noCapacityError(r.json, req.model);
    if (r.status !== 200) throw new NetworkInferenceError(`Network stream failed: ${String(r.json.error ?? r.status)}`, 502);
    const chunks = (r.json.chunks as string[]) ?? [];
    for (const c of chunks) if (c) yield { delta: c };
    after = Number(r.json.next ?? after + chunks.length);
    if (r.json.done) {
      if (Array.isArray(r.json.toolCalls) && r.json.toolCalls.length) yield { toolCalls: r.json.toolCalls as ToolCall[] };
      yield { done: true, ...(r.json.error ? { error: String(r.json.error) } : {}), ...(typeof r.json.creditsSpent === "number" ? { creditsSpent: r.json.creditsSpent } : {}), ...(typeof r.json.promptTokens === "number" ? { promptTokens: r.json.promptTokens } : {}), ...(typeof r.json.outputTokens === "number" ? { outputTokens: r.json.outputTokens } : {}), ...(routed ? { routed } : {}), ...(servedOf(r.json.served) ? { served: servedOf(r.json.served) } : {}) };
      return;
    }
  }
  throw new NetworkInferenceError("The network didn't finish within 6 minutes.", 504);
}

/** OpenAI message content may be a string or a list of parts; the network takes text. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export interface ComputeOverview {
  connected: boolean;
  selfAgentId?: string;
  account?: {
    accountId: string;
    cSats: number;
    earnedSats: number;
    recent: Array<{ type: string; cSats: number; reason: string; taskId?: string; atMs: number }>;
    machines?: Array<{ agentId: string; online: boolean; lastSeenMs: number; computeClass: string; tier: string | null; activeModel: string | null; models: string[]; reservedUntilMs: number | null }>;
    networkAgents?: number;
    coordinator?: { peerId: string; url: string };
  };
  /** agents: machines online in the class with a model (newer coordinators). */
  classes?: Record<string, { label: string; cSatsPerSecondBaseTier: number; agents?: number }>;
  /** agentsByClass: machines per class with the model (newer coordinators). */
  models?: Array<{ model: string; agents: number; agentsByClass?: Record<string, number>; classes: string[]; cSatsPerMTokens?: { input: number; output: number }; restricted?: string; cloudRank?: number; cloudHint?: string }>;
  /** How this machine's agent chose its coordinator (signed registry + latency), from /forward/health. */
  steering?: CoordinatorSteeringView | null;
  /**
   * The network refused this machine's agent (blacklisted by its safety checks), with the reason;
   * the app says so instead of "not connected". From /forward/health.
   */
  paused?: { reason: string; sinceMs: number } | null;
  /** Network subtasks this machine's agent is running now (the update restart waits for them). */
  claims?: number;
  /** The agent stopped taking work ahead of a restart. */
  draining?: boolean;
  /** This machine's memory: pressure, budget, and the models it serves on the network (src/swarm/memory-manager.ts). */
  memory?: MemoryOverview;
}

export interface MemoryOverview {
  pressure: "normal" | "warning" | "critical";
  paused: boolean;
  pausedReason: string | null;
  totalBytes: number;
  budgetBytes: number;
  usedBytes: number;
  loadedModels: string[];
  servingModels: string[];
  /** Newer agents: installed models not served on the network (they run for the owner only), with estimated bytes. */
  ownerModels?: Array<{ name: string; bytes: number }>;
  localOnlyModels: string[];
  tooBigModels: string[];
  contextWindow: number;
  parallel: number;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50).map((x) => x.slice(0, 200)) : []);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The agent's memory guard from /forward/health (also Settings → Active work, activity.ts). */
export function memoryView(raw: unknown): MemoryOverview | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.pressure !== "normal" && r.pressure !== "warning" && r.pressure !== "critical") return undefined;
  return {
    pressure: r.pressure,
    paused: r.paused === true,
    pausedReason: typeof r.pausedReason === "string" ? r.pausedReason.slice(0, 300) : null,
    totalBytes: num(r.totalBytes),
    budgetBytes: num(r.budgetBytes),
    usedBytes: num(r.usedBytes),
    loadedModels: strings(r.loadedModels),
    servingModels: strings(r.servingModels),
    localOnlyModels: strings(r.localOnlyModels),
    tooBigModels: strings(r.tooBigModels),
    ...(Array.isArray(r.ownerModels)
      ? { ownerModels: (r.ownerModels as unknown[]).filter((x): x is { name: string; bytes: number } => typeof (x as { name?: unknown })?.name === "string" && typeof (x as { bytes?: unknown })?.bytes === "number").slice(0, 50).map((x) => ({ name: x.name.slice(0, 200), bytes: num(x.bytes) })) }
      : {}),
    contextWindow: num(r.contextWindow),
    parallel: num(r.parallel),
  };
}

/** paused / claims / draining / memory from the forwarder's /forward/health (agent-lifecycle.ts). */
function lifecycleView(raw: Record<string, unknown> | undefined): Pick<ComputeOverview, "paused" | "claims" | "draining" | "memory"> {
  if (!raw) return {};
  const out: Pick<ComputeOverview, "paused" | "claims" | "draining" | "memory"> = {};
  const memory = memoryView(raw.memory);
  if (memory) out.memory = memory;
  const p = raw.paused as { reason?: unknown; sinceMs?: unknown } | null | undefined;
  if (p && typeof p === "object" && typeof p.reason === "string") out.paused = { reason: p.reason.slice(0, 500), sinceMs: typeof p.sinceMs === "number" ? p.sinceMs : 0 };
  if (typeof raw.claims === "number") out.claims = raw.claims;
  if (typeof raw.draining === "boolean") out.draining = raw.draining;
  return out;
}

/** The agent's last steering decision as the app shows it (src/discovery/steering.ts SteeringResult). */
export interface CoordinatorSteeringView {
  url: string;
  source: "registry" | "fallback";
  peerId?: string;
  region?: string;
  latencyMs?: number;
  reason: string;
  decidedAtMs: number;
}

function steeringView(raw: unknown): CoordinatorSteeringView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string" || (r.source !== "registry" && r.source !== "fallback")) return null;
  return {
    url: r.url,
    source: r.source,
    ...(typeof r.peerId === "string" ? { peerId: r.peerId } : {}),
    ...(typeof r.region === "string" ? { region: r.region } : {}),
    ...(typeof r.latencyMs === "number" ? { latencyMs: r.latencyMs } : {}),
    reason: typeof r.reason === "string" ? r.reason : "",
    decidedAtMs: typeof r.decidedAtMs === "number" ? r.decidedAtMs : 0,
  };
}

/** Balance, prices per class and the network's models, for the app's Compute page. */
export async function computeOverview(d: NetworkDeps): Promise<ComputeOverview> {
  const [acct, cat, health] = await Promise.all([
    call(d, "POST", "/account/summary", {}).catch(() => ({ status: 0, json: {} as Record<string, unknown> })),
    call(d, "GET", "/inference/models").catch(() => ({ status: 0, json: {} as Record<string, unknown> })),
    // The local forwarder's own state (which coordinator steering picked); not a coordinator route.
    d.transport ? Promise.resolve(null) : call(d, "GET", "/health").catch(() => null),
  ]);
  const lifecycle = lifecycleView(health?.status === 200 ? health.json : undefined);
  if (acct.status !== 200 && cat.status !== 200) return { connected: false, ...lifecycle };
  const steering = health?.status === 200 ? steeringView(health.json.steering) : null;
  return {
    connected: true,
    selfAgentId: d.agentId,
    ...(steering ? { steering } : {}),
    ...lifecycle,
    ...(acct.status === 200 ? { account: acct.json as unknown as ComputeOverview["account"] } : {}),
    ...(cat.status === 200 ? { classes: cat.json.classes as ComputeOverview["classes"], models: cat.json.models as ComputeOverview["models"] } : {}),
  };
}

/**
 * Before the app restarts (an update) or quits: this machine's agent stops taking network work and
 * hands what it holds to other agents (BHV006). `resume` takes work again (the restart was put off).
 */
export async function drainAgent(d: NetworkDeps, resume = false) {
  return call(d, "POST", "/drain", { resume });
}

/** Ask for a Lightning invoice that buys cSats for this machine's owner. */
export async function buyCSats(d: NetworkDeps, amountSats: number) {
  return call(d, "POST", "/account/buy", { amountSats });
}

/** Whether a purchase has been paid (checks with the coordinator's Lightning node). */
export async function purchaseStatus(d: NetworkDeps, intentId: string) {
  return call(d, "POST", "/account/intent", { intentId });
}

/** Your reserved-capacity leases and what could be reserved now per class. */
export async function listReservations(d: NetworkDeps) {
  return call(d, "POST", "/account/reservations/list", {});
}

/** Reserve one machine of a class for some minutes (paid now; unused time comes back). */
export async function createReservation(d: NetworkDeps, body: { computeClass: string; minutes: number; model?: string; minVramGb?: number }) {
  return call(d, "POST", "/account/reservations", body);
}

/** Your usage over the last N days (summary for the usage page). */
export async function usageSummary(d: NetworkDeps, days: number) {
  return call(d, "POST", "/account/usage", { days });
}

export async function cancelReservation(d: NetworkDeps, reservationId: string) {
  return call(d, "POST", "/account/reservations/cancel", { reservationId });
}
