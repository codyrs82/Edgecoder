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
import { OllamaLocalProvider, EdgeCoderLocalProvider } from "./providers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** Agent account ID used for credit billing on swarm submissions. */
  agentAccountId: string;
  /** Bluetooth transport status endpoint (localhost). Default: disabled */
  bluetoothStatusUrl?: string;
  /** Language for swarm task submission. Default: "python" */
  swarmLanguage?: "python" | "javascript";
}

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
    if (this.cfg.meshAuthToken) {
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
    prompt: string
  ): Promise<Omit<RouterResult, "route" | "latencyMs">> {
    const coordinatorUrl = this.cfg.coordinatorUrl.replace(/\/$/, "");
    const headers = {
      "content-type": "application/json",
      "x-mesh-token": this.cfg.meshAuthToken
    };

    // Submit task
    const submitRes = await request(`${coordinatorUrl}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        taskId: `ide-${Date.now()}`,
        prompt,
        language: this.cfg.swarmLanguage ?? "python",
        submitterAccountId: this.cfg.agentAccountId,
        projectId: "ide-requests",
        resourceClass: "cpu",
        priority: 60,
        subtasks: [{ prompt, language: this.cfg.swarmLanguage ?? "python" }]
      }),
      headersTimeout: 15_000,
      bodyTimeout: 15_000
    });

    if (submitRes.statusCode < 200 || submitRes.statusCode >= 300) {
      const errBody = await submitRes.body.text();
      throw new Error(`Swarm submit failed (${submitRes.statusCode}): ${errBody}`);
    }

    const submitBody = (await submitRes.body.json()) as {
      taskId: string;
      subtasks: string[];
    };
    const taskId = submitBody.taskId;
    const subtaskId = submitBody.subtasks?.[0];

    if (!subtaskId) throw new Error("Swarm: no subtaskId returned");

    // Poll for result — up to 90s
    const pollUrl = `${coordinatorUrl}/tasks/${taskId}/subtasks/${subtaskId}/result`;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const pollRes = await request(pollUrl, { method: "GET", headers });
        if (pollRes.statusCode === 200) {
          const result = (await pollRes.body.json()) as {
            output?: string;
            ok?: boolean;
            creditsSpent?: number;
          };
          if (result.output !== undefined) {
            return {
              text: result.output,
              creditsSpent: result.creditsSpent,
              swarmTaskId: taskId
            };
          }
        }
      } catch {
        // continue polling
      }
    }

    throw new Error("Swarm task timed out after 90s");
  }

  // -------------------------------------------------------------------------
  // Status snapshot — used by provider-server for the /status endpoint
  // -------------------------------------------------------------------------

  status(): object {
    return {
      activeConcurrent: this.activeConcurrent,
      concurrencyCap: this.cfg.localConcurrencyCap,
      localLatencyP95Ms: this.latency.p95EstimateMs,
      latencyThresholdMs: this.cfg.localLatencyThresholdMs,
      latencySamples: this.latency.sampleCount,
      bluetoothEnabled: !!this.cfg.bluetoothStatusUrl,
      swarmEnabled: !!this.cfg.meshAuthToken
    };
  }
}
