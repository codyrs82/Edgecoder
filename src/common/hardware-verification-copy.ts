// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * What to tell a machine's owner about its hardware verification (src/swarm/hardware-verification.ts),
 * per status and reason: what is happening, what it is paid meanwhile, and whether there is anything
 * they can do. Shown by the desktop app (Settings > Compute, "Your machines") and the portal (Market,
 * "Your agents").
 *
 * Kept byte-identical in desktop/src/lib/hardware-verification-copy.ts (the desktop app does not
 * import from src/); tests/common/hardware-verification-copy.test.ts checks the two match.
 * Self-contained on purpose: the portal also ships it to the browser via Function.prototype.toString.
 */

export interface VerificationView {
  status: string;
  claimedTier: string;
  grantedTier: string;
  /** lastFailReason from the coordinator, e.g. cross_check_unavailable, slow_sample_unconfirmed, declined:model_unavailable. */
  reason?: string | null;
  /** When the coordinator will check again (ms since epoch), if scheduled. */
  nextCheckAtMs?: number | null;
  /** False when this agent version cannot answer the speed check for its claimed tier. */
  checkSupported?: boolean | null;
  /** challenge_* flags from the record (e.g. challenge_model_too_small). */
  flags?: string[] | null;
}

export interface VerificationMessage {
  tone: "ok" | "info" | "warn";
  /** One or two sentences: what is happening, then what (if anything) to do. */
  text: string;
  /** True when the owner can do something about it; false when it resolves on its own. */
  actionable: boolean;
}

export function verificationMessage(v: VerificationView, nowMs: number = Date.now()): VerificationMessage {
  const classOf = (tier: string): string =>
    tier.startsWith("apple") ? "Apple silicon" : tier.startsWith("gpu.dc") ? "datacenter GPU" : tier.startsWith("gpu") ? "GPU" : "CPU";
  const baseTiers = ["cpu.std", "apple.m", "gpu.c8", "gpu.dc40"];
  const rate = (tier: string): string => (baseTiers.indexOf(tier) >= 0 ? `the standard ${classOf(tier)} rate (${tier})` : `the ${tier} rate`);
  const when = (): string => {
    const at = v.nextCheckAtMs;
    if (at === null || at === undefined || !Number.isFinite(at)) return "soon";
    const min = Math.ceil((at - nowMs) / 60_000);
    if (min <= 1) return "in about a minute";
    if (min < 120) return `in ${min} min`;
    return `in about ${Math.round(min / 60)} h`;
  };
  const paid = `you're paid at ${rate(v.grantedTier)} meanwhile`;
  const reason = v.reason ?? "";
  const flags = v.flags ?? [];
  const msg = (tone: VerificationMessage["tone"], text: string, actionable: boolean): VerificationMessage => ({ tone, text, actionable });

  if (v.status === "verified") return msg("ok", `Verified: paid at ${rate(v.grantedTier)}.`, false);
  if (v.status === "base") return msg("info", `Standard tier (${v.grantedTier}): there is nothing to verify.`, false);
  if (v.status === "pending") return msg("info", `Speed check in progress. Nothing to do: ${paid}.`, false);

  // unverified or demoted: explain by reason.
  if (reason === "cross_check_unavailable")
    return msg("info", `This machine finished the speed check for ${v.claimedTier}. Confirming it needs another machine running the same model (owned by someone else, on a different network), and none was available. Nothing to do: ${paid}, and it tries again ${when()}.`, false);
  if (reason === "cross_check_inconclusive")
    return msg("info", `The machine asked to confirm this speed didn't settle it either way. Nothing to do: it tries again with a different machine ${when()}; ${paid}.`, false);
  if (reason === "slow_sample_unconfirmed")
    return msg("warn", `Your machine measured slower than ${v.claimedTier} once; one slow result doesn't count against you. Keep EdgeCoder running, plugged in and not busy with other heavy work: it re-checks ${when()}.`, true);
  if (reason === "challenge_timeout")
    return msg("warn", `The speed check wasn't answered in time. Keep EdgeCoder open and the machine awake (not asleep or on low power): it re-checks ${when()}; ${paid}.`, true);
  if (reason === "declined:model_unavailable")
    return msg("warn", `The speed check needs the model this machine serves, and it wasn't loaded. Keep that model installed and EdgeCoder running: it re-checks ${when()}; ${paid}.`, true);
  if (reason.startsWith("declined:"))
    return msg("warn", `This machine couldn't run the speed check (${reason.slice("declined:".length).replace(/_/g, " ")}). Keep EdgeCoder running and up to date: it re-checks ${when()}; ${paid}.`, true);
  if (reason === "below_claimed_tier")
    return msg("warn", `Your machine measured slower than ${v.claimedTier}, so it's paid at ${rate(v.grantedTier)}. Keep EdgeCoder running while plugged in, with other heavy apps closed: it re-checks ${when()}.`, true);
  if (reason === "task_speed_below_tier")
    return msg("warn", `Real jobs ran much slower than this machine's speed check, so it's paid at ${rate(v.grantedTier)}. Close other heavy apps and keep it plugged in: it re-checks ${when()}.`, true);
  if (reason === "invalid:cross_check_mismatch")
    return msg("warn", `This machine's output didn't match other machines running the same model, so it's paid at ${rate(v.grantedTier)}. Update EdgeCoder and re-download the model if it may be corrupted: it re-checks ${when()}.`, true);
  if (reason.startsWith("invalid:"))
    return msg("warn", `The speed check answer didn't verify (${reason.slice("invalid:".length).replace(/_/g, " ")}), so it's paid at ${rate(v.grantedTier)}. Update EdgeCoder to the latest version: it re-checks ${when()}.`, true);

  // No failure recorded yet.
  if (v.checkSupported === false)
    return msg("warn", `This version of EdgeCoder can't run the speed check for ${v.claimedTier}. Update EdgeCoder to be verified; until then ${paid.replace(" meanwhile", "")}.`, true);
  if (flags.indexOf("challenge_no_model") >= 0)
    return msg("warn", `The speed check runs on the model this machine serves, and none is loaded. Load a model in EdgeCoder: it re-checks ${when()}; ${paid}.`, true);
  if (flags.indexOf("challenge_model_unknown") >= 0)
    return msg("warn", `The speed check can't size the model this machine serves (it isn't in EdgeCoder's model catalog). Serve a catalog model to be verified: it re-checks ${when()}; ${paid}.`, true);
  if (flags.indexOf("challenge_model_too_small") >= 0)
    return msg("warn", `The model this machine serves is too small to measure its speed (the check needs at least 3B active parameters). Load a larger model to be verified: it re-checks ${when()}; ${paid}.`, true);
  return msg("info", `Not checked yet: the speed check runs ${when()} while EdgeCoder is running. Nothing to do: ${paid}.`, false);
}
