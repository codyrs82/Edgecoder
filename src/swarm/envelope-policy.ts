// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { Subtask } from "../common/types.js";

/*
 * Task privacy on the coordinator → agent hop (src/security/envelope.ts).
 *
 * An agent that registered an X25519 key gets every subtask as an encrypted envelope; if the
 * envelope cannot be built the subtask is handed back and nothing is sent (fail closed). An agent
 * without a key (older builds, the iOS app today) gets plaintext unless ENVELOPE_REQUIRED is on,
 * in which case it may not claim a subtask that carries user data. Every plaintext delivery is
 * counted (edgecoder_envelope_plaintext_deliveries_total) so the operator can see when the flag
 * can be turned on.
 */

/** A subtask carries user data when it has an input or a snapshot to run against. */
export function carriesUserData(subtask: Pick<Subtask, "input" | "snapshotRef">): boolean {
  return (subtask.input ?? "").length > 0 || (subtask.snapshotRef ?? "").length > 0;
}

/** Whether an agent may claim `subtask` under the envelope policy. */
export function envelopePolicyAllows(
  agent: { x25519PublicKey?: string } | undefined,
  subtask: Pick<Subtask, "input" | "snapshotRef">,
  envelopeRequired: boolean
): boolean {
  if (!envelopeRequired) return true;
  if (agent?.x25519PublicKey) return true;
  return !carriesUserData(subtask);
}

/** Counters since start, exported on /metrics (src/swarm/coordinator-metrics.ts). */
export const envelopeStats = {
  /** Subtasks sent as encrypted envelopes. */
  encrypted: 0,
  /** Subtasks sent in plaintext to an agent without an envelope key. */
  plaintext: 0,
  /** Envelope builds that failed; the subtask was handed back, nothing sent. */
  encryptFailed: 0,
  /** Results whose envelope key was re-derived (e.g. the coordinator restarted after the claim). */
  rederived: 0,
  /** Encrypted results that could not be opened. */
  decryptFailed: 0
};

export function resetEnvelopeStats(): void {
  for (const k of Object.keys(envelopeStats) as Array<keyof typeof envelopeStats>) envelopeStats[k] = 0;
}
