// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  /**
   * Added to maxRequests per parallel model slot the agent reports (setSlotsLookup), so a
   * multi-slot host's budget grows with the calls it can run at once. 0 or absent: a flat limit.
   */
  perSlot?: number;
}

/** The most slots any agent's budget is scaled by, whatever it reports. */
export const RATE_LIMIT_MAX_SLOTS = 16;

export class AgentRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly windows = new Map<string, number[]>();
  private slotsOf: (agentId: string) => number | undefined = () => undefined;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  /** Where the agent's reported parallel model slots come from (the coordinator's pull reports). */
  setSlotsLookup(fn: (agentId: string) => number | undefined): void {
    this.slotsOf = fn;
  }

  /** This agent's requests per window: the base, plus perSlot for each reported slot (at most RATE_LIMIT_MAX_SLOTS). */
  limitFor(agentId: string): number {
    const base = this.config.maxRequests;
    const perSlot = this.config.perSlot ?? 0;
    if (base <= 0 || perSlot <= 0) return base;
    const raw = Number(this.slotsOf(agentId) ?? 0);
    const slots = Number.isFinite(raw) ? Math.max(0, Math.min(RATE_LIMIT_MAX_SLOTS, Math.floor(raw))) : 0;
    return base + perSlot * slots;
  }

  check(agentId: string): boolean {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;

    let timestamps = this.windows.get(agentId);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(agentId, timestamps);
    }

    // Evict expired timestamps
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.limitFor(agentId)) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  /** How long until `agentId` may send again (0 when it may now). */
  retryAfterMs(agentId: string, now = Date.now()): number {
    const max = this.limitFor(agentId);
    if (max <= 0) return this.config.windowMs;
    const timestamps = this.windows.get(agentId);
    if (!timestamps || timestamps.length < max) return 0;
    // The request that frees a slot is the oldest one still counted in the window.
    const oldestCounted = timestamps[timestamps.length - max];
    return Math.max(0, oldestCounted + this.config.windowMs - now);
  }

  reset(agentId: string): void {
    this.windows.delete(agentId);
  }
}

/**
 * Requests that keep an agent's claims alive or return their work: /result, and a heartbeat sent
 * with `leaseOnly` (the worker's renewal while a claim runs). They count against their own budget.
 */
export function isLeaseTraffic(routePath: string, rawBody: string | undefined): boolean {
  if (routePath === "/result") return true;
  if (routePath !== "/heartbeat" || !rawBody || !rawBody.includes("leaseOnly")) return false;
  try {
    return (JSON.parse(rawBody) as { leaseOnly?: unknown })?.leaseOnly === true;
  } catch {
    return false;
  }
}

/**
 * The agent's work polling: /pull and a heartbeat that is not lease-only (isLeaseTraffic). They
 * count against their own budget, apart from the agent's other signed requests.
 */
export function isPullTraffic(routePath: string, rawBody: string | undefined): boolean {
  return routePath === "/pull" || (routePath === "/heartbeat" && !isLeaseTraffic(routePath, rawBody));
}

/**
 * A signed agent request over its per-identity limit. The signature checked out, so this is
 * the agent's own traffic: it is answered 429 with Retry-After (the coordinator's error handler,
 * src/swarm/coordinator/app.ts), not 401, and it is not a protocol violation. A 401 would tell
 * an honest client its credentials are bad and send it re-registering, which the
 * registration-storm rule (BHV008) then blacklists.
 */
export class AgentRateLimitedError extends Error {
  readonly statusCode = 429;
  readonly code = "agent_rate_limited";
  readonly retryAfterMs: number;
  readonly headers: Record<string, string>;

  constructor(retryAfterMs: number) {
    super("agent_rate_limited");
    this.name = "AgentRateLimitedError";
    this.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs));
    // Retry-After is whole seconds; never 0, or a client would retry at once.
    this.headers = { "retry-after": String(Math.max(1, Math.ceil(this.retryAfterMs / 1000))) };
  }
}

export function isAgentRateLimitedError(error: unknown): error is AgentRateLimitedError {
  return error instanceof AgentRateLimitedError;
}
