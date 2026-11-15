// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Run context shared by the scenarios: the target, the recorder, spawned agents and buyers, the
 * open-loop task driver, chaos hooks (local only) and the findings list.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { MALICIOUS_BEHAVIOURS, SimAgent, newSharedState, type AgentSharedState, type Behaviour, type LatencyModel } from "./agent.js";
import { SimBuyer, type TaskOutcome } from "./buyer.js";
import { call, sleep } from "./http.js";
import { LndClient } from "./lnd.js";
import { Recorder, percentile } from "./metrics.js";
import { buyers as buyerCreds, providers as providerCreds, type LoadedTarget } from "./target.js";

const execFileP = promisify(execFile);

export interface Scale {
  agents: number;
  buyers: number;
  durationSec: number;
  /** Code tasks per second offered (open loop). */
  rate: number;
  /** Share of offered work that is inference (rest: code tasks). */
  inferenceShare: number;
  maliciousFraction: number;
  failureRate: number;
  latency: LatencyModel;
  /** Share of agents without a sandbox (inference-only). */
  noSandboxShare: number;
  topupSats: number;
  heartbeatMs: number;
  idlePollMs: number;
}

export function scaleFromEnv(env: NodeJS.ProcessEnv, defaults: Partial<Scale> = {}): Scale {
  const num = (k: string, d: number) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  return {
    agents: num("STRESS_AGENTS", defaults.agents ?? 20),
    buyers: num("STRESS_BUYERS", defaults.buyers ?? 3),
    durationSec: num("STRESS_DURATION_SEC", defaults.durationSec ?? 120),
    rate: num("STRESS_RATE", defaults.rate ?? 1),
    inferenceShare: num("STRESS_INFERENCE_SHARE", defaults.inferenceShare ?? 0.2),
    maliciousFraction: num("STRESS_MALICIOUS_FRACTION", defaults.maliciousFraction ?? 0),
    failureRate: num("STRESS_FAILURE_RATE", defaults.failureRate ?? 0.02),
    latency: { medianMs: num("STRESS_LATENCY_MS", defaults.latency?.medianMs ?? 1_500), sigma: num("STRESS_LATENCY_SIGMA", defaults.latency?.sigma ?? 0.5) },
    noSandboxShare: num("STRESS_NO_SANDBOX_SHARE", defaults.noSandboxShare ?? 0.2),
    topupSats: num("STRESS_TOPUP_SATS", defaults.topupSats ?? 20_000),
    heartbeatMs: num("STRESS_HEARTBEAT_MS", defaults.heartbeatMs ?? 10_000),
    idlePollMs: num("STRESS_IDLE_POLL_MS", defaults.idlePollMs ?? 1_500)
  };
}

export interface Finding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  evidence?: unknown;
  reproduction?: string;
}

export interface Phase {
  name: string;
  startMs: number;
  endMs?: number;
  meta?: Record<string, unknown>;
}

export class RunContext {
  readonly rec = new Recorder();
  readonly shared: AgentSharedState = newSharedState();
  readonly agents: SimAgent[] = [];
  readonly buyers: SimBuyer[] = [];
  readonly findings: Finding[] = [];
  readonly phases: Phase[] = [];
  readonly notes: string[] = [];
  readonly extra: Record<string, unknown> = {};
  readonly payee?: LndClient;
  readonly hub?: LndClient;
  private agentLoops: Promise<void>[] = [];
  private agentIndex = 0;
  private buyerIndex = 0;
  private taskWaits: Promise<void>[] = [];
  readonly startedAtMs = Date.now();

  constructor(readonly t: LoadedTarget, readonly runId: string, readonly scale: Scale, readonly scenario: string) {
    const sn = t.profile.lndServername;
    if (t.creds.lnd?.payee) this.payee = new LndClient(t.creds.lnd.payee, this.rec, sn, "lnd-payee");
    if (t.profile.kind === "local" && t.creds.lnd?.hub) this.hub = new LndClient(t.creds.lnd.hub, null, sn, "lnd-hub");
  }

  log(msg: string): void {
    const s = ((Date.now() - this.startedAtMs) / 1000).toFixed(1).padStart(6);
    process.stderr.write(`[${s}s ${this.scenario}] ${msg}\n`);
  }

  finding(f: Finding): void {
    this.findings.push(f);
    this.log(`FINDING (${f.severity}) ${f.title}`);
  }

  phase(name: string, meta?: Record<string, unknown>): Phase {
    const prev = this.phases[this.phases.length - 1];
    if (prev && prev.endMs === undefined) prev.endMs = Date.now();
    const p = { name, startMs: Date.now(), meta };
    this.phases.push(p);
    this.log(`phase: ${name}`);
    return p;
  }

  endPhase(): void {
    const prev = this.phases[this.phases.length - 1];
    if (prev && prev.endMs === undefined) prev.endMs = Date.now();
  }

  get meshToken(): string | undefined {
    for (const a of this.agents) {
      const tok = (a as unknown as { meshToken?: string }).meshToken;
      if (tok) return tok;
    }
    return undefined;
  }

  /**
   * Start `n` agents (spread over coordinators and provider accounts). Malicious agents get the
   * last provider account to themselves when there is more than one, so per-account reputation
   * of honest providers is not dragged down by them.
   */
  async spawnAgents(n: number, opts: { maliciousFraction?: number; behaviours?: Behaviour[]; models?: string[]; latency?: LatencyModel; coordinators?: string[]; hardwareProfile?: Record<string, unknown> } = {}): Promise<SimAgent[]> {
    const provs = providerCreds(this.t);
    if (!provs.length) throw new Error("no provider accounts in the credentials");
    const coords = this.t.profile.coordinators.filter((c) => !opts.coordinators || opts.coordinators.includes(c.id));
    const total = this.agents.filter((a) => a.cfg.pulls).length + n;
    if (total > this.t.profile.limits.maxAgents) throw new Error(`target ${this.t.profile.name} allows at most ${this.t.profile.limits.maxAgents} agents`);
    const malFrac = opts.maliciousFraction ?? this.scale.maliciousFraction;
    const nMal = Math.round(n * malFrac);
    const behaviours = opts.behaviours ?? MALICIOUS_BEHAVIOURS;
    const honestProvs = provs.length > 1 && nMal > 0 ? provs.slice(0, -1) : provs;
    const malProv = provs[provs.length - 1];
    const created: SimAgent[] = [];
    for (let i = 0; i < n; i++) {
      const idx = this.agentIndex++;
      const malicious = i < nMal;
      const behaviour: Behaviour = malicious ? behaviours[i % behaviours.length] : "honest";
      // Spread inference-only agents evenly over the fleet (and so over both coordinators).
      const noSandbox = !malicious && ((idx * 37 + 11) % 100) / 100 < this.scale.noSandboxShare;
      const a = new SimAgent(
        {
          runId: this.runId,
          index: idx,
          owner: malicious ? malProv : honestProvs[idx % honestProvs.length],
          coordinator: coords[idx % coords.length],
          portalUrl: this.t.profile.portalUrl,
          behaviour,
          sandboxMode: noSandbox ? "none" : "docker",
          models: opts.models ?? [this.t.profile.inferenceModel],
          latency: opts.latency ?? this.scale.latency,
          failureRate: this.scale.failureRate,
          heartbeatMs: this.scale.heartbeatMs,
          idlePollMs: this.scale.idlePollMs,
          pulls: true,
          ...(opts.hardwareProfile ? { hardwareProfile: opts.hardwareProfile } : {})
        },
        this.rec,
        this.shared
      );
      created.push(a);
    }
    // Enrol/register in small batches: a real fleet does not arrive in the same millisecond.
    for (let i = 0; i < created.length; i += 10) {
      await Promise.all(created.slice(i, i + 10).map((a) => a.start()));
    }
    for (const a of created) {
      this.agents.push(a);
      if (a.state === "registered") this.agentLoops.push(a.loop().catch((e) => this.log(`agent ${a.agentId} loop: ${e}`)));
    }
    const failed = created.filter((a) => a.state !== "registered");
    if (failed.length) {
      const reasons: Record<string, number> = {};
      for (const a of failed) reasons[a.lastError ?? a.state] = (reasons[a.lastError ?? a.state] ?? 0) + 1;
      this.log(`${failed.length}/${created.length} agents did not register: ${JSON.stringify(reasons)}`);
      this.rec.count("agents.start_failed", failed.length);
      this.extra.agentStartFailures = reasons;
    }
    this.log(`${created.length - failed.length} agents running (${nMal} malicious)`);
    return created;
  }

  spawnBuyers(n: number): SimBuyer[] {
    const creds = buyerCreds(this.t);
    if (!creds.length) throw new Error("no buyer accounts in the credentials");
    if (this.buyers.length + n > this.t.profile.limits.maxBuyers) throw new Error(`target ${this.t.profile.name} allows at most ${this.t.profile.limits.maxBuyers} buyers`);
    const out: SimBuyer[] = [];
    for (let i = 0; i < n; i++) {
      const idx = this.buyerIndex++;
      // Several simulated buyers may share one account (the credentials file has a few).
      const b = new SimBuyer(creds[idx % creds.length], this.t.profile.portalUrl, this.t.profile.coordinators, this.rec, this.runId, idx, this.shared);
      out.push(b);
      this.buyers.push(b);
    }
    return out;
  }

  /** Top up each distinct buyer account to at least `minCSats`, paying from the payee node. */
  async fundBuyers(minCSats: number, sats = this.scale.topupSats): Promise<void> {
    if (!this.payee) {
      this.notes.push("no payee LND credentials: buyers were not topped up");
      return;
    }
    const seen = new Set<string>();
    const amount = Math.min(sats, this.t.profile.limits.maxTopupSats);
    await Promise.all(
      this.buyers
        .filter((b) => !seen.has(b.account.accountId) && seen.add(b.account.accountId))
        .map(async (b) => {
          const bal = (await b.balance()) ?? 0;
          if (bal >= minCSats) return;
          const ok = await b.topup(amount, this.payee!);
          this.rec.count(ok ? "topup.settled" : "topup.failed");
        })
    );
  }

  private pickBuyer(i: number): SimBuyer {
    return this.buyers[i % this.buyers.length];
  }

  /**
   * Open-loop driver: offer `rate` units/s for `durationSec`, spread over buyers and coordinators.
   * A unit is a code task (submit + await) or, with probability inferenceShare, an inference call.
   * Returns the tasks offered in this window.
   */
  async drive(rate: number, durationSec: number, opts: { inferenceShare?: number; taskTimeoutMs?: number; maxInFlight?: number; label?: string; extraTask?: Record<string, unknown> } = {}): Promise<{ offered: number; tasks: TaskOutcome[]; inference: Array<{ outcome: string; ms: number }> }> {
    const tasks: TaskOutcome[] = [];
    const inference: Array<{ outcome: string; ms: number }> = [];
    if (rate <= 0) {
      await sleep(durationSec * 1000);
      return { offered: 0, tasks, inference };
    }
    const share = opts.inferenceShare ?? this.scale.inferenceShare;
    const maxInFlight = opts.maxInFlight ?? 2_000;
    const coords = this.t.profile.coordinators;
    const end = Date.now() + durationSec * 1000;
    let i = 0;
    let inFlight = 0;
    const interval = 1000 / rate;
    let next = Date.now();
    while (Date.now() < end) {
      if (inFlight >= maxInFlight) {
        this.rec.count("driver.backpressure_skip");
        await sleep(interval);
        next += interval;
        continue;
      }
      const n = i++;
      const b = this.pickBuyer(n);
      inFlight++;
      if (Math.random() < share) {
        void b
          .inference(this.t.profile.inferenceModel, `stress ${this.runId} ${n} ${Math.random()}`)
          .then((r) => inference.push({ outcome: r.outcome, ms: r.ms }))
          .finally(() => inFlight--);
      } else {
        const c = coords[n % coords.length];
        const wait = b
          .submitTask(c, `print("stress ${this.runId} ${n} ${Math.random()}")`, opts.extraTask)
          .then(async (t) => {
            tasks.push(t);
            if (t.status === "submitted") await b.awaitTask(t, Date.now() + (opts.taskTimeoutMs ?? 120_000));
          })
          .finally(() => inFlight--);
        this.taskWaits.push(wait);
      }
      next += interval;
      const delay = next - Date.now();
      if (delay > 0) await sleep(delay);
    }
    return { offered: i, tasks, inference };
  }

  /** Wait for every task the driver submitted to finish or time out. */
  async drain(): Promise<void> {
    await Promise.allSettled(this.taskWaits);
  }

  taskSummary(tasks?: TaskOutcome[]) {
    const all = tasks ?? this.buyers.flatMap((b) => b.tasks);
    const by: Record<string, number> = {};
    const rejected: Record<string, number> = {};
    for (const t of all) {
      by[t.status] = (by[t.status] ?? 0) + 1;
      if (t.status === "rejected") rejected[t.submitOutcome] = (rejected[t.submitOutcome] ?? 0) + 1;
    }
    const e2e = all.filter((t) => t.completedAtMs).map((t) => t.completedAtMs! - t.submittedAtMs).sort((a, b) => a - b);
    return { total: all.length, byStatus: by, rejectedBy: rejected, e2eP50Ms: percentile(e2e, 50), e2eP95Ms: percentile(e2e, 95), e2eP99Ms: percentile(e2e, 99) };
  }

  /** Sample coordinator gauges (metrics token or health) into the recorder's series. */
  async sampleGauges(): Promise<void> {
    const tok = this.t.creds.tokens?.metrics;
    for (const c of this.t.profile.coordinators) {
      if (tok) {
        const m = await call(null, "metrics", `${c.url}/metrics`, { headers: { authorization: `Bearer ${tok}` } });
        if (m.status === 200) {
          const get = (name: string) => {
            const line = m.text.split("\n").find((l) => l.startsWith(name + " ") || l.startsWith(name + "{"));
            return line ? Number(line.trim().split(/\s+/).pop()) : NaN;
          };
          this.rec.gauge(`${c.id}.rss_mb`, Math.round(get("process_resident_memory_bytes") / 1e6));
          this.rec.gauge(`${c.id}.eventloop_lag_ms`, Math.round(get("nodejs_eventloop_lag_seconds") * 1000));
          this.rec.gauge(`${c.id}.queue_depth`, get("edgecoder_queue_depth"));
          this.rec.gauge(`${c.id}.connected_agents`, get("edgecoder_connected_agents"));
          continue;
        }
      }
      const h = await call(null, "health", `${c.url}/health/runtime`);
      if (h.status === 200) this.rec.gauge(`${c.id}.queue_depth`, Number(h.json?.coordinator?.queued ?? NaN));
      else this.rec.gauge(`${c.id}.up`, 0);
    }
  }

  startGaugeSampler(everyMs = 10_000): () => void {
    const timer = setInterval(() => void this.sampleGauges().catch(() => undefined), everyMs);
    void this.sampleGauges().catch(() => undefined);
    return () => clearInterval(timer);
  }

  // ── chaos (local targets only) ──
  requireDocker(): void {
    if (!this.t.profile.allowDocker) throw new Error(`target ${this.t.profile.name} does not allow docker control`);
  }

  async docker(...args: string[]): Promise<string> {
    this.requireDocker();
    const name = args[args.length - 1];
    if (!name.startsWith("ec-stress-")) throw new Error(`refusing to touch container ${name}`);
    const { stdout } = await execFileP("docker", args);
    return stdout.trim();
  }

  pgPool(): pg.Pool {
    if (!this.t.profile.allowDatabase || !this.t.creds.postgresUrl) throw new Error(`target ${this.t.profile.name} does not allow database access`);
    return new pg.Pool({ connectionString: this.t.creds.postgresUrl, max: 3 });
  }

  async stopAll(): Promise<void> {
    for (const a of this.agents) a.stop();
    for (const b of this.buyers) b.stop();
    await Promise.race([Promise.allSettled(this.agentLoops), sleep(15_000)]);
  }
}
