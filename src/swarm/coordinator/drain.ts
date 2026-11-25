// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Graceful stop for a deploy or restart (SIGTERM / SIGINT). The coordinator keeps its live state
 * in memory (connected agents, relay snapshots, sockets), so a hard stop used to cut running jobs
 * and leave every agent looking offline until it noticed. Now it drains:
 *
 *  0. Tells every connected agent at once with a signed drain notice (coordinator-reconnect.ts): an
 *     agent with that support registers with a peer coordinator for new work right away, finishes
 *     the claims it holds here (their leases, chunks and results still come here), and returns once
 *     the restarted instance answers (src/mesh/drain-failover.ts). Calls nobody has claimed are
 *     handed back at once (refunded, the requester told to use the peer), not after the wait.
 *  1. Stops taking new work. New jobs (/submit, /inference/submit, /portal/chat, /escalate) get a
 *     retryable 503 `coordinator_draining` (with a peer coordinator's URL when one is known, and
 *     nothing charged); /pull answers "no work, draining"; /register is refused so an agent
 *     registers with the instance that replaces this one. /health/runtime says 503 so the
 *     portal and probes stop choosing this instance.
 *  2. Lets claimed subtasks (model calls included), results being paid and open requests finish,
 *     for up to COORDINATOR_DRAIN_MS (default 25 s), then settles the billing of tasks that are done.
 *  3. Sends every connected agent a signed reconnect frame (src/mesh/coordinator-reconnect.ts):
 *     the agent waits a short jittered delay, registers again, then reopens its mesh WebSocket.
 *  4. Closes the sockets and the server, and exits.
 *
 * Work still running when the time is up is not lost: claims and billing are in Postgres and the
 * next instance restores them (billing-restore.ts); the agent's result reaches whichever instance
 * answers. Everything the drain touches is passed in, so it is tested without a coordinator.
 */

export const DEFAULT_COORDINATOR_DRAIN_MS = 25_000;
/** What a refused caller is told to wait before trying again (Retry-After). */
export const DRAIN_RETRY_AFTER_MS = 3_000;
/** Agents come back after this, plus up to RECONNECT_JITTER_MS, so they do not all arrive at once. */
export const RECONNECT_DELAY_MS = 2_000;
export const RECONNECT_JITTER_MS = 8_000;

/** New work: refused while draining (retryable, nothing charged). */
const NEW_WORK_ROUTES = new Set(["/submit", "/inference/submit", "/portal/chat", "/escalate", "/robot/tasks"]);
/** Long polls a requester repeats on its own: not waited for (the claims behind them are). */
const NOT_WAITED_FOR = new Set(["/inference/stream", "/mesh/ws"]);

export interface DrainGateAnswer {
  status: number;
  body: Record<string, unknown>;
  retryAfterSec: number;
}

export interface DrainSocket {
  peerId: string;
  /** A registered agent on a signed bind (a peer coordinator's socket gets no frame, only the close). */
  agent: boolean;
  send(frame: string): void;
  close(code: number, reason: string): void;
}

export interface DrainRunDeps {
  drainMs: number;
  /** What is still running here. */
  busy(): { claims: number; accruals: number };
  /** Settle the billing of tasks with nothing left open (refund what was set aside but not used). */
  settle(): Promise<number>;
  sockets(): DrainSocket[];
  /** The signed reconnect frame for one agent. */
  frameFor(agentId: string): string;
  /** The signed drain notice for one agent, sent as the drain starts (omit: none is sent). */
  noticeFor?(agentId: string): string;
  /**
   * Runs as the drain starts, before the wait: hand back calls nobody has claimed (they can never
   * be claimed here now), so their requesters go to a peer at once rather than after the wait.
   */
  onStart?(): Promise<number>;
  /** Close the HTTP server (bounded by the caller). */
  close(): Promise<void>;
  exit(code: number): void;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  /** Time for the frames to leave before the sockets close. */
  flushMs?: number;
  closeWaitMs?: number;
}

export interface DrainReport {
  idle: boolean;
  /** Drain notices sent as the drain started. */
  noticeSent: number;
  /** Unclaimed calls handed back as the drain started. */
  handedBack: number;
  waitedMs: number;
  settled: number;
  reconnectSent: number;
  socketsClosed: number;
}

/** 1012 "service restart": the standard close code for a server going down to come back. */
export const RESTART_CLOSE_CODE = 1012;

export class CoordinatorDrain {
  private drainingSinceMs: number | null = null;
  private open = 0;
  private running: Promise<DrainReport> | null = null;
  /** A peer coordinator a refused caller can go to now (null: none known; it retries here after the delay). */
  peerUrl: () => string | null = () => null;

  get draining(): boolean {
    return this.drainingSinceMs !== null;
  }

  get openRequests(): number {
    return this.open;
  }

  /** The answer to a request while draining, or null to serve it as usual. */
  gate(method: string, url: string): DrainGateAnswer | null {
    if (!this.draining) return null;
    const path = url.split("?")[0];
    const retryAfterSec = Math.ceil(DRAIN_RETRY_AFTER_MS / 1000);
    // The portal's capacity probe: a draining coordinator is not a place to send calls (it skips an
    // answer it cannot use within its 2 s report age, so calls go to a peer within seconds).
    if (method === "GET" && path === "/inference/models") {
      const peer = this.peerUrl();
      return { status: 503, body: { error: "coordinator_draining", retryable: true, retryAfterMs: DRAIN_RETRY_AFTER_MS, ...(peer ? { coordinatorUrl: peer } : {}) }, retryAfterSec };
    }
    if (method === "POST" && path === "/pull") {
      // Names a peer, so an agent can serve through it while this instance restarts (drain-failover.ts).
      const peer = this.peerUrl();
      return { status: 200, body: { subtask: null, draining: true, retryAfterMs: DRAIN_RETRY_AFTER_MS, ...(peer ? { coordinatorUrl: peer } : {}) }, retryAfterSec };
    }
    if (method === "POST" && (NEW_WORK_ROUTES.has(path) || path === "/register")) {
      const peer = path === "/register" ? null : this.peerUrl();
      return {
        status: 503,
        body: { error: "coordinator_draining", retryable: true, retryAfterMs: DRAIN_RETRY_AFTER_MS, charged: false, ...(peer ? { coordinatorUrl: peer } : {}) },
        retryAfterSec
      };
    }
    return null;
  }

  /** Counts a request that the drain waits for; returns its end (call once). */
  track(method: string, url: string): (() => void) | null {
    const path = url.split("?")[0];
    if (method === "GET" && path === "/health/runtime") return null;
    if (NOT_WAITED_FOR.has(path)) return null;
    this.open++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.open = Math.max(0, this.open - 1);
    };
  }

  /** Start draining (idempotent: a second signal joins the first). */
  run(deps: DrainRunDeps): Promise<DrainReport> {
    if (this.running) return this.running;
    const now = deps.now ?? Date.now;
    this.drainingSinceMs = now();
    this.running = this.drain(deps);
    return this.running;
  }

  private async drain(d: DrainRunDeps): Promise<DrainReport> {
    const now = d.now ?? Date.now;
    const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const started = now();
    const deadline = started + Math.max(0, d.drainMs);
    const pollMs = d.pollMs ?? 250;
    const busyNow = () => {
      const b = d.busy();
      return { ...b, openRequests: this.open };
    };
    d.log.warn({ drainMs: d.drainMs, ...busyNow() }, "coordinator_draining");
    // Tell the agents now: they serve through a peer while this instance finishes and restarts.
    let noticeSent = 0;
    if (d.noticeFor) {
      for (const s of d.sockets()) {
        if (!s.agent) continue;
        try {
          s.send(d.noticeFor(s.peerId));
          noticeSent++;
        } catch {
          // closed under us
        }
      }
    }
    let handedBack = 0;
    if (d.onStart) {
      try {
        handedBack = await d.onStart();
      } catch (err) {
        d.log.warn({ err: String(err) }, "coordinator_drain_start_failed");
      }
    }
    if (noticeSent > 0 || handedBack > 0) d.log.warn({ noticeSent, handedBack }, "coordinator_drain_started");
    let idle = false;
    for (;;) {
      const b = busyNow();
      if (b.claims === 0 && b.accruals === 0 && b.openRequests === 0) {
        idle = true;
        break;
      }
      if (now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    }
    let settled = 0;
    try {
      settled = await d.settle();
    } catch (err) {
      d.log.warn({ err: String(err) }, "coordinator_drain_settle_failed");
    }
    const sockets = d.sockets();
    let reconnectSent = 0;
    for (const s of sockets) {
      if (!s.agent) continue;
      try {
        s.send(d.frameFor(s.peerId));
        reconnectSent++;
      } catch {
        // closed under us: the agent reconnects on its own
      }
    }
    if (reconnectSent > 0) await sleep(d.flushMs ?? 300);
    let socketsClosed = 0;
    for (const s of sockets) {
      try {
        s.close(RESTART_CLOSE_CODE, "coordinator_restart");
        socketsClosed++;
      } catch {
        /* already closed */
      }
    }
    const report: DrainReport = { idle, noticeSent, handedBack, waitedMs: now() - started, settled, reconnectSent, socketsClosed };
    d.log.warn({ ...report, left: busyNow() }, "coordinator_drained");
    await Promise.race([d.close().catch(() => undefined), sleep(d.closeWaitMs ?? 3_000)]);
    d.exit(0);
    return report;
  }
}

/** The coordinator's one drain (the gate hook, /health/runtime and the signal handlers share it). */
export const coordinatorDrain = new CoordinatorDrain();

interface HookApp {
  addHook(name: "onRequest", fn: (req: { method: string; url: string }, reply: DrainReply) => Promise<unknown>): unknown;
  addHook(name: "onResponse", fn: (req: { method: string; url: string }, reply: unknown) => Promise<unknown>): unknown;
  addHook(name: "onRequestAbort", fn: (req: { method: string; url: string }) => Promise<unknown>): unknown;
}
interface DrainReply {
  code(n: number): DrainReply;
  header(k: string, v: string): DrainReply;
  send(body: unknown): unknown;
}

/** Registers the gate (refuse new work while draining) and the open-request count the drain waits on. */
export function installDrainHooks(app: HookApp, drain: CoordinatorDrain = coordinatorDrain): void {
  const ends = new WeakMap<object, () => void>();
  app.addHook("onRequest", async (req, reply) => {
    const answer = drain.gate(req.method, req.url);
    if (answer) return reply.code(answer.status).header("retry-after", String(answer.retryAfterSec)).send(answer.body);
    const end = drain.track(req.method, req.url);
    if (end) ends.set(req, end);
  });
  app.addHook("onResponse", async (req) => {
    ends.get(req)?.();
  });
  // A caller that went away never gets a response: count it as ended too.
  app.addHook("onRequestAbort", async (req) => {
    ends.get(req)?.();
  });
}

/** SIGTERM / SIGINT start the drain (Fly sends kill_signal, then kills after kill_timeout). */
export function installDrainSignals(start: (signal: string) => void, signals: Pick<NodeJS.Process, "once"> = process): void {
  signals.once("SIGTERM", () => start("SIGTERM"));
  signals.once("SIGINT", () => start("SIGINT"));
}
