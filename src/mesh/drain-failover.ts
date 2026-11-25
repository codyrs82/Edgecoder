// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Serving through a peer coordinator while the home one drains for a planned restart (outage test
 * 3b, run 8: agents of a restarted US seed were back 39-45 s after the restart command, and in the
 * meantime only the EU-connected hosts served the model, so buyers sent to the EU seed got "busy").
 *
 * The agent's side, as a small state machine the worker drives:
 *
 *   idle --notice--> leaving --(jittered delay)--> away --(home answers, not draining)--> returning --> idle
 *
 * - A planned drain signal (the drain notice frame, a /pull answered `draining`, a /register refused
 *   `coordinator_draining`, a reconnect frame or a 1012 close) starts it at once: there is no 30 s
 *   wait as for an unexplained loss (coordinator-reconnect.ts CoordinatorRestartWindow).
 * - leaving: after a short random delay (DRAIN_FAILOVER_JITTER_MS, so the agents of one coordinator
 *   do not all register with the peer in the same instant) the worker picks a peer (the steering
 *   pick, else the peer the notice named; never the draining home) and registers there for new
 *   work. Claims it holds on the home keep reporting there (the worker pins each claim to the
 *   coordinator that issued it).
 * - away: the worker probes the home's unauthenticated GET /identity every HOME_PROBE_MS (plus
 *   jitter). Draining (`draining: true`) or no answer: keep serving through the peer. An answer
 *   without `draining` is the restarted instance.
 * - returning: after another random delay (HOME_RETURN_JITTER_MS: the restarted instance gets its
 *   agents spread out, as the reconnect frame's jitter does) the worker switches back and registers
 *   at home, once the calls the peer gave it are done (at most HOME_RETURN_HOLD_MAX_MS; meanwhile it
 *   takes nothing new). If that register fails as a restart failure does, it goes back to the peer
 *   and probes again.
 *
 * Bounded: after DRAIN_AWAY_MAX_MS away the agent stops probing and stays where it is (steering
 * decides from then on, as for any other coordinator change).
 */

export const DRAIN_FAILOVER_JITTER_MS = 1_000;
export const HOME_PROBE_MS = 2_000;
export const HOME_PROBE_JITTER_MS = 1_000;
export const HOME_RETURN_JITTER_MS = 3_000;
/** No peer to go to (none answers, or the notice named none and steering is off): look again after this. */
export const NO_PEER_RETRY_MS = 3_000;
export const DRAIN_AWAY_MAX_MS = 10 * 60_000;
/**
 * Coming home while the peer's own calls still run here: the agent first lets them finish (pulling
 * the peer with no free slot, so the peer neither hands it more nor sees an idle host that stopped
 * pulling and takes them back, #577 agentHeldBack), for at most this long.
 */
export const HOME_RETURN_HOLD_MAX_MS = 60_000;

export type DrainFailoverPhase = "idle" | "leaving" | "away" | "returning" | "homing";
export type HomeProbeState = "up" | "draining" | "down";

const normalize = (url: string) => url.trim().replace(/\/+$/, "");

/** What the home's GET /identity says: the restarted instance, still the draining one, or nothing yet. */
export function homeProbeState(statusCode: number | null, body: unknown): HomeProbeState {
  if (statusCode === null || statusCode < 200 || statusCode >= 300) return "down";
  const b = body as { draining?: unknown; peerId?: unknown } | null;
  if (!b || typeof b !== "object" || typeof b.peerId !== "string") return "down";
  return b.draining === true ? "draining" : "up";
}

export class DrainFailover {
  private phase: DrainFailoverPhase = "idle";
  private homeUrl: string | null = null;
  private awayUrl: string | null = null;
  private hint: string | null = null;
  private reasonText = "";
  private dueAtMs = 0;
  private startedAtMs = 0;
  /** Coordinators known to be draining now (never picked as the peer). */
  private readonly draining = new Set<string>();

  constructor(private readonly random: () => number = Math.random) {}

  get state(): DrainFailoverPhase {
    return this.phase;
  }
  get home(): string | null {
    return this.homeUrl;
  }
  get away(): string | null {
    return this.awayUrl;
  }
  get peerHint(): string | null {
    return this.hint;
  }
  get reason(): string {
    return this.reasonText;
  }
  active(): boolean {
    return this.phase !== "idle";
  }

  /**
   * A planned drain signal from `drainingUrl` (the coordinator the agent works for now). Returns
   * true when this starts a failover (the worker should wake its loop).
   */
  notice(input: { drainingUrl: string; peerUrl?: string | null; reason: string; nowMs?: number }): boolean {
    const now = input.nowMs ?? Date.now();
    const draining = normalize(input.drainingUrl);
    const peer = input.peerUrl ? normalize(input.peerUrl) : null;
    this.draining.add(draining);
    if (peer && peer !== draining) this.hint = peer;
    if (this.phase === "leaving") return false;
    if (this.phase === "idle") {
      this.homeUrl = draining;
      this.startedAtMs = now;
    } else if (this.phase === "away" && draining !== this.awayUrl) {
      // The home again (an old frame arriving late): nothing new, keep probing.
      return false;
    }
    // idle, or the peer we went to is draining too, or the home drains again as we come back.
    this.phase = "leaving";
    this.awayUrl = null;
    this.reasonText = input.reason;
    this.dueAtMs = now + Math.floor(this.random() * DRAIN_FAILOVER_JITTER_MS);
    return true;
  }

  /** Until the next scheduled step (the move, a home probe or the return); 0 when due or idle. */
  msUntilDue(nowMs = Date.now()): number {
    return this.phase === "idle" ? 0 : Math.max(0, this.dueAtMs - nowMs);
  }

  failoverDue(nowMs = Date.now()): boolean {
    return this.phase === "leaving" && nowMs >= this.dueAtMs;
  }

  /** The first candidate that is not draining (normalized), or null. */
  pickPeer(candidates: Array<string | null | undefined>): string | null {
    for (const c of candidates) {
      if (!c) continue;
      const url = normalize(c);
      if (url && !this.draining.has(url)) return url;
    }
    return null;
  }

  /** No peer to go to: try again later (the agent stays in its restart window at home meanwhile). */
  noPeer(nowMs = Date.now()): void {
    if (this.phase === "leaving") this.dueAtMs = nowMs + NO_PEER_RETRY_MS;
  }

  /** The worker switched to `url` for new work. */
  moved(url: string, nowMs = Date.now()): void {
    this.phase = "away";
    this.awayUrl = normalize(url);
    this.dueAtMs = nowMs + this.probeWait();
  }

  homeProbeDue(nowMs = Date.now()): boolean {
    return this.phase === "away" && nowMs >= this.dueAtMs;
  }

  /** The home probe's answer. Returns true when the return home is now scheduled. */
  onHomeProbe(state: HomeProbeState, nowMs = Date.now()): boolean {
    if (this.phase !== "away" || !this.homeUrl) return false;
    if (state === "up") {
      this.draining.delete(this.homeUrl);
      this.phase = "returning";
      this.dueAtMs = nowMs + Math.floor(this.random() * HOME_RETURN_JITTER_MS);
      return true;
    }
    if (nowMs - this.startedAtMs > DRAIN_AWAY_MAX_MS) {
      this.reset();
      return false;
    }
    this.dueAtMs = nowMs + this.probeWait();
    return false;
  }

  returnDue(nowMs = Date.now()): boolean {
    return this.phase === "returning" && nowMs >= this.dueAtMs;
  }

  /**
   * Returning and the peer's calls (`peerCallsInFlight`) still run: take nothing new from the peer
   * and wait, for at most HOME_RETURN_HOLD_MAX_MS after the return was due.
   */
  holdingForPeerCalls(peerCallsInFlight: number, nowMs = Date.now()): boolean {
    return this.phase === "returning" && peerCallsInFlight > 0 && nowMs - this.dueAtMs < HOME_RETURN_HOLD_MAX_MS;
  }

  /** The worker switched back to the home and is registering there. */
  homing(): void {
    if (this.phase === "returning") this.phase = "homing";
  }

  /** The register at home failed as a restart does: back to the peer, probe again. Returns the peer's URL. */
  homeNotReady(nowMs = Date.now()): string | null {
    if (this.phase !== "homing" && this.phase !== "returning") return null;
    if (this.homeUrl) this.draining.add(this.homeUrl);
    this.phase = "away";
    this.dueAtMs = nowMs + this.probeWait();
    return this.awayUrl;
  }

  /**
   * The agent registered with `url`. At home: the failover is over. Anywhere else while leaving:
   * that is the move (the worker calls moved() itself; this is for a register that raced it).
   */
  registered(url: string): void {
    if (this.phase === "idle") return;
    if (this.homeUrl && normalize(url) === this.homeUrl && (this.phase === "homing" || this.phase === "returning")) this.reset();
  }

  /** The agent's coordinator was changed by something else (steering, a failover of the peer): stop. */
  reset(): void {
    this.phase = "idle";
    this.homeUrl = null;
    this.awayUrl = null;
    this.hint = null;
    this.reasonText = "";
    this.draining.clear();
  }

  private probeWait(): number {
    return HOME_PROBE_MS + Math.floor(this.random() * HOME_PROBE_JITTER_MS);
  }
}
