// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import {
  countersignAsCoordinator,
  hashResultOutput,
  normalizePem,
  verifyAgentClaim,
  type SignedAgentReceiptClaim,
  type WorkReceipt
} from "./receipt.js";

/*
 * Coordinator-side receipt issuance, kept out of coordinator.ts so the wiring there is a
 * few lines: validate the agent's signed claim against the result that was actually
 * credited, then countersign.
 */

/** Shape of the `receipt` field an agent attaches to its POST /result body. */
export const agentReceiptClaimSchema = z.object({
  taskId: z.string().min(1),
  subtaskId: z.string().min(1),
  agentId: z.string().min(1),
  agentPublicKeyPem: z.string().min(1),
  startedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative(),
  resultHash: z.string().regex(/^[0-9a-f]{64}$/),
  agentSignature: z.string().min(1)
});

export interface IssueReceiptInput {
  /** The `receipt` field from the result body, if the agent sent one. */
  claim: SignedAgentReceiptClaim | undefined;
  /** What the coordinator credited. */
  result: { taskId: string; subtaskId: string; agentId: string; output: string };
  /** The agent's registered key when known; the claim's key must match it. */
  registeredAgentPublicKeyPem: string | null | undefined;
  coordinator: { coordinatorId: string; publicKeyPem: string; privateKeyPem: string };
  computeClass: string;
  credits: number;
  /** Price of one credit in millisatoshi at accrual time. */
  msatPerCredit: number;
}

export type IssueReceiptOutcome = { receipt: WorkReceipt } | { receipt: null; skipped: string };

export function issueReceiptForAccrual(input: IssueReceiptInput): IssueReceiptOutcome {
  const { claim, result } = input;
  if (!claim) return { receipt: null, skipped: "no_agent_claim" };
  if (claim.taskId !== result.taskId || claim.subtaskId !== result.subtaskId || claim.agentId !== result.agentId) {
    return { receipt: null, skipped: "claim_result_mismatch" };
  }
  if (claim.resultHash !== hashResultOutput(result.output)) return { receipt: null, skipped: "result_hash_mismatch" };
  if (claim.finishedAtMs < claim.startedAtMs) return { receipt: null, skipped: "time_range_invalid" };
  if (input.registeredAgentPublicKeyPem && normalizePem(input.registeredAgentPublicKeyPem) !== normalizePem(claim.agentPublicKeyPem)) {
    return { receipt: null, skipped: "agent_key_mismatch" };
  }
  if (!verifyAgentClaim(claim)) return { receipt: null, skipped: "agent_signature_invalid" };
  const msatPerCredit = Math.max(0, Math.round(input.msatPerCredit));
  const credits = Number(input.credits.toFixed(6));
  const receipt = countersignAsCoordinator(
    claim,
    {
      coordinatorId: input.coordinator.coordinatorId,
      coordinatorPublicKeyPem: input.coordinator.publicKeyPem,
      computeClass: input.computeClass,
      credits,
      msat: Math.round(credits * msatPerCredit),
      msatPerCredit
    },
    input.coordinator.privateKeyPem
  );
  return { receipt };
}
