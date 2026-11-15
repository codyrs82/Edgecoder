// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * How the coordinator judges a result for the behaviour rules and for pay, separating "the program
 * failed" from "the agent failed" (docs/security/agent-threat-model.md, buyer framing).
 *
 * A buyer decides what its code job does: `import sys; sys.exit(1)` makes every honest worker's
 * result fail. Counted as worker failures, a few such jobs collapse the worker's success rate
 * (BHV004) and get it struck or blacklisted. Agents from this change on say whether they executed the
 * job (SubtaskResult.executed / exitCode / programError); a failure of a job they executed is the
 * job's ("program_error") and never counts against them.
 *
 * Pay: a program error the agent credibly ran is paid like a success (the buyer used the compute;
 * before this change, appending `sys.exit(1)` got a buyer the output for free). Credible means a
 * code kind, a real non-zero exit status (or a time or output limit it hit), and no faster on the
 * coordinator's clock than an honest model call plus sandbox run (fastResultThresholdMs, BHV001's
 * bar). Beyond that, the result goes through result verification like any other: its comparator
 * keys on exit status and stdout, so a worker that claims a failure it did not run disagrees with a
 * replica that ran it (VRF001, no pay). A claim that is not credible counts as the agent's failure
 * and is not paid. A refusal by the sandbox policy (outside_subset) never ran anything: not the
 * agent's failure, and not paid.
 *
 * Agents that predate the field (no `executed`): a failure is judged as before, the agent's, and
 * not paid; the per-submitter cap in the behaviour tracker keeps one buyer from sinking them.
 */
import type { ProgramErrorReason } from "../common/types.js";
import { fastResultThresholdMs } from "../security/behavior-tracker.js";

export type ResultOutcome = "ok" | "program_error" | "agent_failure";

export interface ResultJudgement {
  outcome: ResultOutcome;
  /** A failed result that is paid anyway: a program error the agent credibly ran. */
  payableFailure: boolean;
  /** The result came from an agent that does not report `executed`. */
  legacy: boolean;
  /** Why a reported program error was not accepted as one. */
  rejectedClaim?: string;
}

const CODE_KINDS = new Set(["micro_loop", "single_step"]);
const RAN_PROGRAM_ERRORS = new Set<ProgramErrorReason>(["exit_nonzero", "timeout", "output_limit"]);

export function judgeResult(
  r: { ok: boolean; executed?: boolean; exitCode?: number; programError?: ProgramErrorReason },
  ctx: { kind?: string; serverMeasuredMs: number }
): ResultJudgement {
  if (r.ok) return { outcome: "ok", payableFailure: false, legacy: r.executed === undefined };
  if (r.executed === undefined) return { outcome: "agent_failure", payableFailure: false, legacy: true };
  // Model calls have no program: a failed one is the agent's (the inference retry path handles it).
  if (!r.executed || ctx.kind === undefined || !CODE_KINDS.has(ctx.kind)) {
    return { outcome: "agent_failure", payableFailure: false, legacy: false, ...(r.executed ? { rejectedClaim: "not_a_code_kind" } : {}) };
  }
  if (r.programError === "outside_subset") return { outcome: "program_error", payableFailure: false, legacy: false };
  if (!r.programError || !RAN_PROGRAM_ERRORS.has(r.programError)) {
    return { outcome: "agent_failure", payableFailure: false, legacy: false, rejectedClaim: "no_program_error" };
  }
  if (typeof r.exitCode !== "number" || !Number.isInteger(r.exitCode) || r.exitCode === 0) {
    return { outcome: "agent_failure", payableFailure: false, legacy: false, rejectedClaim: "no_exit_status" };
  }
  if (ctx.serverMeasuredMs < fastResultThresholdMs(ctx.kind)) {
    return { outcome: "agent_failure", payableFailure: false, legacy: false, rejectedClaim: "too_fast" };
  }
  return { outcome: "program_error", payableFailure: true, legacy: false };
}
