// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Network models for the OpenAI-compatible endpoint: "network/<model>[@class]" runs the chat on an
 * agent that has the model (any class, or the one named: cpu, apple, gpu, gpu.dc), through this
 * machine's agent (signed, billed per second by class to its owner in cSats), and streams the
 * reply back as it is generated.
 */

import { randomUUID } from "node:crypto";
import { request } from "undici";
import type { ChatMessage, ToolCall, ToolSpec } from "../../inference-api/types.js";

export const NETWORK_PREFIX = "network/";
const CLASSES = new Set(["cpu", "apple", "gpu", "gpu.dc"]);

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

/** "network/qwen2.5-coder:32b@gpu" -> { model, computeClass }; null when not a network model. */
export function parseNetworkModel(id: string): { model: string; computeClass: string } | null {
  if (!id.startsWith(NETWORK_PREFIX)) return null;
  const rest = id.slice(NETWORK_PREFIX.length);
  const at = rest.lastIndexOf("@");
  if (at > 0 && CLASSES.has(rest.slice(at + 1))) return { model: rest.slice(0, at), computeClass: rest.slice(at + 1) };
  return rest ? { model: rest, computeClass: "any" } : null;
}

async function call(d: NetworkDeps, method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal) {
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
  const models = (json.models as Array<{ model: string; agents: number; classes: string[] }>) ?? [];
  const out: NetworkModel[] = [];
  for (const m of models) {
    out.push({ id: `${NETWORK_PREFIX}${m.model}`, model: m.model, agents: m.agents, classes: m.classes });
    for (const c of m.classes) out.push({ id: `${NETWORK_PREFIX}${m.model}@${c}`, model: m.model, agents: m.agents, classes: [c] });
  }
  return out;
}

export interface CompletionPiece {
  delta?: string;
  toolCalls?: ToolCall[];
  done?: boolean;
  error?: string;
  creditsSpent?: number;
}

/** Where a network chat runs: any agent (billed per second), your own machines, or a lease you hold. */
export interface NetworkTarget {
  target?: "network" | "mine";
  reservationId?: string;
  /** Price ceiling, cSats per second on the class's base tier (sent as msat per credit). */
  maxCSatsPerSecond?: number;
}

export class NetworkInferenceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Run a chat on the network and yield the reply as it streams. */
export async function* streamNetworkCompletion(
  d: NetworkDeps,
  req: { model: string; computeClass: string; messages: Array<{ role: string; content: string } | ChatMessage>; tools?: ToolSpec[]; maxTokens?: number; temperature?: number } & NetworkTarget,
  signal?: AbortSignal,
): AsyncGenerator<CompletionPiece> {
  const taskId = `inf-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
    ...(req.maxCSatsPerSecond ? { maxBidMsatPerCredit: Math.round(req.maxCSatsPerSecond * 1000) } : {}),
    ...(req.maxTokens ? { maxTokens: Math.min(32_768, req.maxTokens) } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  }, signal);
  if (sub.status !== 200) {
    const err = String(sub.json.error ?? `HTTP ${sub.status}`);
    const msg =
      err === "no_agent_has_model" ? `No machine on the network has ${req.model} right now.` :
      err === "no_own_agent_has_model" ? `None of your own machines has ${req.model} (or none is online).` :
      err === "reservation_not_active" ? "That reservation has ended. Reserve again on the Compute page." :
      err === "reserved_agent_lacks_model" ? `The reserved machine doesn't have ${req.model}; it has: ${((sub.json.models as string[]) ?? []).join(", ") || "no models"}.` :
      err === "insufficient_credits" ? `Not enough cSats for this request (it sets aside up to ${sub.json.neededCSats} cSats; unused cSats come back).` :
      err === "agent_not_registered" ? "This computer's agent isn't connected to the network yet." :
      `Network request failed: ${err}`;
    throw new NetworkInferenceError(msg, sub.status === 402 ? 402 : sub.status === 409 ? 404 : 502);
  }
  const subtaskId = String(sub.json.subtaskId);
  let after = 0;
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) return;
    const r = await call(d, "POST", "/inference/stream", { taskId, subtaskId, after, waitMs: 15_000 }, signal);
    if (r.status !== 200) throw new NetworkInferenceError(`Network stream failed: ${String(r.json.error ?? r.status)}`, 502);
    const chunks = (r.json.chunks as string[]) ?? [];
    for (const c of chunks) if (c) yield { delta: c };
    after = Number(r.json.next ?? after + chunks.length);
    if (r.json.done) {
      if (Array.isArray(r.json.toolCalls) && r.json.toolCalls.length) yield { toolCalls: r.json.toolCalls as ToolCall[] };
      yield { done: true, ...(r.json.error ? { error: String(r.json.error) } : {}), ...(typeof r.json.creditsSpent === "number" ? { creditsSpent: r.json.creditsSpent } : {}) };
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
  account?: { accountId: string; cSats: number; earnedSats: number; recent: Array<{ type: string; cSats: number; reason: string; taskId?: string; atMs: number }> };
  classes?: Record<string, { label: string; cSatsPerSecondBaseTier: number }>;
  models?: Array<{ model: string; agents: number; classes: string[] }>;
}

/** Balance, prices per class and the network's models, for the app's Compute page. */
export async function computeOverview(d: NetworkDeps): Promise<ComputeOverview> {
  const [acct, cat] = await Promise.all([
    call(d, "POST", "/account/summary", {}).catch(() => ({ status: 0, json: {} as Record<string, unknown> })),
    call(d, "GET", "/inference/models").catch(() => ({ status: 0, json: {} as Record<string, unknown> })),
  ]);
  if (acct.status !== 200 && cat.status !== 200) return { connected: false };
  return {
    connected: true,
    ...(acct.status === 200 ? { account: acct.json as unknown as ComputeOverview["account"] } : {}),
    ...(cat.status === 200 ? { classes: cat.json.classes as ComputeOverview["classes"], models: cat.json.models as ComputeOverview["models"] } : {}),
  };
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

export async function cancelReservation(d: NetworkDeps, reservationId: string) {
  return call(d, "POST", "/account/reservations/cancel", { reservationId });
}
