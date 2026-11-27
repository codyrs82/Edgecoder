// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Which failures a bot waits out by itself and which need you, said once:
 *   - "transient": the network or this computer's agent was out of reach right now (not connected,
 *     reconnecting, a coordinator restarting or draining, every machine busy, the request timed out
 *     or the connection dropped). It retries with backoff and never counts toward a stuck pause.
 *   - "blocker": only you can fix it (out of cSats, today's budget spent, a refusal or permission
 *     problem, a task it can't make progress on, anything not known to be transient). The same
 *     blocker three runs in a row pauses the bot (stuckProblem); cSats and budget have their own holds.
 */
export type RunFailureClass = "transient" | "blocker";
const TRANSIENT_FAILURE = new RegExp(
  [
    "isn't connected to the network",
    "agent_not_registered",
    "coordinator is restarting",
    "coordinator_draining",
    "coordinator_unreachable",
    "is busy and none could start this request in time",
    "no_capacity",
    "network stream failed",
    "didn't finish within \\d+ minutes",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "socket hang up",
    "fetch failed",
    "other side closed",
    "Headers Timeout Error",
    "Body Timeout Error",
    "\\b(502|503|504)\\b",
  ].join("|"),
  "i",
);
const BLOCKER_FAILURE = /not enough cSats|no cSats|budget\b[^.]*\bis spent|insufficient|you said no|denied|not allowed|permission|unauthori[sz]ed|forbidden|isn't installed|not found/i;
export function runFailureClass(error: string | undefined): RunFailureClass | null {
  if (!error || !error.trim()) return null;
  if (BLOCKER_FAILURE.test(error)) return "blocker";
  return TRANSIENT_FAILURE.test(error) ? "transient" : "blocker";
}
