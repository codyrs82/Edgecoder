// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

export { safeTokenEqual } from "../common/crypto-utils.js";

export function normalizeIpCandidate(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.toLowerCase() === "unknown") return undefined;
  if (value.startsWith("::ffff:")) return value.slice(7);
  if (value.startsWith("[") && value.includes("]")) return value.slice(1, value.indexOf("]"));
  const colonCount = (value.match(/:/g) ?? []).length;
  if (colonCount === 1 && /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) {
    return value.split(":")[0];
  }
  return value;
}

export function readHeaderValue(headers: Record<string, unknown>, key: string): string | undefined {
  const raw = headers[key];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((item) => typeof item === "string");
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

export function extractClientIp(headers: Record<string, unknown>, fallbackIp?: string): string | undefined {
  const priorityHeaders = ["fly-client-ip", "cf-connecting-ip", "x-real-ip", "true-client-ip"];
  for (const key of priorityHeaders) {
    const headerValue = readHeaderValue(headers, key);
    const normalized = headerValue ? normalizeIpCandidate(headerValue) : undefined;
    if (normalized) return normalized;
  }
  const forwarded = readHeaderValue(headers, "x-forwarded-for");
  if (forwarded) {
    for (const part of forwarded.split(",")) {
      const normalized = normalizeIpCandidate(part);
      if (normalized) return normalized;
    }
  }
  if (typeof fallbackIp === "string") {
    return normalizeIpCandidate(fallbackIp);
  }
  return undefined;
}

export function normalizeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("::");
}

export function weightedMedian(entries: Array<{ value: number; weight: number }>): number {
  if (entries.length === 0) return 0;
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (totalWeight <= 0) return sorted[Math.floor(sorted.length / 2)]?.value ?? 0;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += Math.max(0, item.weight);
    if (cumulative >= totalWeight / 2) return item.value;
  }
  return sorted[sorted.length - 1]?.value ?? 0;
}

export function parseRecordPayload(record: { payloadJson?: string }): Record<string, unknown> {
  if (!record.payloadJson) return {};
  try {
    return JSON.parse(record.payloadJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface ContributionStats {
  /** Credits earned by compute (reason compute_contribution). */
  earned: number;
  /** Credits spent on task submission (reason task_submit). */
  spent: number;
  /** Credits bought with sats (reason credit_purchase:<intentId>). */
  purchased: number;
}

export type ContributionPolicyDecision = { ok: true; reason: "burst_balance" | "ratio_ok" | "nothing_spent" } | { ok: false; reason: string };

/**
 * Contribute-first policy for POST /submit. An account may submit when it holds at least
 * `burstCredits`, or when (earned + purchased) / spent >= `minRatio`.
 *
 * Purchased credits count as "earned": someone who pays sats for credits has paid for the
 * compute they consume, so a pure consumer (never contributes compute) can keep submitting
 * as long as purchases keep pace with spend. Before this, only compute_contribution counted,
 * so a buyer below the burst threshold who had ever submitted got contribute_first_required.
 */
export function contributionPolicyDecision(
  stats: ContributionStats,
  balance: number,
  cfg: { burstCredits: number; minRatio: number }
): ContributionPolicyDecision {
  if (balance >= cfg.burstCredits) return { ok: true, reason: "burst_balance" };
  if (stats.spent <= 0) return { ok: true, reason: "nothing_spent" };
  const effectiveEarned = Math.max(0, stats.earned) + Math.max(0, stats.purchased);
  const ratio = effectiveEarned / stats.spent;
  if (ratio < cfg.minRatio) {
    return {
      ok: false,
      reason:
        `contribute_first_policy: earned=${stats.earned.toFixed(3)} purchased=${stats.purchased.toFixed(3)} ` +
        `spent=${stats.spent.toFixed(3)} ratio=${ratio.toFixed(3)} min=${cfg.minRatio}`
    };
  }
  return { ok: true, reason: "ratio_ok" };
}

export function computeIntentFee(amountSats: number, feeBps: number): { feeSats: number; netSats: number } {
  const feeSats = Math.floor((amountSats * feeBps) / 10000);
  const netSats = Math.max(0, amountSats - feeSats);
  return { feeSats, netSats };
}

/**
 * Whose credits a POST /submit spends. The shared mesh token says nothing about the caller's
 * account, so naming one takes the portal service token (the portal binds it from the session),
 * a request signed by a registered agent (it spends its owner's account, linked at registration,
 * or its own id when unowned), or a loopback caller (the desktop app's own coordinator).
 * Anyone else may only submit anonymously.
 */
export function submitterAccountDecision(input: {
  requested: string;
  portalService: boolean;
  signature: { agentId: string } | "rejected" | null;
  ownerAccountId?: string;
  loopback: boolean;
}): { accountId: string } | { status: number; error: string } {
  const { requested } = input;
  if (input.portalService) return { accountId: requested };
  if (input.signature === "rejected") return { status: 401, error: "invalid_signature" };
  if (input.signature) {
    const owner = input.ownerAccountId ?? input.signature.agentId;
    if (requested === "anonymous") return { accountId: "anonymous" };
    if (requested !== owner && requested !== input.signature.agentId) {
      return { status: 403, error: "submitter_account_mismatch" };
    }
    return { accountId: owner };
  }
  if (requested === "anonymous" || input.loopback) return { accountId: requested };
  return { status: 403, error: "submitter_signature_required" };
}
