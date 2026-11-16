// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { BitcoinAnchorRecord, BitcoinNetwork } from "../common/types.js";
import type { AnchorTrackerStatus } from "./anchor-tracker.js";
import { isLiveAnchor, isTxid } from "./anchoring.js";
import { anchorProviderProblem } from "./bitcoin-rpc.js";

/*
 * #46: what the API says about anchoring. Nothing here writes: rows are labelled at read time.
 *
 * - No BITCOIN_ANCHOR_PROVIDER means anchoring is disabled, in every environment. Nothing is
 *   broadcast and nothing is reported as anchored.
 * - Rows written by the old simulation carry `anchor:<network>:<hash>` / `stats-anchor:...` in
 *   tx_ref with status "anchored". They are not transactions, so they are reported as
 *   "simulated" with no txid and zero confirmations. The stored rows are left as they are.
 * - Rows broadcast by the mock provider (explicit BITCOIN_ANCHOR_PROVIDER=mock, never in
 *   production) have a made-up 64-hex txid; they are reported as "simulated" too.
 */

export type AnchoringMode = "disabled" | "simulated" | "enabled";

export interface AnchoringModeInfo {
  mode: AnchoringMode;
  /** Normalised BITCOIN_ANCHOR_PROVIDER, null when unset. */
  provider: string | null;
  /** Why a configured provider is not used (typo, read-only provider, missing credentials, mock in production). */
  problem?: string;
}

/**
 * What BITCOIN_ANCHOR_PROVIDER asks for. Unset is "disabled" in every environment: there is
 * no silent fallback to the mock provider. `mock` must be asked for by name and is refused
 * in production. A real provider that cannot work is "disabled" with the reason.
 */
export function resolveAnchoringMode(env: NodeJS.ProcessEnv = process.env): AnchoringModeInfo {
  const provider = (env.BITCOIN_ANCHOR_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) return { mode: "disabled", provider: null };
  if (provider === "mock" && env.NODE_ENV !== "production") return { mode: "simulated", provider };
  const problem = anchorProviderProblem(env);
  return problem ? { mode: "disabled", provider, problem } : { mode: "enabled", provider };
}

export interface AnchoringStatus {
  /** True only when a real provider is configured and there is a database to record anchors in. */
  enabled: boolean;
  mode: AnchoringMode;
  provider: string | null;
  network: BitcoinNetwork;
  /** Confirmations at which a pending anchor becomes "anchored". */
  requiredConfirmations: number;
  detail: string;
  /** Confirmation poll loop state; absent while anchoring is disabled. */
  tracker?: AnchorTrackerStatus;
}

export function anchoringStatus(input: {
  mode: AnchoringModeInfo;
  /** False when there is no database to record anchors in. */
  storeAvailable: boolean;
  network: BitcoinNetwork;
  requiredConfirmations: number;
  tracker?: AnchorTrackerStatus;
}): AnchoringStatus {
  const { provider, problem } = input.mode;
  const mode: AnchoringMode = input.storeAvailable ? input.mode.mode : "disabled";
  const detail =
    mode === "enabled"
      ? `anchoring_enabled: OP_RETURN via ${provider}; an anchor is confirmed at ${input.requiredConfirmations} confirmations`
      : mode === "simulated"
        ? "anchoring_simulated: BITCOIN_ANCHOR_PROVIDER=mock makes up transaction ids; nothing is anchored on Bitcoin"
        : problem
          ? `anchoring_disabled: ${problem}`
          : !provider
            ? "anchoring_disabled: no BITCOIN_ANCHOR_PROVIDER is configured, so nothing is anchored on Bitcoin"
            : "anchoring_disabled: no database to record anchors in";
  return {
    enabled: mode === "enabled",
    mode,
    provider,
    network: input.network,
    requiredConfirmations: input.requiredConfirmations,
    detail,
    tracker: mode === "disabled" ? undefined : input.tracker
  };
}

export type AnchorSimulatedReason = "legacy_fake_tx_ref" | "mock_provider";

/** Why a row is not a real Bitcoin transaction, or null when it is (or is still being broadcast). */
export function anchorSimulatedReason(record: BitcoinAnchorRecord): AnchorSimulatedReason | null {
  if (record.anchorProvider === "mock") return "mock_provider";
  // "broadcasting:<uuid>" is the placeholder of an in-flight or rejected real broadcast.
  if (!record.txRef.startsWith("broadcasting:") && !isTxid(record.txRef)) return "legacy_fake_tx_ref";
  return null;
}

/** Confirmations to report: only a real, non-failed transaction has any. */
export function anchorConfirmations(record: BitcoinAnchorRecord | null | undefined): number {
  return record && isLiveAnchor(record) && !anchorSimulatedReason(record) ? record.confirmations ?? 0 : 0;
}

/** A real anchor at depth: status "anchored" (reached the required confirmations) and at least `minConfirmations`. */
export function isConfirmedAnchor(record: BitcoinAnchorRecord | null | undefined, minConfirmations = 1): boolean {
  return Boolean(record) && record!.status === "anchored" && anchorConfirmations(record) >= Math.max(1, minConfirmations);
}

/** A real anchor that exists or is on its way: live txid, or a broadcast still being reconciled. */
export function isRealAnchorInProgress(record: BitcoinAnchorRecord | null | undefined): boolean {
  if (!record || anchorSimulatedReason(record)) return false;
  return isLiveAnchor(record) || record.status === "broadcasting" || record.status === "needs_admin";
}

export interface AnchorView {
  anchorId: string;
  epochId: string;
  checkpointHash: string;
  network: BitcoinNetwork;
  /** The stored status, except that a simulated row is never "anchored" or "pending": it is "simulated". */
  status: BitcoinAnchorRecord["status"] | "simulated";
  simulated: boolean;
  simulatedReason?: AnchorSimulatedReason;
  /** A real Bitcoin txid, or absent. Never a legacy `anchor:...` reference or a mock txid. */
  txRef?: string;
  /** What a simulated row has in tx_ref, kept for audit. Not a transaction. */
  simulatedTxRef?: string;
  confirmations: number;
  requiredConfirmations: number;
  blockHash?: string;
  blockHeight?: number;
  anchoredAtMs?: number;
  createdAtMs: number;
  lastCheckedAtMs?: number;
  provider?: string;
}

export function describeAnchor(record: BitcoinAnchorRecord, requiredConfirmations: number): AnchorView {
  const reason = anchorSimulatedReason(record);
  const common = {
    anchorId: record.anchorId,
    epochId: record.epochId,
    checkpointHash: record.checkpointHash,
    network: record.anchorNetwork,
    requiredConfirmations,
    createdAtMs: record.createdAtMs,
    lastCheckedAtMs: record.lastCheckedAtMs,
    provider: record.anchorProvider
  };
  if (reason) {
    return { ...common, status: "simulated", simulated: true, simulatedReason: reason, simulatedTxRef: record.txRef, confirmations: 0 };
  }
  return {
    ...common,
    status: record.status,
    simulated: false,
    txRef: isTxid(record.txRef) ? record.txRef : undefined,
    confirmations: anchorConfirmations(record),
    blockHash: record.blockHash,
    blockHeight: record.blockHeight,
    anchoredAtMs: record.status === "anchored" ? record.anchoredAtMs : undefined
  };
}

/**
 * Inputs for the stats finality answer about one checkpoint's anchor. Hard finality needs a
 * real transaction that reached the required depth; a simulated row never counts, and neither
 * does one confirmation of a transaction that is still "pending".
 */
export function checkpointAnchorFinality(input: {
  anchor: BitcoinAnchorRecord | null | undefined;
  requiredConfirmations: number;
  /** STATS_ANCHOR_MIN_CONFIRMATIONS: can only raise the bar above the required depth. */
  minConfirmations: number;
}): { hardFinalized: boolean; anchorInProgress: boolean; requiredConfirmations: number; anchor?: AnchorView } {
  const required = Math.max(1, input.requiredConfirmations, input.minConfirmations);
  return {
    hardFinalized: isConfirmedAnchor(input.anchor, required),
    anchorInProgress: isRealAnchorInProgress(input.anchor),
    requiredConfirmations: required,
    anchor: input.anchor ? describeAnchor(input.anchor, required) : undefined
  };
}
