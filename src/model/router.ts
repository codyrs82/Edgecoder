// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * IntelligentRouter — decides WHERE to execute each IDE request.
 *
 * Decision waterfall (in priority order):
 *
 *  1. Bluetooth-local  — a nearby iPhone/Mac is connected and BT mode is active.
 *                        Free, offline, zero credits used or earned.
 *
 *  2. Local Ollama     — local model is healthy AND p95 latency is within budget
 *                        AND concurrent load is below the concurrency cap.
 *                        Free for the user; no swarm credits involved.
 *
 *  3. Swarm network    — submit as a task to the coordinator queue.
 *                        Costs credits from the local agent's account;
 *                        the fulfilling agent earns credits.
 *                        Used when local is too slow, unhealthy, or overloaded.
 *
 *  4. Edgecoder-local  — deterministic offline stub; always succeeds.
 *                        Last resort so the IDE never hard-blocks.
 *
 * The router tracks an exponential-moving-average (EMA) of local response
 * latency and a concurrency counter so it can make the right call without
 * needing a separate sidecar process.
 */

import { request } from "undici";
import type { Readable } from "node:stream";
import { OllamaLocalProvider, EdgeCoderLocalProvider } from "./providers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * #71/#113: thrown when the coordinator accepted the swarm task but we never got the
 * result (no subtask id, poll timeout). The task may still run and bill, so callers
 * must count the spend, not release the reservation.
 */
export class SwarmPostSubmitError extends Error {
  readonly submitted = true;
  constructor(message: string, readonly swarmTaskId?: string) {
    super(message);
    this.name = "SwarmPostSubmitError";
  }
}

export type RouteDecision =
  | "bluetooth-local"
  | "ollama-local"
  | "swarm"
  | "edgecoder-local";

export interface RouterConfig {
  /** Max concurrent local Ollama requests before spilling to swarm. Default: 2 */
  localConcurrencyCap: number;
  /** If local EMA latency (ms) exceeds this, prefer swarm. Default: 8000 */
  localLatencyThresholdMs: number;
  /** Coordinator URL for swarm task submission. */
  coordinatorUrl: string;
  /** Mesh auth token for coordinator API. */
  meshAuthToken: string;
  /**
   * The user's own agent (its loopback forwarder, src/swarm/local-forwarder.ts). When set, swarm
   * work goes through it: the agent signs the submission, so it spends the agent owner's account.
   */
  localAgentUrl?: string;
  /** Bearer token for the local forwarder (the IDE token). */
  localAgentToken?: () => string;
  /** Agent account ID used for credit billing on swarm submissions. */
  agentAccountId: string;
  /** Bluetooth transport status endpoint (localhost). Default: disabled */
  bluetoothStatusUrl?: string;
  /** Language for swarm task submission. Default: "python" */
  swarmLanguage?: "python" | "javascript";
  /**
   * Frozen snapshot the coordinator requires on POST /submit (design decision #8): a
   * 40-hex git commit or an https:// tarball URL. Resolved per request so the IDE
   * can pass the active project's HEAD. Falls back to IDE_SWARM_SNAPSHOT_REF.
   */
  resolveSnapshotRef?: () => string | undefined;
}

/**
 * #159: undici/socket error codes that prove the request never left this host, so a
 * failed POST /submit with one of these cannot have been charged by the coordinator.
 * Anything else (headers/body timeout, reset after send, unknown) is treated as
 * "possibly submitted" and surfaces as SwarmPostSubmitError.
 */
const NOT_SENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_INVALID_ARG"
]);

export function submitErrorWasNeverSent(err: unknown): boolean {
  const code = (err as { code?: unknown; cause?: { code?: unknown } } | null)?.code
    ?? (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && NOT_SENT_ERROR_CODES.has(code);
}

const SNAPSHOT_REF_RE = /^(?:[0-9a-f]{40}|https:\/\/.+)$/i;

export interface RouterResult {
  text: string;
  route: RouteDecision;
  latencyMs: number;
  /** Credits spent (swarm route only) */
  creditsSpent?: number;
  /** Task ID if routed via swarm */
  swarmTaskId?: string;
  error?: string;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatRouteResult {
  route: RouteDecision;
  /** For non-streaming: the full response text */
  text?: string;
  /** For streaming: the NDJSON body from Ollama (caller consumes) */
  stream?: Readable;
  /** The model name used */
  model: string;
  latencyMs?: number;
  creditsSpent?: number;
  swarmTaskId?: string;
}

// ---------------------------------------------------------------------------
// EMA latency tracker
// ---------------------------------------------------------------------------

class LatencyTracker {
  private ema = 0;
  private samples = 0;
  private readonly alpha = 0.2; // EMA smoothing factor

  record(ms: number): void {
    if (this.samples === 0) {
      this.ema = ms;
    } else {
      this.ema = this.alpha * ms + (1 - this.alpha) * this.ema;
    }
    this.samples++;
  }

  get p95EstimateMs(): number {
    // Conservative: treat EMA as p50, multiply by 1.8 as p95 estimate
    return this.samples < 3 ? 0 : Math.round(this.ema * 1.8);
  }

  get sampleCount(): number {
    return this.samples;
  }
}

// ---------------------------------------------------------------------------
// IntelligentRouter
// ---------------------------------------------------------------------------

export class IntelligentRouter {
  private readonly ollama: OllamaLocalProvider;
  private readonly stub: EdgeCoderLocalProvider;
  private readonly latency = new LatencyTracker();
  private activeConcurrent = 0;
  private readonly cfg: RouterConfig;

  constructor(cfg: Partial<RouterConfig> = {}) {
    this.cfg = {
      localConcurrencyCap: 2,
      localLatencyThresholdMs: 8000,
      coordinatorUrl: process.env.COORDINATOR_URL ?? "https://coordinator.edgecoder.io",
      meshAuthToken: process.env.MESH_AUTH_TOKEN ?? "",
      localAgentUrl: process.env.SWARM_VIA_LOCAL_AGENT_URL?.trim() || undefined,
      agentAccountId: process.env.AGENT_ACCOUNT_ID ?? process.env.AGENT_ID ?? "local-agent",
      bluetoothStatusUrl: process.env.BT_STATUS_URL,
      swarmLanguage: "python",
      ...cfg
    };
    this.ollama = new OllamaLocalProvider();
    this.stub = new EdgeCoderLocalProvider();
  }

  // -------------------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------------------

  async route(prompt: string, maxTokens = 512): Promise<RouterResult> {
    const started = Date.now();

    // 1. Bluetooth-local — check first because it's zero-cost and offline-capable
    if (await this.isBluetoothAvailable()) {
      const result = await this.runViaBluetooth(prompt, maxTokens);
      if (result) {
        return { ...result, route: "bluetooth-local", latencyMs: Date.now() - started };
      }
    }

    // 2. Local Ollama — use if healthy and within capacity + latency budget
    if (await this.isLocalViable()) {
      try {
        this.activeConcurrent++;
        const t0 = Date.now();
        const res = await this.ollama.generate({ prompt, maxTokens });
        const elapsed = Date.now() - t0;
        this.latency.record(elapsed);
        this.activeConcurrent--;
        return { text: res.text, route: "ollama-local", latencyMs: elapsed };
      } catch (err) {
        this.activeConcurrent = Math.max(0, this.activeConcurrent - 1);
        console.warn("[router] local Ollama failed, falling to swarm:", String(err));
      }
    }

    // 3. Swarm — submit to coordinator task queue
    if (this.swarmEnabled) {
      try {
        const result = await this.runViaSwarm(prompt);
        return { ...result, route: "swarm", latencyMs: Date.now() - started };
      } catch (err) {
        console.warn("[router] swarm submission failed, falling to stub:", String(err));
      }
    }

    // 4. Edgecoder-local stub — always-on safety net
    const res = await this.stub.generate({ prompt, maxTokens });
    return { text: res.text, route: "edgecoder-local", latencyMs: Date.now() - started };
  }

  /** True when swarm routing is configured (the local agent forwarder or a mesh token). */
  get swarmEnabled(): boolean {
    return !!this.cfg.localAgentUrl || !!this.cfg.meshAuthToken;
  }

  /** #36: explicit swarm route for the IDE /run/swarm endpoint. Throws if swarm is not configured. */
  async routeSwarm(prompt: string, maxTokens?: number): Promise<RouterResult> {
    if (!this.swarmEnabled) throw new Error("swarm_unavailable");
    const started = Date.now();
    const result = await this.runViaSwarm(prompt, undefined, maxTokens);
    return { ...result, route: "swarm", latencyMs: Date.now() - started };
  }

  // -------------------------------------------------------------------------
  // Decision helpers
  // -------------------------------------------------------------------------

  private async isBluetoothAvailable(): Promise<boolean> {
    if (!this.cfg.bluetoothStatusUrl) return false;
    try {
      const res = await request(this.cfg.bluetoothStatusUrl, { method: "GET" });
      if (res.statusCode !== 200) return false;
      const body = (await res.body.json()) as { connected?: boolean; centralCount?: number };
      return !!(body.connected || (body.centralCount && body.centralCount > 0));
    } catch {
      return false;
    }
  }

  private async isLocalViable(): Promise<boolean> {
    // Concurrency gate
    if (this.activeConcurrent >= this.cfg.localConcurrencyCap) {
      console.log(`[router] local overloaded (${this.activeConcurrent}/${this.cfg.localConcurrencyCap} concurrent) → swarm`);
      return false;
    }
    // Latency gate — only apply after we have enough samples
    const p95 = this.latency.p95EstimateMs;
    if (p95 > 0 && p95 > this.cfg.localLatencyThresholdMs) {
      console.log(`[router] local p95 latency ${p95}ms > threshold ${this.cfg.localLatencyThresholdMs}ms → swarm`);
      return false;
    }
    // Health gate
    const healthy = await this.ollama.health();
    if (!healthy) {
      console.log("[router] local Ollama unhealthy → swarm");
    }
    return healthy;
  }

  // -------------------------------------------------------------------------
  // Bluetooth route
  // -------------------------------------------------------------------------

  private async runViaBluetooth(
    prompt: string,
    maxTokens: number
  ): Promise<Omit<RouterResult, "route" | "latencyMs"> | null> {
    // BT transport exposes a local HTTP proxy on a well-known port.
    // The BluetoothTransport peripheral on Mac/iPhone listens and forwards
    // the request to the connected device's llama.cpp inference.
    const btProxyUrl = process.env.BT_PROXY_URL ?? "http://127.0.0.1:11435";
    try {
      const res = await request(`${btProxyUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, maxTokens, stream: false }),
        headersTimeout: 30_000,
        bodyTimeout: 60_000
      });
      if (res.statusCode < 200 || res.statusCode >= 300) return null;
      const body = (await res.body.json()) as { response?: string; text?: string };
      return { text: body.response ?? body.text ?? "" };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Swarm route — submit task to coordinator queue, poll for result
  // -------------------------------------------------------------------------

  private async runViaSwarm(
    prompt: string,
    requestedModel?: string,
    maxTokens?: number
  ): Promise<Omit<RouterResult, "route" | "latencyMs">> {
    // Through the local agent, its forwarder mirrors the coordinator routes under /forward.
    const viaAgent = this.cfg.localAgentUrl?.replace(/\/$/, "");
    const coordinatorUrl = viaAgent ? `${viaAgent}/forward` : this.cfg.coordinatorUrl.replace(/\/$/, "");
    const headers: Record<string, string> = viaAgent
      ? { "content-type": "application/json", authorization: `Bearer ${this.cfg.localAgentToken?.() ?? ""}` }
      : { "content-type": "application/json", "x-mesh-token": this.cfg.meshAuthToken };

    // The coordinator's submit route is POST /submit (not /tasks) and it requires a
    // frozen snapshot reference (#8). Without one the request is rejected before any
    // charge, so fail here with an actionable message instead of a coordinator 500.
    const snapshotRef = this.cfg.resolveSnapshotRef?.() ?? process.env.IDE_SWARM_SNAPSHOT_REF?.trim();
    if (!snapshotRef || !SNAPSHOT_REF_RE.test(snapshotRef)) {
      throw new Error(
        "swarm_snapshot_ref_required: the swarm needs a frozen snapshot (40-hex git commit or https:// tarball). " +
          "Open a git project in the IDE or set IDE_SWARM_SNAPSHOT_REF."
      );
    }

    const taskId = `ide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Submit task
    let submitRes: Awaited<ReturnType<typeof request>>;
    try {
      submitRes = await request(`${coordinatorUrl}/submit`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          taskId,
          prompt,
          language: this.cfg.swarmLanguage ?? "python",
          snapshotRef,
          submitterAccountId: this.cfg.agentAccountId,
          projectId: "ide-requests",
          resourceClass: "cpu",
          priority: 60,
          requestedModel,
          // #71: forwarded so the coordinator can price and limit the request.
          ...(maxTokens !== undefined ? { maxTokens } : {})
        }),
        headersTimeout: 15_000,
        bodyTimeout: 15_000
      });
    } catch (err) {
      // #159: a connect-phase failure never reached the coordinator, so nothing was
      // charged. A headers/body timeout after the request was written may have been
      // accepted (and billed), so the caller must count the estimate, not release it.
      if (submitErrorWasNeverSent(err)) throw err;
      throw new SwarmPostSubmitError(
        `Swarm submit outcome unknown (${err instanceof Error ? err.message : String(err)})`,
        taskId
      );
    }

    if (submitRes.statusCode < 200 || submitRes.statusCode >= 300) {
      const errBody = await submitRes.body.text();
      throw new Error(`Swarm submit failed (${submitRes.statusCode}): ${errBody}`);
    }

    let submitBody: { taskId: string; subtasks: string[] };
    try {
      submitBody = (await submitRes.body.json()) as { taskId: string; subtasks: string[] };
    } catch {
      throw new SwarmPostSubmitError("Swarm: unreadable submit response", taskId);
    }
    const subtaskId = submitBody.subtasks?.[0];

    if (!subtaskId) throw new SwarmPostSubmitError("Swarm: no subtaskId returned", taskId);

    // Poll for result — up to 90s
    const pollUrl = `${coordinatorUrl}/tasks/${encodeURIComponent(taskId)}/subtasks/${encodeURIComponent(subtaskId)}/result`;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const pollRes = await request(pollUrl, { method: "GET", headers, headersTimeout: 10_000, bodyTimeout: 10_000 });
        if (pollRes.statusCode === 200) {
          const result = (await pollRes.body.json()) as {
            output?: string;
            ok?: boolean;
            error?: string;
            creditsSpent?: number;
          };
          if (result.output !== undefined) {
            return {
              text: result.output,
              creditsSpent: result.creditsSpent,
              swarmTaskId: taskId,
              ...(result.ok === false && result.error ? { error: result.error } : {})
            };
          }
        } else {
          await pollRes.body.dump();
        }
      } catch {
        // continue polling
      }
    }

    throw new SwarmPostSubmitError("Swarm task timed out after 90s", taskId);
  }

  // -------------------------------------------------------------------------
  // Chat routing — multi-message conversations with optional streaming
  // -------------------------------------------------------------------------

  private readonly ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  private readonly ollamaChatModel = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";

  async routeChat(
    messages: ChatMessage[],
    opts: { stream?: boolean; temperature?: number; maxTokens?: number; requestedModel?: string } = {}
  ): Promise<ChatRouteResult> {
    const stream = opts.stream ?? false;
    const temperature = opts.temperature ?? 0.7;
    const maxTokens = opts.maxTokens ?? 4096;
    const chatModel = opts.requestedModel ?? this.ollamaChatModel;

    // 1. Bluetooth-local chat
    if (await this.isBluetoothAvailable()) {
      const result = await this.runChatViaBluetooth(messages, maxTokens);
      if (result) {
        return { route: "bluetooth-local", text: result, model: "bluetooth" };
      }
    }

    // 2. Local Ollama — use if healthy and within capacity + latency budget
    if (await this.isLocalViable()) {
      try {
        this.activeConcurrent++;
        const t0 = Date.now();
        const ollamaRes = await request(`${this.ollamaHost}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: chatModel,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            stream,
            options: { temperature, num_predict: maxTokens },
          }),
        });

        if (stream) {
          // Return the raw stream — provider-server converts NDJSON → SSE
          // Latency is tracked when the stream ends (caller responsibility)
          return {
            route: "ollama-local",
            stream: ollamaRes.body as unknown as Readable,
            model: chatModel,
          };
        }

        // Non-streaming: read full response
        const payload = (await ollamaRes.body.json()) as {
          message?: { content?: string };
        };
        const elapsed = Date.now() - t0;
        this.latency.record(elapsed);
        this.activeConcurrent--;
        return {
          route: "ollama-local",
          text: payload.message?.content ?? "",
          model: chatModel,
          latencyMs: elapsed,
        };
      } catch (err) {
        this.activeConcurrent = Math.max(0, this.activeConcurrent - 1);
        console.warn("[router] local Ollama chat failed, falling to swarm:", String(err));
      }
    }

    // 3. Swarm — submit the last user message as a task to the coordinator
    if (this.swarmEnabled) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (lastUserMsg) {
        try {
          const result = await this.runViaSwarm(lastUserMsg.content, opts.requestedModel);
          return {
            route: "swarm",
            text: result.text,
            model: "swarm",
            creditsSpent: result.creditsSpent,
            swarmTaskId: result.swarmTaskId,
          };
        } catch (err) {
          console.warn("[router] swarm chat failed, falling to stub:", String(err));
        }
      }
    }

    // 4. Offline stub — always-on safety net
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    return {
      route: "edgecoder-local",
      text: "I'm currently offline — local Ollama is unavailable and no swarm peers are reachable. Please check that Ollama is running (`ollama serve`) or connect to the EdgeCoder network.",
      model: "edgecoder-local",
    };
  }

  /** Track that a streaming request finished (called by provider-server) */
  recordStreamComplete(elapsedMs: number): void {
    this.latency.record(elapsedMs);
    this.activeConcurrent = Math.max(0, this.activeConcurrent - 1);
  }

  private async runChatViaBluetooth(
    messages: ChatMessage[],
    maxTokens: number
  ): Promise<string | null> {
    const btProxyUrl = process.env.BT_PROXY_URL ?? "http://127.0.0.1:11435";
    try {
      const res = await request(`${btProxyUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages, maxTokens, stream: false }),
        headersTimeout: 30_000,
        bodyTimeout: 60_000,
      });
      if (res.statusCode < 200 || res.statusCode >= 300) return null;
      const body = (await res.body.json()) as { message?: { content?: string } };
      return body.message?.content ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Status snapshot — used by provider-server for the /status endpoint
  // -------------------------------------------------------------------------

  status(): {
    activeConcurrent: number;
    concurrencyCap: number;
    localLatencyP95Ms: number;
    latencyThresholdMs: number;
    latencySamples: number;
    bluetoothEnabled: boolean;
    swarmEnabled: boolean;
  } {
    return {
      activeConcurrent: this.activeConcurrent,
      concurrencyCap: this.cfg.localConcurrencyCap,
      localLatencyP95Ms: this.latency.p95EstimateMs,
      latencyThresholdMs: this.cfg.localLatencyThresholdMs,
      latencySamples: this.latency.sampleCount,
      bluetoothEnabled: !!this.cfg.bluetoothStatusUrl,
      swarmEnabled: this.swarmEnabled
    };
  }
}
