// Copyright (c) 2025 EdgeCoder, LLC
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

  reset(agentId: string): void {
    this.windows.delete(agentId);
  }
}
