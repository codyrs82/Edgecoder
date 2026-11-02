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

export const NETWORK_PREFIX = "network/";
const CLASSES = new Set(["cpu", "apple", "gpu", "gpu.dc"]);

export interface NetworkDeps {
  /** The local agent's forwarder, e.g. http://127.0.0.1:4305 */
  forwarder: string;
  token: () => string;
  /** Account to bill: this machine's agent id (the coordinator maps it to its owner). */
  agentId: string;
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
  const res = await request(`${d.forwarder}${path}`, {
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
  const { status, json } = await call(d, "GET", "/forward/inference/models");
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
  done?: boolean;
  error?: string;
  creditsSpent?: number;
}

export class NetworkInferenceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Run a chat on the network and yield the reply as it streams. */
export async function* streamNetworkCompletion(
  d: NetworkDeps,
  req: { model: string; computeClass: string; messages: Array<{ role: string; content: string }>; maxTokens?: number; temperature?: number },
  signal?: AbortSignal,
): AsyncGenerator<CompletionPiece> {
  const taskId = `inf-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sub = await call(d, "POST", "/forward/inference/submit", {
    taskId,
    submitterAccountId: d.agentId,
    model: req.model,
    computeClass: req.computeClass,
    messages: req.messages.map((m) => ({ role: m.role === "system" || m.role === "assistant" ? m.role : "user", content: m.content })),
    ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  }, signal);
  if (sub.status !== 200) {
    const err = String(sub.json.error ?? `HTTP ${sub.status}`);
    const msg =
      err === "no_agent_has_model" ? `No machine on the network has ${req.model} right now.` :
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
    const r = await call(d, "POST", "/forward/inference/stream", { taskId, subtaskId, after, waitMs: 15_000 }, signal);
    if (r.status !== 200) throw new NetworkInferenceError(`Network stream failed: ${String(r.json.error ?? r.status)}`, 502);
    const chunks = (r.json.chunks as string[]) ?? [];
    for (const c of chunks) if (c) yield { delta: c };
    after = Number(r.json.next ?? after + chunks.length);
    if (r.json.done) {
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
