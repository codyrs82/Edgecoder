// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Direct work (agent-to-agent offers relayed by the coordinator, /agent-mesh/direct-work/* and
 * /agent-mesh/models/request) is unpaid, so it is allowed only between agents of the same account:
 * your own machines sharing work. Work for another account goes through the coordinator market
 * (POST /submit), where it is billed and the worker paid.
 *
 * The account comes from the coordinator's verified agent → account mapping (the portal-linked
 * ownership row), never from anything the sender says. An agent with no ownership row has no
 * verified account and does no direct work with anyone: its id would otherwise double as an
 * account id, and the coordinator's /register does not stop an agent from taking an id equal to
 * another user's account id (docs/security/agent-threat-model.md).
 */

export const DIRECT_WORK_MARKET_HINT =
  "Direct work is only between agents of the same account. Submit work for another account's agents to the coordinator market (POST /submit), where it is billed.";

export type DirectWorkAccountDecision =
  | { ok: true; accountId: string }
  | { ok: false; error: "direct_work_cross_account" | "direct_work_account_unverified" };

/** Coordinator side: both agents' verified accounts (null: no ownership row). */
export function directWorkAccountDecision(fromAccountId: string | null | undefined, toAccountId: string | null | undefined): DirectWorkAccountDecision {
  if (!fromAccountId || !toAccountId) return { ok: false, error: "direct_work_account_unverified" };
  if (fromAccountId !== toAccountId) return { ok: false, error: "direct_work_cross_account" };
  return { ok: true, accountId: fromAccountId };
}

/**
 * Worker side: run an offer only if the coordinator (in its signed heartbeat response) says it
 * comes from this agent's own account, the one the coordinator named in its signed /register
 * response. Offers from a coordinator that predates the check carry no account and are refused.
 */
export function workerAcceptsDirectWorkOffer(
  offer: { fromAgentId: string; fromAccountId?: string },
  ownAccountId: string | undefined,
  blacklisted: (agentId: string) => boolean
): { ok: true } | { ok: false; reason: "sender_blacklisted" | "no_sender_account" | "cross_account" } {
  if (blacklisted(offer.fromAgentId)) return { ok: false, reason: "sender_blacklisted" };
  if (!offer.fromAccountId || !ownAccountId) return { ok: false, reason: "no_sender_account" };
  if (offer.fromAccountId !== ownAccountId) return { ok: false, reason: "cross_account" };
  return { ok: true };
}
