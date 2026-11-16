// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export class AgentRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly windows = new Map<string, number[]>();

  constructor(config: RateLimitConfig) {
    this.config = config;
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

    if (timestamps.length >= this.config.maxRequests) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  /** How long until `agentId` may send again (0 when it may now). */
  retryAfterMs(agentId: string, now = Date.now()): number {
    if (this.config.maxRequests <= 0) return this.config.windowMs;
    const timestamps = this.windows.get(agentId);
    if (!timestamps || timestamps.length < this.config.maxRequests) return 0;
    // The request that frees a slot is the oldest one still counted in the window.
    const oldestCounted = timestamps[timestamps.length - this.config.maxRequests];
    return Math.max(0, oldestCounted + this.config.windowMs - now);
  }

  reset(agentId: string): void {
    this.windows.delete(agentId);
  }
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
