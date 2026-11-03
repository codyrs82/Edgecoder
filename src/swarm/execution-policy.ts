// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { Subtask, SubtaskResult } from "../common/types.js";
import type { TaskEnvelope, EncryptedResult } from "../security/envelope.js";
import { isValidSnapshotRef } from "./snapshot-resolver.js";

/*
 * Checks the worker applies before running or reporting any subtask, whatever its source
 * (coordinator /pull, mesh task_offer, peer-direct work), so no path skips them.
 */

export type SnapshotEnforcement = "strict" | "warn" | "off";

export function parseSnapshotEnforcement(raw: string | undefined): SnapshotEnforcement {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "strict" || v === "off" ? v : "warn";
}

export type SnapshotDecision =
  | { run: true; warning?: string; verified?: boolean }
  | { run: false; error: string };

/**
 * Frozen snapshot enforcement (Design Decision #8). Inference runs a model, not project code, so it
 * needs no snapshot. A code subtask needs a valid snapshotRef (40-hex commit or https tarball);
 * synthetic refs ("mesh", "peer-direct") are not valid. strict refuses, warn runs and says so.
 */
export function checkSnapshotPolicy(st: Pick<Subtask, "id" | "kind"> & { snapshotRef?: string }, mode: SnapshotEnforcement): SnapshotDecision {
  if (st.kind === "inference") return { run: true };
  if (st.snapshotRef && isValidSnapshotRef(st.snapshotRef)) return { run: true, verified: true };
  const ref = st.snapshotRef ?? "";
  if (mode === "strict") return { run: false, error: `snapshot_invalid: frozen snapshot enforcement rejected subtask ${st.id} (snapshotRef "${ref}")` };
  if (mode === "off") return { run: true };
  return { run: true, warning: `subtask ${st.id} has invalid snapshotRef "${ref}"; proceeding (enforcement=${mode})` };
}

/**
 * The /result body for a task that arrived as an encrypted envelope. Fails closed: when encryption
 * fails, the output is never sent in plaintext; a failure without the output is reported instead.
 */
export function envelopeResultPayload(
  result: SubtaskResult,
  envelope: TaskEnvelope,
  encrypt: (r: { ok: boolean; output: string; error?: string; durationMs: number }, envelope: TaskEnvelope) => EncryptedResult,
  /** Re-signs the report for the failure (the report signature covers `ok`). */
  resign?: (ok: false) => { reportNonce: string; reportSignature: string }
): { payload: Record<string, unknown>; encrypted: boolean; error?: string } {
  const common = { taskId: result.taskId, agentId: result.agentId, reportNonce: result.reportNonce, reportSignature: result.reportSignature };
  try {
    const encrypted = encrypt({ ok: result.ok, output: result.output, error: result.error, durationMs: result.durationMs }, envelope);
    return { payload: { ...encrypted, ...common }, encrypted: true };
  } catch (err) {
    return {
      payload: {
        subtaskId: result.subtaskId,
        ...common,
        ...(resign ? resign(false) : {}),
        ok: false,
        output: "",
        error: "result_encryption_failed",
        durationMs: result.durationMs
      },
      encrypted: false,
      error: String(err)
    };
  }
}
