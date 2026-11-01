// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * #71: spend caps for the IDE provider server's swarm route. Every /run/swarm call
 * submits a coordinator task that spends credits, so a runaway or prompt-injected
 * client holding the IDE token must not be able to spend without bound.
 *
 * - IDE_SWARM_MAX_CREDITS: cap per request (checked against the expected cost
 *   before the task is submitted, and logged if the reported cost exceeds it).
 * - IDE_SWARM_SESSION_MAX_CREDITS: cap per provider-server process.
 * - IDE_SWARM_EXPECTED_CREDITS: pre-submit estimate (default 1 = the coordinator's
 *   per-submit charge). Actual spend is counted from the coordinator's creditsSpent.
 * Unset/empty caps mean "no cap".
 */
export interface SwarmBudgetConfig {
  perRequestMax?: number;
  sessionMax?: number;
  expectedCredits: number;
}

export function swarmBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): SwarmBudgetConfig {
  const cap = (v: string | undefined) => {
    if (v === undefined || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const expected = cap(env.IDE_SWARM_EXPECTED_CREDITS);
  return {
    perRequestMax: cap(env.IDE_SWARM_MAX_CREDITS),
    sessionMax: cap(env.IDE_SWARM_SESSION_MAX_CREDITS),
    expectedCredits: expected !== undefined && expected > 0 ? expected : 1
  };
}

export type SwarmBudgetDecision = { ok: true } | { ok: false; reason: "per_request_cap" | "session_cap" };

export class SwarmSpendGuard {
  private spent = 0;
  private reserved = 0;

  constructor(private readonly cfg: SwarmBudgetConfig) {}

  /** Reserve the expected cost before submitting; call settle() or release() after. */
  reserve(): SwarmBudgetDecision {
    const cost = this.cfg.expectedCredits;
    if (this.cfg.perRequestMax !== undefined && cost > this.cfg.perRequestMax) return { ok: false, reason: "per_request_cap" };
    if (this.cfg.sessionMax !== undefined && this.spent + this.reserved + cost > this.cfg.sessionMax) {
      return { ok: false, reason: "session_cap" };
    }
    this.reserved += cost;
    return { ok: true };
  }

  /** Count the coordinator-reported spend (falls back to the estimate when absent). */
  settle(creditsSpent: number | undefined): { overPerRequestCap: boolean } {
    this.reserved = Math.max(0, this.reserved - this.cfg.expectedCredits);
    const actual = Number.isFinite(creditsSpent) && (creditsSpent as number) >= 0 ? (creditsSpent as number) : this.cfg.expectedCredits;
    this.spent += actual;
    return { overPerRequestCap: this.cfg.perRequestMax !== undefined && actual > this.cfg.perRequestMax };
  }

  /** The submit failed before anything was charged. */
  release(): void {
    this.reserved = Math.max(0, this.reserved - this.cfg.expectedCredits);
  }

  status(): { spent: number; perRequestMax: number | null; sessionMax: number | null; remaining: number | null } {
    return {
      spent: this.spent,
      perRequestMax: this.cfg.perRequestMax ?? null,
      sessionMax: this.cfg.sessionMax ?? null,
      remaining: this.cfg.sessionMax !== undefined ? Math.max(0, this.cfg.sessionMax - this.spent - this.reserved) : null
    };
  }
}
