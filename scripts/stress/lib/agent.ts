// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Simulated agents speaking the real coordinator protocol over HTTP: enrol with the portal using
 * the owner's API key (/nodes/enroll, as `edgecoder-install --enroll` does), register with the
 * coordinator (signed, own Ed25519 key, portal registration token), then heartbeat / pull /
 * result, every request signed with src/security/request-signing.ts (the real implementation).
 *
 * No code is executed. An honest agent returns a deterministic output derived from the subtask
 * input, so two honest executions agree under the verifier's comparator (exit status + stdout,
 * src/swarm/verification.ts) and a wrong output is a real mismatch.
 *
 * Malicious behaviours (one per agent) and what the coordinator should do:
 *   wrong_output      always a wrong answer          -> outvoted by replicas, strikes, blacklist
 *   replay            re-send a captured signed /result verbatim -> 401 (nonce replay)
 *   double_result     a second, freshly signed /result for the same subtask -> refused, no credit
 *   unclaimed_result  a /result for a subtask another agent claimed -> 403/409
 *   oversized         a /result over the 1 MiB agent limit -> 413
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { hashRequestBody, signRequest } from "../../../src/security/request-signing.js";
import { call, sleep, type CallResult } from "./http.js";
import type { Recorder } from "./metrics.js";
import type { AccountCred, CoordinatorTarget } from "./target.js";

export type Behaviour = "honest" | "wrong_output" | "replay" | "double_result" | "unclaimed_result" | "oversized";
export const MALICIOUS_BEHAVIOURS: Behaviour[] = ["wrong_output", "replay", "double_result", "unclaimed_result", "oversized"];

export interface LatencyModel {
  /** Median simulated execution time (ms). */
  medianMs: number;
  /** Log-normal shape; 0 = always the median. */
  sigma: number;
}

export interface AgentConfig {
  runId: string;
  index: number;
  owner: AccountCred;
  coordinator: CoordinatorTarget;
  portalUrl: string;
  behaviour: Behaviour;
  sandboxMode: "docker" | "none";
  /** Models this agent reports (inference subtasks need the requested one). */
  models: string[];
  latency: LatencyModel;
  /** Fraction of honest executions reported as failed (ok: false). */
  failureRate: number;
  heartbeatMs: number;
  idlePollMs: number;
  /** Do not pull (a buyer's submitter identity). */
  pulls: boolean;
}

/** Shared between the agents of one load generator (attacks that need another agent's claim). */
export interface AgentSharedState {
  recentClaims: Array<{ subtaskId: string; taskId: string; agentId: string; atMs: number }>;
  /** subtaskId -> number of plain 200 (credited path, not held) /result answers seen. */
  acceptedResults: Map<string, number>;
}

export function newSharedState(): AgentSharedState {
  return { recentClaims: [], acceptedResults: new Map() };
}

/** The deterministic correct answer for a subtask input. */
export function honestOutput(input: string): string {
  return `stress-ok ${createHash("sha256").update(input).digest("hex").slice(0, 24)}\n`;
}

function lognormalMs(m: LatencyModel, rand: () => number): number {
  if (m.sigma <= 0) return m.medianMs;
  // Box-Muller
  const u = Math.max(1e-9, rand());
  const v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(1, m.medianMs * Math.exp(m.sigma * z));
}

export type AgentState = "new" | "enrolled" | "registered" | "offline" | "blacklisted" | "stopped" | "failed";

export class SimAgent {
  readonly agentId: string;
  private readonly keys = generateKeyPairSync("ed25519");
  private readonly publicKeyPem = this.keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  private readonly privateKeyPem = this.keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  private registrationToken?: string;
  private meshToken?: string;
  state: AgentState = "new";
  private stopping = false;
  private offlineUntilMs = 0;
  /** Set by churn: drop the claimed subtask without reporting (abandon) when going offline. */
  private abandonNext = false;
  private hbTimer?: NodeJS.Timeout;
  private lastSignedResult?: { raw: string; headers: Record<string, string> };
  readonly stats = { claimed: 0, reported: 0, accepted: 0, held: 0, rejected: 0, abandoned: 0, reRegistered: 0, inference: 0 };
  lastError?: string;
  private readonly rand: () => number;

  constructor(readonly cfg: AgentConfig, private readonly rec: Recorder, private readonly shared: AgentSharedState) {
    this.agentId = `stress-${cfg.runId}-${cfg.behaviour === "honest" ? "a" : "m"}${cfg.index}`;
    let seed = (cfg.index + 1) * 2654435761;
    this.rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 1_000_000) / 1_000_000;
    };
  }

  get coordinatorId(): string {
    return this.cfg.coordinator.id;
  }

  get accountId(): string {
    return this.cfg.owner.accountId;
  }

  private url(path: string): string {
    return `${this.cfg.coordinator.url.replace(/\/$/, "")}${path}`;
  }

  private ep(path: string): string {
    return `POST ${path} [${this.cfg.coordinator.id}]`;
  }

  /** Signed POST: x-body-sha256 is the hash of exactly the bytes sent. */
  async signedPost<T = any>(path: string, body: object, opts: { endpoint?: string; timeoutMs?: number; expected?: number[] } = {}): Promise<CallResult<T>> {
    const raw = JSON.stringify(body);
    const headers = signRequest({ method: "POST", path, bodyHash: hashRequestBody(raw), privateKeyPem: this.privateKeyPem, agentId: this.agentId }) as unknown as Record<string, string>;
    if (this.meshToken) headers["x-mesh-token"] = this.meshToken;
    if (path === "/result") this.lastSignedResult = { raw, headers: { ...headers } };
    return call<T>(this.rec, opts.endpoint ?? this.ep(path), this.url(path), { body: raw, headers, timeoutMs: opts.timeoutMs, expected: opts.expected });
  }

  /** GET with the mesh token (what an agent holds after /register). */
  async meshGet<T = any>(path: string, endpoint: string, expected?: number[]): Promise<CallResult<T>> {
    return call<T>(this.rec, endpoint, this.url(path), { headers: this.meshToken ? { "x-mesh-token": this.meshToken } : {}, expected });
  }

  async enroll(): Promise<boolean> {
    const r = await call(this.rec, "POST /nodes/enroll [portal]", `${this.cfg.portalUrl.replace(/\/$/, "")}/nodes/enroll`, {
      body: { nodeId: this.agentId, nodeKind: "agent" },
      headers: { authorization: `Bearer ${this.cfg.owner.apiKey}` }
    });
    if (r.status !== 200 || !r.json?.registrationToken) {
      this.lastError = `enroll ${r.outcome}`;
      this.state = "failed";
      return false;
    }
    if (r.json.active === false) this.rec.count("enroll.inactive");
    this.registrationToken = r.json.registrationToken;
    this.state = "enrolled";
    return true;
  }

  async register(withToken = true): Promise<boolean> {
    const body = {
      agentId: this.agentId,
      os: "linux",
      version: "stress-0.1.0",
      mode: "swarm-only",
      ...(withToken ? { registrationToken: this.registrationToken } : {}),
      localModelProvider: "ollama-local",
      clientType: "edgecoder-stress-sim",
      maxConcurrentTasks: 1,
      sandboxMode: this.cfg.sandboxMode,
      publicKeyPem: this.publicKeyPem,
      ...(this.cfg.models.length ? { installedModels: this.cfg.models, activeModel: this.cfg.models[0] } : {}),
      powerTelemetry: { onACPower: true, deviceType: "server" }
    };
    const r = await this.signedPost("/register", body);
    if (r.status !== 200 || !r.json?.accepted) {
      this.lastError = `register ${r.outcome}`;
      if (r.json?.error === "agent_blacklisted") this.state = "blacklisted";
      return false;
    }
    if (r.json.meshToken) this.meshToken = r.json.meshToken;
    this.state = "registered";
    return true;
  }

  private async heartbeat(): Promise<void> {
    if (this.state !== "registered" || Date.now() < this.offlineUntilMs) return;
    const r = await this.signedPost("/heartbeat", { agentId: this.agentId, powerTelemetry: { onACPower: true, deviceType: "server" } });
    if (r.json?.blacklisted) {
      this.state = "blacklisted";
      this.rec.count(`agent.blacklisted.${this.cfg.behaviour}`);
    } else if (r.status === 401) {
      await this.recover(r);
    }
  }

  /** After a coordinator restart the agent is unknown there: register again (with the token). */
  private async recover(r: CallResult): Promise<void> {
    const reason = r.json?.reason ?? r.json?.error;
    if (reason === "agent_not_registered" || reason === "signature_invalid" || reason === "agent_signature_required") {
      this.stats.reRegistered++;
      this.rec.count("agent.reregister");
      await this.register(true);
    }
  }

  startHeartbeats(): void {
    const jitter = Math.floor(this.rand() * this.cfg.heartbeatMs);
    this.hbTimer = setTimeout(() => {
      void this.heartbeat().catch(() => undefined);
      this.hbTimer = setInterval(() => void this.heartbeat().catch(() => undefined), this.cfg.heartbeatMs);
    }, jitter);
  }

  /** Churn: go dark for `ms` (no heartbeats, no pulls); abandon the subtask in hand if asked. */
  goOffline(ms: number, abandonInFlight: boolean): void {
    this.offlineUntilMs = Date.now() + ms;
    this.abandonNext = abandonInFlight;
    this.rec.count("agent.churn.offline");
  }

  stop(): void {
    this.stopping = true;
    if (this.hbTimer) {
      clearTimeout(this.hbTimer);
      clearInterval(this.hbTimer);
    }
    if (this.state !== "blacklisted") this.state = "stopped";
  }

  async start(): Promise<boolean> {
    if (!(await this.enroll())) return false;
    if (!(await this.register(true))) {
      this.state = this.state === "blacklisted" ? "blacklisted" : "failed";
      return false;
    }
    this.startHeartbeats();
    return true;
  }

  /** Pull loop until stop(). */
  async loop(): Promise<void> {
    if (!this.cfg.pulls) return;
    let wasOffline = false;
    while (!this.stopping && this.state !== "blacklisted") {
      if (Date.now() < this.offlineUntilMs) {
        wasOffline = true;
        await sleep(Math.min(1_000, this.offlineUntilMs - Date.now()));
        continue;
      }
      if (wasOffline) {
        wasOffline = false;
        // Reconnect: prove the key we registered (signed /register without a token), as a worker does.
        if (!(await this.register(false))) await this.register(true);
        this.rec.count("agent.churn.reconnect");
      }
      const r = await this.signedPost("/pull", { agentId: this.agentId });
      if (r.status === 401) {
        await this.recover(r);
        await sleep(this.cfg.idlePollMs);
        continue;
      }
      if (r.status !== 200) {
        await sleep(this.cfg.idlePollMs * 2);
        continue;
      }
      if (r.json?.blocked) {
        this.state = "blacklisted";
        this.rec.count(`agent.blacklisted.${this.cfg.behaviour}`);
        break;
      }
      const st = r.json?.subtask;
      if (!st) {
        await sleep(this.cfg.idlePollMs * (0.5 + this.rand()));
        continue;
      }
      await this.execute(st);
    }
  }

  private async execute(st: { id: string; taskId: string; kind: string; input: string; requestedModel?: string }): Promise<void> {
    this.stats.claimed++;
    this.rec.count(`claim.${st.kind}`);
    this.shared.recentClaims.push({ subtaskId: st.id, taskId: st.taskId, agentId: this.agentId, atMs: Date.now() });
    if (this.shared.recentClaims.length > 500) this.shared.recentClaims.splice(0, 250);
    const startedAt = Date.now();
    await sleep(lognormalMs(this.cfg.latency, this.rand));
    if (this.abandonNext && Date.now() < this.offlineUntilMs) {
      // Went offline mid-task: the claim is left to expire (lease requeue, #51).
      this.abandonNext = false;
      this.stats.abandoned++;
      this.rec.count("agent.churn.abandoned");
      return;
    }
    const failed = this.cfg.behaviour === "honest" && this.rand() < this.cfg.failureRate;
    let output = failed ? "" : honestOutput(st.input);
    if (this.cfg.behaviour === "wrong_output") output = `stress-bad ${randomUUID()}\n`;
    if (this.cfg.behaviour === "oversized") output = "x".repeat(1_100_000);
    if (st.kind === "inference") {
      this.stats.inference++;
      const text = `simulated reply ${createHash("sha256").update(st.input).digest("hex").slice(0, 12)}`;
      await this.signedPost("/inference/chunks", { subtaskId: st.id, seq: 0, delta: text, done: true, promptTokens: Math.ceil(st.input.length / 4), outputTokens: 8 });
      output = text;
    }
    const body = {
      subtaskId: st.id,
      taskId: st.taskId,
      agentId: this.agentId,
      ok: !failed,
      output,
      ...(failed ? { error: "simulated_failure" } : {}),
      durationMs: Date.now() - startedAt,
      ...(st.requestedModel ? { model: st.requestedModel } : {})
    };
    this.stats.reported++;
    const r = await this.signedPost("/result", body, this.cfg.behaviour === "oversized" ? { endpoint: `${this.ep("/result")} oversized`, expected: [413] } : this.cfg.behaviour === "wrong_output" ? { endpoint: `${this.ep("/result")} wrong-output`, expected: [403] } : {});
    this.noteResult(st.id, r, "result");
    if (this.cfg.behaviour === "oversized") this.rec.count(`attack.oversized.${r.outcome}`);
    if (this.cfg.behaviour === "replay" && this.lastSignedResult) {
      // The exact signed request again: same nonce, timestamp and body.
      const again = await call(this.rec, `${this.ep("/result")} replay`, this.url("/result"), { body: this.lastSignedResult.raw, headers: this.lastSignedResult.headers, expected: [401, 403, 409] });
      this.rec.count(`attack.replay.${again.outcome}`);
      this.noteResult(st.id, again, "replay");
    }
    if (this.cfg.behaviour === "double_result") {
      const again = await this.signedPost("/result", { ...body, durationMs: body.durationMs + 1 }, { endpoint: `${this.ep("/result")} double`, expected: [401, 403, 409] });
      this.rec.count(`attack.double_result.${again.outcome}`);
      this.noteResult(st.id, again, "double");
    }
    if (this.cfg.behaviour === "unclaimed_result") {
      const victim = [...this.shared.recentClaims].reverse().find((c) => c.agentId !== this.agentId);
      if (victim) {
        const forged = await this.signedPost(
          "/result",
          { subtaskId: victim.subtaskId, taskId: victim.taskId, agentId: this.agentId, ok: true, output: `stress-bad ${randomUUID()}\n`, durationMs: 1000 },
          { endpoint: `${this.ep("/result")} unclaimed`, expected: [401, 403, 409] }
        );
        this.rec.count(`attack.unclaimed_result.${forged.outcome}`);
        this.noteResult(victim.subtaskId, forged, "unclaimed");
      }
    }
  }

  private noteResult(subtaskId: string, r: CallResult, kind: string): void {
    if (r.status === 200 && r.json?.ok) {
      if (r.json.held) this.stats.held++;
      else {
        this.stats.accepted++;
        this.shared.acceptedResults.set(subtaskId, (this.shared.acceptedResults.get(subtaskId) ?? 0) + 1);
      }
      if (kind !== "result") {
        this.rec.addEvidence({
          endpoint: `POST /result ${kind}`,
          outcome: "accepted",
          note: `attack "${kind}" by ${this.agentId} on subtask ${subtaskId} was answered 200 ${JSON.stringify(r.json)}`
        });
        this.rec.count(`attack.${kind}.accepted`);
      }
    } else {
      this.stats.rejected++;
    }
  }
}
